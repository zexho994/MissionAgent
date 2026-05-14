# Pi Agent Skill Loading Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 DigitalAgent 增加一套基于 pi-agent tool calling 的通用 skill 动态加载能力，让 Owner、MissionPlan、HR 和 runtime mission agent 都能按需读取本地 DigitalAgent skill 文档。

**Architecture:** 新增只读 skill 工具 `list_skill_files` 和 `load_skill`，工具只允许读取 `apps/server/config/skills` 下的 Markdown 相对路径。抽出共享 `runPiAgent(...)`，让 `PiSdkAdapter` 和新的 `PiAgentLlmService` 共用同一套 pi-agent 工具调用机制，避免两套工具调用实现。

**Tech Stack:** TypeScript, Vitest, Node fs/path APIs, `@earendil-works/pi-agent-core`, existing `@digitalagent/runtime` and `apps/server` config.

---

## 文件结构

- Create: `apps/server/config/skills/digitalagent/SKILL.md`  
  DigitalAgent skill 入口，说明系统能力、何时加载能力详情、Owner 如何避免把内部 mission 执行误解成外部项目建设。
- Create: `apps/server/config/skills/digitalagent/capabilities/agent-collaboration.md`  
  多 agent 协作、A2A、汇报、评审能力说明。
- Create: `apps/server/config/skills/digitalagent/capabilities/code-writing.md`  
  代码编写、测试、review 类 mission 的能力边界。
- Create: `apps/server/config/skills/digitalagent/capabilities/web-search.md`  
  网页搜索能力说明。
- Create: `apps/server/config/skills/digitalagent/capabilities/file-io.md`  
  文件读写能力说明。
- Create: `apps/server/config/skills/digitalagent/capabilities/browser-validation.md`  
  浏览器验证能力说明。
- Modify: `apps/server/config/agent-system.json`  
  新增 `skills.rootDir: "config/skills"`，并更新 Owner/HR prompt 的 skill tool 使用规则。
- Modify: `apps/server/src/system-config.ts`  
  增加 `skills` 配置类型和 fastfail 校验。
- Create: `apps/server/src/system-config.test.ts`  
  覆盖 `skills.rootDir` 缺失、空值、正常值。
- Create: `packages/runtime/src/pi-extensions/skills.ts`  
  实现 `listSkillFiles`, `loadSkillFile`, `createSkillTools`。
- Create: `packages/runtime/src/pi-extensions/skills.test.ts`  
  覆盖相对路径、安全边界、query 过滤、工具返回形状。
- Create: `packages/runtime/src/pi-agent-runner.ts`  
  抽出共享 pi-agent runner。
- Create: `packages/runtime/src/pi-agent-runner.test.ts`  
  覆盖 runner 注入 tools、sessionId、事件订阅、超时失败。
- Modify: `packages/runtime/src/pi-sdk-adapter.ts`  
  复用 `runPiAgent(...)`，保持现有 `runAgentTask` 对外接口。
- Modify: `packages/runtime/src/pi-sdk-adapter.test.ts`  
  更新断言，确认 adapter 仍传递 tools，并收集 web_search sources。
- Create: `packages/runtime/src/llm/pi-agent-llm-service.ts`  
  新增 pi-agent-backed `LlmService`。
- Create: `packages/runtime/src/llm/pi-agent-llm-service.test.ts`  
  覆盖消息转换、final assistant 内容提取、工具注入、空内容失败。
- Modify: `packages/runtime/src/index.ts` and `packages/runtime/src/llm/index.ts`  
  导出新工具、新 runner 和新 LLM service。
- Modify: `apps/server/src/server.ts`  
  读取 skill root，创建 skill tools，给 Owner/MissionPlan/HR 的 LLM service 和 runtime `PiSdkAdapter` 注入同一套 skill tools。
- Modify: `apps/server/src/owner/prompts.ts`  
  增加 Owner 使用 skill tools 的系统提示。
- Modify: `apps/server/src/owner/mission-plan.ts`  
  增加 MissionPlan 使用 skill tools 的系统提示。
- Modify: `apps/server/src/hr-agent.ts`  
  增加 HR 使用 skill tools 的系统提示，修正 “software projects” 定位。

---

### Task 1: 配置和初始 Skill 文档

**Files:**
- Modify: `apps/server/config/agent-system.json`
- Modify: `apps/server/src/system-config.ts`
- Create: `apps/server/src/system-config.test.ts`
- Create: `apps/server/config/skills/digitalagent/SKILL.md`
- Create: `apps/server/config/skills/digitalagent/capabilities/agent-collaboration.md`
- Create: `apps/server/config/skills/digitalagent/capabilities/code-writing.md`
- Create: `apps/server/config/skills/digitalagent/capabilities/web-search.md`
- Create: `apps/server/config/skills/digitalagent/capabilities/file-io.md`
- Create: `apps/server/config/skills/digitalagent/capabilities/browser-validation.md`

- [ ] **Step 1: 写失败测试**

Create `apps/server/src/system-config.test.ts`:

```ts
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { loadAgentSystemConfig } from "./system-config.js";

function baseConfig() {
  return {
    owner: {
      prompts: {
        systemPrompt: "owner",
        gatheringInstruction: "gather",
        briefSchema: "{}",
        maxGatheringTurns: 5,
      },
      brief: {
        summaryTemplate: "summary",
        successMetrics: ["metric"],
        constraints: ["constraint"],
      },
      followup: {
        template: "followup {{message}}",
      },
    },
    teamPlanner: {
      baseAgents: [
        {
          role: "owner",
          name: "Owner Agent",
          responsibility: "Own mission",
          status: "idle",
          currentTask: false,
          lastAction: "idle",
          avatarSeed: "owner",
        },
      ],
      capabilityMatchers: {
        plan: ["plan"],
        execute: ["execute"],
        review: ["review"],
      },
    },
    ui: {
      emptyPrompt: "empty",
      starterPrompts: [],
    },
  };
}

function writeConfig(value: unknown) {
  const dir = join(tmpdir(), `digitalagent-config-${Date.now()}-${Math.random()}`);
  mkdirSync(join(dir, "config", "skills"), { recursive: true });
  const file = join(dir, "config", "agent-system.json");
  writeFileSync(file, JSON.stringify(value, null, 2));
  return { dir, file };
}

describe("loadAgentSystemConfig skills config", () => {
  it("loads skills.rootDir when configured", () => {
    const config = baseConfig();
    const { file } = writeConfig({
      ...config,
      skills: { rootDir: "config/skills" },
    });

    expect(loadAgentSystemConfig(file).skills).toEqual({ rootDir: "config/skills" });
  });

  it("fails fast when skills.rootDir is missing", () => {
    const { file } = writeConfig(baseConfig());

    expect(() => loadAgentSystemConfig(file)).toThrow("skills.rootDir is required");
  });

  it("fails fast when skills.rootDir is empty", () => {
    const { file } = writeConfig({
      ...baseConfig(),
      skills: { rootDir: "" },
    });

    expect(() => loadAgentSystemConfig(file)).toThrow("skills.rootDir is required");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run:

```bash
pnpm --filter @digitalagent/server exec vitest run src/system-config.test.ts
```

Expected: FAIL，TypeScript 或运行时断言显示 `skills` 字段不存在或缺少校验。

- [ ] **Step 3: 实现配置类型和校验**

Modify `apps/server/src/system-config.ts`:

```ts
export interface AgentSystemConfig {
  owner: {
    prompts?: {
      systemPrompt: string;
      gatheringInstruction: string;
      briefSchema: string;
      maxGatheringTurns: number;
    };
    brief: {
      summaryTemplate: string;
      successMetrics: string[];
      constraints: string[];
    };
    followup: {
      template: string;
    };
  };
  skills: {
    rootDir: string;
  };
  teamPlanner: {
    baseAgents: ConfigAgentSpec[];
    capabilityMatchers: Record<"plan" | "execute" | "review", string[]>;
  };
  agentCollaboration?: {
    maxConversationDepth: number;
    maxDiscussionRounds?: number;
    cooldownMs: number;
    contextTokenBudget: number;
    personas?: Record<string, {
      role: string;
      systemPrompt: string;
      communicationStyle: string;
      responseGuidelines: string;
      availableActions: string[];
    }>;
  };
  agentAutonomy?: {
    tickIntervalMs?: number;
    maxConcurrentEvals?: number;
    reportFrequencyTicks?: number;
  };
  scheduler?: {
    defaultTimezone?: string;
  };
  ui: {
    emptyPrompt: string;
    starterPrompts: Array<{ label: string; value: string }>;
  };
}
```

Update `validateAgentSystemConfig`:

```ts
function validateAgentSystemConfig(config: AgentSystemConfig): void {
  if (!config.owner?.brief?.summaryTemplate.trim()) throw new Error("owner.brief.summaryTemplate is required");
  if (!config.owner.brief.successMetrics.length) throw new Error("owner.brief.successMetrics is required");
  if (!config.owner.brief.constraints.length) throw new Error("owner.brief.constraints is required");
  if (!config.owner.followup.template.trim()) throw new Error("owner.followup.template is required");
  if (!config.skills?.rootDir?.trim()) throw new Error("skills.rootDir is required");
  if (!config.teamPlanner.baseAgents.length) throw new Error("teamPlanner.baseAgents is required");
  if (!config.teamPlanner.capabilityMatchers.plan.length) throw new Error("teamPlanner.capabilityMatchers.plan is required");
  if (!config.ui.emptyPrompt.trim()) throw new Error("ui.emptyPrompt is required");
}
```

Modify `apps/server/config/agent-system.json` near the top-level root:

```json
"skills": {
  "rootDir": "config/skills"
},
```

- [ ] **Step 4: 创建初始 skill 文档**

Create `apps/server/config/skills/digitalagent/SKILL.md`:

```md
# DigitalAgent Skill

DigitalAgent 是一个 Mission 执行系统，不是普通问答助手，也不是默认帮用户搭建外部项目的项目管理工具。

DigitalAgent 可以把用户目标转成 MissionBrief，生成 MissionPlan，由 HR 招募 mission 内临时 agent 团队，并通过任务执行、A2A 协作、汇报、评审和产物迭代推进目标。

## 使用原则

- 当用户要求 DigitalAgent 的 agent 执行、协作、测试、验证或产出结果时，应把目标理解为一个 DigitalAgent mission。
- 不要把“调用 DigitalAgent 内部 agent 协作能力完成任务”误解为“构建一个 agent 协作系统”。
- 如果用户明确要求开发软件、实现代码、搭建 Web App、写脚本或创建仓库，应把目标理解为代码构建类 mission。
- 只追问会阻塞 MissionBrief、MissionPlan、团队招募或验收的信息。
- agent 分工、协作方式、执行顺序、工具选择通常由 MissionPlan 和 HR 基于目标自行设计。

## 能力详情

- `digitalagent/capabilities/agent-collaboration.md`
- `digitalagent/capabilities/code-writing.md`
- `digitalagent/capabilities/web-search.md`
- `digitalagent/capabilities/file-io.md`
- `digitalagent/capabilities/browser-validation.md`
```

Create `apps/server/config/skills/digitalagent/capabilities/agent-collaboration.md`:

```md
# Agent Collaboration

DigitalAgent 可以在一个 mission 内创建多个临时 agent，通过任务分配、A2A 对话、层级汇报、评审和后续任务推进协作。

适用场景：

- 用户要测试 mission 中 agent 间协作是否打通。
- 用户要求多个 agent 轮流完成任务，例如成语接龙、分工研究、交叉 review。
- 用户要求一个 agent 产出后触发另一个 agent 继续处理。

计划建议：

- MissionPlan 应描述协作目标、轮次、交接条件、验收标准。
- HR 应招募围绕任务执行的角色，而不是现实组织岗位。
- 如果任务是协作能力验证，角色应服务于验证链路，例如轮次推进、规则校验、结果汇总、质量评审。
```

Create `apps/server/config/skills/digitalagent/capabilities/code-writing.md`:

```md
# Code Writing

DigitalAgent 可以把代码构建目标拆成设计、实现、测试、review 和修复任务。

适用场景：

- 用户明确要求实现功能、修复 bug、编写脚本、搭建应用或修改仓库代码。
- 用户要求验证代码行为、运行测试、生成 PR 或提交代码。

计划建议：

- MissionBrief 应保留真实构建目标，不要把代码任务改写成咨询任务。
- MissionPlan 应包含实现范围、涉及文件、测试命令和验收标准。
- HR 可招募开发、测试、review、架构或调试角色。
```

Create `apps/server/config/skills/digitalagent/capabilities/web-search.md`:

```md
# Web Search

DigitalAgent 可以让 agent 使用网页搜索获取外部信息，并把搜索来源纳入结果。

适用场景：

- 用户要求查找最新资料、引用来源、竞品信息、政策信息或公开网页证据。
- 任务验收要求 URL、标题、摘要或出处。

计划建议：

- MissionPlan 应明确需要搜索的问题和引用验收标准。
- HR 应至少安排一个负责检索、核验或引用整理的角色。
```

Create `apps/server/config/skills/digitalagent/capabilities/file-io.md`:

```md
# File IO

DigitalAgent 可以通过文件读写在 agent 间传递中间状态或生成可检查产物。

适用场景：

- 用户要求把过程写入文件。
- 多个 agent 需要读取同一份状态、日志、清单或中间产物。
- 验收要求检查某个文件是否存在、是否包含指定结构或内容。

计划建议：

- MissionPlan 应说明文件名、写入规则、读取规则和最终检查方式。
- HR 应避免让所有角色无序写同一个文件；需要设计记录者、校验者或协调者。
```

Create `apps/server/config/skills/digitalagent/capabilities/browser-validation.md`:

```md
# Browser Validation

DigitalAgent 可以通过浏览器验证本地或远程页面的可见行为。

适用场景：

- 用户要求确认页面交互、布局、流程或端到端体验。
- 任务涉及前端功能、表单、按钮、状态流转或浏览器可见错误。

计划建议：

- MissionPlan 应描述需要打开的 URL、关键交互、可见断言和失败信号。
- HR 可安排测试或验收角色专门负责浏览器验证。
```

- [ ] **Step 5: 运行测试确认通过**

Run:

```bash
pnpm --filter @digitalagent/server exec vitest run src/system-config.test.ts
```

Expected: PASS.

- [ ] **Step 6: 提交**

```bash
git add apps/server/config/agent-system.json apps/server/config/skills apps/server/src/system-config.ts apps/server/src/system-config.test.ts
git commit -m "feat: add digitalagent skill config"
```

---

### Task 2: Skill 文件系统工具

**Files:**
- Create: `packages/runtime/src/pi-extensions/skills.ts`
- Create: `packages/runtime/src/pi-extensions/skills.test.ts`
- Modify: `packages/runtime/src/index.ts`

- [ ] **Step 1: 写失败测试**

Create `packages/runtime/src/pi-extensions/skills.test.ts`:

```ts
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createSkillTools, listSkillFiles, loadSkillFile } from "./skills.js";

function createSkillRoot() {
  const root = join(tmpdir(), `digitalagent-skills-${Date.now()}-${Math.random()}`);
  mkdirSync(join(root, "digitalagent", "capabilities"), { recursive: true });
  writeFileSync(join(root, "digitalagent", "SKILL.md"), "# DigitalAgent Skill\n\nCore summary.");
  writeFileSync(join(root, "digitalagent", "capabilities", "agent-collaboration.md"), "# Agent Collaboration\n\nA2A collaboration.");
  writeFileSync(join(root, "digitalagent", "notes.txt"), "not markdown");
  return root;
}

describe("skill filesystem helpers", () => {
  it("lists markdown skill files as relative paths", async () => {
    const rootDir = createSkillRoot();

    const files = await listSkillFiles({ rootDir });

    expect(files).toEqual([
      { path: "digitalagent/SKILL.md", title: "DigitalAgent Skill" },
      { path: "digitalagent/capabilities/agent-collaboration.md", title: "Agent Collaboration" },
    ]);
  });

  it("filters skill files by query", async () => {
    const rootDir = createSkillRoot();

    const files = await listSkillFiles({ rootDir, query: "collaboration" });

    expect(files).toEqual([
      { path: "digitalagent/capabilities/agent-collaboration.md", title: "Agent Collaboration" },
    ]);
  });

  it("loads a relative markdown skill file", async () => {
    const rootDir = createSkillRoot();

    const loaded = await loadSkillFile({ rootDir, path: "digitalagent/SKILL.md" });

    expect(loaded).toEqual({
      path: "digitalagent/SKILL.md",
      content: "# DigitalAgent Skill\n\nCore summary.",
    });
  });

  it("rejects absolute paths", async () => {
    const rootDir = createSkillRoot();

    await expect(loadSkillFile({ rootDir, path: join(rootDir, "digitalagent", "SKILL.md") }))
      .rejects.toThrow("Skill path must be relative");
  });

  it("rejects path traversal", async () => {
    const rootDir = createSkillRoot();

    await expect(loadSkillFile({ rootDir, path: "../secret.md" }))
      .rejects.toThrow("Skill path cannot contain path traversal");
  });

  it("rejects non-markdown files", async () => {
    const rootDir = createSkillRoot();

    await expect(loadSkillFile({ rootDir, path: "digitalagent/notes.txt" }))
      .rejects.toThrow("Only markdown skill files are supported");
  });

  it("rejects missing files", async () => {
    const rootDir = createSkillRoot();

    await expect(loadSkillFile({ rootDir, path: "digitalagent/missing.md" }))
      .rejects.toThrow("Skill file not found");
  });
});

describe("createSkillTools", () => {
  it("creates list_skill_files and load_skill tools", async () => {
    const rootDir = createSkillRoot();
    const tools = createSkillTools({ rootDir });

    expect(tools.map((tool) => tool.name)).toEqual(["list_skill_files", "load_skill"]);

    const listResult = await tools[0]!.execute("call-1", {});
    expect(listResult.content[0]?.text).toContain("digitalagent/SKILL.md");

    const loadResult = await tools[1]!.execute("call-2", { path: "digitalagent/SKILL.md" });
    expect(loadResult.content[0]?.text).toContain("# DigitalAgent Skill");
    expect(loadResult.details).toEqual({ path: "digitalagent/SKILL.md" });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run:

```bash
pnpm --filter @digitalagent/runtime exec vitest run src/pi-extensions/skills.test.ts
```

Expected: FAIL with module not found for `./skills.js`.

- [ ] **Step 3: 实现 skill 工具**

Create `packages/runtime/src/pi-extensions/skills.ts`:

```ts
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { Type } from "@sinclair/typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";

export interface SkillFileInfo {
  path: string;
  title: string;
}

export interface SkillToolOptions {
  rootDir: string;
}

const ListSkillFilesParameters = Type.Object({
  query: Type.Optional(Type.String({ description: "Optional case-insensitive filter for skill path, title, or content." })),
});

const LoadSkillParameters = Type.Object({
  path: Type.String({ description: "Relative markdown skill path, for example digitalagent/SKILL.md." }),
});

export async function listSkillFiles(input: { rootDir: string; query?: string }): Promise<SkillFileInfo[]> {
  const root = resolve(input.rootDir);
  if (!existsSync(root)) {
    throw new Error(`Skill root not found: ${root}`);
  }

  const files = await collectMarkdownFiles(root, root);
  const query = input.query?.trim().toLowerCase();
  const result: SkillFileInfo[] = [];

  for (const path of files.sort()) {
    const loaded = await loadSkillFile({ rootDir: root, path });
    const haystack = `${path}\n${loaded.content}`.toLowerCase();
    if (query && !haystack.includes(query)) continue;
    result.push({ path, title: firstMarkdownHeading(loaded.content) ?? path });
  }

  return result;
}

export async function loadSkillFile(input: { rootDir: string; path: string }): Promise<{ path: string; content: string }> {
  const root = resolve(input.rootDir);
  const requestedPath = input.path;

  if (isAbsolute(requestedPath)) {
    throw new Error("Skill path must be relative");
  }
  if (requestedPath.split(/[\\/]+/).includes("..")) {
    throw new Error("Skill path cannot contain path traversal");
  }
  if (!requestedPath.endsWith(".md")) {
    throw new Error("Only markdown skill files are supported");
  }

  const absolute = resolve(root, requestedPath);
  const relativePath = relative(root, absolute);
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error("Skill path escapes skill root");
  }
  if (!existsSync(absolute)) {
    throw new Error(`Skill file not found: ${requestedPath}`);
  }

  return {
    path: normalizeRelativePath(relativePath),
    content: await readFile(absolute, "utf8"),
  };
}

export function createSkillTools(options: SkillToolOptions): AgentTool<any>[] {
  return [
    {
      name: "list_skill_files",
      label: "List Skill Files",
      description: "List available DigitalAgent skill markdown files by relative path.",
      parameters: ListSkillFilesParameters,
      async execute(_toolCallId, params) {
        const files = await listSkillFiles({ rootDir: options.rootDir, query: params.query });
        return {
          content: [{ type: "text", text: JSON.stringify(files, null, 2) }],
          details: { count: files.length },
        };
      },
    },
    {
      name: "load_skill",
      label: "Load Skill",
      description: "Load a DigitalAgent skill markdown file by relative path.",
      parameters: LoadSkillParameters,
      async execute(_toolCallId, params) {
        const loaded = await loadSkillFile({ rootDir: options.rootDir, path: params.path });
        return {
          content: [{ type: "text", text: loaded.content }],
          details: { path: loaded.path },
        };
      },
    },
  ];
}

async function collectMarkdownFiles(root: string, dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const absolute = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectMarkdownFiles(root, absolute));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(normalizeRelativePath(relative(root, absolute)));
    }
  }
  return files;
}

function firstMarkdownHeading(content: string): string | undefined {
  const line = content.split(/\r?\n/).find((item) => item.startsWith("# "));
  return line?.replace(/^#\s+/, "").trim() || undefined;
}

function normalizeRelativePath(path: string): string {
  return path.split(sep).join("/");
}
```

- [ ] **Step 4: 导出 skill 工具**

Modify `packages/runtime/src/index.ts`:

```ts
export * from "./pi-sdk-adapter.js";
export * from "./pi-hooks.js";
export { createWebSearchTool, searchWeb } from "./pi-extensions/web-search.js";
export type { WebSearchToolOptions, SearchOptions, SearchResult, SearchResponse } from "./pi-extensions/web-search.js";
export { createSkillTools, listSkillFiles, loadSkillFile } from "./pi-extensions/skills.js";
export type { SkillFileInfo, SkillToolOptions } from "./pi-extensions/skills.js";
export * from "./llm/index.js";
```

- [ ] **Step 5: 运行测试确认通过**

Run:

```bash
pnpm --filter @digitalagent/runtime exec vitest run src/pi-extensions/skills.test.ts
```

Expected: PASS.

- [ ] **Step 6: 提交**

```bash
git add packages/runtime/src/pi-extensions/skills.ts packages/runtime/src/pi-extensions/skills.test.ts packages/runtime/src/index.ts
git commit -m "feat: add skill loading tools"
```

---

### Task 3: 抽出共享 pi-agent runner 并保持 runtime adapter 行为

**Files:**
- Create: `packages/runtime/src/pi-agent-runner.ts`
- Create: `packages/runtime/src/pi-agent-runner.test.ts`
- Modify: `packages/runtime/src/pi-sdk-adapter.ts`
- Modify: `packages/runtime/src/pi-sdk-adapter.test.ts`
- Modify: `packages/runtime/src/index.ts`

- [ ] **Step 1: 写 runner 失败测试**

Create `packages/runtime/src/pi-agent-runner.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { runPiAgent } from "./pi-agent-runner.js";

describe("runPiAgent", () => {
  it("constructs a pi-agent with tools, session id, and initial messages", async () => {
    const tool = {
      name: "load_skill",
      label: "Load Skill",
      description: "Load a skill",
      parameters: {} as never,
      execute: vi.fn(),
    };
    const fakeAgent = {
      prompt: vi.fn().mockResolvedValue(undefined),
      subscribe: vi.fn(),
      state: { messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }] },
    };
    const agentFactory = vi.fn().mockReturnValue(fakeAgent);

    const result = await runPiAgent({
      apiKey: "k",
      modelProvider: "minimax-cn",
      modelId: "MiniMax-M2.7-highspeed",
      systemPrompt: "system",
      messages: [{ role: "user", content: "previous" }],
      prompt: "next",
      tools: [tool],
      sessionId: "session-1",
      timeoutSeconds: 5,
      agentFactory: agentFactory as never,
    });

    expect(agentFactory).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-1",
        initialState: expect.objectContaining({
          systemPrompt: "system",
          tools: [tool],
          messages: [{ role: "user", content: "previous" }],
        }),
      }),
    );
    expect(fakeAgent.prompt).toHaveBeenCalledWith("next");
    expect(result.messages).toEqual(fakeAgent.state.messages);
  });

  it("forwards agent events to onEvent", async () => {
    let handler: ((event: unknown) => void) | undefined;
    const onEvent = vi.fn();
    const fakeAgent = {
      prompt: vi.fn().mockImplementation(async () => {
        handler?.({ type: "tool_execution_end", toolName: "web_search" });
      }),
      subscribe: vi.fn().mockImplementation((next) => {
        handler = next;
      }),
      state: { messages: [] },
    };

    await runPiAgent({
      apiKey: "k",
      modelProvider: "minimax-cn",
      modelId: "MiniMax-M2.7-highspeed",
      systemPrompt: "",
      messages: [],
      prompt: "run",
      tools: [],
      timeoutSeconds: 5,
      onEvent,
      agentFactory: (() => fakeAgent) as never,
    });

    expect(onEvent).toHaveBeenCalledWith({ type: "tool_execution_end", toolName: "web_search" });
  });
});
```

- [ ] **Step 2: 运行 runner 测试确认失败**

Run:

```bash
pnpm --filter @digitalagent/runtime exec vitest run src/pi-agent-runner.test.ts
```

Expected: FAIL with module not found for `./pi-agent-runner.js`.

- [ ] **Step 3: 实现共享 runner**

Create `packages/runtime/src/pi-agent-runner.ts`:

```ts
import { Agent, type AgentEvent, type AgentTool } from "@earendil-works/pi-agent-core";
import { getModel, type Model } from "@earendil-works/pi-ai";

export interface PiAgentMessage {
  role: "user" | "assistant";
  content: string | Array<{ type: "text"; text: string }>;
}

export interface PiAgentConfig {
  initialState: {
    systemPrompt: string;
    model: Model<any>;
    tools: AgentTool<any>[];
    messages: PiAgentMessage[];
  };
  sessionId?: string;
  getApiKey?: () => Promise<string>;
}

export interface PiAgentLike {
  prompt(text: string): Promise<void>;
  subscribe(handler: (event: AgentEvent) => void): void;
  state: {
    messages: unknown[];
  };
}

export interface RunPiAgentInput {
  apiKey: string;
  modelProvider?: string;
  modelId?: string;
  systemPrompt: string;
  messages: PiAgentMessage[];
  prompt: string;
  tools: AgentTool<any>[];
  timeoutSeconds: number;
  sessionId?: string;
  onEvent?: (event: AgentEvent) => void;
  agentFactory?: (config: PiAgentConfig) => PiAgentLike;
}

export interface RunPiAgentResult {
  messages: unknown[];
}

export async function runPiAgent(input: RunPiAgentInput): Promise<RunPiAgentResult> {
  const model = resolveModelSafe(input.modelProvider ?? "minimax-cn", input.modelId ?? "MiniMax-M2.7-highspeed");
  const config: PiAgentConfig = {
    initialState: {
      systemPrompt: input.systemPrompt,
      model,
      tools: input.tools,
      messages: input.messages,
    },
    getApiKey: async () => input.apiKey,
  };
  if (input.sessionId) {
    config.sessionId = input.sessionId;
  }

  const agentFactory = input.agentFactory ?? ((agentConfig) => new Agent(agentConfig as never) as unknown as PiAgentLike);
  const agent = agentFactory(config);
  agent.subscribe((event) => {
    input.onEvent?.(event);
  });

  await runWithTimeout(agent.prompt(input.prompt), input.timeoutSeconds);
  return { messages: agent.state.messages };
}

export function resolveModelSafe(provider: string, modelId: string): Model<any> {
  try {
    const model = getModel(provider as any, modelId as any);
    if (model) return model as Model<any>;
  } catch {
    // fall through to custom model shape
  }
  return {
    id: modelId,
    name: modelId,
    api: "openai-completions",
    provider,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 4096,
  } as Model<any>;
}

export function runWithTimeout<T>(promise: Promise<T>, timeoutSeconds: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`pi-agent timed out after ${timeoutSeconds}s`)), timeoutSeconds * 1000);
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}
```

- [ ] **Step 4: 重构 `PiSdkAdapter` 复用 runner**

Modify `packages/runtime/src/pi-sdk-adapter.ts`:

```ts
import type { AgentEvent, AgentTool } from "@earendil-works/pi-agent-core";
import type { Source } from "@digitalagent/core";
import { runPiAgent, type PiAgentConfig, type PiAgentLike } from "./pi-agent-runner.js";
```

Keep the public `AgentConfig` and `AgentLike` aliases for tests:

```ts
export type AgentConfig = PiAgentConfig;
export type AgentLike = PiAgentLike;
```

Update `runAgentTask`:

```ts
  async runAgentTask(input: RunAgentTaskInput): Promise<RunAgentTaskResult> {
    const sources: Source[] = [];

    try {
      const result = await runPiAgent({
        apiKey: this.apiKey,
        modelProvider: this.modelProvider,
        modelId: this.modelId,
        systemPrompt: input.systemPrompt ?? "",
        messages: [],
        prompt: input.message,
        tools: this.tools,
        timeoutSeconds: input.timeoutSeconds,
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        onEvent: (event) => collectSourcesFromEvent(event, sources),
        agentFactory: this.agentFactory,
      });
      return {
        status: "completed",
        output: { messages: result.messages },
        stderr: "",
        sources,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        status: "failed",
        output: { messages: [], error: message },
        stderr: message,
        sources,
        error: message,
      };
    }
  }
```

Remove local `resolveModelSafe` and `runWithTimeout` from `pi-sdk-adapter.ts` after the adapter imports them through `runPiAgent`.

- [ ] **Step 5: 更新失败结果测试**

Modify the failed status test in `packages/runtime/src/pi-sdk-adapter.test.ts` so it no longer expects state messages from the failed fake agent:

```ts
expect(result).toMatchObject({
  status: "failed",
  stderr: "pi blew up",
  error: "pi blew up",
  output: { messages: [], error: "pi blew up" },
});
```

- [ ] **Step 6: 导出 runner**

Modify `packages/runtime/src/index.ts`:

```ts
export * from "./pi-agent-runner.js";
```

- [ ] **Step 7: 运行 runtime 测试**

Run:

```bash
pnpm --filter @digitalagent/runtime exec vitest run src/pi-agent-runner.test.ts src/pi-sdk-adapter.test.ts
```

Expected: PASS.

- [ ] **Step 8: 提交**

```bash
git add packages/runtime/src/pi-agent-runner.ts packages/runtime/src/pi-agent-runner.test.ts packages/runtime/src/pi-sdk-adapter.ts packages/runtime/src/pi-sdk-adapter.test.ts packages/runtime/src/index.ts
git commit -m "refactor: share pi-agent runner"
```

---

### Task 4: PiAgentLlmService

**Files:**
- Create: `packages/runtime/src/llm/pi-agent-llm-service.ts`
- Create: `packages/runtime/src/llm/pi-agent-llm-service.test.ts`
- Modify: `packages/runtime/src/llm/index.ts`
- Modify: `packages/runtime/src/index.ts`

- [ ] **Step 1: 写失败测试**

Create `packages/runtime/src/llm/pi-agent-llm-service.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { createPiAgentLlmService } from "./pi-agent-llm-service.js";

describe("createPiAgentLlmService", () => {
  it("runs pi-agent with system prompt, prior messages, latest prompt, and tools", async () => {
    const tool = {
      name: "load_skill",
      label: "Load Skill",
      description: "Load a skill",
      parameters: {} as never,
      execute: vi.fn(),
    };
    const fakeAgent = {
      prompt: vi.fn().mockResolvedValue(undefined),
      subscribe: vi.fn(),
      state: {
        messages: [
          { role: "assistant", content: [{ type: "text", text: "{\"status\":\"ready\"}" }] },
        ],
      },
    };
    const agentFactory = vi.fn().mockReturnValue(fakeAgent);
    const llm = createPiAgentLlmService({
      apiKey: "k",
      modelProvider: "minimax-cn",
      modelId: "MiniMax-M2.7-highspeed",
      tools: [tool],
      agentFactory: agentFactory as never,
    });

    const response = await llm.call([
      { role: "system", content: "system-a" },
      { role: "system", content: "system-b" },
      { role: "user", content: "first" },
      { role: "assistant", content: "answer" },
      { role: "user", content: "latest" },
    ]);

    expect(agentFactory).toHaveBeenCalledWith(
      expect.objectContaining({
        initialState: expect.objectContaining({
          systemPrompt: "system-a\n\nsystem-b",
          tools: [tool],
          messages: [
            { role: "user", content: "first" },
            { role: "assistant", content: [{ type: "text", text: "answer" }] },
          ],
        }),
      }),
    );
    expect(fakeAgent.prompt).toHaveBeenCalledWith("latest");
    expect(response.content).toBe("{\"status\":\"ready\"}");
    expect(response.finishReason).toBe("stop");
  });

  it("streams final content through onStream when token events are unavailable", async () => {
    const fakeAgent = {
      prompt: vi.fn().mockResolvedValue(undefined),
      subscribe: vi.fn(),
      state: {
        messages: [{ role: "assistant", content: [{ type: "text", text: "hello" }] }],
      },
    };
    const onStream = vi.fn();
    const llm = createPiAgentLlmService({
      apiKey: "k",
      tools: [],
      agentFactory: (() => fakeAgent) as never,
    });

    await llm.call([{ role: "user", content: "say hello" }], { onStream });

    expect(onStream).toHaveBeenCalledWith("hello");
  });

  it("fails fast when no user prompt exists", async () => {
    const llm = createPiAgentLlmService({ apiKey: "k", tools: [] });

    await expect(llm.call([{ role: "system", content: "system" }]))
      .rejects.toThrow("PiAgentLlmService requires a user message");
  });

  it("fails fast when pi-agent returns no assistant text", async () => {
    const fakeAgent = {
      prompt: vi.fn().mockResolvedValue(undefined),
      subscribe: vi.fn(),
      state: { messages: [] },
    };
    const llm = createPiAgentLlmService({
      apiKey: "k",
      tools: [],
      agentFactory: (() => fakeAgent) as never,
    });

    await expect(llm.call([{ role: "user", content: "x" }]))
      .rejects.toThrow("PiAgentLlmService returned no assistant content");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run:

```bash
pnpm --filter @digitalagent/runtime exec vitest run src/llm/pi-agent-llm-service.test.ts
```

Expected: FAIL with module not found.

- [ ] **Step 3: 实现 PiAgentLlmService**

Create `packages/runtime/src/llm/pi-agent-llm-service.ts`:

```ts
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { runPiAgent, type PiAgentLike, type PiAgentConfig, type PiAgentMessage } from "../pi-agent-runner.js";
import type { LlmService } from "./llm-service.js";
import type { LlmCallStats, LlmMessage } from "./types.js";

export interface CreatePiAgentLlmServiceOptions {
  apiKey: string;
  modelProvider?: string;
  modelId?: string;
  tools: AgentTool<any>[];
  timeoutSeconds?: number;
  agentFactory?: (config: PiAgentConfig) => PiAgentLike;
}

export function createPiAgentLlmService(options: CreatePiAgentLlmServiceOptions): LlmService {
  if (!options.apiKey) {
    throw new Error("LLM API key is required");
  }

  let stats: LlmCallStats = {
    totalCalls: 0,
    totalPromptTokens: 0,
    totalCompletionTokens: 0,
  };

  return {
    async call(messages, callOptions) {
      const prepared = preparePiAgentMessages(messages);
      const timeoutSeconds = callOptions?.timeoutMs !== undefined
        ? Math.ceil(callOptions.timeoutMs / 1000)
        : options.timeoutSeconds ?? 90;
      const result = await runPiAgent({
        apiKey: options.apiKey,
        modelProvider: options.modelProvider,
        modelId: callOptions?.model ?? options.modelId,
        systemPrompt: prepared.systemPrompt,
        messages: prepared.messages,
        prompt: prepared.prompt,
        tools: options.tools,
        timeoutSeconds,
        ...(options.agentFactory ? { agentFactory: options.agentFactory } : {}),
      });

      const content = extractLastAssistantText(result.messages);
      if (!content.trim()) {
        throw new Error("PiAgentLlmService returned no assistant content");
      }
      callOptions?.onStream?.(content);

      const promptTokens = messages.reduce((sum, message) => sum + message.content.length, 0);
      const completionTokens = content.length;
      stats = {
        totalCalls: stats.totalCalls + 1,
        totalPromptTokens: stats.totalPromptTokens + promptTokens,
        totalCompletionTokens: stats.totalCompletionTokens + completionTokens,
        lastCallAt: new Date().toISOString(),
      };

      return {
        content,
        model: callOptions?.model ?? options.modelId ?? "MiniMax-M2.7-highspeed",
        usage: {
          promptTokens,
          completionTokens,
          totalTokens: promptTokens + completionTokens,
        },
        finishReason: "stop",
      };
    },
    stats() {
      return stats;
    },
  };
}

function preparePiAgentMessages(messages: LlmMessage[]): { systemPrompt: string; messages: PiAgentMessage[]; prompt: string } {
  const systemParts: string[] = [];
  const conversational: PiAgentMessage[] = [];

  for (const message of messages) {
    if (message.role === "system") {
      systemParts.push(message.content);
    } else if (message.role === "assistant") {
      conversational.push({ role: "assistant", content: [{ type: "text", text: message.content }] });
    } else {
      conversational.push({ role: "user", content: message.content });
    }
  }

  const last = conversational.at(-1);
  if (!last || last.role !== "user" || typeof last.content !== "string") {
    throw new Error("PiAgentLlmService requires a user message");
  }

  return {
    systemPrompt: systemParts.join("\n\n"),
    messages: conversational.slice(0, -1),
    prompt: last.content,
  };
}

function extractLastAssistantText(messages: unknown[]): string {
  for (const message of [...messages].reverse()) {
    if (!isRecord(message) || message.role !== "assistant") continue;
    const content = message.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .map((item) => isRecord(item) && typeof item.text === "string" ? item.text : "")
        .join("");
    }
  }
  return "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
```

- [ ] **Step 4: 导出 PiAgentLlmService**

Modify `packages/runtime/src/llm/index.ts`:

```ts
export * from "./types.js";
export * from "./llm-service.js";
export * from "./llm-factory.js";
export * from "./fake-llm-adapter.js";
export * from "./pi-agent-llm-service.js";
```

`packages/runtime/src/index.ts` already exports `./llm/index.js`; no additional top-level export is needed after this change.

- [ ] **Step 5: 运行测试**

Run:

```bash
pnpm --filter @digitalagent/runtime exec vitest run src/llm/pi-agent-llm-service.test.ts
```

Expected: PASS.

- [ ] **Step 6: 提交**

```bash
git add packages/runtime/src/llm/pi-agent-llm-service.ts packages/runtime/src/llm/pi-agent-llm-service.test.ts packages/runtime/src/llm/index.ts
git commit -m "feat: add pi-agent llm service"
```

---

### Task 5: Server 接入同一套 Skill Tools

**Files:**
- Modify: `apps/server/src/server.ts`
- Modify: `apps/server/src/server.ts` imports from `@digitalagent/runtime`
- Modify: `packages/runtime/src/index.ts` if exports are missing after Task 2-4

- [ ] **Step 1: 写构建前检查命令**

Run:

```bash
pnpm --filter @digitalagent/server typecheck
```

Expected before implementation: FAIL after code references are added, or PASS if not yet changed. This command is the guardrail for this task.

- [ ] **Step 2: 修改 server imports**

Modify `apps/server/src/server.ts` import:

```ts
import {
  PiSdkAdapter,
  createPiAgentLlmService,
  createSkillTools,
  createWebSearchTool,
} from "@digitalagent/runtime";
import { loadAgentSystemConfig } from "./system-config.js";
```

- [ ] **Step 3: 创建共享 skill tools**

In `apps/server/src/server.ts`, after `dataFile`, add:

```ts
const configFile = join(root, "..", "config", "agent-system.json");
const agentConfig = loadAgentSystemConfig(configFile);
const skillRoot = join(root, "..", agentConfig.skills.rootDir);
const skillTools = createSkillTools({ rootDir: skillRoot });
```

- [ ] **Step 4: 用 PiAgentLlmService 替换 completion-only LLM**

Replace:

```ts
const llm = createLlmServiceFromEnv(process.env);
```

with:

```ts
const apiKey =
  process.env.LLM_API_KEY ??
  process.env.MINIMAX_API_KEY ??
  process.env.ANTHROPIC_API_KEY ??
  "";

const llm = createPiAgentLlmService({
  apiKey,
  modelProvider: process.env.LLM_PROVIDER ?? "minimax-cn",
  modelId: process.env.LLM_MODEL ?? "MiniMax-M2.7-highspeed",
  tools: skillTools,
});
```

Remove the later duplicate `apiKey` declaration.

- [ ] **Step 5: 给 runtime PiSdkAdapter 注入同一套 skill tools**

Modify the `PiSdkAdapter` construction:

```ts
const pi = new PiSdkAdapter({
  apiKey,
  modelProvider: process.env.LLM_PROVIDER ?? "minimax-cn",
  modelId: process.env.LLM_MODEL ?? "MiniMax-M2.7-highspeed",
  tools: [...skillTools, createWebSearchTool({})],
});
```

- [ ] **Step 6: 保持 mission service 使用同一 config file**

Modify service construction:

```ts
const missions = new InMemoryMissionService({ storageFile: dataFile, configFile, llm, runtime });
```

- [ ] **Step 7: 运行 typecheck**

Run:

```bash
pnpm --filter @digitalagent/server typecheck
```

Expected: PASS.

- [ ] **Step 8: 提交**

```bash
git add apps/server/src/server.ts
git commit -m "feat: wire skill tools into server agents"
```

---

### Task 6: Prompt 接入 Skill 使用规则

**Files:**
- Modify: `apps/server/src/owner/prompts.ts`
- Modify: `apps/server/src/owner/mission-plan.ts`
- Modify: `apps/server/src/hr-agent.ts`
- Modify: `apps/server/src/owner/prompts.test.ts`
- Modify: `apps/server/src/owner/mission-plan.test.ts`
- Modify: `apps/server/src/hr-agent.test.ts`

- [ ] **Step 1: Owner prompt 测试**

Modify `apps/server/src/owner/prompts.test.ts` in `buildOwnerSystemPrompt` tests to include:

```ts
expect(prompt).toContain("list_skill_files");
expect(prompt).toContain("load_skill");
expect(prompt).toContain("digitalagent/SKILL.md");
expect(prompt).toContain("Do not rewrite DigitalAgent internal mission execution into an external software-building project");
```

- [ ] **Step 2: MissionPlan prompt 测试**

Modify `apps/server/src/owner/mission-plan.test.ts` to assert the system prompt contains skill instructions:

```ts
const messages = buildMissionPlanMessages({ brief });
expect(messages[0]?.content).toContain("list_skill_files");
expect(messages[0]?.content).toContain("load_skill");
expect(messages[0]?.content).toContain("digitalagent/SKILL.md");
```

- [ ] **Step 3: HR prompt 测试**

Keep `buildHRAgentSystemPrompt` private. Add a behavior test in `apps/server/src/hr-agent.test.ts` using a fake LLM handler that captures messages:

```ts
const calls: Array<{ role: string; content: string }[]> = [];
const hrAgent = createHRAgent({
  llm: new FakeLlmAdapter((messages) => {
    calls.push(messages);
    return JSON.stringify({
      analysis: {
        requiredCapabilities: ["agent_collaboration"],
        estimatedTeamSize: 2,
        priorityRoles: ["Coordinator", "Reviewer"],
        complexity: "low",
        riskFactors: ["rule drift"],
      },
      roleSpecs: [
        {
          name: "接龙协调员",
          purpose: "推进接龙轮次",
          responsibilities: ["安排轮次"],
          capabilities: ["agent_collaboration"],
          allowedTools: ["load_skill"],
          successCriteria: ["轮次清晰"],
          budget: { maxRuntimeMinutes: 60, maxTasks: 3 },
        },
        {
          name: "规则审核员",
          purpose: "审核成语接龙规则",
          responsibilities: ["检查成语合法性"],
          capabilities: ["review"],
          allowedTools: ["load_skill"],
          successCriteria: ["规则检查完成"],
          budget: { maxRuntimeMinutes: 60, maxTasks: 3 },
        },
      ],
    });
  }),
});

await hrAgent.analyzeAndPlan("mission_1", missionBrief);
expect(calls[0]?.[0]?.content).toContain("list_skill_files");
expect(calls[0]?.[0]?.content).toContain("load_skill");
expect(calls[0]?.[0]?.content).toContain("DigitalAgent mission execution system");
```

- [ ] **Step 4: 运行 prompt 测试确认失败**

Run:

```bash
pnpm --filter @digitalagent/server exec vitest run src/owner/prompts.test.ts src/owner/mission-plan.test.ts src/hr-agent.test.ts
```

Expected: FAIL because prompts do not yet include skill tool guidance.

- [ ] **Step 5: 更新 Owner prompt**

Modify `apps/server/src/owner/prompts.ts`:

```ts
const SKILL_TOOL_DIRECTIVE = [
  "DigitalAgent capability context:",
  "You have access to skill loading tools: list_skill_files and load_skill.",
  "Use load_skill with digitalagent/SKILL.md when you need to understand how DigitalAgent should execute a user mission.",
  "Load more specific skill files only when the mission requires capability guidance.",
  "Do not expose skill loading details to the user.",
  "Interpret user requests in the context of DigitalAgent capabilities.",
  "Do not rewrite DigitalAgent internal mission execution into an external software-building project unless the user explicitly asks to build software.",
].join("\n");
```

Update `buildOwnerSystemPrompt`:

```ts
export function buildOwnerSystemPrompt(systemPrompt: string, gatheringInstruction: string, briefSchema: string): string {
  return `${systemPrompt}

${SKILL_TOOL_DIRECTIVE}

${gatheringInstruction}

CRITICAL: You may ONLY ask ONE question per response. Ask more than one question and the conversation will be rejected. If answer choices would help, put them on separate lines using this format:
A. First option
B. Second option
C. Third option

When you are ready to produce a MissionBrief, respond with ONLY a JSON object matching this schema (no markdown, no explanation):
${briefSchema}`;
}
```

- [ ] **Step 6: 更新 MissionPlan prompt**

Modify `apps/server/src/owner/mission-plan.ts` system content:

```ts
content: `You are the Owner planning workflow for DigitalAgent.
You have access to skill loading tools: list_skill_files and load_skill.
Use load_skill with digitalagent/SKILL.md when you need DigitalAgent capability context for planning.
Do not expose skill loading details in the returned JSON.
Return ONLY a JSON object. No markdown, no explanation.
The JSON must contain: goal, successMetrics, phases, workstreams, reportingLines, scheduleRhythms, risks, checkpoints.
goal must be a string. successMetrics, risks, and checkpoints must be arrays of strings.
Each phase must contain: name, objective, deliverables, successCriteria.
Each phase deliverables and successCriteria must be arrays of strings.
Each workstream must contain: name, objective, requiredRole, responsibilities, firstTaskGoal.
Each workstream responsibilities must be an array of strings.
Each reporting line must contain: fromRole, toRole, cadence, purpose.
Each schedule rhythm must contain: name, cadence, ownerRole, purpose.
Keep arrays concise with 1 to 3 items. Do not omit arrays. Use empty arrays only for risks when there are genuinely no risks.`,
```

- [ ] **Step 7: 更新 HR prompt**

Modify `buildHRAgentSystemPrompt()` in `apps/server/src/hr-agent.ts`:

```ts
function buildHRAgentSystemPrompt(): string {
  return [
    "You are an experienced HR Agent for the DigitalAgent mission execution system.",
    "Your role is to analyze mission requirements and propose mission-internal agent teams.",
    "You have access to skill loading tools: list_skill_files and load_skill.",
    "Use load_skill with digitalagent/SKILL.md when you need DigitalAgent capability context.",
    "Do not expose skill loading details to the user.",
    "Do not assume the user wants to build an external software project unless they explicitly ask for software construction.",
    "Always consider:",
    "- Required skills and capabilities",
    "- Team size constraints (prefer 2-5 members)",
    "- Budget limitations",
    "- Role dependencies and collaboration needs",
    "- Risk factors and mitigation strategies",
    "",
    "When proposing teams, ensure:",
    "- Each role has clear responsibilities",
    "- Success criteria are measurable",
    "- Tool permissions match each role's assigned mission responsibilities",
    "- Budget allocation is realistic",
    "",
    "When proposing teams, also suggest a work rhythm:",
    "- Recommend periodic tasks based on the mission goal and roles",
    "- Consider each role's responsibilities when scheduling recurring work",
    "- If anomaly detection is needed, describe the trigger condition and responder",
    "",
    "Respond with structured JSON that can be parsed directly.",
    "Use Chinese for user-facing role names, purposes, responsibilities, risk factors, schedule names, and schedule task descriptions.",
  ].join("\n");
}
```

- [ ] **Step 8: 运行 prompt 测试**

Run:

```bash
pnpm --filter @digitalagent/server exec vitest run src/owner/prompts.test.ts src/owner/mission-plan.test.ts src/hr-agent.test.ts
```

Expected: PASS.

- [ ] **Step 9: 提交**

```bash
git add apps/server/src/owner/prompts.ts apps/server/src/owner/prompts.test.ts apps/server/src/owner/mission-plan.ts apps/server/src/owner/mission-plan.test.ts apps/server/src/hr-agent.ts apps/server/src/hr-agent.test.ts
git commit -m "feat: teach agents to load skills"
```

---

### Task 7: 端到端行为回归测试

**Files:**
- Modify: `apps/server/src/mission-service.test.ts`
- Modify: `packages/runtime/src/llm/pi-agent-llm-service.test.ts`

- [ ] **Step 1: 添加 Owner 行为回归测试**

Add to `apps/server/src/mission-service.test.ts` near Owner conversation tests:

```ts
it("keeps DigitalAgent collaboration test missions inside DigitalAgent instead of rewriting them as external projects", async () => {
  const llm = new FakeLlmAdapter((messages) => {
    const system = messages.map((message) => message.content).join("\n");
    expect(system).toContain("digitalagent/SKILL.md");
    return JSON.stringify({
      goal: "验证 DigitalAgent mission 内 5 个 agent 能否协作完成 50 次成语接龙",
      scope: "使用 DigitalAgent 内部 mission agents 轮流给出成语、推进轮次、校验规则并汇总结果",
      constraints: ["每轮只能由一个 agent 给出下一个成语", "完成 50 次接龙才算成功"],
      successMetrics: ["完成 50 次有效接龙", "agent 之间的交接和汇报链路可观察"],
      keyAssumptions: ["DigitalAgent 可以创建 mission 内临时 agent 团队"],
      targetAudience: "DigitalAgent 产品和测试团队",
      timeline: "当前验收周期",
    });
  });
  const service = new InMemoryMissionService({ llm });

  const mission = await service.createMission({
    goal: "5 个 agent 协作玩成语接龙,测试 mission 中 agent 协作是否通了,完成 50 次才算成功。",
  });
  await waitForBrief(service, mission.id);

  const refreshed = service.snapshot().missions.find((candidate) => candidate.id === mission.id);
  expect(refreshed?.brief?.goal).toContain("DigitalAgent mission");
  expect(refreshed?.brief?.goal).not.toContain("框架");
  expect(refreshed?.brief?.goal).not.toContain("Web App");
});
```

- [ ] **Step 2: 添加代码构建任务不被误伤测试**

Add to `apps/server/src/mission-service.test.ts`:

```ts
it("preserves explicit software build missions as build-artifact goals", async () => {
  const llm = new FakeLlmAdapter(() => JSON.stringify({
    goal: "实现一个成语接龙 Web App",
    scope: "设计并实现可运行的 Web 应用，包含成语输入、接龙校验和结果展示",
    constraints: ["需要可本地运行", "需要基础浏览器验证"],
    successMetrics: ["Web App 可以启动", "用户可以完成至少 5 轮接龙"],
    keyAssumptions: ["当前仓库允许新增或修改前端代码"],
    targetAudience: "最终用户",
    timeline: "当前开发周期",
  }));
  const service = new InMemoryMissionService({ llm });

  const mission = await service.createMission({
    goal: "帮我实现一个成语接龙 Web App",
  });
  await waitForBrief(service, mission.id);

  const refreshed = service.snapshot().missions.find((candidate) => candidate.id === mission.id);
  expect(refreshed?.brief?.goal).toBe("实现一个成语接龙 Web App");
  expect(refreshed?.brief?.scope).toContain("Web 应用");
});
```

- [ ] **Step 3: 放置测试到已有 helper 可见的作用域**

`apps/server/src/mission-service.test.ts` 已在文件前部定义 `waitForBrief(service, missionId)` helper。把 Step 1 和 Step 2 的两个测试放在同一个顶层 `describe("InMemoryMissionService", ...)` 作用域内，靠近现有 Owner conversation tests，使测试直接复用已有 helper，不新增第二个 `waitForBrief`。

- [ ] **Step 4: 运行回归测试**

Run:

```bash
pnpm --filter @digitalagent/server exec vitest run src/mission-service.test.ts -t "DigitalAgent collaboration test missions|explicit software build missions"
```

Expected: PASS.

- [ ] **Step 5: 运行 runtime LLM 测试**

Run:

```bash
pnpm --filter @digitalagent/runtime exec vitest run src/llm/pi-agent-llm-service.test.ts src/pi-extensions/skills.test.ts
```

Expected: PASS.

- [ ] **Step 6: 提交**

```bash
git add apps/server/src/mission-service.test.ts packages/runtime/src/llm/pi-agent-llm-service.test.ts
git commit -m "test: cover skill-informed mission interpretation"
```

---

### Task 8: 全量验证

**Files:**
- No code changes expected.

- [ ] **Step 1: 运行 runtime 测试**

```bash
pnpm --filter @digitalagent/runtime test
```

Expected: PASS.

- [ ] **Step 2: 运行 server 测试**

```bash
pnpm --filter @digitalagent/server test
```

Expected: PASS.

- [ ] **Step 3: 运行 typecheck**

```bash
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 4: 运行 build**

```bash
pnpm build
```

Expected: PASS.

- [ ] **Step 5: 检查 git 状态**

```bash
git status --short
```

Expected: only intentional untracked or user-owned files remain. Do not stage unrelated `.claude/` or prior roadmap edits unless the user explicitly asks.

---

## 自检

- Spec 覆盖：计划覆盖 skill 文件、JSON 配置、路径型 `load_skill`、`list_skill_files`、共享 pi-agent runner、PiAgentLlmService、runtime agent skill 工具、prompt 更新、fastfail 和测试。
- 范围控制：没有引入 skillId、stage policy、文件大小限制、远程 skill、任意文件读取、业务工具权限系统。
- 类型一致性：`createSkillTools({ rootDir })` 返回 `AgentTool<any>[]`，同时供 `PiAgentLlmService` 和 `PiSdkAdapter` 使用；`runPiAgent(...)` 是唯一构造 pi-agent 的底层 helper。
- 执行边界：每个任务都能独立测试和提交；当前计划不修改 UI，也不实现文件 IO、浏览器验证、代码编辑等业务工具。
