# Plan 3: 安全和监控 (Safety and Monitoring v1) Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task. TDD red→green→commit per task.

**Goal:** 让 Mission 不会失控，用户敢真的"按一次启动就不管"。补齐 4 块平台能力中的"不失控"层：mission-level circuit breaker、budget enforcement、HTTP retries、data source cadence scheduling。

**Architecture:** Mission status 加 `pause/resume` 控制（停 scheduler、停 autonomy、不再派 followup task）；MissionBudget 追加 `maxFollowupTasks` 上限；budget 超限自动 pause + notify owner；HTTP 适配器加可配置重试（默认 3 次指数退避）；数据源加 `cadenceCron` 字段，scheduler 自动定时触发 fetch。

**Tech Stack:** TypeScript, Vitest, 现有模块。

---

## Tasks

### Task 1: Mission pause / resume control (circuit breaker)

**Files:** `apps/server/src/mission-service.ts`, tests, `api.ts`

新增方法：
- `pauseMission(missionId, reason?)` — 设 status="paused"，停 scheduler.stopAll(missionId)，停 autonomy.stopLoop(missionId)，appendMessage agent_notify 给 owner（"Mission paused: {reason}"）
- `resumeMission(missionId)` — 仅当 status="paused" 时；恢复 status="active"；重启 scheduler + autonomy

行为约束：
- pause 后：`createFollowupTask` 立即返回 `{created: false, reason: "mission_paused"}`，不再派活
- pause 后：`triggerDataSourceFetch` 仍可手动触发但不自动；`triggerPublish` 仍可手动触发不自动
- resume 后：scheduler/autonomy 重启

API:
- `POST /api/missions/:id/pause` body: `{reason?: string}` → 200 with snapshot
- `POST /api/missions/:id/resume` → 200 with snapshot

测试要点：
- pauseMission 设置 status + stops scheduler + stops autonomy
- 暂停后 createFollowupTask 返回 mission_paused
- resume 后能继续派 followup
- pause 重复调用幂等（已 paused 时不报错）
- resume 非 paused 时是 no-op

Commit: `feat(mission-service): add pause/resume mission circuit breaker`

---

### Task 2: Budget enforcement — auto-pause on overrun

**Files:** `packages/core/src/types.ts` (extend `MissionBudget`), `apps/server/src/mission-service.ts`, tests

`MissionBudget` 添加 `maxFollowupTasks?: number`（默认 100）。

在 `createFollowupTask` 安全护栏检查后追加：
- 当前 mission 总任务数（已含 initial + scheduled + followups）≥ `maxFollowupTasks` → 调用 `pauseMission` 并返回 `{created: false, reason: "budget_exceeded", escalateMessageSent: true}`

`createTaskFromScheduleRule` 同样检查，超额时记 schedule trigger event "skipped: budget exceeded" 并 pauseMission。

测试：
- 设定 maxFollowupTasks=2，已有初始 task；第 1 个 followup 成功，第 2 个 followup 触发 budget_exceeded → pauseMission 被调用
- 暂停后 mission.status === "paused"
- owner 收到 agent_notify 含 "budget"

Commit: `feat(mission-service): enforce maxFollowupTasks budget with auto-pause`

---

### Task 3: HTTP adapter retries (exponential backoff)

**Files:** `apps/server/src/data-source-adapter.ts`, `publish-target-adapter.ts`, tests

构造选项追加：
```typescript
interface HttpRetryConfig {
  maxAttempts: number;     // default 3
  initialDelayMs: number;  // default 200
}
```

`HttpDataSourceAdapter` 和 `HttpPublishTargetAdapter` 在请求失败（非 2xx 或 throw）时按指数退避重试 `maxAttempts` 次（`initialDelayMs * 2^(attempt-1)`），sleep 通过依赖注入便于测试。最终返回结果带 `attemptCount`。

返回类型扩展：
- success: `{ ok: true, data, attemptCount }`
- failure: `{ ok: false, error, attemptCount }`

测试：
- 失败 2 次后第 3 次成功 → attemptCount=3, ok=true
- 全部失败 → ok=false, attemptCount=3
- 单次成功 → attemptCount=1

mission-service 中 fetch/publish 调用更新（attemptCount 不破坏现有 record schema，作为 metadata 可选）。

Commit: `feat(adapters): add retry with exponential backoff to HTTP adapters`

---

### Task 4: Data source cadence scheduling

**Files:** `packages/core/src/types.ts` (extend `MissionDataSource`), `apps/server/src/mission-service.ts`, `mission-scheduler.ts`, tests

`MissionDataSource` 添加 `cadenceCron?: string`（如 `"0 */1 * * *"` 每小时）。

`MissionScheduler` 已有 cron 触发能力，复用：
- 注册数据源 cadence 时，scheduler 内部维护一份 `dataSourceCronJobs` map
- 触发时调用 `service.triggerDataSourceFetch(missionId, sourceId)`

`addDataSource` / `removeDataSource` 时同步 register/unregister scheduler 的 cadence。

`pauseMission` 时停止 cadence；`resumeMission` 时重启（已在 Task 1 的 scheduler stop/restart 内自然实现）。

测试（用 fake clock）：
- 添加带 cadence 的数据源 → cron 触发后 fetch 被调用并写 KnowledgeEntry
- removeDataSource 后 cron 不再触发
- mission paused 时 cron 不触发

Commit: `feat(mission-service): schedule data source fetches via cron cadence`

---

### Task 5: API + ROADMAP + merge

**Files:** `apps/server/src/api.ts`, tests, `ROADMAP.md`

新增 endpoints:
- `POST /api/missions/:id/pause` body: `{reason?: string}`
- `POST /api/missions/:id/resume`
- `addDataSource` body 支持 `cadenceCron` 字段

ROADMAP 标 A.4 v1 / Plan 3 ✅ 完成。

`pnpm test && pnpm typecheck` 全绿后 merge plan-3-safety branch 到 master。

---

## Self-Review Checklist

### Spec coverage (vs. ROADMAP A.4)
- ✅ 任务上限护栏（每次反馈最多派 N 个） → 已在 Plan 1 完成
- ✅ Mission 总产出上限 → Task 2 (maxFollowupTasks)
- ⚠️ 总 token 上限 → 推迟（需 LLM usage 追踪基础设施，独立）
- ✅ Mission 级熔断按钮 → Task 1
- ✅ 异常事件主动通知（外部接口失败、超预算）→ pause 即 notify
- ⚠️ 账号被限/封 主动通知 → 推迟（需要适配器层识别 4xx 模式）
- ⚠️ 分层托管开关 → 推迟（v2 带 v3 派活时再做）

### Risks
1. **Pause/resume 幂等性**：测试要覆盖重复调用；pauseMission(已paused)、resumeMission(已active) 都应 no-op，不抛错。
2. **Cadence cron 重启**：MissionScheduler 已有 cron 调度（schedule rules）—— 数据源应复用同一调度器实例避免双进程。
3. **Retry 测试速度**：用注入的 sleep mock 避免真等 200ms*N。
4. **Budget 边界**：`maxFollowupTasks` 是"followup task 总数上限"还是"包括 initial+scheduled 在内的总任务上限"？v1 选择**总任务上限**（含 initial），更直观，文案更清晰。

---

## Execution Handoff

Plan saved to `docs/superpowers/plans/2026-05-10-safety-monitoring-v1.md`.

执行：在 `plan-3-safety` 分支上按 5 个 Task 顺序 TDD。每个 Task 一个 commit。完成后 merge 到 master。
