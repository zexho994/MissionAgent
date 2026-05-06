# Phase 4B: Automation Gap Fillers — 产品设计

## Overview

Phase 4B 补齐 Phase 3 遗漏和 Phase 4 未覆盖的自动化缺口，使系统能在用户确认 MissionBrief 后零人工介入地跑通完整闭环。

核心原则：最小改动，不引入新架构组件，复用现有 LLM 服务和 ConversationBus。

## 问题诊断

当前系统的自动化链路有 4 个断裂点：

```
Review 完成 → 不通知 Agent（Phase 3 遗漏）
Task 完成   → 不触发下一个 Task（缺少编排）
Agent 思考  → 不能直接产出 Artifact（依赖 OpenClaw）
Mission 运行 → 不知道何时完成（无 successMetrics 检查）
```

## Goals

- Review 事件接入 ConversationBus，评审结果自动通知相关 Agent
- LLM 直驱执行：Agent 通过 LLM 直接产出 Artifact，不依赖 OpenClaw
- 自动任务编排：任务完成后自动触发下一阶段任务，形成闭环
- Mission 完成判定：基于 successMetrics 自动检测 Mission 是否达成目标

## Non-Goals

- 不替代 OpenClaw 作为通用执行引擎（LLM Executor 只处理文本类任务）
- 不实现分布式调度（复用 Phase 4 的 MissionScheduler）
- 不实现外部数据源集成（Phase 5 范围）
- 不实现 Agent 长期记忆管理（Phase 6 范围）

---

## 1. Review → Bus 接线

### 问题

`submitExecutionResult()` 中评审完成后没有调用 `dispatchToBus()`，导致：
- Worker 不知道评审结果（revision_needed 时无法响应）
- Owner 不知道任务完成情况
- 规划 Agent 无法基于评审结果调整后续计划

### 设计

在 `mission-service.ts` 的评审流程末尾新增 Bus 事件分发：

**修改点：`submitExecutionResult()` 方法**

当评审完成后（无论 approve/revise/reject），调用 `dispatchToBus()` 分发对应事件：

| 评审结果 | BusEvent | 通知对象 |
|---------|----------|---------|
| approve | `{ type: "review_completed", agentId, taskId, decision: "approve" }` | Owner, Planner |
| revise | `{ type: "review_revision_needed", agentId, taskId, comments }` | Worker (执行修订), Planner |
| reject | `{ type: "review_completed", agentId, taskId, decision: "reject" }` | Owner |

**Relevance Rules 扩展**

在 `AgentConversationBus` 的 agent selection 逻辑中补充：

| Event | 通知（status update） | LLM 响应 |
|-------|----------------------|----------|
| review_completed | Task assignee | Owner（更新进度感知） |
| review_revision_needed | Worker（必须响应） | Planner（评估影响） |

**不影响现有流程**：Bus 事件分发在评审完成后异步执行，不阻塞评审结果的返回。

---

## 2. LLM Executor

### 问题

当前所有实际工作产出都依赖 OpenClaw CLI。但很多任务（调研、策划、文案撰写、数据分析）本质上是文本生成，LLM 可以直接完成。OpenClaw 是一个外部依赖，不可用时系统完全无法产出任何内容。

### 设计思路

**不引入新的执行引擎**。复用现有 `startExecution()` + `submitExecutionResult()` 流程，在中间插入 LLM 调用替代 OpenClaw 调用。

```
startExecution() → [新增] llmExecute() → submitExecutionResult()
                   ↑ 替代 openclaw.run()
```

### 2.1 LLM Execution Flow

新增方法到 `InMemoryMissionService`：

```typescript
async executeTaskWithLlm(input: {
  missionId: string;
  taskId: string;
}): Promise<Artifact>
```

流程：

```
1. 验证 task 状态为 running（startExecution 已调用）
2. 获取 task.contract（objective, input, outputSchema, successCriteria）
3. 获取 agent persona（角色定位、能力边界）
4. 获取 context（同 ContextRetriever 逻辑：当前 mission 的 artifacts、messages、knowledge）
5. 构建 execution prompt
6. 调用 LLM
7. 解析 LLM 输出为 Artifact
8. 调用 submitExecutionResult()（走正常评审流程）
```

### 2.2 Execution Prompt 构建

```typescript
interface ExecutionPromptContext {
  agentRole: string;           // "数据分析师"
  agentPurpose: string;        // "负责信息收集和数据分析"
  taskObjective: string;       // Task contract 的 objective
  taskInput: Record<string, unknown>;  // Task contract 的 input
  outputSchema: Record<string, unknown>; // 期望的输出结构
  successCriteria: string[];   // 成功标准
  missionGoal: string;         // Mission 目标
  relevantContext: string;     // 检索到的上下文摘要
}
```

Prompt 模板：

```
你是 ${agentRole}，${agentPurpose}。

任务目标：${taskObjective}
任务输入：${JSON.stringify(taskInput)}
输出格式：${JSON.stringify(outputSchema)}
成功标准：${successCriteria.join('; ')}

Mission 背景：${missionGoal}

相关上下文：
${relevantContext}

请直接输出符合输出格式的 JSON 结果。不要解释，只输出 JSON。
```

### 2.3 Artifact 生成

LLM 输出解析为 Artifact：

```typescript
// LLM 输出 → Artifact
function parseLlmOutputToArtifact(
  llmOutput: string,
  taskId: string,
  taskContract: TaskContract
): Artifact
```

规则：
- 尝试 JSON parse LLM 输出
- 如果 parse 失败，包装为 `{ text: llmOutput }`
- Artifact type 根据 agent role 推断：researcher → research_report, planner → content_draft, 等
- evidence 从 context 引用中提取

### 2.4 执行路由

在 API 层提供路由选择：

```
POST /api/missions/tasks/execute
Body: { missionId, taskId, executor: "llm" | "openclaw" }
```

- `executor: "llm"` → 调用 `executeTaskWithLlm()`
- `executor: "openclaw"` → 调用现有 OpenClaw 流程（默认）
- 如果 OpenClaw 不可用，自动 fallback 到 LLM executor

新增配置到 `agent-system.json`：

```json
{
  "execution": {
    "defaultExecutor": "openclaw",
    "fallbackToLlm": true,
    "roleExecutorOverrides": {
      "researcher": "llm",
      "planner": "llm",
      "content-writer": "llm"
    }
  }
}
```

`roleExecutorOverrides` 允许特定角色默认使用 LLM 执行，因为这些角色的任务本质是文本生成。

### 2.5 不做什么

- 不实现工具调用（tool use）。LLM Executor 只处理纯文本产出任务。需要调用外部 API 的任务仍走 OpenClaw。
- 不实现多轮执行。单次 LLM 调用产出单次 Artifact。如果质量不够，走 review → revision → re-execute 循环。
- 不修改 TaskStateMachine。LLM Executor 走现有状态机（running → submitted → reviewing → completed/revision_needed）。

---

## 3. 自动任务编排

### 问题

当前任务完成/失败后，系统停在原地。没有逻辑去：
- 规划后续任务
- 自动开始下一个任务
- 根据执行结果调整计划

### 设计思路

**任务编排器（Task Orchestrator）** — 一个轻量组件，在任务完成时评估"下一步做什么"并自动触发。

不是复杂的 DAG 引擎。编排器用 LLM 判断当前状态并决定下一步行动。

### 3.1 TaskOrchestrator

新增到 `apps/server/src/task-orchestrator.ts`：

```typescript
export interface OrchestratorDeps {
  llm: LlmService;
  missionService: InMemoryMissionService;
  clock: () => Date;
}

export class TaskOrchestrator {
  constructor(deps: OrchestratorDeps);

  async onTaskCompleted(input: {
    missionId: string;
    taskId: string;
    artifactId: string;
  }): Promise<void>;

  async onTaskFailed(input: {
    missionId: string;
    taskId: string;
    failureReason: string;
  }): Promise<void>;

  async onMissionActivated(missionId: string): Promise<void>;
}
```

### 3.2 onMissionActivated — 初始任务规划

Mission 激活且团队创建后，编排器用 LLM 根据 MissionBrief + 团队角色规划首批任务：

```
输入：MissionBrief + 团队角色列表 + 每个 RoleSpec 的能力描述
LLM 输出：TaskPlan[]
  → 每个 TaskPlan 包含：title, objective, assigneeRole, dependencies, priority
  → 编排器将 TaskPlan 转为 Task 创建并排队
  → 无依赖的 Task 立即执行（调用 executeTaskWithLlm 或 openclaw）
```

### 3.3 onTaskCompleted — 完成后续

任务成功完成后：

```
1. 获取 Mission 当前状态：
   - 已完成的 tasks 及 artifacts
   - 进行中的 tasks
   - 排队中的 tasks
   - 剩余 budget
   - successMetrics
2. 构建 orchestration prompt
3. LLM 决策：
   a. 是否需要后续任务？（如：调研完成 → 需要策划任务）
   b. 是否可以评估 Mission 进展？
   c. 是否需要调整进行中任务的优先级？
4. 执行 LLM 决策：
   - 创建新 Task → 排队并自动开始执行
   - 标记 Mission 进展
```

### 3.4 onTaskFailed — 失败恢复

任务失败后：

```
1. 获取失败原因（failureReason）
2. LLM 评估：
   a. 可重试？→ 创建同类型新 Task（可能调整策略）
   b. 可绕过？→ 标记跳过，继续后续任务
   c. 阻塞性失败？→ 通知 Owner，请求人工介入
3. 执行决策
```

### 3.5 Orchestration Prompt

```typescript
interface OrchestrationContext {
  missionGoal: string;
  successMetrics: string[];
  teamRoles: Array<{ role: string; purpose: string }>;
  completedTasks: Array<{
    title: string;
    assigneeRole: string;
    artifactSummary: string;
    qualityScore: number;
  }>;
  inProgressTasks: Array<{ title: string; assigneeRole: string }>;
  failedTasks: Array<{ title: string; reason: string }>;
  recentBusMessages: Array<{ from: string; content: string }>;
  budgetUsed: number;
  budgetTotal: number;
}
```

Prompt：

```
你是任务编排器，负责根据当前 Mission 进展决定下一步行动。

Mission 目标：${missionGoal}
成功指标：${successMetrics}
团队角色：${teamRoles}

已完成任务：
${completedTasks}

进行中任务：
${inProgressTasks}

失败任务：
${failedTasks}

Agent 最近讨论：
${recentBusMessages}

预算使用：${budgetUsed} / ${budgetTotal}

请用 JSON 回答：
{
  "actions": [
    {
      "type": "create_task",
      "title": "...",
      "objective": "...",
      "assigneeRole": "...",
      "priority": "normal",
      "executor": "llm"
    }
  ],
  "missionProgress": 0.0-1.0,
  "assessment": "一句话评估当前进展"
}

如果没有需要创建的新任务，actions 为空数组。
```

### 3.6 防护机制

| 机制 | 说明 |
|------|------|
| 最大任务数 | 每个 Mission 最多创建 50 个 Task（防无限循环） |
| 编排冷却 | 同一 Mission 30 秒内最多触发一次编排（防快速循环） |
| 预算检查 | 每次编排前检查剩余预算，不足时只通知 Owner 不创建新任务 |
| 人工审批 | 超过 10 个任务后，新任务需要 Owner 确认（通过 Bus 通知 Owner） |

### 3.7 与 Phase 4 调度器的关系

- **MissionScheduler（Phase 4）**：定时/条件触发，创建周期性任务（每日检查、每周回顾）
- **TaskOrchestrator（Phase 4B）**：事件驱动，在任务完成时动态规划后续任务

两者互补：
- 调度器负责"固定节奏"的任务
- 编排器负责"根据进展动态调整"的任务
- 两者创建的 Task 走同一条执行和评审流程

---

## 4. Mission 完成判定

### 问题

系统没有自动检测 Mission 是否达成目标的机制。Mission 只能手动完成或取消。

### 设计

### 4.1 Progress Check

在 TaskOrchestrator 的 `onTaskCompleted` 中增加 Mission 进度评估：

每次任务完成后，编排器在 orchestration prompt 中评估 `missionProgress`。当 progress ≥ 0.9 时，触发完成检查。

### 4.2 Completion Check Prompt

独立的完成评估调用：

```
你是 Mission 完成评估器。

Mission 目标：${missionGoal}
成功指标：${successMetrics}

任务执行历史：
${taskHistory}

Agent 讨论摘要：
${discussionSummary}

请评估 Mission 是否已经完成。

输出 JSON：
{
  "completed": true/false,
  "achievementSummary": "对每个成功指标的达成情况评估",
  "confidence": 0.0-1.0,
  "remainingWork": "如果未完成，描述剩余工作"
}
```

### 4.3 Completion Flow

```
TaskOrchestrator.onTaskCompleted()
  → LLM 评估 missionProgress ≥ 0.9
  → 调用 completionCheck()
  → if (completed && confidence ≥ 0.8):
      → missionService.completeMission(missionId)
      → Bus 广播 mission_completed
      → 停止 AutonomyService
      → 停止 MissionScheduler
      → 生成最终 MissionReport
  → else:
      → 正常继续编排
```

### 4.4 MissionReport

Mission 完成时生成的结构化报告：

```typescript
interface MissionReport {
  missionId: string;
  goal: string;
  achievedAt: string;
  duration: string;            // 总运行时长
  totalTasks: number;
  completedTasks: number;
  failedTasks: number;
  achievementSummary: string;  // LLM 生成的达成情况摘要
  metricsAssessment: Array<{
    metric: string;
    achieved: boolean;
    evidence: string;
  }>;
  budgetUsed: number;
  keyDecisions: string[];      // 从 Agent 讨论中提取的关键决策
  lessonsLearned: string[];    // LLM 总结的经验教训
}
```

---

## 5. 集成方案

### 5.1 MissionService 修改

```typescript
class InMemoryMissionService {
  private taskOrchestrator: TaskOrchestrator;

  // submitExecutionResult 末尾新增：
  // 1. dispatchToBus(review_event)  ← Review → Bus 接线
  // 2. if (task status === completed):
  //      taskOrchestrator.onTaskCompleted(...)
  // 3. if (task status === failed):
  //      taskOrchestrator.onTaskFailed(...)

  // activateMission / activateMissionWithHR 末尾新增：
  // taskOrchestrator.onMissionActivated(missionId)
}
```

### 5.2 API 新增

```
POST /api/missions/tasks/execute          → 执行任务（支持 LLM / OpenClaw 路由）
POST /api/missions/:id/check-completion   → 手动触发完成检查
GET  /api/missions/:id/report             → 获取 MissionReport
```

### 5.3 配置扩展

`agent-system.json` 新增：

```json
{
  "execution": {
    "defaultExecutor": "openclaw",
    "fallbackToLlm": true,
    "roleExecutorOverrides": {}
  },
  "orchestration": {
    "maxTasksPerMission": 50,
    "orchestrationCooldownMs": 30000,
    "humanApprovalThreshold": 10,
    "completionConfidenceThreshold": 0.8
  }
}
```

---

## 6. 完整自动化链路（Phase 4 + 4B 合并后）

```
用户确认 MissionBrief
  → HR 组建团队 + 谈判调度计划
  → TaskOrchestrator.onMissionActivated()
    → LLM 规划首批任务
    → 自动 executeTaskWithLlm() 开始执行

Agent 执行任务
  → LLM 产出 Artifact
  → 自动 Review
  → Review → Bus 通知相关 Agent
  → Agent 讨论、汇报、调整

任务完成
  → TaskOrchestrator.onTaskCompleted()
    → LLM 评估进展，规划下一步
    → 自动创建并执行新任务
    → MissionScheduler 定时任务并行运行

进展评估
  → missionProgress ≥ 0.9
  → Completion Check
  → 自动完成 Mission + 生成报告
```

---

## 7. Error Handling

| 场景 | 处理方式 |
|------|---------|
| LLM Executor 调用失败 | 标记任务 failed，触发 onTaskFailed 流程 |
| Orchestration prompt 超时 | 跳过本次编排，等待下一个完成事件 |
| 完成判定 confidence 不足 | 继续运行，下次 task 完成时重新评估 |
| 任务数超限 | 停止创建新任务，通知 Owner |
| 预算不足 | 只通知不执行，等待 Owner 决策 |
| Agent 不存在 | 跳过该任务分配，warn 日志 |

---

## 8. File Plan

### Phase 4B 新增文件

| 文件 | 说明 |
|------|------|
| `apps/server/src/task-orchestrator.ts` | 任务编排器 |
| `apps/server/src/task-orchestrator.test.ts` | 编排器测试 |
| `apps/server/src/llm-executor.ts` | LLM 执行器（prompt 构建 + Artifact 解析） |
| `apps/server/src/llm-executor.test.ts` | 执行器测试 |
| `apps/server/src/mission-report.ts` | MissionReport 类型 + 生成逻辑 |
| `apps/server/src/mission-report.test.ts` | 报告测试 |

### Phase 4B 修改文件

| 文件 | 修改内容 |
|------|---------|
| `apps/server/src/mission-service.ts` | Review → Bus 接线 + 编排器集成 + LLM 执行路由 |
| `apps/server/src/agent-conversation-bus.ts` | 补充 review event 的 agent selection 规则 |
| `apps/server/src/api.ts` | 新增 execute / check-completion / report 端点 |
| `apps/server/config/agent-system.json` | execution + orchestration 配置 |

---

## 9. Testing Requirements

### LLM Executor 测试
- 正常执行：LLM 返回有效 JSON → 生成 Artifact
- JSON parse 失败：包装为 `{ text: output }`
- 根据 agent role 推断 Artifact type
- OpenClaw 不可用时自动 fallback 到 LLM

### Task Orchestrator 测试
- onMissionActivated：根据 Brief 生成首批任务
- onTaskCompleted：创建后续任务并自动开始执行
- onTaskCompleted：所有任务完成后不创建新任务
- onTaskFailed：重试策略选择（retry / skip / escalate）
- 冷却机制：30 秒内不重复编排
- 任务数限制：超过 50 不创建

### Review → Bus 接线测试
- approve 后 Bus 收到 review_completed 事件
- revise 后 Bus 收到 review_revision_needed 事件
- reject 后 Bus 收到 review_completed 事件
- 事件中包含正确的 agentId 和 taskId

### Mission 完成判定测试
- progress < 0.9 不触发完成检查
- progress ≥ 0.9 + confidence ≥ 0.8 → 自动完成
- confidence < 0.8 → 继续运行
- 完成后生成 MissionReport
- 完成后停止所有服务（Scheduler, Autonomy, Bus）

### 集成测试（FakeLlmAdapter）
- 完整链路：激活 → 首批任务 → 执行 → 评审 → 后续任务 → 完成
- 10 个任务后需要 Owner 确认
- 预算不足时停止执行
