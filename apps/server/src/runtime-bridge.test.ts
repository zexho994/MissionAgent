import { describe, expect, it } from "vitest";
import { buildAgentMessage } from "./runtime-bridge.js";

describe("buildAgentMessage", () => {
  it("includes a followup hint when task.origin.type is 'followup'", () => {
    const result = buildAgentMessage({
      message: "do thing",
      mission: { id: "m1", goal: "test" },
      task: {
        id: "t2",
        title: "next",
        origin: { type: "followup", reason: "previous done", sourceTaskId: "t1" },
      },
    });

    expect(result.toLowerCase()).toContain("follow-up");
    expect(result.toLowerCase()).toMatch(/read.*referenced.*files|chain\.txt/i);
  });

  it("does NOT include followup hint for non-followup tasks", () => {
    const result = buildAgentMessage({
      message: "do thing",
      mission: { id: "m1", goal: "test" },
      task: { id: "t1", title: "initial" },
    });

    expect(result.toLowerCase()).not.toContain("follow-up");
  });
});
