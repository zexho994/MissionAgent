import {
  createNegotiation,
  createNegotiationMessage,
  transitionNegotiation,
  calculateAgreementScore,
  type Negotiation,
  type NegotiationMessage,
  type RoleSpec,
} from "@digitalagent/core";
import type { LlmService } from "@digitalagent/runtime";
import type { TeamProposal } from "./hr-agent.js";
import { extractJson } from "./hr-agent.js";

export type { TeamProposal };

export interface OwnerContext {
  ownerAgentId: string;
  preferences: {
    teamSize: [number, number];
    maxBudget: {
      maxRuntimeMinutes: number;
      maxTasks: number;
    };
    preferredCapabilities: string[];
    avoidCapabilities: string[];
  };
  constraints: string[];
  previousFeedback: string[];
}

export interface NegotiationServiceOptions {
  llm: LlmService;
  maxRounds?: number;
  escalationThreshold?: number;
}

export interface NegotiationSummary {
  outcome: "agreed" | "failed" | "escalated";
  roundsCompleted: number;
  finalProposal?: TeamProposal | undefined;
  failureReason?: string;
  keyDecisions: string[];
  alternatives: TeamProposal[];
}

export function createNegotiationService(options: NegotiationServiceOptions) {
  const {
    llm,
    maxRounds = 3,
    escalationThreshold = 0.5,
  } = options;

  return {
    startNegotiation,
    processRound,
    checkAgreement,
    escalateToUser,
    generateNegotiationSummary,
  };

  async function startNegotiation(
    proposal: TeamProposal,
    ownerContext: OwnerContext,
  ): Promise<Negotiation> {
    const negotiation = createNegotiation({
      missionId: proposal.missionId,
      initiatorId: proposal.proposedBy,
      participantId: ownerContext.ownerAgentId,
      topic: `Team composition for mission: ${proposal.missionId}`,
    });

    const proposalContent = await buildProposalContent(proposal, ownerContext);
    const proposalMessage = createNegotiationMessage({
      senderId: proposal.proposedBy,
      receiverId: ownerContext.ownerAgentId,
      type: "proposal",
      content: proposalContent,
    });

    return transitionNegotiation(negotiation, proposalMessage);
  }

  async function processRound(
    negotiation: Negotiation,
    message: NegotiationMessage,
  ): Promise<Negotiation> {
    const updated = transitionNegotiation(negotiation, message);

    if (isTerminalStatus(updated.status)) {
      return updated;
    }

    if (updated.currentRound >= maxRounds) {
      return await escalateToUser(
        updated,
        `Maximum negotiation rounds (${maxRounds}) reached`,
      );
    }

    const shouldRespond = message.senderId === updated.participantId;

    if (shouldRespond) {
      const response = await generateResponse(updated, message);
      return transitionNegotiation(updated, response);
    }

    return updated;
  }

  function checkAgreement(
    proposal: Record<string, unknown>,
    counterProposal: Record<string, unknown>,
  ): number {
    return calculateAgreementScore(proposal, counterProposal);
  }

  async function escalateToUser(
    negotiation: Negotiation,
    reason: string,
  ): Promise<Negotiation> {
    const escalationMessage = createNegotiationMessage({
      senderId: negotiation.initiatorId,
      receiverId: negotiation.participantId,
      type: "escalation_request",
      content: {
        reason,
        history: negotiation.rounds,
        userIntervention: true,
      },
    });

    return transitionNegotiation(negotiation, escalationMessage);
  }

  async function generateNegotiationSummary(
    negotiation: Negotiation,
  ): Promise<NegotiationSummary> {
    const summary: NegotiationSummary = {
      outcome: negotiation.status as "agreed" | "failed" | "escalated",
      roundsCompleted: negotiation.currentRound,
      keyDecisions: extractKeyDecisions(negotiation),
      alternatives: [],
    };

    if (negotiation.status === "failed") {
      summary.failureReason = extractFailureReason(negotiation);
      summary.alternatives = await generateAlternatives(negotiation);
    }

    if (negotiation.status === "agreed") {
      summary.finalProposal = extractFinalProposal(negotiation);
    }

    return summary;
  }

  async function buildProposalContent(
    proposal: TeamProposal,
    ownerContext: OwnerContext,
  ): Promise<Record<string, unknown>> {
    try {
      const systemPrompt = buildNegotiationSystemPrompt();
      const userPrompt = buildProposalPrompt(proposal, ownerContext);

      const response = await llm.call([
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ]);

      return parseProposalResponse(response.content, proposal);
    } catch (error) {
      console.error("[Negotiation] Build proposal content failed:", error instanceof Error ? error.message : String(error));
      return {
        message: "我建议为这个 Mission 采用以下团队配置",
        proposal,
        justification: "该配置基于 Mission 目标、成功指标和约束生成",
      };
    }
  }

  async function generateResponse(
    negotiation: Negotiation,
    lastMessage: NegotiationMessage,
  ): Promise<NegotiationMessage> {
    try {
      const systemPrompt = buildNegotiationSystemPrompt();
      const userPrompt = buildResponsePrompt(negotiation, lastMessage);

      const response = await llm.call([
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ]);

      return parseResponseMessage(response.content, negotiation);
    } catch (error) {
      console.error("[Negotiation] Generate response failed:", error instanceof Error ? error.message : String(error));
      return createNegotiationMessage({
        senderId: negotiation.initiatorId,
        receiverId: negotiation.participantId,
        type: "counter_proposal",
        content: {
          message: "我需要更多信息才能继续调整团队提案",
          requiresClarification: true,
        },
      });
    }
  }

  async function generateAlternatives(
    negotiation: Negotiation,
  ): Promise<TeamProposal[]> {
    const alternatives: TeamProposal[] = [];

    for (const round of negotiation.rounds) {
      for (const message of round.messages) {
        if (message.type === "counter_proposal" && message.content.proposal) {
          alternatives.push(message.content.proposal as TeamProposal);
        }
      }
    }

    return alternatives.slice(0, 3);
  }
}

function buildNegotiationSystemPrompt(): string {
  return [
    "You are a skilled negotiator representing the HR team in team composition discussions.",
    "Your goal is to reach agreement on team structure while ensuring mission success.",
    "",
    "Negotiation principles:",
    "- Be collaborative but firm on essential requirements",
    "- Offer alternatives when requests are not feasible",
    "- Explain the reasoning behind your proposals",
    "- Seek win-win solutions",
    "- Know when to escalate for user input",
    "",
    "Always respond with structured JSON that can be parsed directly.",
    "Use Chinese for every user-facing message, justification, role description, risk, and recommendation.",
  ].join("\n");
}

function buildProposalPrompt(
  proposal: TeamProposal,
  ownerContext: OwnerContext,
): string {
  return [
    "Present this team proposal to the mission owner in Chinese:",
    "",
    `**Mission ID:** ${proposal.missionId}`,
    `**Team Size:** ${proposal.roles.length} members`,
    `**Total Budget:** ${proposal.totalBudget.maxRuntimeMinutes} minutes, ${proposal.totalBudget.maxTasks} tasks`,
    `**Estimated Duration:** ${proposal.estimatedDuration}`,
    "",
    "**Proposed Roles:**",
    ...proposal.roles.map((role, i) =>
      `  ${i + 1}. ${role.name}: ${role.purpose}`,
    ),
    "",
    "**Risk Assessment:**",
    ...proposal.riskAssessment.map((risk) => `  - ${risk}`),
    "",
    "**Collaboration Plan:**",
    `  - Workflow: ${proposal.collaborationPlan.workflow}`,
    `  - Communication: ${proposal.collaborationPlan.communicationChannels.join(", ")}`,
    `  - Decision Making: ${proposal.collaborationPlan.decisionMaking}`,
    "",
    "**Owner Preferences:**",
    `  - Team Size: ${ownerContext.preferences.teamSize[0]}-${ownerContext.preferences.teamSize[1]}`,
    `  - Max Budget: ${ownerContext.preferences.maxBudget.maxRuntimeMinutes}min`,
    `  - Preferred: ${ownerContext.preferences.preferredCapabilities.join(", ")}`,
    "",
    "Provide a JSON response with this structure:",
    "{",
    '  "message": "中文团队提案说明",',
    '  "proposal": { ... },',
    '  "justification": "为什么这个团队配置合理"',
    "}",
  ].join("\n");
}

function buildResponsePrompt(
  negotiation: Negotiation,
  lastMessage: NegotiationMessage,
): string {
  const context = [
    `**Round:** ${negotiation.currentRound}/${negotiation.rounds.length}`,
    `**Status:** ${negotiation.status}`,
    "",
    "**Last Message:**",
    `From: ${lastMessage.senderId}`,
    `Type: ${lastMessage.type}`,
    `Content: ${JSON.stringify(lastMessage.content)}`,
  ];

  if (lastMessage.type === "counter_proposal") {
    context.push(
      "",
      "Analyze the counter-proposal and respond.",
      "If agreement is possible, send an 'agreement' message.",
      "If you need to adjust, send a 'counter_proposal' message.",
      "If it's not feasible, send a 'rejection' message with reasons.",
    );
  } else if (lastMessage.type === "rejection") {
    context.push(
      "",
      "The proposal was rejected. Acknowledge and provide alternative options if available.",
    );
  }

  context.push(
    "",
    "Provide a JSON response with this structure:",
    "{",
    '  "type": "agreement|counter_proposal|rejection",',
    '  "message": "Response message",',
    '  "revisedProposal": { ... } // if counter_proposal',
    "}",
  );

  return context.join("\n");
}

function parseProposalResponse(
  content: string,
  originalProposal: TeamProposal,
): Record<string, unknown> {
  try {
    const json = extractJson(content, "object");
    if (json) {
      return JSON.parse(json);
    }
  } catch (error) {
    // Fall through to default
  }

  return {
    message: "I propose the following team for your mission",
    proposal: originalProposal,
    justification: "Based on mission requirements and constraints",
  };
}

function parseResponseMessage(
  content: string,
  negotiation: Negotiation,
): NegotiationMessage {
  try {
    const json = extractJson(content, "object");
    if (json) {
      const parsed = JSON.parse(json);
      const messageType = parsed.type || "counter_proposal";

      return createNegotiationMessage({
        senderId: negotiation.initiatorId,
        receiverId: negotiation.participantId,
        type: messageType as NegotiationMessage["type"],
        content: parsed,
      });
    }
  } catch (error) {
    // Fall through to default
  }

  return createNegotiationMessage({
    senderId: negotiation.initiatorId,
    receiverId: negotiation.participantId,
    type: "counter_proposal",
    content: {
      message: "I need more information to proceed",
      requiresClarification: true,
    },
  });
}

function extractKeyDecisions(negotiation: Negotiation): string[] {
  const decisions: string[] = [];

  for (const round of negotiation.rounds) {
    for (const message of round.messages) {
      if (message.type === "agreement") {
        decisions.push("Team composition agreed upon");
      }
      if (message.type === "counter_proposal" && message.content.revisedProposal) {
        decisions.push("Alternative proposal considered");
      }
    }
  }

  return decisions.length > 0 ? decisions : ["Initial proposal presented"];
}

function extractFailureReason(negotiation: Negotiation): string {
  for (let i = negotiation.rounds.length - 1; i >= 0; i--) {
    const round = negotiation.rounds[i];
    if (!round) continue;
    for (let j = round.messages.length - 1; j >= 0; j--) {
      const message = round.messages[j];
      if (!message) continue;
      if (message.type === "rejection" && message.content.reason) {
        return String(message.content.reason);
      }
    }
  }

  return "Negotiation failed to reach agreement";
}

function extractFinalProposal(negotiation: Negotiation): TeamProposal | undefined {
  for (let i = negotiation.rounds.length - 1; i >= 0; i--) {
    const round = negotiation.rounds[i];
    if (!round) continue;
    for (let j = round.messages.length - 1; j >= 0; j--) {
      const message = round.messages[j];
      if (!message) continue;
      if (message.type === "agreement" && message.content.agreedProposal) {
        return message.content.agreedProposal as TeamProposal;
      }
      if (message.type === "proposal" && message.content.proposal) {
        return message.content.proposal as TeamProposal;
      }
    }
  }

  return undefined;
}

function isTerminalStatus(status: string): boolean {
  return status === "agreed" || status === "failed" || status === "escalated";
}
