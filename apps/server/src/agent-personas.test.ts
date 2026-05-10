import { describe, expect, it } from "vitest";
import { loadAgentSystemConfig } from "./system-config.js";
import { AgentPersonaRegistry } from "./agent-personas.js";
import type { WarRoomAgent } from "./mission-service.js";

function makeAgent(role: string, name: string): WarRoomAgent {
  return {
    id: `a-${role}`,
    missionId: "m-1",
    role,
    name,
    responsibility: "test",
    status: "idle",
    currentTaskId: undefined,
    lastAction: "",
    avatarSeed: name,
    sortOrder: 0,
  } as WarRoomAgent;
}

describe("Owner persona", () => {
  it("includes create_followup_task in availableActions (loaded from agent-system.json)", () => {
    const config = loadAgentSystemConfig();
    const personas = config.agentCollaboration?.personas ?? {};
    const ownerConfig = personas.owner;
    expect(ownerConfig).toBeDefined();
    expect(ownerConfig?.availableActions).toContain("create_followup_task");
  });

  it("AgentPersonaRegistry.personaFor exposes create_followup_task for owner", () => {
    const config = loadAgentSystemConfig();
    const personas = config.agentCollaboration?.personas ?? {};
    const registry = new AgentPersonaRegistry(personas);
    const persona = registry.personaFor(makeAgent("owner", "Owner"));
    expect(persona.availableActions).toContain("create_followup_task");
  });

  it("non-owner roles do NOT have create_followup_task in v1", () => {
    const config = loadAgentSystemConfig();
    const personas = config.agentCollaboration?.personas ?? {};
    const registry = new AgentPersonaRegistry(personas);
    for (const role of ["researcher", "content_strategist", "reviewer"]) {
      const persona = registry.personaFor(makeAgent(role, role));
      expect(persona.availableActions).not.toContain("create_followup_task");
    }
  });
});
