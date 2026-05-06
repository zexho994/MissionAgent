import { createId } from "./ids.js";
import type { Artifact, ArtifactType, Review, ReviewDecision, Source } from "./types.js";

export interface CreateArtifactInput {
  taskId: string;
  type: ArtifactType;
  content: Record<string, unknown>;
  evidence: string[];
  sources: Source[];
  qualityScore?: number;
}

export interface CreateReviewInput {
  artifactId: string;
  reviewerAgentId: string;
  decision: ReviewDecision;
  comments: string[];
}

export function createArtifact(input: CreateArtifactInput): Artifact {
  if (!input.taskId.trim()) {
    throw new Error("Artifact taskId is required");
  }
  if (input.evidence.length === 0) {
    throw new Error("Artifact requires at least one evidence item");
  }
  if (
    input.qualityScore !== undefined &&
    (input.qualityScore < 0 || input.qualityScore > 1)
  ) {
    throw new Error("Artifact qualityScore must be between 0 and 1");
  }

  return {
    id: createId("artifact"),
    taskId: input.taskId,
    type: input.type,
    content: { ...input.content },
    evidence: [...input.evidence],
    sources: [...input.sources],
    ...(input.qualityScore === undefined ? {} : { qualityScore: input.qualityScore }),
    createdAt: new Date(),
  };
}

export function createReview(input: CreateReviewInput): Review {
  if (!input.artifactId.trim()) {
    throw new Error("Review artifactId is required");
  }
  if (!input.reviewerAgentId.trim()) {
    throw new Error("Review reviewerAgentId is required");
  }
  if (input.decision === "reject" && input.comments.length === 0) {
    throw new Error("Reject reviews require comments");
  }
  if (input.decision === "revise" && input.comments.length === 0) {
    throw new Error("Revision reviews require comments");
  }

  return {
    id: createId("review"),
    artifactId: input.artifactId,
    reviewerAgentId: input.reviewerAgentId,
    decision: input.decision,
    comments: [...input.comments],
    createdAt: new Date(),
  };
}
