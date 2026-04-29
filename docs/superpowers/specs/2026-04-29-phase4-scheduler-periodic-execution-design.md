# Phase 4: Scheduler & Periodic Execution — 产品设计

## Overview

Phase 4 在 Mission 内嵌入调度引擎，让长期运行的 Mission 拥有团队工作节奏。调度规则由 HR 在团队谈判时提出，Owner 审核协商，作为 TeamPlan 的一部分。系统用 cron 表达式驱动定期任务，用条件触发器响应异常。

核心设计原则：调度只是创建 Task 的另一种方式，不引入新的任务状态或执行通道。

## Goals

- Mission 级别的调度引擎，支持 cron 定时和条件触发
- 调度规则作为 HR 谈判产出的一部分，与团队方案一体
- 触发时创建 Task 走正常任务流程（plan → execute → review）
- 调度持久化，服务重启后恢复
- 条件触发器挂载在 Agent 任务完成事件上，用 LLM 评估条件
- Mission 完成/取消时自动清理调度

## Non-Goals

- 不实现具体的社媒数据采集适配器（Phase 5 范围）
- 不引入分布式锁或多进程协调（当前单进程架构）
- 不自动执行 OpenClaw（调度只创建 Task，执行仍是显式触发）
- 不引入独立的事件总线（复用现有 agent_conversation_bus）

## Architecture Decision

**方案 A：Mission 内嵌调度器**

在 `InMemoryMissionService` 内为每个 active Mission 持有一个 `MissionScheduler` 实例。调度规则存储在 Mission 对象上，随 mission-store.json 持久化。

理由：当前系统是单进程、内存存储、JSON 持久化。引入 BullMQ/Temporal 等外部调度框架是基础设施先行于产品验证。正确的 Phase 4 设计是一个轻量的内嵌调度器，有清晰的时钟抽象以便测试，有干净的替换边界以便未来升级。

## Domain Types

新增到 `packages/core/src/types.ts`：

```typescript
// --- 触发方式 ---

export interface CronTrigger {
  type: 'cron'
  expression: string    // "0 9 * * 1-5"
  timezone: string      // "Asia/Shanghai"
}

export interface ConditionTrigger {
  type: 'condition'
  description: string           // "互动率下降超过20%"
  sourceAgentRole: string       // "data-analyst" — 谁负责检测
  evaluatePrompt: string        // LLM 评估条件的 prompt
}

export type ScheduleTrigger = CronTrigger | ConditionTrigger

// --- 调度规则 ---

export interface ScheduleRule {
  id: string
  name: string                    // "每日数据检查"
  missionId: string
  enabled: boolean

  // 触发方式（二选一）
  trigger: ScheduleTrigger

  // 任务模板
  taskTemplate: {
    title: string                 // "检查昨日互动数据"
    contract: TaskContract        // 目标、输入、输出schema、成功标准
    assigneeRole: string          // "data-analyst"
    priority: 'low' | 'normal' | 'high'
  }

  // 控制
  maxConcurrent: number           // 同一时间最多几个未完成的同类任务
  metadata: Record<string, unknown>
}
```

Mission 类型扩展：

```typescript
interface Mission {
  // ... 现有字段
  scheduleRules: ScheduleRule[]
}
```

`createMission()` 工厂函数初始化 `scheduleRules: []`。

构造器在 `packages/core/src/schedule.ts`：

```typescript
export function createScheduleRule(input: Omit<ScheduleRule, 'id'>): ScheduleRule
```

验证规则：
- `name`、`missionId` 非空
- `trigger` 必须是 CronTrigger 或 ConditionTrigger 之一
- `taskTemplate.title`、`taskTemplate.assigneeRole` 非空
- `taskTemplate.contract` 必须有 `objective`
- `maxConcurrent` 为正整数
- CronTrigger 的 `expression` 必须通过 cron 格式验证
- ConditionTrigger 的 `description`、`sourceAgentRole`、`evaluatePrompt` 非空

## Cron Support

创建 `apps/server/src/schedule-rules.ts`。

使用 `node-cron` 库处理标准五字段 cron 表达式。

API：

```typescript
export function validateCronExpression(expression: string): void
export function nextRunAfter(trigger: CronTrigger, after: Date): Date
export function isDue(nextRunAt: string, now: Date): boolean
```

支持的五字段 cron：`minute hour dayOfMonth month dayOfWeek`。

支持的值：`*`、单个整数、逗号分隔列表、`*/n` 间隔。

不支持：范围（`1-5`）、命名日期（`MON`）、秒字段、Quartz 扩展。遇到不支持的语法抛出 `Unsupported cron expression`。

## MissionScheduler 组件

创建 `apps/server/src/mission-scheduler.ts`。

```typescript
export interface SchedulerDeps {
  clock: SchedulerClock
  missionService: InMemoryMissionService
}

export interface SchedulerClock {
  now(): Date
  setInterval(handler: () => void, ms: number): unknown
  clearInterval(handle: unknown): void
}

export class MissionScheduler {
  constructor(missionId: string, deps: SchedulerDeps)

  // 生命周期
  start(rules: ScheduleRule[]): void
  stop(): void
  restart(rules: ScheduleRule[]): void

  // 规则管理
  addRule(rule: ScheduleRule): void
  removeRule(ruleId: string): void
  updateRule(ruleId: string, patch: Partial<ScheduleRule>): void
  getRules(): ScheduleRule[]

  // 条件触发器评估
  evaluateConditions(context: MissionContext): Promise<void>
}
```

行为：
- `start()` 为每个 CronTrigger 规则注册 node-cron 定时任务
- `stop()` 清除所有定时任务，幂等
- `restart()` 先 stop 再 start，用于规则变更后重建
- 每个 cron tick 调用 `onTrigger(rule)`

触发流程：

```
Cron tick
  → MissionScheduler.onTrigger(rule)
    → 检查 maxConcurrent（查询未完成的同类任务数）
    → 超限则跳过，记录 info 日志
    → 未超限则：
      → missionService.createTask(rule.taskTemplate)
      → missionService.assignTask(taskId, agentByRole)
      → 通过 agent_conversation_bus 通知相关 Agent
```

## 条件触发器评估

条件触发器不依赖 cron，而是挂载在 Agent 任务执行完成的事件上：

```
Agent 完成任务（状态 → completed）
  → MissionService.onTaskCompleted(taskId)
    → 检查该 Mission 的所有 ConditionTrigger 规则
    → 对每个规则：
      if (rule.trigger.sourceAgentRole === completedTask.agentRole)
        → 用 LLM 评估 rule.trigger.evaluatePrompt + 任务产出
        → if (条件满足)
          → onTrigger(rule)
```

评估上下文：LLM 拿到完成任务的 Artifact 内容、Mission 目标和成功指标、触发条件的描述。

评估 prompt 模板：

```
你是任务监控器。根据以下信息判断是否满足触发条件。

触发条件：${rule.trigger.description}
任务产出：${artifact.content}
Mission目标：${mission.goal}

请回答 YES 或 NO，并简要说明原因。
```

## HR 谈判集成

### TeamPlan 扩展

```typescript
interface TeamProposal {
  // ... 现有字段（roles, budget, risks）
  schedulePlan: SchedulePlanItem[]
}

interface SchedulePlanItem {
  name: string                    // "每日数据检查"
  cronExpression?: string         // "0 9 * * 1-5"（cron 类型必填）
  assigneeRole: string            // "data-analyst"
  taskDescription: string         // 任务描述
  justification: string           // "需要每天监控数据以发现异常趋势"

  // 条件触发（可选，与 cronExpression 二选一）
  conditionDescription?: string   // "互动率下降超过20%"
  conditionSourceRole?: string    // "data-analyst"
  conditionEvaluatePrompt?: string // LLM 评估 prompt
}
```

### 谈判过程

1. **HR 提出团队方案**时同时提出调度计划。HR 根据 MissionBrief 用 LLM 生成节奏建议（不是硬编码模板）
2. **Owner 审核**可以接受、调整频率、添加/删除规则，走正常的谈判循环
3. **谈判达成一致**后，`SchedulePlanItem[]` 转换为 `ScheduleRule[]`：
   - HR 填充 `TaskContract`（根据角色能力和任务描述）
   - 设置 `maxConcurrent` 默认为 1
   - 条件触发器也可以在此时协商

### HR Prompt 扩展

HR 的 system prompt 新增调度相关指引：

```
在提出团队方案时，你需要同时规划团队的工作节奏：
- 根据目标类型建议合理的定期任务
- 考虑每个角色的职责，安排对应的周期性工作
- 如果需要条件触发（如异常告警），明确说明触发条件和响应人
- 用自然语言描述节奏，系统会转为 cron 表达式
```

## MissionService 集成

```typescript
class InMemoryMissionService {
  private schedulers: Map<string, MissionScheduler>  // missionId → scheduler

  // Mission 激活时：从 teamPlan.scheduleRules 启动调度器
  // Mission 完成/取消时：停止调度器
  // Mission 暂停时：暂停调度器
}
```

MissionSnapshot 扩展，新增 `scheduleRules: ScheduleRule[]`。

持久化恢复流程：

```
Server.start()
  → MissionService.loadFromStore()
    → 对每个 active 的 Mission：
      → 重建 MissionScheduler(mission.scheduleRules)
      → scheduler.start()
```

## API Endpoints

新增到 `apps/server/src/api.ts`：

```
GET    /api/missions/:id/schedule          → 获取调度规则列表
POST   /api/missions/:id/schedule          → 添加调度规则
PATCH  /api/missions/:id/schedule/:ruleId  → 更新规则（启用/禁用/修改）
DELETE /api/missions/:id/schedule/:ruleId  → 删除规则
POST   /api/missions/:id/schedule/:ruleId/trigger  → 手动触发一次
```

## UI

在 Mission 详情页新增调度面板：
- 规则列表：名称、cron/条件描述、分配角色、下次触发时间、启用状态
- 手动触发按钮
- 启用/禁用开关

UI 数据通过现有 SSE 机制实时推送。

## Error Handling

| 场景 | 处理方式 |
|------|---------|
| cron 触发但 Agent 不存在 | 跳过，warn 日志，通知 Owner |
| 条件评估 LLM 调用失败 | 跳过本次，下次重试，不创建任务 |
| Task 创建失败 | 跳过，error 日志，通知 Owner |
| 服务重启 | 从 store 恢复，重新注册所有 cron |
| maxConcurrent 超限 | 静默跳过，info 日志 |
| 任务模板填充不完整 | 创建时校验，缺失字段用默认值兜底 |

## File Plan

- 修改 `packages/core/src/types.ts` — 新增 ScheduleRule、CronTrigger、ConditionTrigger 类型
- 创建 `packages/core/src/schedule.ts` — 构造器和验证函数
- 创建 `packages/core/src/schedule.test.ts` — 类型验证单元测试
- 修改 `packages/core/src/index.ts` — 导出 schedule 模块
- 创建 `apps/server/src/schedule-rules.ts` — cron 解析和 nextRun 计算
- 创建 `apps/server/src/schedule-rules.test.ts` — cron 测试
- 创建 `apps/server/src/mission-scheduler.ts` — MissionScheduler 组件
- 创建 `apps/server/src/mission-scheduler.test.ts` — 调度器测试（fake clock）
- 修改 `apps/server/src/mission-service.ts` — 集成调度器，持久化，恢复
- 修改 `apps/server/src/api.ts` — 新增调度 API 端点
- 修改 `apps/server/src/api.test.ts` — API 测试
- 修改 `apps/server/src/server.ts` — 启动时恢复调度器
- 修改 `apps/server/src/hr-agent.ts` — 谈判时生成调度计划
- 修改 `apps/server/src/negotiation-manager.ts` — TeamProposal 扩展

## Testing Requirements

Core 测试：
- `createScheduleRule` 拒绝空 name
- `createScheduleRule` 拒绝无效 cron
- `createScheduleRule` 拒绝空 sourceAgentRole 的 ConditionTrigger

Cron 测试：
- `nextRunAfter("0 9 * * *", 08:59)` → 09:00
- `nextRunAfter("0 9 * * *", 09:00)` → 次日 09:00
- `nextRunAfter("0 10 * * 1", Wednesday)` → 下周一 10:00
- 不支持的格式抛出异常

Scheduler 测试：
- tick 创建 Task 并分配给正确 Agent
- tick 跳过 disabled 的规则
- tick 跳过 maxConcurrent 超限的规则
- tick 后 nextRunAt 更新
- Agent 不存在时 warn 并跳过

MissionService 集成测试：
- 激活 Mission 时注册调度规则
- 重新激活不重复注册
- 完成/取消 Mission 时清理调度
- 持久化后恢复调度
- 条件触发器在任务完成时评估
- 评估为 true 时创建通知任务

API 测试：
- CRUD 调度规则
- 手动触发
- 条件评估端点

## Acceptance Scenario

用户创建并激活 Mission：`运营一个小红书账号，一个月涨到1000粉丝`

预期行为：
1. Mission 激活创建团队（Phase 2）
2. HR 谈判时提出调度计划：每日数据检查、每周选题会、每两周回顾
3. Owner 审核确认后，系统注册三个 ScheduleRule
4. 当时钟到达每日检查时间，MissionScheduler 触发，创建 Task 分配给数据分析师
5. 数据分析师完成任务后，条件触发器评估"互动率是否下降超20%"
6. 如果条件满足，通知项目经理

## Implementation Order

1. Core schedule types + constructors + unit tests
2. Cron/interval rule parsing + tests
3. MissionScheduler component + fake clock tests
4. MissionService integration (persistence, restore, lifecycle)
5. HR negotiation integration (TeamProposal 扩展, prompt 更新)
6. API endpoints + tests
7. Condition trigger evaluation (LLM-based) + tests
8. Server startup/shutdown wiring
9. Full verification
