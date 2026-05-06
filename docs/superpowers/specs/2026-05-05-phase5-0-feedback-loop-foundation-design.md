# Phase 5.0: Feedback Loop Foundation — Product Design

## Overview

Phase 5.0 creates the foundation for feedback loops without attempting full autonomous strategy adaptation.

The product goal is to make every completed, revised, rejected, or failed task produce a Mission-level learning artifact. The system should be able to answer: did this work move the Mission forward, what did we learn, what should happen next, and does the current strategy need attention?

This phase should not make the system aggressively self-modifying. It should establish the domain primitives, persistence, API surface, and War Room visibility that later Phase 5.x work can build on safely.

## Current Problem

The codebase already has useful execution primitives:

- `Task`
- `Artifact`
- `Review`
- `KnowledgeEntry`
- `AgentMessage`
- `TaskEvent`
- scheduler trigger records
- War Room overview and schedule UI

The missing layer is feedback interpretation.

Today, `submitExecutionResult()` evaluates artifact quality and transitions the task. That tells us whether an artifact is acceptable, but not whether the work helped the Mission. A rejected task has comments, but not a structured failure analysis. A good or bad result can create messages and knowledge entries, but there is no first-class record of why the Mission strategy should stay the same or change.

Without this layer, Phase 5 would drift into disconnected features: external data ingestion, dashboards, retries, or Agent messages without a stable feedback model.

## Goals

- Add first-class Mission-level outcome evaluation after task execution results.
- Add structured failure analysis for rejected, revision-requested, or failed execution flows.
- Add a lightweight strategy adjustment record that can capture proposed changes without automatically mutating the whole Mission.
- Persist all new feedback records and expose them in snapshots and APIs.
- Store important feedback summaries in Mission knowledge.
- Notify relevant Agents through existing message/event mechanisms.
- Show recent evaluations and strategy adjustments in the War Room.
- Keep the implementation compatible with Phase 4.5 automation and schedule-triggered tasks.

## Non-Goals

- Do not implement full autonomous strategy adaptation in Phase 5.0.
- Do not automatically recreate the team or modify Agent responsibilities in this phase.
- Do not integrate real external platforms such as Xiaohongshu, Zhihu, GitHub, or analytics APIs.
- Do not build a complex analytics dashboard.
- Do not introduce a new frontend framework.
- Do not replace existing artifact review logic.
- Do not hide failed outcomes behind fallback behavior. Failure analysis should expose problems early.

## Recommended Approach

Use Phase 5.0 as a domain foundation phase.

The recommended approach is:

1. Add explicit feedback domain records.
2. Generate them from existing execution and review transitions.
3. Persist and expose them through snapshot/API surfaces.
4. Render the newest records in War Room.
5. Leave heavy adaptation actions to Phase 5.x.

Rejected alternatives:

- **Jump directly to external data integration:** This would create data ingestion before the product knows how to reason about feedback.
- **Make Agents auto-change strategy immediately:** This is risky without traceable evaluation and adjustment records.
- **Only add War Room UI:** That would improve visibility but leave no durable model for future automation.

## Domain Model

### MissionOutcomeEvaluation

Records how a task result affected the Mission.

```ts
interface MissionOutcomeEvaluation {
  id: string;
  missionId: string;
  taskId: string;
  artifactId?: string;
  reviewId?: string;
  source: "execution_result" | "execution_failure" | "manual";
  outcome: "advanced" | "neutral" | "blocked" | "regressed";
  contributionScore: number;
  summary: string;
  evidence: string[];
  risks: string[];
  recommendedNextActions: string[];
  createdAt: string;
}
```

Rules:

- `contributionScore` must be between `0` and `1`.
- `summary` is required.
- `evidence` is required for non-manual records.
- `blocked` and `regressed` outcomes must include at least one risk or recommended next action.

### TaskFailureAnalysis

Records why a task did not produce useful forward motion.

```ts
type TaskFailureType =
  | "missing_information"
  | "agent_mismatch"
  | "unclear_task"
  | "external_blocker"
  | "low_quality_output"
  | "execution_error";

interface TaskFailureAnalysis {
  id: string;
  missionId: string;
  taskId: string;
  artifactId?: string;
  reviewId?: string;
  failureType: TaskFailureType;
  summary: string;
  rootCause: string;
  recommendedRecovery: "ask_user" | "revise_task" | "split_task" | "reassign_agent" | "adjust_strategy";
  recommendedNextActions: string[];
  createdAt: string;
}
```

Rules:

- Failure analysis is generated for rejected reviews, revision-requested reviews, and explicit execution failures.
- `rootCause` is required.
- `recommendedNextActions` must not be empty.
- The system should not silently retry. Retrying is a future action that must be explicitly represented.

### StrategyAdjustment

Records the lifecycle of a strategy change proposal.

```ts
interface StrategyAdjustment {
  id: string;
  missionId: string;
  triggeredByEvaluationId?: string;
  triggeredByFailureAnalysisId?: string;
  status: "proposed" | "accepted" | "rejected" | "superseded";
  previousStrategy: string;
  proposedStrategy: string;
  rationale: string;
  affectedAgentRoles: string[];
  proposedTaskGoals: string[];
  requiresHrReview: boolean;
  createdAt: string;
}
```

Rules:

- Phase 5.0 creates proposed adjustments only.
- Accepting, rejecting, and applying adjustments can be added later, but the data model reserves the states now.
- `requiresHrReview` is a signal only in Phase 5.0; it should not automatically create or modify Agents.

## Feedback Generation

### After `submitExecutionResult()`

When an execution result is submitted:

1. Keep existing artifact quality evaluation and review behavior.
2. Create a `MissionOutcomeEvaluation`.
3. If the review decision is `revise` or `reject`, also create a `TaskFailureAnalysis`.
4. If the failure analysis recommends `adjust_strategy`, create a proposed `StrategyAdjustment`.
5. Write a concise summary to Mission knowledge.
6. Append task events and messages so relevant Agents can see the feedback.

The first implementation can use deterministic heuristics based on review decision, artifact quality score, task status, task contract, and review comments. LLM-driven evaluation can be added in a later 5.x phase after the domain model is stable.

### After `failExecution()`

When an execution fails:

1. Create a blocked `MissionOutcomeEvaluation`.
2. Create a `TaskFailureAnalysis` with `failureType: "execution_error"` unless a more specific type is available.
3. Notify the task assignee and Owner through existing messages.
4. Do not create replacement tasks automatically in Phase 5.0.

## API Design

Add read endpoints:

- `GET /api/missions/:missionId/feedback/evaluations`
- `GET /api/missions/:missionId/feedback/failure-analyses`
- `GET /api/missions/:missionId/feedback/strategy-adjustments`
- `GET /api/missions/:missionId/feedback-summary`

`feedback-summary` returns the newest records needed by War Room:

```ts
interface FeedbackSummary {
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

Do not add mutation endpoints for manually creating strategy adjustments in Phase 5.0. The only mutation path should be existing execution flows.

## Snapshot And Persistence

Extend `MissionSnapshot` with:

```ts
missionOutcomeEvaluations: MissionOutcomeEvaluation[];
taskFailureAnalyses: TaskFailureAnalysis[];
strategyAdjustments: StrategyAdjustment[];
```

Persistence restore must fast-fail on malformed records rather than dropping them silently.

`emptySnapshot()` in the frontend must include empty arrays for these fields.

## War Room Experience

Add a lightweight feedback section to the War Room overview.

The first version should show:

- Latest Mission outcome evaluation.
- Latest failure analysis, if any.
- Latest strategy adjustment proposal, if any.
- Counts of evaluations, failure analyses, and strategy adjustments.

The UI should answer:

- What did the system learn from the latest execution?
- Is anything blocked?
- Is a strategy change being proposed?

It should not expose raw internal scoring as the primary message. Scores can be secondary details.

## Phase 5.x Boundary

Move these features out of Phase 5.0:

### Phase 5.1: Execution Feedback

- LLM-assisted Mission contribution evaluation.
- Automatic follow-up task creation.
- User-facing recovery actions.
- Stronger routing of feedback to specific Agents.

### Phase 5.2: Strategy Adaptation

- Accept/reject strategy adjustment actions.
- Applying strategy changes to Mission plans.
- Triggering HR review from accepted strategy adjustments.
- Tracking before/after strategy effectiveness.

### Phase 5.3: External Data Integration

- External data source adapter interface.
- Manual or mock metric ingestion.
- Real platform integrations.
- Data analyst workflows based on external metrics.

## Error Handling

- Invalid feedback records should throw immediately.
- Missing mission, task, artifact, or review references should throw.
- Rejected or failed tasks must not produce empty failure analyses.
- Strategy adjustment creation must require a rationale.
- API endpoints should return empty arrays for Missions with no feedback records.

## Testing

Add unit and API coverage for:

- Creating valid and invalid feedback domain records.
- `submitExecutionResult()` creates an outcome evaluation for approved reviews.
- `submitExecutionResult()` creates failure analysis for revise/reject reviews.
- `failExecution()` creates blocked evaluation and execution-error analysis.
- Feedback records persist and restore.
- Feedback summary API returns latest records and counts.
- War Room renders empty feedback state and latest feedback state.

## Acceptance Criteria

- Completing a task creates a Mission-level outcome evaluation.
- A rejected or revision-requested result creates a structured failure analysis.
- Execution failure creates a blocked evaluation and failure analysis.
- Feedback records appear in snapshots and survive persistence restore.
- Feedback summary API returns stable counts and latest records.
- War Room shows the latest feedback without requiring users to inspect raw task history.
- No external platform integration is implemented in Phase 5.0.
- No autonomous strategy application occurs in Phase 5.0.
