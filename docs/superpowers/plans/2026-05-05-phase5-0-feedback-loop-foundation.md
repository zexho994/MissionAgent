# Phase 5.0 Feedback Loop Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add durable Mission-level feedback records for task outcomes, failures, and strategy adjustment proposals, then expose them through APIs and War Room visibility.

**Architecture:** Put feedback domain types and fast-fail factories in `packages/core`, deterministic feedback generation in a focused server module, and persistence/API/UI integration in existing server and public frontend files. Phase 5.0 only records and displays feedback; it does not apply strategy changes or integrate external platforms.

**Tech Stack:** TypeScript, Vitest, existing `InMemoryMissionService`, plain browser JavaScript, existing War Room CSS.

---

## File Structure

- Create `packages/core/src/feedback.ts`: feedback domain input types and factory functions.
- Create `packages/core/src/feedback.test.ts`: fast-fail unit coverage for the domain factories.
- Modify `packages/core/src/types.ts`: export feedback interfaces and union types.
- Modify `packages/core/src/index.ts`: export `feedback.ts`.
- Create `apps/server/src/feedback-generation.ts`: deterministic conversion from execution/review/failure context into feedback records.
- Create `apps/server/src/feedback-generation.test.ts`: unit coverage for approved, revise/reject, and failed execution generation.
- Modify `apps/server/src/mission-service.ts`: store, snapshot, persist, restore, summarize, and generate feedback from execution flows.
- Modify `apps/server/src/mission-service.test.ts`: service-level integration tests.
- Modify `apps/server/src/api.ts`: read-only feedback endpoints.
- Modify `apps/server/src/api.test.ts`: API tests.
- Modify `apps/server/public/app.js`: frontend empty snapshot and feedback summary state/API loading.
- Modify `apps/server/public/war-room.js`: War Room feedback panel rendering.
- Modify `apps/server/public/styles.css`: feedback panel styles.

---

### Task 1: Core Feedback Domain

**Files:**
- Create: `packages/core/src/feedback.ts`
- Create: `packages/core/src/feedback.test.ts`
- Modify: `packages/core/src/types.ts`
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: Write failing domain tests**

Create `packages/core/src/feedback.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  createMissionOutcomeEvaluation,
  createStrategyAdjustment,
  createTaskFailureAnalysis,
} from "./feedback.js";

describe("feedback domain", () => {
  it("creates a mission outcome evaluation", () => {
    const evaluation = createMissionOutcomeEvaluation({
      missionId: "mission_1",
      taskId: "task_1",
      artifactId: "artifact_1",
      reviewId: "review_1",
      source: "execution_result",
      outcome: "advanced",
      contributionScore: 0.82,
      summary: "The execution produced a usable growth plan.",
      evidence: ["Review approved the artifact"],
      risks: [],
      recommendedNextActions: ["Schedule the first execution check"],
    });

    expect(evaluation.id).toMatch(/^feedback_eval_/);
    expect(evaluation.missionId).toBe("mission_1");
    expect(evaluation.contributionScore).toBe(0.82);
    expect(evaluation.createdAt).toEqual(expect.any(String));
  });

  it("fails fast when non-manual evaluation has no evidence", () => {
    expect(() =>
      createMissionOutcomeEvaluation({
        missionId: "mission_1",
        taskId: "task_1",
        source: "execution_result",
        outcome: "neutral",
        contributionScore: 0.5,
        summary: "No clear contribution yet.",
        evidence: [],
        risks: [],
        recommendedNextActions: ["Review the task result"],
      }),
    ).toThrow("Mission outcome evaluation evidence is required");
  });

  it("fails fast when blocked evaluation has no risk or next action", () => {
    expect(() =>
      createMissionOutcomeEvaluation({
        missionId: "mission_1",
        taskId: "task_1",
        source: "execution_failure",
        outcome: "blocked",
        contributionScore: 0,
        summary: "Execution failed.",
        evidence: ["Execution error: timeout"],
        risks: [],
        recommendedNextActions: [],
      }),
    ).toThrow("Blocked or regressed evaluations require a risk or next action");
  });

  it("creates task failure analysis", () => {
    const analysis = createTaskFailureAnalysis({
      missionId: "mission_1",
      taskId: "task_1",
      artifactId: "artifact_1",
      reviewId: "review_1",
      failureType: "low_quality_output",
      summary: "The artifact needs revision.",
      rootCause: "Reviewer requested clearer evidence.",
      recommendedRecovery: "revise_task",
      recommendedNextActions: ["Ask the assignee to revise the evidence section"],
    });

    expect(analysis.id).toMatch(/^failure_analysis_/);
    expect(analysis.failureType).toBe("low_quality_output");
  });

  it("fails fast when failure analysis has no next action", () => {
    expect(() =>
      createTaskFailureAnalysis({
        missionId: "mission_1",
        taskId: "task_1",
        failureType: "execution_error",
        summary: "Execution failed.",
        rootCause: "The local executor crashed.",
        recommendedRecovery: "revise_task",
        recommendedNextActions: [],
      }),
    ).toThrow("Task failure analysis requires at least one recommended next action");
  });

  it("creates a proposed strategy adjustment", () => {
    const adjustment = createStrategyAdjustment({
      missionId: "mission_1",
      triggeredByFailureAnalysisId: "failure_analysis_1",
      status: "proposed",
      previousStrategy: "Post broad content experiments.",
      proposedStrategy: "Focus on evidence-backed repository growth loops.",
      rationale: "Recent task output lacked a clear path to the Mission metric.",
      affectedAgentRoles: ["owner", "data_analyst"],
      proposedTaskGoals: ["Review repository growth metric assumptions"],
      requiresHrReview: true,
    });

    expect(adjustment.id).toMatch(/^strategy_adjustment_/);
    expect(adjustment.status).toBe("proposed");
  });

  it("fails fast when strategy adjustment has no rationale", () => {
    expect(() =>
      createStrategyAdjustment({
        missionId: "mission_1",
        status: "proposed",
        previousStrategy: "Old strategy",
        proposedStrategy: "New strategy",
        rationale: "",
        affectedAgentRoles: [],
        proposedTaskGoals: [],
        requiresHrReview: false,
      }),
    ).toThrow("Strategy adjustment rationale is required");
  });
});
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
pnpm --filter @digitalagent/core test -- feedback.test.ts
```

Expected: FAIL with module resolution errors for `./feedback.js`.

- [ ] **Step 3: Add feedback types to `types.ts`**

Add after `Review` in `packages/core/src/types.ts`:

```ts
export type MissionOutcomeEvaluationSource = "execution_result" | "execution_failure" | "manual";
export type MissionOutcome = "advanced" | "neutral" | "blocked" | "regressed";

export interface MissionOutcomeEvaluation {
  id: string;
  missionId: string;
  taskId: string;
  artifactId?: string;
  reviewId?: string;
  source: MissionOutcomeEvaluationSource;
  outcome: MissionOutcome;
  contributionScore: number;
  summary: string;
  evidence: string[];
  risks: string[];
  recommendedNextActions: string[];
  createdAt: string;
}

export type TaskFailureType =
  | "missing_information"
  | "agent_mismatch"
  | "unclear_task"
  | "external_blocker"
  | "low_quality_output"
  | "execution_error";

export type RecommendedRecovery =
  | "ask_user"
  | "revise_task"
  | "split_task"
  | "reassign_agent"
  | "adjust_strategy";

export interface TaskFailureAnalysis {
  id: string;
  missionId: string;
  taskId: string;
  artifactId?: string;
  reviewId?: string;
  failureType: TaskFailureType;
  summary: string;
  rootCause: string;
  recommendedRecovery: RecommendedRecovery;
  recommendedNextActions: string[];
  createdAt: string;
}

export type StrategyAdjustmentStatus = "proposed" | "accepted" | "rejected" | "superseded";

export interface StrategyAdjustment {
  id: string;
  missionId: string;
  triggeredByEvaluationId?: string;
  triggeredByFailureAnalysisId?: string;
  status: StrategyAdjustmentStatus;
  previousStrategy: string;
  proposedStrategy: string;
  rationale: string;
  affectedAgentRoles: string[];
  proposedTaskGoals: string[];
  requiresHrReview: boolean;
  createdAt: string;
}
```

- [ ] **Step 4: Implement feedback factories**

Create `packages/core/src/feedback.ts`:

```ts
import { createId } from "./ids.js";
import type {
  MissionOutcomeEvaluation,
  MissionOutcomeEvaluationSource,
  MissionOutcome,
  RecommendedRecovery,
  StrategyAdjustment,
  StrategyAdjustmentStatus,
  TaskFailureAnalysis,
  TaskFailureType,
} from "./types.js";

export interface CreateMissionOutcomeEvaluationInput {
  missionId: string;
  taskId: string;
  artifactId?: string;
  reviewId?: string;
  source: MissionOutcomeEvaluationSource;
  outcome: MissionOutcome;
  contributionScore: number;
  summary: string;
  evidence: string[];
  risks: string[];
  recommendedNextActions: string[];
}

export interface CreateTaskFailureAnalysisInput {
  missionId: string;
  taskId: string;
  artifactId?: string;
  reviewId?: string;
  failureType: TaskFailureType;
  summary: string;
  rootCause: string;
  recommendedRecovery: RecommendedRecovery;
  recommendedNextActions: string[];
}

export interface CreateStrategyAdjustmentInput {
  missionId: string;
  triggeredByEvaluationId?: string;
  triggeredByFailureAnalysisId?: string;
  status: StrategyAdjustmentStatus;
  previousStrategy: string;
  proposedStrategy: string;
  rationale: string;
  affectedAgentRoles: string[];
  proposedTaskGoals: string[];
  requiresHrReview: boolean;
}

function requireTrimmed(value: string, label: string): void {
  if (!value.trim()) {
    throw new Error(`${label} is required`);
  }
}

export function createMissionOutcomeEvaluation(
  input: CreateMissionOutcomeEvaluationInput,
): MissionOutcomeEvaluation {
  requireTrimmed(input.missionId, "Mission outcome evaluation missionId");
  requireTrimmed(input.taskId, "Mission outcome evaluation taskId");
  requireTrimmed(input.summary, "Mission outcome evaluation summary");
  if (input.contributionScore < 0 || input.contributionScore > 1) {
    throw new Error("Mission outcome evaluation contributionScore must be between 0 and 1");
  }
  if (input.source !== "manual" && input.evidence.length === 0) {
    throw new Error("Mission outcome evaluation evidence is required");
  }
  if (
    (input.outcome === "blocked" || input.outcome === "regressed") &&
    input.risks.length === 0 &&
    input.recommendedNextActions.length === 0
  ) {
    throw new Error("Blocked or regressed evaluations require a risk or next action");
  }

  return {
    id: createId("feedback_eval"),
    missionId: input.missionId,
    taskId: input.taskId,
    ...(input.artifactId === undefined ? {} : { artifactId: input.artifactId }),
    ...(input.reviewId === undefined ? {} : { reviewId: input.reviewId }),
    source: input.source,
    outcome: input.outcome,
    contributionScore: input.contributionScore,
    summary: input.summary,
    evidence: [...input.evidence],
    risks: [...input.risks],
    recommendedNextActions: [...input.recommendedNextActions],
    createdAt: new Date().toISOString(),
  };
}

export function createTaskFailureAnalysis(input: CreateTaskFailureAnalysisInput): TaskFailureAnalysis {
  requireTrimmed(input.missionId, "Task failure analysis missionId");
  requireTrimmed(input.taskId, "Task failure analysis taskId");
  requireTrimmed(input.summary, "Task failure analysis summary");
  requireTrimmed(input.rootCause, "Task failure analysis rootCause");
  if (input.recommendedNextActions.length === 0) {
    throw new Error("Task failure analysis requires at least one recommended next action");
  }

  return {
    id: createId("failure_analysis"),
    missionId: input.missionId,
    taskId: input.taskId,
    ...(input.artifactId === undefined ? {} : { artifactId: input.artifactId }),
    ...(input.reviewId === undefined ? {} : { reviewId: input.reviewId }),
    failureType: input.failureType,
    summary: input.summary,
    rootCause: input.rootCause,
    recommendedRecovery: input.recommendedRecovery,
    recommendedNextActions: [...input.recommendedNextActions],
    createdAt: new Date().toISOString(),
  };
}

export function createStrategyAdjustment(input: CreateStrategyAdjustmentInput): StrategyAdjustment {
  requireTrimmed(input.missionId, "Strategy adjustment missionId");
  requireTrimmed(input.previousStrategy, "Strategy adjustment previousStrategy");
  requireTrimmed(input.proposedStrategy, "Strategy adjustment proposedStrategy");
  requireTrimmed(input.rationale, "Strategy adjustment rationale");

  return {
    id: createId("strategy_adjustment"),
    missionId: input.missionId,
    ...(input.triggeredByEvaluationId === undefined ? {} : { triggeredByEvaluationId: input.triggeredByEvaluationId }),
    ...(input.triggeredByFailureAnalysisId === undefined ? {} : { triggeredByFailureAnalysisId: input.triggeredByFailureAnalysisId }),
    status: input.status,
    previousStrategy: input.previousStrategy,
    proposedStrategy: input.proposedStrategy,
    rationale: input.rationale,
    affectedAgentRoles: [...input.affectedAgentRoles],
    proposedTaskGoals: [...input.proposedTaskGoals],
    requiresHrReview: input.requiresHrReview,
    createdAt: new Date().toISOString(),
  };
}
```

- [ ] **Step 5: Export feedback factories**

Add to `packages/core/src/index.ts`:

```ts
export * from "./feedback.js";
```

- [ ] **Step 6: Run core feedback tests**

Run:

```bash
pnpm --filter @digitalagent/core test -- feedback.test.ts
```

Expected: PASS.

- [ ] **Step 7: Run core typecheck**

Run:

```bash
pnpm --filter @digitalagent/core typecheck
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/feedback.ts packages/core/src/feedback.test.ts packages/core/src/types.ts packages/core/src/index.ts
git commit -m "feat: add feedback domain records"
```

---

### Task 2: Deterministic Feedback Generation

**Files:**
- Create: `apps/server/src/feedback-generation.ts`
- Create: `apps/server/src/feedback-generation.test.ts`

- [ ] **Step 1: Write failing generation tests**

Create `apps/server/src/feedback-generation.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { Artifact, Mission, Review, Task } from "@digitalagent/core";
import {
  buildExecutionFailureFeedback,
  buildExecutionResultFeedback,
} from "./feedback-generation.js";

const mission: Mission = {
  id: "mission_1",
  goal: "Grow a GitHub account to two repositories over 1k stars",
  successMetrics: ["Two repositories exceed 1k stars"],
  constraints: ["One month timeline"],
  status: "active",
  budget: { maxRuntimeMinutes: 120 },
  createdAt: new Date("2026-05-05T00:00:00.000Z"),
  scheduleRules: [],
};

const task: Task = {
  id: "task_1",
  missionId: "mission_1",
  title: "Draft repository growth plan",
  status: "completed",
  dependencies: [],
  contract: {
    objective: "Create a growth plan",
    input: {},
    outputSchema: { summary: "string" },
    successCriteria: ["Includes next actions"],
  },
  approvalRequired: false,
  assigneeAgentId: "agent_owner",
};

const artifact: Artifact = {
  id: "artifact_1",
  taskId: "task_1",
  type: "execution_log",
  content: { summary: "Plan with next actions" },
  evidence: ["openclaw:local"],
  qualityScore: 0.86,
  createdAt: new Date("2026-05-05T00:01:00.000Z"),
};

describe("feedback generation", () => {
  it("builds advanced evaluation for approved execution result", () => {
    const review: Review = {
      id: "review_1",
      artifactId: "artifact_1",
      reviewerAgentId: "agent_reviewer",
      decision: "approve",
      comments: ["Artifact quality check passed"],
      createdAt: new Date("2026-05-05T00:02:00.000Z"),
    };

    const feedback = buildExecutionResultFeedback({ mission, task, artifact, review });

    expect(feedback.evaluation.outcome).toBe("advanced");
    expect(feedback.evaluation.contributionScore).toBe(0.86);
    expect(feedback.evaluation.evidence).toContain("Review decision: approve");
    expect(feedback.failureAnalysis).toBeUndefined();
    expect(feedback.strategyAdjustment).toBeUndefined();
  });

  it("builds failure analysis for revision request", () => {
    const review: Review = {
      id: "review_2",
      artifactId: "artifact_1",
      reviewerAgentId: "agent_reviewer",
      decision: "revise",
      comments: ["Artifact needs stronger evidence"],
      createdAt: new Date("2026-05-05T00:02:00.000Z"),
    };

    const feedback = buildExecutionResultFeedback({ mission, task, artifact, review });

    expect(feedback.evaluation.outcome).toBe("blocked");
    expect(feedback.failureAnalysis?.failureType).toBe("low_quality_output");
    expect(feedback.failureAnalysis?.recommendedRecovery).toBe("revise_task");
    expect(feedback.strategyAdjustment).toBeUndefined();
  });

  it("builds strategy adjustment proposal for rejected low-score result", () => {
    const lowScoreArtifact: Artifact = { ...artifact, qualityScore: 0.1 };
    const review: Review = {
      id: "review_3",
      artifactId: "artifact_1",
      reviewerAgentId: "agent_reviewer",
      decision: "reject",
      comments: ["Artifact has no OpenClaw output"],
      createdAt: new Date("2026-05-05T00:02:00.000Z"),
    };

    const feedback = buildExecutionResultFeedback({ mission, task, artifact: lowScoreArtifact, review });

    expect(feedback.evaluation.outcome).toBe("regressed");
    expect(feedback.failureAnalysis?.recommendedRecovery).toBe("adjust_strategy");
    expect(feedback.strategyAdjustment?.status).toBe("proposed");
    expect(feedback.strategyAdjustment?.requiresHrReview).toBe(true);
  });

  it("builds blocked feedback for execution failure", () => {
    const feedback = buildExecutionFailureFeedback({
      mission,
      task,
      error: "OpenClaw timed out",
    });

    expect(feedback.evaluation.source).toBe("execution_failure");
    expect(feedback.evaluation.outcome).toBe("blocked");
    expect(feedback.failureAnalysis.failureType).toBe("execution_error");
    expect(feedback.failureAnalysis.rootCause).toContain("OpenClaw timed out");
  });
});
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
pnpm --filter @digitalagent/server test -- feedback-generation.test.ts
```

Expected: FAIL with module resolution errors for `./feedback-generation.js`.

- [ ] **Step 3: Implement deterministic generation module**

Create `apps/server/src/feedback-generation.ts`:

```ts
import {
  createMissionOutcomeEvaluation,
  createStrategyAdjustment,
  createTaskFailureAnalysis,
  type Artifact,
  type Mission,
  type MissionOutcomeEvaluation,
  type Review,
  type StrategyAdjustment,
  type Task,
  type TaskFailureAnalysis,
} from "@digitalagent/core";

export interface ExecutionResultFeedback {
  evaluation: MissionOutcomeEvaluation;
  failureAnalysis?: TaskFailureAnalysis;
  strategyAdjustment?: StrategyAdjustment;
}

export interface ExecutionFailureFeedback {
  evaluation: MissionOutcomeEvaluation;
  failureAnalysis: TaskFailureAnalysis;
}

function artifactScore(artifact: Artifact): number {
  return artifact.qualityScore ?? 0.5;
}

function reviewEvidence(review: Review, artifact: Artifact): string[] {
  return [
    `Review decision: ${review.decision}`,
    `Artifact type: ${artifact.type}`,
    ...review.comments.map((comment) => `Review comment: ${comment}`),
  ];
}

function currentStrategy(mission: Mission): string {
  return mission.brief?.scope || mission.goal;
}

export function buildExecutionResultFeedback(input: {
  mission: Mission;
  task: Task;
  artifact: Artifact;
  review: Review;
}): ExecutionResultFeedback {
  const score = artifactScore(input.artifact);
  const outcome = input.review.decision === "approve"
    ? "advanced"
    : input.review.decision === "revise"
      ? "blocked"
      : score <= 0.2
        ? "regressed"
        : "blocked";

  const evaluation = createMissionOutcomeEvaluation({
    missionId: input.mission.id,
    taskId: input.task.id,
    artifactId: input.artifact.id,
    reviewId: input.review.id,
    source: "execution_result",
    outcome,
    contributionScore: score,
    summary: input.review.decision === "approve"
      ? `Task "${input.task.title}" produced an approved artifact for the Mission.`
      : `Task "${input.task.title}" did not produce acceptable forward motion.`,
    evidence: reviewEvidence(input.review, input.artifact),
    risks: input.review.decision === "approve" ? [] : input.review.comments,
    recommendedNextActions: input.review.decision === "approve"
      ? [`Use the artifact from "${input.task.title}" in the next Mission step.`]
      : [`Recover task "${input.task.title}" before relying on this output.`],
  });

  if (input.review.decision === "approve") {
    return { evaluation };
  }

  const recommendedRecovery = input.review.decision === "reject" && score <= 0.2
    ? "adjust_strategy"
    : "revise_task";
  const failureAnalysis = createTaskFailureAnalysis({
    missionId: input.mission.id,
    taskId: input.task.id,
    artifactId: input.artifact.id,
    reviewId: input.review.id,
    failureType: "low_quality_output",
    summary: `Task "${input.task.title}" requires recovery after ${input.review.decision}.`,
    rootCause: input.review.comments.join("; "),
    recommendedRecovery,
    recommendedNextActions: recommendedRecovery === "adjust_strategy"
      ? ["Review whether the current Mission strategy can still produce the target outcome."]
      : [`Revise task "${input.task.title}" with stronger evidence and clearer output.`],
  });

  if (recommendedRecovery !== "adjust_strategy") {
    return { evaluation, failureAnalysis };
  }

  const strategyAdjustment = createStrategyAdjustment({
    missionId: input.mission.id,
    triggeredByEvaluationId: evaluation.id,
    triggeredByFailureAnalysisId: failureAnalysis.id,
    status: "proposed",
    previousStrategy: currentStrategy(input.mission),
    proposedStrategy: `Reassess strategy after "${input.task.title}" failed to produce usable Mission progress.`,
    rationale: failureAnalysis.rootCause,
    affectedAgentRoles: [],
    proposedTaskGoals: failureAnalysis.recommendedNextActions,
    requiresHrReview: true,
  });

  return { evaluation, failureAnalysis, strategyAdjustment };
}

export function buildExecutionFailureFeedback(input: {
  mission: Mission;
  task: Task;
  error: string;
}): ExecutionFailureFeedback {
  const evaluation = createMissionOutcomeEvaluation({
    missionId: input.mission.id,
    taskId: input.task.id,
    source: "execution_failure",
    outcome: "blocked",
    contributionScore: 0,
    summary: `Execution failed for task "${input.task.title}".`,
    evidence: [`Execution error: ${input.error}`],
    risks: [input.error],
    recommendedNextActions: [`Inspect and recover task "${input.task.title}".`],
  });

  const failureAnalysis = createTaskFailureAnalysis({
    missionId: input.mission.id,
    taskId: input.task.id,
    failureType: "execution_error",
    summary: `Execution failed for task "${input.task.title}".`,
    rootCause: input.error,
    recommendedRecovery: "revise_task",
    recommendedNextActions: [`Fix the execution blocker and rerun task "${input.task.title}".`],
  });

  return { evaluation, failureAnalysis };
}
```

- [ ] **Step 4: Run generation tests**

Run:

```bash
pnpm --filter @digitalagent/server test -- feedback-generation.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run server typecheck**

Run:

```bash
pnpm --filter @digitalagent/server typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/feedback-generation.ts apps/server/src/feedback-generation.test.ts
git commit -m "feat: generate mission feedback records"
```

---

### Task 3: Mission Service Feedback Persistence And Execution Integration

**Files:**
- Modify: `apps/server/src/mission-service.ts`
- Modify: `apps/server/src/mission-service.test.ts`
- Modify: `apps/server/src/agent-autonomy.test.ts`
- Modify: `apps/server/src/agent-conversation-bus.test.ts`

- [ ] **Step 1: Add failing service tests**

Append to `apps/server/src/mission-service.test.ts` inside the existing `InMemoryMissionService` describe block:

```ts
  it("creates outcome evaluation when execution result is approved", () => {
    const service = new InMemoryMissionService();
    const mission = service.createMission("Grow a GitHub repository");
    service.activateMission(mission.id);
    const task = service.snapshot().tasks.find((candidate) => candidate.missionId === mission.id);
    expect(task).toBeDefined();
    const execution = service.startExecution({ missionId: mission.id, taskId: task!.id });

    service.submitExecutionResult({
      missionId: mission.id,
      taskId: task!.id,
      executionId: execution.id,
      content: { openclaw: "Approved execution output with next actions" },
      evidence: ["openclaw:local"],
    });

    const snapshot = service.snapshot();
    expect(snapshot.missionOutcomeEvaluations).toHaveLength(1);
    expect(snapshot.missionOutcomeEvaluations[0]).toMatchObject({
      missionId: mission.id,
      taskId: task!.id,
      source: "execution_result",
      outcome: "advanced",
    });
    expect(snapshot.taskFailureAnalyses).toHaveLength(0);
    expect(snapshot.knowledgeEntries.some((entry) => entry.key.startsWith("feedback:"))).toBe(true);
  });

  it("creates failure analysis when execution result is rejected", () => {
    const service = new InMemoryMissionService();
    const mission = service.createMission("Grow a GitHub repository");
    service.activateMission(mission.id);
    const task = service.snapshot().tasks.find((candidate) => candidate.missionId === mission.id);
    expect(task).toBeDefined();
    const execution = service.startExecution({ missionId: mission.id, taskId: task!.id });

    service.submitExecutionResult({
      missionId: mission.id,
      taskId: task!.id,
      executionId: execution.id,
      content: { openclaw: "" },
      evidence: ["openclaw:local"],
    });

    const snapshot = service.snapshot();
    expect(snapshot.missionOutcomeEvaluations).toHaveLength(1);
    expect(snapshot.taskFailureAnalyses).toHaveLength(1);
    expect(snapshot.taskFailureAnalyses[0]).toMatchObject({
      missionId: mission.id,
      taskId: task!.id,
      failureType: "low_quality_output",
    });
  });

  it("creates blocked feedback when execution fails", () => {
    const service = new InMemoryMissionService();
    const mission = service.createMission("Grow a GitHub repository");
    service.activateMission(mission.id);
    const task = service.snapshot().tasks.find((candidate) => candidate.missionId === mission.id);
    expect(task).toBeDefined();
    const execution = service.startExecution({ missionId: mission.id, taskId: task!.id });

    service.failExecution({
      executionId: execution.id,
      error: "OpenClaw timed out",
    });

    const snapshot = service.snapshot();
    expect(snapshot.missionOutcomeEvaluations).toHaveLength(1);
    expect(snapshot.missionOutcomeEvaluations[0]?.outcome).toBe("blocked");
    expect(snapshot.taskFailureAnalyses).toHaveLength(1);
    expect(snapshot.taskFailureAnalyses[0]?.failureType).toBe("execution_error");
  });

  it("persists and restores feedback records", () => {
    const storageFile = join(tmpdir(), `digitalagent-feedback-${Date.now()}.json`);
    const service = new InMemoryMissionService({ storageFile });
    const mission = service.createMission("Grow a GitHub repository");
    service.activateMission(mission.id);
    const task = service.snapshot().tasks.find((candidate) => candidate.missionId === mission.id);
    expect(task).toBeDefined();
    const execution = service.startExecution({ missionId: mission.id, taskId: task!.id });

    service.failExecution({
      executionId: execution.id,
      error: "OpenClaw timed out",
    });

    const reloaded = new InMemoryMissionService({ storageFile });
    expect(reloaded.snapshot().missionOutcomeEvaluations).toHaveLength(1);
    expect(reloaded.snapshot().taskFailureAnalyses).toHaveLength(1);
  });

  it("returns feedback summary with latest records and counts", () => {
    const service = new InMemoryMissionService();
    const mission = service.createMission("Grow a GitHub repository");
    service.activateMission(mission.id);
    const task = service.snapshot().tasks.find((candidate) => candidate.missionId === mission.id);
    expect(task).toBeDefined();
    const execution = service.startExecution({ missionId: mission.id, taskId: task!.id });

    service.failExecution({
      executionId: execution.id,
      error: "OpenClaw timed out",
    });

    expect(service.getFeedbackSummary(mission.id)).toMatchObject({
      missionId: mission.id,
      counts: {
        evaluations: 1,
        failureAnalyses: 1,
        strategyAdjustments: 0,
      },
    });
  });
```

If `join` and `tmpdir` are not already imported in the test file, add:

```ts
import { tmpdir } from "node:os";
import { join } from "node:path";
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
pnpm --filter @digitalagent/server test -- mission-service.test.ts -t "feedback|execution fails|persists and restores feedback"
```

Expected: FAIL because `MissionSnapshot` has no feedback arrays and `getFeedbackSummary` is missing.

- [ ] **Step 3: Import feedback types and generation helpers**

In `apps/server/src/mission-service.ts`, extend the `@digitalagent/core` import with:

```ts
  type MissionOutcomeEvaluation,
  type StrategyAdjustment,
  type TaskFailureAnalysis,
```

Add a local import near other server imports:

```ts
import {
  buildExecutionFailureFeedback,
  buildExecutionResultFeedback,
  type ExecutionFailureFeedback,
  type ExecutionResultFeedback,
} from "./feedback-generation.js";
```

- [ ] **Step 4: Extend snapshot and service state**

Add to `MissionSnapshot`:

```ts
  missionOutcomeEvaluations: MissionOutcomeEvaluation[];
  taskFailureAnalyses: TaskFailureAnalysis[];
  strategyAdjustments: StrategyAdjustment[];
```

Add maps in `InMemoryMissionService` near existing record maps:

```ts
  private readonly missionOutcomeEvaluations = new Map<string, MissionOutcomeEvaluation>();
  private readonly taskFailureAnalyses = new Map<string, TaskFailureAnalysis>();
  private readonly strategyAdjustments = new Map<string, StrategyAdjustment>();
```

Add to `snapshot()`:

```ts
      missionOutcomeEvaluations: [...this.missionOutcomeEvaluations.values()],
      taskFailureAnalyses: [...this.taskFailureAnalyses.values()],
      strategyAdjustments: [...this.strategyAdjustments.values()],
```

- [ ] **Step 5: Add feedback summary type and methods**

Add near `AutomationSummary`:

```ts
export interface FeedbackSummary {
  missionId: string;
  latestEvaluation?: MissionOutcomeEvaluation;
  latestFailureAnalysis?: TaskFailureAnalysis;
  latestStrategyAdjustment?: StrategyAdjustment;
  counts: {
    evaluations: number;
    failureAnalyses: number;
    strategyAdjustments: number;
  };
}
```

Add public methods near `getAutomationSummary()`:

```ts
  getMissionOutcomeEvaluations(missionId: string): MissionOutcomeEvaluation[] {
    this.requireMission(missionId);
    return [...this.missionOutcomeEvaluations.values()].filter((record) => record.missionId === missionId);
  }

  getTaskFailureAnalyses(missionId: string): TaskFailureAnalysis[] {
    this.requireMission(missionId);
    return [...this.taskFailureAnalyses.values()].filter((record) => record.missionId === missionId);
  }

  getStrategyAdjustments(missionId: string): StrategyAdjustment[] {
    this.requireMission(missionId);
    return [...this.strategyAdjustments.values()].filter((record) => record.missionId === missionId);
  }

  getFeedbackSummary(missionId: string): FeedbackSummary {
    const evaluations = this.getMissionOutcomeEvaluations(missionId);
    const failureAnalyses = this.getTaskFailureAnalyses(missionId);
    const strategyAdjustments = this.getStrategyAdjustments(missionId);
    const byCreatedAt = <T extends { createdAt: string }>(records: T[]) =>
      [...records].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return {
      missionId,
      latestEvaluation: byCreatedAt(evaluations)[0],
      latestFailureAnalysis: byCreatedAt(failureAnalyses)[0],
      latestStrategyAdjustment: byCreatedAt(strategyAdjustments)[0],
      counts: {
        evaluations: evaluations.length,
        failureAnalyses: failureAnalyses.length,
        strategyAdjustments: strategyAdjustments.length,
      },
    };
  }
```

Add this private method near other private helpers:

```ts
  private requireMission(missionId: string): Mission {
    const mission = this.missions.get(missionId);
    if (!mission) {
      throw new Error(`Mission not found: ${missionId}`);
    }
    return mission;
  }
```

- [ ] **Step 6: Add feedback persistence helpers**

Add private helper methods:

```ts
  private recordExecutionResultFeedback(feedback: ExecutionResultFeedback): void {
    this.missionOutcomeEvaluations.set(feedback.evaluation.id, feedback.evaluation);
    if (feedback.failureAnalysis) {
      this.taskFailureAnalyses.set(feedback.failureAnalysis.id, feedback.failureAnalysis);
    }
    if (feedback.strategyAdjustment) {
      this.strategyAdjustments.set(feedback.strategyAdjustment.id, feedback.strategyAdjustment);
    }
    this.recordFeedbackKnowledge(feedback.evaluation);
  }

  private recordExecutionFailureFeedback(feedback: ExecutionFailureFeedback): void {
    this.missionOutcomeEvaluations.set(feedback.evaluation.id, feedback.evaluation);
    this.taskFailureAnalyses.set(feedback.failureAnalysis.id, feedback.failureAnalysis);
    this.recordFeedbackKnowledge(feedback.evaluation);
  }

  private recordFeedbackKnowledge(evaluation: MissionOutcomeEvaluation): void {
    const key = `feedback:${evaluation.taskId}:${evaluation.id}`;
    const existing = [...this.knowledgeEntries.values()].find(
      (entry) => entry.missionId === evaluation.missionId && entry.key === key,
    );
    if (existing) {
      throw new Error(`Feedback knowledge already exists: ${key}`);
    }
    const owner = [...this.agents.values()].find(
      (agent) => agent.missionId === evaluation.missionId && agent.role === "owner",
    );
    const entry = createKnowledgeEntry({
      missionId: evaluation.missionId,
      key,
      value: `${evaluation.outcome}: ${evaluation.summary}`,
      sourceAgentId: owner?.id ?? "system",
    });
    this.knowledgeEntries.set(entry.id, entry);
  }
```

- [ ] **Step 7: Integrate feedback generation in `submitExecutionResult()`**

After `this.reviews.set(review.id, review);` and before task events/messages are finalized, add:

```ts
    const feedback = buildExecutionResultFeedback({
      mission,
      task: resultTask,
      artifact,
      review,
    });
    this.recordExecutionResultFeedback(feedback);
```

After the existing `review.completed` task event, append:

```ts
    this.appendTaskEvent({
      missionId: mission.id,
      taskId: task.id,
      actorAgentId: reviewer.id,
      type: "feedback.evaluated",
      summary: feedback.evaluation.summary,
    });
```

If `WarRoomTaskEvent.type` is a string union, add `"feedback.evaluated"` to that union.

- [ ] **Step 8: Integrate feedback generation in `failExecution()`**

After the worker message and task event are appended, add:

```ts
    const mission = this.requireMission(execution.missionId);
    const task = this.tasks.get(execution.taskId);
    if (!task || task.missionId !== mission.id) {
      throw new Error(`Task not found in mission: ${execution.taskId}`);
    }
    const feedback = buildExecutionFailureFeedback({
      mission,
      task,
      error: input.error,
    });
    this.recordExecutionFailureFeedback(feedback);
    this.appendTaskEvent({
      missionId: execution.missionId,
      taskId: execution.taskId,
      actorAgentId: worker.id,
      type: "feedback.evaluated",
      summary: feedback.evaluation.summary,
    });
```

- [ ] **Step 9: Add strict restore parsers for feedback records**

Add these helpers near other top-level helpers in `apps/server/src/mission-service.ts`:

```ts
function expectStoredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} is required`);
  }
  return value;
}

function expectStoredNumber(value: unknown, label: string): number {
  if (typeof value !== "number") {
    throw new Error(`${label} must be a number`);
  }
  return value;
}

function expectStoredStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${label} must be a string array`);
  }
  return [...value];
}

function expectStoredBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${label} must be a boolean`);
  }
  return value;
}

function expectStoredObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function parseStoredMissionOutcomeEvaluation(value: unknown): MissionOutcomeEvaluation {
  const record = expectStoredObject(value, "missionOutcomeEvaluation");
  return {
    id: expectStoredString(record.id, "missionOutcomeEvaluation.id"),
    missionId: expectStoredString(record.missionId, "missionOutcomeEvaluation.missionId"),
    taskId: expectStoredString(record.taskId, "missionOutcomeEvaluation.taskId"),
    ...(record.artifactId === undefined ? {} : { artifactId: expectStoredString(record.artifactId, "missionOutcomeEvaluation.artifactId") }),
    ...(record.reviewId === undefined ? {} : { reviewId: expectStoredString(record.reviewId, "missionOutcomeEvaluation.reviewId") }),
    source: expectStoredString(record.source, "missionOutcomeEvaluation.source") as MissionOutcomeEvaluation["source"],
    outcome: expectStoredString(record.outcome, "missionOutcomeEvaluation.outcome") as MissionOutcomeEvaluation["outcome"],
    contributionScore: expectStoredNumber(record.contributionScore, "missionOutcomeEvaluation.contributionScore"),
    summary: expectStoredString(record.summary, "missionOutcomeEvaluation.summary"),
    evidence: expectStoredStringArray(record.evidence, "missionOutcomeEvaluation.evidence"),
    risks: expectStoredStringArray(record.risks, "missionOutcomeEvaluation.risks"),
    recommendedNextActions: expectStoredStringArray(record.recommendedNextActions, "missionOutcomeEvaluation.recommendedNextActions"),
    createdAt: expectStoredString(record.createdAt, "missionOutcomeEvaluation.createdAt"),
  };
}

function parseStoredTaskFailureAnalysis(value: unknown): TaskFailureAnalysis {
  const record = expectStoredObject(value, "taskFailureAnalysis");
  return {
    id: expectStoredString(record.id, "taskFailureAnalysis.id"),
    missionId: expectStoredString(record.missionId, "taskFailureAnalysis.missionId"),
    taskId: expectStoredString(record.taskId, "taskFailureAnalysis.taskId"),
    ...(record.artifactId === undefined ? {} : { artifactId: expectStoredString(record.artifactId, "taskFailureAnalysis.artifactId") }),
    ...(record.reviewId === undefined ? {} : { reviewId: expectStoredString(record.reviewId, "taskFailureAnalysis.reviewId") }),
    failureType: expectStoredString(record.failureType, "taskFailureAnalysis.failureType") as TaskFailureAnalysis["failureType"],
    summary: expectStoredString(record.summary, "taskFailureAnalysis.summary"),
    rootCause: expectStoredString(record.rootCause, "taskFailureAnalysis.rootCause"),
    recommendedRecovery: expectStoredString(record.recommendedRecovery, "taskFailureAnalysis.recommendedRecovery") as TaskFailureAnalysis["recommendedRecovery"],
    recommendedNextActions: expectStoredStringArray(record.recommendedNextActions, "taskFailureAnalysis.recommendedNextActions"),
    createdAt: expectStoredString(record.createdAt, "taskFailureAnalysis.createdAt"),
  };
}

function parseStoredStrategyAdjustment(value: unknown): StrategyAdjustment {
  const record = expectStoredObject(value, "strategyAdjustment");
  return {
    id: expectStoredString(record.id, "strategyAdjustment.id"),
    missionId: expectStoredString(record.missionId, "strategyAdjustment.missionId"),
    ...(record.triggeredByEvaluationId === undefined ? {} : { triggeredByEvaluationId: expectStoredString(record.triggeredByEvaluationId, "strategyAdjustment.triggeredByEvaluationId") }),
    ...(record.triggeredByFailureAnalysisId === undefined ? {} : { triggeredByFailureAnalysisId: expectStoredString(record.triggeredByFailureAnalysisId, "strategyAdjustment.triggeredByFailureAnalysisId") }),
    status: expectStoredString(record.status, "strategyAdjustment.status") as StrategyAdjustment["status"],
    previousStrategy: expectStoredString(record.previousStrategy, "strategyAdjustment.previousStrategy"),
    proposedStrategy: expectStoredString(record.proposedStrategy, "strategyAdjustment.proposedStrategy"),
    rationale: expectStoredString(record.rationale, "strategyAdjustment.rationale"),
    affectedAgentRoles: expectStoredStringArray(record.affectedAgentRoles, "strategyAdjustment.affectedAgentRoles"),
    proposedTaskGoals: expectStoredStringArray(record.proposedTaskGoals, "strategyAdjustment.proposedTaskGoals"),
    requiresHrReview: expectStoredBoolean(record.requiresHrReview, "strategyAdjustment.requiresHrReview"),
    createdAt: expectStoredString(record.createdAt, "strategyAdjustment.createdAt"),
  };
}
```

- [ ] **Step 10: Restore feedback records from storage**

In `loadFromFile()`, after restoring `knowledgeEntries`, add:

```ts
    for (const evaluation of (stored.missionOutcomeEvaluations ?? []).map(parseStoredMissionOutcomeEvaluation)) {
      this.missionOutcomeEvaluations.set(evaluation.id, evaluation);
    }
    for (const analysis of (stored.taskFailureAnalyses ?? []).map(parseStoredTaskFailureAnalysis)) {
      this.taskFailureAnalyses.set(analysis.id, analysis);
    }
    for (const adjustment of (stored.strategyAdjustments ?? []).map(parseStoredStrategyAdjustment)) {
      this.strategyAdjustments.set(adjustment.id, adjustment);
    }
```

Do not catch parser errors. Malformed stored feedback must stop service construction.

- [ ] **Step 11: Update test fixtures with empty arrays**

In `apps/server/src/agent-autonomy.test.ts` and `apps/server/src/agent-conversation-bus.test.ts`, add these fields to snapshot fixtures:

```ts
missionOutcomeEvaluations: [],
taskFailureAnalyses: [],
strategyAdjustments: [],
```

- [ ] **Step 12: Run service tests**

Run:

```bash
pnpm --filter @digitalagent/server test -- mission-service.test.ts -t "feedback|execution fails|persists and restores feedback"
```

Expected: PASS.

- [ ] **Step 13: Run affected server tests**

Run:

```bash
pnpm --filter @digitalagent/server test -- mission-service.test.ts agent-autonomy.test.ts agent-conversation-bus.test.ts
```

Expected: PASS.

- [ ] **Step 14: Commit**

```bash
git add apps/server/src/mission-service.ts apps/server/src/mission-service.test.ts apps/server/src/agent-autonomy.test.ts apps/server/src/agent-conversation-bus.test.ts
git commit -m "feat: persist mission feedback records"
```

---

### Task 4: Feedback API Routes

**Files:**
- Modify: `apps/server/src/api.ts`
- Modify: `apps/server/src/api.test.ts`

- [ ] **Step 1: Write failing API tests**

Append to the mission API tests in `apps/server/src/api.test.ts`:

```ts
  it("returns mission feedback summary", async () => {
    const { handler, missions } = createTestHandler();
    const mission = missions.createMission("Grow a GitHub repository");
    missions.activateMission(mission.id);
    const task = missions.snapshot().tasks.find((candidate) => candidate.missionId === mission.id);
    expect(task).toBeDefined();
    const execution = missions.startExecution({ missionId: mission.id, taskId: task!.id });
    missions.failExecution({ executionId: execution.id, error: "OpenClaw timed out" });

    const resp = await handler({
      method: "GET",
      path: `/api/missions/${mission.id}/feedback-summary`,
      body: undefined,
    });

    expect(resp.status).toBe(200);
    expect(resp.body).toMatchObject({
      summary: {
        missionId: mission.id,
        counts: {
          evaluations: 1,
          failureAnalyses: 1,
          strategyAdjustments: 0,
        },
      },
    });
  });

  it("returns feedback record collections", async () => {
    const { handler, missions } = createTestHandler();
    const mission = missions.createMission("Grow a GitHub repository");
    missions.activateMission(mission.id);
    const task = missions.snapshot().tasks.find((candidate) => candidate.missionId === mission.id);
    expect(task).toBeDefined();
    const execution = missions.startExecution({ missionId: mission.id, taskId: task!.id });
    missions.failExecution({ executionId: execution.id, error: "OpenClaw timed out" });

    const evaluations = await handler({
      method: "GET",
      path: `/api/missions/${mission.id}/feedback/evaluations`,
      body: undefined,
    });
    const failureAnalyses = await handler({
      method: "GET",
      path: `/api/missions/${mission.id}/feedback/failure-analyses`,
      body: undefined,
    });
    const strategyAdjustments = await handler({
      method: "GET",
      path: `/api/missions/${mission.id}/feedback/strategy-adjustments`,
      body: undefined,
    });

    expect(evaluations.status).toBe(200);
    expect((evaluations.body as { evaluations: unknown[] }).evaluations).toHaveLength(1);
    expect(failureAnalyses.status).toBe(200);
    expect((failureAnalyses.body as { failureAnalyses: unknown[] }).failureAnalyses).toHaveLength(1);
    expect(strategyAdjustments.status).toBe(200);
    expect((strategyAdjustments.body as { strategyAdjustments: unknown[] }).strategyAdjustments).toHaveLength(0);
  });
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
pnpm --filter @digitalagent/server test -- api.test.ts -t "feedback"
```

Expected: FAIL with 404 responses for feedback endpoints.

- [ ] **Step 3: Add feedback summary route**

In `apps/server/src/api.ts`, before schedule routes, add:

```ts
    const feedbackSummaryMatch = request.path.match(/^\/api\/missions\/([^/]+)\/feedback-summary$/);
    if (feedbackSummaryMatch) {
      const missionId = feedbackSummaryMatch[1];
      if (!missionId) {
        return json(400, { error: "Mission ID required" });
      }
      if (request.method === "GET") {
        return json(200, { summary: deps.missions.getFeedbackSummary(missionId) });
      }
    }
```

- [ ] **Step 4: Add feedback collection routes**

Add after the summary route:

```ts
    const feedbackCollectionMatch = request.path.match(
      /^\/api\/missions\/([^/]+)\/feedback\/(evaluations|failure-analyses|strategy-adjustments)$/,
    );
    if (feedbackCollectionMatch) {
      const missionId = feedbackCollectionMatch[1];
      const collection = feedbackCollectionMatch[2];
      if (!missionId) {
        return json(400, { error: "Mission ID required" });
      }
      if (request.method === "GET" && collection === "evaluations") {
        return json(200, { evaluations: deps.missions.getMissionOutcomeEvaluations(missionId) });
      }
      if (request.method === "GET" && collection === "failure-analyses") {
        return json(200, { failureAnalyses: deps.missions.getTaskFailureAnalyses(missionId) });
      }
      if (request.method === "GET" && collection === "strategy-adjustments") {
        return json(200, { strategyAdjustments: deps.missions.getStrategyAdjustments(missionId) });
      }
    }
```

- [ ] **Step 5: Run API feedback tests**

Run:

```bash
pnpm --filter @digitalagent/server test -- api.test.ts -t "feedback"
```

Expected: PASS.

- [ ] **Step 6: Run full API tests**

Run:

```bash
pnpm --filter @digitalagent/server test -- api.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/api.ts apps/server/src/api.test.ts
git commit -m "feat: expose mission feedback APIs"
```

---

### Task 5: War Room Feedback Visibility

**Files:**
- Modify: `apps/server/public/app.js`
- Modify: `apps/server/public/war-room.js`
- Modify: `apps/server/public/styles.css`

- [ ] **Step 1: Add frontend state**

In `apps/server/public/app.js`, extend `state`:

```js
  feedbackSummaryByMissionId: {},
```

Update `emptySnapshot()`:

```js
    missionOutcomeEvaluations: [],
    taskFailureAnalyses: [],
    strategyAdjustments: [],
    knowledgeEntries: [],
```

- [ ] **Step 2: Add feedback API helper**

In `apps/server/public/app.js`, after `loadAutomationState()` add:

```js
async function loadFeedbackState(missionId) {
  if (!missionId) return;
  const result = await api(`/api/missions/${missionId}/feedback-summary`);
  state.feedbackSummaryByMissionId[missionId] = result.summary;
}
```

- [ ] **Step 3: Load feedback with mission automation**

In `refreshMissionAutomation()`, after `await loadAutomationState(mission.id);` add:

```js
  await loadFeedbackState(mission.id);
```

In the `[data-open-war-room]` click handler, after each `await loadAutomationState(mission.id);` add:

```js
      await loadFeedbackState(mission.id);
```

- [ ] **Step 4: Render feedback panel on overview**

In `apps/server/public/war-room.js`, update `renderWarOverview(data)` after `renderAutomationPulse(...)`:

```js
    ${renderFeedbackPanel(state.feedbackSummaryByMissionId[data.mission.id])}
```

Add before `renderAutomationPulse(data, summary)`:

```js
function renderFeedbackPanel(summary) {
  if (!summary) {
    return `
      <div class="feedback-panel">
        <div>
          <span>反馈闭环</span>
          <strong>正在读取反馈状态</strong>
          <p>系统会在任务完成或失败后记录 Mission 层面的学习结果。</p>
        </div>
      </div>
    `;
  }
  const evaluation = summary.latestEvaluation;
  const failure = summary.latestFailureAnalysis;
  const adjustment = summary.latestStrategyAdjustment;
  return `
    <div class="feedback-panel">
      <div class="feedback-main">
        <span>反馈闭环</span>
        <strong>${evaluation ? esc(evaluation.summary) : "还没有任务反馈"}</strong>
        <p>${evaluation ? `结果：${esc(evaluation.outcome)} · 贡献度 ${Math.round(evaluation.contributionScore * 100)}%` : "完成或失败一个任务后，这里会显示系统学到了什么。"}</p>
      </div>
      <div class="feedback-stats">
        <div><strong>${summary.counts.evaluations}</strong><span>评估</span></div>
        <div><strong>${summary.counts.failureAnalyses}</strong><span>失败分析</span></div>
        <div><strong>${summary.counts.strategyAdjustments}</strong><span>策略提案</span></div>
      </div>
      ${failure ? `<div class="feedback-note blocked"><strong>阻塞</strong><p>${esc(failure.summary)}</p></div>` : ""}
      ${adjustment ? `<div class="feedback-note"><strong>策略提案</strong><p>${esc(adjustment.proposedStrategy)}</p></div>` : ""}
    </div>
  `;
}
```

- [ ] **Step 5: Add feedback panel styles**

In `apps/server/public/styles.css`, near War Room styles add:

```css
.feedback-panel {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 14px;
  align-items: center;
  margin-bottom: 18px;
  border: 1px solid #d8dee8;
  border-radius: 10px;
  background: #ffffff;
  padding: 16px;
}
.feedback-main span,
.feedback-note strong {
  display: block;
  margin-bottom: 5px;
  color: #667085;
  font-size: 12px;
  font-weight: 800;
}
.feedback-main strong {
  display: block;
  margin-bottom: 5px;
  font-size: 16px;
}
.feedback-main p,
.feedback-note p {
  margin: 0;
  color: #5d6675;
  font-size: 13px;
  line-height: 1.5;
}
.feedback-stats {
  display: grid;
  grid-template-columns: repeat(3, minmax(72px, 1fr));
  gap: 8px;
}
.feedback-stats div {
  border: 1px solid #e4e7ec;
  border-radius: 8px;
  background: #f9fafb;
  padding: 9px 10px;
  text-align: center;
}
.feedback-stats strong,
.feedback-stats span {
  display: block;
}
.feedback-stats strong {
  color: #15181d;
  font-size: 16px;
}
.feedback-stats span {
  color: #667085;
  font-size: 12px;
  font-weight: 800;
}
.feedback-note {
  grid-column: 1 / -1;
  border: 1px solid #d8dee8;
  border-radius: 8px;
  background: #f9fafc;
  padding: 10px 12px;
}
.feedback-note.blocked {
  border-color: #f4b4b4;
  background: #fff1f1;
}
@media (max-width: 760px) {
  .feedback-panel {
    grid-template-columns: 1fr;
  }
  .feedback-stats {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}
```

- [ ] **Step 6: Build**

Run:

```bash
pnpm --filter @digitalagent/server build
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/server/public/app.js apps/server/public/war-room.js apps/server/public/styles.css
git commit -m "feat: show mission feedback in war room"
```

---

### Task 6: Full Verification And Browser Acceptance

**Files:**
- No code changes expected during the first verification pass.

- [ ] **Step 1: Run core tests**

Run:

```bash
pnpm --filter @digitalagent/core test
```

Expected: PASS.

- [ ] **Step 2: Run server tests**

Run:

```bash
pnpm --filter @digitalagent/server test
```

Expected: PASS.

- [ ] **Step 3: Run workspace typecheck**

Run:

```bash
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 4: Run workspace tests**

Run:

```bash
pnpm test
```

Expected: PASS.

- [ ] **Step 5: Start local server**

Run:

```bash
pnpm dev
```

Expected output includes:

```text
DigitalAgent running at http://127.0.0.1:3000
```

- [ ] **Step 6: Verify War Room empty feedback state in browser**

Open `http://127.0.0.1:3000` in the in-app browser, enter an active Mission's War Room.

Expected:

- Automation pulse still appears.
- Feedback panel appears under the automation pulse.
- If no task result exists, panel shows `还没有任务反馈`.
- Browser console has no errors.

- [ ] **Step 7: Verify feedback after execution failure**

Use the app or API to start and fail an execution for an active task.

Expected:

- `/api/missions/:missionId/feedback-summary` returns `counts.evaluations: 1`.
- `/api/missions/:missionId/feedback-summary` returns `counts.failureAnalyses: 1`.
- War Room feedback panel shows blocked feedback.
- `/api/snapshot` includes `missionOutcomeEvaluations` and `taskFailureAnalyses`.

- [ ] **Step 8: Verify feedback after approved execution result**

Use the app or API to submit a passing execution result for an active task.

Expected:

- `/api/missions/:missionId/feedback/evaluations` includes an `execution_result` record.
- The latest evaluation outcome is `advanced` for an approved high-quality result.
- War Room feedback panel shows the latest evaluation summary.

- [ ] **Step 9: Stop dev server**

Stop the `pnpm dev` process with `Ctrl-C`.

- [ ] **Step 10: Commit fixes if verification found defects**

If verification required code changes:

```bash
git add packages/core/src apps/server/src apps/server/public
git commit -m "fix: stabilize feedback foundation flow"
```

If no code changes were needed, do not create an empty commit.
