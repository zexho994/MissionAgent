# Phase 4.6.0: Autopilot Flow Diagnosis — Product Design

## Overview

Phase 4.6.0 makes Mission startup blockers visible.

The product should be able to answer a simple question for every Mission:

```text
Why is this Mission not running yet?
```

This phase does not fix or automate the missing steps. It creates a structured diagnosis service, API, and War Room panel that reveal where the Mission is blocked in the autopilot bootstrap path.

## Current Problem

DigitalAgent already has many of the pieces needed for a running Mission:

- Owner briefing and brief confirmation.
- HR-based team assembly.
- Agent relations.
- Initial tasks from activation.
- Schedule rules and automation pulse.
- Execution records.
- OpenClaw execution integration.

The product still feels stuck because those pieces are not connected into a visible startup path. A user can enter the War Room and see Agents, tasks, and schedules, but the product does not clearly say what is missing before the Mission can run automatically.

The main known missing pieces are:

- No first-class `MissionPlan`.
- No explicit plan confirmation gate.
- No generic execution runner abstraction.
- No automatic next-action launcher.
- Default schedule bootstrap is not tied to Mission readiness.

Phase 4.6.0 should expose these gaps honestly instead of hiding them behind optimistic UI.

## Goals

- Add a structured `AutopilotDiagnosis` for each Mission.
- Detect the current autopilot stage from existing Mission data.
- Report concrete blockers and next actions.
- Expose diagnosis through a read-only API.
- Show diagnosis in the War Room overview.
- Keep current Mission behavior unchanged.
- Make missing Phase 4.6.x prerequisites visible, especially missing `MissionPlan` and execution runner.

## Non-Goals

- Do not create `MissionPlan` in this phase.
- Do not auto-confirm briefs.
- Do not auto-run HR.
- Do not create initial tasks.
- Do not add execution runner abstraction.
- Do not register default schedules.
- Do not start or trigger executions automatically.
- Do not add new user action buttons in the diagnosis panel.

## Recommended Approach

Add a deterministic diagnosis layer in `InMemoryMissionService`.

The diagnosis should use existing state only:

- Mission brief and `briefConfirmed`.
- Agents and relations.
- Tasks and task statuses.
- Schedule rules.
- Executions.
- Tool calls.
- Runner availability signals supplied by the API layer.

The first implementation should be conservative. If a later capability is not implemented yet, diagnosis should say so directly. For example, `hasPlan` should be `false` until Phase 4.6.1 introduces a real `MissionPlan`.

`InMemoryMissionService` should not own OpenClaw health checks. The API layer already has access to OpenClaw dependencies, so the diagnosis method should accept runtime signals:

```ts
interface AutopilotRuntimeSignals {
  hasExecutionRunner: boolean;
}
```

Rejected alternatives:

- **Backend-only diagnosis:** Useful for tests, but it does not solve the product visibility problem.
- **Diagnosis plus automatic repair:** Too broad for 4.6.0 and risks hiding the true missing flow.
- **A large lifecycle state migration:** Premature before we know which blockers matter most in real use.

## Domain Model

```ts
export type AutopilotStage =
  | "briefing"
  | "missing_plan"
  | "team_not_ready"
  | "missing_initial_tasks"
  | "missing_execution_runner"
  | "missing_schedule"
  | "ready"
  | "running"
  | "blocked";

export type AutopilotBlockerCode =
  | "brief_not_confirmed"
  | "mission_plan_missing"
  | "team_not_ready"
  | "initial_tasks_missing"
  | "execution_runner_missing"
  | "schedule_rules_missing"
  | "execution_blocked";

export interface AutopilotBlocker {
  code: AutopilotBlockerCode;
  message: string;
  nextAction: string;
}

export interface AutopilotDiagnosisSignals {
  briefConfirmed: boolean;
  hasPlan: boolean;
  teamReady: boolean;
  hasInitialTasks: boolean;
  hasExecutionRunner: boolean;
  hasScheduleRules: boolean;
  hasRunningExecution: boolean;
}

export interface AutopilotDiagnosis {
  missionId: string;
  stage: AutopilotStage;
  ready: boolean;
  blockers: AutopilotBlocker[];
  signals: AutopilotDiagnosisSignals;
}
```

## Stage Rules

Evaluate prerequisite gates first. Runtime states are only considered after the Mission has passed all startup prerequisites.

1. `briefing`
   - If `mission.briefConfirmed !== true`.

2. `missing_plan`
   - If no confirmed `MissionPlan` exists.
   - In Phase 4.6.0 this will be true for most Missions because `MissionPlan` does not exist yet.

3. `team_not_ready`
   - If the Mission has no non-Owner, non-HR execution Agents.

4. `missing_initial_tasks`
   - If the Mission has no non-completed task that can plausibly be executed.

5. `missing_execution_runner`
   - If the Mission has executable tasks but no available runner signal.
   - In Phase 4.6.0, the only real runner signal is OpenClaw availability from the API layer.
   - Internal LLM runner support is not counted until Phase 4.6.4 adds that runner.

6. `missing_schedule`
   - If the Mission has no schedule rules.

7. `blocked`
   - If all prerequisites are satisfied, but the latest task execution failed or a non-Owner/non-HR execution Agent is blocked.

8. `running`
   - If all prerequisites are satisfied and the Mission has any running execution.

9. `ready`
   - If all prerequisites are satisfied and there are no runtime blockers.

The diagnosis should return only blockers that are relevant after earlier prerequisite gates pass. For example, a Mission with an unconfirmed brief should not also report missing plan, runner, or schedule blockers.

## API Design

Add:

```text
GET /api/missions/:missionId/autopilot-diagnosis
```

Response:

```ts
{
  diagnosis: AutopilotDiagnosis
}
```

Behavior:

- Missing Mission throws `Mission not found`.
- Existing Mission always returns a diagnosis.
- No mutation occurs.

## War Room Experience

Add an "Autopilot 状态" panel to the War Room overview, below the automation pulse.

The panel should show:

- Current stage.
- Whether the Mission is ready.
- The first blocker message.
- The first blocker next action.
- Compact signal checklist.

Example empty/early state:

```text
Autopilot 状态
阶段：缺少执行计划
当前阻塞：MissionBrief 已确认，但还没有 MissionPlan。
下一步：进入 Phase 4.6.1，让 Owner 生成并确认 MissionPlan。
```

The panel must not show action buttons in 4.6.0. It is a diagnostic surface only.

## Frontend State

Add:

```js
autopilotDiagnosisByMissionId: {}
```

Add loader:

```js
loadAutopilotDiagnosis(missionId)
```

Load diagnosis when entering or refreshing War Room alongside automation state.

`emptySnapshot()` does not need new arrays in this phase.

## Error Handling

- Missing Mission should fail through the existing API error flow.
- Diagnosis should not swallow inconsistent state.
- If a Mission has tasks that reference missing Agents, diagnosis should mark team or runner readiness as blocked rather than pretending ready.
- If OpenClaw is unavailable, diagnosis should expose missing runner state when executable tasks exist.

## Testing

Add server tests for:

- Newly created Mission with no confirmed brief returns `briefing`.
- Brief-confirmed Mission without plan returns `missing_plan`.
- Mission with running execution returns `running`.
- Mission with failed execution returns `blocked`.
- Mission with tasks but no runner signal returns `missing_execution_runner`.
- Mission with no schedule rules returns `missing_schedule` once earlier blockers are absent or explicitly bypassed in the test fixture.
- API returns diagnosis for an existing Mission.

Add frontend/build verification:

- War Room renders loading state before diagnosis arrives.
- War Room renders stage, blocker message, next action, and signal checklist after diagnosis loads.

## Acceptance Criteria

- Every Mission can return an `AutopilotDiagnosis`.
- War Room shows why the Mission is not running.
- Diagnosis explicitly exposes missing `MissionPlan` before 4.6.1 exists.
- Diagnosis explicitly exposes missing execution runner before 4.6.4 exists.
- No automatic progression or repair is added.
- Existing automation pulse, schedule tab, and trigger-next behavior continue to work.
