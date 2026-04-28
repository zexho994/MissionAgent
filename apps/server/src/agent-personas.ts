import type { WarRoomAgent } from "./mission-service.js";

export interface AgentPersona {
  role: string;
  systemPrompt: string;
  communicationStyle: string;
  responseGuidelines: string;
  availableActions: string[];
}

export class AgentPersonaRegistry {
  private readonly personas: Map<string, AgentPersona>;

  constructor(personas: Record<string, AgentPersona> = {}) {
    this.personas = new Map(Object.entries(personas));
  }

  personaFor(agent: WarRoomAgent): AgentPersona {
    return this.personas.get(agent.role) ?? {
      role: agent.role,
      systemPrompt: `You are ${agent.name}. Your responsibility is: ${agent.responsibility}`,
      communicationStyle: "Be concise, concrete, and collaborative.",
      responseGuidelines: "Respond only with information that helps the mission move forward.",
      availableActions: ["report_findings", "request_info", "notify_risk", "acknowledge"],
    };
  }
}
