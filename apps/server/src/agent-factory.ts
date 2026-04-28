import {
  createId,
  type RoleSpec,
  type AgentPersona,
  type AgentTemplate,
  type TeamContext,
  generateSystemPrompt,
} from "@digitalagent/core";

export interface WarRoomAgent {
  id: string;
  missionId: string;
  role: string;
  name: string;
  responsibility: string;
  status: "idle" | "thinking" | "running" | "blocked" | "done";
  currentTaskId: string | undefined;
  lastAction: string;
  avatarSeed: string;
  sortOrder: number;
  toolPermissions: string[];
  budget: {
    maxRuntimeMinutes: number;
    maxTasks: number;
  };
}

export interface AgentRelation {
  id: string;
  missionId: string;
  fromAgentId: string;
  toAgentId: string;
  label: string;
  status: "active" | "waiting" | "done";
  createdAt: string;
}

export interface AgentFactoryOptions {
  defaultAvatarSeed?: string;
  defaultStatus?: WarRoomAgent["status"];
}

export type AgentFactory = ReturnType<typeof createAgentFactory>;

export function createAgentFactory(options: AgentFactoryOptions = {}) {
  const {
    defaultAvatarSeed = "agent",
    defaultStatus = "idle",
  } = options;

  return {
    createAgentFromRoleSpec,
    generateSystemPrompt: generateSystemPromptWrapper,
    setupRelations,
    inferAgentPersona,
  };

  function createAgentFromRoleSpec(
    missionId: string,
    spec: RoleSpec,
    sortOrder: number,
  ): WarRoomAgent {
    return {
      id: createId("agent"),
      missionId,
      role: spec.id,
      name: spec.name,
      responsibility: spec.purpose,
      status: defaultStatus,
      currentTaskId: undefined,
      lastAction: "Waiting for task assignment",
      avatarSeed: generateAvatarSeed(spec.name),
      sortOrder,
      toolPermissions: [...spec.allowedTools],
      budget: { ...spec.budget },
    };
  }

  function generateSystemPromptWrapper(
    spec: RoleSpec,
    persona: AgentPersona,
  ): string {
    const roleSpecSummary = {
      name: spec.name,
      purpose: spec.purpose,
      responsibilities: spec.responsibilities,
      successCriteria: spec.successCriteria,
    };

    let prompt = generateSystemPrompt(persona, roleSpecSummary);

    if (spec.inputContract && Object.keys(spec.inputContract).length > 0) {
      prompt += "\n\n## Input Contract\n";
      prompt += JSON.stringify(spec.inputContract, null, 2);
    }

    if (spec.outputContract && Object.keys(spec.outputContract).length > 0) {
      prompt += "\n\n## Output Contract\n";
      prompt += JSON.stringify(spec.outputContract, null, 2);
    }

    return prompt;
  }

  function setupRelations(agents: WarRoomAgent[]): AgentRelation[] {
    const relations: AgentRelation[] = [];
    const missionId = agents[0]?.missionId || "";

    const sortedAgents = [...agents].sort((a, b) => a.sortOrder - b.sortOrder);

    for (let i = 0; i < sortedAgents.length; i++) {
      const current = sortedAgents[i];
      if (!current) continue;

      if (i > 0) {
        const previous = sortedAgents[i - 1];
        if (previous) {
          relations.push(createRelation({
            missionId,
            fromAgentId: previous.id,
            toAgentId: current.id,
            label: determineRelationLabel(previous.role, current.role),
            status: i === 1 ? "active" : "waiting",
          }));
        }
      }

      if (current.role === "owner") {
        for (let j = i + 1; j < sortedAgents.length; j++) {
          const specialist = sortedAgents[j];
          if (specialist && specialist.role !== "hr") {
            relations.push(createRelation({
              missionId,
              fromAgentId: current.id,
              toAgentId: specialist.id,
              label: "Oversee and guide",
              status: "active",
            }));
          }
        }
      }

      if (current.role === "hr") {
        for (let j = i + 1; j < sortedAgents.length; j++) {
          const specialist = sortedAgents[j];
          if (specialist && specialist.role !== "owner") {
            relations.push(createRelation({
              missionId,
              fromAgentId: current.id,
              toAgentId: specialist.id,
              label: "Assign tasks and monitor",
              status: specialist.role === "reviewer" ? "waiting" : "active",
            }));
          }
        }
      }
    }

    const reviewers = sortedAgents.filter(agent => agent.role === "reviewer");
    const workers = sortedAgents.filter(agent =>
      agent.role !== "owner" &&
      agent.role !== "hr" &&
      agent.role !== "reviewer",
    );

    for (const reviewer of reviewers) {
      for (const worker of workers) {
        const existingRelation = relations.find(
          r => r.fromAgentId === worker.id && r.toAgentId === reviewer.id,
        );

        if (!existingRelation) {
          relations.push(createRelation({
            missionId,
            fromAgentId: worker.id,
            toAgentId: reviewer.id,
            label: "Submit work for review",
            status: "waiting",
          }));
        }
      }
    }

    return relations;
  }

  function inferAgentPersona(spec: RoleSpec): AgentPersona {
    const personality = inferPersonality(spec);
    const communicationStyle = inferCommunicationStyle(spec);
    const decisionMaking = inferDecisionMaking(spec);
    const systemPrompt = generateBaseSystemPrompt(spec, personality, communicationStyle, decisionMaking);

    return {
      id: createId("persona"),
      name: `${spec.name} Persona`,
      personality,
      communicationStyle,
      decisionMaking,
      systemPrompt,
      createdAt: new Date(),
    };
  }
}

function createRelation(input: Omit<AgentRelation, "id" | "createdAt">): AgentRelation {
  return {
    ...input,
    id: createId("relation"),
    createdAt: new Date().toISOString(),
  };
}

function generateAvatarSeed(roleName: string): string {
  const normalized = roleName.toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "");

  const seeds: Record<string, string> = {
    "owner": "owner",
    "hr": "hr",
    "system-architect": "architect",
    "researcher": "researcher",
    "developer": "developer",
    "reviewer": "reviewer",
    "tester": "tester",
    "designer": "designer",
  };

  return seeds[normalized] || normalized;
}

function determineRelationLabel(fromRole: string, toRole: string): string {
  const labels: Record<string, Record<string, string | undefined>> = {
    owner: {
      hr: "Delegate team planning",
      researcher: "Request research and analysis",
      developer: "Assign development tasks",
      reviewer: "Request quality assurance",
      default: "Assign responsibilities",
    },
    hr: {
      researcher: "Onboard and assign research tasks",
      developer: "Onboard and assign development tasks",
      reviewer: "Coordinate review workflow",
      default: "Coordinate and assign work",
    },
    researcher: {
      developer: "Provide research findings",
      reviewer: "Submit research for review",
      default: "Collaborate and share findings",
    },
    developer: {
      reviewer: "Submit implementation for review",
      tester: "Submit for testing",
      default: "Collaborate on implementation",
    },
    default: {
      default: "Coordinate and collaborate",
    },
  };

  const fromLabel = labels[fromRole]?.[toRole] || labels[fromRole]?.default;
  const defaultLabel = labels.default?.default;
  return fromLabel || defaultLabel || "Collaborate";
}

function inferPersonality(spec: RoleSpec): AgentPersona["personality"] {
  const name = spec.name.toLowerCase();
  const purpose = spec.purpose.toLowerCase();

  if (name.includes("architect") || name.includes("design")) {
    return "analytical";
  }
  if (name.includes("creative") || name.includes("writer") || name.includes("content")) {
    return "creative";
  }
  if (name.includes("manager") || name.includes("coordinator")) {
    return "collaborative";
  }
  if (name.includes("lead") || name.includes("senior")) {
    return "decisive";
  }
  if (name.includes("support") || name.includes("assistant")) {
    return "friendly";
  }

  if (purpose.includes("design") || purpose.includes("architect")) {
    return "analytical";
  }
  if (purpose.includes("create") || purpose.includes("content")) {
    return "creative";
  }
  if (purpose.includes("coordinate") || purpose.includes("manage")) {
    return "collaborative";
  }

  return "collaborative";
}

function inferCommunicationStyle(spec: RoleSpec): AgentPersona["communicationStyle"] {
  const name = spec.name.toLowerCase();

  if (name.includes("architect") || name.includes("lead") || name.includes("senior")) {
    return "formal";
  }
  if (name.includes("support") || name.includes("assistant")) {
    return "casual";
  }

  return "neutral";
}

function inferDecisionMaking(spec: RoleSpec): AgentPersona["decisionMaking"] {
  const name = spec.name.toLowerCase();
  const purpose = spec.purpose.toLowerCase();

  if (name.includes("architect") || name.includes("analyst")) {
    return "data-driven";
  }
  if (name.includes("creative") || name.includes("designer")) {
    return "intuitive";
  }
  if (name.includes("manager") || name.includes("coordinator")) {
    return "collaborative";
  }
  if (name.includes("lead") || name.includes("owner")) {
    return "autonomous";
  }

  if (purpose.includes("analyze") || purpose.includes("research")) {
    return "data-driven";
  }
  if (purpose.includes("coordinate") || purpose.includes("team")) {
    return "collaborative";
  }

  return "balanced";
}

function generateBaseSystemPrompt(
  spec: RoleSpec,
  personality: AgentPersona["personality"],
  communicationStyle: AgentPersona["communicationStyle"],
  decisionMaking: AgentPersona["decisionMaking"],
): string {
  const personalityTraits: Record<AgentPersona["personality"], string> = {
    analytical: "systematic, detail-oriented, and logic-driven",
    creative: "innovative, imaginative, and original",
    collaborative: "team-oriented, cooperative, and inclusive",
    decisive: "assertive, action-oriented, and confident",
    friendly: "approachable, supportive, and helpful",
    formal: "professional, structured, and precise",
    casual: "relaxed, straightforward, and easygoing",
  };

  const communicationStyles: Record<AgentPersona["communicationStyle"], string> = {
    formal: "professional language with clear structure",
    neutral: "balanced and appropriate communication",
    casual: "conversational and accessible language",
  };

  const decisionStyles: Record<AgentPersona["decisionMaking"], string> = {
    "data-driven": "bases decisions on thorough analysis and evidence",
    intuitive: "relies on expertise and creative insight",
    collaborative: "seeks input and builds consensus",
    autonomous: "makes independent decisions with confidence",
    balanced: "combines analysis, intuition, and collaboration",
  };

  return [
    `You are a ${spec.name} with a ${personality} personality.`,
    `You are ${personalityTraits[personality]} and communicate using ${communicationStyles[communicationStyle]}.`,
    `You ${decisionStyles[decisionMaking]}.`,
    "",
    `**Your Purpose:** ${spec.purpose}`,
    "",
    "**Key Traits:**",
    `- Approach: ${personality}`,
    `- Communication: ${communicationStyle}`,
    `- Decision Making: ${decisionMaking}`,
    "",
    "**Core Responsibilities:**",
    ...spec.responsibilities.map(r => `- ${r}`),
    "",
    "**Success Criteria:**",
    ...spec.successCriteria.map(c => `- ${c}`),
    "",
    "Always maintain your personality while fulfilling your role responsibilities.",
    "Adapt your communication style to be effective while staying true to your character.",
  ].join("\n");
}