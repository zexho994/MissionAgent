# Phase 5.1 Feedback Loop Closure — Design

**Date:** 2026-05-06
**Status:** Approved for implementation

## Goal

Close the feedback loop by routing blocked/regressed evaluations to the Owner Agent for decision-making, so feedback records drive actual strategy adaptation rather than sitting unused in storage.

## Decision Log

| # | Question | Decision |
|---|----------|----------|
| 1 | How does the system handle blocked/regressed feedback? | Route to Owner Agent for judgment |
| 2 | Which evaluations does Owner receive? | blocked + regressed only (not advanced/neutral) |
| 3 | Does strategy adjustment require human approval? | No — Owner directly creates accepted StrategyAdjustment |
| 4 | When does Owner evaluate feedback? | Immediately on each blocked/regressed event |
| 5 | What context does Owner receive? | Evaluation summary + risks + next actions + TaskFailureAnalysis (root cause, recovery) |
| 6 | Who responds to accepted StrategyAdjustment? | HR Agent automatically triggered for team re-evaluation |
| 7 | How does Owner decide to adjust strategy? | Owner LLM judgment (no rules engine) |
| 8 | How does human see strategy changes? | War Room StrategyAdjustment panel (read-only history) |
| 9 | What can human do in the panel? | Read-only — no actions |

---

## End-to-End Flow

```
submitExecutionResult() / failExecution()
    → buildExecutionResultFeedback() / buildExecutionFailureFeedback()
    → recordExecutionResultFeedback() / recordExecutionFailureFeedback()
    → dispatchFeedbackEvent()                          ← NEW
    → AgentConversationBus routes feedback_evaluated   ← NEW
    → Owner Agent receives event
    → ContextRetriever includes evaluation + failureAnalysis in context  ← NEW
    → Owner LLM decides: adjust strategy or acknowledge
    → If adjustment needed: proposeStrategyAdjustment action (accepted)  ← NEW
    → System auto-triggers HR review for team re-evaluation  ← NEW
    → War Room StrategyAdjustmentPanel shows history   ← NEW
```

---

## New Components

### 1. BusEvent: `feedback_evaluated`

```typescript
type BusEventType =
  | "execution_completed"
  | "execution_failed"
  | "review_completed"
  | "review_revision_needed"
  | "agent_request"
  | "agent_notify"
  | "user_message"
  | "periodic_report"
  | "feedback_evaluated";  // NEW
```

```typescript
interface FeedbackEvaluatedEvent {
  type: "feedback_evaluated";
  missionId: string;
  taskId: string;
  evaluation: MissionOutcomeEvaluation;       // blocked or regressed only
  failureAnalysis?: TaskFailureAnalysis;        // present for revise/reject/execution_error
  timestamp: string;
}
```

**Routing:** `AgentConversationBus.dispatchEvent()` routes `feedback_evaluated` to the Owner agent via `targetAgents()`.

### 2. `dispatchFeedbackEvent()`

In `mission-service.ts`, called at the end of `submitExecutionResult()` and `failExecution()` when the evaluation outcome is `blocked` or `regressed`:

```typescript
function dispatchFeedbackEvent(
  deps: MissionServiceDeps,
  mission: Mission,
  evaluation: MissionOutcomeEvaluation,
  failureAnalysis?: TaskFailureAnalysis,
): void {
  const event: FeedbackEvaluatedEvent = {
    type: "feedback_evaluated",
    missionId: mission.id,
    taskId: evaluation.taskId,
    evaluation,
    failureAnalysis,
    timestamp: new Date().toISOString(),
  };
  deps.conversationBus.dispatchEvent(event);
}
```

**Condition:** Only dispatched when `evaluation.outcome === "blocked"` or `evaluation.outcome === "regressed"`.

### 3. Owner Agent Prompt Fragment

In `config/agent-system.json` or the Owner's prompt builder, add a section:

```
## Responding to Feedback Events

When you receive a feedback_evaluated event with a blocked or regressed outcome:
1. Review the evaluation: summary, risks, recommended next actions
2. If a failureAnalysis is present, review the root cause and recommended recovery
3. Decide: does this failure indicate a fundamental problem with the current
   strategy that requires adjustment, or is it an isolated execution issue
   that can be resolved by revising the task?
4. If strategy adjustment is warranted:
   - Use the proposeStrategyAdjustment action to record the adjustment
   - The system will automatically trigger an HR review of team composition
5. If no adjustment is needed, acknowledge the feedback in your response
   (no action required).
```

### 4. `proposeStrategyAdjustment` Agent Action

Add to the Owner's available actions in `owner/prompts.ts` or the action registry:

```typescript
async function proposeStrategyAdjustment(
  missionId: string,
  rationale: string,
  previousStrategy: string,
  proposedStrategy: string,
  affectedAgentRoles: string[],
  proposedTaskGoals: string[],
): Promise<{ adjustmentId: string }> {
  // 1. Create StrategyAdjustment with status = "accepted"
  const adjustment = createStrategyAdjustment({
    missionId,
    status: "accepted",
    previousStrategy,
    proposedStrategy,
    rationale,
    affectedAgentRoles,
    proposedTaskGoals,
    requiresHrReview: true,
  });

  // 2. Persist it
  missionService.recordAcceptedStrategyAdjustment(adjustment);

  // 3. Auto-trigger HR review
  await missionService.triggerHrTeamReevaluation(missionId, adjustment.id);

  return { adjustmentId: adjustment.id };
}
```

**Key difference from existing `createStrategyAdjustment`:** `status` is hardcoded to `"accepted"` (not `"proposed"`) — no human approval step. `requiresHrReview` is always `true`.

### 5. `triggerHrTeamReevaluation()`

In `mission-service.ts` or a new `hr-review.ts`:

```typescript
async function triggerHrTeamReevaluation(
  missionId: string,
  triggeredByAdjustmentId: string,
): Promise<void> {
  const mission = this.requireMission(missionId);
  const hrAgent = [...this.agents.values()].find(
    (a) => a.missionId === missionId && a.role === "hr",
  );
  if (!hrAgent) return; // No HR agent in this mission

  const adjustment = this.strategyAdjustments.get(triggeredByAdjustmentId);

  // Append a message to HR agent asking it to review team composition
  this.appendAgentMessage({
    missionId,
    fromAgentId: "system",
    toAgentId: hrAgent.id,
    content: `Team re-evaluation requested based on strategy adjustment: ${adjustment.rationale}. Proposed strategy: ${adjustment.proposedStrategy}. Review whether current team composition can execute this strategy or if new roles/adjustments are needed.`,
    type: "agent_request",
  });
}
```

**Note:** The HR review is a conversation round-trip, not a synchronous operation. The system queues the request and the HR agent responds in its own LLM tick cycle.

### 6. ContextRetriever Enhancement

In `context-retriever.ts`, when `activeEvents` contains `feedback_evaluated`, inject the evaluation and failure analysis into the context:

```typescript
function getRelevantContext(params: ContextParams): ContextBlock[] {
  const blocks: ContextBlock[] = [];

  for (const event of params.activeEvents) {
    if (event.type === "feedback_evaluated") {
      blocks.push({
        role: "system",
        content: `## Feedback Event Context
Task: ${event.taskId}
Evaluation Outcome: ${event.evaluation.outcome}
Evaluation Summary: ${event.evaluation.summary}
Evaluation Risks: ${event.evaluation.risks.join("; ") || "none"}
Recommended Next Actions: ${event.evaluation.recommendedNextActions.join("; ")}
${event.failureAnalysis ? `
Failure Analysis:
- Type: ${event.failureAnalysis.failureType}
- Root Cause: ${event.failureAnalysis.rootCause}
- Recommended Recovery: ${event.failureAnalysis.recommendedRecovery}
` : ""}`,
      });
    }
  }

  // ... rest of context building
}
```

### 7. War Room StrategyAdjustmentPanel

In `war-room.js`, add a panel that renders alongside the feedback panel:

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

CSS in `styles.css`:

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

---

## File Inventory

| File | Change |
|------|--------|
| `apps/server/src/agent-conversation-bus.ts` | Add `feedback_evaluated` to `BusEvent` union; route to Owner |
| `apps/server/src/mission-service.ts` | Add `dispatchFeedbackEvent()`, `recordAcceptedStrategyAdjustment()`, `triggerHrTeamReevaluation()` |
| `apps/server/src/context-retriever.ts` | Inject evaluation + failureAnalysis when `feedback_evaluated` event present |
| `apps/server/config/agent-system.json` | Add feedback response prompt fragment for Owner |
| `apps/server/src/owner/prompts.ts` | Add `proposeStrategyAdjustment` action |
| `apps/server/src/negotiation-manager.ts` | (May need extension to handle HR re-evaluation triggers) |
| `apps/server/public/war-room.js` | Add `renderStrategyAdjustmentsPanel()` |
| `apps/server/public/styles.css` | Add `.strategy-panel` styles |
| `apps/server/public/app.js` | Load strategy adjustments on mission select |

---

## Testing Approach

### Unit Tests

- `feedback-loop.test.ts`: Test `dispatchFeedbackEvent()` only fires for blocked/regressed
- `owner-feedback-context.test.ts`: Test `ContextRetriever` injects correct blocks for `feedback_evaluated` events
- `strategy-adjustment-action.test.ts`: Test `proposeStrategyAdjustment` creates accepted record and triggers HR

### Integration Tests

- Full round-trip: fail execution → Owner receives event → Owner calls action → HR gets message → panel shows record
- Using existing `InMemoryMissionService` test harness

---

## Out of Scope (Phase 5.2)

- Human approval step for strategy adjustments (Owner bypasses this per decision #3)
- Rules engine for automatic adjustment decisions
- Milestone / timeline visualization
- Budget monitoring
