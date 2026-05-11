# Plan 2: HTTP 接入与发布基础 (HTTP Adapters v1) Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Mission 能（1）通过 HTTP 接口拉取外部数据源（GSC、用户自家接口、邮件平台等）并落到 `KnowledgeEntry`；（2）把审核通过的 artifact 自动发布到声明的 HTTP 目标。Mission 第一次"接到真实世界"。

**Architecture:** 域层（core）增加 `MissionDataSource`、`MissionPublishTarget`、`DataSourceFetchRecord`、`PublishAttempt` 类型；服务端定义 `DataSourceAdapter`/`PublishTargetAdapter` 接口与注册表；实现 HTTP 适配器（依赖注入 `fetch` 以便测试）；`InMemoryMissionService` 暴露数据源/发布目标的增删查 + 触发；artifact 审核通过后自动检查匹配的 publish targets 并发布；失败注入 owner 的 agent_notify。

**Tech Stack:** TypeScript, Vitest, 现有 mission-service / knowledge-base / api 模块。

**Scope (v1):**
- HTTP only（浏览器自动化属于 Plan 4）
- 手动触发 fetch（cadence 调度属于 Plan 2.5 / 与 Plan 3 安全机制结合后再加）
- 自动发布在 artifact 审核通过时触发
- 失败 → owner 通知（重试策略简化为最多 3 次同步重试）

---

## File Structure

### 新建
| 文件 | 责任 |
|---|---|
| `packages/core/src/data-source.ts` | `createMissionDataSource` factory + types |
| `packages/core/src/data-source.test.ts` | factory unit tests |
| `packages/core/src/publish-target.ts` | `createMissionPublishTarget` factory + types |
| `packages/core/src/publish-target.test.ts` | factory unit tests |
| `apps/server/src/data-source-adapter.ts` | `DataSourceAdapter` interface + registry + `HttpDataSourceAdapter` |
| `apps/server/src/data-source-adapter.test.ts` | adapter unit tests |
| `apps/server/src/publish-target-adapter.ts` | `PublishTargetAdapter` interface + registry + `HttpPublishTargetAdapter` |
| `apps/server/src/publish-target-adapter.test.ts` | adapter unit tests |

### 修改
| 文件 | 改什么 |
|---|---|
| `packages/core/src/types.ts` | 在 `Mission` 上加 `dataSources?` / `publishTargets?`；新增公共类型 |
| `packages/core/src/index.ts` | 导出新工厂 |
| `apps/server/src/mission-service.ts` | 增加 dataSource/publishTarget 操作方法 + auto-publish hook in submitExecutionResult 流程 |
| `apps/server/src/mission-service.test.ts` | 覆盖 fetch 与 publish 流程 |
| `apps/server/src/api.ts` | 新增 REST endpoints |
| `apps/server/src/api.test.ts` | 端到端 API 测试 |

---

## Tasks

### Task 1: Add MissionDataSource / MissionPublishTarget / fetch-record / publish-attempt types

**Files:** `packages/core/src/types.ts`, new factories + tests.

- [ ] **Step 1: Write failing tests** — `packages/core/src/data-source.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { createMissionDataSource } from "./data-source.js";

describe("createMissionDataSource", () => {
  it("creates a data source with id, default status idle, and empty fetch history", () => {
    const ds = createMissionDataSource({
      missionId: "m1",
      name: "GSC",
      adapter: "http",
      config: { url: "https://api.example.com/gsc", method: "GET" },
    });
    expect(ds.id).toMatch(/^datasource_/);
    expect(ds.missionId).toBe("m1");
    expect(ds.name).toBe("GSC");
    expect(ds.adapter).toBe("http");
    expect(ds.status).toBe("idle");
    expect(ds.fetchHistory).toEqual([]);
  });

  it("rejects empty name", () => {
    expect(() =>
      createMissionDataSource({
        missionId: "m1",
        name: " ",
        adapter: "http",
        config: { url: "https://x", method: "GET" },
      }),
    ).toThrow("name");
  });

  it("rejects empty url", () => {
    expect(() =>
      createMissionDataSource({
        missionId: "m1",
        name: "X",
        adapter: "http",
        config: { url: "", method: "GET" },
      }),
    ).toThrow("url");
  });
});
```

Same shape for `publish-target.test.ts` (creating a publish target with `config: { url, method, contentTypes }`).

- [ ] **Step 2: Run test → FAIL**: `pnpm --filter @digitalagent/core exec vitest run src/data-source.test.ts`

- [ ] **Step 3: Implement core types** — in `packages/core/src/types.ts` add:

```typescript
export type MissionDataSourceStatus = "idle" | "fetching" | "ok" | "failed";

export interface HttpDataSourceConfig {
  url: string;
  method: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
}

export interface DataSourceFetchRecord {
  id: string;
  fetchedAt: string;
  status: "ok" | "failed";
  knowledgeEntryId?: string;
  errorMessage?: string;
}

export interface MissionDataSource {
  id: string;
  missionId: string;
  name: string;
  adapter: "http";
  config: HttpDataSourceConfig;
  status: MissionDataSourceStatus;
  fetchHistory: DataSourceFetchRecord[];
  createdAt: string;
  lastFetchedAt?: string;
}

export type MissionPublishTargetStatus = "idle" | "publishing" | "ok" | "failed";

export interface HttpPublishTargetConfig {
  url: string;
  method: "POST" | "PUT";
  headers?: Record<string, string>;
  bodyTemplate?: string; // {{artifact}} placeholder
}

export interface PublishAttempt {
  id: string;
  targetId: string;
  artifactId: string;
  attemptedAt: string;
  status: "ok" | "failed";
  responseSnippet?: string;
  errorMessage?: string;
}

export interface MissionPublishTarget {
  id: string;
  missionId: string;
  name: string;
  adapter: "http";
  config: HttpPublishTargetConfig;
  status: MissionPublishTargetStatus;
  contentTypes: string[]; // artifact types this target accepts; ["*"] for all
  attempts: PublishAttempt[];
  createdAt: string;
  lastAttemptAt?: string;
}
```

Add `dataSources?: MissionDataSource[]` and `publishTargets?: MissionPublishTarget[]` to `Mission`.

- [ ] **Step 4: Implement factories**

`packages/core/src/data-source.ts`:
```typescript
import { createId } from "./ids.js";
import type { MissionDataSource, HttpDataSourceConfig } from "./types.js";

export interface CreateMissionDataSourceInput {
  missionId: string;
  name: string;
  adapter: "http";
  config: HttpDataSourceConfig;
}

export function createMissionDataSource(input: CreateMissionDataSourceInput): MissionDataSource {
  if (!input.missionId.trim()) throw new Error("missionId required");
  if (!input.name.trim()) throw new Error("data source name required");
  if (!input.config.url.trim()) throw new Error("data source url required");
  return {
    id: createId("datasource"),
    missionId: input.missionId,
    name: input.name.trim(),
    adapter: input.adapter,
    config: { ...input.config },
    status: "idle",
    fetchHistory: [],
    createdAt: new Date().toISOString(),
  };
}
```

Same shape for `publish-target.ts`.

- [ ] **Step 5: Export from index.ts**

- [ ] **Step 6: Run all tests** → GREEN. `pnpm --filter @digitalagent/core test`

- [ ] **Step 7: Commit** — `feat(core): add MissionDataSource and MissionPublishTarget domain types`

---

### Task 2: Adapter interfaces + registry

**Files:** `apps/server/src/data-source-adapter.ts`, `publish-target-adapter.ts` and tests.

- [ ] **Step 1: Write failing tests** for the registry pattern.

```typescript
import { describe, expect, it } from "vitest";
import { DataSourceAdapterRegistry } from "./data-source-adapter.js";

describe("DataSourceAdapterRegistry", () => {
  it("returns registered adapter by type", () => {
    const stub = {
      async fetch() { return { ok: true as const, data: { hello: "world" } }; },
    };
    const reg = new DataSourceAdapterRegistry();
    reg.register("stub", stub);
    expect(reg.get("stub")).toBe(stub);
  });
  it("throws when unknown type requested", () => {
    const reg = new DataSourceAdapterRegistry();
    expect(() => reg.get("unknown")).toThrow(/no adapter/i);
  });
});
```

Mirror for `PublishTargetAdapterRegistry`.

- [ ] **Step 2: Run → FAIL**

- [ ] **Step 3: Implement** the interface + registry classes (no impls yet, just the contract).

```typescript
// data-source-adapter.ts
export type DataSourceFetchResult =
  | { ok: true; data: unknown }
  | { ok: false; error: string };

export interface DataSourceAdapter {
  fetch(config: unknown): Promise<DataSourceFetchResult>;
}

export class DataSourceAdapterRegistry {
  private readonly map = new Map<string, DataSourceAdapter>();
  register(type: string, adapter: DataSourceAdapter): void {
    this.map.set(type, adapter);
  }
  get(type: string): DataSourceAdapter {
    const a = this.map.get(type);
    if (!a) throw new Error(`No adapter registered for type "${type}"`);
    return a;
  }
}
```

Mirror for publish targets.

- [ ] **Step 4: GREEN.**

- [ ] **Step 5: Commit** — `feat(adapters): add DataSourceAdapter / PublishTargetAdapter interfaces`

---

### Task 3: HttpDataSourceAdapter

**Files:** add to `data-source-adapter.ts` + tests.

- [ ] **Step 1: Write failing test**

```typescript
describe("HttpDataSourceAdapter", () => {
  it("fetches via injected fetch and returns parsed JSON", async () => {
    let called: { url: string; init?: RequestInit } | undefined;
    const fakeFetch = async (url: string, init?: RequestInit) => {
      called = { url, init };
      return new Response(JSON.stringify({ rows: [1, 2, 3] }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    };
    const adapter = new HttpDataSourceAdapter({ fetch: fakeFetch });
    const result = await adapter.fetch({ url: "https://x/api", method: "GET" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toEqual({ rows: [1, 2, 3] });
    expect(called?.url).toBe("https://x/api");
    expect(called?.init?.method).toBe("GET");
  });
  it("returns error on non-2xx", async () => {
    const fakeFetch = async () => new Response("nope", { status: 503 });
    const adapter = new HttpDataSourceAdapter({ fetch: fakeFetch });
    const result = await adapter.fetch({ url: "https://x/api", method: "GET" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/503/);
  });
  it("returns error when fetch throws", async () => {
    const fakeFetch = async () => { throw new Error("network down"); };
    const adapter = new HttpDataSourceAdapter({ fetch: fakeFetch });
    const result = await adapter.fetch({ url: "https://x", method: "GET" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("network down");
  });
});
```

- [ ] **Step 2: Run → FAIL**

- [ ] **Step 3: Implement**

```typescript
type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export class HttpDataSourceAdapter implements DataSourceAdapter {
  private readonly fetchFn: FetchFn;
  constructor(deps?: { fetch?: FetchFn }) {
    this.fetchFn = deps?.fetch ?? (globalThis.fetch as FetchFn);
  }
  async fetch(config: unknown): Promise<DataSourceFetchResult> {
    const cfg = config as { url: string; method: "GET" | "POST"; headers?: Record<string,string>; body?: string };
    if (!cfg?.url) return { ok: false, error: "missing url" };
    try {
      const init: RequestInit = { method: cfg.method, headers: cfg.headers };
      if (cfg.method === "POST" && cfg.body) init.body = cfg.body;
      const res = await this.fetchFn(cfg.url, init);
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}: ${await res.text().catch(() => "")}` };
      const ct = res.headers.get("content-type") ?? "";
      const data = ct.includes("application/json") ? await res.json() : await res.text();
      return { ok: true, data };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
}
```

- [ ] **Step 4: GREEN. Commit** — `feat(adapters): implement HttpDataSourceAdapter`

---

### Task 4: HttpPublishTargetAdapter

Mirror Task 3 for publish: takes `{url, method, headers, bodyTemplate}` config plus `payload: { artifactId, content }`. `bodyTemplate` allows `{{artifact}}` substitution; default is `JSON.stringify(payload)`. Returns response snippet on success.

- [ ] **Step 1-4:** TDD as in Task 3.

- [ ] **Step 5: Commit** — `feat(adapters): implement HttpPublishTargetAdapter`

---

### Task 5: MissionService data source ops

**Files:** `apps/server/src/mission-service.ts`, tests.

Add to MissionService:
- private `dataSourcesByMission = new Map<string, MissionDataSource[]>()`
- private `dataSourceAdapters: DataSourceAdapterRegistry` initialized with `http` -> HttpDataSourceAdapter (constructor option to override for tests)
- `addDataSource(missionId, input): MissionDataSource`
- `removeDataSource(missionId, sourceId): void`
- `listDataSources(missionId): MissionDataSource[]`
- `triggerDataSourceFetch(missionId, sourceId): Promise<DataSourceFetchRecord>` — calls adapter; on success creates `KnowledgeEntry` with `key=dataSource:{name}:{ISO timestamp}`, `value=truncated JSON.stringify(data, null, 2)` (max 8KB); on failure adds record with errorMessage and emits `agent_notify` to owner.
- Persist all to `mission-store.json`.
- Update `snapshot()` to include data sources.

- [ ] **Step 1: Write failing tests** covering happy path + failure path + persistence.

- [ ] **Step 2-4:** RED → GREEN → commit.

- [ ] **Commit** — `feat(mission-service): add data source ops + manual fetch with KnowledgeEntry creation`

---

### Task 6: MissionService publish target ops + auto-publish hook

Same shape as Task 5 but for publish targets:
- `addPublishTarget`, `removePublishTarget`, `listPublishTargets`
- `triggerPublish(missionId, targetId, artifactId): Promise<PublishAttempt>` — manual trigger
- **Auto-publish hook**: in `submitExecutionResult` after artifact is approved (review.decision === "approve"), look at `mission.publishTargets`. For each target whose `contentTypes` includes the artifact's type (or is `["*"]`), call `triggerPublish` async. Failures → owner notify (don't block approval).

- [ ] **Step 1: Write failing test for happy publish flow:**

```typescript
it("auto-publishes approved artifact to matching HTTP publish target", async () => {
  const fetched: any[] = [];
  const fakeFetch = async (url: string, init?: RequestInit) => {
    fetched.push({ url, init });
    return new Response(JSON.stringify({ id: "post-1" }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const service = new InMemoryMissionService({ runtime: makeApprovableRuntime(), fetch: fakeFetch });
  const mission = await service.createMission({ goal: "research GitHub growth metrics" });
  service.activateMission({ missionId: mission.id });
  service.addPublishTarget(mission.id, {
    name: "speakin",
    adapter: "http",
    config: { url: "https://speakin.cc/api/posts", method: "POST" },
    contentTypes: ["*"],
  });
  const initialTask = service.snapshot().tasks.find((t) => t.missionId === mission.id)!;
  service.executeTask({ missionId: mission.id, taskId: initialTask.id, message: "go" });
  for (let i = 0; i < 12; i++) await new Promise(r => setImmediate(r));

  expect(fetched.length).toBeGreaterThanOrEqual(1);
  const target = service.listPublishTargets(mission.id)[0];
  expect(target.attempts.length).toBeGreaterThanOrEqual(1);
  expect(target.attempts[0]?.status).toBe("ok");
});
```

- [ ] **Step 2-4:** RED → implement → GREEN.

- [ ] **Commit** — `feat(mission-service): add publish target ops + auto-publish on artifact approval`

---

### Task 7: API endpoints

Add to `apps/server/src/api.ts`:
- `POST /api/missions/:id/data-sources` (body: name, adapter, config) → 201 with source
- `DELETE /api/missions/:id/data-sources/:sourceId` → 204
- `GET /api/missions/:id/data-sources` → list
- `POST /api/missions/:id/data-sources/:sourceId/fetch` → triggers, returns latest record
- Same shape for publish-targets

Validate inputs (URL is well-formed, method is GET/POST or POST/PUT). Reject `*` content types if mission lacks artifact type yet.

- [ ] **Step 1-4:** TDD via `api.test.ts`. Use `handleApiRequest` directly as in existing pattern.

- [ ] **Commit** — `feat(api): expose data source and publish target REST endpoints`

---

### Task 8: ROADMAP update + manual sanity check

- [ ] **Step 1:** `pnpm test && pnpm typecheck` — all green.

- [ ] **Step 2:** Build server `pnpm build` and start `pnpm dev`. Hit `POST /api/missions/<id>/data-sources` with curl/HTTPie pointing at `https://httpbin.org/json` to confirm fetch wires through and creates a KnowledgeEntry visible in snapshot.

- [ ] **Step 3:** Update `ROADMAP.md` Plan 2 status to ✅ shipped, marking A.1 + A.2 (HTTP portion) complete. Note that scheduled cadence and browser adapters are deferred.

- [ ] **Step 4:** Commit + merge to master.

---

## Self-Review Checklist

### Spec coverage
- ✅ A.1 数据源接入: HTTP adapter + KnowledgeEntry → Tasks 1, 3, 5
- ✅ A.2 发布: HTTP adapter + auto-publish on approval → Tasks 1, 4, 6
- ✅ 失败重试 / 通知: failures emit `agent_notify` to owner (single attempt now; multi-attempt in Plan 3 safety)
- ⚠️ Deferred: scheduled cadence (待与 Plan 3 安全机制结合), browser adapter (Plan 4)
- ⚠️ Deferred: 限流处理 (Plan 3)

### Risks
1. **`globalThis.fetch` typings on Node 18+**: Should be present; if not, server already uses Node 20+ per CI. Verify before Task 3.
2. **Persistence of attempts/fetchHistory**: Data sources can grow unbounded. Cap to last 50 records per source/target.
3. **`bodyTemplate` substitution**: keep simple — just `JSON.stringify({ artifact: {...} })` v1; don't implement string templating yet.
4. **Owner notify volume**: a flaky external endpoint could spam owner. Mitigate by deduping consecutive identical errors (record `errorMessage` and don't notify again if same as last).

### Type consistency
- `MissionDataSource` defined Task 1, used Tasks 5 + 7 — consistent.
- `DataSourceAdapter` defined Task 2, used Tasks 3 + 5 — consistent.
- `PublishAttempt` defined Task 1, used Task 6.

---

## Execution Handoff

Plan saved to `docs/superpowers/plans/2026-05-10-http-adapters-v1.md`.

**Recommended approach:** Subagent-driven (one subagent per task, review at each checkpoint) given the breadth of files touched. If running inline, be aware that Tasks 5–7 require building the core package between server tests (server depends on core dist).
