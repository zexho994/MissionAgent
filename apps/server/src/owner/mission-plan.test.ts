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

const completeMissionPlanJson = `{
  "goal":"Grow two GitHub repositories past 1k stars",
  "successMetrics":["two repositories exceed 1k stars"],
  "phases":[{"name":"Positioning","objective":"Clarify repository story","deliverables":["profile update"],"successCriteria":["story is clear"]}],
  "workstreams":[{"name":"Content","objective":"Publish useful updates","requiredRole":"Content Strategist","responsibilities":["write posts"],"firstTaskGoal":"Draft launch post"}],
  "reportingLines":[{"fromRole":"Content Strategist","toRole":"Owner","cadence":"daily","purpose":"Progress updates"}],
  "scheduleRhythms":[{"name":"Daily growth check","cadence":"daily","ownerRole":"Owner","purpose":"Review star growth"}],
  "risks":["content may not resonate"],
  "checkpoints":["weekly star review"]
}`;

describe("MissionPlan Owner prompt/parser", () => {
  it("parses a complete MissionPlan JSON object", () => {
    const plan = parseMissionPlanDraft(completeMissionPlanJson);

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

  it("wraps invalid JSON syntax with a MissionPlan LLM response error", () => {
    expect(() => parseMissionPlanDraft('{"goal":,}')).toThrow("Invalid MissionPlan JSON in LLM response");
  });

  it("parses MissionPlan JSON from a fenced code block", () => {
    const plan = parseMissionPlanDraft(`Here is the plan:
\`\`\`json
${completeMissionPlanJson}
\`\`\``);

    expect(plan.goal).toBe("Grow two GitHub repositories past 1k stars");
  });

  it("parses MissionPlan JSON after leading prose", () => {
    const plan = parseMissionPlanDraft(`Based on the brief, here is the MissionPlan:\n${completeMissionPlanJson}`);

    expect(plan.workstreams[0]?.name).toBe("Content");
  });

  it("keeps nested braces inside strings while finding the JSON object end", () => {
    const plan = parseMissionPlanDraft(
      completeMissionPlanJson.replace(
        '"Clarify repository story"',
        '"Clarify repository story with literal braces {like this}"',
      ),
    );

    expect(plan.phases[0]?.objective).toBe("Clarify repository story with literal braces {like this}");
  });

  it("ignores trailing non-JSON text after the first balanced MissionPlan object", () => {
    const plan = parseMissionPlanDraft(`${completeMissionPlanJson}\nThis summary should not be parsed.`);

    expect(plan.checkpoints).toEqual(["weekly star review"]);
  });

  it("builds planning messages with confirmed brief and optional feedback", () => {
    const messages = buildMissionPlanMessages({ brief, feedback: "Add a stronger analytics role." });

    expect(messages[0]?.role).toBe("system");
    expect(messages[1]?.content).toContain("Grow two GitHub repositories past 1k stars");
    expect(messages[1]?.content).toContain("Add a stronger analytics role.");
  });

  it("includes skill tool directives in the system prompt", () => {
    const messages = buildMissionPlanMessages({ brief });

    expect(messages[0]?.content).toContain("list_skill_files");
    expect(messages[0]?.content).toContain("load_skill");
    expect(messages[0]?.content).toContain("digitalagent/SKILL.md");
  });
});
