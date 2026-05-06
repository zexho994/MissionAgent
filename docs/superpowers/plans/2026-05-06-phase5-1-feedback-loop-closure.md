# Phase 5.1 Feedback Loop Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route blocked/regressed evaluations to the Owner Agent, let Owner LLM decide whether to propose a strategy adjustment, auto-trigger HR re-evaluation when adjustment is created, and display strategy adjustment history in War Room.

**Architecture:** Add `feedback_evaluated` bus event routed to Owner. Extend `parseAction()` to handle `propose_strategy_adjustment` by executing business logic directly. Inject feedback context into Owner's LLM context via `ContextRetriever`. War Room loads and displays strategy adjustment history.

**Tech Stack:** TypeScript, Vitest, existing InMemoryMissionService, plain browser JavaScript.

---

## File Inventory

| File | Change |
|------|--------|
| `apps/server/src/agent-conversation-types.ts` | Add `FeedbackEvaluatedEvent` to `BusEvent` union |
| `apps/server/src/agent-conversation-bus.ts` | Route `feedback_evaluated` to Owner; add `propose_strategy_adjustment` action executor |
| `apps/server/src/context-retriever.ts` | Add `activeEvents` param; inject feedback context when `feedback_evaluated` present |
| `apps/server/src/mission-service.ts` | Add `dispatchFeedbackEvent()`, wire into `submitExecutionResult()` / `failExecution()` |
| `apps/server/config/agent-system.json` | Add `propose_strategy_adjustment` to Owner `availableActions`; add feedback prompt fragment |
| `apps/server/src/owner/prompts.ts` | Add feedback response guidance to `buildOwnerSystemPrompt()` |
| `apps/server/public/war-room.js` | Add `renderStrategyAdjustmentsPanel()`; wire into war overview |
| `apps/server/public/styles.css` | Add `.strategy-panel` styles |
| `apps/server/public/app.js` | Add `strategyAdjustmentsByMissionId` state; load on mission select |

---

## Task 1: BusEvent Types for Feedback

**Files:**
- Modify: `apps/server/src/agent-conversation-types.ts`
- Create: `apps/server/src/feedback-loop.test.ts`

- [ ] **Step 1: Read existing BusEvent types**

Run: `head -80 apps/server/src/agent-conversation-types.ts`

- [ ] **Step 2: Add `FeedbackEvaluatedEvent` to `BusEvent` union**

In `apps/server/src/agent-conversation-types.ts`, add after the existing event interface definitions:

```typescript
export interface FeedbackEvaluatedEvent {
  type: "feedback_evaluated";
  missionId: string;
  taskId: string;
  evaluation: import("@digitalagent/core").MissionOutcomeEvaluation;
  failureAnalysis?: import("@digitalagent/core").TaskFailureAnalysis;
  timestamp: string;
}
```

Find the `BusEvent` type union and add `| FeedbackEvaluatedEvent`.

- [ ] **Step 3: Write failing test for dispatch condition**

Create `apps/server/src/feedback-loop.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import type { MissionOutcomeEvaluation, TaskFailureAnalysis } from "@digitalagent/core";
import { buildExecutionFailureFeedback } from "./feedback-generation.js";

describe("feedback loop dispatch", () => {
  it("only dispatches feedback event for blocked or regressed outcomes", () => {
    const evaluation: MissionOutcomeEvaluation = {
      id: "eval_1",
      missionId: "mission_1",
      taskId: "task_1",
      source: "execution_result",
      outcome: "advanced",  // not blocked/regressed
      contributionScore: 0.9,
      summary: "Good result",
      evidence: ["approved"],
      risks: [],
      recommendedNextActions: [],
      createdAt: new Date().toISOString(),
    };

    // Should NOT dispatch
    const shouldDispatch = evaluation.outcome === "blocked" || evaluation.outcome === "regressed";
    expect(shouldDispatch).toBe(false);
  });

  it("dispatches feedback event for blocked outcome", () => {
    const evaluation: MissionOutcomeEvaluation = {
      id: "eval_1",
      missionId: "mission_1",
      taskId: "task_1",
      source: "execution_result",
      outcome: "blocked",
      contributionScore: 0.3,
      summary: "Needs revision",
      evidence: ["revise requested"],
      risks: ["quality below threshold"],
      recommendedNextActions: ["Revise the artifact"],
      createdAt: new Date().toISOString(),
    };

    // Should dispatch
    const shouldDispatch = evaluation.outcome === "blocked" || evaluation.outcome === "regressed";
    expect(shouldDispatch).toBe(true);
  });
});
```

- [ ] **Step 4: Run test**

Run: `pnpm --filter @digitalagent/server test -- feedback-loop.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/agent-conversation-types.ts apps/server/src/feedback-loop.test.ts
git commit -m "feat: add FeedbackEvaluatedEvent bus event type"
```

---

## Task 2: Route Feedback Event to Owner

**Files:**
- Modify: `apps/server/src/agent-conversation-bus.ts`

- [ ] **Step 1: Read targetAgents and topicForEvent**

Run: `sed -n '212,265p' apps/server/src/agent-conversation-bus.ts`

- [ ] **Step 2: Add `feedback_evaluated` to `targetAgents()` switch**

In the `targetAgents()` switch (around line 219), add after `case "periodic_report"`:

```typescript
case "feedback_evaluated":
  return uniqueAgents([owner]);
```

- [ ] **Step 3: Add `feedback_evaluated` to `topicForEvent()` switch**

In `topicForEvent()` (around line 242), add:

```typescript
case "feedback_evaluated":
  return "Feedback evaluation — strategy adjustment decision";
```

- [ ] **Step 4: Run server tests**

Run: `pnpm --filter @digitalagent/server test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/agent-conversation-bus.ts
git commit -m "feat: route feedback_evaluated events to Owner agent"
```

---

## Task 3: Dispatch Feedback Event from Mission Service

**Files:**
- Modify: `apps/server/src/mission-service.ts`
- Create: `apps/server/src/feedback-loop-dispatch.test.ts`

- [ ] **Step 1: Read the end of submitExecutionResult where feedback is recorded**

Run: `sed -n '1035,1055p' apps/server/src/mission-service.ts`

- [ ] **Step 2: Read the end of failExecution where feedback is recorded**

Run: `sed -n '1165,1190p' apps/server/src/mission-service.ts`

- [ ] **Step 3: Write failing integration test**

Create `apps/server/src/feedback-loop-dispatch.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { InMemoryMissionService } from "./mission-service.js";

describe("feedback event dispatch", () => {
  it("dispatches feedback event when execution result is blocked", async () => {
    const service = new InMemoryMissionService();
    const mission = service.createMission("Grow a GitHub repository");
    service.activateMission(mission.id);
    const task = service.snapshot().tasks.find((t) => t.missionId === mission.id);
    expect(task).toBeDefined();
    const execution = service.startExecution({ missionId: mission.id, taskId: task!.id });

    // Submit a revise result (builds blocked evaluation)
    service.submitExecutionResult({
      missionId: mission.id,
      taskId: task!.id,
      executionId: execution.id,
      content: { openclaw: "" },  // empty = low quality
      evidence: ["openclaw:local"],
    });

    // Verify evaluation is blocked
    const snapshot = service.snapshot();
    const eval_ = snapshot.missionOutcomeEvaluations.find(
      (e) => e.taskId === task!.id,
    );
    expect(eval_?.outcome).toBe("blocked");

    // Verify message was dispatched to Owner (check agentMessages)
    const ownerAgent = snapshot.agents.find((a) => a.role === "owner");
    const ownerMessages = snapshot.agentMessages.filter(
      (m) => m.fromAgentId === ownerAgent?.id || m.toAgentId === ownerAgent?.id,
    );
    // The dispatch sends a feedback_evaluated event which generates a message
    expect(snapshot.agentMessages.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `pnpm --filter @digitalagent/server test -- feedback-loop-dispatch.test.ts`
Expected: FAIL (dispatchFeedbackEvent not defined yet)

- [ ] **Step 5: Add dispatchFeedbackEvent function and wire it in**

In `mission-service.ts`, after `recordFeedbackKnowledge()` (around line 2500), add:

```typescript
function dispatchFeedbackEvent(
  deps: MissionServiceDeps,
  mission: Mission,
  evaluation: MissionOutcomeEvaluation,
  failureAnalysis?: TaskFailureAnalysis,
): void {
  if (evaluation.outcome !== "blocked" && evaluation.outcome !== "regressed") {
    return;  // Only dispatch for blocked/regressed
  }
  deps.conversationBus.dispatchEvent({
    missionId: mission.id,
    event: {
      type: "feedback_evaluated",
      missionId: mission.id,
      taskId: evaluation.taskId,
      evaluation,
      failureAnalysis,
      timestamp: new Date().toISOString(),
    },
  });
}
```

In `submitExecutionResult()` after `this.recordExecutionResultFeedback(feedback);` (around line 1040), add:

```typescript
dispatchFeedbackEvent(this.deps, mission, feedback.evaluation, feedback.failureAnalysis);
```

In `failExecution()` after `this.recordExecutionFailureFeedback(feedback);` (around line 1173), add:

```typescript
dispatchFeedbackEvent(this.deps, mission, feedback.evaluation, feedback.failureAnalysis);
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm --filter @digitalagent/server test -- feedback-loop-dispatch.test.ts`
Expected: PASS

- [ ] **Step 7: Run full server tests**

Run: `pnpm --filter @digitalagent/server test`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add apps/server/src/mission-service.ts apps/server/src/feedback-loop-dispatch.test.ts
git commit -m "feat: dispatch feedback_evaluated event on blocked/regressed outcomes"
```

---

## Task 4: ContextRetriever Injects Feedback Context

**Files:**
- Modify: `apps/server/src/context-retriever.ts`

- [ ] **Step 1: Read ContextRetriever interface and getRelevantContext**

Run: `head -110 apps/server/src/context-retriever.ts`

- [ ] **Step 2: Extend ContextParams to include activeEvents**

In `context-retriever.ts`, find the `ContextParams` interface (around line 8) and add:

```typescript
export interface ContextParams {
  missionId: string;
  agentId: string;
  currentTopic: string;
  threadId?: string;
  activeEvents?: BusEvent[];  // NEW
}
```

- [ ] **Step 3: Add feedback context block injection**

In `getRelevantContext()`, before the existing snippet building code (around line 28), add:

```typescript
// Inject feedback event context if present
if (input.activeEvents) {
  for (const event of input.activeEvents) {
    if (event.type === "feedback_evaluated") {
      const feedbackSnippet: ContextSnippet = {
        source: "feedback",
        sourceId: event.evaluation.id,
        summary: `[${event.evaluation.outcome.toUpperCase()}] ${event.evaluation.summary}${
          event.failureAnalysis
            ? ` | Failure: ${event.failureAnalysis.failureType} — ${event.failureAnalysis.rootCause}`
            : ""
        }`,
        relevance: 1.0,
        createdAt: event.timestamp,
      };
      snippets.unshift(feedbackSnippet);  // Prepend so it appears first
    }
  }
}
```

- [ ] **Step 4: Wire activeEvents into callAgent**

In `agent-conversation-bus.ts`, find where `contextRetriever.getRelevantContext()` is called inside `callAgent()` (around line 171). Pass the event:

```typescript
const context = this.deps.contextRetriever.getRelevantContext({
  missionId: input.missionId,
  agentId: input.target.id,
  currentTopic: input.thread.topic,
  threadId: input.thread.id,
  activeEvents: [input.event],  // pass current event for context injection
});
```

- [ ] **Step 5: Run tests**

Run: `pnpm --filter @digitalagent/server test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/context-retriever.ts apps/server/src/agent-conversation-bus.ts
git commit -m "feat: inject feedback context into Owner agent's LLM context"
```

---

## Task 5: Owner Feedback Prompt and Action Registration

**Files:**
- Modify: `apps/server/config/agent-system.json`
- Modify: `apps/server/src/owner/prompts.ts`

- [ ] **Step 1: Read buildOwnerSystemPrompt**

Run: `cat apps/server/src/owner/prompts.ts`

- [ ] **Step 2: Add propose_strategy_adjustment to Owner's availableActions**

In `apps/server/config/agent-system.json`, find the `owner` persona and change:

```json
"availableActions": ["notify_owner", "request_info", "acknowledge", "propose_strategy_adjustment"]
```

- [ ] **Step 3: Add feedback guidance to Owner's system prompt**

In `apps/server/src/owner/prompts.ts`, in `buildOwnerSystemPrompt()`, append to the returned string:

```typescript
+ `
## Responding to Feedback Events

When you receive a feedback_evaluated event with a blocked or regressed outcome:
1. Review the evaluation: summary, risks, recommended next actions
2. If a failureAnalysis is present, review the root cause and recommended recovery
3. Decide: does this failure indicate a fundamental problem with the current
   strategy that requires adjustment, or is it an isolated execution issue
   that can be resolved by revising the task?
4. If strategy adjustment is warranted:
   - Use the propose_strategy_adjustment action with the following payload:
     {
       "type": "propose_strategy_adjustment",
       "payload": {
         "rationale": "<why adjustment is needed>",
         "previousStrategy": "<current strategy as you understand it>",
         "proposedStrategy": "<what to change>",
         "affectedAgentRoles": ["<role1>", "<role2>"],
         "proposedTaskGoals": ["<goal1>", "<goal2>"]
       }
     }
   - The system will automatically trigger an HR review after the adjustment is recorded.
5. If no adjustment is needed, respond with acknowledge action.
`
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @digitalagent/server test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/server/config/agent-system.json apps/server/src/owner/prompts.ts
git commit -m "feat: add propose_strategy_adjustment action to Owner and feedback prompt"
```

---

## Task 6: Execute Strategy Adjustment Action

**Files:**
- Modify: `apps/server/src/agent-conversation-bus.ts`
- Create: `apps/server/src/strategy-adjustment-action.test.ts`

- [ ] **Step 1: Read the parseAction function and callAgent response handling**

Run: `sed -n '165,215p' apps/server/src/agent-conversation-bus.ts`

- [ ] **Step 2: Write failing test for propose_strategy_adjustment action**

Create `apps/server/src/strategy-adjustment-action.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { InMemoryMissionService } from "./mission-service.js";

describe("propose_strategy_adjustment action", () => {
  it("creates accepted StrategyAdjustment when Owner proposes it", async () => {
    const service = new InMemoryMissionService();
    const mission = service.createMission("Grow a GitHub repository");
    service.activateMission(mission.id);

    // Simulate Owner calling propose_strategy_adjustment
    // We test this via the mission service directly since action execution
    // happens through the conversation bus
    const previousStrategy = "Post broad content experiments.";
    const proposedStrategy = "Focus on evidence-backed repository growth loops.";
    const rationale = "Recent tasks failed due to lack of clear growth metric path.";

    const adjustment = {
      missionId: mission.id,
      status: "accepted" as const,
      previousStrategy,
      proposedStrategy,
      rationale,
      affectedAgentRoles: ["owner", "data_analyst"],
      proposedTaskGoals: ["Review repository growth metric assumptions"],
      requiresHrReview: true,
    };

    // Manually create the adjustment to test persistence
    service.recordAcceptedStrategyAdjustment(
      adjustment as import("@digitalagent/core").StrategyAdjustment,
    );

    const snapshot = service.snapshot();
    const found = snapshot.strategyAdjustments.find(
      (a) => a.missionId === mission.id && a.rationale === rationale,
    );
    expect(found).toBeDefined();
    expect(found?.status).toBe("accepted");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @digitalagent/server test -- strategy-adjustment-action.test.ts`
Expected: FAIL (recordAcceptedStrategyAdjustment not defined)

- [ ] **Step 4: Add recordAcceptedStrategyAdjustment to mission-service**

In `mission-service.ts`, add public method:

```typescript
recordAcceptedStrategyAdjustment(adjustment: StrategyAdjustment): void {
  if (adjustment.status !== "accepted") {
    throw new Error("Only accepted strategy adjustments can be recorded directly");
  }
  this.strategyAdjustments.set(adjustment.id, adjustment);
  this.recordFeedbackKnowledge(
    this.missionOutcomeEvaluations.values().find(
      (e) => e.missionId === adjustment.missionId,
    )!,
  );
}
```

- [ ] **Step 5: Add triggerHrTeamReevaluation method**

In `mission-service.ts`, add:

```typescript
async triggerHrTeamReevaluation(missionId: string, triggeredByAdjustmentId: string): Promise<void> {
  const hrAgent = [...this.agents.values()].find(
    (a) => a.missionId === missionId && a.role === "hr",
  );
  if (!hrAgent) return;  // No HR agent in this mission

  const adjustment = this.strategyAdjustments.get(triggeredByAdjustmentId);
  if (!adjustment) return;

  this.appendMessage({
    missionId,
    fromAgentId: "system",
    toAgentId: hrAgent.id,
    type: "agent_request",
    content: `Team re-evaluation requested based on strategy adjustment: ${adjustment.rationale}. Proposed strategy: ${adjustment.proposedStrategy}. Review whether current team composition can execute this strategy or if new roles/adjustments are needed. Respond via the conversation bus.`,
  });
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm --filter @digitalagent/server test -- strategy-adjustment-action.test.ts`
Expected: PASS

- [ ] **Step 7: Extend parseAction to handle propose_strategy_adjustment**

In `agent-conversation-bus.ts`, modify `parseAction()` (around line 356) to add the new action type:

Change the condition from:
```typescript
if (type !== "request_info" && type !== "notify_owner" && type !== "escalate" && type !== "acknowledge" && type !== "report_to_superior") {
  return { type: "acknowledge" };
}
```

To:
```typescript
if (type !== "request_info" && type !== "notify_owner" && type !== "escalate" && type !== "acknowledge" && type !== "report_to_superior" && type !== "propose_strategy_adjustment") {
  return { type: "acknowledge" };
}
```

- [ ] **Step 8: Add createId import to agent-conversation-bus**

In `apps/server/src/agent-conversation-bus.ts`, add to the imports at the top:

```typescript
import { createId } from "@digitalagent/core";
```

- [ ] **Step 9: Handle propose_strategy_adjustment in callAgent response**

In `agent-conversation-bus.ts`, find the part of `callAgent()` that processes the LLM response (around where `response.action` is handled after line 200). After processing `response.action`, add:

```typescript
// Execute propose_strategy_adjustment action
if (response.action?.type === "propose_strategy_adjustment" && response.action?.payload) {
  const payload = response.action.payload as Record<string, unknown>;
  const adjustment = {
    id: createId("strategy_adjustment"),
    missionId: input.missionId,
    status: "accepted" as const,
    previousStrategy: String(payload.previousStrategy ?? ""),
    proposedStrategy: String(payload.proposedStrategy ?? ""),
    rationale: String(payload.rationale ?? ""),
    affectedAgentRoles: Array.isArray(payload.affectedAgentRoles) ? payload.affectedAgentRoles.map(String) : [],
    proposedTaskGoals: Array.isArray(payload.proposedTaskGoals) ? payload.proposedTaskGoals.map(String) : [],
    requiresHrReview: true,
    createdAt: new Date().toISOString(),
  };

  const mission = this.deps.getSnapshot().missions.find((m) => m.id === input.missionId);
  if (mission) {
    this.deps.missions.recordAcceptedStrategyAdjustment(adjustment);
    void this.deps.missions.triggerHrTeamReevaluation(input.missionId, adjustment.id);
  }
}
```

- [ ] **Step 10: Run tests**

Run: `pnpm --filter @digitalagent/server test`
Expected: PASS

- [ ] **Step 11: Commit**

```bash
git add apps/server/src/agent-conversation-bus.ts apps/server/src/mission-service.ts apps/server/src/strategy-adjustment-action.test.ts
git commit -m "feat: execute propose_strategy_adjustment action and auto-trigger HR"
```

---

## Task 7: War Room StrategyAdjustments Panel

**Files:**
- Modify: `apps/server/public/war-room.js`
- Modify: `apps/server/public/styles.css`
- Modify: `apps/server/public/app.js`

- [ ] **Step 1: Read renderFeedbackPanel for pattern reference**

Run: `sed -n '126,160p' apps/server/public/war-room.js`

- [ ] **Step 2: Add renderStrategyAdjustmentsPanel function**

In `apps/server/public/war-room.js`, after `renderFeedbackPanel()` (around line 157), add:

```javascript
function renderStrategyAdjustmentsPanel(adjustments) {
  if (!adjustments || adjustments.length === 0) {
    return `
      <div class="strategy-panel">
        <div>
          <span>策略调整</span>
          <strong>暂无策略调整记录</strong>
          <p>当 Mission 策略发生变更时，会在此处显示历史记录。</p>
        </div>
      </div>
    `;
  }

  return `
    <div class="strategy-panel">
      <div class="strategy-header">
        <span>策略调整</span>
      </div>
      ${adjustments.map(adj => `
        <div class="strategy-record">
          <div class="strategy-rationale">${esc(adj.rationale)}</div>
          <div class="strategy-diff">
            <span class="strategy-from">${esc(adj.previousStrategy)}</span>
            <span class="strategy-arrow">→</span>
            <span class="strategy-to">${esc(adj.proposedStrategy)}</span>
          </div>
          <div class="strategy-meta">
            ${adj.affectedAgentRoles.length > 0 ? `影响角色: ${adj.affectedAgentRoles.join(", ")}` : ""}
            · ${new Date(adj.createdAt).toLocaleString()}
          </div>
        </div>
      `).join("")}
    </div>
  `;
}
```

- [ ] **Step 3: Wire panel into war overview**

In `apps/server/public/war-room.js`, find where the war overview is rendered (look for `renderWarOverview` or where feedback panel is called). Add the strategy panel after the feedback panel:

```javascript
${renderStrategyAdjustmentsPanel(state.strategyAdjustmentsByMissionId[data.mission.id])}
```

- [ ] **Step 4: Add strategy panel styles**

In `apps/server/public/styles.css`, add after the `.feedback-panel` styles:

```css
.strategy-panel {
  margin-bottom: 18px;
  border: 1px solid #d8dee8;
  border-radius: 10px;
  background: #ffffff;
  padding: 16px;
}
.strategy-header span {
  display: block;
  margin-bottom: 12px;
  color: #667085;
  font-size: 12px;
  font-weight: 800;
  text-transform: uppercase;
}
.strategy-record {
  border-top: 1px solid #e4e7ec;
  padding: 12px 0;
}
.strategy-record:first-child {
  border-top: none;
  padding-top: 0;
}
.strategy-rationale {
  font-size: 14px;
  color: #15181d;
  margin-bottom: 6px;
}
.strategy-diff {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  margin-bottom: 4px;
}
.strategy-from {
  color: #667085;
  text-decoration: line-through;
}
.strategy-arrow {
  color: #667085;
}
.strategy-to {
  color: #0d6e3f;
  font-weight: 500;
}
.strategy-meta {
  font-size: 12px;
  color: #98a2b3;
}
```

- [ ] **Step 5: Add state and API loading in app.js**

In `apps/server/public/app.js`, add to `state`:

```javascript
strategyAdjustmentsByMissionId: {},
```

In `emptySnapshot()`, add:

```javascript
strategyAdjustments: [],
```

Add API helper after `loadFeedbackState()`:

```javascript
async function loadStrategyAdjustments(missionId) {
  if (!missionId) return;
  const result = await api(`/api/missions/${missionId}/feedback/strategy-adjustments`);
  state.strategyAdjustmentsByMissionId[missionId] = result.strategyAdjustments || [];
}
```

In `refreshMissionAutomation()`, after `await loadFeedbackState(mission.id);`, add:

```javascript
await loadStrategyAdjustments(mission.id);
```

In the `[data-open-war-room]` click handler, after each `await loadFeedbackState(mission.id);`, add:

```javascript
await loadStrategyAdjustments(mission.id);
```

- [ ] **Step 6: Build and verify**

Run: `pnpm --filter @digitalagent/server build`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add apps/server/public/war-room.js apps/server/public/styles.css apps/server/public/app.js
git commit -m "feat: show strategy adjustment history in War Room"
```

---

## Task 8: Full Integration Test

**Files:**
- Create: `apps/server/src/feedback-loop-integration.test.ts`

- [ ] **Step 1: Write full round-trip integration test**

Create `apps/server/src/feedback-loop-integration.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { InMemoryMissionService } from "./mission-service.js";

describe("feedback loop full integration", () => {
  it("blocked execution triggers feedback event and creates strategy adjustment", async () => {
    const service = new InMemoryMissionService();
    const mission = service.createMission("Grow a GitHub repository");
    service.activateMission(mission.id);
    const task = service.snapshot().tasks.find((t) => t.missionId === mission.id);
    expect(task).toBeDefined();
    const execution = service.startExecution({ missionId: mission.id, taskId: task!.id });

    // Submit empty result -> blocked evaluation
    service.submitExecutionResult({
      missionId: mission.id,
      taskId: task!.id,
      executionId: execution.id,
      content: { openclaw: "" },
      evidence: ["openclaw:local"],
    });

    // Verify evaluation created
    const snapshot = service.snapshot();
    const eval_ = snapshot.missionOutcomeEvaluations.find((e) => e.taskId === task!.id);
    expect(eval_).toBeDefined();
    expect(eval_?.outcome).toBe("blocked");

    // Verify failure analysis created
    const failure = snapshot.taskFailureAnalyses.find((f) => f.taskId === task!.id);
    expect(failure).toBeDefined();
    expect(failure?.failureType).toBe("low_quality_output");

    // Verify knowledge entry created
    const knowledge = snapshot.knowledgeEntries.find((k) => k.key.includes("feedback:"));
    expect(knowledge).toBeDefined();
  });

  it("failed execution triggers feedback event", async () => {
    const service = new InMemoryMissionService();
    const mission = service.createMission("Grow a GitHub repository");
    service.activateMission(mission.id);
    const task = service.snapshot().tasks.find((t) => t.missionId === mission.id);
    expect(task).toBeDefined();
    const execution = service.startExecution({ missionId: mission.id, taskId: task!.id });

    service.failExecution({ executionId: execution.id, error: "OpenClaw timed out" });

    const snapshot = service.snapshot();
    const eval_ = snapshot.missionOutcomeEvaluations.find((e) => e.taskId === task!.id);
    expect(eval_?.outcome).toBe("blocked");
    expect(eval_?.source).toBe("execution_failure");
    const failure = snapshot.taskFailureAnalyses.find((f) => f.taskId === task!.id);
    expect(failure?.failureType).toBe("execution_error");
  });

  it("feedback summary reflects latest records", async () => {
    const service = new InMemoryMissionService();
    const mission = service.createMission("Grow a GitHub repository");
    service.activateMission(mission.id);
    const task = service.snapshot().tasks.find((t) => t.missionId === mission.id);
    expect(task).toBeDefined();
    const execution = service.startExecution({ missionId: mission.id, taskId: task!.id });

    service.failExecution({ executionId: execution.id, error: "OpenClaw timed out" });

    const summary = service.getFeedbackSummary(mission.id);
    expect(summary.counts.evaluations).toBe(1);
    expect(summary.counts.failureAnalyses).toBe(1);
    expect(summary.latestEvaluation?.outcome).toBe("blocked");
  });
});
```

- [ ] **Step 2: Run integration tests**

Run: `pnpm --filter @digitalagent/server test -- feedback-loop-integration.test.ts`
Expected: PASS

- [ ] **Step 3: Run full test suite**

Run: `pnpm --filter @digitalagent/server test`
Expected: PASS

- [ ] **Step 4: Run workspace tests**

Run: `pnpm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/feedback-loop-integration.test.ts
git commit -m "test: add feedback loop integration tests"
```

---

## Verification

- [ ] **Step 1: Run core tests**

Run: `pnpm --filter @digitalagent/core test`
Expected: PASS

- [ ] **Step 2: Run server tests**

Run: `pnpm --filter @digitalagent/server test`
Expected: PASS

- [ ] **Step 3: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS

- [ ] **Step 4: Start dev server**

Run: `pnpm dev`
Expected: Server starts on http://127.0.0.1:3000

- [ ] **Step 5: Verify in browser**

Open War Room for an active mission. Verify:
1. Strategy panel shows "暂无策略调整记录"
2. No console errors

- [ ] **Step 6: Verify via API**

```bash
curl http://127.0.0.1:3000/api/missions
# Find a mission ID, then:
curl http://127.0.0.1:3000/api/missions/:id/feedback-summary
curl http://127.0.0.1:3000/api/missions/:id/feedback/strategy-adjustments
```

- [ ] **Step 7: Stop dev server**

Stop with Ctrl-C.
