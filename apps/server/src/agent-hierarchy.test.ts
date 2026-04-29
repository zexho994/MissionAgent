import { describe, it, expect } from "vitest";
import { findSuperiors, findSubordinates } from "./agent-hierarchy.js";
import type { AgentRelation, WarRoomAgent } from "./mission-service.js";

function makeAgent(id: string, role: string): WarRoomAgent {
  return {
    id,
    missionId: "mission_1",
    role,
    name: id,
    responsibility: `${role} responsibilities`,
    status: "idle",
    currentTaskId: undefined,
    lastAction: "",
    avatarSeed: id,
    sortOrder: 0,
  };
}

function makeRelation(fromId: string, toId: string, label: string): AgentRelation {
  return {
    id: `rel_${fromId}_${toId}`,
    missionId: "mission_1",
    fromAgentId: fromId,
    toAgentId: toId,
    label,
    status: "active",
    createdAt: new Date().toISOString(),
  };
}

describe("agent-hierarchy", () => {
  const owner = makeAgent("owner_1", "owner");
  const hr = makeAgent("hr_1", "hr");
  const researcher = makeAgent("agent_1", "data_analyst");
  const writer = makeAgent("agent_2", "content_strategist");
  const reviewer = makeAgent("agent_3", "reviewer");

  const agents = [owner, hr, researcher, writer, reviewer];

  const relations: AgentRelation[] = [
    makeRelation(owner.id, hr.id, "Delegate team planning"),
    makeRelation(owner.id, researcher.id, "Oversee and guide"),
    makeRelation(owner.id, writer.id, "Oversee and guide"),
    makeRelation(hr.id, researcher.id, "Assign tasks and monitor"),
    makeRelation(hr.id, writer.id, "Assign tasks and monitor"),
    makeRelation(researcher.id, reviewer.id, "Submit work for review"),
    makeRelation(writer.id, reviewer.id, "Submit work for review"),
  ];

  describe("findSuperiors", () => {
    it("should find owner as superior for worker agents", () => {
      const superiors = findSuperiors(researcher.id, relations, agents);
      expect(superiors).toHaveLength(2);
      const roles = superiors.map((a) => a.role);
      expect(roles).toContain("owner");
      expect(roles).toContain("hr");
    });

    it("should find owner as superior for hr agent", () => {
      const superiors = findSuperiors(hr.id, relations, agents);
      expect(superiors).toHaveLength(1);
      expect(superiors[0]?.role).toBe("owner");
    });

    it("should return empty for owner (top of hierarchy)", () => {
      const superiors = findSuperiors(owner.id, relations, agents);
      expect(superiors).toHaveLength(0);
    });

    it("should not treat non-hierarchical relations as superior links", () => {
      const superiors = findSuperiors(reviewer.id, relations, agents);
      expect(superiors).toHaveLength(0);
    });
  });

  describe("findSubordinates", () => {
    it("should find all subordinates for owner", () => {
      const subs = findSubordinates(owner.id, relations, agents);
      expect(subs).toHaveLength(3);
      const roles = subs.map((a) => a.role);
      expect(roles).toContain("hr");
      expect(roles).toContain("data_analyst");
      expect(roles).toContain("content_strategist");
    });

    it("should find worker subordinates for hr", () => {
      const subs = findSubordinates(hr.id, relations, agents);
      expect(subs).toHaveLength(2);
      const roles = subs.map((a) => a.role);
      expect(roles).toContain("data_analyst");
      expect(roles).toContain("content_strategist");
    });

    it("should return empty for worker agents", () => {
      const subs = findSubordinates(researcher.id, relations, agents);
      expect(subs).toHaveLength(0);
    });
  });
});
