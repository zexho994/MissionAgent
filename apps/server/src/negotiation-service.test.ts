import { describe, it, expect, beforeEach } from "vitest";
import {
  createNegotiation,
  createNegotiationMessage,
  transitionNegotiation,
  calculateAgreementScore,
  type Negotiation,
  type NegotiationMessage,
  type RoleSpec,
} from "@digitalagent/core";
import {
  createNegotiationService,
  type TeamProposal,
  type OwnerContext,
} from "./negotiation-service.js";
import type { LlmService } from "@digitalagent/runtime";

describe("NegotiationService", () => {
  let mockLlm: LlmService;
  let negotiationService: ReturnType<typeof createNegotiationService>;
  let mockProposal: TeamProposal;
  let mockOwnerContext: OwnerContext;

  beforeEach(() => {
    mockLlm = {
      call: async () => ({
        content: "LLM response",
        model: "test-model",
        usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
        finishReason: "stop",
      }),
      stats: () => ({
        totalCalls: 0,
        totalPromptTokens: 0,
        totalCompletionTokens: 0,
      }),
    };

    negotiationService = createNegotiationService({ llm: mockLlm });

    mockProposal = {
      missionId: "mission-123",
      roles: [
        {
          id: "role-1",
          name: "Architect",
          purpose: "Design system",
          responsibilities: ["Design", "Document"],
          allowedTools: ["code", "diagrams"],
          inputContract: {},
          outputContract: {},
          successCriteria: ["Design complete"],
          budget: { maxRuntimeMinutes: 120, maxTasks: 5 },
        },
      ],
      proposedBy: "hr-agent-1",
      totalBudget: { maxRuntimeMinutes: 120, maxTasks: 5 },
      estimatedDuration: "2 hours",
      riskAssessment: ["Technical complexity", "Time constraints"],
      collaborationPlan: {
        workflow: "Sequential",
        communicationChannels: ["Direct messages"],
        decisionMaking: "Consensus",
      },
      createdAt: new Date(),
    };

    mockOwnerContext = {
      ownerAgentId: "owner-1",
      preferences: {
        teamSize: [1, 3],
        maxBudget: { maxRuntimeMinutes: 180, maxTasks: 10 },
        preferredCapabilities: ["system_architecture"],
        avoidCapabilities: [],
      },
      constraints: ["Must use TypeScript", "Follow security best practices"],
      previousFeedback: [],
    };
  });

  describe("startNegotiation", () => {
    it("should initialize negotiation between HR and Owner", async () => {
      const negotiation = await negotiationService.startNegotiation(
        mockProposal,
        mockOwnerContext,
      );

      expect(negotiation.missionId).toBe(mockProposal.missionId);
      expect(negotiation.initiatorId).toContain("hr");
      expect(negotiation.participantId).toBe(mockOwnerContext.ownerAgentId);
      expect(negotiation.topic.toLowerCase()).toContain("team");
      expect(negotiation.status).toBe("active"); // After initial proposal message
      expect(negotiation.rounds).toHaveLength(1); // One round started
    });

    it("should create initial proposal message", async () => {
      const negotiation = await negotiationService.startNegotiation(
        mockProposal,
        mockOwnerContext,
      );

      expect(negotiation.rounds).toHaveLength(1);
      expect(negotiation.currentRound).toBe(1);
      expect(negotiation.status).toBe("active");

      const firstRound = negotiation.rounds[0];
      if (firstRound) {
        expect(firstRound.messages).toHaveLength(1);
        expect(firstRound.messages[0]?.type).toBe("proposal");
      }
    });

    it("should include proposal details in initial message", async () => {
      mockLlm.call = async () => ({
        content: JSON.stringify({
          message: "I propose the following team for your mission",
          proposal: mockProposal,
          justification: "Based on mission requirements",
        }),
        model: "test-model",
        usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
        finishReason: "stop",
      });
      mockLlm.stats = () => ({ totalCalls: 0, totalPromptTokens: 0, totalCompletionTokens: 0 });

      const negotiation = await negotiationService.startNegotiation(
        mockProposal,
        mockOwnerContext,
      );

      const proposalMessage = negotiation.rounds[0]?.messages[0];
      expect(proposalMessage).toBeDefined();
      expect(proposalMessage?.type).toBe("proposal");
      expect(proposalMessage?.content).toBeDefined();
    });
  });

  describe("processRound", () => {
    it("should advance negotiation state with valid message", async () => {
      const negotiation = await negotiationService.startNegotiation(
        mockProposal,
        mockOwnerContext,
      );

      const ownerMessage: NegotiationMessage = {
        id: "msg-2",
        senderId: mockOwnerContext.ownerAgentId,
        receiverId: negotiation.initiatorId,
        type: "counter_proposal",
        content: {
          feedback: "Team looks good, but reduce budget",
          counterProposal: {
            ...mockProposal,
            totalBudget: { maxRuntimeMinutes: 90, maxTasks: 3 },
          },
        },
        timestamp: new Date(),
      };

      mockLlm.call = async () => ({
        content: JSON.stringify({
          type: "counter_proposal",
          message: "I can adjust the budget as requested",
          revisedProposal: {
            ...mockProposal,
            totalBudget: { maxRuntimeMinutes: 90, maxTasks: 3 },
          },
        }),
        model: "test-model",
        usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
        finishReason: "stop",
      });
      mockLlm.stats = () => ({ totalCalls: 0, totalPromptTokens: 0, totalCompletionTokens: 0 });

      const updated = await negotiationService.processRound(
        negotiation,
        ownerMessage,
      );

      expect(updated.status).toBe("active");
      expect(updated.rounds.length).toBeGreaterThanOrEqual(1);
    });

    it("should detect agreement and transition to agreed state", async () => {
      const negotiation = await negotiationService.startNegotiation(
        mockProposal,
        mockOwnerContext,
      );

      const agreementMessage: NegotiationMessage = {
        id: "msg-3",
        senderId: mockOwnerContext.ownerAgentId,
        receiverId: negotiation.initiatorId,
        type: "agreement",
        content: {
          message: "Team proposal accepted",
          agreedProposal: mockProposal,
        },
        timestamp: new Date(),
      };

      mockLlm.call = async () => ({
        content: JSON.stringify({
          type: "agreement",
          message: "Great! I'll proceed with team creation",
        }),
        model: "test-model",
        usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
        finishReason: "stop",
      });
      mockLlm.stats = () => ({ totalCalls: 0, totalPromptTokens: 0, totalCompletionTokens: 0 });

      const updated = await negotiationService.processRound(
        negotiation,
        agreementMessage,
      );

      expect(updated.status).toBe("agreed");
      expect(updated.endedAt).toBeDefined();
    });

    it("should handle rejection and transition to failed state", async () => {
      const negotiation = await negotiationService.startNegotiation(
        mockProposal,
        mockOwnerContext,
      );

      const rejectionMessage: NegotiationMessage = {
        id: "msg-4",
        senderId: mockOwnerContext.ownerAgentId,
        receiverId: negotiation.initiatorId,
        type: "rejection",
        content: {
          reason: "Team composition doesn't meet requirements",
          feedback: "Need different skill set",
        },
        timestamp: new Date(),
      };

      const updated = await negotiationService.processRound(
        negotiation,
        rejectionMessage,
      );

      expect(updated.status).toBe("failed");
      expect(updated.endedAt).toBeDefined();
    });

    it("should handle escalation requests", async () => {
      const negotiation = await negotiationService.startNegotiation(
        mockProposal,
        mockOwnerContext,
      );

      const escalationMessage: NegotiationMessage = {
        id: "msg-5",
        senderId: mockOwnerContext.ownerAgentId,
        receiverId: negotiation.initiatorId,
        type: "escalation_request",
        content: {
          reason: "Unable to agree on team composition",
          userIntervention: true,
        },
        timestamp: new Date(),
      };

      const updated = await negotiationService.processRound(
        negotiation,
        escalationMessage,
      );

      expect(updated.status).toBe("escalated");
      expect(updated.escalationReason).toBeDefined();
      expect(updated.endedAt).toBeDefined();
    });

    it("should prevent transitions from terminal states", async () => {
      const agreedNegotiation = createNegotiation({
        missionId: "mission-123",
        initiatorId: "hr-1",
        participantId: "owner-1",
        topic: "team proposal",
      });

      const proposalMessage = createNegotiationMessage({
        senderId: "hr-1",
        receiverId: "owner-1",
        type: "proposal",
        content: {},
      });

      const activeNegotiation = transitionNegotiation(agreedNegotiation, proposalMessage);

      const terminal = transitionNegotiation(activeNegotiation, createNegotiationMessage({
        senderId: "owner-1",
        receiverId: "hr-1",
        type: "agreement",
        content: {},
      }));

      const extraMessage = createNegotiationMessage({
        senderId: "owner-1",
        receiverId: "hr-1",
        type: "counter_proposal",
        content: {},
      });

      await expect(
        negotiationService.processRound(terminal, extraMessage),
      ).rejects.toThrow();
    });
  });

  describe("checkAgreement", () => {
    it("should return true when both parties agree", () => {
      const proposal = { teamSize: 3, budget: 100 };
      const counter = { teamSize: 3, budget: 100 };

      const score = calculateAgreementScore(proposal, counter);
      expect(score).toBe(1);
    });

    it("should calculate partial agreement score", () => {
      const proposal = { teamSize: 3, budget: 100, tools: ["code", "test"] };
      const counter = { teamSize: 3, budget: 80, tools: ["code", "deploy"] };

      const score = calculateAgreementScore(proposal, counter);
      expect(score).toBeGreaterThan(0);
      expect(score).toBeLessThan(1);
    });

    it("should detect low agreement and suggest escalation", () => {
      const proposal = { teamSize: 5, budget: 200, tools: ["code", "test", "deploy"] };
      const counter = { teamSize: 2, budget: 50, tools: ["design"] };

      const score = calculateAgreementScore(proposal, counter);
      expect(score).toBeLessThan(0.5);
    });
  });

  describe("escalateToUser", () => {
    it("should transition negotiation to escalated state", async () => {
      const negotiation = await negotiationService.startNegotiation(
        mockProposal,
        mockOwnerContext,
      );

      const escalated = await negotiationService.escalateToUser(
        negotiation,
        "Unable to reach agreement after multiple rounds",
      );

      expect(escalated.status).toBe("escalated");
      expect(escalated.escalationReason).toBeDefined();
      expect(escalated.endedAt).toBeDefined();
    });

    it("should include negotiation history in escalation", async () => {
      const negotiation = await negotiationService.startNegotiation(
        mockProposal,
        mockOwnerContext,
      );

      // Add some rounds
      let current = negotiation;
      for (let i = 0; i < 3; i++) {
        const message = createNegotiationMessage({
          senderId: `agent-${i}`,
          receiverId: `agent-${i + 1}`,
          type: "counter_proposal",
          content: { round: i },
        });
        current = transitionNegotiation(current, message);
      }

      const escalated = await negotiationService.escalateToUser(
        current,
        "Max rounds reached",
      );

      expect(escalated.rounds.length).toBeGreaterThanOrEqual(3);
      expect(escalated.escalationReason).toContain("Max rounds");
    });
  });

  describe("generateNegotiationSummary", () => {
    it("should summarize successful negotiation", async () => {
      const negotiation = await negotiationService.startNegotiation(
        mockProposal,
        mockOwnerContext,
      );

      // Simulate agreement
      const agreementMessage = createNegotiationMessage({
        senderId: mockOwnerContext.ownerAgentId,
        receiverId: negotiation.initiatorId,
        type: "agreement",
        content: {
          message: "Team proposal accepted",
          agreedProposal: mockProposal,
        },
      });

      const agreed = transitionNegotiation(negotiation, agreementMessage);

      const summary = await negotiationService.generateNegotiationSummary(agreed);

      expect(summary.outcome).toBe("agreed");
      expect(summary.finalProposal).toBeDefined();
      expect(summary.roundsCompleted).toBeGreaterThan(0);
      expect(summary.keyDecisions).toBeDefined();
    });

    it("should summarize failed negotiation with reasons", async () => {
      const negotiation = await negotiationService.startNegotiation(
        mockProposal,
        mockOwnerContext,
      );

      // Simulate rejection
      const rejectionMessage = createNegotiationMessage({
        senderId: mockOwnerContext.ownerAgentId,
        receiverId: negotiation.initiatorId,
        type: "rejection",
        content: {
          reason: "Budget too high",
          feedback: "Need to reduce costs",
        },
      });

      const failed = transitionNegotiation(negotiation, rejectionMessage);

      const summary = await negotiationService.generateNegotiationSummary(failed);

      expect(summary.outcome).toBe("failed");
      expect(summary.failureReason).toBeDefined();
      expect(summary.alternatives).toBeDefined();
    });
  });
});