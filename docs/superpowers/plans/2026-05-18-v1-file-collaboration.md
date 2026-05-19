# V1 文件协作与任务接力 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 5 个 agent 通过 `file_read` / `file_write` 共享 `chain.txt`,通过 `pass_to_next_agent` 接力完成 15 轮成语接龙(roadmap V1-1)。

**Architecture:** 在 `@digitalagent/runtime` 新增两个工具(文件 IO + 任务接力);`MissionService` 在每次 `executeTask` 时 per-call 注入这两个工具(带 missionId / sourceTaskId / sourceAgentId 闭包);工具清单沉到现有 skill 文档(file-io.md、agent-collaboration.md),prompt 不硬编码具体工具名;Agents tab 增加"工具操作流水"卡片。

**Tech Stack:** TypeScript / pnpm workspace / Vitest / pi-agent-core(`@earendil-works/pi-agent-core`)/ TypeBox(`@earendil-works/pi-ai` 的 `Type`)

**Spec:** `docs/superpowers/specs/2026-05-18-v1-file-collaboration-design.md`

---

## Phase 1: Runtime 工具(独立可测)

### Task 1: 文件 IO 工具

**Files:**
- Create: `packages/runtime/src/pi-extensions/file-io.ts`
- Create: `packages/runtime/src/pi-extensions/file-io.test.ts`
- Modify: `packages/runtime/src/index.ts`

- [ ] **Step 1: 写失败测试**

创建 `packages/runtime/src/pi-extensions/file-io.test.ts`:

```typescript
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { createFileTools } from "./file-io.js";

describe("file-io tools", () => {
  let workspaceRoot: string;

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), "digitalagent-fileio-"));
  });

  afterEach(() => {
    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  function getTool(name: string) {
    const tools = createFileTools({ workspaceRoot });
    const tool = tools.find((t) => t.name === name);
    if (!tool) throw new Error(`Tool not found: ${name}`);
    return tool;
  }

  describe("file_write", () => {
    it("creates workspace dir lazily on first write and writes content", async () => {
      const tool = getTool("file_write");
      const result = await tool.execute("call-1", { path: "chain.txt", content: "信马由缰\n" });

      const written = readFileSync(join(workspaceRoot, "chain.txt"), "utf8");
      expect(written).toBe("信马由缰\n");
      expect(result.details).toMatchObject({ bytesWritten: expect.any(Number), path: "chain.txt" });
    });

    it("appends when mode is 'append'", async () => {
      const tool = getTool("file_write");
      await tool.execute("c1", { path: "chain.txt", content: "信马由缰\n" });
      await tool.execute("c2", { path: "chain.txt", content: "缰绳万缕\n", mode: "append" });

      const written = readFileSync(join(workspaceRoot, "chain.txt"), "utf8");
      expect(written).toBe("信马由缰\n缰绳万缕\n");
    });

    it("overwrites by default", async () => {
      const tool = getTool("file_write");
      await tool.execute("c1", { path: "chain.txt", content: "old\n" });
      await tool.execute("c2", { path: "chain.txt", content: "new\n" });

      const written = readFileSync(join(workspaceRoot, "chain.txt"), "utf8");
      expect(written).toBe("new\n");
    });

    it("rejects absolute paths", async () => {
      const tool = getTool("file_write");
      const result = await tool.execute("c1", { path: "/etc/passwd", content: "x" });
      expect(JSON.stringify(result)).toMatch(/path/i);
      expect(JSON.stringify(result)).toMatch(/absolute|relative/i);
    });

    it("rejects parent directory traversal", async () => {
      const tool = getTool("file_write");
      const result = await tool.execute("c1", { path: "../escaped.txt", content: "x" });
      expect(JSON.stringify(result)).toMatch(/path/i);
    });

    it("rejects content over 1 MB", async () => {
      const tool = getTool("file_write");
      const huge = "x".repeat(1_048_577);
      const result = await tool.execute("c1", { path: "big.txt", content: huge });
      expect(JSON.stringify(result)).toMatch(/size|large|limit/i);
    });

    it("rejects when workspace already contains 100 files", async () => {
      mkdirSync(workspaceRoot, { recursive: true });
      for (let i = 0; i < 100; i++) {
        writeFileSync(join(workspaceRoot, `f${i}.txt`), "x");
      }
      const tool = getTool("file_write");
      const result = await tool.execute("c1", { path: "overflow.txt", content: "y" });
      expect(JSON.stringify(result)).toMatch(/file.*limit|too many/i);
    });
  });

  describe("file_read", () => {
    it("returns exists:false when file missing (no throw)", async () => {
      const tool = getTool("file_read");
      const result = await tool.execute("c1", { path: "missing.txt" });
      expect(result.details).toMatchObject({ exists: false, content: "", sizeBytes: 0 });
    });

    it("returns content and size when file exists", async () => {
      mkdirSync(workspaceRoot, { recursive: true });
      writeFileSync(join(workspaceRoot, "chain.txt"), "信马由缰\n");
      const tool = getTool("file_read");
      const result = await tool.execute("c1", { path: "chain.txt" });

      expect(result.details).toMatchObject({
        exists: true,
        content: "信马由缰\n",
        sizeBytes: Buffer.byteLength("信马由缰\n", "utf8"),
      });
    });

    it("rejects absolute paths", async () => {
      const tool = getTool("file_read");
      const result = await tool.execute("c1", { path: "/etc/passwd" });
      expect(JSON.stringify(result)).toMatch(/path/i);
    });

    it("rejects parent traversal", async () => {
      const tool = getTool("file_read");
      const result = await tool.execute("c1", { path: "../etc/passwd" });
      expect(JSON.stringify(result)).toMatch(/path/i);
    });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @digitalagent/runtime vitest run src/pi-extensions/file-io.test.ts`
Expected: 全部 FAIL,"Cannot find module './file-io.js'"

- [ ] **Step 3: 写实现**

创建 `packages/runtime/src/pi-extensions/file-io.ts`:

```typescript
/**
 * File IO pi extension — mission-scoped workspace read/write.
 *
 * Two tools:
 * - `file_write({ path, content, mode? })` — write text content to a path
 *   inside the workspace. `mode` is "overwrite" (default) or "append".
 * - `file_read({ path })` — read text content; returns `{ exists: false }`
 *   without throwing if the file does not exist.
 *
 * Sandboxed: paths must be relative, resolved path must remain inside
 * `workspaceRoot`. Caps: 1 MB per call, 100 files per workspace.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, appendFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep, dirname } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";

const MAX_BYTES_PER_CALL = 1_048_576; // 1 MB
const MAX_FILES_PER_WORKSPACE = 100;

export interface FileToolOptions {
  workspaceRoot: string;
}

const FileWriteParameters = Type.Object({
  path: Type.String({ description: "Relative path inside the mission workspace, e.g. 'chain.txt'." }),
  content: Type.String({ description: "Text content to write." }),
  mode: Type.Optional(Type.Union([Type.Literal("overwrite"), Type.Literal("append")], {
    description: "Write mode. 'overwrite' (default) replaces file; 'append' adds to the end.",
  })),
});

const FileReadParameters = Type.Object({
  path: Type.String({ description: "Relative path inside the mission workspace." }),
});

function validateRelativePath(rawPath: string, workspaceRoot: string): { ok: true; absolute: string } | { ok: false; error: string } {
  if (typeof rawPath !== "string" || rawPath.trim() === "") {
    return { ok: false, error: "path must be a non-empty string" };
  }
  if (isAbsolute(rawPath)) {
    return { ok: false, error: "path must be relative to the workspace (absolute paths are rejected)" };
  }
  if (rawPath.split(/[\\/]+/).includes("..")) {
    return { ok: false, error: "path cannot contain parent traversal ('..')" };
  }
  const absolute = resolve(workspaceRoot, rawPath);
  const rel = relative(workspaceRoot, absolute);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    return { ok: false, error: "resolved path escapes workspace root" };
  }
  return { ok: true, absolute };
}

function countWorkspaceFiles(workspaceRoot: string): number {
  if (!existsSync(workspaceRoot)) return 0;
  let count = 0;
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) count += 1;
    }
  };
  walk(workspaceRoot);
  return count;
}

function errorResult(message: string): { content: { type: "text"; text: string }[]; details: Record<string, unknown> } {
  return {
    content: [{ type: "text", text: JSON.stringify({ ok: false, error: message }) }],
    details: { ok: false, error: message },
  };
}

export function createFileTools(options: FileToolOptions): AgentTool<any>[] {
  const { workspaceRoot } = options;

  const writeTool: AgentTool<typeof FileWriteParameters> = {
    name: "file_write",
    label: "File Write",
    description:
      "Write text content to a file in the mission workspace. Path must be relative (e.g. 'chain.txt'). Mode is 'overwrite' (default) or 'append'. Max 1 MB per call, max 100 files per workspace.",
    parameters: FileWriteParameters,
    async execute(_toolCallId, params: any) {
      const validation = validateRelativePath(params.path, workspaceRoot);
      if (!validation.ok) return errorResult(validation.error);

      const content: string = params.content ?? "";
      const byteLength = Buffer.byteLength(content, "utf8");
      if (byteLength > MAX_BYTES_PER_CALL) {
        return errorResult(`content size ${byteLength} exceeds the per-call limit of ${MAX_BYTES_PER_CALL} bytes (1 MB)`);
      }

      const mode = params.mode === "append" ? "append" : "overwrite";

      const existedBefore = existsSync(validation.absolute);
      if (!existedBefore) {
        const currentCount = countWorkspaceFiles(workspaceRoot);
        if (currentCount >= MAX_FILES_PER_WORKSPACE) {
          return errorResult(`workspace already contains ${currentCount} files (limit ${MAX_FILES_PER_WORKSPACE}); refuse to create more`);
        }
      }

      mkdirSync(dirname(validation.absolute), { recursive: true });
      if (mode === "append") {
        appendFileSync(validation.absolute, content, "utf8");
      } else {
        writeFileSync(validation.absolute, content, "utf8");
      }

      const finalSize = statSync(validation.absolute).size;
      const details = { ok: true, bytesWritten: byteLength, path: params.path, totalSizeBytes: finalSize, mode };
      return {
        content: [{ type: "text", text: JSON.stringify(details) }],
        details,
      };
    },
  };

  const readTool: AgentTool<typeof FileReadParameters> = {
    name: "file_read",
    label: "File Read",
    description:
      "Read text content from a file in the mission workspace. Returns { exists: false, content: '', sizeBytes: 0 } if the file does not exist (does not throw). Max 1 MB per read.",
    parameters: FileReadParameters,
    async execute(_toolCallId, params: any) {
      const validation = validateRelativePath(params.path, workspaceRoot);
      if (!validation.ok) return errorResult(validation.error);

      if (!existsSync(validation.absolute)) {
        const details = { ok: true, exists: false, content: "", sizeBytes: 0, path: params.path };
        return {
          content: [{ type: "text", text: JSON.stringify(details) }],
          details,
        };
      }

      const stat = statSync(validation.absolute);
      if (stat.size > MAX_BYTES_PER_CALL) {
        return errorResult(`file size ${stat.size} exceeds the per-call limit of ${MAX_BYTES_PER_CALL} bytes (1 MB)`);
      }

      const content = readFileSync(validation.absolute, "utf8");
      const details = { ok: true, exists: true, content, sizeBytes: stat.size, path: params.path };
      return {
        content: [{ type: "text", text: JSON.stringify(details) }],
        details,
      };
    },
  };

  return [readTool, writeTool];
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @digitalagent/runtime vitest run src/pi-extensions/file-io.test.ts`
Expected: 全部 PASS(10 个 case)

- [ ] **Step 5: 在 runtime index 导出**

修改 `packages/runtime/src/index.ts`,在第 9 行 `createSkillTools` 那行后追加:

```typescript
export { createFileTools } from "./pi-extensions/file-io.js";
export type { FileToolOptions } from "./pi-extensions/file-io.js";
```

- [ ] **Step 6: 跑全 runtime 测试 + typecheck**

Run: `pnpm --filter @digitalagent/runtime test && pnpm --filter @digitalagent/runtime typecheck`
Expected: 全部 PASS

- [ ] **Step 7: Commit**

```bash
git add packages/runtime/src/pi-extensions/file-io.ts packages/runtime/src/pi-extensions/file-io.test.ts packages/runtime/src/index.ts
git commit -m "feat(runtime): add file_read/file_write tools with workspace sandbox"
```

---

### Task 2: 任务接力工具

**Files:**
- Create: `packages/runtime/src/pi-extensions/agent-handoff.ts`
- Create: `packages/runtime/src/pi-extensions/agent-handoff.test.ts`
- Modify: `packages/runtime/src/index.ts`

- [ ] **Step 1: 写失败测试**

创建 `packages/runtime/src/pi-extensions/agent-handoff.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";
import { createPassToNextAgentTool } from "./agent-handoff.js";

describe("createPassToNextAgentTool", () => {
  function makeDeps(overrides: Partial<Parameters<typeof createPassToNextAgentTool>[0]> = {}) {
    return {
      missionId: "mission-1",
      sourceTaskId: "task-1",
      sourceAgentId: "agent-1",
      createFollowupTask: vi.fn(async () => ({ created: true as const, taskId: "task-2" })),
      appendMessage: vi.fn(() => undefined),
      ...overrides,
    };
  }

  it("calls createFollowupTask with payload mapped from params", async () => {
    const deps = makeDeps();
    const tool = createPassToNextAgentTool(deps);

    const result = await tool.execute("call-99", {
      nextRole: "玩家2",
      objective: "继续接龙,首字'缰'",
      reason: "我接了'信马由缰'",
      inputContext: { lastIdiom: "信马由缰", chainLength: 3 },
    });

    expect(deps.createFollowupTask).toHaveBeenCalledTimes(1);
    const payload = deps.createFollowupTask.mock.calls[0]![0];
    expect(payload).toMatchObject({
      missionId: "mission-1",
      triggeringEventId: "handoff:task-1:call-99",
      payload: {
        objective: "继续接龙,首字'缰'",
        assigneeRole: "玩家2",
        reason: "我接了'信马由缰'",
        sourceTaskId: "task-1",
        inputContext: { lastIdiom: "信马由缰", chainLength: 3 },
      },
    });
    expect(result.details).toMatchObject({ created: true, taskId: "task-2" });
  });

  it("appends an agent_chat message describing the handoff", async () => {
    const deps = makeDeps();
    const tool = createPassToNextAgentTool(deps);

    await tool.execute("call-1", {
      nextRole: "玩家2",
      objective: "x",
      reason: "我做完了",
    });

    expect(deps.appendMessage).toHaveBeenCalledTimes(1);
    const msg = deps.appendMessage.mock.calls[0]![0];
    expect(msg).toMatchObject({
      missionId: "mission-1",
      fromAgentId: "agent-1",
      type: "agent_chat",
    });
    expect(msg.content).toContain("玩家2");
    expect(msg.content).toContain("我做完了");
  });

  it("returns failure result when createFollowupTask refuses (no_assignee)", async () => {
    const deps = makeDeps({
      createFollowupTask: vi.fn(async () => ({
        created: false as const,
        reason: "no_assignee" as const,
        escalateMessageSent: true,
      })),
    });
    const tool = createPassToNextAgentTool(deps);

    const result = await tool.execute("c1", { nextRole: "不存在的角色", objective: "x", reason: "y" });
    expect(result.details).toMatchObject({ created: false, reason: "no_assignee" });
  });

  it("uses empty inputContext when not provided", async () => {
    const deps = makeDeps();
    const tool = createPassToNextAgentTool(deps);

    await tool.execute("c1", { nextRole: "玩家2", objective: "x", reason: "y" });

    const payload = deps.createFollowupTask.mock.calls[0]![0];
    expect(payload.payload.inputContext).toEqual({});
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @digitalagent/runtime vitest run src/pi-extensions/agent-handoff.test.ts`
Expected: FAIL,"Cannot find module './agent-handoff.js'"

- [ ] **Step 3: 写实现**

创建 `packages/runtime/src/pi-extensions/agent-handoff.ts`:

```typescript
/**
 * Agent handoff pi extension — `pass_to_next_agent` tool.
 *
 * Lets the executing agent hand off the next concrete step to a teammate
 * by role name. Internally creates a follow-up task (assigned to that role)
 * AND appends an agent_chat message so the handoff is visible in the UI.
 *
 * Built per-call with closures over the current mission / task / agent ID
 * (those values cannot be statically bound to the adapter).
 */

import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";

export interface CreateFollowupTaskInput {
  missionId: string;
  triggeringEventId: string;
  payload: {
    title: string;
    objective: string;
    assigneeRole: string;
    reason: string;
    sourceTaskId?: string;
    inputContext: Record<string, unknown>;
  };
}

export type CreateFollowupTaskResult =
  | { created: true; taskId: string }
  | {
      created: false;
      reason: "per_event_limit" | "mission_cap" | "no_assignee" | "mission_paused" | "budget_exceeded";
      escalateMessageSent?: boolean;
    };

export interface AppendMessageInput {
  missionId: string;
  fromAgentId: string;
  type: "agent_chat";
  content: string;
}

export interface PassToNextAgentDeps {
  missionId: string;
  sourceTaskId: string;
  sourceAgentId: string;
  createFollowupTask: (input: CreateFollowupTaskInput) => Promise<CreateFollowupTaskResult>;
  appendMessage: (input: AppendMessageInput) => void;
}

const PassToNextAgentParameters = Type.Object({
  nextRole: Type.String({ description: "Role name of the teammate to receive the next task (must match a role in the mission team)." }),
  objective: Type.String({ description: "One-sentence description of what the next agent should do." }),
  reason: Type.String({ description: "Why the handoff is happening; appears in the agent message log." }),
  inputContext: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: "Optional structured context the next agent will see in their task input." })),
});

export function createPassToNextAgentTool(deps: PassToNextAgentDeps): AgentTool<typeof PassToNextAgentParameters> {
  return {
    name: "pass_to_next_agent",
    label: "Pass to Next Agent",
    description:
      "Hand off the next concrete step to a teammate by role name. The platform will immediately create a task assigned to that role and start them. Call ONLY when your own turn is complete AND there is genuinely a next step a teammate should take. Returns { created: true, taskId } on success or { created: false, reason } on failure.",
    parameters: PassToNextAgentParameters,
    async execute(toolCallId: string, params: any) {
      const nextRole: string = params.nextRole;
      const objective: string = params.objective;
      const reason: string = params.reason;
      const inputContext: Record<string, unknown> = params.inputContext ?? {};

      const triggeringEventId = `handoff:${deps.sourceTaskId}:${toolCallId}`;

      const result = await deps.createFollowupTask({
        missionId: deps.missionId,
        triggeringEventId,
        payload: {
          title: `${nextRole}: ${objective.slice(0, 40)}`,
          objective,
          assigneeRole: nextRole,
          reason,
          sourceTaskId: deps.sourceTaskId,
          inputContext,
        },
      });

      deps.appendMessage({
        missionId: deps.missionId,
        fromAgentId: deps.sourceAgentId,
        type: "agent_chat",
        content: `[递棒→${nextRole}] ${reason}`,
      });

      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: result as unknown as Record<string, unknown>,
      };
    },
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @digitalagent/runtime vitest run src/pi-extensions/agent-handoff.test.ts`
Expected: 4 个 case 全 PASS

- [ ] **Step 5: 在 runtime index 导出**

修改 `packages/runtime/src/index.ts`,Task 1 加的那行下面追加:

```typescript
export { createPassToNextAgentTool } from "./pi-extensions/agent-handoff.js";
export type {
  PassToNextAgentDeps,
  CreateFollowupTaskInput,
  CreateFollowupTaskResult,
  AppendMessageInput,
} from "./pi-extensions/agent-handoff.js";
```

- [ ] **Step 6: 跑全 runtime 测试 + typecheck**

Run: `pnpm --filter @digitalagent/runtime test && pnpm --filter @digitalagent/runtime typecheck`
Expected: 全部 PASS

- [ ] **Step 7: Commit**

```bash
git add packages/runtime/src/pi-extensions/agent-handoff.ts packages/runtime/src/pi-extensions/agent-handoff.test.ts packages/runtime/src/index.ts
git commit -m "feat(runtime): add pass_to_next_agent tool for cross-agent handoff"
```

---

## Phase 2: Server 接线

### Task 3: MissionService 增加 workspaceRoot 选项 + 删除时清理工作区

**Files:**
- Modify: `apps/server/src/mission-service.ts`(`MissionServiceOptions` ~553, constructor ~619, `deleteMission` ~1629)
- Modify: `apps/server/src/mission-service.test.ts`(末尾增 case)

- [ ] **Step 1: 写失败测试**

在 `apps/server/src/mission-service.test.ts` 文件末尾(最后一个 `});` 闭合 describe 之前的位置)追加:

```typescript
  describe("workspace lifecycle", () => {
    it("deleteMission removes the workspace directory under workspaceRoot", async () => {
      const workspaceRoot = mkdtempSync(join(tmpdir(), "v1-workspace-"));
      const storageFile = join(workspaceRoot, "store.json");

      const missions = new InMemoryMissionService({
        storageFile,
        workspaceRoot,
        llm: new FakeLlmAdapter(() => "{}"),
      });

      const m = missions.createMission({
        goal: "test goal",
        scope: "test",
        constraints: [],
        successMetrics: ["m"],
      });

      // Simulate an agent having written a file in the workspace
      const missionDir = join(workspaceRoot, m.id);
      mkdirSync(missionDir, { recursive: true });
      writeFileSync(join(missionDir, "chain.txt"), "x");

      missions.deleteMission(m.id);

      expect(existsSync(missionDir)).toBe(false);

      rmSync(workspaceRoot, { recursive: true, force: true });
    });

    it("deleteMission does not throw when workspace dir does not exist", () => {
      const workspaceRoot = mkdtempSync(join(tmpdir(), "v1-workspace-"));
      const missions = new InMemoryMissionService({
        storageFile: join(workspaceRoot, "store.json"),
        workspaceRoot,
        llm: new FakeLlmAdapter(() => "{}"),
      });

      const m = missions.createMission({
        goal: "test goal",
        scope: "test",
        constraints: [],
        successMetrics: ["m"],
      });

      // Never created the mission dir
      expect(() => missions.deleteMission(m.id)).not.toThrow();

      rmSync(workspaceRoot, { recursive: true, force: true });
    });
  });
```

确保文件顶部 import 包含 `mkdirSync`, `existsSync`, `rmSync` 来自 `node:fs`(目前已有 `mkdtempSync`, `rmSync`, `writeFileSync`,补 `mkdirSync` 和 `existsSync`)。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @digitalagent/server vitest run src/mission-service.test.ts -t "workspace lifecycle"`
Expected: FAIL("workspaceRoot is not a known option" 或 workspace 没被删)

- [ ] **Step 3: 修改 MissionServiceOptions(`mission-service.ts:553`)**

把 interface 改成:

```typescript
export interface MissionServiceOptions {
  storageFile?: string | undefined;
  configFile?: string | undefined;
  llm?: LlmService | undefined;
  runtime?: MissionExecutionRuntime | undefined;
  followupSafety?: FollowupSafetyConfig | undefined;
  fetch?: ((url: string, init?: RequestInit) => Promise<Response>) | undefined;
  workspaceRoot?: string | undefined;
}
```

- [ ] **Step 4: 在 class 字段里加 workspaceRoot,构造函数赋值**

`mission-service.ts:595` 附近,在 `storageFile` 字段下面追加:

```typescript
  private readonly workspaceRoot: string | undefined;
```

`mission-service.ts:620` 附近构造函数里追加:

```typescript
    this.workspaceRoot = options.workspaceRoot;
```

- [ ] **Step 5: 在 `deleteMission` 末尾追加 workspace 清理**

文件顶部 import 需要加 `import { promises as fsPromises } from "node:fs";`(如果还没有)和 `import { join as pathJoin } from "node:path";`(如果还没有)。检查现有 import,选择不冲突的别名。

在 `deleteMission` 方法的 `this.persist();` 之前(或最后,看现有结构)追加:

```typescript
    if (this.workspaceRoot) {
      const workspaceDir = pathJoin(this.workspaceRoot, missionId);
      fsPromises.rm(workspaceDir, { recursive: true, force: true }).catch((err) => {
        console.error(`[MissionService] Failed to clean workspace ${workspaceDir}:`, err);
      });
    }
```

(如果 `path` 已经被 `import { join } from "node:path"` 引入,直接用 `join`,不用别名;`node:fs` 的 `promises` 同理。)

- [ ] **Step 6: 跑测试确认通过**

Run: `pnpm --filter @digitalagent/server vitest run src/mission-service.test.ts -t "workspace lifecycle"`
Expected: 2 个 case 全 PASS

- [ ] **Step 7: 跑全 server 测试 + typecheck**

Run: `pnpm --filter @digitalagent/server test && pnpm --filter @digitalagent/server typecheck`
Expected: 无新增失败

- [ ] **Step 8: Commit**

```bash
git add apps/server/src/mission-service.ts apps/server/src/mission-service.test.ts
git commit -m "feat(server): MissionService.workspaceRoot + delete cleanup"
```

---

### Task 4: `executeTask` 注入 file IO + handoff 工具

**Files:**
- Modify: `apps/server/src/mission-service.ts`(`executeTask` ~1208)
- Modify: `apps/server/src/mission-service.test.ts`(新 case)

- [ ] **Step 1: 写失败测试**

在 `mission-service.test.ts` 的 `workspace lifecycle` describe 后追加(同一文件):

```typescript
  describe("executeTask tool injection", () => {
    it("passes file_read, file_write, pass_to_next_agent tools to runtime", async () => {
      const workspaceRoot = mkdtempSync(join(tmpdir(), "v1-inject-"));
      const recordedTools: string[] = [];
      const runtime: MissionExecutionRuntime = {
        async runAgentTask(input) {
          for (const t of input.tools ?? []) recordedTools.push(t.name);
          return { status: "completed", output: {}, stderr: "" };
        },
      };

      const missions = new InMemoryMissionService({
        storageFile: join(workspaceRoot, "store.json"),
        workspaceRoot,
        llm: new FakeLlmAdapter(() => "{}"),
        runtime,
      });

      const m = missions.createMission({
        goal: "g",
        scope: "s",
        constraints: [],
        successMetrics: ["m"],
      });

      // Need an agent + task — use minimal setup
      const agent = missions.upsertAgent({
        missionId: m.id,
        name: "Tester",
        role: "tester",
        responsibility: "test",
      });
      const task = missions.createTaskForAgent({
        missionId: m.id,
        assigneeAgentId: agent.id,
        title: "t1",
        contract: { objective: "do thing", input: {}, outputSchema: {}, successCriteria: [] },
      });
      missions.markTaskReady(task.id);

      missions.executeTask({ missionId: m.id, taskId: task.id, message: "go" });

      // Give the async runAgentTask a tick to be invoked
      await new Promise((r) => setTimeout(r, 50));

      expect(recordedTools).toContain("file_read");
      expect(recordedTools).toContain("file_write");
      expect(recordedTools).toContain("pass_to_next_agent");

      rmSync(workspaceRoot, { recursive: true, force: true });
    });
  });
```

**注意**:`upsertAgent` / `createTaskForAgent` / `markTaskReady` 等方法名可能与现有实现不完全一致。打开 `mission-service.ts` 搜索现有公共方法,**用现有 API 凑出"一个可执行的 task"的最少调用序列**(如果 `executeTask` 需要的前置太复杂,改成用 `mission-service.test.ts` 文件中已有的辅助函数,参考其他 `it(...)` 块怎么准备 mission + task)。

如果方法签名不对导致编译失败,**修测试直到能编过 + FAIL 出"recordedTools 不包含 file_read"**——这是 RED 阶段的真正目标。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @digitalagent/server vitest run src/mission-service.test.ts -t "executeTask tool injection"`
Expected: FAIL,recordedTools 为空数组或不包含期望的工具名

- [ ] **Step 3: 在 mission-service.ts 顶部加 import**

```typescript
import { createFileTools, createPassToNextAgentTool } from "@digitalagent/runtime";
import { join as pathJoin } from "node:path";  // 如已存在则跳过
```

- [ ] **Step 4: 在 `executeTask` 里注入工具**

定位 `executeTask` 方法(`mission-service.ts:1208`),找到这段:

```typescript
    void runtime
      .runAgentTask({
        message: buildAgentMessage({ message: input.message, mission, task }),
        timeoutSeconds: 300,
        sessionId: input.missionId,
        missionId: input.missionId,
        agentId: executor.id,
        ...(systemPrompt ? { systemPrompt } : {}),
        onToolEvent: (toolEvent) => this.notifyToolCall(input.missionId, toolEvent),
      })
```

替换为:

```typescript
    const perCallTools = this.buildPerCallTools({
      missionId: input.missionId,
      sourceTaskId: input.taskId,
      sourceAgentId: executor.id,
    });

    void runtime
      .runAgentTask({
        message: buildAgentMessage({ message: input.message, mission, task }),
        timeoutSeconds: 300,
        sessionId: input.missionId,
        missionId: input.missionId,
        agentId: executor.id,
        tools: perCallTools,
        ...(systemPrompt ? { systemPrompt } : {}),
        onToolEvent: (toolEvent) => this.notifyToolCall(input.missionId, toolEvent),
      })
```

并在 class 里(放在 `executeTask` 旁边即可)加一个 private helper:

```typescript
  private buildPerCallTools(ctx: {
    missionId: string;
    sourceTaskId: string;
    sourceAgentId: string;
  }) {
    const tools: any[] = [];

    if (this.workspaceRoot) {
      const missionWorkspace = pathJoin(this.workspaceRoot, ctx.missionId);
      tools.push(...createFileTools({ workspaceRoot: missionWorkspace }));
    }

    tools.push(
      createPassToNextAgentTool({
        missionId: ctx.missionId,
        sourceTaskId: ctx.sourceTaskId,
        sourceAgentId: ctx.sourceAgentId,
        createFollowupTask: (input) => this.createFollowupTask(input),
        appendMessage: (msg) =>
          this.appendMessage({
            missionId: msg.missionId,
            fromAgentId: msg.fromAgentId,
            type: msg.type,
            content: msg.content,
          }),
      }),
    );

    return tools;
  }
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm --filter @digitalagent/server vitest run src/mission-service.test.ts -t "executeTask tool injection"`
Expected: PASS

- [ ] **Step 6: 跑全 server 测试**

Run: `pnpm --filter @digitalagent/server test && pnpm --filter @digitalagent/server typecheck`
Expected: 无新增失败

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/mission-service.ts apps/server/src/mission-service.test.ts
git commit -m "feat(server): inject file_io + handoff tools per executeTask call"
```

---

### Task 5: server.ts 把 workspaceRoot 传进去

**Files:**
- Modify: `apps/server/src/server.ts`(顶部 ~17-20)

- [ ] **Step 1: 打开 server.ts,在 `dataFile` 定义后加 `workspaceRoot`**

`server.ts:20` 附近:

```typescript
const dataFile = process.env.DIGITALAGENT_STORE_FILE ?? join(root, "..", "data", "mission-store.json");
const workspaceRoot = process.env.DIGITALAGENT_WORKSPACE_ROOT ?? join(root, "..", "data", "workspaces");
```

- [ ] **Step 2: 把 workspaceRoot 传给 MissionService**

`server.ts:54` 附近,把:

```typescript
const missions = new InMemoryMissionService({ storageFile: dataFile, llm, runtime });
```

改成:

```typescript
const missions = new InMemoryMissionService({ storageFile: dataFile, workspaceRoot, llm, runtime });
```

- [ ] **Step 3: typecheck**

Run: `pnpm --filter @digitalagent/server typecheck`
Expected: 通过

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/server.ts
git commit -m "feat(server): wire DIGITALAGENT_WORKSPACE_ROOT env var"
```

---

### Task 6: `buildAgentMessage` 接力提示

**Files:**
- Modify: `apps/server/src/runtime-bridge.ts`(`buildAgentMessage` :22)
- Create: `apps/server/src/runtime-bridge.test.ts`(若不存在)

- [ ] **Step 1: 写失败测试**

如果 `runtime-bridge.test.ts` 不存在,创建它;否则在末尾追加:

```typescript
import { describe, expect, it } from "vitest";
import { buildAgentMessage } from "./runtime-bridge.js";

describe("buildAgentMessage", () => {
  it("includes a followup hint when task.origin.type is 'followup'", () => {
    const result = buildAgentMessage({
      message: "do thing",
      mission: { id: "m1", goal: "test" },
      task: {
        id: "t2",
        title: "next",
        origin: { type: "followup", reason: "previous done", sourceTaskId: "t1" },
      },
    });

    expect(result.toLowerCase()).toContain("follow-up");
    expect(result.toLowerCase()).toMatch(/read.*referenced.*files|chain\.txt/i);
  });

  it("does NOT include followup hint for non-followup tasks", () => {
    const result = buildAgentMessage({
      message: "do thing",
      mission: { id: "m1", goal: "test" },
      task: { id: "t1", title: "initial" },
    });

    expect(result.toLowerCase()).not.toContain("follow-up");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @digitalagent/server vitest run src/runtime-bridge.test.ts`
Expected: 第一个 case FAIL("follow-up" 不在输出里)

- [ ] **Step 3: 修改 `buildAgentMessage`**

`apps/server/src/runtime-bridge.ts:22`,把函数改成:

```typescript
export function buildAgentMessage(input: {
  message: string;
  mission: unknown;
  task: unknown;
}): string {
  const lines: string[] = [
    "Mission context:",
    JSON.stringify({ mission: input.mission, task: input.task }, null, 2),
  ];

  const taskRecord = (input.task && typeof input.task === "object" ? input.task : {}) as Record<string, unknown>;
  const origin = taskRecord.origin as { type?: string } | undefined;
  if (origin?.type === "followup") {
    lines.push(
      "",
      "Note: This is a follow-up task handed off from a teammate. Before producing new output, read any referenced files in the mission workspace (e.g. chain.txt) so you know what your teammate already produced.",
    );
  }

  lines.push("", "User instruction:", input.message);
  return lines.join("\n");
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @digitalagent/server vitest run src/runtime-bridge.test.ts`
Expected: 2 个 case PASS

- [ ] **Step 5: 跑全 server 测试**

Run: `pnpm --filter @digitalagent/server test`
Expected: 无新增失败

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/runtime-bridge.ts apps/server/src/runtime-bridge.test.ts
git commit -m "feat(server): add follow-up task hint in agent message"
```

---

### Task 7: 协作类 mission 默认带 `maxFollowupTasks: 30` 安全阀

**Files:**
- Modify: `apps/server/src/mission-service.ts`(创建 mission 时设默认 budget)

**目的**:V1 接龙最多 30 棒上限,防 LLM 无限递归。

- [ ] **Step 1: 定位 mission 创建路径**

在 `apps/server/src/mission-service.ts` 中搜 `createMission`(`grep -n "createMission" apps/server/src/mission-service.ts`)找到对外的 mission 创建方法。看 budget 字段当前默认值。

如果 `mission.budget.maxFollowupTasks` 当前默认是 `undefined`,在创建 mission 时为它设个默认值 `30`(注意:如果调用方显式传了别的值,要尊重调用方,只在未传时填默认)。

- [ ] **Step 2: 写失败测试**

在 `mission-service.test.ts` 末尾追加:

```typescript
  describe("mission budget defaults", () => {
    it("createMission defaults maxFollowupTasks to 30 when not provided", () => {
      const missions = new InMemoryMissionService({
        llm: new FakeLlmAdapter(() => "{}"),
      });
      const m = missions.createMission({
        goal: "g",
        scope: "s",
        constraints: [],
        successMetrics: ["m"],
      });
      expect(m.budget.maxFollowupTasks).toBe(30);
    });

    it("createMission respects explicit maxFollowupTasks", () => {
      const missions = new InMemoryMissionService({
        llm: new FakeLlmAdapter(() => "{}"),
      });
      const m = missions.createMission({
        goal: "g",
        scope: "s",
        constraints: [],
        successMetrics: ["m"],
        budget: { maxFollowupTasks: 5 },
      });
      expect(m.budget.maxFollowupTasks).toBe(5);
    });
  });
```

- [ ] **Step 3: 跑测试确认失败**

Run: `pnpm --filter @digitalagent/server vitest run src/mission-service.test.ts -t "mission budget defaults"`
Expected: 第一个 case FAIL(可能是 undefined 或 missing)

- [ ] **Step 4: 修改实现**

找到 `createMission` 内部对 budget 的处理(可能调用了 `@digitalagent/core` 的 `createMission` 工厂)。如果当前没传 maxFollowupTasks,改成:

```typescript
// 简化示意 — 实际定位要看现有 createMission 内的 budget 处理
budget: {
  ...input.budget,
  maxFollowupTasks: input.budget?.maxFollowupTasks ?? 30,
}
```

如果是调用 `@digitalagent/core` 的工厂(`createMission(input)`)且工厂不接受默认覆盖,在 server 这层先把 input 改造好再传。

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm --filter @digitalagent/server vitest run src/mission-service.test.ts -t "mission budget defaults"`
Expected: 2 个 case PASS

- [ ] **Step 6: 检查没有破坏已有测试**

Run: `pnpm --filter @digitalagent/server test`
Expected: 无新失败(若有,可能是某些测试断言了 budget 为 undefined,改它们 `toBe(30)` 即可)

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/mission-service.ts apps/server/src/mission-service.test.ts
git commit -m "feat(server): default maxFollowupTasks=30 as handoff safety cap"
```

---

## Phase 3: Skill 文档 + Prompt(顺序敏感)

### Task 8: 更新 skill 文档列出真实工具签名

**Files:**
- Modify: `apps/server/config/skills/digitalagent/capabilities/file-io.md`
- Modify: `apps/server/config/skills/digitalagent/capabilities/agent-collaboration.md`

- [ ] **Step 1: 改 `file-io.md`,在原文末尾追加章节**

打开 `apps/server/config/skills/digitalagent/capabilities/file-io.md`,在文件末尾追加(保留现有 1-14 行):

```markdown

## 可用工具

- `file_read({ path })` — 读取 mission 工作区中的文件。返回 `{ exists, content, sizeBytes }`。文件不存在时返回 `exists: false`、`content: ""`,**不抛错**(适合"接龙第一棒,文件还不存在"的场景)。
- `file_write({ path, content, mode })` — 写入文件。`mode` 为 `"overwrite"`(默认,完全覆盖)或 `"append"`(追加到末尾)。`path` 必须相对,如 `chain.txt` 或 `subdir/log.md`。

## 约束

- `path` 不能是绝对路径,不能包含 `..`(防越界)
- 单次读 / 写最大 1 MB
- 单个 mission 工作区最多 100 个文件(超过后 `file_write` 拒绝创建新文件)
- 工作区目录懒创建:首次 `file_write` 自动 `mkdir -p`
- Mission 删除时工作区跟着清理
```

- [ ] **Step 2: 改 `agent-collaboration.md`,在原文末尾追加章节**

打开 `apps/server/config/skills/digitalagent/capabilities/agent-collaboration.md`,在文件末尾追加:

```markdown

## 可用工具

- `pass_to_next_agent({ nextRole, objective, reason, inputContext? })` — 把下一步任务交给指定角色的队友。平台会立即创建一个 task 派给对方并启动其执行。返回 `{ created: true, taskId }` 表示交棒成功,或 `{ created: false, reason }`(`no_assignee` / `mission_paused` / `budget_exceeded` 等)表示失败。
  - `nextRole`:团队中的角色名(必须存在,如 "玩家2")
  - `objective`:下一棒要做什么(一句话)
  - `reason`:为什么递棒(进 agent 消息日志,UI 可见)
  - `inputContext`:可选结构化上下文(下一个 agent 在 task 输入里能看到)

## 调用时机

- 当且仅当自己这一棒**确实做完**,且**真有下一步该让队友做**时,才调用 `pass_to_next_agent`
- 如果 mission 有终止条件(如 "完成 N 轮"),**先读相关状态文件**(如 `chain.txt`)确认未达成,再递棒;达成了就不递,任务链自然结束
- 不要刚启动就调用——先做完自己应做的工作
- Mission 内的"接力链"有 30 棒上限(`maxFollowupTasks`),超出会被平台拒绝并自动 pause
```

- [ ] **Step 3: 确认存在性**

Run: `cat apps/server/config/skills/digitalagent/capabilities/file-io.md | grep -c "file_read"`
Expected: 至少 1

Run: `cat apps/server/config/skills/digitalagent/capabilities/agent-collaboration.md | grep -c "pass_to_next_agent"`
Expected: 至少 1

- [ ] **Step 4: Commit**

```bash
git add apps/server/config/skills/digitalagent/capabilities/file-io.md apps/server/config/skills/digitalagent/capabilities/agent-collaboration.md
git commit -m "docs(skills): list file_read/file_write/pass_to_next_agent signatures"
```

---

### Task 9: 改 HR 提示词,移除假工具名,指向 skill

**Files:**
- Modify: `apps/server/src/hr-agent.ts`(`:262`, `:408`)

- [ ] **Step 1: 改 `hr-agent.ts:262`**

打开 `apps/server/src/hr-agent.ts`,定位:

```typescript
    "- Agents can coordinate through agent_send_message, agent_read_messages, and turn_record when the mission needs multi-agent handoff evidence.",
```

替换为:

```typescript
    "- Before designing the team, you may load digitalagent/SKILL.md and relevant capability files (file-io, agent-collaboration, web-search) via load_skill to learn the actual runtime tools available; assign those tool names in each role's allowedTools accordingly.",
```

- [ ] **Step 2: 改 `hr-agent.ts:408`**

定位:

```typescript
    "- For collaborative tasks, include agent_send_message, agent_read_messages, or turn_record in allowedTools when those tools help make handoffs observable.",
```

替换为:

```typescript
    "- For collaborative or turn-based tasks, ensure the working roles' allowedTools cover the relevant capabilities discovered via load_skill (typically file IO + agent handoff tools).",
```

- [ ] **Step 3: 跑现有 HR 测试**

Run: `pnpm --filter @digitalagent/server vitest run src/hr-agent.test.ts`
Expected: 大概率全 PASS;若个别 case 断言了旧字符串(`agent_send_message` 等),改测试断言以匹配新文本(让它们检查"含 capability"或"含 load_skill"这种语义,而不是死字符串)

- [ ] **Step 4: 跑全 server 测试 + typecheck**

Run: `pnpm --filter @digitalagent/server test && pnpm --filter @digitalagent/server typecheck`
Expected: 无新增失败

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/hr-agent.ts apps/server/src/hr-agent.test.ts
git commit -m "feat(server): HR prompt no longer hardcodes tool names; points to skills"
```

---

### Task 10: 改 Agent 系统提示词指令(`system-config.ts`)

**Files:**
- Modify: `apps/server/src/system-config.ts`(`RUNTIME_SKILL_TOOL_DIRECTIVE` ~88)

- [ ] **Step 1: 改 `RUNTIME_SKILL_TOOL_DIRECTIVE`**

打开 `apps/server/src/system-config.ts`,定位常量:

```typescript
const RUNTIME_SKILL_TOOL_DIRECTIVE = [
  "",
  "DigitalAgent capability context:",
  "You have access to skill loading tools: list_skill_files and load_skill.",
  "Use load_skill with digitalagent/SKILL.md when you need capability guidance for a mission.",
  "Load more specific skill files (e.g., digitalagent/capabilities/*.md) only when the mission requires specific capability context.",
  "Do not expose skill loading details to the user.",
].join("\n");
```

替换为:

```typescript
const RUNTIME_SKILL_TOOL_DIRECTIVE = [
  "",
  "DigitalAgent capability context:",
  "You have access to skill loading tools: list_skill_files and load_skill.",
  "When you receive a task, load digitalagent/SKILL.md first to discover available runtime tools and capabilities.",
  "Then load the specific capability files relevant to your task (e.g., digitalagent/capabilities/file-io.md, digitalagent/capabilities/agent-collaboration.md) before acting.",
  "These skill files are the authoritative source for tool names and signatures — do not invent or assume tool names that are not listed there.",
  "Do not expose skill loading details to the user.",
].join("\n");
```

- [ ] **Step 2: 跑现有 system-config 测试**

Run: `pnpm --filter @digitalagent/server vitest run src/system-config.test.ts`
Expected: PASS(若有断言字符串改了,同样修测试断言到语义层面)

- [ ] **Step 3: 跑全 server 测试 + typecheck**

Run: `pnpm --filter @digitalagent/server test && pnpm --filter @digitalagent/server typecheck`
Expected: 无新增失败

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/system-config.ts apps/server/src/system-config.test.ts
git commit -m "feat(server): agent prompt directs to load skills before tool use"
```

---

## Phase 4: UI

### Task 11: Agents tab 增加"工具操作流水"卡片

**Files:**
- Modify: `apps/server/public/war-room.js`(`renderAgentDetailCard` :609)
- Modify: `apps/server/public/styles.css`(末尾追加)

- [ ] **Step 1: 修改 `war-room.js`,在 `renderAgentDetailCard` 末尾插入流水块**

打开 `apps/server/public/war-room.js`。定位 `renderAgentDetailCard` 返回的 HTML 字符串里 `<div class="agent-message-feed">...</div>` 块的闭合 `</article>` 之前。在 `</article>` 上一行插入:

```javascript
      ${renderToolCallTimeline(data, agent)}
```

(让模板字符串里多一个调用。)

在文件中找一个合适位置(比如 `latestAgentMessages` 函数后,`renderTaskCard` 函数前)新加两个函数:

```javascript
function renderToolCallTimeline(data, agent) {
  const calls = data.toolCalls
    .filter((c) => c.agentId === agent.id)
    .sort((a, b) => new Date(a.startedAt) - new Date(b.startedAt))
    .slice(-10);

  if (!calls.length) return "";

  return `
    <div class="agent-tool-timeline">
      <span class="field-label">工具操作流水</span>
      ${calls.map((call) => `
        <div class="tool-call-item status-${esc(call.status)}">
          <div class="tool-call-head">
            <span class="tool-call-icon">${toolStatusIcon(call.status)}</span>
            <time>${esc(formatTime(call.startedAt))}</time>
            <strong>${esc(call.toolName)}</strong>
          </div>
          <pre class="tool-call-input">${esc(shortJson(call.input, 200))}</pre>
          ${call.status === "completed" ? `<div class="tool-call-result">→ ${esc(summarizeToolOutput(call.toolName, call.output))}</div>` : ""}
          ${call.status === "failed" ? `<div class="tool-call-error">✗ ${esc(call.error || "失败")}</div>` : ""}
          ${call.status === "running" ? `<div class="tool-call-running">运行中...</div>` : ""}
        </div>
      `).join("")}
    </div>
  `;
}

function toolStatusIcon(status) {
  switch (status) {
    case "completed": return "✅";
    case "failed": return "✗";
    case "running": return "🔄";
    default: return "•";
  }
}

function shortJson(obj, maxLen) {
  try {
    const s = JSON.stringify(obj);
    if (!s) return "";
    return s.length > maxLen ? s.slice(0, maxLen) + "..." : s;
  } catch {
    return "";
  }
}

function summarizeToolOutput(toolName, output) {
  if (!output) return "完成";
  switch (toolName) {
    case "file_read":
      if (output.exists === false) return "文件不存在";
      return `读取 ${output.sizeBytes ?? "?"} 字节`;
    case "file_write":
      return `写入 ${output.bytesWritten ?? "?"} 字节 (${output.mode || "overwrite"})`;
    case "pass_to_next_agent":
      if (output.created) return `已派任务给 ${output.assigneeRole || "下一棒"} (taskId=${output.taskId || "?"})`;
      return `拒绝:${output.reason || "未知"}`;
    case "web_search":
      const count = Array.isArray(output.searchResults) ? output.searchResults.length : (Array.isArray(output.sources) ? output.sources.length : 0);
      return `${count} 条搜索结果`;
    case "list_skill_files":
      return `${Array.isArray(output) ? output.length : (output.count ?? "?")} 个技能文件`;
    case "load_skill":
      return `加载 ${output.path || "技能"}`;
    default: return "完成";
  }
}
```

- [ ] **Step 2: 在 styles.css 末尾追加样式**

打开 `apps/server/public/styles.css`,在文件末尾追加:

```css
/* Agent tool-call timeline (V1) */
.agent-tool-timeline {
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px dashed #444;
}

.agent-tool-timeline .field-label {
  display: block;
  margin-bottom: 8px;
  font-size: 12px;
  color: #888;
}

.tool-call-item {
  margin: 6px 0;
  padding: 8px 10px;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.03);
  border-left: 3px solid #555;
  font-size: 12px;
}

.tool-call-item.status-completed { border-left-color: #4caf50; }
.tool-call-item.status-failed    { border-left-color: #e53935; }
.tool-call-item.status-running   { border-left-color: #1e88e5; }

.tool-call-head {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 500;
}

.tool-call-head time {
  color: #888;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.tool-call-input {
  margin: 4px 0 0;
  padding: 4px 6px;
  background: rgba(0, 0, 0, 0.2);
  border-radius: 4px;
  font-size: 11px;
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
  white-space: pre-wrap;
  word-break: break-all;
  color: #aaa;
}

.tool-call-result   { margin-top: 4px; color: #80cbc4; }
.tool-call-error    { margin-top: 4px; color: #ef9a9a; }
.tool-call-running  { margin-top: 4px; color: #90caf9; font-style: italic; }
```

- [ ] **Step 3: 启 dev server 手验**

Run: `pnpm dev`(放后台或开新终端)
打开浏览器到 `http://127.0.0.1:3000`,创建一个测试 mission 跑一下,确认 Agents tab 上看不到报错。若某些字段名不对(比如 `data.toolCalls` 实际叫别的),修复后再试。

(此步无自动化测试——UI 改动靠人眼)

- [ ] **Step 4: Commit**

```bash
git add apps/server/public/war-room.js apps/server/public/styles.css
git commit -m "feat(ui): Agents tab — per-agent tool call timeline"
```

---

## Phase 5: 验收

### Task 12: Smoke 测试(真 LLM,门控)

**Files:**
- Create: `apps/server/src/v1-collaboration.smoke.test.ts`

- [ ] **Step 1: 创建 smoke 测试**

创建 `apps/server/src/v1-collaboration.smoke.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { InMemoryMissionService } from "./mission-service.js";
import type { MissionExecutionRuntime } from "./runtime-bridge.js";
import {
  PiSdkAdapter,
  createPiAgentLlmService,
  createSkillTools,
  createWebSearchTool,
} from "@digitalagent/runtime";

const REAL_LLM = process.env.PI_SMOKE === "1";

describe.runIf(REAL_LLM)("V1 接龙:5 个 agent 协作完成 15 轮 (real LLM)", () => {
  it(
    "招出团队、agent 协作写 chain.txt、达到 15 行后链子终止",
    async () => {
      const workspaceRoot = mkdtempSync(join(tmpdir(), "v1-smoke-"));
      const storageFile = join(workspaceRoot, "store.json");

      const apiKey = process.env.LLM_API_KEY ?? process.env.MINIMAX_API_KEY ?? process.env.ANTHROPIC_API_KEY ?? "";
      if (!apiKey) throw new Error("V1 smoke requires LLM_API_KEY / MINIMAX_API_KEY / ANTHROPIC_API_KEY");

      const skillRoot = join(process.cwd(), "config", "skills");
      const skillTools = createSkillTools({ rootDir: skillRoot });

      const llm = createPiAgentLlmService({
        apiKey,
        modelProvider: process.env.LLM_PROVIDER ?? "minimax-cn",
        modelId: process.env.LLM_MODEL ?? "MiniMax-M2.7-highspeed",
        tools: skillTools,
      });

      const pi = new PiSdkAdapter({
        apiKey,
        modelProvider: process.env.LLM_PROVIDER ?? "minimax-cn",
        modelId: process.env.LLM_MODEL ?? "MiniMax-M2.7-highspeed",
        tools: [...skillTools, createWebSearchTool({})],
      });

      const runtime: MissionExecutionRuntime = { runAgentTask: (i) => pi.runAgentTask(i) };

      const missions = new InMemoryMissionService({ storageFile, workspaceRoot, llm, runtime });

      // === 创建 mission, 走 brief → plan → 激活 ===
      const m = missions.createMission({
        goal:
          "5 个 agent 协作玩成语接龙,每轮把当前接到的成语写入 chain.txt 文件,下一个 agent 必须先读 chain.txt 拿到上一个成语,再接龙写回。完成 15 次才算成功。",
        scope: "V1 验收",
        constraints: [],
        successMetrics: ["chain.txt 包含 15 个合法成语,首尾相接"],
      });

      // 注:以下 brief/plan 自动确认 + 激活的细节需要按 mission-service 现有 API 适配。
      // 简化版:直接调"确认 brief"→ "确认 plan" → "activate" 的 service 方法,跳过 Owner LLM 对话。
      // 若 API 设计要求走完整流程,改成 await walkOwnerFlow(missions, m.id);
      // (具体方法名以代码为准:autoConfirmBrief / autoConfirmPlan / activateMission 等。)
      await missions.autoConfirmBriefForTesting?.(m.id);
      await missions.autoConfirmPlanForTesting?.(m.id);
      await missions.activateMission?.(m.id);

      // === 轮询等 mission idle 或超时 ===
      const deadline = Date.now() + 600_000; // 10 分钟
      while (Date.now() < deadline) {
        const snapshot = missions.snapshot();
        const mission = snapshot.missions.find((x) => x.id === m.id);
        if (!mission) throw new Error("mission disappeared mid-run");
        const tasks = snapshot.tasks.filter((t) => t.missionId === m.id);
        const allTerminal = tasks.length > 0 && tasks.every((t) => ["completed", "failed"].includes(t.status));
        if (mission.status === "failed" || mission.status === "completed" || allTerminal) break;
        await new Promise((r) => setTimeout(r, 3000));
      }

      // === 断言 ===
      const snapshot = missions.snapshot();
      const mission = snapshot.missions.find((x) => x.id === m.id)!;

      expect(mission.status).not.toBe("failed");

      const workerAgents = snapshot.agents.filter(
        (a) => a.missionId === m.id && !["owner", "hr"].includes(a.role),
      );
      expect(workerAgents.length).toBeGreaterThanOrEqual(2);
      expect(workerAgents.length).toBeLessThanOrEqual(10);

      // chain.txt 存在 + 行数
      const chainPath = join(workspaceRoot, m.id, "chain.txt");
      expect(existsSync(chainPath)).toBe(true);
      const lines = readFileSync(chainPath, "utf8").trim().split("\n").filter(Boolean);
      expect(lines.length).toBeGreaterThanOrEqual(15);
      for (const line of lines) {
        expect(line.trim().length).toBeGreaterThanOrEqual(2);
        expect(line.trim().length).toBeLessThanOrEqual(8);
      }

      // 工具调用证据
      const calls = snapshot.toolCalls.filter((c) => c.missionId === m.id);
      expect(calls.some((c) => c.toolName === "file_write")).toBe(true);
      expect(calls.some((c) => c.toolName === "file_read")).toBe(true);
      expect(calls.filter((c) => c.toolName === "pass_to_next_agent").length).toBeGreaterThanOrEqual(10);

      // 每个 worker agent 至少有 1 条 toolCall(没人摸鱼)
      for (const a of workerAgents) {
        const own = calls.filter((c) => c.agentId === a.id);
        expect(own.length).toBeGreaterThan(0);
      }

      rmSync(workspaceRoot, { recursive: true, force: true });
    },
    700_000,
  );
});
```

**注意**:测试里 `autoConfirmBriefForTesting` / `autoConfirmPlanForTesting` / `activateMission` 是占位名——按代码实际方法名替换。若没有"自动确认"helper,需要构造合适的 LLM mock 来走完 owner-driven 流程,或者临时加 helper 方法。**若改造涉及添加 helper 方法,在 mission-service.ts 中加上后保持 export**。

- [ ] **Step 2: 不跑(默认门控)** —— 这一步不实际跑测试,因为没有 `PI_SMOKE=1` 时它 skip。下一步手工验收时再跑。

- [ ] **Step 3: 跑 typecheck 确认没编译错**

Run: `pnpm --filter @digitalagent/server typecheck`
Expected: 通过

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/v1-collaboration.smoke.test.ts
git commit -m "test(server): V1 接龙 smoke test (gated by PI_SMOKE=1)"
```

---

### Task 13: 手工验收脚本文档

**Files:**
- Create: `docs/E2E-V1-ACCEPTANCE.md`

- [ ] **Step 1: 创建文档**

```markdown
# E2E V1 验收手工脚本

**对应**: `docs/E2E-ROADMAP.md` 的 V1-1 用例
**目的**: V1 收敛时跑这份清单全过 = 验收通过

---

## 0. 前置

- [ ] 干净 worktree,所有改动已 commit
- [ ] `pnpm install && pnpm build` 通过
- [ ] LLM api key 已配(`.env` 里 `LLM_API_KEY=` 或 `MINIMAX_API_KEY=`)

## 1. 自动化(可门控,跑得快)

- [ ] `pnpm test` —— 全部单元测试通过(含 file-io、agent-handoff、mission-service workspace 等)
- [ ] `pnpm --filter @digitalagent/server typecheck` —— 通过
- [ ] `PI_SMOKE=1 LLM_API_KEY=xxx pnpm --filter @digitalagent/server vitest run src/v1-collaboration.smoke.test.ts` —— 通过(约 5-10 分钟)

## 2. 浏览器手工跑

- [ ] `pnpm dev`,打开 `http://127.0.0.1:3000`
- [ ] 在主输入框粘贴 V1-1 goal 原文:
      > "5 个 agent 协作玩成语接龙,每轮把当前接到的成语写入 chain.txt 文件,下一个 agent 必须先读 chain.txt 拿到上一个成语,再接龙写回。完成 15 次才算成功。"
- [ ] 走完 Owner brief 确认
- [ ] 走完 MissionPlan 确认
- [ ] 激活 mission

### 期望观察(自动可验)

- [ ] HR Agent 进入 running → idle,没 failed
- [ ] 团队规模:**2-10 个**非 owner/hr agent
- [ ] Agents tab:每个玩家卡片下能看到"工具操作流水"块,有 file_read / file_write / pass_to_next_agent 的调用
- [ ] 找到 `apps/server/data/workspaces/<missionId>/chain.txt`,**存在**
- [ ] `cat chain.txt | wc -l` >= 15
- [ ] 每行 2-8 字符
- [ ] V0-1 兜底:不出现 "Mission Operator Agent" 这种泛角色

### 人工抽查(创意判断,不自动)

- [ ] 角色名跟"接龙 / 玩家 / 词汇"主题相关(不是 Generic Worker)
- [ ] chain.txt 至少 80% 是合法成语
- [ ] 抽样 5 个相邻条目,确认有"前一个尾字 ≈ 后一个首字"的接龙关系(允许同音变通)
- [ ] HR 招的角色不是所有人都用 file 工具——典型场景应该 1-2 个负责"记账",其他负责"出招"(看 allowedTools)

## 3. 删除验证

- [ ] 在 UI 上删掉刚跑的 mission
- [ ] `ls apps/server/data/workspaces/<missionId>` —— 应该 `No such file or directory`

## 4. V0 回归

- [ ] 重新跑一次 V0-1 用例(roadmap 原文 goal),确认没把老功能搞坏

---

任何一项 ❌ → 不算 V1 收敛,先看 roadmap "失败时的处理流程"修。
```

- [ ] **Step 2: Commit**

```bash
git add docs/E2E-V1-ACCEPTANCE.md
git commit -m "docs: V1 acceptance manual script"
```

---

## Self-Review

- **Spec coverage**:
  - §5.1 file-io tool → Task 1 ✓
  - §5.2 handoff tool → Task 2 ✓
  - §5.3 workspace 生命周期(option + 删除) → Task 3, 5 ✓
  - §5.3 per-call 工具注入 → Task 4 ✓
  - §5.4 skill 文档更新 → Task 8 ✓
  - §5.5 HR / Agent prompt → Task 9, 10 ✓
  - §5.5 buildAgentMessage followup hint → Task 6 ✓
  - §5.6 UI 流水 → Task 11 ✓
  - §5.7 maxFollowupTasks 默认 → Task 7 ✓
  - §8.1 单元测试 → 散落在 Task 1, 2, 3, 4, 6, 7 ✓
  - §8.2 Smoke → Task 12 ✓
  - §8.3 手工验收 → Task 13 ✓
- **Placeholder scan**:Task 7 step 4 有"具体定位以代码为准"的提示,Task 12 step 1 有"以现有 API 适配"的灵活性说明——这些是合理的 implementation flexibility,不是 TODO。其余步骤都有完整代码。
- **类型一致性**:`createFollowupTask` 返回类型 / `appendMessage` 参数类型 / `WriteTool/ReadTool` 名字在 Task 1, 2, 4 间一致;`workspaceRoot` 在 Task 3-5 命名一致;tool names (`file_read` / `file_write` / `pass_to_next_agent`) 全文一致。

---

**Plan 完成,共 13 个任务,5 个阶段。**
