import { describe, expect, it } from "vitest";
import { InMemoryMissionService } from "./mission-service.js";

describe("propose_strategy_adjustment action", () => {
  it("creates accepted StrategyAdjustment when Owner proposes it", async () => {
    const service = new InMemoryMissionService();
    const mission = await service.createMission({ goal: "Grow a GitHub repository" });
    service.activateMission({ missionId: mission.id });

    // Simulate Owner calling propose_strategy_adjustment
    const previousStrategy = "Post broad content experiments.";
    const proposedStrategy = "Focus on evidence-backed repository growth loops.";
    const rationale = "Recent tasks failed due to lack of clear growth metric path.";

    const adjustment = {
      missionId: mission.id,
      status: "accepted" as const,
      previousStrategy,
      proposedStrategy,
      rationale,
      affectedAgentRoles: ["owner", "data_analyst"],
      proposedTaskGoals: ["Review repository growth metric assumptions"],
      requiresHrReview: true,
    };

    service.recordAcceptedStrategyAdjustment(
      adjustment as import("@digitalagent/core").StrategyAdjustment,
    );

    const snapshot = service.snapshot();
    const found = snapshot.strategyAdjustments.find(
      (a) => a.missionId === mission.id && a.rationale === rationale,
    );
    expect(found).toBeDefined();
    expect(found?.status).toBe("accepted");
  });
});
