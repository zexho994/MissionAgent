import { createId } from "./ids.js";
import type { RoleSpec } from "./types.js";

export type PersonalityType =
  | "analytical"
  | "creative"
  | "collaborative"
  | "decisive"
  | "friendly"
  | "formal"
  | "casual";

export type CommunicationStyle = "formal" | "neutral" | "casual";

export type DecisionMakingStyle =
  | "data-driven"
  | "intuitive"
  | "collaborative"
  | "autonomous"
  | "balanced";

export interface AgentTemplate {
  id: string;
  name: string;
  roleType: string;
  baseCapabilities: string[];
  defaultTools: string[];
  createdAt: Date;
}

export interface CreateAgentTemplateInput {
  name: string;
  roleType: string;
  baseCapabilities: string[];
  defaultTools: string[];
}

export function createAgentTemplate(
  input: CreateAgentTemplateInput
): AgentTemplate {
  if (!input.name.trim()) {
    throw new Error("Template name is required");
  }
  if (!input.roleType.trim()) {
    throw new Error("Role type is required");
  }
  if (input.baseCapabilities.length === 0) {
    throw new Error("At least one capability is required");
  }
  if (input.defaultTools.length === 0) {
    throw new Error("At least one tool is required");
  }

  return {
    id: createId("template"),
    name: input.name,
    roleType: input.roleType,
    baseCapabilities: [...input.baseCapabilities],
    defaultTools: [...input.defaultTools],
    createdAt: new Date(),
  };
}

export interface AgentPersona {
  id: string;
  name: string;
  personality: PersonalityType;
  communicationStyle: CommunicationStyle;
  decisionMaking: DecisionMakingStyle;
  systemPrompt: string;
  createdAt: Date;
}

export interface CreateAgentPersonaInput {
  name: string;
  personality: PersonalityType;
  communicationStyle?: CommunicationStyle;
  decisionMaking?: DecisionMakingStyle;
  systemPrompt: string;
}

export function createAgentPersona(
  input: CreateAgentPersonaInput
): AgentPersona {
  if (!input.name.trim()) {
    throw new Error("Persona name is required");
  }
  if (!input.systemPrompt.trim()) {
    throw new Error("System prompt is required");
  }

  return {
    id: createId("persona"),
    name: input.name,
    personality: input.personality,
    communicationStyle: input.communicationStyle ?? "neutral",
    decisionMaking: input.decisionMaking ?? "balanced",
    systemPrompt: input.systemPrompt,
    createdAt: new Date(),
  };
}

export interface TeamContext {
  teamMembers: string[];
  reportingLine: string;
  collaborators: string[];
}

export interface AgentOnboardingContext {
  id: string;
  agentId: string;
  missionId: string;
  roleSpec: RoleSpec;
  teamContext: TeamContext;
  initialInstructions: string | undefined;
  createdAt: Date;
}

export interface CreateAgentOnboardingContextInput {
  agentId: string;
  missionId: string;
  roleSpec: RoleSpec;
  teamContext: TeamContext;
  initialInstructions?: string;
}

export function createAgentOnboardingContext(
  input: CreateAgentOnboardingContextInput
): AgentOnboardingContext {
  if (!input.agentId.trim()) {
    throw new Error("Agent ID is required");
  }
  if (!input.missionId.trim()) {
    throw new Error("Mission ID is required");
  }

  return {
    id: createId("onboarding"),
    agentId: input.agentId,
    missionId: input.missionId,
    roleSpec: { ...input.roleSpec },
    teamContext: {
      teamMembers: [...input.teamContext.teamMembers],
      reportingLine: input.teamContext.reportingLine,
      collaborators: [...input.teamContext.collaborators],
    },
    initialInstructions: input.initialInstructions,
    createdAt: new Date(),
  };
}

export interface RoleSpecSummary {
  name: string;
  purpose: string;
  responsibilities: string[];
  successCriteria: string[];
}

export function generateSystemPrompt(
  persona: AgentPersona,
  roleSpec: RoleSpecSummary
): string {
  const sections: string[] = [];

  sections.push(persona.systemPrompt);

  sections.push("\n## Your Role");
  sections.push(`**Name:** ${roleSpec.name}`);
  sections.push(`**Purpose:** ${roleSpec.purpose}`);

  if (roleSpec.responsibilities.length > 0) {
    sections.push("\n## Responsibilities");
    roleSpec.responsibilities.forEach((resp, index) => {
      sections.push(`${index + 1}. ${resp}`);
    });
  }

  if (roleSpec.successCriteria.length > 0) {
    sections.push("\n## Success Criteria");
    roleSpec.successCriteria.forEach((criteria) => {
      sections.push(`- ${criteria}`);
    });
  }

  sections.push("\n## Your Approach");
  sections.push(`- **Personality:** ${persona.personality}`);
  sections.push(`- **Communication Style:** ${persona.communicationStyle}`);
  sections.push(`- **Decision Making:** ${persona.decisionMaking}`);

  return sections.join("\n");
}