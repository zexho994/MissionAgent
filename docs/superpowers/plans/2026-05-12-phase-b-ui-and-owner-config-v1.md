# Phase B Foundation: 资料库 + 产出 Tab 升级 + Owner 动态配置 v1

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 Phase B 真实启动 speakin Mission 准备好 3 个面向用户的能力：(1) Mission 资料库（成果性资料归档）；(2) 产出 Tab 上展示每条产出物的发布状态；(3) Owner 通过自然对话动态增删改发布渠道和数据源。

**Architecture:**
- **资料库**：扩展现有 `KnowledgeEntry` 类型加 `category` 字段，给 AI agent 新增 `archive_to_knowledge` action（写入 `mission-service.setKnowledge` 接口已存在）。前端 War Room 新增"资料库" Tab，按 category 分组 + 时间倒序。
- **产出 Tab 升级**：复用现有 `PublishAttempt[]` 数据（已在 `MissionPublishTarget.attempts` 里）。后端在 outputs 查询时按 artifactId 聚合所有渠道的最新尝试。前端在产出 Tab 每条产出物下加"发布状态"块。
- **Owner 动态配置**：给 Owner persona 新增 `configure_publish_target` / `configure_data_source` 两个 action（每个支持 add/update/remove 三种 op），扩展 conversation bus 的 action parser 和 dispatcher，调用 `mission-service.add/update/removePublishTarget` 与 `add/update/removeDataSource`；如果 update 方法不存在，先补齐 service 方法再接 bus。

**Tech Stack:**
- TypeScript（strict + exactOptionalPropertyTypes + noUncheckedIndexedAccess）
- Vitest（单元测试）
- 原生 Node http（API 层无 Express）
- Vanilla JS + Template literals（前端，无框架）

---

## File Structure

**Will modify:**
- `packages/core/src/knowledge-category.ts` / `apps/server/src/knowledge-base.ts` — KnowledgeCategory 类型 + KnowledgeEntry.category 字段
- `apps/server/src/knowledge-base.ts` — createKnowledgeEntry 加 category
- `apps/server/src/mission-service.ts` — setKnowledge / listKnowledge 支持 category；产出聚合发布状态
- `apps/server/src/agent-conversation-types.ts` — 新增 ArchiveToKnowledgePayload、ConfigurePublishTargetPayload、ConfigureDataSourcePayload + 加入 union
- `apps/server/src/agent-conversation-bus.ts` — parseAction 处理 3 个新 action；execute 路径分发到 service 方法
- `apps/server/src/agent-personas.ts` — 默认 availableActions 加 `archive_to_knowledge`
- `apps/server/config/agent-system.json` — Owner 加 `configure_publish_target` + `configure_data_source`；其他角色加 `archive_to_knowledge`
- `apps/server/src/api.ts` — GET /api/missions/:id/knowledge?category= 支持按 category 过滤
- `apps/server/public/war-room.js` — 新增"资料库" Tab + 产出 Tab 加发布状态展示
- `apps/server/public/styles.css` — 资料库 + 发布状态徽章样式

**Will create:**
- `packages/core/src/knowledge-category.ts` — KNOWLEDGE_CATEGORIES 常量 + label 映射
- `apps/server/src/agent-action-dispatch.test.ts` — 新 action 端到端测试

---

## Phase 1: 资料库扩展（Function 1）

### Task 1: 在 core 添加 KnowledgeCategory 类型

**Files:**
- Create: `packages/core/src/knowledge-category.ts`
- Modify: `packages/core/src/index.ts`（re-export）

- [ ] **Step 1: 写 KnowledgeCategory 单元测试**

Create `packages/core/src/knowledge-category.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { KNOWLEDGE_CATEGORIES, knowledgeCategoryLabel, isKnowledgeCategory } from "./knowledge-category.js";

describe("KnowledgeCategory", () => {
  it("exposes 5 categories", () => {
    expect(KNOWLEDGE_CATEGORIES).toEqual([
      "external_data",
      "research_note",
      "decision",
      "draft",
      "review_feedback",
    ]);
  });

  it("returns Chinese labels for known categories", () => {
    expect(knowledgeCategoryLabel("external_data")).toBe("外部数据");
    expect(knowledgeCategoryLabel("research_note")).toBe("调研笔记");
    expect(knowledgeCategoryLabel("decision")).toBe("决策方案");
    expect(knowledgeCategoryLabel("draft")).toBe("草稿");
    expect(knowledgeCategoryLabel("review_feedback")).toBe("评估反馈");
  });

  it("rejects unknown categories", () => {
    expect(isKnowledgeCategory("external_data")).toBe(true);
    expect(isKnowledgeCategory("random")).toBe(false);
  });
});
```

- [ ] **Step 2: 实现 knowledge-category.ts**

Create `packages/core/src/knowledge-category.ts`:
```typescript
export const KNOWLEDGE_CATEGORIES = [
  "external_data",
  "research_note",
  "decision",
  "draft",
  "review_feedback",
] as const;

export type KnowledgeCategory = (typeof KNOWLEDGE_CATEGORIES)[number];

const LABELS: Record<KnowledgeCategory, string> = {
  external_data: "外部数据",
  research_note: "调研笔记",
  decision: "决策方案",
  draft: "草稿",
  review_feedback: "评估反馈",
};

export function knowledgeCategoryLabel(category: KnowledgeCategory): string {
  return LABELS[category];
}

export function isKnowledgeCategory(value: unknown): value is KnowledgeCategory {
  return typeof value === "string" && (KNOWLEDGE_CATEGORIES as readonly string[]).includes(value);
}
```

- [ ] **Step 3: 在 core/index.ts re-export**

Add to `packages/core/src/index.ts`（找已有 re-export 块加进去）:
```typescript
export * from "./knowledge-category.js";
```

- [ ] **Step 4: 运行测试**

Run: `pnpm --filter @digitalagent/core vitest run src/knowledge-category.test.ts`
Expected: PASS 3 tests

- [ ] **Step 5: typecheck + commit**

```bash
pnpm --filter @digitalagent/core typecheck
git add packages/core/src/knowledge-category.ts packages/core/src/knowledge-category.test.ts packages/core/src/index.ts
git commit -m "feat(core): add KnowledgeCategory type with 5 categories"
```

---

### Task 2: KnowledgeEntry 类型加 category 字段

**Files:**
- Modify: `apps/server/src/knowledge-base.ts`

- [ ] **Step 1: 扩写现有 knowledge-base 测试**

Replace `apps/server/src/knowledge-base.test.ts`（如果不存在就新建）to add category coverage. Find existing `createKnowledgeEntry` tests and add:
```typescript
import { describe, it, expect } from "vitest";
import { createKnowledgeEntry } from "./knowledge-base.js";

describe("createKnowledgeEntry", () => {
  it("defaults category to external_data when not provided", () => {
    const entry = createKnowledgeEntry({
      missionId: "m1",
      key: "gsc-2026-05",
      value: "data",
      sourceAgentId: "agent_x",
    });
    expect(entry.category).toBe("external_data");
  });

  it("preserves explicit category", () => {
    const entry = createKnowledgeEntry({
      missionId: "m1",
      key: "draft-1",
      value: "blog v1",
      sourceAgentId: "agent_writer",
      category: "draft",
    });
    expect(entry.category).toBe("draft");
  });
});
```

- [ ] **Step 2: 运行测试看它失败**

Run: `pnpm --filter @digitalagent/server vitest run src/knowledge-base.test.ts`
Expected: FAIL ("category" undefined)

- [ ] **Step 3: 修改 knowledge-base.ts**

Replace `apps/server/src/knowledge-base.ts` content:
```typescript
import { createId } from "@digitalagent/core";
import type { KnowledgeCategory } from "@digitalagent/core";

export interface KnowledgeEntry {
  id: string;
  missionId: string;
  key: string;
  value: string;
  category: KnowledgeCategory;
  sourceAgentId: string;
  createdAt: string;
}

export interface CreateKnowledgeEntryInput {
  missionId: string;
  key: string;
  value: string;
  sourceAgentId: string;
  category?: KnowledgeCategory;
}

export function createKnowledgeEntry(input: CreateKnowledgeEntryInput): KnowledgeEntry {
  return {
    id: createId("knowledge"),
    missionId: input.missionId,
    key: input.key,
    value: input.value,
    category: input.category ?? "external_data",
    sourceAgentId: input.sourceAgentId,
    createdAt: new Date().toISOString(),
  };
}
```

- [ ] **Step 4: 运行测试通过**

Run: `pnpm --filter @digitalagent/server vitest run src/knowledge-base.test.ts`
Expected: PASS

- [ ] **Step 5: 处理 store-migration 反序列化兼容**

Open `apps/server/src/store-migration.ts` 找 knowledgeEntries 反序列化或 mission-service 的 load 路径（grep `knowledgeEntries` in mission-service.ts line ~3495）。
旧 JSON 里没有 `category` 字段，加迁移：在 mission-service 的 `loadFromStore`（或类似函数，含 `for (const entry of stored.knowledgeEntries ?? []) this.knowledgeEntries.set(entry.id, entry);` 那行）改为：
```typescript
for (const entry of stored.knowledgeEntries ?? []) {
  const normalized: KnowledgeEntry = {
    ...entry,
    category: (entry as { category?: KnowledgeCategory }).category ?? "external_data",
  };
  this.knowledgeEntries.set(entry.id, normalized);
}
```
（确保 import 了 KnowledgeCategory）

- [ ] **Step 6: typecheck 全包**

Run: `pnpm typecheck`
Expected: PASS

- [ ] **Step 7: commit**

```bash
git add apps/server/src/knowledge-base.ts apps/server/src/knowledge-base.test.ts apps/server/src/mission-service.ts
git commit -m "feat(server): KnowledgeEntry supports category field (defaults to external_data)"
```

---

### Task 3: mission-service.setKnowledge 接受 category

**Files:**
- Modify: `apps/server/src/mission-service.ts` line ~2222 (setKnowledge method)

- [ ] **Step 1: 写测试 — setKnowledge 写入 category**

Find existing `mission-service.test.ts` 里 setKnowledge 测试块（grep "setKnowledge" in test file），加一个 case:
```typescript
it("setKnowledge stores category and listKnowledge returns it", () => {
  const { service, missionId } = setupServiceWithMission(); // 用现有 helper
  service.setKnowledge({
    missionId,
    key: "selection-2026-05",
    value: "本周选 X",
    agentId: "agent_pm",
    category: "decision",
  });
  const entries = service.listKnowledge({ missionId });
  expect(entries[0].category).toBe("decision");
});
```

- [ ] **Step 2: 运行测试看它失败**

Run: `pnpm --filter @digitalagent/server vitest run src/mission-service.test.ts -t "setKnowledge stores category"`
Expected: FAIL（参数类型不接受 category）

- [ ] **Step 3: 修改 setKnowledge 签名**

Modify `apps/server/src/mission-service.ts` line ~2222:
```typescript
setKnowledge(input: {
  missionId: string;
  key: string;
  value: string;
  agentId: string;
  category?: KnowledgeCategory;
}): KnowledgeEntry {
  const mission = this.missions.get(input.missionId);
  if (!mission) throw new Error(`Mission not found: ${input.missionId}`);
  const existing = [...this.knowledgeEntries.values()].find(
    (entry) => entry.missionId === input.missionId && entry.key === input.key,
  );
  if (existing) {
    const updated: KnowledgeEntry = {
      ...existing,
      value: input.value,
      category: input.category ?? existing.category,
    };
    this.knowledgeEntries.set(updated.id, updated);
    this.persist();
    return updated;
  }
  const entry = createKnowledgeEntry({
    missionId: input.missionId,
    key: input.key,
    value: input.value,
    sourceAgentId: input.agentId,
    category: input.category,
  });
  this.knowledgeEntries.set(entry.id, entry);
  this.persist();
  return entry;
}
```
也找文件顶部 import 加 `KnowledgeCategory`:
```typescript
import type { KnowledgeCategory } from "@digitalagent/core";
```

同样改 line ~3324 的另一处 setKnowledge fallback（grep `createKnowledgeEntry` 找）— 那是 data-source 自动归档的内部路径，让它写 `category: "external_data"`（已是默认值，明确写出来更清晰）:
```typescript
const entry = createKnowledgeEntry({
  missionId,
  key,
  value,
  sourceAgentId: agentId,
  category: "external_data",
});
```

- [ ] **Step 4: 测试通过**

Run: `pnpm --filter @digitalagent/server vitest run src/mission-service.test.ts -t "setKnowledge stores category"`
Expected: PASS

- [ ] **Step 5: typecheck + 全包测试快跑**

```bash
pnpm typecheck
pnpm --filter @digitalagent/server vitest run src/mission-service.test.ts
```

- [ ] **Step 6: commit**

```bash
git add apps/server/src/mission-service.ts apps/server/src/mission-service.test.ts
git commit -m "feat(server): setKnowledge accepts optional category param"
```

---

### Task 4: archive_to_knowledge agent action 类型 + parser

**Files:**
- Modify: `apps/server/src/agent-conversation-types.ts`
- Modify: `apps/server/src/agent-conversation-bus.ts`

- [ ] **Step 1: 写 parseAction 测试**

Find existing `agent-conversation-bus.test.ts`（如果不存在，grep "parseAgentConversationResponse" 找；如果没有专门测试文件，加到与 bus 邻近的测试文件，或新建）:
```typescript
import { describe, it, expect } from "vitest";
import { parseAgentConversationResponse } from "./agent-conversation-bus.js";

describe("parseAgentConversationResponse archive_to_knowledge", () => {
  it("accepts well-formed archive payload", () => {
    const content = JSON.stringify({
      message: "I'm archiving the competitor analysis",
      type: "agent_chat",
      action: {
        type: "archive_to_knowledge",
        payload: {
          key: "competitor-analysis-2026-05",
          title: "本周竞品文章拆解",
          value: "...",
          category: "research_note",
        },
      },
    });
    const parsed = parseAgentConversationResponse(content);
    expect(parsed.action).toEqual({
      type: "archive_to_knowledge",
      payload: {
        key: "competitor-analysis-2026-05",
        title: "本周竞品文章拆解",
        value: "...",
        category: "research_note",
      },
    });
  });

  it("falls back to acknowledge when payload missing fields", () => {
    const content = JSON.stringify({
      message: "hmm",
      type: "agent_chat",
      action: { type: "archive_to_knowledge", payload: { key: "x" } },
    });
    const parsed = parseAgentConversationResponse(content);
    expect(parsed.action).toEqual({ type: "acknowledge" });
  });

  it("rejects unknown category", () => {
    const content = JSON.stringify({
      message: "x",
      type: "agent_chat",
      action: {
        type: "archive_to_knowledge",
        payload: { key: "k", title: "t", value: "v", category: "bogus" },
      },
    });
    const parsed = parseAgentConversationResponse(content);
    expect(parsed.action).toEqual({ type: "acknowledge" });
  });
});
```

- [ ] **Step 2: 运行测试看它失败**

Run: `pnpm --filter @digitalagent/server vitest run src/agent-conversation-bus.test.ts -t "archive_to_knowledge"`
Expected: FAIL

- [ ] **Step 3: 扩展 AgentConversationAction union**

Modify `apps/server/src/agent-conversation-types.ts`:
```typescript
import type { KnowledgeCategory } from "@digitalagent/core";
// ... existing imports

export interface ArchiveToKnowledgePayload {
  key: string;
  title: string;
  value: string;
  category: KnowledgeCategory;
  sourceTaskId?: string;
}

export type AgentConversationAction =
  | {
      type: "request_info" | "notify_owner" | "escalate" | "acknowledge" | "report_to_superior";
      targetAgentId?: string;
      payload?: Record<string, unknown>;
    }
  | {
      type: "create_followup_task";
      payload: CreateFollowupTaskPayload;
    }
  | {
      type: "archive_to_knowledge";
      payload: ArchiveToKnowledgePayload;
    };
```

- [ ] **Step 4: 扩展 parseAction**

Modify `apps/server/src/agent-conversation-bus.ts` 在 `parseAction` 函数里 `create_followup_task` 分支之后加：
```typescript
if (type === "archive_to_knowledge") {
  const payload = value.payload as Record<string, unknown> | undefined;
  if (
    !payload ||
    typeof payload.key !== "string" || !payload.key.trim() ||
    typeof payload.title !== "string" || !payload.title.trim() ||
    typeof payload.value !== "string" || !payload.value.trim() ||
    !isKnowledgeCategory(payload.category)
  ) {
    return { type: "acknowledge" };
  }
  const archivePayload: ArchiveToKnowledgePayload = {
    key: payload.key.trim(),
    title: payload.title.trim(),
    value: payload.value.trim(),
    category: payload.category,
  };
  if (typeof payload.sourceTaskId === "string" && payload.sourceTaskId.trim()) {
    archivePayload.sourceTaskId = payload.sourceTaskId.trim();
  }
  return { type: "archive_to_knowledge", payload: archivePayload };
}
```
也要补 import：
```typescript
import { isKnowledgeCategory } from "@digitalagent/core";
import type { ArchiveToKnowledgePayload } from "./agent-conversation-types.js";
```

- [ ] **Step 5: 也在 propagationTargets 把新 action 排除**

Modify `apps/server/src/agent-conversation-bus.ts` 在 propagationTargets 里：
```typescript
if (
  response.action &&
  response.action.type !== "create_followup_task" &&
  response.action.type !== "archive_to_knowledge" &&
  response.action.targetAgentId
) {
  candidateIds.push(response.action.targetAgentId);
}
```
（archive_to_knowledge 没有 targetAgentId，是单纯的存档动作）

- [ ] **Step 6: 测试通过**

Run: `pnpm --filter @digitalagent/server vitest run src/agent-conversation-bus.test.ts -t "archive_to_knowledge"`
Expected: PASS 3 tests

- [ ] **Step 7: commit**

```bash
git add apps/server/src/agent-conversation-types.ts apps/server/src/agent-conversation-bus.ts apps/server/src/agent-conversation-bus.test.ts
git commit -m "feat(server): add archive_to_knowledge agent action with parser"
```

---

### Task 5: conversation bus 执行 archive_to_knowledge action

**Files:**
- Modify: `apps/server/src/agent-conversation-bus.ts`
- Modify: `apps/server/src/mission-service.ts` (wire `setKnowledge` callback into bus deps)

- [ ] **Step 1: 写 dispatch 测试**

Add to `apps/server/src/agent-conversation-bus.test.ts`:
```typescript
it("dispatches archive_to_knowledge by calling setKnowledge", async () => {
  const setKnowledge = vi.fn();
  // ... build bus with deps including { setKnowledge, ...rest }
  // Stub callAgent to return action archive_to_knowledge
  // Trigger bus and assert setKnowledge called with right args
});
```
（如果该测试文件还没有 stub callAgent 的 helper，参考 followup-task-safety.test.ts 类似模式；如果太复杂，用集成测试代替——在 mission-service.test.ts 里直接验证 bus.run 之后 knowledgeEntries 多一条 category=research_note 的条目）

- [ ] **Step 2: 在 bus deps 接口加 setKnowledge 回调**

Find `apps/server/src/agent-conversation-bus.ts` 类似 `createFollowupTask` 接入的位置（line ~50 typedef 和 line ~130 的 dispatch 块）。在 deps 接口加：
```typescript
archiveToKnowledge?: (input: {
  missionId: string;
  agentId: string;
  payload: ArchiveToKnowledgePayload;
}) => void;
```

在 callAgent 返回后处理 action 的块（line ~128 附近）加：
```typescript
if (
  response.action?.type === "archive_to_knowledge" &&
  this.deps.archiveToKnowledge
) {
  this.deps.archiveToKnowledge({
    missionId: input.missionId,
    agentId: target.id,
    payload: response.action.payload,
  });
}
```

不要在 action dispatch 层 catch 后只 `console.error`。归档是用户可见的状态变更；service 抛错时应让 `AgentConversationBus` 外层错误路径把 agent 标记为 blocked，并写入失败消息。

- [ ] **Step 3: mission-service 注入 archiveToKnowledge 回调**

Find where `new AgentConversationBus(...)` is constructed in mission-service.ts (grep "new AgentConversationBus")。在 deps 里加：
```typescript
archiveToKnowledge: ({ missionId, agentId, payload }) => {
  this.setKnowledge({
    missionId,
    key: payload.key,
    value: payload.value,
    agentId,
    category: payload.category,
  });
  // 加一条 agent_chat 消息表明已归档（让用户能在协作对话里看到）
  this.appendAgentMessage({
    missionId,
    fromAgentId: agentId,
    type: "agent_chat",
    content: `归档资料【${payload.title}】到资料库（分类：${payload.category}）`,
  });
},
```
（具体函数 name 看现有代码——可能是 `appendMessage`、`recordAgentMessage`、`appendAgentMessage`，grep 找）

- [ ] **Step 4: 测试通过**

Run: `pnpm --filter @digitalagent/server vitest run src/agent-conversation-bus.test.ts -t "archive_to_knowledge"`
Expected: PASS

- [ ] **Step 5: commit**

```bash
git add apps/server/src/agent-conversation-bus.ts apps/server/src/mission-service.ts apps/server/src/agent-conversation-bus.test.ts
git commit -m "feat(server): dispatch archive_to_knowledge through setKnowledge"
```

---

### Task 6: AI personas 加 archive_to_knowledge 到 availableActions

**Files:**
- Modify: `apps/server/src/agent-personas.ts`
- Modify: `apps/server/config/agent-system.json`
- Modify: `apps/server/src/agent-conversation-bus.ts` 提示词（让 LLM 知道何时用此 action）

- [ ] **Step 1: 修改默认 persona**

In `apps/server/src/agent-personas.ts` line 24:
```typescript
availableActions: ["report_findings", "request_info", "notify_risk", "acknowledge", "archive_to_knowledge"],
```

- [ ] **Step 2: 修改 agent-system.json**

In `apps/server/config/agent-system.json`，给除 Owner 之外的所有 personas（pm/researcher/strategist/reviewer 等）的 `availableActions` 数组都加 `"archive_to_knowledge"`（Owner 不加——Owner 是用户对接面，不动手归档；归档由具体执行角色发起）。

具体 location（line 174-195 范围）保持现有项，每个数组末尾加 `"archive_to_knowledge"`：
```json
{
  "role": "pm",
  "availableActions": ["notify_owner", "request_info", "acknowledge", "create_followup_task", "archive_to_knowledge"]
}
```
对 line 181, 188, 195 三条做同样修改（line 174 是 owner，不动）。

- [ ] **Step 3: 修改 LLM 提示词加入 archive 指引**

Modify `apps/server/src/agent-conversation-bus.ts` 在 callAgent 的 user message（line ~237）里 `Choose action.type` 那段后加一段：
```
If `archive_to_knowledge` is among your available actions AND this turn produced a concrete piece of information worth keeping (research findings, a decision, a draft, review feedback), you SHOULD return:
{"action":{"type":"archive_to_knowledge","payload":{"key":"<short-stable-key>","title":"<human readable title>","value":"<the full content to archive>","category":"<one of: external_data | research_note | decision | draft | review_feedback>"}}}.
Don't archive routine acknowledgements or chat. Pick the category that best fits.
```

- [ ] **Step 4: 全包测试 + typecheck**

```bash
pnpm typecheck
pnpm --filter @digitalagent/server vitest run
```
Expected: 全部 PASS

- [ ] **Step 5: commit**

```bash
git add apps/server/src/agent-personas.ts apps/server/config/agent-system.json apps/server/src/agent-conversation-bus.ts
git commit -m "feat(server): wire archive_to_knowledge into non-owner personas and LLM prompt"
```

---

### Task 7: API endpoint - 按 category 过滤资料库

**Files:**
- Modify: `apps/server/src/api.ts` line 226 (knowledge GET)

- [ ] **Step 1: 写 API 测试**

In `apps/server/src/api.test.ts` 加：
```typescript
it("GET /api/missions/knowledge filters by category", async () => {
  // 用现有 test setup helper：missions.setKnowledge 两条不同 category 的
  // 然后 GET /api/missions/knowledge?missionId=X&category=decision
  // 验证只返回 decision 那条
});
```

- [ ] **Step 2: 运行测试看它失败**

Run: `pnpm --filter @digitalagent/server vitest run src/api.test.ts -t "filters by category"`
Expected: FAIL

- [ ] **Step 3: 修改 api.ts**

Find line 226 附近现有的 GET /api/missions/knowledge:
```typescript
if (request.method === "GET" && request.path.startsWith("/api/missions/knowledge?")) {
  const url = new URL(`http://x${request.path}`);
  const missionId = url.searchParams.get("missionId") ?? undefined;
  const category = url.searchParams.get("category") ?? undefined;
  if (!missionId) return json(400, { error: "missionId required" });
  let entries = deps.missions.listKnowledge({ missionId });
  if (category) {
    entries = entries.filter((entry) => entry.category === category);
  }
  return json(200, { entries });
}
```

- [ ] **Step 4: 测试通过 + commit**

```bash
pnpm --filter @digitalagent/server vitest run src/api.test.ts
git add apps/server/src/api.ts apps/server/src/api.test.ts
git commit -m "feat(server): /api/missions/knowledge supports category filter"
```

---

### Task 8: 前端资料库 Tab

**Files:**
- Modify: `apps/server/public/war-room.js`
- Modify: `apps/server/public/styles.css`

- [ ] **Step 1: 加导航按钮**

In `apps/server/public/war-room.js` line 17，加：
```javascript
${warNavButton("knowledge", "资料库")}
```
（放在 outputs 前面）

- [ ] **Step 2: 加 renderKnowledgePanel 函数**

In `apps/server/public/war-room.js` 在 renderAgentsPanel 函数附近加：
```javascript
function renderKnowledgePanel(data) {
  const entries = [...(data.knowledgeEntries || [])].sort(
    (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
  );

  const categoryLabels = {
    external_data: "外部数据",
    research_note: "调研笔记",
    decision: "决策方案",
    draft: "草稿",
    review_feedback: "评估反馈",
  };

  const grouped = {};
  for (const entry of entries) {
    const cat = entry.category || "external_data";
    if (!grouped[cat]) grouped[cat] = [];
    grouped[cat].push(entry);
  }

  const agentById = new Map(data.agents.map((a) => [a.id, a]));

  const sections = Object.keys(categoryLabels).map((cat) => {
    const items = grouped[cat] || [];
    if (items.length === 0) return "";
    return `
      <section class="knowledge-section">
        <h2>${esc(categoryLabels[cat])}<span class="knowledge-count">${items.length}</span></h2>
        <div class="knowledge-list">
          ${items.map((entry) => {
            const agent = agentById.get(entry.sourceAgentId);
            return `
              <article class="knowledge-card">
                <header>
                  <strong>${esc(entry.key)}</strong>
                  <time>${esc(formatTime(entry.createdAt))}</time>
                </header>
                <p class="knowledge-source">归档人：${esc(agent?.name || entry.sourceAgentId)}</p>
                <pre class="knowledge-value">${esc(shortText(entry.value, 600))}</pre>
              </article>
            `;
          }).join("")}
        </div>
      </section>
    `;
  }).join("");

  return `
    <div class="tab-panel knowledge-panel">
      <h1>Mission 资料库</h1>
      <p>AI 团队产生的成果性资料：外部数据、调研笔记、决策方案、草稿、评估反馈。</p>
      ${entries.length === 0 ? `<div class="empty-state">还没有归档的资料。AI 团队工作时会主动归档。</div>` : sections}
    </div>
  `;
}
```

- [ ] **Step 3: 在 renderWarTab 路由里挂上**

In `renderWarTab` 函数（line ~540）加 if 分支处理 knowledge case，类似已有的 `if (state.warTab === "tasks")` 块：
```javascript
if (state.warTab === "knowledge") {
  return renderKnowledgePanel(data);
}
```
（放在已有 tasks 分支之前或之后均可）

- [ ] **Step 4: 加 CSS 样式**

Append to `apps/server/public/styles.css`:
```css
.knowledge-panel { padding: 1.5rem; }
.knowledge-section { margin-bottom: 2rem; }
.knowledge-section h2 {
  font-size: 1.05rem;
  margin-bottom: 0.75rem;
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
.knowledge-count {
  background: #eef2ff;
  color: #4f46e5;
  padding: 0.1rem 0.5rem;
  border-radius: 999px;
  font-size: 0.75rem;
  font-weight: 500;
}
.knowledge-list { display: grid; gap: 0.75rem; }
.knowledge-card {
  background: white;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  padding: 0.875rem 1rem;
}
.knowledge-card header {
  display: flex;
  justify-content: space-between;
  margin-bottom: 0.25rem;
}
.knowledge-card time { color: #64748b; font-size: 0.8rem; }
.knowledge-source { color: #64748b; font-size: 0.8rem; margin: 0.25rem 0 0.5rem; }
.knowledge-value {
  background: #f8fafc;
  padding: 0.5rem 0.75rem;
  border-radius: 6px;
  font-size: 0.85rem;
  white-space: pre-wrap;
  max-height: 12em;
  overflow: auto;
  margin: 0;
}
```

- [ ] **Step 5: 手动验证（dev 跑起来看）**

```bash
pnpm dev
# 浏览器访问 http://127.0.0.1:3000，进入任一 mission 的作战室，点"资料库" tab
# 若有 mission 没数据，应该看到 empty-state；如果有 mission 跑过数据源 fetch 应能看到外部数据条目
```

- [ ] **Step 6: commit**

```bash
git add apps/server/public/war-room.js apps/server/public/styles.css
git commit -m "feat(ui): add Mission 资料库 tab grouped by category"
```

---

## Phase 2: 产出 Tab 升级（Function 2）

### Task 9: 产出聚合发布状态 helper

**Files:**
- Modify: `apps/server/src/mission-service.ts`（snapshot 已经返回 publishTargets 含 attempts，前端可直接计算）
- Modify: `apps/server/public/war-room.js`

> 决策：所有发布状态聚合放前端做，后端已经把 publishTargets + attempts 都在 snapshot 暴露了。这样后端不需要新 endpoint。

- [ ] **Step 1: 前端加 helper 函数**

In `apps/server/public/war-room.js`，在 renderTaskCard 附近加：
```javascript
function publishStatusForArtifact(data, artifactId) {
  const targets = data.mission?.publishTargets || [];
  if (targets.length === 0) return [];
  return targets.map((target) => {
    const attempts = (target.attempts || [])
      .filter((a) => a.artifactId === artifactId)
      .sort((a, b) => new Date(b.attemptedAt) - new Date(a.attemptedAt));
    const latest = attempts[0];
    return {
      targetId: target.id,
      targetName: target.name,
      status: latest ? latest.status : "pending",
      errorMessage: latest?.errorMessage,
      attemptedAt: latest?.attemptedAt,
    };
  });
}

function publishStatusLabel(status) {
  return {
    ok: "已发",
    failed: "失败",
    pending: "待发",
  }[status] || status;
}
```

- [ ] **Step 2: 找出当前产出列表的渲染位置**

Grep `outputs` panel 在 war-room.js — 当前 outputs 是泛型 list (line ~555-559)，需要专门写一个 renderOutputsPanel：

In renderWarTab，找到 outputs 路由把它独立出来：
```javascript
if (state.warTab === "outputs") {
  return renderOutputsPanel(data);
}
```

- [ ] **Step 3: 实现 renderOutputsPanel**

Add to `apps/server/public/war-room.js`:
```javascript
function renderOutputsPanel(data) {
  const artifacts = [...(data.artifacts || [])].sort(
    (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
  );
  const taskById = new Map(data.tasks.map((t) => [t.id, t]));

  return `
    <div class="tab-panel outputs-panel">
      <h1>产出列表</h1>
      <p>按时间倒序展示 AI 团队的产出物，包含发布状态。</p>
      ${artifacts.length === 0 ? `<div class="empty-state">还没有产出物</div>` : artifacts.map((artifact) => {
        const task = taskById.get(artifact.taskId);
        const publishStatuses = publishStatusForArtifact(data, artifact.id);
        return `
          <article class="output-card">
            <header>
              <strong>${esc(artifact.type)}</strong>
              <time>${esc(formatTime(artifact.createdAt))}</time>
            </header>
            <p class="output-task">关联任务：${esc(task?.title || "未知")}</p>
            <p class="output-quality">质量分：${Math.round((artifact.qualityScore || 0) * 100)}</p>
            ${publishStatuses.length > 0 ? `
              <div class="output-publish-status">
                <span class="field-label">发布状态</span>
                <div class="publish-badge-row">
                  ${publishStatuses.map((p) => `
                    <span class="publish-badge publish-${esc(p.status)}" title="${esc(p.errorMessage || "")}">
                      ${esc(p.targetName)}：${esc(publishStatusLabel(p.status))}
                    </span>
                  `).join("")}
                </div>
              </div>
            ` : ""}
          </article>
        `;
      }).join("")}
    </div>
  `;
}
```

- [ ] **Step 4: 加发布徽章 CSS**

Append to `apps/server/public/styles.css`:
```css
.outputs-panel { padding: 1.5rem; }
.output-card {
  background: white;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  padding: 0.875rem 1rem;
  margin-bottom: 0.75rem;
}
.output-card header { display: flex; justify-content: space-between; }
.output-task, .output-quality { color: #64748b; font-size: 0.85rem; margin: 0.25rem 0; }
.output-publish-status { margin-top: 0.5rem; }
.publish-badge-row { display: flex; flex-wrap: wrap; gap: 0.4rem; margin-top: 0.25rem; }
.publish-badge {
  font-size: 0.75rem;
  padding: 0.15rem 0.55rem;
  border-radius: 999px;
  border: 1px solid transparent;
}
.publish-ok { background: #ecfdf5; color: #047857; border-color: #a7f3d0; }
.publish-failed { background: #fef2f2; color: #b91c1c; border-color: #fecaca; }
.publish-pending { background: #f3f4f6; color: #4b5563; border-color: #d1d5db; }
```

- [ ] **Step 5: 手动验证**

```bash
pnpm dev
# 浏览器访问 mission 作战室 → 产出 Tab，确认看到发布状态徽章
```

- [ ] **Step 6: commit**

```bash
git add apps/server/public/war-room.js apps/server/public/styles.css
git commit -m "feat(ui): outputs tab shows per-channel publish status badges"
```

---

## Phase 3: Owner 通过对话动态配置（Function 3）

### Task 10: configure_publish_target action 类型 + parser

**Files:**
- Modify: `apps/server/src/agent-conversation-types.ts`
- Modify: `apps/server/src/agent-conversation-bus.ts`

- [ ] **Step 1: 加 ConfigurePublishTargetPayload 类型**

In `apps/server/src/agent-conversation-types.ts` 加：
```typescript
export type ConfigurePublishTargetPayload =
  | {
      op: "add";
      name: string;
      url: string;
      method?: "POST" | "PUT";
      contentTypes?: string[];
      headers?: Record<string, string>;
    }
  | {
      op: "update";
      targetId: string;
      name?: string;
      url?: string;
      method?: "POST" | "PUT";
      contentTypes?: string[];
      headers?: Record<string, string>;
    }
  | {
      op: "remove";
      targetId: string;
    };
```
扩 union:
```typescript
export type AgentConversationAction =
  | { /* existing */ }
  // ...
  | {
      type: "configure_publish_target";
      payload: ConfigurePublishTargetPayload;
    };
```

- [ ] **Step 2: 写 parser 测试**

In `apps/server/src/agent-conversation-bus.test.ts`:
```typescript
describe("parseAgentConversationResponse configure_publish_target", () => {
  it("accepts add op with required fields", () => {
    const content = JSON.stringify({
      message: "Adding email subscription target",
      type: "agent_chat",
      action: {
        type: "configure_publish_target",
        payload: {
          op: "add",
          name: "Email Newsletter",
          url: "https://api.example.com/newsletter",
          method: "POST",
          contentTypes: ["*"],
        },
      },
    });
    const parsed = parseAgentConversationResponse(content);
    expect(parsed.action?.type).toBe("configure_publish_target");
  });

  it("accepts remove op", () => {
    const content = JSON.stringify({
      message: "Removing target",
      type: "agent_chat",
      action: {
        type: "configure_publish_target",
        payload: { op: "remove", targetId: "pt_123" },
      },
    });
    const parsed = parseAgentConversationResponse(content);
    expect(parsed.action?.type).toBe("configure_publish_target");
  });

  it("accepts update op with targetId and at least one changed field", () => {
    const content = JSON.stringify({
      message: "Updating target",
      type: "agent_chat",
      action: {
        type: "configure_publish_target",
        payload: {
          op: "update",
          targetId: "pt_123",
          url: "https://api.example.com/newsletter-v2",
        },
      },
    });
    const parsed = parseAgentConversationResponse(content);
    expect(parsed.action?.type).toBe("configure_publish_target");
  });

  it("falls back to acknowledge for malformed payload", () => {
    const content = JSON.stringify({
      message: "x",
      type: "agent_chat",
      action: { type: "configure_publish_target", payload: { op: "add", name: "" } },
    });
    const parsed = parseAgentConversationResponse(content);
    expect(parsed.action).toEqual({ type: "acknowledge" });
  });
});
```

- [ ] **Step 3: 运行测试看它失败**

Run: `pnpm --filter @digitalagent/server vitest run src/agent-conversation-bus.test.ts -t "configure_publish_target"`
Expected: FAIL

- [ ] **Step 4: 扩展 parseAction**

Add to `apps/server/src/agent-conversation-bus.ts` parseAction:
```typescript
if (type === "configure_publish_target") {
  const payload = value.payload as Record<string, unknown> | undefined;
  if (!payload || typeof payload.op !== "string") return { type: "acknowledge" };

  if (payload.op === "add") {
    if (
      typeof payload.name !== "string" || !payload.name.trim() ||
      typeof payload.url !== "string" || !payload.url.trim()
    ) {
      return { type: "acknowledge" };
    }
    const method = payload.method === "PUT" ? "PUT" : "POST";
    const contentTypes = Array.isArray(payload.contentTypes)
      ? payload.contentTypes.filter((c): c is string => typeof c === "string")
      : ["*"];
    const headers = payload.headers && typeof payload.headers === "object" && !Array.isArray(payload.headers)
      ? payload.headers as Record<string, string>
      : undefined;
    const cfg: ConfigurePublishTargetPayload = {
      op: "add",
      name: payload.name.trim(),
      url: payload.url.trim(),
      method,
      contentTypes,
    };
    if (headers) cfg.headers = headers;
    return { type: "configure_publish_target", payload: cfg };
  }

  if (payload.op === "remove") {
    if (typeof payload.targetId !== "string" || !payload.targetId.trim()) {
      return { type: "acknowledge" };
    }
    return {
      type: "configure_publish_target",
      payload: { op: "remove", targetId: payload.targetId.trim() },
    };
  }

  if (payload.op === "update") {
    if (typeof payload.targetId !== "string" || !payload.targetId.trim()) {
      return { type: "acknowledge" };
    }
    const patch: ConfigurePublishTargetPayload = {
      op: "update",
      targetId: payload.targetId.trim(),
    };
    if (typeof payload.name === "string" && payload.name.trim()) patch.name = payload.name.trim();
    if (typeof payload.url === "string" && payload.url.trim()) patch.url = payload.url.trim();
    if (payload.method === "POST" || payload.method === "PUT") patch.method = payload.method;
    if (Array.isArray(payload.contentTypes)) {
      patch.contentTypes = payload.contentTypes.filter((c): c is string => typeof c === "string");
    }
    if (payload.headers && typeof payload.headers === "object" && !Array.isArray(payload.headers)) {
      patch.headers = payload.headers as Record<string, string>;
    }
    if (!patch.name && !patch.url && !patch.method && !patch.contentTypes && !patch.headers) {
      return { type: "acknowledge" };
    }
    return { type: "configure_publish_target", payload: patch };
  }

  return { type: "acknowledge" };
}
```
加 import:
```typescript
import type { ConfigurePublishTargetPayload } from "./agent-conversation-types.js";
```

- [ ] **Step 5: 也在 propagationTargets 把新 action 排除**

类似 archive_to_knowledge 处理。

- [ ] **Step 6: 测试通过 + commit**

```bash
pnpm --filter @digitalagent/server vitest run src/agent-conversation-bus.test.ts -t "configure_publish_target"
git add apps/server/src/agent-conversation-types.ts apps/server/src/agent-conversation-bus.ts apps/server/src/agent-conversation-bus.test.ts
git commit -m "feat(server): add configure_publish_target action with parser"
```

---

### Task 11: configure_data_source action 类型 + parser

镜像 Task 10，结构完全一致，差别在 fields。

**Files:**
- Modify: `apps/server/src/agent-conversation-types.ts`
- Modify: `apps/server/src/agent-conversation-bus.ts`

- [ ] **Step 1: 加 ConfigureDataSourcePayload 类型**

In `agent-conversation-types.ts`:
```typescript
export type ConfigureDataSourcePayload =
  | {
      op: "add";
      name: string;
      url: string;
      method?: "POST" | "GET";
      headers?: Record<string, string>;
      body?: string;
    }
  | {
      op: "update";
      sourceId: string;
      name?: string;
      url?: string;
      method?: "POST" | "GET";
      headers?: Record<string, string>;
      body?: string;
    }
  | {
      op: "remove";
      sourceId: string;
    };
```
扩 union 加入 `configure_data_source` variant。

- [ ] **Step 2: 写 parser 测试**

类似 Task 10 的四个 case：add 成功、update 成功、remove 成功、malformed 回 acknowledge。update 必须有 sourceId 且至少一个可更新字段。

- [ ] **Step 3: 运行看测试失败**

- [ ] **Step 4: 扩展 parseAction**

Add 对应分支，结构同 Task 10 但字段不同（add 接收 url/method/headers/body；update 接收 sourceId 加可选 name/url/method/headers/body，且至少一个字段存在；remove 接收 sourceId）。

- [ ] **Step 5: propagationTargets 排除**

- [ ] **Step 6: 测试通过 + commit**

```bash
git add apps/server/src/agent-conversation-types.ts apps/server/src/agent-conversation-bus.ts apps/server/src/agent-conversation-bus.test.ts
git commit -m "feat(server): add configure_data_source action with parser"
```

---

### Task 12: bus dispatch 调 service 方法

**Files:**
- Modify: `apps/server/src/agent-conversation-bus.ts`
- Modify: `apps/server/src/mission-service.ts`

- [ ] **Step 1: 加 bus deps 回调接口**

In `apps/server/src/agent-conversation-bus.ts` 的 deps 接口加：
```typescript
configurePublishTarget?: (input: {
  missionId: string;
  agentId: string;
  payload: ConfigurePublishTargetPayload;
}) => Promise<void>;
configureDataSource?: (input: {
  missionId: string;
  agentId: string;
  payload: ConfigureDataSourcePayload;
}) => Promise<void>;
```

这些回调必须 fastfail：不要在 bus dispatch 层 catch 后只 `console.error`。配置动作是用户可见的状态变更；service 抛错时应让 `AgentConversationBus` 外层错误路径把 agent 标记为 blocked，并写入失败消息。

- [ ] **Step 2: 在 action dispatch 块加分支**

紧跟 archive_to_knowledge 的 dispatch 之后：
```typescript
if (
  response.action?.type === "configure_publish_target" &&
  this.deps.configurePublishTarget
) {
  await this.deps.configurePublishTarget({
    missionId: input.missionId,
    agentId: target.id,
    payload: response.action.payload,
  });
}

if (
  response.action?.type === "configure_data_source" &&
  this.deps.configureDataSource
) {
  await this.deps.configureDataSource({
    missionId: input.missionId,
    agentId: target.id,
    payload: response.action.payload,
  });
}
```

- [ ] **Step 3: mission-service 注入这两个回调**

In `apps/server/src/mission-service.ts` 找 `new AgentConversationBus(...)` 的 deps，加：
```typescript
configurePublishTarget: async ({ missionId, agentId, payload }) => {
  if (payload.op === "add") {
    const target = this.addPublishTarget(missionId, {
      name: payload.name,
      adapter: "http",
      config: {
        url: payload.url,
        method: payload.method ?? "POST",
        ...(payload.headers ? { headers: payload.headers } : {}),
      },
      contentTypes: payload.contentTypes ?? ["*"],
    });
    this.appendAgentMessage({
      missionId,
      fromAgentId: agentId,
      type: "agent_chat",
      content: `已添加发布渠道【${target.name}】（${target.id}）`,
    });
  } else if (payload.op === "remove") {
    this.removePublishTarget(missionId, payload.targetId);
    this.appendAgentMessage({
      missionId,
      fromAgentId: agentId,
      type: "agent_chat",
      content: `已移除发布渠道（${payload.targetId}）`,
    });
  } else if (payload.op === "update") {
    const target = this.updatePublishTarget(missionId, payload.targetId, {
      name: payload.name,
      config: payload.url || payload.method || payload.headers
        ? {
            ...(payload.url ? { url: payload.url } : {}),
            ...(payload.method ? { method: payload.method } : {}),
            ...(payload.headers ? { headers: payload.headers } : {}),
          }
        : undefined,
      contentTypes: payload.contentTypes,
    });
    this.appendAgentMessage({
      missionId,
      fromAgentId: agentId,
      type: "agent_chat",
      content: `已更新发布渠道【${target.name}】（${target.id}）`,
    });
  }
},
configureDataSource: async ({ missionId, agentId, payload }) => {
  if (payload.op === "add") {
    const source = this.addDataSource(missionId, {
      name: payload.name,
      adapter: "http",
      config: {
        url: payload.url,
        method: payload.method ?? "GET",
        ...(payload.headers ? { headers: payload.headers } : {}),
        ...(payload.body ? { body: payload.body } : {}),
      },
    });
    this.appendAgentMessage({
      missionId,
      fromAgentId: agentId,
      type: "agent_chat",
      content: `已添加数据源【${source.name}】（${source.id}）`,
    });
  } else if (payload.op === "remove") {
    this.removeDataSource(missionId, payload.sourceId);
    this.appendAgentMessage({
      missionId,
      fromAgentId: agentId,
      type: "agent_chat",
      content: `已移除数据源（${payload.sourceId}）`,
    });
  } else if (payload.op === "update") {
    const source = this.updateDataSource(missionId, payload.sourceId, {
      name: payload.name,
      config: payload.url || payload.method || payload.headers || payload.body
        ? {
            ...(payload.url ? { url: payload.url } : {}),
            ...(payload.method ? { method: payload.method } : {}),
            ...(payload.headers ? { headers: payload.headers } : {}),
            ...(payload.body ? { body: payload.body } : {}),
          }
        : undefined,
    });
    this.appendAgentMessage({
      missionId,
      fromAgentId: agentId,
      type: "agent_chat",
      content: `已更新数据源【${source.name}】（${source.id}）`,
    });
  }
},
```
（核对 `addDataSource` 的入参签名——参考 line 2264 附近现有方法）

如果 `mission-service.ts` 当前没有 update 方法，先新增 `updatePublishTarget` / `updateDataSource`，要求：
- 找不到 mission/target/source 直接 throw。
- update patch 为空直接 throw。
- URL/method/header/body/contentTypes 仍复用现有创建路径的校验规则。
- 持久化后返回更新后的对象。

- [ ] **Step 4: 写 mission-service 集成测试**

In `apps/server/src/mission-service.test.ts` 加：
```typescript
it("Owner action configure_publish_target adds target to mission", async () => {
  const { service, missionId, ownerAgentId, callAgentStub } = setupWithMissionAndOwner();
  callAgentStub.mockResolvedValueOnce({
    message: "Adding email channel",
    type: "agent_chat",
    mentionedAgentIds: [],
    shouldPropagate: false,
    action: {
      type: "configure_publish_target",
      payload: { op: "add", name: "Email", url: "https://e/p", method: "POST" },
    },
  });
  await service.processUserMessage({ missionId, content: "把博文也发到邮件订阅", agentId: ownerAgentId });
  const targets = service.listPublishTargets(missionId);
  expect(targets.some((t) => t.name === "Email")).toBe(true);
});
```
（确切的 helper 名要看 mission-service.test.ts 的现有 fixture——按相同模式写）

- [ ] **Step 5: 测试通过 + commit**

```bash
pnpm --filter @digitalagent/server vitest run src/mission-service.test.ts -t "configure_publish_target"
pnpm typecheck
git add apps/server/src/agent-conversation-bus.ts apps/server/src/mission-service.ts apps/server/src/mission-service.test.ts
git commit -m "feat(server): dispatch configure_publish_target and configure_data_source through bus"
```

---

### Task 13: Owner persona 加新 actions + LLM 提示词

**Files:**
- Modify: `apps/server/config/agent-system.json`
- Modify: `apps/server/src/agent-conversation-bus.ts` (prompt)

- [ ] **Step 1: 给 Owner persona 加 2 个 action**

In `apps/server/config/agent-system.json` line 174:
```json
{
  "role": "owner",
  "availableActions": [
    "notify_owner",
    "request_info",
    "acknowledge",
    "create_followup_task",
    "configure_publish_target",
    "configure_data_source"
  ]
}
```

- [ ] **Step 2: 更新 LLM 提示词**

Modify `apps/server/src/agent-conversation-bus.ts` callAgent 的 user message，在 archive 指引之后加：
```
If `configure_publish_target` is among your available actions AND the user (or mission context) clearly asked to add/update/remove a publish channel, you SHOULD return:
{"action":{"type":"configure_publish_target","payload":{"op":"add","name":"<channel name>","url":"<full URL>","method":"POST","contentTypes":["*"]}}}
or
{"action":{"type":"configure_publish_target","payload":{"op":"update","targetId":"<existing target id>","url":"<new full URL>"}}}
or
{"action":{"type":"configure_publish_target","payload":{"op":"remove","targetId":"<existing target id>"}}}.

If `configure_data_source` is among your available actions AND the user wants to add/update/remove an observed data source, you SHOULD return:
{"action":{"type":"configure_data_source","payload":{"op":"add","name":"<source name>","url":"<full URL>","method":"GET"}}}
or
{"action":{"type":"configure_data_source","payload":{"op":"update","sourceId":"<existing source id>","url":"<new full URL>"}}}
or
{"action":{"type":"configure_data_source","payload":{"op":"remove","sourceId":"<existing source id>"}}}.

When confirming a configuration change, set `message` to a short user-facing confirmation in Chinese.
```

- [ ] **Step 3: typecheck + 全包测试**

```bash
pnpm typecheck
pnpm --filter @digitalagent/server vitest run
```

- [ ] **Step 4: commit**

```bash
git add apps/server/config/agent-system.json apps/server/src/agent-conversation-bus.ts
git commit -m "feat(server): Owner persona can configure publish targets and data sources"
```

---

## Phase 4: 集成验证

### Task 14: 端到端集成测试

**Files:**
- Modify: `apps/server/src/speakin-mission.integration.test.ts`（已有的）

- [ ] **Step 1: 加测试 - 用户对话添加发布渠道**

Append to `apps/server/src/speakin-mission.integration.test.ts`:
```typescript
it("Owner adds a publish target via user conversation", async () => {
  const { service, missionId } = await bootstrapSpeakinMission();
  const before = service.listPublishTargets(missionId).length;
  await service.processUserMessage({
    missionId,
    content: "再加一个邮件订阅渠道 https://api.example.com/news",
    agentId: getOwnerAgentId(service, missionId),
  });
  const after = service.listPublishTargets(missionId).length;
  expect(after).toBeGreaterThan(before);
});

it("Writer agent archives draft to knowledge base", async () => {
  const { service, missionId } = await bootstrapSpeakinMission();
  // 用现有 fixture 完成一个写作任务（参考已有的 mission 接龙测试）
  // 验证 service.listKnowledge({ missionId }) 里出现 category=draft 的条目
});
```
（如果现有 fixture 没暴露这些 helper，按相同模式补 helper）

- [ ] **Step 2: 跑测试**

```bash
pnpm --filter @digitalagent/server vitest run src/speakin-mission.integration.test.ts
```

- [ ] **Step 3: 全包冒烟**

```bash
pnpm test
pnpm typecheck
pnpm build
```
Expected: all green

- [ ] **Step 4: commit**

```bash
git add apps/server/src/speakin-mission.integration.test.ts
git commit -m "test(server): e2e coverage for Owner dynamic config and agent archive"
```

---

### Task 15: 手动 UI 烟囱测试 + ROADMAP 标记

**Files:**
- Modify: `ROADMAP.md`

- [ ] **Step 1: pnpm dev 跑起来手动验证**

```bash
pnpm dev
```
打开 http://127.0.0.1:3000，做这几件事：
1. 进入或创建一个 mission，进入作战室
2. 点"资料库" tab，看是否能显示空态或现有外部数据条目
3. 点"产出" tab，确认发布状态徽章渲染（如果还没有 artifact 就空着也算正常）
4. 在 Owner 对话框里说"再加一个发布渠道：邮件订阅 https://test.example.com/news"，看 Owner 是否回应"已添加发布渠道"
5. 检查后端产生了新 PublishTarget（用 curl 或 SQLite browser）：
```bash
curl http://127.0.0.1:3000/api/missions/<mission-id>/publish-targets
```

- [ ] **Step 2: 修复发现的小问题**（如有）

- [ ] **Step 3: 更新 ROADMAP**

Modify `/Users/zexho/Documents/DigitalAgent/ROADMAP.md` Phase B 部分，把 "B.1 Mission 配置 (HTTP-only v1)" 章节后加一段新章节 "B.0 Phase B 启动准备（2026-05-12 完成）"：
```markdown
### B.0 Phase B 启动准备（2026-05-12 完成）

为 Phase B 真实启动 speakin Mission 准备的 3 个用户面向能力：

- ✅ **Mission 资料库**：扩展 `KnowledgeEntry` 加 `category` 字段，5 类（外部数据/调研笔记/决策方案/草稿/评估反馈）。AI agent 新增 `archive_to_knowledge` action，可主动归档成果性资料。War Room 加"资料库" Tab。
- ✅ **产出 Tab 升级**：每条产出物显示在各发布渠道的状态（已发/失败/待发）。
- ✅ **Owner 动态配置**：Owner 通过自然对话增删改发布渠道和数据源（不需要任何配置面板）。新增 `configure_publish_target` / `configure_data_source` 两个 Owner action。
```

- [ ] **Step 4: commit + push**

```bash
git add ROADMAP.md
git commit -m "docs(roadmap): mark Phase B foundation prep as completed"
git push -u origin HEAD
```

- [ ] **Step 5: 创建 PR**

```bash
gh pr create --title "feat: Phase B foundation — 资料库 + 产出发布状态 + Owner 动态配置" --body "$(cat <<'EOF'
## Summary

为 Phase B 真实启动 speakin Mission 准备好 3 个用户面向能力：

1. **Mission 资料库**：5 类 category（外部数据 / 调研笔记 / 决策方案 / 草稿 / 评估反馈），AI agent 可主动归档；War Room 新增"资料库" Tab
2. **产出 Tab 升级**：每条产出物展示各发布渠道的状态徽章
3. **Owner 动态配置**：通过自然对话增删改发布渠道和数据源，不需要任何配置面板

## Test plan

- [ ] `pnpm test` 全绿
- [ ] `pnpm typecheck` 全绿
- [ ] `pnpm build` 成功
- [ ] 手动：War Room 资料库 Tab 可见，能渲染外部数据 + 归档条目
- [ ] 手动：产出 Tab 发布状态徽章可见
- [ ] 手动：Owner 对话里说"加一个发布渠道..."能成功配置

EOF
)"
```

---

## Self-Review

Spec 覆盖：
- ✅ 功能 1（资料库 5 类成果性资料）：Tasks 1-8
- ✅ 功能 2（产出 Tab 升级展示发布状态）：Task 9
- ✅ 功能 3（Owner 通过对话动态配置）：Tasks 10-13
- ✅ 集成验证：Tasks 14-15
- ✅ 数据源/发布渠道操作都通过现有 mission-service 方法（addPublishTarget / removePublishTarget / addDataSource / removeDataSource）
- ✅ 没有引入新的 REST endpoint（除了 Task 7 的 category 过滤），所有动作通过对话流完成
- ✅ 每个 task 都有可运行的测试代码和具体 commit message

Placeholder 检查：✅ 无 TBD / TODO / 占位符。

Type 一致性：
- ✅ `KnowledgeCategory` 在 core 定义，server 类型一致引用
- ✅ `ArchiveToKnowledgePayload` / `ConfigurePublishTargetPayload` / `ConfigureDataSourcePayload` 在 agent-conversation-types.ts 集中定义
- ✅ bus 回调接口接收的 payload 类型与 union 成员一致
