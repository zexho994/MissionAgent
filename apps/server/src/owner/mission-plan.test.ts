import { describe, expect, it } from "vitest";
import type { MissionBrief } from "@digitalagent/core";
import { buildMissionPlanMessages, parseMissionPlanDraft } from "./mission-plan.js";

const brief: MissionBrief = {
  goal: "Grow two GitHub repositories past 1k stars",
  scope: "GitHub account and repository growth",
  constraints: ["one month"],
  successMetrics: ["two repositories exceed 1k stars"],
  keyAssumptions: ["developer audience"],
  targetAudience: "GitHub developers",
  timeline: "one month",
};

describe("MissionPlan Owner prompt/parser", () => {
  it("parses a complete MissionPlan JSON object", () => {
    const plan = parseMissionPlanDraft(`{
      "goal":"Grow two GitHub repositories past 1k stars",
      "successMetrics":["two repositories exceed 1k stars"],
      "phases":[{"name":"Positioning","objective":"Clarify repository story","deliverables":["profile update"],"successCriteria":["story is clear"]}],
      "workstreams":[{"name":"Content","objective":"Publish useful updates","requiredRole":"Content Strategist","responsibilities":["write posts"],"firstTaskGoal":"Draft launch post"}],
      "reportingLines":[{"fromRole":"Content Strategist","toRole":"Owner","cadence":"daily","purpose":"Progress updates"}],
      "scheduleRhythms":[{"name":"Daily growth check","cadence":"daily","ownerRole":"Owner","purpose":"Review star growth"}],
      "risks":["content may not resonate"],
      "checkpoints":["weekly star review"]
    }`);

    expect(plan.goal).toBe("Grow two GitHub repositories past 1k stars");
    expect(plan.workstreams[0]?.requiredRole).toBe("Content Strategist");
    expect(plan.scheduleRhythms[0]?.cadence).toBe("daily");
  });

  it("rejects malformed plan output instead of falling back", () => {
    expect(() => parseMissionPlanDraft(`{"goal":"x","successMetrics":[]}`)).toThrow(
      "MissionPlan must have non-empty successMetrics",
    );
    expect(() => parseMissionPlanDraft("plain text")).toThrow("No JSON object found in LLM response");
  });

  it("builds planning messages with confirmed brief and optional feedback", () => {
    const messages = buildMissionPlanMessages({ brief, feedback: "Add a stronger analytics role." });

    expect(messages[0]?.role).toBe("system");
    expect(messages[1]?.content).toContain("Grow two GitHub repositories past 1k stars");
    expect(messages[1]?.content).toContain("Add a stronger analytics role.");
  });
});
