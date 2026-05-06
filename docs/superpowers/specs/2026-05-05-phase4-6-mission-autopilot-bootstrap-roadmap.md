# Phase 4.6: Mission Autopilot Bootstrap — Iteration Roadmap

## Purpose

Phase 4.6 fixes the product's main execution path before Phase 5 feedback adaptation begins.

The current product has many strong pieces: Owner briefing, HR team assembly, Agent relations, schedule rules, War Room visibility, and OpenClaw execution integration. The missing product layer is the default path that turns a newly created Mission into a running Mission.

This roadmap breaks the work into small iterations. Each iteration solves one concrete problem and should leave the product more usable than before.

## Product Gap

The desired flow is:

```text
User expresses goal
-> Owner understands and clarifies requirements
-> User confirms brief
-> Owner creates a Mission plan
-> User confirms or revises the plan
-> HR assembles the team from the plan
-> System creates initial tasks and default schedules
-> Agents execute work on cadence
-> Agents communicate and report progress
-> System adjusts based on real progress
```

The current product only partially supports this flow:

- Briefing exists.
- HR assembly exists.
- Agent relations exist.
- Schedule rules exist.
- War Room visibility exists.
- Execution records exist.

But the flow does not yet run by default because these are missing or incomplete:

- No explicit Mission startup/onboarding state.
- No first-class `MissionPlan`.
- No user confirmation loop for the plan.
- HR is not fully plan-driven.
- Team-ready Missions do not reliably get initial executable tasks.
- Task execution is effectively tied to OpenClaw instead of a generic runner.
- The product does not automatically start the next executable action.
- Default schedule bootstrap is not part of Mission readiness.
- War Room does not clearly say why a Mission is not running.

## Iteration List

### Phase 4.6.0: Autopilot Flow Diagnosis

**Goal:** Make the current Mission startup blocker visible.

**Problem Solved:** Users and developers cannot tell why a Mission has not started running.

**Scope:**

- Define a diagnostic view of Mission startup state.
- Show whether the Mission is blocked by missing brief confirmation, missing plan, missing team, missing initial tasks, missing execution runner, or missing schedule bootstrap.
- Expose the diagnosis in War Room.
- Do not auto-fix anything in this iteration.

**Acceptance Criteria:**

- War Room can answer: "Why is this Mission not running yet?"
- A newly created Mission shows a concrete next missing step.
- Existing active Missions do not break.

---

### Phase 4.6.1: Owner Workflow Prompts And MissionPlan

**Goal:** Add the missing plan layer between confirmed brief and HR assembly.

**Problem Solved:** HR currently reasons from the brief too directly; there is no explicit execution plan for team assembly and schedules.

**Scope:**

- Add `MissionPlan`.
- Add Owner planning workflow prompt.
- Generate a plan after brief confirmation.
- Let user confirm the plan or submit revision feedback.
- Prevent HR assembly from using an unconfirmed plan in the autopilot path.

**MissionPlan Should Include:**

- Mission goal and success metrics.
- Execution phases.
- Key workstreams.
- Required roles.
- Initial task goals.
- Expected reporting relationships.
- Default schedule rhythm.
- Risks and checkpoints.

**Acceptance Criteria:**

- After brief confirmation, the system can generate a structured plan.
- User can confirm or request plan changes.
- Confirmed plan becomes the source of truth for HR assembly.

---

### Phase 4.6.2: Plan-Driven HR Assembly

**Goal:** Make HR assemble the team from `MissionPlan`, not only from `MissionBrief`.

**Problem Solved:** Team composition, responsibilities, reporting relationships, and schedules are not tightly tied to the plan.

**Scope:**

- Update HR input to include confirmed `MissionPlan`.
- Require HR output to include role specs, agent relations, schedule recommendations, and initial task plan.
- Ensure each role maps back to a workstream or responsibility in the plan.
- Fast-fail if HR output does not satisfy the plan.

**Acceptance Criteria:**

- HR-created roles trace back to the confirmed plan.
- Reporting relationships are created from HR output.
- Schedule recommendations are captured for later bootstrap.
- War Room shows that the team was assembled from the plan.

---

### Phase 4.6.3: Initial Task Planning

**Goal:** Ensure a team-ready Mission has executable work.

**Problem Solved:** The system can create a team but still leave Agents with no concrete tasks.

**Scope:**

- Add `InitialTaskPlan` or equivalent task-generation structure.
- Generate first tasks from confirmed plan and assembled roles.
- Create at least one ready task for each critical execution role.
- Create coordination tasks for Owner or project-manager-like roles.
- Fast-fail if no executable task can be generated.

**Acceptance Criteria:**

- After team assembly, the Mission has ready tasks.
- Each critical Agent has a clear first responsibility.
- War Room shows the next executable task.

---

### Phase 4.6.4: ExecutionRunner Abstraction

**Goal:** Decouple task execution from OpenClaw.

**Problem Solved:** Current execution records exist, but real task execution is tied to `/api/openclaw/run`.

**Scope:**

- Add `TaskExecutionRunner` interface.
- Add `OpenClawExecutionRunner`.
- Add `InternalLlmExecutionRunner` for text/planning/analysis tasks.
- Add runner selection rules.
- Fast-fail when no runner can execute a task.
- Keep OpenClaw as one runner, not the execution architecture itself.

**Acceptance Criteria:**

- The system can select a runner for a task.
- OpenClaw tasks still work.
- Internal LLM-compatible tasks can run without OpenClaw.
- Missing runner is visible as a blocked state, not silent failure.

---

### Phase 4.6.5: Autopilot Start Next Action

**Goal:** Let a ready Mission automatically start or expose the next executable action.

**Problem Solved:** The product can create tasks, but does not reliably move from task to execution.

**Scope:**

- Find the next executable task.
- Select the appropriate runner.
- Start execution.
- Submit result or fail execution through existing service methods.
- Expose current runner and error state in War Room.

**Acceptance Criteria:**

- Mission can move from ready task to running execution.
- Successful execution produces artifact and review.
- Failed execution produces an explicit blocked state.
- War Room shows what is currently executing.

---

### Phase 4.6.6: Default Schedule Bootstrap

**Goal:** Give long-running Missions a default operating rhythm.

**Problem Solved:** Schedule rules exist, but Mission readiness does not automatically include a useful cadence.

**Scope:**

- Create daily check and weekly review schedule templates from confirmed plan and team roles.
- Register default schedules after team and initial tasks are ready.
- Avoid duplicate schedule creation.
- Mark schedule source as system/bootstrap metadata.
- Ensure automation pulse reflects the default schedules.

**Acceptance Criteria:**

- A ready long-running Mission has default schedule rules.
- Automation pulse shows the next automatic action.
- `trigger-next` can create a task from the default rule.
- Re-running bootstrap does not duplicate rules.

---

### Phase 4.6.7: End-to-End Browser Acceptance

**Goal:** Prove the main product flow works from Mission creation to first execution result.

**Problem Solved:** Individual features exist, but the complete path has not been validated as a product journey.

**Scope:**

- Browser-test the full Mission startup path.
- Verify created Mission moves through briefing, planning, team assembly, task planning, schedule bootstrap, and first execution.
- Verify War Room shows the current state at each step.
- Fix blockers found during acceptance.

**Acceptance Criteria:**

The following path works in the in-app browser:

```text
Create Mission
-> Owner asks for missing details or generates brief
-> User confirms brief
-> Owner generates MissionPlan
-> User confirms plan
-> HR assembles team
-> System creates initial tasks
-> System registers default schedules
-> System starts or exposes the next executable action
-> Execution produces artifact/review or explicit failure
-> War Room shows progress and current blocker
```

## Recommended Order

Implement in this order:

```text
4.6.0 Flow diagnosis
4.6.1 MissionPlan
4.6.2 Plan-driven HR
4.6.3 Initial tasks
4.6.4 ExecutionRunner
4.6.5 Start next action
4.6.6 Default schedule bootstrap
4.6.7 E2E acceptance
```

## Why This Comes Before Phase 5

Phase 5 feedback loops require real execution results.

If the Mission cannot reliably reach task execution and artifact review, Phase 5 would evaluate an incomplete product flow. Phase 4.6 must first make the system run a Mission end to end. Then Phase 5 can evaluate, learn, and adapt from real outcomes.

## Prompt System Direction

Phase 4.6 should also introduce workflow-style prompts inspired by the Superpowers skill model.

Each Agent workflow should define:

- When to use it.
- Required inputs.
- Step-by-step process.
- Hard gates.
- Output JSON schema.
- Fast-fail conditions.
- Non-goals.

Candidate workflow prompts:

- `owner-briefing`
- `owner-planning`
- `hr-team-assembly`
- `execution-planning`
- `execution-runner-selection`
- `task-execution`

The goal is not just better wording. The goal is to constrain Agent behavior through explicit workflow protocols.
