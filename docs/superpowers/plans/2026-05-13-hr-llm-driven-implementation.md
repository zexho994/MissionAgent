# HR 招募 LLM 驱动化改造 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 HR 招募改造为纯 LLM 驱动、出错可见的单一路径,删除关键词 fallback 和所有相关死代码。

**Architecture:** 在 `negotiation-manager.ts` 外层包装重试逻辑(3 次重试,间隔 1s/2s/4s),失败后透传到 API 返回 503。删除 `team-planning.ts` / `hr-activation.ts` 及 `agent-system.json` 中的关键词配置。

**Tech Stack:** TypeScript, Vitest, Node.js HTTP, pnpm workspaces (`@digitalagent/core`, `@digitalagent/runtime`, `@digitalagent/server`)。

**Spec reference:** `docs/superpowers/specs/2026-05-13-hr-llm-driven-design.md`

---

## File Structure

### 新建
- `apps/server/src/retry.ts` — 通用重试工具(纯函数,无副作用)
- `apps/server/src/retry.test.ts` — 重试工具单测(使用 fake timers)

### 修改
- `apps/server/src/hr-agent.ts` — 移除 `analyzeAndPlan` 内部的 try-catch fallback,让 LLM 错误向上抛
- `apps/server/src/hr-agent.test.ts` — 调整依赖内部 fallback 的测试
- `apps/server/src/negotiation-manager.ts` — `startNegotiation` 包重试 + 失败时 HR 状态置 `failed`
- `apps/server/src/negotiation-manager.test.ts` — 增加重试场景测试
- `apps/server/src/mission-service.ts` — 删除老 `activateMission()`,`activateMissionWithHR` 改名为 `activateMission`,去掉 catch fallback;内联 `matcherFor` 工具
- `apps/server/src/mission-service.test.ts` — 删除关键词路径测试;增加 503 错误测试
- `apps/server/src/api.ts` — `/missions/:id/activate` 错误时返回 503 + `Retry-After: 5`
- `apps/server/src/api.test.ts` — 增加 503 响应测试
- `apps/server/src/system-config.ts` — 从 `AgentSystemConfig` 类型移除被砍字段
- `apps/server/config/agent-system.json` — 删除 `rules` / `fallbackAgent` / `reviewAgent` / `relationLabels` / `initialTasks`
- `apps/server/public/app.js` — HR 卡片显示重试状态;失败时显示重试按钮;处理 503 响应
- `apps/server/public/war-room.js` — (如有 HR 状态显示)同步重试文案

### 删除
- `apps/server/src/team-planning.ts`
- `apps/server/src/team-planning.test.ts`
- `apps/server/src/hr-activation.ts`

---

## 阶段 1: 加重试(纯加法)

### Task 1.1: 创建重试工具 `retry.ts` + 单测

**Files:**
- Create: `apps/server/src/retry.ts`
- Create: `apps/server/src/retry.test.ts`

- [ ] **Step 1: 写测试 `retry.test.ts` — 描述完整重试行为**

创建 `apps/server/src/retry.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { withRetry } from "./retry.js";

describe("withRetry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns result on first success without waiting", async () => {
    const fn = vi.fn().mockResolvedValue("success");

    const promise = withRetry(fn, { maxAttempts: 4, delaysMs: [1000, 2000, 4000] });
    const result = await promise;

    expect(result).toBe("success");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on failure and returns result when eventual attempt succeeds", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("fail 1"))
      .mockRejectedValueOnce(new Error("fail 2"))
      .mockResolvedValueOnce("success");

    const promise = withRetry(fn, { maxAttempts: 4, delaysMs: [1000, 2000, 4000] });
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(2000);
    const result = await promise;

    expect(result).toBe("success");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("throws the last error when all attempts fail", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("always fails"));

    const promise = withRetry(fn, { maxAttempts: 4, delaysMs: [1000, 2000, 4000] });
    const expectation = expect(promise).rejects.toThrow("always fails");

    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(4000);
    await expectation;

    expect(fn).toHaveBeenCalledTimes(4);
  });

  it("waits the specified delays between attempts", async () => {
    const callTimestamps: number[] = [];
    const fn = vi.fn().mockImplementation(async () => {
      callTimestamps.push(Date.now());
      throw new Error("fail");
    });

    const promise = withRetry(fn, { maxAttempts: 4, delaysMs: [1000, 2000, 4000] });
    promise.catch(() => undefined);

    await vi.advanceTimersByTimeAsync(0);
    expect(fn).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(fn).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(2000);
    expect(fn).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(4000);
    expect(fn).toHaveBeenCalledTimes(4);

    await expect(promise).rejects.toThrow("fail");
  });

  it("calls onRetry callback before each retry with attempt number", async () => {
    const onRetry = vi.fn();
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("fail 1"))
      .mockResolvedValueOnce("success");

    const promise = withRetry(fn, {
      maxAttempts: 4,
      delaysMs: [1000, 2000, 4000],
      onRetry,
    });
    await vi.advanceTimersByTimeAsync(1000);
    await promise;

    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith({ attempt: 1, error: expect.any(Error), nextDelayMs: 1000 });
  });
});
```

- [ ] **Step 2: 运行测试,确认全部失败**

Run: `pnpm --filter @digitalagent/server vitest run src/retry.test.ts`
Expected: 5 个测试全部 FAIL,错误信息包含 `Cannot find module './retry.js'`

- [ ] **Step 3: 实现 `retry.ts` 通过测试**

创建 `apps/server/src/retry.ts`:

```typescript
export interface RetryOptions {
  maxAttempts: number;
  delaysMs: number[];
  onRetry?: (info: { attempt: number; error: unknown; nextDelayMs: number }) => void;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt < options.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const isLastAttempt = attempt === options.maxAttempts - 1;
      if (isLastAttempt) {
        break;
      }
      const delayMs = options.delaysMs[attempt] ?? 0;
      options.onRetry?.({ attempt: attempt + 1, error, nextDelayMs: delayMs });
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw lastError;
}
```

- [ ] **Step 4: 运行测试,确认全部通过**

Run: `pnpm --filter @digitalagent/server vitest run src/retry.test.ts`
Expected: 5 个测试全部 PASS

- [ ] **Step 5: 提交**

```bash
git add apps/server/src/retry.ts apps/server/src/retry.test.ts
git commit -m "feat(retry): add generic withRetry utility with exponential backoff"
```

---

### Task 1.2: 移除 `hr-agent.ts:analyzeAndPlan` 内部 fallback

**Files:**
- Modify: `apps/server/src/hr-agent.ts:152-201`
- Modify: `apps/server/src/hr-agent.test.ts` (调整依赖 fallback 的测试)

- [ ] **Step 1: 读现状,确认要删的代码段**

Run: `grep -n "analyzeAndPlan failed, using fallback" /Users/zexho/Documents/DigitalAgent/apps/server/src/hr-agent.ts`
Expected: 输出 `188:        "[HR Agent] analyzeAndPlan failed, using fallback:",`

- [ ] **Step 2: 修改 `hr-agent.ts:152-201`,移除 try-catch**

把 `analyzeAndPlan` 函数从:

```typescript
async function analyzeAndPlan(
  missionId: string,
  brief: MissionBrief,
): Promise<{ analysis: MissionAnalysis; roleSpecs: RoleSpec[] }> {
  const systemPrompt = buildHRAgentSystemPrompt();
  const userPrompt = buildAnalyzeAndPlanPrompt(brief);

  try {
    const content = await llmCallStream([
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ]);

    const json = extractJson(content, "object");
    if (!json) {
      throw new Error("No JSON object found in analyzeAndPlan response");
    }
    const parsed = JSON.parse(json) as {
      analysis?: unknown;
      roleSpecs?: unknown;
    };

    const analysis = buildAnalysis(parsed.analysis, brief);
    const roleSpecs = buildRoleSpecsFromArray(parsed.roleSpecs, missionId);
    if (roleSpecs.length === 0) {
      throw new Error("analyzeAndPlan response contained no valid roleSpecs");
    }
    for (const spec of roleSpecs) {
      const validation = validateRoleSpec(spec);
      if (!validation.isValid) {
        throw new Error(`Invalid role spec ${spec.name}: ${validation.errors.join(", ")}`);
      }
    }

    return { analysis, roleSpecs };
  } catch (error) {
    console.error(
      "[HR Agent] analyzeAndPlan failed, using fallback:",
      error instanceof Error ? error.message : String(error),
    );
    const fallbackAnalysis: MissionAnalysis = {
      ...fallbackMissionAnalysis(brief),
      missionGoal: brief.goal,
    };
    return {
      analysis: fallbackAnalysis,
      roleSpecs: fallbackRoleSpecs(missionId, fallbackAnalysis),
    };
  }
}
```

改为(去掉 try-catch,让错误向上抛):

```typescript
async function analyzeAndPlan(
  missionId: string,
  brief: MissionBrief,
): Promise<{ analysis: MissionAnalysis; roleSpecs: RoleSpec[] }> {
  const systemPrompt = buildHRAgentSystemPrompt();
  const userPrompt = buildAnalyzeAndPlanPrompt(brief);

  const content = await llmCallStream([
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ]);

  const json = extractJson(content, "object");
  if (!json) {
    throw new Error("No JSON object found in analyzeAndPlan response");
  }
  const parsed = JSON.parse(json) as {
    analysis?: unknown;
    roleSpecs?: unknown;
  };

  const analysis = buildAnalysis(parsed.analysis, brief);
  const roleSpecs = buildRoleSpecsFromArray(parsed.roleSpecs, missionId);
  if (roleSpecs.length === 0) {
    throw new Error("analyzeAndPlan response contained no valid roleSpecs");
  }
  for (const spec of roleSpecs) {
    const validation = validateRoleSpec(spec);
    if (!validation.isValid) {
      throw new Error(`Invalid role spec ${spec.name}: ${validation.errors.join(", ")}`);
    }
  }

  return { analysis, roleSpecs };
}
```

- [ ] **Step 3: 检查 `hr-agent.test.ts` 中是否有依赖内部 fallback 的测试**

Run: `grep -n "fallback\|analyzeAndPlan" /Users/zexho/Documents/DigitalAgent/apps/server/src/hr-agent.test.ts`

- [ ] **Step 4: 改造任何依赖内部 fallback 的测试**

如果存在 `it("uses fallback when LLM fails")` 这类测试,改为期望抛错:

把(示例)
```typescript
it("uses fallback when LLM fails", async () => {
  // ... mock LLM throwing
  const result = await hrAgent.analyzeAndPlan(...);
  expect(result.analysis.priorityRoles).toEqual(["generalist"]);
});
```

改为:
```typescript
it("throws when LLM fails", async () => {
  // ... mock LLM throwing
  await expect(hrAgent.analyzeAndPlan(...)).rejects.toThrow();
});
```

如果 grep 没找到 `analyzeAndPlan` 相关的 fallback 断言,跳过此步。

- [ ] **Step 5: 运行 hr-agent 测试,确认通过**

Run: `pnpm --filter @digitalagent/server vitest run src/hr-agent.test.ts`
Expected: 全部 PASS

- [ ] **Step 6: 运行所有相关测试,确认其他模块没破坏**

Run: `pnpm --filter @digitalagent/server vitest run src/negotiation-manager.test.ts src/mission-service.test.ts`
Expected: 全部 PASS — 因为 `mission-service.ts:833` 仍有外层 fallback,内部 fallback 移除后行为对外不变

- [ ] **Step 7: 提交**

```bash
git add apps/server/src/hr-agent.ts apps/server/src/hr-agent.test.ts
git commit -m "refactor(hr-agent): remove internal fallback in analyzeAndPlan, errors now propagate"
```

---

### Task 1.3: 在 `negotiation-manager.ts:startNegotiation` 中加重试 + 测试

**Files:**
- Modify: `apps/server/src/negotiation-manager.ts:72-128`
- Modify: `apps/server/src/negotiation-manager.test.ts`

- [ ] **Step 1: 写重试测试 — 第一个 it 块测"前 2 次失败、第 3 次成功"**

在 `apps/server/src/negotiation-manager.test.ts` 的 `describe("startNegotiation", () => {` 块内末尾,添加:

```typescript
it("retries analyzeAndPlan up to 3 times on transient LLM failures", async () => {
  const deps = makeTestDeps();
  let callCount = 0;
  deps.llm.call = async (_messages, options) => {
    callCount += 1;
    if (callCount <= 2) {
      throw new Error(`transient failure ${callCount}`);
    }
    const content = JSON.stringify({
      analysis: {
        requiredCapabilities: ["data_analysis"],
        estimatedTeamSize: 2,
        priorityRoles: ["data_analyst"],
        complexity: "medium",
        riskFactors: [],
      },
      roleSpecs: [{
        name: "Analyst",
        purpose: "Analyze",
        responsibilities: ["work"],
        allowedTools: ["web_search"],
        successCriteria: ["done"],
        budget: { maxRuntimeMinutes: 60, maxTasks: 3 },
      }],
    });
    if (options?.onStream) {
      for (const ch of content) options.onStream(ch);
    }
    return { content, model: "test", usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, finishReason: "stop" };
  };

  const mission = makeMissionWithBrief();
  deps.missions.set(mission.id, mission);
  const ownerAgent: WarRoomAgent = {
    id: "owner-1",
    missionId: mission.id,
    role: "owner",
    name: "Owner",
    responsibility: "owner",
    status: "idle",
    currentTaskId: undefined,
    lastAction: "",
    avatarSeed: "owner",
    sortOrder: 0,
  };
  deps.agents.set(ownerAgent.id, ownerAgent);

  const manager = new NegotiationManager(deps);
  const proposal = await manager.startNegotiation({ missionId: mission.id }, mission);

  expect(proposal.roles).toHaveLength(1);
  expect(callCount).toBe(3);
});
```

- [ ] **Step 2: 写第二个测试 — "所有重试失败时抛错并把 HR 状态置 failed"**

继续添加:

```typescript
it("throws after exhausting retries and marks HR agent as failed", async () => {
  const deps = makeTestDeps();
  deps.llm.call = async () => {
    throw new Error("permanent failure");
  };

  const mission = makeMissionWithBrief();
  deps.missions.set(mission.id, mission);
  const ownerAgent: WarRoomAgent = {
    id: "owner-2",
    missionId: mission.id,
    role: "owner",
    name: "Owner",
    responsibility: "owner",
    status: "idle",
    currentTaskId: undefined,
    lastAction: "",
    avatarSeed: "owner",
    sortOrder: 0,
  };
  deps.agents.set(ownerAgent.id, ownerAgent);

  const manager = new NegotiationManager(deps);
  await expect(manager.startNegotiation({ missionId: mission.id }, mission))
    .rejects.toThrow("permanent failure");

  const hrAgents = [...deps.agents.values()].filter((a) => a.role === "hr");
  expect(hrAgents).toHaveLength(1);
  expect(hrAgents[0].status).toBe("failed");
  expect(hrAgents[0].lastAction).toContain("招募失败");
});
```

- [ ] **Step 3: 运行测试,确认两个新测试都失败**

Run: `pnpm --filter @digitalagent/server vitest run src/negotiation-manager.test.ts -t "retries analyzeAndPlan"`
Expected: FAIL (重试逻辑还没加)

Run: `pnpm --filter @digitalagent/server vitest run src/negotiation-manager.test.ts -t "marks HR agent as failed"`
Expected: FAIL

- [ ] **Step 4: 在 `negotiation-manager.ts` 加重试常量与导入**

文件顶部 import 区加:

```typescript
import { withRetry } from "./retry.js";
```

在 `NegotiationManager` 类定义之前(line 47 附近)加常量:

```typescript
const HR_RETRY_DELAYS_MS = [1000, 2000, 4000];
const HR_MAX_ATTEMPTS = 4; // 1 initial + 3 retries
```

- [ ] **Step 5: 修改 `startNegotiation` 包重试逻辑**

把 `startNegotiation` 中 line 82-97 的:

```typescript
const stream = this.startHrStream(mission.id, "analyzing");
let proposal: TeamProposal;
try {
  const hrAgent = createHRAgent({
    llm: this.llm,
    ...(stream.onToken === undefined ? {} : { onToken: stream.onToken }),
  });
  const { analysis, roleSpecs } = await hrAgent.analyzeAndPlan(mission.id, mission.brief);
  this.appendMessage({
    missionId: mission.id,
    fromAgentId: hrAgentId,
    type: "agent_notify",
    content: `HR 已完成 MissionBrief 分析并生成 ${roleSpecs.length} 个角色规格(共 ${analysis.estimatedTeamSize} 个核心角色,复杂度 ${analysis.complexity}),正在整理团队提案。`,
  });
  proposal = await hrAgent.proposeTeam(mission.id, roleSpecs, mission.brief);
} finally {
  stream.done();
}
```

改为:

```typescript
const stream = this.startHrStream(mission.id, "analyzing");
let proposal: TeamProposal;
try {
  const hrAgent = createHRAgent({
    llm: this.llm,
    ...(stream.onToken === undefined ? {} : { onToken: stream.onToken }),
  });
  try {
    const { analysis, roleSpecs } = await withRetry(
      () => hrAgent.analyzeAndPlan(mission.id, mission.brief!),
      {
        maxAttempts: HR_MAX_ATTEMPTS,
        delaysMs: HR_RETRY_DELAYS_MS,
        onRetry: ({ attempt }) => {
          this.agents.set(hrAgentId, {
            ...this.agents.get(hrAgentId)!,
            status: "running",
            lastAction: `第 ${attempt} 次重试中...`,
          });
        },
      },
    );
    this.appendMessage({
      missionId: mission.id,
      fromAgentId: hrAgentId,
      type: "agent_notify",
      content: `HR 已完成 MissionBrief 分析并生成 ${roleSpecs.length} 个角色规格(共 ${analysis.estimatedTeamSize} 个核心角色,复杂度 ${analysis.complexity}),正在整理团队提案。`,
    });
    proposal = await hrAgent.proposeTeam(mission.id, roleSpecs, mission.brief);
  } catch (error) {
    const current = this.agents.get(hrAgentId);
    if (current) {
      this.agents.set(hrAgentId, {
        ...current,
        status: "failed",
        lastAction: "招募失败 (3 次重试均失败)",
      });
    }
    throw error;
  }
} finally {
  stream.done();
}
```

- [ ] **Step 6: 更新 `WarRoomAgent` 类型的 status 联合(如果 `failed` 不在已有类型里)**

Run: `grep -n "type WarRoomAgent\|status:" /Users/zexho/Documents/DigitalAgent/apps/server/src/mission-service.ts | head -20`

找到 `WarRoomAgent` 接口定义,检查 `status` 字段。如果 `"failed"` 不在联合里,加上。

例如把:
```typescript
status: "idle" | "running" | "thinking" | "done";
```
改为:
```typescript
status: "idle" | "running" | "thinking" | "done" | "failed";
```

并 grep 检查所有使用 `status:` 的位置不需要其他改动。

- [ ] **Step 7: 运行新测试,确认通过**

Run: `pnpm --filter @digitalagent/server vitest run src/negotiation-manager.test.ts`
Expected: 全部 PASS,包含新加的两个测试

- [ ] **Step 8: 运行全部测试,确认无回归**

Run: `pnpm --filter @digitalagent/server test`
Expected: 全绿

- [ ] **Step 9: 运行 typecheck**

Run: `pnpm --filter @digitalagent/server typecheck`
Expected: 无错误

- [ ] **Step 10: 提交**

```bash
git add apps/server/src/negotiation-manager.ts apps/server/src/negotiation-manager.test.ts apps/server/src/mission-service.ts
git commit -m "feat(hr): add retry logic with exponential backoff to HR analyzeAndPlan"
```

---

## 阶段 2: 拆 fallback(行为变化)

### Task 2.1: 删除 `mission-service.ts:activateMissionWithHR` 的 catch fallback

**Files:**
- Modify: `apps/server/src/mission-service.ts:806-836`
- Modify: `apps/server/src/mission-service.test.ts`

- [ ] **Step 1: 先写一个测试,验证 LLM 错误时不再走 fallback**

在 `apps/server/src/mission-service.test.ts` 中找到 `describe("activateMissionWithHR"`(如不存在则在末尾添加一个 describe 块),添加测试:

```typescript
it("does not fall back to keyword path when HR retries exhaust", async () => {
  const service = createServiceWithBrief({
    llm: {
      call: async () => {
        throw new Error("LLM unavailable");
      },
      stats: () => ({ totalCalls: 0, totalPromptTokens: 0, totalCompletionTokens: 0 }),
    },
  });
  const mission = await service.createMission({
    goal: "Grow Xiaohongshu followers",
    successMetrics: ["1000 followers"],
    constraints: [],
  });
  // ... set brief on the mission via the service's owner agent flow
  await service.confirmBrief({ missionId: mission.id });

  await expect(service.activateMissionWithHR({ missionId: mission.id }))
    .rejects.toThrow("LLM unavailable");

  // Verify no agents from keyword path were created
  const agents = service.listAgents(mission.id);
  const nonHrAgents = agents.filter((a) => a.role !== "owner" && a.role !== "hr");
  expect(nonHrAgents).toEqual([]);
});
```

> **注意:** 此测试需要先准备好 `createServiceWithBrief` 工厂(可能已存在)。如果不存在,在文件顶部添加一个简化版,模仿现有的 service 初始化模式。

- [ ] **Step 2: 运行测试,确认失败**

Run: `pnpm --filter @digitalagent/server vitest run src/mission-service.test.ts -t "does not fall back to keyword"`
Expected: FAIL — 当前 catch 会静默 fallback 到 `activateMission`,导致测试期望的 rejects 不发生

- [ ] **Step 3: 修改 `mission-service.ts:806-836`,删除 catch fallback**

把:

```typescript
async activateMissionWithHR(input: ActivateMissionRequest): Promise<Mission> {
  const mission = this.missions.get(input.missionId);
  if (!mission) {
    throw new Error(`Mission not found: ${input.missionId}`);
  }
  this.assertMissionPlanReadyForActivation(mission.id);
  const existingTask = [...this.tasks.values()].find((task) => task.missionId === mission.id);
  if (existingTask) {
    return mission;
  }

  if (!this.llm || !mission.brief) {
    return this.activateMission(input);
  }

  try {
    await this.getNegotiationManager().startNegotiation(input, mission);

    const owner = this.agentByRole(mission.id, "owner");
    this.updateAgent(owner.id, {
      status: "idle",
      lastAction: "Reviewing HR team proposal",
    });

    this.persist();
    return this.missions.get(mission.id)!;
  } catch (error) {
    console.error("[MissionService] HR-based activation failed, falling back to keyword:", error instanceof Error ? error.message : String(error));
    return this.activateMission(input);
  }
}
```

改为(移除 catch 中的 fallback,改为重新抛出 + 持久化失败状态):

```typescript
async activateMissionWithHR(input: ActivateMissionRequest): Promise<Mission> {
  const mission = this.missions.get(input.missionId);
  if (!mission) {
    throw new Error(`Mission not found: ${input.missionId}`);
  }
  this.assertMissionPlanReadyForActivation(mission.id);
  const existingTask = [...this.tasks.values()].find((task) => task.missionId === mission.id);
  if (existingTask) {
    return mission;
  }

  if (!this.llm || !mission.brief) {
    throw new Error("HR activation requires LLM service and mission brief");
  }

  try {
    await this.getNegotiationManager().startNegotiation(input, mission);

    const owner = this.agentByRole(mission.id, "owner");
    this.updateAgent(owner.id, {
      status: "idle",
      lastAction: "Reviewing HR team proposal",
    });

    this.persist();
    return this.missions.get(mission.id)!;
  } catch (error) {
    this.persist();
    throw error;
  }
}
```

- [ ] **Step 4: 运行新测试,确认通过**

Run: `pnpm --filter @digitalagent/server vitest run src/mission-service.test.ts -t "does not fall back to keyword"`
Expected: PASS

- [ ] **Step 5: 运行全部 mission-service 测试,处理回归**

Run: `pnpm --filter @digitalagent/server vitest run src/mission-service.test.ts`
Expected: 可能有依赖旧 fallback 行为的测试失败。逐个修复:
- 如果测试是"LLM 失败时应该走关键词 fallback",改为"LLM 失败时应该抛错"
- 如果测试用了 `if (!this.llm)` 的隐式 fallback,改为显式提供 LLM mock

- [ ] **Step 6: 提交**

```bash
git add apps/server/src/mission-service.ts apps/server/src/mission-service.test.ts
git commit -m "fix(hr): remove silent fallback to keyword path when LLM HR fails"
```

---

### Task 2.2: API 层把 HR 失败转成 503 + `Retry-After`

**Files:**
- Modify: `apps/server/src/api.ts` (找到 `/missions/:id/activate` 路由)
- Modify: `apps/server/src/api.test.ts`

- [ ] **Step 1: 定位 activate 路由处理**

Run: `grep -n "activate\|activateMissionWithHR" /Users/zexho/Documents/DigitalAgent/apps/server/src/api.ts`
Expected: 找到处理 `/activate` 路径的位置(行号需要记录)

- [ ] **Step 2: 写测试 — `/activate` 在 HR 失败时返回 503**

在 `apps/server/src/api.test.ts` 末尾添加:

```typescript
it("returns 503 with Retry-After when HR activation fails", async () => {
  const failingLlm: LlmService = {
    call: async () => { throw new Error("LLM down"); },
    stats: () => ({ totalCalls: 0, totalPromptTokens: 0, totalCompletionTokens: 0 }),
  };
  const missions = new InMemoryMissionService({ llm: failingLlm, config: testConfig });

  // Create + confirm a mission with brief
  const mission = await missions.createMission({
    goal: "Test mission",
    successMetrics: ["done"],
    constraints: [],
  });
  // ... ensure brief is set (use existing test helper or service method)
  await missions.confirmBrief({ missionId: mission.id });

  const response = await handleApiRequest(
    {
      method: "POST",
      url: `/api/missions/${mission.id}/activate`,
      headers: {},
      body: "",
    },
    { missions },
  );

  expect(response.status).toBe(503);
  expect(response.headers["Retry-After"]).toBe("5");
});
```

> **注意:** `testConfig` 和 `InMemoryMissionService` 的初始化需对照现有测试模式。如有现成的 helper 函数(如 `makeTestService`),复用之。

- [ ] **Step 3: 运行测试,确认失败**

Run: `pnpm --filter @digitalagent/server vitest run src/api.test.ts -t "returns 503"`
Expected: FAIL — 当前 activate 路径会把错误转成 500 而不是 503

- [ ] **Step 4: 修改 `api.ts` 中的 activate 路径**

找到 activate 路由(根据 Step 1 的 grep 结果),在 try-catch 中:

把(示例,具体行号根据实际为准):

```typescript
try {
  const mission = await deps.missions.activateMissionWithHR({ missionId });
  return { status: 200, headers: {}, body: JSON.stringify({ mission }) };
} catch (error) {
  return { status: 500, headers: {}, body: JSON.stringify({ error: errorMessage(error) }) };
}
```

改为:

```typescript
try {
  const mission = await deps.missions.activateMissionWithHR({ missionId });
  return { status: 200, headers: {}, body: JSON.stringify({ mission }) };
} catch (error) {
  return {
    status: 503,
    headers: { "Retry-After": "5", "Content-Type": "application/json" },
    body: JSON.stringify({
      error: errorMessage(error),
      retryable: true,
      message: "HR 招募失败,请点击重试",
    }),
  };
}
```

- [ ] **Step 5: 运行测试,确认通过**

Run: `pnpm --filter @digitalagent/server vitest run src/api.test.ts -t "returns 503"`
Expected: PASS

- [ ] **Step 6: 运行全部 api 测试**

Run: `pnpm --filter @digitalagent/server vitest run src/api.test.ts`
Expected: 全绿

- [ ] **Step 7: 提交**

```bash
git add apps/server/src/api.ts apps/server/src/api.test.ts
git commit -m "feat(api): return 503 with Retry-After when HR activation fails"
```

---

## 阶段 3: 删除死代码(机械清理)

### Task 3.1: 把 `matcherFor` 从 team-planning.ts 内联到 mission-service.ts

**Files:**
- Modify: `apps/server/src/mission-service.ts:44` (改 import) + `:3367-3377`(改 firstAgentWithCapability)

- [ ] **Step 1: 读取 team-planning.ts 中 matcherFor 与 escapeRegExp 的实现**

Run: `grep -A 5 "function matcherFor\|function escapeRegExp" /Users/zexho/Documents/DigitalAgent/apps/server/src/team-planning.ts`

记录两个函数的完整代码:

```typescript
export function matcherFor(parts: string[]): RegExp {
  return new RegExp(parts.map(escapeRegExp).join("|"), "i");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
```

- [ ] **Step 2: 修改 `mission-service.ts` 的 import (line 44)**

把:

```typescript
import { planMissionTeam, matcherFor, type MissionTeamPlan } from "./team-planning.js";
```

改为(只移除 team-planning 导入):

```typescript
// (整行删除)
```

然后在 `firstAgentWithCapability` 方法之前(或文件末尾的 helper 函数区)添加:

```typescript
function matcherFor(parts: string[]): RegExp {
  return new RegExp(parts.map(escapeRegExp).join("|"), "i");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
```

(放在 InMemoryMissionService class 外部作为模块级函数。)

- [ ] **Step 3: 删除 mission-service.ts 中所有对 `planMissionTeam` 和 `MissionTeamPlan` 的使用**

Run: `grep -n "planMissionTeam\|MissionTeamPlan" /Users/zexho/Documents/DigitalAgent/apps/server/src/mission-service.ts`

定位到 `activateMission()` 方法(line 725-771)。整个方法都依赖 `planMissionTeam`,所以整段都将在 Task 3.2 删除 — 这里先不动。

- [ ] **Step 4: 暂时跳过编译,直接到 Task 3.2**

(此 task 不做编译检查,因为下一 task 会继续修改同一文件)

---

### Task 3.2: 删除 `team-planning.ts` 和 `team-planning.test.ts`,删除老 `activateMission`,重命名 `activateMissionWithHR`

**Files:**
- Delete: `apps/server/src/team-planning.ts`
- Delete: `apps/server/src/team-planning.test.ts`
- Modify: `apps/server/src/mission-service.ts:725-771` (删老 activateMission) + `:806-836` (重命名)

- [ ] **Step 1: 删 `team-planning.ts` 和测试**

```bash
rm apps/server/src/team-planning.ts apps/server/src/team-planning.test.ts
```

- [ ] **Step 2: 删除 `mission-service.ts:725-771` 的整个 `activateMission()` 方法**

定位 line 725-771(关键词版 activateMission),整段删除。

```typescript
// 删除这一段:
activateMission(input: ActivateMissionRequest): Mission {
  const mission = this.missions.get(input.missionId);
  if (!mission) {
    throw new Error(`Mission not found: ${input.missionId}`);
  }
  const existingTask = [...this.tasks.values()].find((task) => task.missionId === mission.id);
  if (existingTask) {
    return mission;
  }

  const teamPlan = planMissionTeam(mission.goal, this.config);
  // ... 整段 (大约 47 行)
}
```

- [ ] **Step 3: 重命名 `activateMissionWithHR` 为 `activateMission`**

把:

```typescript
async activateMissionWithHR(input: ActivateMissionRequest): Promise<Mission> {
```

改为:

```typescript
async activateMission(input: ActivateMissionRequest): Promise<Mission> {
```

- [ ] **Step 4: grep + 修复所有 `activateMissionWithHR` 调用方**

Run: `grep -rn "activateMissionWithHR" /Users/zexho/Documents/DigitalAgent/apps/server/src --include="*.ts"`

对每个匹配,把 `activateMissionWithHR` 改为 `activateMission`。

主要影响:
- `api.ts` — 处理 activate 路由的位置
- `mission-service.test.ts` — 任何测试调用

- [ ] **Step 5: 检查 `createMissionTeam` 是否仍被调用**

Run: `grep -n "createMissionTeam" /Users/zexho/Documents/DigitalAgent/apps/server/src/mission-service.ts`

如果 `createMissionTeam` 这个 private 方法只在已删除的 `activateMission` 中被调用,删除该方法定义。

- [ ] **Step 6: 编译检查 + 跑测试,修复任何破损**

Run: `pnpm --filter @digitalagent/server typecheck`
Expected: 无错误

Run: `pnpm --filter @digitalagent/server test`
Expected: 全绿(可能需要删除几个依赖关键词路径的旧测试)

如有失败:
- 测试调用 `service.activateMission()` 期望走关键词路径 → 删除该测试或改为 LLM 路径
- import 引用了 `team-planning.js` → 删除该 import

- [ ] **Step 7: 提交**

```bash
git add apps/server/src/mission-service.ts apps/server/src/api.ts apps/server/src/mission-service.test.ts apps/server/src/api.test.ts
git rm apps/server/src/team-planning.ts apps/server/src/team-planning.test.ts
git commit -m "refactor: delete team-planning keyword path, rename activateMissionWithHR to activateMission"
```

---

### Task 3.3: 删除 `hr-activation.ts`

**Files:**
- Delete: `apps/server/src/hr-activation.ts`

- [ ] **Step 1: 确认无生产代码引用**

Run: `grep -rn "hr-activation\|activateWithHRAgent" /Users/zexho/Documents/DigitalAgent/apps/server/src --include="*.ts" | grep -v ".test.ts"`
Expected: 无输出(仅测试可能有引用,或完全无引用)

- [ ] **Step 2: 检查测试是否引用**

Run: `grep -rn "hr-activation\|activateWithHRAgent" /Users/zexho/Documents/DigitalAgent/apps/server/src --include="*.ts"`

如果有测试文件引用 `hr-activation`,记录文件路径。

- [ ] **Step 3: 删除文件 + 删除/更新引用的测试**

```bash
rm apps/server/src/hr-activation.ts
```

如有测试引用,删除对应测试文件或在测试中删除引用 `hr-activation` 的部分。

- [ ] **Step 4: 编译 + 测试**

Run: `pnpm --filter @digitalagent/server typecheck && pnpm --filter @digitalagent/server test`
Expected: 全绿

- [ ] **Step 5: 提交**

```bash
git rm apps/server/src/hr-activation.ts
git commit -m "refactor: delete unused hr-activation.ts (duplicate LLM HR entry)"
```

---

### Task 3.4: 清理 `agent-system.json` + 同步 `system-config.ts` 类型

**Files:**
- Modify: `apps/server/config/agent-system.json`
- Modify: `apps/server/src/system-config.ts`

- [ ] **Step 1: 编辑 `apps/server/config/agent-system.json`**

把 `teamPlanner` 对象内删除以下字段:
- `rules` (整个数组)
- `fallbackAgent`
- `reviewAgent`
- `relationLabels`
- `initialTasks`

保留:
- `baseAgents` (owner, hr 两个对象)
- `capabilityMatchers` (被 firstAgentWithCapability 使用)

删除后 `teamPlanner` 应该长这样:

```json
"teamPlanner": {
  "baseAgents": [
    {
      "role": "owner",
      "name": "Owner Agent",
      ...
    },
    {
      "role": "hr",
      "name": "HR Agent",
      ...
    }
  ],
  "capabilityMatchers": {
    "plan": ["planner", "strategist", "research", "analyst", "architect"],
    "execute": ["worker", "creator", "browser", "image", "content", "engineer", "operator", "producer", "research"],
    "review": ["review", "qa", "critic", "editor", "quality"]
  }
}
```

- [ ] **Step 2: 修改 `system-config.ts` 的 `AgentSystemConfig` 类型**

Run: `grep -n "teamPlanner\|interface AgentSystemConfig\|rules\|fallbackAgent\|reviewAgent\|relationLabels\|initialTasks" /Users/zexho/Documents/DigitalAgent/apps/server/src/system-config.ts`

定位到 `teamPlanner` 的类型定义,删除以下字段:
- `rules: ...`
- `fallbackAgent: ...`
- `reviewAgent: ...`
- `relationLabels: ...`
- `initialTasks: ...`

只保留 `baseAgents` 和 `capabilityMatchers`。

- [ ] **Step 3: 修改 `loadAgentSystemConfig` 的校验逻辑**

Run: `grep -n "rules is required\|fallbackAgent is required\|reviewAgent\|relationLabels\|initialTasks" /Users/zexho/Documents/DigitalAgent/apps/server/src/system-config.ts`

删除对应的 `if (!config.teamPlanner.X) throw...` 校验行。

- [ ] **Step 4: grep 全工程,处理被砍字段的引用**

```bash
cd /Users/zexho/Documents/DigitalAgent
grep -rn "teamPlanner.rules\|teamPlanner.fallbackAgent\|teamPlanner.reviewAgent\|teamPlanner.relationLabels\|teamPlanner.initialTasks" apps/server/src --include="*.ts"
```

对每个匹配:
- 若在测试中: 删除该测试或简化为不依赖这些字段
- 若在生产代码中: 应该不存在(本次改造已经删了主要消费者),如果有遗漏,删除引用

- [ ] **Step 5: 编译 + 测试**

Run: `pnpm --filter @digitalagent/server typecheck`
Expected: 无错误

Run: `pnpm --filter @digitalagent/server test`
Expected: 全绿

- [ ] **Step 6: 提交**

```bash
git add apps/server/config/agent-system.json apps/server/src/system-config.ts
# 加上可能也被改的测试文件
git add apps/server/src/
git commit -m "refactor(config): remove keyword rules and fallback config from agent-system.json"
```

---

### Task 3.5: 全工程验证 — 阶段 3 收尾

- [ ] **Step 1: grep 验证关键词路径全无残留**

```bash
cd /Users/zexho/Documents/DigitalAgent
grep -rn "planMissionTeam\|team-planning" apps/server packages --include="*.ts" --include="*.json"
```
Expected: 无输出

```bash
grep -rn "activateMissionWithHR\|hr-activation" apps/server packages --include="*.ts" --include="*.json"
```
Expected: 无输出

```bash
grep -rn "MissionTeamPlan" apps/server packages --include="*.ts"
```
Expected: 无输出

- [ ] **Step 2: 完整跑一次构建 + 测试**

Run:
```bash
pnpm build && pnpm test
```
Expected: 全部通过

- [ ] **Step 3: 检查 git status,确认没有遗漏文件**

Run: `git status`
Expected: 工作树干净(除了你阶段 3 前就存在的未跟踪文件)

如有未提交的相关改动,合到上一个 commit 或新加 commit。

---

## 阶段 4: UI/UX 提示(前端)

### Task 4.1: HR Agent 卡片显示重试状态

**Files:**
- Modify: `apps/server/public/app.js` 或 `apps/server/public/war-room.js`(根据 HR 卡片渲染位置)

- [ ] **Step 1: 定位 HR Agent 卡片渲染逻辑**

Run: `grep -n "HR Agent\|lastAction\|招募中" /Users/zexho/Documents/DigitalAgent/apps/server/public/*.js`
Expected: 找到渲染 HR 卡片 / lastAction 字段的代码位置

- [ ] **Step 2: 修改卡片渲染,显示 `lastAction` 中的"第 N 次重试中"**

如果当前已经显示 `lastAction`,则不需改;只需确认后端流出来的字符串能正确传到前端。

如果当前未显示,在 HR 卡片 DOM 中加一个状态文案区:

```javascript
const hrCard = `
  <div class="agent-card hr-card">
    <strong>HR Agent</strong>
    <p class="hr-status">${escapeHtml(agent.lastAction)}</p>
  </div>
`;
```

- [ ] **Step 3: 启动 dev server 手动验证**

```bash
pnpm dev
```

打开浏览器 → 创建一个 mission → 在网络请求中拦截 LLM 调用模拟失败(可借助浏览器开发者工具的 network 条件失败,或临时改 LLM mock)。

预期看到:
- HR 卡片显示"正在分析 MissionBrief..."
- 失败后显示"第 1 次重试中..." → "第 2 次重试中..." → "第 3 次重试中..."
- 最终失败显示"招募失败 (3 次重试均失败)"

如果实际看不到中间状态,说明 stream 事件没正确推送 — 检查 `negotiation-manager.ts` 的 `onRetry` 回调是否触发了 stream 推送。

---

### Task 4.2: HR 失败时显示重试按钮 + 处理 503 响应

**Files:**
- Modify: `apps/server/public/app.js`(或对应 HR 卡片所在文件)

- [ ] **Step 1: 定位 activate 接口调用位置**

Run: `grep -n "fetch.*activate\|/activate" /Users/zexho/Documents/DigitalAgent/apps/server/public/*.js`

- [ ] **Step 2: 修改 fetch 调用,处理 503 响应**

把(示例):

```javascript
const response = await fetch(`/api/missions/${missionId}/activate`, { method: "POST" });
if (!response.ok) {
  alert("激活失败");
  return;
}
```

改为:

```javascript
const response = await fetch(`/api/missions/${missionId}/activate`, { method: "POST" });
if (response.status === 503) {
  const body = await response.json();
  showHrFailureUi(missionId, body.message ?? "HR 招募失败");
  return;
}
if (!response.ok) {
  alert("激活失败");
  return;
}
```

并实现 `showHrFailureUi`:

```javascript
function showHrFailureUi(missionId, message) {
  const hrCard = document.querySelector(`[data-mission-id="${missionId}"] .hr-card`);
  if (!hrCard) return;
  hrCard.innerHTML = `
    <strong>HR Agent</strong>
    <p class="hr-status hr-failed">${escapeHtml(message)}</p>
    <button type="button" data-retry-activate="${missionId}">重试招募</button>
  `;
  hrCard.querySelector("[data-retry-activate]").addEventListener("click", () => {
    void activateMission(missionId);
  });
}
```

(`activateMission` 是已有的前端函数,根据实际代码命名调整。)

- [ ] **Step 3: 添加少量 CSS — 失败状态视觉提示**

如有 `styles.css`,在文件末尾添加:

```css
.hr-status.hr-failed {
  color: #c0392b;
}

.hr-card button[data-retry-activate] {
  margin-top: 4px;
  padding: 4px 12px;
  background: #fff;
  border: 1px solid #c0392b;
  border-radius: 4px;
  color: #c0392b;
  cursor: pointer;
}
```

- [ ] **Step 4: 手动浏览器验证**

```bash
pnpm dev
```

- 创建 mission,正常激活 → 看到 HR 工作 → 团队招募成功(没 retry 按钮)
- 模拟 LLM 失败(可在 `hr-agent.ts` 临时 throw,或断网) → 重启服务 → 重新激活 → 看到失败 UI + 重试按钮
- 点击重试按钮 → 再次触发 activate 请求

- [ ] **Step 5: 提交**

```bash
git add apps/server/public/app.js apps/server/public/styles.css
# 如改了其他 JS 也加上
git commit -m "feat(ui): show HR retry status and add retry button on 503 response"
```

---

## 全部完成 — 收尾验证

- [ ] **Step 1: 全工程 grep,确认无残留**

```bash
cd /Users/zexho/Documents/DigitalAgent
grep -rn "planMissionTeam\|team-planning\|hr-activation\|activateMissionWithHR" --include="*.ts" --include="*.json" --include="*.js" .
```
Expected: 仅可能有 docs/superpowers/specs 或 plans 中的设计文档命中(不影响),无源码命中

- [ ] **Step 2: typecheck + 测试全绿**

```bash
pnpm typecheck && pnpm test
```
Expected: 全部通过

- [ ] **Step 3: 手动 smoke test — 输入"成语接龙"goal**

```bash
pnpm dev
```

- 浏览器创建 mission: 目标 = "5 个 agent 协作玩成语接龙,完成 50 次以上才算成功"
- Owner 确认 brief
- 看 HR 招出的团队
- 验收:
  - ✓ 团队规模 2-5 个
  - ✓ 角色名字与"接龙/文字游戏"相关(人工 review)
  - ✓ Mission 可激活进入 running 状态

- [ ] **Step 4: 手动 smoke test — LLM 错误注入**

临时在 `hr-agent.ts` 的 `analyzeAndPlan` 顶部加 `throw new Error("test");` → `pnpm dev` → 创建 mission → 看 HR 卡片显示重试状态 → 最终失败 + 重试按钮。

测试完后还原 hr-agent.ts。

- [ ] **Step 5: PR 准备**

按阶段拆成 4 个 PR(或合并为 1 个 PR,看团队偏好):

```bash
gh pr create --base master --head <current-branch> --title "refactor: HR LLM-driven recruitment (drop keyword fallback)" --body "$(cat <<'EOF'
## Summary
- 删除关键词招募路径 (team-planning.ts)
- LLM 失败时重试 3 次后透传错误,API 返回 503
- 删除重复代码 hr-activation.ts
- agent-system.json 瘦身
- HR 卡片显示重试状态 + 重试按钮

See: docs/superpowers/specs/2026-05-13-hr-llm-driven-design.md

## Test plan
- [x] Unit tests: retry, negotiation-manager, mission-service, api
- [x] Typecheck pass
- [x] Manual smoke: 成语接龙 mission HR 输出合理团队
- [x] Manual smoke: LLM 错误注入 → 503 + 重试 UI
EOF
)"
```

---

## 自检笔记 (供执行者参考)

- 阶段 1 是纯加法,跑过 = 净收益,可独立 ship
- 阶段 2 是行为变化,ship 后密切看失败率,>5% 就 revert 该阶段 commit
- 阶段 3 是机械删除,改动量大但风险低,审阅时主要看是否漏删
- 阶段 4 是前端,改动隔离,可单独 ship
