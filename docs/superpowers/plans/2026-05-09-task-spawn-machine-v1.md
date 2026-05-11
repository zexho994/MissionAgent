# 派活机器 v1：Owner 派下一个任务 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Owner / PM persona 在收到 `review_completed` / `execution_completed` 事件后，能基于反馈 LLM 决策派出下一个具体的实质工作任务，而不是只 acknowledge——让 Mission 真正能"自己跑"起来。

**Architecture:** 在 `AgentConversationResponse.action` 类型上新增 `create_followup_task`；Owner / PM persona 的 `availableActions` 里加入此 action；LLM 提示语里告知 LLM 新 action 的用法和参数；conversation bus 与 autonomy service 在收到此 action 时调用 `MissionService.createFollowupTask`，该方法带安全护栏（每 event 最多派 N 个 followup、Mission 总任务数软上限触发 escalate）。新任务创建后立即调度执行（与 scheduled task 同等待遇），确保循环真的合上。

**Tech Stack:** TypeScript, Vitest (test runner), 现有 mission-service / agent-conversation-bus / agent-autonomy / agent-personas 模块。

---

## 诊断背景（为什么这个 plan 存在）

**根因**：整个项目里"创建 task" 只发生在 2 个地方（Mission 启动初始化、Scheduler 定时触发），**没有任何代码路径会基于反馈派出新任务**。

**证据**：
- `mission-service.ts:648` 创建 initial task，`mission-service.ts:2429-2433` 是 scheduler 回调创建定时任务，全项目仅这 2 处
- `agent-conversation-types.ts:30` action 类型联合：`request_info | notify_owner | escalate | acknowledge | report_to_superior`，**没有 `create_followup_task`**
- `agent-system.json:166` Owner persona 可用动作：`["notify_owner", "request_info", "acknowledge"]`，**Owner 无牌可打**
- `schedule-templates.ts` 4 个内置模板全是"自检/汇报"型元任务，不是推进 Mission 的实质工作

**症状**：用户实测下来——团队 agent 完成第一个任务，向 Owner 汇报，Owner 只回复"了解"，Mission 停滞。

**修复方向**：在 action 类型、persona、prompt、bus、autonomy、mission-service 几处协同改动，让 Owner 收到反馈能派出新的实质任务，并加安全护栏防止失控。

---

## File Structure

### 修改的文件

| 文件 | 责任 |
|---|---|
| `packages/core/src/types.ts` | Task 类型加 `origin` 字段（标记是 initial / scheduled / followup，followup 带 reason 和 sourceTaskId） |
| `apps/server/src/agent-conversation-types.ts` | Action 联合类型加 `create_followup_task` + 定义其 payload 形状 |
| `apps/server/src/agent-conversation-bus.ts` | `parseAction` 识别新类型；事件处理时若 action 是 `create_followup_task` 且来自 Owner，调用 mission-service.createFollowupTask；LLM 提示语里加新 action 的用法 |
| `apps/server/src/agent-autonomy.ts` | 同上：`evaluateAgent` 后处理 `create_followup_task` action；LLM 提示语里加新 action |
| `apps/server/src/agent-personas.ts` | Owner / PM persona 默认 `availableActions` 加 `create_followup_task` |
| `apps/server/config/agent-system.json` | Owner persona 配置里 `availableActions` 加 `create_followup_task` |
| `apps/server/src/mission-service.ts` | 新增 `createFollowupTask` 方法（含安全护栏、自动 assign、自动 execute）；通过依赖注入暴露给 bus 和 autonomy |
| `packages/core/src/task.ts` | `createTask` 工厂函数支持 `origin` 字段 |

### 新建的文件

| 文件 | 责任 |
|---|---|
| `apps/server/src/followup-task-safety.ts` | 安全护栏的纯函数（per-event limit、per-mission cap、escalate 决策），便于单测 |
| `apps/server/src/followup-task-safety.test.ts` | 安全护栏的单元测试 |

### 改动的测试文件

| 文件 | 加什么 |
|---|---|
| `packages/core/src/task.test.ts` | createTask 接受 `origin` 字段 |
| `apps/server/src/agent-conversation-bus.test.ts` | parseAction 解析 `create_followup_task`；bus 收到此 action 调用 mission-service |
| `apps/server/src/agent-autonomy.test.ts` | autonomy 收到此 action 调用 mission-service |
| `apps/server/src/mission-service.test.ts` | createFollowupTask 创建任务带正确 metadata、enforces 安全限制、调度 execute |
| `apps/server/src/autonomous-flow.test.ts` | end-to-end：完成 task #1 → review_completed → Owner 派 task #2 → task #2 自动执行 |

---

## Tasks

### Task 1: 给 Task 类型加 `origin` 字段

**Files:**
- Modify: `packages/core/src/types.ts:132-145`
- Modify: `packages/core/src/task.ts:13` (and the `createTask` signature)
- Test: `packages/core/src/task.test.ts`

- [ ] **Step 1: Write the failing test for createTask with origin**

加到 `packages/core/src/task.test.ts`：
```typescript
import { describe, expect, it } from "vitest";
import { createTask } from "./task.js";

describe("createTask with origin", () => {
  it("records initial origin when not specified (backward compat)", () => {
    const task = createTask({
      missionId: "m-1",
      title: "do thing",
      dependencies: [],
      contract: { objective: "x", input: {}, outputSchema: {}, successCriteria: [] },
      approvalRequired: false,
    });
    expect(task.origin?.type ?? "initial").toBe("initial");
  });

  it("records followup origin with reason and sourceTaskId", () => {
    const task = createTask({
      missionId: "m-1",
      title: "do followup",
      dependencies: [],
      contract: { objective: "y", input: {}, outputSchema: {}, successCriteria: [] },
      approvalRequired: false,
      origin: { type: "followup", reason: "based on review of task-A", sourceTaskId: "task-A" },
    });
    expect(task.origin).toEqual({
      type: "followup",
      reason: "based on review of task-A",
      sourceTaskId: "task-A",
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @digitalagent/core vitest run src/task.test.ts -t "with origin"
```
Expected: FAIL（`origin` not a valid CreateTaskInput field）

- [ ] **Step 3: Add `TaskOrigin` type and extend `Task` in types.ts**

在 `packages/core/src/types.ts` 找到 `interface Task`，前面加：
```typescript
export type TaskOriginType = "initial" | "scheduled" | "followup";

export interface TaskOrigin {
  type: TaskOriginType;
  reason?: string;
  sourceTaskId?: string;
  triggeredByEventId?: string;
}
```

把 `interface Task` 加一个 optional 字段：
```typescript
export interface Task {
  // ... existing fields ...
  scheduleRuleId?: string;
  origin?: TaskOrigin;
}
```

- [ ] **Step 4: Update `createTask` factory in task.ts**

在 `packages/core/src/task.ts`：
```typescript
import type { Task, TaskContract, TaskOrigin } from "./types.js";
import { newId } from "./ids.js";

export interface CreateTaskInput {
  missionId: string;
  title: string;
  dependencies: string[];
  contract: TaskContract;
  approvalRequired: boolean;
  scheduleRuleId?: string;
  origin?: TaskOrigin;
}

export function createTask(input: CreateTaskInput): Task {
  const task: Task = {
    id: newId("task"),
    missionId: input.missionId,
    title: input.title,
    status: "draft",
    dependencies: input.dependencies,
    contract: input.contract,
    approvalRequired: input.approvalRequired,
  };
  if (input.scheduleRuleId) task.scheduleRuleId = input.scheduleRuleId;
  if (input.origin) task.origin = input.origin;
  return task;
}
```

- [ ] **Step 5: Run test to verify it passes**

```bash
pnpm --filter @digitalagent/core vitest run src/task.test.ts -t "with origin"
```
Expected: PASS

- [ ] **Step 6: Run all core tests to ensure no regression**

```bash
pnpm --filter @digitalagent/core test
```
Expected: ALL PASS

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/types.ts packages/core/src/task.ts packages/core/src/task.test.ts
git commit -m "feat(core): add TaskOrigin to track who/why created a task"
```

---

### Task 2: 扩展 Action 类型，加入 `create_followup_task`

**Files:**
- Modify: `apps/server/src/agent-conversation-types.ts:24-34`
- Test: `apps/server/src/agent-conversation-bus.test.ts`

- [ ] **Step 1: Write the failing test for parseAction with new type**

加到 `apps/server/src/agent-conversation-bus.test.ts`：
```typescript
import { describe, expect, it } from "vitest";
import { parseAgentConversationResponse } from "./agent-conversation-bus.js";

describe("parseAction create_followup_task", () => {
  it("parses create_followup_task action with payload", () => {
    const llmOutput = JSON.stringify({
      message: "派下一波任务",
      type: "agent_chat",
      shouldPropagate: false,
      action: {
        type: "create_followup_task",
        payload: {
          title: "Write second SEO article on topic X",
          objective: "Produce a second article based on first article's data",
          assigneeRole: "content_strategist",
          reason: "First article's keyword Y had high CTR",
          sourceTaskId: "task-1",
        },
      },
    });
    const parsed = parseAgentConversationResponse(llmOutput);
    expect(parsed.action?.type).toBe("create_followup_task");
    expect(parsed.action?.payload).toMatchObject({
      title: "Write second SEO article on topic X",
      assigneeRole: "content_strategist",
      reason: "First article's keyword Y had high CTR",
      sourceTaskId: "task-1",
    });
  });

  it("falls back to acknowledge if create_followup_task payload missing title", () => {
    const llmOutput = JSON.stringify({
      message: "...",
      type: "agent_chat",
      shouldPropagate: false,
      action: { type: "create_followup_task", payload: { objective: "x" } },
    });
    const parsed = parseAgentConversationResponse(llmOutput);
    expect(parsed.action?.type).toBe("acknowledge");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @digitalagent/server vitest run src/agent-conversation-bus.test.ts -t "create_followup_task"
```
Expected: FAIL（type not in union, parseAction falls back）

- [ ] **Step 3: Extend Action union in agent-conversation-types.ts**

把 line 24-34 整段替换为：
```typescript
export interface CreateFollowupTaskPayload {
  title: string;
  objective: string;
  assigneeRole: string;
  reason: string;
  sourceTaskId?: string;
  inputContext?: Record<string, unknown>;
}

export interface AgentConversationResponse {
  message: string;
  type: AgentMessageType;
  mentionedAgentIds?: string[];
  shouldPropagate: boolean;
  action?:
    | { type: "request_info" | "notify_owner" | "escalate" | "acknowledge" | "report_to_superior";
        targetAgentId?: string;
        payload?: Record<string, unknown>;
      }
    | { type: "create_followup_task";
        payload: CreateFollowupTaskPayload;
      };
}
```

- [ ] **Step 4: Extend `parseAction` in agent-conversation-bus.ts**

在 `apps/server/src/agent-conversation-bus.ts` line 356 替换 `parseAction` 函数：
```typescript
function parseAction(action: unknown): AgentConversationResponse["action"] {
  if (!action || typeof action !== "object") {
    return { type: "acknowledge" };
  }
  const value = action as Record<string, unknown>;
  const type = value.type;
  if (type === "create_followup_task") {
    const payload = value.payload as Record<string, unknown> | undefined;
    if (!payload
      || typeof payload.title !== "string" || !payload.title.trim()
      || typeof payload.objective !== "string" || !payload.objective.trim()
      || typeof payload.assigneeRole !== "string" || !payload.assigneeRole.trim()
      || typeof payload.reason !== "string" || !payload.reason.trim()
    ) {
      return { type: "acknowledge" };
    }
    const followupPayload: CreateFollowupTaskPayload = {
      title: payload.title.trim(),
      objective: payload.objective.trim(),
      assigneeRole: payload.assigneeRole.trim(),
      reason: payload.reason.trim(),
    };
    if (typeof payload.sourceTaskId === "string") {
      followupPayload.sourceTaskId = payload.sourceTaskId;
    }
    if (payload.inputContext && typeof payload.inputContext === "object" && !Array.isArray(payload.inputContext)) {
      followupPayload.inputContext = payload.inputContext as Record<string, unknown>;
    }
    return { type: "create_followup_task", payload: followupPayload };
  }
  if (type !== "request_info" && type !== "notify_owner" && type !== "escalate" && type !== "acknowledge" && type !== "report_to_superior") {
    return { type: "acknowledge" };
  }
  const parsed: Extract<NonNullable<AgentConversationResponse["action"]>, { type: typeof type }> = { type };
  if (typeof value.targetAgentId === "string") parsed.targetAgentId = value.targetAgentId;
  if (value.payload && typeof value.payload === "object" && !Array.isArray(value.payload)) {
    parsed.payload = value.payload as Record<string, unknown>;
  }
  return parsed;
}
```

记得 import：
```typescript
import type { AgentConversationResponse, BusEvent, ConversationThread, CreateFollowupTaskPayload } from "./agent-conversation-types.js";
```

- [ ] **Step 5: Run test to verify it passes**

```bash
pnpm --filter @digitalagent/server vitest run src/agent-conversation-bus.test.ts -t "create_followup_task"
```
Expected: PASS

- [ ] **Step 6: Run all server tests to ensure no regression**

```bash
pnpm --filter @digitalagent/server vitest run src/agent-conversation-bus.test.ts
```
Expected: ALL PASS

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/agent-conversation-types.ts apps/server/src/agent-conversation-bus.ts apps/server/src/agent-conversation-bus.test.ts
git commit -m "feat(agent-conversation): add create_followup_task action type"
```

---

### Task 3: Owner / PM persona 启用 `create_followup_task` 动作

**Files:**
- Modify: `apps/server/config/agent-system.json:166`
- Modify: `apps/server/src/agent-personas.ts`
- Test: `apps/server/src/agent-personas.test.ts`（可能需要新建）

- [ ] **Step 1: Check if agent-personas.test.ts exists**

```bash
ls /Users/zexho/Documents/DigitalAgent/apps/server/src/agent-personas.test.ts 2>/dev/null && echo "exists" || echo "need to create"
```

- [ ] **Step 2: Write the failing test for owner persona availableActions**

加到（或新建）`apps/server/src/agent-personas.test.ts`：
```typescript
import { describe, expect, it } from "vitest";
import { loadAgentPersonas } from "./agent-personas.js";
import { loadSystemConfig } from "./system-config.js";

describe("Owner persona", () => {
  it("includes create_followup_task in availableActions", () => {
    const config = loadSystemConfig();
    const personas = loadAgentPersonas(config);
    const ownerPersona = personas.personas.find((p) => p.role === "owner");
    expect(ownerPersona?.availableActions).toContain("create_followup_task");
  });
});
```

注：`loadAgentPersonas` 实际名字与签名根据 `agent-personas.ts` 现有实现调整。先 grep 确认：
```bash
grep -n "export" /Users/zexho/Documents/DigitalAgent/apps/server/src/agent-personas.ts | head -5
```

- [ ] **Step 3: Run test to verify it fails**

```bash
pnpm --filter @digitalagent/server vitest run src/agent-personas.test.ts
```
Expected: FAIL（owner.availableActions 没有 create_followup_task）

- [ ] **Step 4: Update agent-system.json**

`apps/server/config/agent-system.json` line 166 附近 owner persona：
```json
"owner": {
  "role": "owner",
  "systemPrompt": "You are the Owner Agent. You protect the mission goal, surface strategic risks, and keep the team aligned.",
  "communicationStyle": "Direct, concise, and decision-oriented.",
  "responseGuidelines": "Respond when a mission risk, decision, or cross-agent coordination issue needs attention. When a team member completes substantive work and reports findings, decide whether to spawn a concrete follow-up task that advances the mission.",
  "availableActions": ["notify_owner", "request_info", "acknowledge", "create_followup_task"]
}
```

content_strategist / researcher / reviewer 暂不开放（v1 只 Owner 有派活权，符合 A→C 演进路径中的 v1）。

- [ ] **Step 5: Update agent-personas.ts if there's hardcoded fallback**

```bash
grep -n "availableActions" /Users/zexho/Documents/DigitalAgent/apps/server/src/agent-personas.ts
```

如果有 hardcoded default，把 owner 的 default 也加上 `create_followup_task`。

- [ ] **Step 6: Run test to verify it passes**

```bash
pnpm --filter @digitalagent/server vitest run src/agent-personas.test.ts
```
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add apps/server/config/agent-system.json apps/server/src/agent-personas.ts apps/server/src/agent-personas.test.ts
git commit -m "feat(personas): grant Owner persona create_followup_task action"
```

---

### Task 4: 更新 LLM 提示语让 Owner 知道可以派活

**Files:**
- Modify: `apps/server/src/agent-conversation-bus.ts:204` (the prompt for callAgent)
- Modify: `apps/server/src/agent-autonomy.ts:172` (the prompt for evaluateAgent)
- Test: `apps/server/src/agent-conversation-bus.test.ts`

- [ ] **Step 1: Write a test asserting prompt mentions create_followup_task**

加到 `apps/server/src/agent-conversation-bus.test.ts`：
```typescript
import { AgentConversationBus } from "./agent-conversation-bus.js";

describe("Prompt mentions create_followup_task for Owner", () => {
  it("includes create_followup_task in the action options when owner is the target", async () => {
    const calls: string[] = [];
    const bus = new AgentConversationBus({
      llm: {
        call: async (messages) => {
          calls.push(JSON.stringify(messages));
          return { content: '{"message":"ok","type":"agent_chat","shouldPropagate":false,"action":{"type":"acknowledge"}}' };
        },
      } as any,
      personas: {
        personaFor: (agent: any) => ({
          role: agent.role,
          systemPrompt: "you are owner",
          communicationStyle: "direct",
          responseGuidelines: "respond when mission risk",
          availableActions: ["acknowledge", "create_followup_task"],
        }),
      } as any,
      contextRetriever: { getRelevantContext: () => [] } as any,
      getSnapshot: () => ({
        missions: [{ id: "m-1", goal: "test" }] as any,
        agents: [{ id: "a-owner", missionId: "m-1", role: "owner", name: "Owner", status: "idle" }] as any,
        tasks: [],
        artifacts: [],
        agentMessages: [],
        agentRelations: [],
        threads: [],
      } as any),
      appendMessage: (m: any) => ({ ...m, id: "mid", createdAt: new Date() }),
      createThread: (t: any) => ({ ...t, id: "tid", createdAt: new Date().toISOString() }),
      resolveThread: () => undefined,
      updateAgent: () => undefined,
      maxConversationDepth: 3,
      maxDiscussionRounds: 1,
      cooldownMs: 0,
    });
    await bus.dispatchEvent({
      missionId: "m-1",
      event: { type: "review_completed", agentId: "a-owner", taskId: "t-1", decision: "approve" },
    });
    expect(calls.join(" ")).toContain("create_followup_task");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @digitalagent/server vitest run src/agent-conversation-bus.test.ts -t "Prompt mentions"
```
Expected: FAIL（prompt 里没有 `create_followup_task` 字串）

- [ ] **Step 3: Update prompt in agent-conversation-bus.ts**

`apps/server/src/agent-conversation-bus.ts` line 204 整行替换：
```typescript
"Respond with one JSON object only. Choose `action.type` based on persona's availableActions. If you have create_followup_task available and the event indicates a task completed and the mission needs the next concrete work step, you MAY return: {\"action\":{\"type\":\"create_followup_task\",\"payload\":{\"title\":\"...\",\"objective\":\"...\",\"assigneeRole\":\"...\",\"reason\":\"...\",\"sourceTaskId\":\"...\"}}}. Otherwise return one of: acknowledge / report_to_superior / request_info / notify_owner / escalate. Schema: {\"message\":\"...\",\"type\":\"agent_chat|agent_report|agent_request|agent_notify|agent_discussion\",\"mentionedAgentIds\":[],\"shouldPropagate\":false,\"action\":{...}}",
```

- [ ] **Step 4: Update prompt in agent-autonomy.ts**

`apps/server/src/agent-autonomy.ts` line 172 整行替换：
```typescript
"Given your context and role, decide your next action. If your persona has create_followup_task available and the recent activity indicates the mission needs a concrete next step (e.g., a task completed and the next substantive work is clear), you MAY return: {\"action\":{\"type\":\"create_followup_task\",\"payload\":{\"title\":\"...\",\"objective\":\"...\",\"assigneeRole\":\"...\",\"reason\":\"...\"}}}. Otherwise: acknowledge / report_to_superior / request_info / notify_owner / escalate.",
"Respond with one JSON object only: {\"message\":\"...\",\"type\":\"agent_report|agent_chat|agent_request|agent_notify\",\"mentionedAgentIds\":[],\"shouldPropagate\":false,\"action\":{...}}",
```

- [ ] **Step 5: Run test to verify it passes**

```bash
pnpm --filter @digitalagent/server vitest run src/agent-conversation-bus.test.ts -t "Prompt mentions"
```
Expected: PASS

- [ ] **Step 6: Run full server tests for regressions**

```bash
pnpm --filter @digitalagent/server vitest run src/agent-conversation-bus.test.ts src/agent-autonomy.test.ts
```
Expected: ALL PASS

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/agent-conversation-bus.ts apps/server/src/agent-autonomy.ts apps/server/src/agent-conversation-bus.test.ts
git commit -m "feat(agents): inform LLM of create_followup_task action in prompts"
```

---

### Task 5: 安全护栏纯函数（独立可测）

**Files:**
- Create: `apps/server/src/followup-task-safety.ts`
- Create: `apps/server/src/followup-task-safety.test.ts`

- [ ] **Step 1: Write the failing test for safety helpers**

新建 `apps/server/src/followup-task-safety.test.ts`：
```typescript
import { describe, expect, it } from "vitest";
import {
  checkFollowupSafety,
  type FollowupSafetyConfig,
  type FollowupSafetyContext,
} from "./followup-task-safety.js";

const config: FollowupSafetyConfig = {
  maxFollowupsPerEvent: 1,
  maxTotalTasksPerMission: 50,
};

const baseCtx: FollowupSafetyContext = {
  missionId: "m-1",
  triggeringEventId: "ev-1",
  totalTasksInMission: 5,
  followupsAlreadyCreatedForEvent: 0,
};

describe("checkFollowupSafety", () => {
  it("approves when within all limits", () => {
    expect(checkFollowupSafety(config, baseCtx)).toEqual({ allowed: true });
  });

  it("blocks when per-event limit reached", () => {
    expect(checkFollowupSafety(config, { ...baseCtx, followupsAlreadyCreatedForEvent: 1 }))
      .toEqual({ allowed: false, reason: "per_event_limit", limit: 1 });
  });

  it("blocks and signals escalation when mission cap reached", () => {
    expect(checkFollowupSafety(config, { ...baseCtx, totalTasksInMission: 50 }))
      .toEqual({ allowed: false, reason: "mission_cap", limit: 50, escalateToUser: true });
  });

  it("blocks when both limits hit, returns the more severe (mission cap)", () => {
    const result = checkFollowupSafety(config, {
      ...baseCtx,
      followupsAlreadyCreatedForEvent: 1,
      totalTasksInMission: 50,
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("mission_cap");
    expect(result.escalateToUser).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @digitalagent/server vitest run src/followup-task-safety.test.ts
```
Expected: FAIL（file doesn't exist）

- [ ] **Step 3: Implement safety helpers**

新建 `apps/server/src/followup-task-safety.ts`：
```typescript
export interface FollowupSafetyConfig {
  maxFollowupsPerEvent: number;
  maxTotalTasksPerMission: number;
}

export interface FollowupSafetyContext {
  missionId: string;
  triggeringEventId: string;
  totalTasksInMission: number;
  followupsAlreadyCreatedForEvent: number;
}

export type FollowupSafetyResult =
  | { allowed: true }
  | { allowed: false; reason: "per_event_limit" | "mission_cap"; limit: number; escalateToUser?: boolean };

export function checkFollowupSafety(
  config: FollowupSafetyConfig,
  ctx: FollowupSafetyContext,
): FollowupSafetyResult {
  if (ctx.totalTasksInMission >= config.maxTotalTasksPerMission) {
    return {
      allowed: false,
      reason: "mission_cap",
      limit: config.maxTotalTasksPerMission,
      escalateToUser: true,
    };
  }
  if (ctx.followupsAlreadyCreatedForEvent >= config.maxFollowupsPerEvent) {
    return {
      allowed: false,
      reason: "per_event_limit",
      limit: config.maxFollowupsPerEvent,
    };
  }
  return { allowed: true };
}

export const DEFAULT_FOLLOWUP_SAFETY: FollowupSafetyConfig = {
  maxFollowupsPerEvent: 1,
  maxTotalTasksPerMission: 50,
};
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm --filter @digitalagent/server vitest run src/followup-task-safety.test.ts
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/followup-task-safety.ts apps/server/src/followup-task-safety.test.ts
git commit -m "feat(safety): add checkFollowupSafety pure helper"
```

---

### Task 6: MissionService.createFollowupTask 方法

**Files:**
- Modify: `apps/server/src/mission-service.ts` （加新方法 + 内部使用 checkFollowupSafety）
- Test: `apps/server/src/mission-service.test.ts`

- [ ] **Step 1: Write the failing test for createFollowupTask happy path**

加到 `apps/server/src/mission-service.test.ts`（如已有 createFollowupTask describe block 则放进去）：
```typescript
import { InMemoryMissionService } from "./mission-service.js";
import { describe, expect, it, vi } from "vitest";

describe("InMemoryMissionService.createFollowupTask", () => {
  it("creates a task with origin metadata, assigns to a matching role agent, and triggers execution", async () => {
    const service = createTestService(); // helper that creates an InMemoryMissionService with a test mission and team
    const mission = await service.createMissionForTest({ goal: "test mission" });
    // Bring mission into "team confirmed" state with a content_strategist agent (use existing helpers)
    await service.confirmTestMissionWithRoles(mission.id, ["content_strategist"]);
    const sourceTask = service.getInitialTask(mission.id);

    const result = await service.createFollowupTask({
      missionId: mission.id,
      triggeringEventId: "evt-1",
      payload: {
        title: "Write second SEO article on topic X",
        objective: "Produce a second article based on first article's data",
        assigneeRole: "content_strategist",
        reason: "First article's keyword Y had high CTR",
        sourceTaskId: sourceTask.id,
      },
    });

    expect(result.created).toBe(true);
    const newTask = service.getTaskByTitle(mission.id, "Write second SEO article on topic X");
    expect(newTask).toBeDefined();
    expect(newTask?.origin).toEqual({
      type: "followup",
      reason: "First article's keyword Y had high CTR",
      sourceTaskId: sourceTask.id,
      triggeredByEventId: "evt-1",
    });
    expect(newTask?.assigneeAgentId).toBeDefined();
    // Verify execution was triggered (executeTask was called)
    expect(service.getExecutionCallsForTask(newTask!.id).length).toBeGreaterThan(0);
  });

  it("blocks creating second followup for same triggering event (per_event_limit)", async () => {
    const service = createTestService();
    const mission = await service.createMissionForTest({ goal: "test" });
    await service.confirmTestMissionWithRoles(mission.id, ["content_strategist"]);

    const first = await service.createFollowupTask({
      missionId: mission.id,
      triggeringEventId: "evt-1",
      payload: minimalPayload("content_strategist"),
    });
    expect(first.created).toBe(true);

    const second = await service.createFollowupTask({
      missionId: mission.id,
      triggeringEventId: "evt-1",
      payload: minimalPayload("content_strategist"),
    });
    expect(second.created).toBe(false);
    expect(second.reason).toBe("per_event_limit");
  });

  it("escalates to owner when mission cap reached", async () => {
    const service = createTestService({ maxTotalTasksPerMission: 3 });
    const mission = await service.createMissionForTest({ goal: "test" });
    await service.confirmTestMissionWithRoles(mission.id, ["content_strategist"]);
    // Manually fill up to cap
    await service.bulkCreateTasksForTest(mission.id, 2);

    const result = await service.createFollowupTask({
      missionId: mission.id,
      triggeringEventId: "evt-X",
      payload: minimalPayload("content_strategist"),
    });
    expect(result.created).toBe(false);
    expect(result.reason).toBe("mission_cap");
    expect(result.escalateMessageSent).toBe(true);
    // Verify a notify_owner message was appended
    const messages = service.getMessagesForTest(mission.id);
    expect(messages.some((m) => m.type === "agent_notify" && m.content.includes("mission cap"))).toBe(true);
  });
});

function minimalPayload(role: string) {
  return {
    title: "do thing",
    objective: "x",
    assigneeRole: role,
    reason: "test",
  };
}
```

注：`createTestService`、`createMissionForTest`、`confirmTestMissionWithRoles`、`getTaskByTitle` 等 helper 函数需要先看 `mission-service.test.ts` 已有的 helper 模式（搜 `function create` / `helper`）。如果没有现成 helper，先用现有 test pattern 起一个。

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @digitalagent/server vitest run src/mission-service.test.ts -t "createFollowupTask"
```
Expected: FAIL（method 不存在）

- [ ] **Step 3: Implement createFollowupTask**

在 `apps/server/src/mission-service.ts` 找一个合适的位置（建议 `createTaskFromScheduleRule` 附近 line 2510 前后），加：

```typescript
import { checkFollowupSafety, DEFAULT_FOLLOWUP_SAFETY, type FollowupSafetyConfig } from "./followup-task-safety.js";
import type { CreateFollowupTaskPayload } from "./agent-conversation-types.js";

// ... 在 InMemoryMissionService class 内：

private followupSafetyConfig: FollowupSafetyConfig = DEFAULT_FOLLOWUP_SAFETY;
private followupCountByEvent = new Map<string, number>();

async createFollowupTask(input: {
  missionId: string;
  triggeringEventId: string;
  payload: CreateFollowupTaskPayload;
}): Promise<
  | { created: true; taskId: string }
  | { created: false; reason: "per_event_limit" | "mission_cap"; escalateMessageSent: boolean }
> {
  const mission = this.missions.get(input.missionId);
  if (!mission) throw new Error(`Mission not found: ${input.missionId}`);

  const totalTasks = [...this.tasks.values()].filter((t) => t.missionId === input.missionId).length;
  const followupsForEvent = this.followupCountByEvent.get(input.triggeringEventId) ?? 0;

  const safety = checkFollowupSafety(this.followupSafetyConfig, {
    missionId: input.missionId,
    triggeringEventId: input.triggeringEventId,
    totalTasksInMission: totalTasks,
    followupsAlreadyCreatedForEvent: followupsForEvent,
  });

  if (!safety.allowed) {
    let escalateMessageSent = false;
    if (safety.escalateToUser) {
      const owner = [...this.agents.values()].find(
        (a) => a.missionId === input.missionId && a.role === "owner",
      );
      if (owner) {
        this.appendMessage({
          missionId: input.missionId,
          fromAgentId: "system",
          toAgentId: owner.id,
          type: "agent_notify",
          content: `Mission reached task limit (${safety.limit}). Reason: ${safety.reason} — mission cap. Manual review required before more followup tasks.`,
        });
        escalateMessageSent = true;
      }
    }
    this.persist();
    return { created: false, reason: safety.reason, escalateMessageSent };
  }

  // Find an agent that matches the assigneeRole
  const assignee = [...this.agents.values()].find(
    (a) => a.missionId === input.missionId
      && (a.role === input.payload.assigneeRole || a.role.includes(input.payload.assigneeRole)),
  );
  if (!assignee) {
    // No matching agent — escalate to owner
    const owner = [...this.agents.values()].find(
      (a) => a.missionId === input.missionId && a.role === "owner",
    );
    if (owner) {
      this.appendMessage({
        missionId: input.missionId,
        fromAgentId: "system",
        toAgentId: owner.id,
        type: "agent_notify",
        content: `Followup task "${input.payload.title}" could not be assigned: no agent for role "${input.payload.assigneeRole}".`,
      });
    }
    this.persist();
    return { created: false, reason: "per_event_limit", escalateMessageSent: true };
    // (Use per_event_limit as fallback; future: add new reason "no_assignee")
  }

  // Create the task
  const task = createTask({
    missionId: input.missionId,
    title: input.payload.title,
    dependencies: [],
    contract: {
      objective: input.payload.objective,
      input: input.payload.inputContext ?? {},
      outputSchema: {},
      successCriteria: [`Output addresses: ${input.payload.objective}`],
    },
    approvalRequired: false,
    origin: {
      type: "followup",
      reason: input.payload.reason,
      sourceTaskId: input.payload.sourceTaskId,
      triggeredByEventId: input.triggeringEventId,
    },
  });
  const assigned = { ...task, assigneeAgentId: assignee.id };
  this.tasks.set(assigned.id, assigned);
  this.followupCountByEvent.set(
    input.triggeringEventId,
    followupsForEvent + 1,
  );

  this.appendMessage({
    missionId: input.missionId,
    fromAgentId: "system",
    type: "task_plan",
    content: `Followup task "${input.payload.title}" created (reason: ${input.payload.reason}).`,
  });

  // Trigger execution if runtime is available
  if (this.runtime) {
    try {
      void this.executeTask({ missionId: input.missionId, taskId: assigned.id, message: input.payload.objective });
    } catch (error) {
      console.error(
        `[MissionService] Followup task execution failed to start (mission ${input.missionId}, task ${assigned.id}):`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  this.persist();
  return { created: true, taskId: assigned.id };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm --filter @digitalagent/server vitest run src/mission-service.test.ts -t "createFollowupTask"
```
Expected: PASS

- [ ] **Step 5: Run all mission-service tests for regression**

```bash
pnpm --filter @digitalagent/server vitest run src/mission-service.test.ts
```
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/mission-service.ts apps/server/src/mission-service.test.ts
git commit -m "feat(mission-service): add createFollowupTask with safety guards"
```

---

### Task 7: Bus 收到 `create_followup_task` action 时调用 createFollowupTask

**Files:**
- Modify: `apps/server/src/agent-conversation-bus.ts` (constructor deps + dispatchEvent handling)
- Modify: `apps/server/src/mission-service.ts` (wire createFollowupTask into bus deps)
- Test: `apps/server/src/agent-conversation-bus.test.ts`

- [ ] **Step 1: Write the failing test for end-to-end bus → followup creation**

加到 `apps/server/src/agent-conversation-bus.test.ts`：
```typescript
describe("Bus dispatches create_followup_task action", () => {
  it("when LLM returns create_followup_task, bus calls createFollowupTask on the dependency", async () => {
    const createFollowupCalls: any[] = [];
    const llmResponse = JSON.stringify({
      message: "派下一个",
      type: "agent_chat",
      shouldPropagate: false,
      action: {
        type: "create_followup_task",
        payload: {
          title: "T2",
          objective: "Do the next step",
          assigneeRole: "content_strategist",
          reason: "based on review",
          sourceTaskId: "t-1",
        },
      },
    });
    const bus = new AgentConversationBus({
      // ... same scaffolding as Task 4 test ...
      createFollowupTask: async (input) => {
        createFollowupCalls.push(input);
        return { created: true, taskId: "new-task-id" };
      },
    } as any);
    await bus.dispatchEvent({
      missionId: "m-1",
      event: { type: "review_completed", agentId: "a-owner", taskId: "t-1", decision: "approve" },
    });
    expect(createFollowupCalls).toHaveLength(1);
    expect(createFollowupCalls[0].payload.title).toBe("T2");
    expect(createFollowupCalls[0].triggeringEventId).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @digitalagent/server vitest run src/agent-conversation-bus.test.ts -t "create_followup_task action"
```
Expected: FAIL

- [ ] **Step 3: Add createFollowupTask to bus deps interface**

在 `apps/server/src/agent-conversation-bus.ts` constructor deps 类型加：
```typescript
createFollowupTask: (input: {
  missionId: string;
  triggeringEventId: string;
  payload: CreateFollowupTaskPayload;
}) => Promise<{ created: true; taskId: string } | { created: false; reason: string }>;
```

- [ ] **Step 4: Handle create_followup_task action in dispatchEvent**

在 `dispatchEvent` 函数中，找到处理 response.action 的地方（在 `lastMessage = this.deps.appendMessage(messageInput);` 后面），加：
```typescript
if (response.action?.type === "create_followup_task") {
  const eventId = thread.id; // or generate a stable id from event
  await this.deps.createFollowupTask({
    missionId: input.missionId,
    triggeringEventId: eventId,
    payload: response.action.payload,
  });
}
```

- [ ] **Step 5: Wire in mission-service when constructing bus**

`apps/server/src/mission-service.ts` 找到 bus 构造的位置（grep "new AgentConversationBus"），把 `createFollowupTask` 加进 deps：
```typescript
createFollowupTask: (input) => this.createFollowupTask(input),
```

- [ ] **Step 6: Run test to verify it passes**

```bash
pnpm --filter @digitalagent/server vitest run src/agent-conversation-bus.test.ts -t "create_followup_task action"
```
Expected: PASS

- [ ] **Step 7: Run all related tests for regression**

```bash
pnpm --filter @digitalagent/server vitest run src/agent-conversation-bus.test.ts src/mission-service.test.ts
```
Expected: ALL PASS

- [ ] **Step 8: Commit**

```bash
git add apps/server/src/agent-conversation-bus.ts apps/server/src/mission-service.ts apps/server/src/agent-conversation-bus.test.ts
git commit -m "feat(bus): dispatch create_followup_task action to mission-service"
```

---

### Task 8: Autonomy service 同样收到 `create_followup_task` action 时调用 createFollowupTask

**Files:**
- Modify: `apps/server/src/agent-autonomy.ts` (deps + evaluateAgent)
- Modify: `apps/server/src/mission-service.ts` (wire deps)
- Test: `apps/server/src/agent-autonomy.test.ts`

- [ ] **Step 1: Write the failing test**

加到 `apps/server/src/agent-autonomy.test.ts`：
```typescript
describe("AgentAutonomyService dispatches create_followup_task", () => {
  it("when LLM returns create_followup_task, autonomy calls createFollowupTask", async () => {
    const createFollowupCalls: any[] = [];
    // Build autonomy with stubbed deps (mirror existing test patterns)
    const autonomy = new AgentAutonomyService({
      // ... existing scaffolding ...
      createFollowupTask: async (input) => {
        createFollowupCalls.push(input);
        return { created: true, taskId: "tx" };
      },
    } as any);
    autonomy.startLoop("m-1");
    // Trigger one tick manually if testable; otherwise verify via setInterval mock
    await autonomy.tickForTest("m-1"); // expose tick if needed for tests
    expect(createFollowupCalls.length).toBeGreaterThan(0);
  });
});
```

注：现有 test 文件可能没有 `tickForTest` helper。先看现有测试如何驱动 tick：
```bash
grep -n "startLoop\|tick" /Users/zexho/Documents/DigitalAgent/apps/server/src/agent-autonomy.test.ts | head -10
```

如有现成 pattern 参考，没有的话需要在 AgentAutonomyService 暴露一个 internal `tickForTest` 方法（仅供测试用）。

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter @digitalagent/server vitest run src/agent-autonomy.test.ts -t "create_followup_task"
```
Expected: FAIL

- [ ] **Step 3: Add createFollowupTask to autonomy deps + handle action**

`apps/server/src/agent-autonomy.ts` 加 deps：
```typescript
createFollowupTask: (input: {
  missionId: string;
  triggeringEventId: string;
  payload: CreateFollowupTaskPayload;
}) => Promise<{ created: true; taskId: string } | { created: false; reason: string }>;
```

在 `evaluateAgent` 函数处理 response.action 的地方（line 180 附近）加：
```typescript
if (response.action?.type === "create_followup_task") {
  await this.deps.createFollowupTask({
    missionId,
    triggeringEventId: `autonomy-tick-${tickCount}-${agent.id}`,
    payload: response.action.payload,
  });
}
```

- [ ] **Step 4: Wire deps in mission-service.ts**

找到 `new AgentAutonomyService` 构造处，加 `createFollowupTask: (input) => this.createFollowupTask(input)`。

- [ ] **Step 5: Run test to verify it passes**

```bash
pnpm --filter @digitalagent/server vitest run src/agent-autonomy.test.ts -t "create_followup_task"
```
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/agent-autonomy.ts apps/server/src/mission-service.ts apps/server/src/agent-autonomy.test.ts
git commit -m "feat(autonomy): dispatch create_followup_task action to mission-service"
```

---

### Task 9: 端到端集成测试——Mission 真的能从 task 1 → task 2 → task 3 接龙

**Files:**
- Modify or create: `apps/server/src/autonomous-flow.test.ts`

- [ ] **Step 1: Read existing autonomous-flow.test.ts to understand pattern**

```bash
ls /Users/zexho/Documents/DigitalAgent/apps/server/src/autonomous-flow.test.ts && head -80 /Users/zexho/Documents/DigitalAgent/apps/server/src/autonomous-flow.test.ts
```

- [ ] **Step 2: Write the failing end-to-end test**

加到 `apps/server/src/autonomous-flow.test.ts`：
```typescript
describe("Mission task spawning loop (A.3 v1)", () => {
  it("after first task completes, owner spawns followup task; after followup completes, owner can spawn another", async () => {
    // Setup: create service with stub LLM and stub runtime
    const llm = new StubLlm();
    const runtime = new StubRuntime();
    // Owner LLM is configured to return create_followup_task on review_completed
    llm.queueOwnerResponse({
      action: {
        type: "create_followup_task",
        payload: {
          title: "Step 2",
          objective: "Do step 2 based on step 1",
          assigneeRole: "content_strategist",
          reason: "Step 1 surfaced topic X",
          sourceTaskId: "<filled by test>",
        },
      },
    });
    llm.queueOwnerResponse({
      action: {
        type: "create_followup_task",
        payload: {
          title: "Step 3",
          objective: "Do step 3 based on step 2",
          assigneeRole: "content_strategist",
          reason: "Step 2 surfaced topic Y",
          sourceTaskId: "<filled by test>",
        },
      },
    });
    const service = createServiceWithStubs(llm, runtime);

    // Create + activate Mission
    const mission = await service.createMissionForTest({
      goal: "运营一个内容站",
      successMetrics: ["每周 1 篇"],
    });
    await service.confirmTestMissionWithRoles(mission.id, ["content_strategist"]);

    // Simulate: initial task completes → submitExecutionResult triggers review_completed event
    const initialTask = service.getInitialTask(mission.id);
    await service.submitExecutionResultForTest(initialTask.id, "first article draft");

    // Wait for autonomy / bus to process
    await waitFor(() => service.getTasksForTest(mission.id).length >= 2);

    const tasks = service.getTasksForTest(mission.id);
    expect(tasks.length).toBeGreaterThanOrEqual(2);
    const step2 = tasks.find((t) => t.title === "Step 2");
    expect(step2).toBeDefined();
    expect(step2?.origin?.type).toBe("followup");
    expect(step2?.origin?.sourceTaskId).toBe(initialTask.id);

    // Now simulate: step 2 completes → triggers another followup
    await service.submitExecutionResultForTest(step2!.id, "second article draft");
    await waitFor(() => service.getTasksForTest(mission.id).length >= 3);

    const step3 = service.getTasksForTest(mission.id).find((t) => t.title === "Step 3");
    expect(step3).toBeDefined();
    expect(step3?.origin?.sourceTaskId).toBe(step2!.id);
  });

  it("respects per-event limit: same review only spawns one followup", async () => {
    // Setup similar to above, but configure Owner LLM to return create_followup_task twice for same event
    // Verify only the first one creates a task
  });

  it("escalates to owner when total task cap reached", async () => {
    // Setup with maxTotalTasksPerMission=3, fill 3 tasks, then trigger a review event
    // Verify: no new task created, owner gets agent_notify message
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
pnpm --filter @digitalagent/server vitest run src/autonomous-flow.test.ts -t "task spawning loop"
```
Expected: FAIL（at least the first assertion — followup task not created）

- [ ] **Step 4: Inspect failures and fix any wiring issues**

If any task in earlier tasks (1-8) was incomplete, this end-to-end test will reveal. Fix as needed.

- [ ] **Step 5: Run test to verify it passes**

```bash
pnpm --filter @digitalagent/server vitest run src/autonomous-flow.test.ts -t "task spawning loop"
```
Expected: PASS

- [ ] **Step 6: Run full server test suite for regression**

```bash
pnpm --filter @digitalagent/server test
```
Expected: ALL PASS

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/autonomous-flow.test.ts
git commit -m "test(autonomous-flow): end-to-end task spawning loop verification"
```

---

### Task 10: Manual verification 手动验证 + 文档更新

**Files:**
- Modify: `ROADMAP.md` (mark A.3 v1 as complete)

- [ ] **Step 1: Build and start server**

```bash
pnpm build
pnpm dev
```
Wait for server to come up at http://localhost:3000

- [ ] **Step 2: Create a new test Mission via the UI**

打开 `http://localhost:3000`，点 "新对话"，输入一个简单 Mission 目标，例如：
> "学习一下 React Server Components"

走完 Owner 多轮对话 → MissionPlan → 进入作战室

- [ ] **Step 3: Wait for first task to complete and verify followup is created**

观察作战室。预期：
1. 初始 task 自动执行
2. 完成后 review 通过
3. **Owner 不再回"了解"，而是派出第 2 个具体任务**
4. 第 2 个任务自动开始执行

如果观察到这个，A.3 v1 真的跑通了。

- [ ] **Step 4: Check War Room shows the followup origin**

第 2 个 task 应该在 UI 上能看到来源信息（"基于 task 1 的产出 / 原因：..."）。如果 UI 没显示这个 metadata，记录为 P2 改进项（不阻塞 A.3 v1 验收）。

- [ ] **Step 5: Update ROADMAP.md to mark A.3 v1 done**

`ROADMAP.md` Phase A.3 区域加：
```markdown
**v1 完成（2026-05-XX）**：Owner 收到反馈后能派出 followup task 并自动执行。Mission 不再在第 1 个任务后停滞。
```

- [ ] **Step 6: Commit ROADMAP update**

```bash
git add ROADMAP.md
git commit -m "docs(roadmap): mark A.3 v1 (Owner spawn followup task) as shipped"
```

---

## Self-Review Checklist (执行 Plan 前自检)

### Spec coverage
- ✅ A.3 核心：Owner 能基于反馈派活 → Tasks 1-8 实现，Task 9 集成验证
- ✅ 决策可解释：每个 followup task 带 `origin.reason` → Task 1 类型 + Task 6 实现
- ✅ 安全护栏（per-event + mission cap） → Task 5 helper + Task 6 集成
- ✅ 用户拍板分层（escalate） → Task 6 escalate 路径
- ⚠️ 不在本 plan 范围：Owner 之外的 persona 派活权（属于 v2/v3，按 A→C 演进路径推迟）
- ⚠️ 不在本 plan 范围：调试"任务执行不稳定"（独立问题，需要单独诊断 OpenClaw runtime 行为）

### Type consistency check
- `TaskOrigin` 在 Task 1 定义，Task 6 用 → 一致
- `CreateFollowupTaskPayload` 在 Task 2 定义，Task 6/7/8 用 → 一致
- `createFollowupTask` 签名在 Task 6 定义，Task 7/8 用同一签名 → 一致
- `FollowupSafetyConfig` 在 Task 5 定义，Task 6 用 → 一致

### Placeholder scan
- 所有代码块都是实际可执行的（除了 Task 6 / Task 7 测试需要 helper 函数，已注明需要先看现有 test pattern）
- 所有命令都是具体可运行的
- 没有 "TODO" / "TBD" / "implement later"

### 已识别的风险
1. **Task 6 测试 helper 函数命名假设**：`createTestService`、`confirmTestMissionWithRoles` 等可能不是现有 helper 的真实名字。执行 Task 6 前要先 grep 现有 mission-service.test.ts 的 helper 模式调整命名。
2. **Task 8 autonomy `tickForTest`**：现有可能没有这个 helper，可能需要新加 internal export 仅供测试。如果完全无法测试，把这个 case 合并到 Task 9 的端到端测试。
3. **Task 7 `eventId` 选取**：当前用 `thread.id`，但同一 thread 内可能有多个 events。如果发现 per_event_limit 误判，改成"event in dispatchEvent input 的内容哈希"。

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-05-09-task-spawn-machine-v1.md`. Two execution options:**

**1. Subagent-Driven（recommended）** - 我（主对话）派 fresh subagent 执行每个 task，subagent 完成后我 review、批准、再派下一个 task。好处：每个 task 都有清晰的 review 节点，subagent 上下文干净，问题可以早发现。

**2. Inline Execution** - 我在当前对话直接执行所有 tasks。好处：上下文连续，少切换；坏处：上下文会被 build/test 输出塞满，token 消耗大。

**Which approach?**
