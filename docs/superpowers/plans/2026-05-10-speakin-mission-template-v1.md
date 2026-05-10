# Plan 5: speakin Mission Template + End-to-End Integration v1 Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task. TDD red→green→commit per task.

**Goal:** 把 Plan 1+2+3 的能力打通成一个可启动的 speakin.cc Mission 模板 + 端到端集成测试，证明平台对一个真实长循环 Mission 是可用的（HTTP-only，知乎/掘金 推迟到 Plan 4）。

**Why this before Plan 4:** Plans 1-3 提供了"想 / 看 HTTP / 做 HTTP / 不失控"，已足够支撑 speakin.cc 这个 HTTP-only Mission（speakin 自家发文 API + GSC 数据 都是 HTTP）。Plan 4 的浏览器自动化是 nice-to-have（多渠道扩张），不是"启动第一个 Mission"的前置。先用 Plan 5 锁死 Plans 1-3 的端到端正确性，再决定 Plan 4 的优先级。

**Architecture:** 新增 `mission-templates/` 模块——用户传 `{templateId: "speakin-content"}` 时自动生成 Mission（含数据源/发布目标/初始任务/schedule rule）。新增"周循环"集成测试：模拟初始 task 完成 → owner 派 followup → followup 完成 → 触发数据源 fetch → 发布到 publish target → 验证消息流。

**Tech Stack:** TypeScript, Vitest, 现有 mission-service / data sources / publish targets / followup task机制.

---

## Tasks

### Task 1: Mission template registry + speakin template

**Files:** new `apps/server/src/mission-templates.ts` + tests; modify `mission-service.ts` to support template-based mission creation.

`mission-templates.ts` 导出:
```typescript
export interface MissionTemplate {
  id: string;
  goal: string;
  successMetrics: string[];
  constraints: string[];
  budget?: { maxRuntimeMinutes?: number; maxFollowupTasks?: number };
  dataSources?: Array<Omit<CreateMissionDataSourceInput, "missionId">>;
  publishTargets?: Array<Omit<CreateMissionPublishTargetInput, "missionId">>;
  initialFollowupHints?: string[]; // 给 LLM 的提示，但 v1 仅记录到 mission.constraints
}

export const MISSION_TEMPLATES: Record<string, MissionTemplate> = {
  "speakin-content": {
    id: "speakin-content",
    goal: "research and publish weekly content for speakin.cc to drive organic growth",
    successMetrics: [
      "weekly review of GSC keyword performance",
      "at least 1 new article published per week",
      "track article performance week-over-week",
    ],
    constraints: [
      "all content must be published to speakin.cc /api/posts",
      "GSC data must be referenced in topic selection",
    ],
    budget: { maxRuntimeMinutes: 1440, maxFollowupTasks: 30 },
    dataSources: [
      {
        name: "Google Search Console (speakin)",
        adapter: "http",
        config: {
          url: "https://www.googleapis.com/webmasters/v3/sites/speakin.cc/searchAnalytics/query",
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ startDate: "auto", endDate: "auto", dimensions: ["query"] }),
        },
      },
    ],
    publishTargets: [
      {
        name: "speakin.cc blog",
        adapter: "http",
        config: { url: "https://speakin.cc/api/posts", method: "POST" },
        contentTypes: ["*"],
      },
    ],
  },
};
```

`mission-service.ts` 新增方法 `createMissionFromTemplate({ templateId })`:
- 查 template
- 调用 `createMission` with goal/successMetrics/constraints/budget
- 调用 `addDataSource` for each
- 调用 `addPublishTarget` for each

测试要点：
- `createMissionFromTemplate({ templateId: "speakin-content" })` 创建 Mission 含 1 个数据源 + 1 个发布目标
- 未知 templateId 抛 "Unknown mission template"

Commit: `feat(mission-templates): add speakin-content template + createMissionFromTemplate method`

---

### Task 2: API endpoint for template-based creation

**Files:** `apps/server/src/api.ts` + `api.test.ts`

新增：
- `POST /api/missions/from-template` body: `{templateId: string}` → 201 with `{mission, snapshot}`
- `GET /api/mission-templates` → list of `{id, goal}` (no body)

测试要点：
- POST 创建 Mission，snapshot 包含 dataSources/publishTargets
- 未知 template → 400
- GET list 返回 speakin-content

Commit: `feat(api): expose mission template endpoints`

---

### Task 3: End-to-end integration test — speakin Mission week 1 simulation

**Files:** new `apps/server/src/speakin-mission.integration.test.ts`

模拟一个 "week 1" 场景：
1. `createMissionFromTemplate({templateId: "speakin-content"})` 启动 Mission
2. Mock fetch 返回 GSC 数据（一组关键词 + impressions）
3. Mock runtime 返回写好的 artifact 文本（长度 OK，含 "speakin"，含 source URL）
4. Owner LLM 在 review_completed 后派 followup task "Write article on top-performing keyword"
5. Followup task 自动执行（runtime 返回 article 内容）
6. Artifact 通过审核（quality eval pass）
7. **验证**：speakin /api/posts 被调用，publish attempt success
8. **验证**：GSC fetch 被调用（数据源手动触发），KnowledgeEntry 创建
9. **验证**：mission status 仍为 active（无 budget 触顶 / 无失败叫人）

这是 ROADMAP 的 Phase B Week 1 验收的"代码可验证"部分。

Commit: `test(speakin): end-to-end week 1 simulation covering Plans 1+2+3 integration`

---

### Task 4: ROADMAP update + merge

- ROADMAP.md 标 Plan 5 v1（HTTP-only Mission template + integration test）✅ 完成
- Plan 4 移到 Phase B 后期 / Phase C 选项（"看 Phase B 数据决定是否做"）
- 注：Plan 5 的"4 周观察"部分是用户运维范畴，不是代码工作；本 plan 完成 = "可启动 Mission + 集成测试通过"

Commit: `docs(roadmap): mark Plan 5 v1 (speakin template + integration) shipped, defer Plan 4 to Phase C decision`

Merge `plan-5-speakin-template` 到 master.

---

## Self-Review Checklist

### Spec coverage (vs. ROADMAP Phase B)
- ✅ Mission 配置（看 / 做 / 想 / 不失控）→ Task 1 模板涵盖 4 块
- ✅ 端到端循环 (Plans 1+2+3 集成) → Task 3
- ⚠️ 4 周观察 → 不在代码范畴，由运维 / Phase B operator 跟进
- ⚠️ 知乎/掘金 → 推迟（Plan 4 / Phase C 决定）

### Risks
1. **GSC API mocking**：真实 GSC 需要 OAuth；测试用 fake fetch 即可。生产环境的 OAuth 集成属于运维配置，不在 v1 代码范畴。
2. **speakin /api/posts mocking**：同上，测试用 fake fetch；生产环境用户提供真实 endpoint。
3. **Quality eval 关键词匹配**：runtime mock 输出必须包含 mission goal 中的关键词（"speakin"、"content"、"weekly"），否则 evaluateArtifactQuality 会 revise 而非 approve。

### Type consistency
- Template 类型复用 `CreateMissionDataSourceInput` / `CreateMissionPublishTargetInput`，与 Plan 2 类型一致。

---

## Execution Handoff

Plan saved to `docs/superpowers/plans/2026-05-10-speakin-mission-template-v1.md`.

执行：在 `plan-5-speakin-template` 分支上按 4 个 Task 顺序 TDD。Plan 4 (browser automation) 留待 Phase B 数据驱动后再决定。
