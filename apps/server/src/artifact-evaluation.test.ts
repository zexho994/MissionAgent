import { describe, expect, it } from "vitest";
import type { Mission } from "@digitalagent/core";
import { evaluateArtifactQuality } from "./artifact-evaluation.js";

function mission(goal: string): Mission {
  return {
    id: "mission-1",
    goal,
    successMetrics: ["完成50次有效接龙", "5个Agent均参与接龙"],
    constraints: ["每个成语出牌前需验证有效性"],
    status: "active",
    budget: { maxRuntimeMinutes: 180 },
    createdAt: new Date("2026-05-15T00:00:00Z"),
    scheduleRules: [],
  };
}

describe("evaluateArtifactQuality", () => {
  it("does not classify long assistant messages as empty output", () => {
    const result = evaluateArtifactQuality({
      pi: {
        messages: [
          { role: "assistant", content: [{ type: "text", text: "完成50次有效接龙，5个Agent均参与接龙。" }] },
        ],
      },
    }, mission("普通任务"));

    expect(result.comments).not.toContain("Agent output is empty or too short");
  });

  it("does not apply domain-specific tool evidence requirements in deterministic review", () => {
    const result = evaluateArtifactQuality({
      pi: {
        messages: [
          { role: "assistant", content: [{ type: "text", text: "我模拟5个Agent完成了50次成语接龙，全部有效。" }] },
        ],
      },
    }, mission("5 个 agent 协作玩成语接龙,完成 50 次接龙才算成功。"));

    expect(result.comments.some((comment) => comment.includes("tool evidence"))).toBe(false);
  });
});
