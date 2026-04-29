import { describe, it, expect } from "vitest";
import { createKnowledgeEntry, type KnowledgeEntry } from "./knowledge-base.js";

describe("createKnowledgeEntry", () => {
  it("should create an entry with generated id and timestamp", () => {
    const entry = createKnowledgeEntry({
      missionId: "mission_1",
      key: "daily_metrics",
      value: JSON.stringify({ followers: 500, engagement: 0.03 }),
      sourceAgentId: "agent_analyst",
    });

    expect(entry.id).toMatch(/^knowledge_/);
    expect(entry.missionId).toBe("mission_1");
    expect(entry.key).toBe("daily_metrics");
    expect(entry.value).toBe(JSON.stringify({ followers: 500, engagement: 0.03 }));
    expect(entry.sourceAgentId).toBe("agent_analyst");
    expect(entry.createdAt).toBeTruthy();
  });

  it("should create unique ids for each entry", () => {
    const entry1 = createKnowledgeEntry({
      missionId: "m1",
      key: "k1",
      value: "v1",
      sourceAgentId: "a1",
    });
    const entry2 = createKnowledgeEntry({
      missionId: "m1",
      key: "k2",
      value: "v2",
      sourceAgentId: "a1",
    });

    expect(entry1.id).not.toBe(entry2.id);
  });

  it("should preserve all input fields immutably", () => {
    const input = {
      missionId: "mission_1",
      key: "test_key",
      value: "test_value",
      sourceAgentId: "agent_1",
    };

    const entry = createKnowledgeEntry(input);

    expect(entry).toMatchObject(input);
    expect(entry).toHaveProperty("id");
    expect(entry).toHaveProperty("createdAt");
  });
});
