import { describe, expect, it } from "vitest";
import { createArtifact, createReview } from "./artifact-review.js";

describe("artifact and review", () => {
  it("creates an artifact with evidence and approves it with a review", () => {
    const artifact = createArtifact({
      taskId: "task_1",
      type: "research_report",
      content: {
        patterns: ["numbered hooks", "before-after title"],
      },
      evidence: ["https://example.com/note/1"],
      qualityScore: 0.82,
    });

    const review = createReview({
      artifactId: artifact.id,
      reviewerAgentId: "agent_reviewer",
      decision: "approve",
      comments: ["Evidence is sufficient for the next planning step"],
    });

    expect(artifact.taskId).toBe("task_1");
    expect(artifact.evidence).toHaveLength(1);
    expect(review.decision).toBe("approve");
  });

  it("fails fast when a rejected review has no comments", () => {
    expect(() =>
      createReview({
        artifactId: "artifact_1",
        reviewerAgentId: "agent_reviewer",
        decision: "reject",
        comments: [],
      }),
    ).toThrow("Reject reviews require comments");
  });
});
