# Phase 4.5: War Room Automation Productization — Product Design

## Overview

Phase 4.5 turns the existing scheduler and schedule-rule backend into a visible, understandable product experience inside the War Room.

The user-facing goal is simple: when a user enters an active Mission, they should immediately understand that the system is running on a cadence. They should see what will happen next, who is responsible, when it will happen, what recently happened, and how to trigger or pause the automation without learning internal concepts like cron expressions or task contracts.

This phase does not add more intelligence. It makes the existing automation legible and lightly controllable.

## Current Problem

The current codebase already has Phase 4 backend primitives:

- `Mission.scheduleRules`
- `MissionScheduler`
- cron and condition triggers
- schedule REST APIs
- scheduler restore on service startup

The product still feels static because the War Room does not expose those capabilities clearly:

- The overview page does not show the next scheduled action.
- The schedule tab renders `暂无数据` even when schedule APIs exist.
- The user cannot trigger the next scheduled task from the War Room.
- There is no lightweight way to create business-language schedule rules.
- Scheduled task failures can be too soft from a product perspective.

The result is a dangerous mismatch: the backend has scheduler capability, but the user cannot confidently perceive that the Mission is alive.

## Goals

- Add a War Room "automation pulse" to the overview page.
- Show the next scheduled action, current scheduled work, and recent trigger result.
- Let users trigger the next eligible scheduled rule with one action.
- Let users pause and resume Mission automation without pausing the Mission itself.
- Replace the empty schedule tab with a rule list, next-run state, trigger history, and lightweight template creation.
- Support lightweight daily, weekly, and condition schedule templates.
- Keep cron, task contracts, condition prompts, and internal rule IDs out of the normal user flow.
- Fast-fail visible user-triggered automation errors instead of silently swallowing them.

## Non-Goals

- Do not implement Phase 5 feedback adaptation.
- Do not implement external data source adapters.
- Do not build a full cron editor.
- Do not expose raw `TaskContract` editing.
- Do not add one-off reminders.
- Do not support biweekly schedules in this phase, because current cron validation does not honestly support that product promise.
- Do not introduce a frontend framework.
- Do not replace `MissionScheduler`.

## Recommended Approach

Use the existing `ScheduleRule` model and scheduler as the source of truth. Add product-level service methods and UI rendering around them.

The chosen product direction is "War Room automation pulse + lightweight rule templates":

- The War Room overview gets the first-viewport signal that automation is running.
- The schedule tab becomes the detail and light-control surface.
- Users can add schedule rules through templates, not raw technical fields.
- The implementation remains incremental and compatible with existing Phase 4/4B work.

Rejected alternatives:

- **Overview-only pulse:** Fast, but leaves users unable to adjust basic cadence.
- **Full automation console:** Powerful, but it turns a goal-achievement product into an engineering configuration tool.

## User Experience

### War Room Overview

The War Room overview should add an automation pulse section above the existing agent network.

The pulse shows:

- **Next automatic action:** rule name, next execution time, responsible Agent, and task summary.
- **Current scheduled work:** queued or running tasks created by schedule rules.
- **Recent trigger:** most recent scheduled task creation or trigger result.
- **Actions:** `立即触发下一步` and `暂停自动运行` or `恢复自动运行`.

The pulse is intentionally concise. It should answer "is this Mission running?" before it asks the user to manage configuration.

### Schedule Tab

The schedule tab becomes the detail view for automation.

It shows:

- Existing HR/system-generated rules.
- User-created template rules.
- Enabled or disabled state.
- Next run time for cron rules.
- Rule assignee.
- Trigger type: daily, weekly, or condition.
- Recent trigger records.
- Lightweight actions: enable, disable, trigger now.

It also includes a lightweight rule creation form.

### Template Creation

The user creates rules in business language.

Supported periodic templates:

- Daily check.
- Weekly review.

Supported condition template:

- When a source Agent's output satisfies a condition, create a response task.

The form should collect:

- Template type.
- Responsible Agent or source Agent.
- Task goal or response task goal.
- Condition text for condition templates.

The form must not ask for:

- Cron expressions.
- `TaskContract`.
- `evaluatePrompt`.
- `maxConcurrent`.

After creating a rule, the UI asks:

- `现在执行一次`
- `等待计划时间`

This avoids creating premature work while still giving the user a way to see immediate motion.

## Backend API Design

Reuse existing endpoints where possible:

- `GET /api/missions/:missionId/schedule`
- `POST /api/missions/:missionId/schedule`
- `PATCH /api/missions/:missionId/schedule/:ruleId`
- `POST /api/missions/:missionId/schedule/:ruleId/trigger`

Add product-level endpoints:

### `GET /api/missions/:missionId/automation-summary`

Returns the War Room overview summary.

Response shape:

```ts
interface AutomationSummary {
  missionId: string;
  rulesCount: number;
  automationPaused: boolean;
  nextAction?: {
    ruleId: string;
    ruleName: string;
    nextRunAt: string;
    assigneeRole: string;
    assigneeAgentId?: string;
    taskTitle: string;
  };
  currentScheduledTasks: Array<{
    taskId: string;
    ruleId: string;
    title: string;
    status: string;
    assigneeAgentId?: string;
  }>;
  lastTrigger?: {
    ruleId: string;
    ruleName: string;
    taskId?: string;
    status: "created" | "skipped" | "failed";
    message: string;
    createdAt: string;
  };
}
```

If there are no rules, return `rulesCount: 0` rather than throwing.

### `POST /api/missions/:missionId/schedule/trigger-next`

Triggers the next eligible cron schedule rule.

Selection order:

1. Enabled cron rules whose `nextRunAt` is due or overdue.
2. Enabled cron rule with the nearest future `nextRunAt`.

Condition rules are excluded because they require task-output context.

Fast-fail cases:

- Mission not found.
- No enabled cron schedule rule exists.
- The selected rule has no matching assignee Agent.
- The selected rule is blocked by `maxConcurrent`.

### `POST /api/missions/:missionId/schedule/templates`

Creates a real `ScheduleRule` from a lightweight template.

Request shape:

```ts
type ScheduleTemplateRequest =
  | {
      templateType: "daily_check" | "weekly_review";
      assigneeRole: string;
      taskGoal: string;
    }
  | {
      templateType: "condition_response";
      sourceAgentRole: string;
      condition: string;
      responseAssigneeRole: string;
      responseTaskGoal: string;
    };
```

Periodic mapping:

- `daily_check` -> `0 9 * * *`
- `weekly_review` -> `0 9 * * 1`

Unsupported templates fail explicitly. `biweekly_review` must be rejected in this phase.

Generated rules use:

```ts
metadata: {
  createdBy: "user_template",
  templateType: "...",
}
```

The server generates the `taskTemplate.contract` from the business fields.

### Pause and Resume

Add product-level methods and endpoints:

- `POST /api/missions/:missionId/schedule/pause`
- `POST /api/missions/:missionId/schedule/resume`

Pause behavior:

- Disable currently enabled schedule rules.
- Mark those rules with `metadata.pausedByAutomationToggle = true`.
- Do not modify `Mission.status`.

Resume behavior:

- Re-enable only rules marked with `pausedByAutomationToggle`.
- Clear `pausedByAutomationToggle`.
- Do not re-enable rules that the user had already disabled manually.

`automationPaused` is derived from rule metadata and enabled state.

## Backend Service Design

Add service methods to `InMemoryMissionService`:

```ts
getAutomationSummary(missionId: string): AutomationSummary;
triggerNextScheduleRule(missionId: string): Task;
createScheduleRuleFromTemplate(
  missionId: string,
  input: ScheduleTemplateRequest,
): ScheduleRule;
pauseMissionAutomation(missionId: string): void;
resumeMissionAutomation(missionId: string): void;
```

### Triggering Rules

Current internal schedule-trigger behavior can notify Owner and return when an assignee is missing. That is acceptable for background scheduler ticks, but not for direct user actions.

For `triggerNextScheduleRule()` and explicit UI-triggered rule execution:

- Missing assignee is an error.
- Concurrency block is an error.
- Missing rule is an error.
- Disabled rule is an error.

Background cron ticks may still notify and skip without crashing the scheduler loop.

This distinction keeps unattended background work resilient while preserving fast-fail behavior for user-triggered actions.

### Trigger Records

Add a small structured `scheduleTriggerEvents` collection in `MissionSnapshot`.

```ts
interface ScheduleTriggerEvent {
  id: string;
  missionId: string;
  ruleId: string;
  ruleName: string;
  taskId?: string;
  status: "created" | "skipped" | "failed";
  message: string;
  createdAt: string;
}
```

Create one event whenever a schedule rule is triggered by cron, condition evaluation, explicit rule trigger, or `trigger-next`.

Do not infer recent triggers from arbitrary message text. The automation summary must read from structured trigger events.

## Frontend Design

Keep the existing static frontend structure:

- `apps/server/public/app.js` owns global state and refresh.
- `apps/server/public/war-room.js` owns War Room rendering.
- `apps/server/public/styles.css` owns styles.

Add state:

```js
automationSummaryByMissionId: {},
scheduleRulesByMissionId: {},
scheduleActionPending: false,
scheduleFormOpen: false,
```

Add client fetch helpers:

- `loadAutomationState(missionId)`
- `triggerNextSchedule(missionId)`
- `pauseAutomation(missionId)`
- `resumeAutomation(missionId)`
- `createScheduleTemplate(missionId, payload)`

Add render functions:

- `renderAutomationPulse(data, summary)`
- `renderScheduleTab(data, rules, summary)`
- `renderScheduleRuleCard(rule)`
- `renderScheduleTemplateForm(data)`
- `renderTriggerHistory(summary)`

Refresh behavior:

- Entering War Room loads snapshot, automation summary, and schedule rules.
- Polling refreshes automation summary while Mission view is active.
- Triggering, pausing, resuming, and creating templates refresh snapshot and automation state.

Overview behavior:

- If there are no rules, pulse shows "还没有自动运行节奏" and links the user to the schedule tab.
- If automation is paused, pulse clearly shows paused state.
- If next action exists, pulse shows time, role, task, and responsible Agent where available.

## Error Handling

Errors must be visible and specific.

Examples:

- `No enabled cron schedule rule available`
- `No agent found for role "data_analyst"`
- `Schedule rule is disabled`
- `Schedule rule is already at max concurrency`
- `Unsupported schedule template: biweekly_review`

The frontend should show these errors near the relevant action, not only in the top OpenClaw status pill.

Do not add broad fallback behavior that pretends an action succeeded. If a rule cannot trigger, the product should say why.

## Testing Strategy

### Server Tests

Add tests for:

- `getAutomationSummary()` with no rules.
- `getAutomationSummary()` with a next cron action.
- `getAutomationSummary()` with queued/running scheduled tasks.
- `getAutomationSummary()` with a recent trigger.
- `triggerNextScheduleRule()` chooses overdue cron rules first.
- `triggerNextScheduleRule()` chooses the nearest future cron rule when none are overdue.
- `triggerNextScheduleRule()` rejects when no enabled cron rule exists.
- `triggerNextScheduleRule()` rejects when assignee Agent is missing.
- Template creation creates valid daily rules.
- Template creation creates valid weekly rules.
- Template creation creates valid condition rules.
- Template creation rejects unsupported biweekly template.
- Pause disables only enabled rules and marks metadata.
- Resume restores only rules paused by the automation toggle.

### API Tests

Add tests for:

- `GET /automation-summary`
- `POST /schedule/trigger-next`
- `POST /schedule/templates`
- `POST /schedule/pause`
- `POST /schedule/resume`

### Browser Verification

Manual browser verification is required for the product experience:

1. Start a Mission with schedule rules.
2. Enter the War Room.
3. Confirm the automation pulse appears above the agent network.
4. Confirm `立即触发下一步` creates a task with `scheduleRuleId`.
5. Confirm the overview shows the task as queued or running.
6. Open the schedule tab and confirm rule list, enabled state, next run time, and trigger record.
7. Create a daily or weekly template rule.
8. Choose `现在执行一次` and confirm a scheduled task is created.
9. Pause automation and confirm summary shows paused state.
10. Resume automation and confirm only automation-paused rules are restored.

## Acceptance Criteria

1. An active Mission with schedule rules shows a next automatic action on the War Room overview.
2. The overview includes `立即触发下一步` and pause/resume automation controls.
3. Triggering the next action creates a task with `scheduleRuleId`.
4. Current scheduled tasks appear in the automation pulse.
5. The schedule tab displays real schedule rules instead of a static empty state.
6. Users can create daily, weekly, and condition rules through lightweight templates.
7. Users are asked whether to run a newly created rule now or wait for its planned time.
8. Users never need to edit cron expressions or task contracts in the normal flow.
9. Unsupported biweekly scheduling is rejected explicitly.
10. Pause/resume does not modify `Mission.status`.
11. Resume does not re-enable rules that were manually disabled before pause.
12. User-triggered automation failures are displayed clearly and do not silently succeed.

## Implementation Notes

- Keep implementation scoped to `apps/server`; do not change core package types for `ScheduleTriggerEvent` in this phase.
- Prefer deriving product summary from structured scheduler/task state.
- Read trigger history from structured `scheduleTriggerEvents`, not message text.
- Keep the UI language focused on Mission operations, not scheduler mechanics.
- Keep all new behavior test-first.
