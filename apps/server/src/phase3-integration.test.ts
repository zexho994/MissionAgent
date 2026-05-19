import { describe, it, expect } from "vitest";
import { InMemoryMissionService } from "./mission-service.js";
import { FakeLlmAdapter } from "@digitalagent/runtime";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("Phase 3 integration: knowledge + hierarchy + autonomy", () => {
  it("should store and retrieve knowledge entries", async () => {
    const service = new InMemoryMissionService();
    const mission = await service.createMission({ goal: "test knowledge" });

    service.setKnowledge({
      missionId: mission.id,
      key: "metrics",
      value: JSON.stringify({ followers: 500 }),
      agentId: "agent_analyst",
    });

    service.setKnowledge({
      missionId: mission.id,
      key: "strategy",
      value: "Post daily at 8pm",
      agentId: "agent_strategist",
    });

    const entries = service.listKnowledge({ missionId: mission.id });
    expect(entries).toHaveLength(2);

    const metrics = service.getKnowledge({ missionId: mission.id, key: "metrics" });
    expect(metrics?.value).toContain("500");
  });

  it("should persist knowledge entries across service restarts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "phase3-"));
    const storeFile = join(dir, "store.json");
    const service = new InMemoryMissionService({ storageFile: storeFile });

    const mission = await service.createMission({ goal: "persist knowledge" });
    service.setKnowledge({
      missionId: mission.id,
      key: "daily_check",
      value: "all good",
      agentId: "agent_1",
    });

    const service2 = new InMemoryMissionService({ storageFile: storeFile });
    const entries = service2.listKnowledge({ missionId: mission.id });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.key).toBe("daily_check");

    rmSync(dir, { recursive: true, force: true });
  });

  it("should verify hierarchy relations exist after activation", async () => {
    const llm = new FakeLlmAdapter(() => "test response");
    const service = new InMemoryMissionService({ llm });
    const mission = await service.createMission({
      goal: "test hierarchy",
      successMetrics: ["done"],
      constraints: ["none"],
    });

    await service.activateMission({ missionId: mission.id });

    const snapshot = service.snapshot();
    const relations = snapshot.agentRelations.filter((r) => r.missionId === mission.id);
    expect(relations.length).toBeGreaterThan(0);

    const owner = snapshot.agents.find((a) => a.missionId === mission.id && a.role === "owner");
    const worker = snapshot.agents.find((a) => a.missionId === mission.id && a.role !== "owner" && a.role !== "hr");
    expect(owner).toBeDefined();
    expect(worker).toBeDefined();

    const ownerRelations = relations.filter((r) => r.fromAgentId === owner?.id || r.toAgentId === owner?.id);
    expect(ownerRelations.length).toBeGreaterThan(0);
  });

  it("should start autonomy loop on keyword-based activation", async () => {
    const llm = new FakeLlmAdapter(() => "test response");
    const service = new InMemoryMissionService({ llm });
    const mission = await service.createMission({
      goal: "test autonomy start",
      successMetrics: ["done"],
      constraints: ["none"],
    });

    await service.activateMission({ missionId: mission.id });

    expect((service as any).autonomyService).toBeDefined();
    expect((service as any).autonomyService.isRunning(mission.id)).toBe(true);
  });

  it("should start autonomy loop on HR negotiation confirm", async () => {
    const fake = new FakeLlmAdapter((messages) => {
      const content = typeof messages[0] === "object" ? (messages[messages.length - 1]?.content ?? "") : "";
      if (content.includes("brief")) {
        return JSON.stringify({
          goal: "test negotiation autonomy",
          scope: "test scope",
          constraints: ["none"],
          successMetrics: ["done"],
          keyAssumptions: ["test"],
          targetAudience: "testers",
          timeline: "1 day",
        });
      }
      if (content.includes("mission")) {
        return JSON.stringify({
          requiredCapabilities: ["data_analysis"],
          estimatedTeamSize: 2,
          priorityRoles: ["data_analyst"],
          complexity: "low",
          riskFactors: [],
        });
      }
      return JSON.stringify([{
        name: "DataAnalyst",
        purpose: "Analyze data",
        responsibilities: ["Track metrics"],
        allowedTools: ["web_search"],
        successCriteria: ["Metrics tracked"],
        budget: { maxRuntimeMinutes: 60, maxTasks: 5 },
      }]);
    });

    const service = new InMemoryMissionService({ llm: fake });

    const mission = await service.createMission({
      goal: "test negotiation autonomy",
      successMetrics: ["done"],
      constraints: ["none"],
    });

    await service.continueMission({ missionId: mission.id, message: "确认" });

    const current = service.snapshot().missions.find((m) => m.id === mission.id);
    if (current?.brief) {
      service.confirmBrief({ missionId: mission.id });
      await service.activateMission({ missionId: mission.id });

      const negotiation = service.getNegotiation({ missionId: mission.id });
      if (negotiation) {
        service.confirmNegotiation({ missionId: mission.id });
        expect((service as any).autonomyService?.isRunning(mission.id) ?? false).toBe(true);
      }
    }
  });
});
