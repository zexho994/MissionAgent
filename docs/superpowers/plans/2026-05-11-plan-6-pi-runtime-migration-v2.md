# Plan 6 v2 Implementation Plan — pi SDK Embed + LLM Gateway Consolidation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete Plan 6 v2 in two PRs: (Stage 1) replace the hand-rolled multi-provider LLM layer with `pi-ai`; (Stage 2) embed pi as an in-process SDK via `pi-agent-core`, consume pi event stream for source extraction, enable session-based prompt caching, rename remaining `openclaw` strings (code + dev store), and delete subprocess infrastructure.

**Architecture:** Stage 1 keeps the `LlmService` interface stable and only replaces the factory internals so all 12+ call sites are untouched. Stage 2 introduces `PiSdkAdapter` behind the existing `MissionExecutionRuntime` contract, wraps pi exceptions in an isolation fence, switches source extraction from "parse final JSON" to "subscribe tool_execution_end events", and runs a one-shot store-migration on server startup.

**Tech Stack:** `@earendil-works/pi-ai@0.74.0` (Stage 1), `@earendil-works/pi-agent-core@0.74.0` + `typebox` (Stage 2), vitest, Node 20+. Versions pinned exactly (no `^`).

**Reference spec:** `docs/superpowers/specs/2026-05-11-plan-6-pi-runtime-migration-v2-design.md`

---

## File Structure

### Stage 1 — LLM gateway replacement

**Modified:**
- `packages/runtime/src/llm/llm-factory.ts` — rewrite internals to use `pi-ai`; preserve exported function signatures and `LlmProvider` union.
- `packages/runtime/src/llm/llm-factory.test.ts` — adjust assertions (assert pi-ai-backed behavior; no provider-side classes anymore).
- `packages/runtime/src/llm/index.ts` — drop exports of deleted `OpenAiLlmAdapter` / `AnthropicLlmAdapter`.
- `packages/runtime/package.json` — drop `@anthropic-ai/sdk` `openai`, add `@earendil-works/pi-ai@0.74.0`.

**Deleted:**
- `packages/runtime/src/llm/anthropic-adapter.ts`
- `packages/runtime/src/llm/anthropic-adapter.test.ts`
- `packages/runtime/src/llm/openai-adapter.ts`
- `packages/runtime/src/llm/openai-adapter.test.ts`

**Unchanged (interface stability — DO NOT MODIFY in Stage 1):**
- `packages/runtime/src/llm/types.ts` (`LlmMessage`, `LlmCallOptions`, `LlmResponse`, `LlmCallStats`)
- `packages/runtime/src/llm/llm-service.ts` (`LlmService` interface)
- `packages/runtime/src/llm/fake-llm-adapter.ts`
- All 12+ `this.llm.call(...)` call sites (`mission-service.ts`, etc.)

### Stage 2 — SDK embed + event stream + rename

**New:**
- `packages/runtime/src/pi-sdk-adapter.ts` — implements `MissionExecutionRuntime` via `new Agent(...)`.
- `packages/runtime/src/pi-sdk-adapter.test.ts` — mock pi event stream; cover happy path, timeout, exception, sessionId propagation.
- `packages/runtime/src/pi-sdk-adapter.smoke.test.ts` — `PI_SMOKE=1` gated.
- `packages/runtime/src/pi-hooks.ts` — empty central place for pi-agent-core hooks. Future-proofing.
- `apps/server/src/store-migration.ts` — one-shot rewrite `openclaw` → `pi` keys in store file on startup.
- `apps/server/src/store-migration.test.ts` — 4 core cases: empty store, store with openclaw keys, already migrated, idempotent re-run.

**Modified:**
- `packages/runtime/src/pi-extensions/web-search.ts` — refactor from CLI extension shape to pi-agent-core `AgentTool` object; search backend unchanged.
- `packages/runtime/src/pi-extensions/web-search.test.ts` — update to test the new `AgentTool` shape.
- `packages/runtime/src/index.ts` — replace `pi-cli-adapter` export with `pi-sdk-adapter`; drop `pi-resolver` export.
- `apps/server/src/runtime-bridge.ts` — rename `extractSourcesFromOpenClawOutput` → `extractSourcesFromPiOutput`; change signature to consume pre-collected `Source[]` (collected by `PiSdkAdapter` from event stream).
- `apps/server/src/mission-service.ts` — rename `openclaw.agent` → `pi.agent`, `content: { openclaw }` → `content: { pi }`, `evidence: ["openclaw:local"]` → `["pi:local"]`; pass `sessionId: task.missionId` to `runtime.runAgentTask`; wire store-migration to startup.
- `apps/server/src/mission-helpers.ts` — `openclaw_runner` → `pi_runner`.
- `apps/server/src/artifact-evaluation.ts` — rename all 15 `openclaw` references (variable names, property keys, function-internal).
- `apps/server/src/api.ts` — rename `/api/health` field `openclaw` → `pi`; rename route `/api/openclaw/run` → `/api/pi/run`; rename `ApiDependencies.runtime` health probe accordingly.
- `apps/server/src/api.test.ts` — sync to renamed endpoints + fields.
- `apps/server/src/server.ts` — instantiate `PiSdkAdapter` instead of `PiCliAdapter`.
- `apps/server/src/mission-service.test.ts` / `autonomous-flow.test.ts` — sync any test fixtures using `openclaw` literal strings.
- `packages/runtime/package.json` — drop `@earendil-works/pi-coding-agent`; add `@earendil-works/pi-agent-core@0.74.0`.
- `apps/server/src/runtime-bridge.ts` interface `MissionExecutionRuntime` — extend with optional `sessionId?: string` field.
- `package.json` (root) — add `lint:no-openclaw` script wired into the existing test/CI command.

**Deleted:**
- `packages/runtime/src/pi-cli-adapter.ts`
- `packages/runtime/src/pi-cli-adapter.test.ts`
- `packages/runtime/src/pi-cli-adapter.smoke.test.ts`
- `packages/runtime/src/pi-resolver.ts` (+ tests if exist)

---

# Stage 1 — LLM Gateway Replacement (3 working days, Tasks 1–10)

**Stage 1 Goal:** All `LlmService.call(...)` consumers continue to work identically, but the underlying engine becomes `pi-ai`. No interface changes externally. End of Stage 1 = stand-alone mergeable PR.

## Task 1: Add `pi-ai` dependency, remove old SDK deps

**Files:**
- Modify: `packages/runtime/package.json`

- [ ] **Step 1**: Edit `packages/runtime/package.json` `dependencies` block.

Current:
```json
"dependencies": {
  "@earendil-works/pi-coding-agent": "^0.74.0",
  "typebox": "^1.1.38"
}
```

Remove `@anthropic-ai/sdk` and `openai` if they exist in the workspace (they are imported transitively by the adapter files we will delete). Verify with:

```bash
grep -E '"(@anthropic-ai/sdk|openai)"' packages/runtime/package.json apps/server/package.json package.json
```

Add `@earendil-works/pi-ai` pinned exactly (no `^`):

```json
"dependencies": {
  "@earendil-works/pi-coding-agent": "^0.74.0",
  "@earendil-works/pi-ai": "0.74.0",
  "typebox": "^1.1.38"
}
```

(`@earendil-works/pi-coding-agent` stays for Stage 1 — Stage 2 removes it.)

- [ ] **Step 2**: Run `pnpm install` from repo root.

Expected: install succeeds, lockfile updated.

- [ ] **Step 3**: Verify `pi-ai` is available:

```bash
node -e "import('@earendil-works/pi-ai').then(m => console.log(Object.keys(m).slice(0,10)))"
```

Expected: prints an array including `getModel`, `stream`, `complete`, `Type`.

- [ ] **Step 4**: Commit.

```bash
git add packages/runtime/package.json pnpm-lock.yaml
git commit -m "chore(runtime): add @earendil-works/pi-ai dep (Plan 6 v2 Stage 1)"
```

---

## Task 2: Write failing factory test — pi-ai-backed adapter

**Files:**
- Modify: `packages/runtime/src/llm/llm-factory.test.ts`

- [ ] **Step 1**: Add a failing test that asserts the factory produces an `LlmService` whose `call()` delegates to `pi-ai`'s `complete()` and maps the result back to `LlmResponse`.

Append the following test case at the bottom of `llm-factory.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";
import { createLlmService } from "./llm-factory.js";

describe("createLlmService (pi-ai backed)", () => {
  it("converts LlmMessage[] to pi-ai Context, calls complete(), maps response", async () => {
    const completeMock = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "Hello back" }],
      usage: {
        input: 12,
        output: 3,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
      },
      stopReason: "end_turn",
      model: { id: "claude-3-5-haiku-latest", name: "Claude Haiku" },
    });

    const service = createLlmService({
      provider: "anthropic",
      apiKey: "sk-test",
      model: "claude-3-5-haiku-latest",
      completeFn: completeMock,
    });

    const response = await service.call(
      [
        { role: "system", content: "You are helpful." },
        { role: "user", content: "Say hi" },
      ],
      { maxTokens: 64 },
    );

    expect(completeMock).toHaveBeenCalledTimes(1);
    const [model, context, options] = completeMock.mock.calls[0]!;
    expect(model.id).toBe("claude-3-5-haiku-latest");
    expect(context.systemPrompt).toBe("You are helpful.");
    expect(context.messages).toEqual([{ role: "user", content: "Say hi" }]);
    expect(options).toMatchObject({ apiKey: "sk-test", maxTokens: 64 });

    expect(response).toMatchObject({
      content: "Hello back",
      model: "claude-3-5-haiku-latest",
      usage: { promptTokens: 12, completionTokens: 3, totalTokens: 15 },
      finishReason: "end_turn",
    });
  });
});
```

- [ ] **Step 2**: Run the test to confirm it fails (factory does not yet accept `completeFn` and does not yet wire pi-ai).

```bash
pnpm --filter @digitalagent/runtime vitest run src/llm/llm-factory.test.ts -t "pi-ai backed"
```

Expected: FAIL with type errors or "completeMock was not called".

---

## Task 3: Implement pi-ai-backed adapter (factory rewrite)

**Files:**
- Modify: `packages/runtime/src/llm/llm-factory.ts`

- [ ] **Step 1**: Replace the entire file contents with the pi-ai-backed implementation:

```typescript
import { complete, getModel, type Context, type Model } from "@earendil-works/pi-ai";
import type { LlmService } from "./llm-service.js";
import type {
  LlmCallOptions,
  LlmCallStats,
  LlmMessage,
  LlmResponse,
} from "./types.js";

export type LlmProvider = "openai" | "glm" | "claude" | "anthropic" | "minimax";

export type CompleteFn = typeof complete;

export interface CreateLlmServiceOptions {
  provider: LlmProvider;
  apiKey: string;
  baseUrl?: string | undefined;
  model?: string | undefined;
  maxRetries?: number;
  timeoutMs?: number;
  completeFn?: CompleteFn;
}

export type LlmEnv = Record<string, string | undefined>;

export interface CreateLlmServiceFromEnvOptions {
  completeFn?: CompleteFn;
}

interface ProviderResolution {
  piProvider: string;
  defaultModel: string;
  baseUrlOverride?: string;
}

const providerMap: Record<LlmProvider, ProviderResolution> = {
  openai: { piProvider: "openai", defaultModel: "gpt-4o-mini" },
  glm: {
    piProvider: "openai",
    defaultModel: "glm-4-flash",
    baseUrlOverride: "https://open.bigmodel.cn/api/paas/v4",
  },
  anthropic: { piProvider: "anthropic", defaultModel: "claude-3-5-haiku-latest" },
  claude: { piProvider: "anthropic", defaultModel: "claude-3-5-haiku-latest" },
  minimax: {
    piProvider: "openai",
    defaultModel: "MiniMax-M2.7-highspeed",
    baseUrlOverride: "https://api.minimax.io/v1",
  },
};

export function createLlmService(options: CreateLlmServiceOptions): LlmService {
  if (!options.apiKey) {
    throw new Error("LLM API key is required");
  }
  const resolution = providerMap[options.provider];
  const modelId = options.model ?? resolution.defaultModel;
  const completeFn = options.completeFn ?? complete;

  const model = resolveModel({
    piProvider: resolution.piProvider,
    modelId,
    baseUrl: options.baseUrl ?? resolution.baseUrlOverride,
  });

  let stats: LlmCallStats = {
    totalCalls: 0,
    totalPromptTokens: 0,
    totalCompletionTokens: 0,
  };

  return {
    async call(messages, callOptions): Promise<LlmResponse> {
      const context = toContext(messages);
      const piResponse = await completeFn(model, context, {
        apiKey: options.apiKey,
        ...(callOptions?.maxTokens !== undefined
          ? { maxTokens: callOptions.maxTokens }
          : {}),
        ...(callOptions?.temperature !== undefined
          ? { temperature: callOptions.temperature }
          : {}),
      });

      const content = extractTextContent(piResponse);
      const promptTokens = piResponse.usage?.input ?? 0;
      const completionTokens = piResponse.usage?.output ?? 0;

      stats = {
        totalCalls: stats.totalCalls + 1,
        totalPromptTokens: stats.totalPromptTokens + promptTokens,
        totalCompletionTokens: stats.totalCompletionTokens + completionTokens,
        lastCallAt: new Date().toISOString(),
      };

      return {
        content,
        model: piResponse.model?.id ?? modelId,
        usage: {
          promptTokens,
          completionTokens,
          totalTokens: promptTokens + completionTokens,
        },
        finishReason: piResponse.stopReason ?? "stop",
      };
    },
    stats() {
      return stats;
    },
  };
}

function resolveModel(input: {
  piProvider: string;
  modelId: string;
  baseUrl?: string;
}): Model<any> {
  try {
    const m = getModel(input.piProvider as any, input.modelId as any);
    if (input.baseUrl) {
      return { ...m, baseUrl: input.baseUrl };
    }
    return m;
  } catch {
    return {
      id: input.modelId,
      name: input.modelId,
      api: "openai-completions",
      provider: input.piProvider,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 4096,
      ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
    } as Model<any>;
  }
}

function toContext(messages: LlmMessage[]): Context {
  const systemParts: string[] = [];
  const conversational: Array<{ role: "user" | "assistant"; content: string }> = [];
  for (const m of messages) {
    if (m.role === "system") {
      systemParts.push(m.content);
    } else {
      conversational.push({ role: m.role, content: m.content });
    }
  }
  return {
    systemPrompt: systemParts.join("\n\n"),
    messages: conversational,
    tools: [],
  };
}

function extractTextContent(response: any): string {
  const content = response?.content;
  if (Array.isArray(content)) {
    return content
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text)
      .join("");
  }
  if (typeof content === "string") return content;
  return "";
}

export function createLlmServiceFromEnv(
  env: LlmEnv,
  options?: CreateLlmServiceFromEnvOptions,
): LlmService {
  const provider = (env.LLM_PROVIDER ?? "anthropic") as LlmProvider;
  const apiKey =
    env.LLM_API_KEY ??
    env.ANTHROPIC_API_KEY ??
    env.OPENAI_API_KEY ??
    "";
  return createLlmService({
    provider,
    apiKey,
    ...(env.LLM_MODEL !== undefined ? { model: env.LLM_MODEL } : {}),
    ...(env.LLM_BASE_URL !== undefined ? { baseUrl: env.LLM_BASE_URL } : {}),
    ...(options?.completeFn !== undefined ? { completeFn: options.completeFn } : {}),
  });
}
```

- [ ] **Step 2**: Run the failing test from Task 2:

```bash
pnpm --filter @digitalagent/runtime vitest run src/llm/llm-factory.test.ts -t "pi-ai backed"
```

Expected: PASS.

- [ ] **Step 3**: Commit.

```bash
git add packages/runtime/src/llm/llm-factory.ts packages/runtime/src/llm/llm-factory.test.ts
git commit -m "feat(runtime): rewrite llm-factory on top of pi-ai gateway"
```

---

## Task 4: Update llm-factory.test.ts existing tests (env compat)

**Files:**
- Modify: `packages/runtime/src/llm/llm-factory.test.ts`

- [ ] **Step 1**: Open `llm-factory.test.ts`. Locate every existing test that imported `AnthropicLlmAdapter` or `OpenAiLlmAdapter` directly (these adapters will be deleted in Tasks 6-7). For each such test, rewrite it to mock `completeFn` instead and assert on the call boundary (provider + model resolution).

For example, a previous test like:

```typescript
it("creates an anthropic adapter", () => {
  const svc = createLlmService({ provider: "anthropic", apiKey: "k" });
  expect(svc).toBeInstanceOf(AnthropicLlmAdapter);
});
```

Becomes:

```typescript
it("anthropic provider resolves to anthropic pi-ai model", async () => {
  const completeMock = vi.fn().mockResolvedValue({
    content: [{ type: "text", text: "ok" }],
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0 },
    stopReason: "end_turn",
    model: { id: "claude-3-5-haiku-latest" },
  });
  const svc = createLlmService({
    provider: "anthropic",
    apiKey: "k",
    completeFn: completeMock,
  });
  await svc.call([{ role: "user", content: "hi" }]);
  const [model] = completeMock.mock.calls[0]!;
  expect(model.provider).toBe("anthropic");
});
```

- [ ] **Step 2**: Run the full `llm-factory.test.ts` suite:

```bash
pnpm --filter @digitalagent/runtime vitest run src/llm/llm-factory.test.ts
```

Expected: all tests PASS.

- [ ] **Step 3**: Commit.

```bash
git add packages/runtime/src/llm/llm-factory.test.ts
git commit -m "test(runtime): rewrite llm-factory tests against pi-ai mock surface"
```

---

## Task 5: Update `llm/index.ts` exports

**Files:**
- Modify: `packages/runtime/src/llm/index.ts`

- [ ] **Step 1**: Replace contents with:

```typescript
export type { LlmMessage, LlmCallOptions, LlmResponse, LlmCallStats } from "./types.js";
export type { LlmService } from "./llm-service.js";
export { FakeLlmAdapter } from "./fake-llm-adapter.js";
export {
  createLlmService,
  createLlmServiceFromEnv,
  type CreateLlmServiceOptions,
  type CreateLlmServiceFromEnvOptions,
  type LlmEnv,
  type LlmProvider,
  type CompleteFn,
} from "./llm-factory.js";
```

(Note `OpenAiLlmAdapter` / `AnthropicLlmAdapter` exports are gone.)

- [ ] **Step 2**: Run typecheck on the runtime package:

```bash
pnpm --filter @digitalagent/runtime typecheck
```

Expected: PASS (no consumers were importing the deleted symbols — verified by typecheck).

If typecheck fails on a downstream import, search for it and remove that import line (it should be dead code given the factory is the only entry point used in production):

```bash
grep -rn "OpenAiLlmAdapter\|AnthropicLlmAdapter" packages apps --include="*.ts"
```

- [ ] **Step 3**: Commit.

```bash
git add packages/runtime/src/llm/index.ts
git commit -m "refactor(runtime): drop direct LLM adapter exports"
```

---

## Task 6: Delete `anthropic-adapter.ts` + tests

**Files:**
- Delete: `packages/runtime/src/llm/anthropic-adapter.ts`
- Delete: `packages/runtime/src/llm/anthropic-adapter.test.ts`

- [ ] **Step 1**: Delete both files:

```bash
rm packages/runtime/src/llm/anthropic-adapter.ts packages/runtime/src/llm/anthropic-adapter.test.ts
```

- [ ] **Step 2**: Verify no residual import:

```bash
grep -rn "anthropic-adapter\|AnthropicLlmAdapter" packages apps --include="*.ts"
```

Expected: no output (the test we rewrote in Task 4 should already drop these imports).

- [ ] **Step 3**: Run typecheck:

```bash
pnpm --filter @digitalagent/runtime typecheck
```

Expected: PASS.

- [ ] **Step 4**: Commit.

```bash
git add -A packages/runtime/src/llm/
git commit -m "refactor(runtime): remove anthropic-adapter (replaced by pi-ai)"
```

---

## Task 7: Delete `openai-adapter.ts` + tests

**Files:**
- Delete: `packages/runtime/src/llm/openai-adapter.ts`
- Delete: `packages/runtime/src/llm/openai-adapter.test.ts`

- [ ] **Step 1**: Delete both files:

```bash
rm packages/runtime/src/llm/openai-adapter.ts packages/runtime/src/llm/openai-adapter.test.ts
```

- [ ] **Step 2**: Verify no residual import:

```bash
grep -rn "openai-adapter\|OpenAiLlmAdapter" packages apps --include="*.ts"
```

Expected: no output.

- [ ] **Step 3**: Run typecheck:

```bash
pnpm --filter @digitalagent/runtime typecheck
```

Expected: PASS.

- [ ] **Step 4**: Commit.

```bash
git add -A packages/runtime/src/llm/
git commit -m "refactor(runtime): remove openai-adapter (replaced by pi-ai)"
```

---

## Task 8: Remove `@anthropic-ai/sdk` and `openai` deps

**Files:**
- Modify: `packages/runtime/package.json` (and `apps/server/package.json` / root `package.json` if present there)

- [ ] **Step 1**: Search where the SDK deps live:

```bash
grep -E '"(@anthropic-ai/sdk|openai)"' packages/runtime/package.json apps/server/package.json package.json
```

- [ ] **Step 2**: For each `package.json` that has them, remove the two entries. Example for `packages/runtime/package.json`:

Before:
```json
"dependencies": {
  "@anthropic-ai/sdk": "^0.x.x",
  "openai": "^4.x.x",
  "@earendil-works/pi-coding-agent": "^0.74.0",
  "@earendil-works/pi-ai": "0.74.0",
  "typebox": "^1.1.38"
}
```

After:
```json
"dependencies": {
  "@earendil-works/pi-coding-agent": "^0.74.0",
  "@earendil-works/pi-ai": "0.74.0",
  "typebox": "^1.1.38"
}
```

- [ ] **Step 3**: Re-install:

```bash
pnpm install
```

Expected: lockfile updated, no errors.

- [ ] **Step 4**: Run full test suite + typecheck:

```bash
pnpm typecheck && pnpm test
```

Expected: all green.

- [ ] **Step 5**: Commit.

```bash
git add -A
git commit -m "chore(deps): drop @anthropic-ai/sdk and openai (now via pi-ai)"
```

---

## Task 9: Smoke test for Stage 1 (PI_SMOKE gated)

**Files:**
- Create: `packages/runtime/src/llm/llm-factory.smoke.test.ts`

- [ ] **Step 1**: Create the smoke test file:

```typescript
import { describe, expect, it } from "vitest";
import { createLlmServiceFromEnv } from "./llm-factory.js";

const SMOKE = process.env.PI_SMOKE === "1";

describe.skipIf(!SMOKE)("llm-factory smoke (real pi-ai call)", () => {
  it("returns a non-empty response from a real provider", async () => {
    const env = {
      LLM_PROVIDER: process.env.LLM_PROVIDER ?? "anthropic",
      LLM_API_KEY: process.env.LLM_API_KEY ?? process.env.ANTHROPIC_API_KEY,
      LLM_MODEL: process.env.LLM_MODEL ?? "claude-3-5-haiku-latest",
    };
    if (!env.LLM_API_KEY) {
      throw new Error("PI_SMOKE=1 set but LLM_API_KEY/ANTHROPIC_API_KEY not provided");
    }
    const svc = createLlmServiceFromEnv(env);
    const response = await svc.call(
      [
        { role: "system", content: "Reply with exactly the word OK." },
        { role: "user", content: "Reply now." },
      ],
      { maxTokens: 16 },
    );
    expect(response.content.trim().length).toBeGreaterThan(0);
    expect(response.usage.totalTokens).toBeGreaterThan(0);
  }, 30_000);
});
```

- [ ] **Step 2**: Verify it skips by default:

```bash
pnpm --filter @digitalagent/runtime vitest run src/llm/llm-factory.smoke.test.ts
```

Expected: 0 tests run (skipped).

- [ ] **Step 3**: Run it for real (operator step, manual):

```bash
PI_SMOKE=1 ANTHROPIC_API_KEY=$YOUR_KEY pnpm --filter @digitalagent/runtime vitest run src/llm/llm-factory.smoke.test.ts
```

Expected: PASS, cost < $0.01.

- [ ] **Step 4**: Commit.

```bash
git add packages/runtime/src/llm/llm-factory.smoke.test.ts
git commit -m "test(runtime): add llm-factory PI_SMOKE smoke test"
```

---

## Task 10: Stage 1 verification + PR

**Files:** none (verification + PR creation)

- [ ] **Step 1**: Run the full project test suite:

```bash
pnpm typecheck && pnpm test
```

Expected: all green. (~550+ tests.)

- [ ] **Step 2**: Manually run the smoke test once with a real key:

```bash
PI_SMOKE=1 ANTHROPIC_API_KEY=$YOUR_KEY pnpm --filter @digitalagent/runtime vitest run src/llm/llm-factory.smoke.test.ts
```

Expected: PASS.

- [ ] **Step 3**: Push the branch and create the Stage 1 PR:

```bash
git push -u origin HEAD
gh pr create --title "feat(runtime): Plan 6 v2 Stage 1 — pi-ai LLM gateway" --body "$(cat <<'EOF'
## Summary
- Replace hand-rolled multi-provider LLM layer (1340 lines across anthropic-adapter + openai-adapter + factory) with a thin `pi-ai` shell.
- `LlmService` interface, `LlmMessage` / `LlmResponse` types, and all 12+ call sites are unchanged.
- New deps: `@earendil-works/pi-ai@0.74.0` (pinned). Removed: `@anthropic-ai/sdk`, `openai`.

## Test plan
- [x] `pnpm typecheck` — green
- [x] `pnpm test` — full suite green (~550+ tests)
- [x] `PI_SMOKE=1 pnpm --filter @digitalagent/runtime vitest run src/llm/llm-factory.smoke.test.ts` — manual once, cost < \$0.01
- [ ] Stage 2 PR will follow with SDK embed + rename

Reference: docs/superpowers/specs/2026-05-11-plan-6-pi-runtime-migration-v2-design.md
EOF
)"
```

Expected: PR URL printed. Wait for review.

- [ ] **Step 4**: After PR is merged, pull `master`, then begin Stage 2 on a fresh branch:

```bash
git checkout master && git pull
git checkout -b plan-6-pi-runtime-migration-v2-stage-2
```

---

# Stage 2 — SDK Embed + Event Stream + Rename (5 working days, Tasks 11–32)

**Stage 2 Goal:** Replace the pi CLI subprocess with an in-process `Agent` from `pi-agent-core`. Source extraction switches from "parse final JSON" to "subscribe `tool_execution_end` events". Add session-based prompt caching. Rename all `openclaw` strings (15 code sites + dev store keys). Delete subprocess infrastructure. End of Stage 2 = Plan 6 v2 complete.

## Task 11: Add `pi-agent-core` dependency

**Files:**
- Modify: `packages/runtime/package.json`

- [ ] **Step 1**: Add the new dep (`@earendil-works/pi-coding-agent` stays for now — Task 30 removes it):

```json
"dependencies": {
  "@earendil-works/pi-coding-agent": "^0.74.0",
  "@earendil-works/pi-agent-core": "0.74.0",
  "@earendil-works/pi-ai": "0.74.0",
  "typebox": "^1.1.38"
}
```

- [ ] **Step 2**: `pnpm install`.

- [ ] **Step 3**: Verify import works:

```bash
node -e "import('@earendil-works/pi-agent-core').then(m => console.log(Object.keys(m).slice(0,10)))"
```

Expected: prints array including `Agent`, `agentLoop`.

- [ ] **Step 4**: Commit.

```bash
git add packages/runtime/package.json pnpm-lock.yaml
git commit -m "chore(runtime): add @earendil-works/pi-agent-core dep (Plan 6 v2 Stage 2)"
```

---

## Task 12: Extend `MissionExecutionRuntime` with optional `sessionId`

**Files:**
- Modify: `apps/server/src/runtime-bridge.ts`

- [ ] **Step 1**: Locate the `MissionExecutionRuntime` interface (top of `runtime-bridge.ts`) and add an optional `sessionId` field:

```typescript
export interface MissionExecutionRuntime {
  runAgentTask(input: {
    message: string;
    timeoutSeconds: number;
    systemPrompt?: string;
    sessionId?: string;
  }): Promise<{
    status: string;
    output: unknown;
    stderr: string;
    sources?: Source[];
  }>;
}
```

(Also add an optional `sources` field on the return shape — Stage 2 lets the adapter pre-collect sources from events.)

- [ ] **Step 2**: Run typecheck:

```bash
pnpm --filter @digitalagent/server typecheck
```

Expected: PASS (all callers either don't pass `sessionId` yet, or were already not setting `sources`).

- [ ] **Step 3**: Commit.

```bash
git add apps/server/src/runtime-bridge.ts
git commit -m "feat(runtime): extend MissionExecutionRuntime with sessionId + sources"
```

---

## Task 13: Refactor `web-search.ts` from CLI extension to `AgentTool`

**Files:**
- Modify: `packages/runtime/src/pi-extensions/web-search.ts`
- Modify: `packages/runtime/src/pi-extensions/web-search.test.ts`

- [ ] **Step 1**: Read existing `web-search.ts` to identify the current search-execution function (the HTTP call to Brave-shaped backend). Keep that core function; replace the surrounding "pi CLI extension registration" shape with an `AgentTool` export.

Rewrite `web-search.ts` as:

```typescript
import { Type, type AgentTool } from "@earendil-works/pi-agent-core";

export interface WebSearchResult {
  url: string;
  title?: string;
  snippet?: string;
}

export interface WebSearchEnv {
  apiKey?: string;
  backendUrl?: string;
  fetch?: typeof fetch;
}

export function createWebSearchTool(env: WebSearchEnv): AgentTool<typeof WebSearchParams> {
  return {
    name: "web_search",
    description: "Search the web. Returns results with url, title, snippet.",
    parameters: WebSearchParams,
    async execute({ args }) {
      const results = await runSearch(args.query, env);
      return {
        ok: true,
        details: { results, searchKeyword: args.query },
      };
    },
  };
}

const WebSearchParams = Type.Object({
  query: Type.String({ description: "The search query" }),
});

async function runSearch(query: string, env: WebSearchEnv): Promise<WebSearchResult[]> {
  const backend = env.backendUrl ?? process.env.WEB_SEARCH_BACKEND_URL;
  const apiKey = env.apiKey ?? process.env.WEB_SEARCH_API_KEY;
  if (!backend || !apiKey) {
    return [];
  }
  const fetchFn = env.fetch ?? fetch;
  const response = await fetchFn(`${backend}?q=${encodeURIComponent(query)}`, {
    headers: { "x-api-key": apiKey },
  });
  if (!response.ok) {
    throw new Error(`web_search backend ${response.status}`);
  }
  const data = (await response.json()) as { web?: { results?: WebSearchResult[] } };
  return data.web?.results ?? [];
}
```

- [ ] **Step 2**: Rewrite `web-search.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";
import { createWebSearchTool } from "./web-search.js";

describe("createWebSearchTool", () => {
  it("returns AgentTool with web_search shape", () => {
    const tool = createWebSearchTool({ apiKey: "k", backendUrl: "https://api.test" });
    expect(tool.name).toBe("web_search");
    expect(typeof tool.execute).toBe("function");
  });

  it("returns empty results when no backend configured", async () => {
    const tool = createWebSearchTool({});
    const result = await tool.execute({ args: { query: "test" } } as any);
    expect(result.details.results).toEqual([]);
  });

  it("calls backend with query and returns parsed results", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ web: { results: [{ url: "https://x", title: "X" }] } }),
    });
    const tool = createWebSearchTool({
      apiKey: "k",
      backendUrl: "https://api.test",
      fetch: fetchMock as any,
    });
    const result = await tool.execute({ args: { query: "hello" } } as any);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.test?q=hello",
      expect.objectContaining({ headers: { "x-api-key": "k" } }),
    );
    expect(result.details.results).toEqual([{ url: "https://x", title: "X" }]);
  });

  it("throws on backend error", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    const tool = createWebSearchTool({
      apiKey: "k",
      backendUrl: "https://api.test",
      fetch: fetchMock as any,
    });
    await expect(tool.execute({ args: { query: "x" } } as any)).rejects.toThrow(/500/);
  });
});
```

- [ ] **Step 3**: Run tests:

```bash
pnpm --filter @digitalagent/runtime vitest run src/pi-extensions/web-search.test.ts
```

Expected: all PASS.

- [ ] **Step 4**: Commit.

```bash
git add packages/runtime/src/pi-extensions/
git commit -m "refactor(runtime): web-search becomes pi-agent-core AgentTool"
```

---

## Task 14: Write failing test for `PiSdkAdapter` happy path

**Files:**
- Create: `packages/runtime/src/pi-sdk-adapter.test.ts`

- [ ] **Step 1**: Create the failing test:

```typescript
import { describe, expect, it, vi } from "vitest";
import { PiSdkAdapter } from "./pi-sdk-adapter.js";

describe("PiSdkAdapter", () => {
  it("runs an agent task and returns completed status with the final state", async () => {
    const fakeAgent = {
      prompt: vi.fn().mockResolvedValue(undefined),
      subscribe: vi.fn(),
      state: {
        messages: [
          { role: "user", content: "do it" },
          {
            role: "assistant",
            content: [{ type: "text", text: "done" }],
          },
        ],
      },
    };
    const agentFactory = vi.fn().mockReturnValue(fakeAgent);

    const adapter = new PiSdkAdapter({
      apiKey: "k",
      agentFactory: agentFactory as any,
    });

    const result = await adapter.runAgentTask({
      message: "do it",
      timeoutSeconds: 5,
      sessionId: "mission-123",
    });

    expect(fakeAgent.prompt).toHaveBeenCalledWith("do it");
    expect(agentFactory).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "mission-123" }),
    );
    expect(result.status).toBe("completed");
    expect(result.output).toEqual(expect.objectContaining({ messages: expect.any(Array) }));
    expect(result.sources).toEqual([]);
  });
});
```

- [ ] **Step 2**: Run to verify failure:

```bash
pnpm --filter @digitalagent/runtime vitest run src/pi-sdk-adapter.test.ts
```

Expected: FAIL — `PiSdkAdapter` does not exist yet.

---

## Task 15: Implement `PiSdkAdapter` basic happy path

**Files:**
- Create: `packages/runtime/src/pi-sdk-adapter.ts`

- [ ] **Step 1**: Create the file:

```typescript
import { Agent, type AgentEvent, type AgentTool } from "@earendil-works/pi-agent-core";
import { getModel, type Model } from "@earendil-works/pi-ai";
import type { Source } from "@digitalagent/core";

export interface PiSdkAdapterOptions {
  apiKey: string;
  modelProvider?: string;
  modelId?: string;
  tools?: AgentTool<any>[];
  agentFactory?: (config: AgentConfig) => AgentLike;
}

export interface AgentConfig {
  initialState: {
    systemPrompt: string;
    model: Model<any>;
    tools: AgentTool<any>[];
    messages: never[];
  };
  sessionId?: string;
  getApiKey?: () => Promise<string>;
}

export interface AgentLike {
  prompt(text: string): Promise<void>;
  subscribe(handler: (event: AgentEvent) => void): void;
  state: {
    messages: unknown[];
  };
}

export interface RunAgentTaskInput {
  message: string;
  timeoutSeconds: number;
  systemPrompt?: string;
  sessionId?: string;
}

export interface RunAgentTaskResult {
  status: "completed" | "failed";
  output: unknown;
  stderr: string;
  sources: Source[];
  error?: string;
}

export class PiSdkAdapter {
  private readonly apiKey: string;
  private readonly modelProvider: string;
  private readonly modelId: string;
  private readonly tools: AgentTool<any>[];
  private readonly agentFactory: (config: AgentConfig) => AgentLike;

  constructor(options: PiSdkAdapterOptions) {
    this.apiKey = options.apiKey;
    this.modelProvider = options.modelProvider ?? "anthropic";
    this.modelId = options.modelId ?? "claude-3-5-haiku-latest";
    this.tools = options.tools ?? [];
    this.agentFactory =
      options.agentFactory ??
      ((config) => new Agent(config as any) as unknown as AgentLike);
  }

  async runAgentTask(input: RunAgentTaskInput): Promise<RunAgentTaskResult> {
    const model = getModel(this.modelProvider as any, this.modelId as any);
    const sources: Source[] = [];

    const agent = this.agentFactory({
      initialState: {
        systemPrompt: input.systemPrompt ?? "",
        model,
        tools: this.tools,
        messages: [],
      },
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      getApiKey: async () => this.apiKey,
    });

    agent.subscribe((event) => {
      collectSourcesFromEvent(event, sources);
    });

    try {
      await runWithTimeout(agent.prompt(input.message), input.timeoutSeconds);
      return {
        status: "completed",
        output: { messages: agent.state.messages },
        stderr: "",
        sources,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        status: "failed",
        output: { messages: agent.state.messages, error: message },
        stderr: message,
        sources,
        error: message,
      };
    }
  }
}

function runWithTimeout<T>(promise: Promise<T>, timeoutSeconds: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`pi agent task timed out after ${timeoutSeconds}s`));
    }, timeoutSeconds * 1000);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function collectSourcesFromEvent(event: AgentEvent, sources: Source[]): void {
  if (event.type !== "tool_execution_end") return;
  const result = (event as any).result;
  if (!result || result.ok === false) return;
  const toolName = (event as any).toolName;
  if (toolName !== "web_search") return;
  const details = result.details;
  if (!details) return;
  const results = (details as any).results as Array<Record<string, unknown>> | undefined;
  const keyword = (details as any).searchKeyword as string | undefined;
  if (!Array.isArray(results)) return;
  for (const r of results) {
    if (typeof r.url !== "string") continue;
    const src: Source = { url: r.url };
    if (typeof r.title === "string") src.title = r.title;
    if (typeof r.snippet === "string") src.snippet = r.snippet;
    if (keyword) src.searchKeyword = keyword;
    sources.push(src);
  }
}
```

- [ ] **Step 2**: Run the failing test from Task 14:

```bash
pnpm --filter @digitalagent/runtime vitest run src/pi-sdk-adapter.test.ts
```

Expected: PASS.

- [ ] **Step 3**: Commit.

```bash
git add packages/runtime/src/pi-sdk-adapter.ts packages/runtime/src/pi-sdk-adapter.test.ts
git commit -m "feat(runtime): add PiSdkAdapter (basic happy path)"
```

---

## Task 16: Add `PiSdkAdapter` event-stream source collection test

**Files:**
- Modify: `packages/runtime/src/pi-sdk-adapter.test.ts`

- [ ] **Step 1**: Append a new test case:

```typescript
it("collects sources from tool_execution_end events for web_search", async () => {
  let captured: ((event: any) => void) | null = null;
  const fakeAgent = {
    prompt: vi.fn().mockImplementation(async () => {
      if (captured) {
        captured({
          type: "tool_execution_end",
          toolName: "web_search",
          result: {
            ok: true,
            details: {
              results: [
                { url: "https://a.example", title: "A", snippet: "snip-a" },
                { url: "https://b.example", title: "B" },
              ],
              searchKeyword: "hello",
            },
          },
        });
      }
    }),
    subscribe: vi.fn().mockImplementation((handler: any) => {
      captured = handler;
    }),
    state: { messages: [] },
  };

  const adapter = new PiSdkAdapter({
    apiKey: "k",
    agentFactory: () => fakeAgent as any,
  });

  const result = await adapter.runAgentTask({
    message: "search hello",
    timeoutSeconds: 5,
  });

  expect(result.sources).toEqual([
    { url: "https://a.example", title: "A", snippet: "snip-a", searchKeyword: "hello" },
    { url: "https://b.example", title: "B", searchKeyword: "hello" },
  ]);
});
```

- [ ] **Step 2**: Run:

```bash
pnpm --filter @digitalagent/runtime vitest run src/pi-sdk-adapter.test.ts
```

Expected: PASS.

- [ ] **Step 3**: Commit.

```bash
git add packages/runtime/src/pi-sdk-adapter.test.ts
git commit -m "test(runtime): cover PiSdkAdapter event-stream source collection"
```

---

## Task 17: Add `PiSdkAdapter` timeout + exception isolation tests

**Files:**
- Modify: `packages/runtime/src/pi-sdk-adapter.test.ts`

- [ ] **Step 1**: Append two more test cases:

```typescript
it("returns failed status when prompt throws (exception isolation fence)", async () => {
  const fakeAgent = {
    prompt: vi.fn().mockRejectedValue(new Error("pi blew up")),
    subscribe: vi.fn(),
    state: { messages: [{ role: "user", content: "x" }] },
  };

  const adapter = new PiSdkAdapter({
    apiKey: "k",
    agentFactory: () => fakeAgent as any,
  });

  const result = await adapter.runAgentTask({
    message: "x",
    timeoutSeconds: 5,
  });

  expect(result.status).toBe("failed");
  expect(result.error).toBe("pi blew up");
  expect(result.stderr).toBe("pi blew up");
  expect(result.sources).toEqual([]);
});

it("returns failed status when prompt does not resolve in time", async () => {
  const fakeAgent = {
    prompt: vi.fn().mockImplementation(() => new Promise(() => {})),
    subscribe: vi.fn(),
    state: { messages: [] },
  };

  const adapter = new PiSdkAdapter({
    apiKey: "k",
    agentFactory: () => fakeAgent as any,
  });

  const result = await adapter.runAgentTask({
    message: "x",
    timeoutSeconds: 0.05,
  });

  expect(result.status).toBe("failed");
  expect(result.error).toMatch(/timed out/);
});
```

- [ ] **Step 2**: Run:

```bash
pnpm --filter @digitalagent/runtime vitest run src/pi-sdk-adapter.test.ts
```

Expected: PASS.

- [ ] **Step 3**: Commit.

```bash
git add packages/runtime/src/pi-sdk-adapter.test.ts
git commit -m "test(runtime): cover PiSdkAdapter timeout + exception isolation"
```

---

## Task 18: Create `pi-hooks.ts` placeholder for future extensions

**Files:**
- Create: `packages/runtime/src/pi-hooks.ts`

- [ ] **Step 1**: Create the file with the central re-exports we expect to use later:

```typescript
import type {
  BeforeToolCallContext,
  AfterToolCallContext,
  ShouldStopAfterTurnContext,
  BeforeToolCallResult,
  AfterToolCallResult,
} from "@earendil-works/pi-agent-core";

export type {
  BeforeToolCallContext,
  AfterToolCallContext,
  ShouldStopAfterTurnContext,
  BeforeToolCallResult,
  AfterToolCallResult,
};

export const noopBeforeToolCall = undefined;
export const noopAfterToolCall = undefined;
export const noopShouldStopAfterTurn = undefined;
```

(This file exists so future hook wiring lands in a single, discoverable place — see spec § Architecture / v2 risk mitigation.)

- [ ] **Step 2**: Typecheck:

```bash
pnpm --filter @digitalagent/runtime typecheck
```

Expected: PASS.

- [ ] **Step 3**: Commit.

```bash
git add packages/runtime/src/pi-hooks.ts
git commit -m "feat(runtime): add pi-hooks central re-export module"
```

---

## Task 19: Refactor `runtime-bridge.ts` extractor signature

**Files:**
- Modify: `apps/server/src/runtime-bridge.ts`

- [ ] **Step 1**: Find the existing `extractSourcesFromOpenClawOutput(output: unknown)` function. Rename and change its responsibility — Stage 2 sources come from the adapter directly, so this function becomes a thin merge / dedupe layer that accepts pre-collected sources and also still scans `output` for backwards compatibility (in case an older artifact lacks the new structure).

Replace the function with:

```typescript
export function extractSourcesFromPiOutput(
  output: unknown,
  preCollected: Source[] = [],
): Source[] {
  const merged: Source[] = [...preCollected];
  const seen = new Set(merged.map((s) => s.url));

  if (output && typeof output === "object") {
    const record = output as Record<string, unknown>;
    const fallbackSources = Array.isArray(record.sources)
      ? (record.sources as Array<Record<string, unknown>>)
      : [];
    for (const r of fallbackSources) {
      if (typeof r.url !== "string" || seen.has(r.url)) continue;
      const src: Source = { url: r.url };
      if (typeof r.title === "string") src.title = r.title;
      if (typeof r.snippet === "string") src.snippet = r.snippet;
      merged.push(src);
      seen.add(r.url);
    }
  }
  return merged;
}
```

- [ ] **Step 2**: Search and update callers:

```bash
grep -rn "extractSourcesFromOpenClawOutput" apps packages --include="*.ts"
```

For each caller (likely only `artifact-evaluation.ts`), update both the function name and the call site to pass the pre-collected `Source[]` (will land in Task 22 when we touch artifact-evaluation).

- [ ] **Step 3**: Typecheck:

```bash
pnpm --filter @digitalagent/server typecheck
```

Expected: typecheck may fail temporarily on callers — those are fixed in Task 22. If failure mentions other modules, fix imports.

- [ ] **Step 4**: Commit (the typecheck red on callers is fine; Task 22 closes it).

```bash
git add apps/server/src/runtime-bridge.ts
git commit -m "refactor(server): rename extract function to extractSourcesFromPiOutput"
```

---

## Task 20: Rename `openclaw` in `mission-service.ts`

**Files:**
- Modify: `apps/server/src/mission-service.ts`

- [ ] **Step 1**: Apply the following find/replace within `mission-service.ts`:

| Find | Replace |
|---|---|
| `toolName: "openclaw.agent"` | `toolName: "pi.agent"` |
| `content: { openclaw: result.output, stderr: result.stderr }` | `content: { pi: result.output, stderr: result.stderr }` |
| `evidence: ["openclaw:local"]` | `evidence: ["pi:local"]` |

Additionally, locate the `runtime.runAgentTask({ ... })` call site and add `sessionId: task.missionId` to the argument object. For example, before:

```typescript
void runtime
  .runAgentTask({
    message,
    timeoutSeconds,
    systemPrompt,
  })
```

After:

```typescript
void runtime
  .runAgentTask({
    message,
    timeoutSeconds,
    systemPrompt,
    sessionId: task.missionId,
  })
```

- [ ] **Step 2**: Run the mission-service tests:

```bash
pnpm --filter @digitalagent/server vitest run src/mission-service.test.ts
```

Expected: PASS (or only fail on assertions that look for the old strings — fix those assertions to the new strings).

- [ ] **Step 3**: Commit.

```bash
git add apps/server/src/mission-service.ts apps/server/src/mission-service.test.ts
git commit -m "refactor(server): rename mission-service openclaw envelope to pi + propagate sessionId"
```

---

## Task 21: Rename `openclaw_runner` → `pi_runner` in `mission-helpers.ts`

**Files:**
- Modify: `apps/server/src/mission-helpers.ts`

- [ ] **Step 1**: Replace both occurrences:

```bash
sed -i.bak 's/openclaw_runner/pi_runner/g' apps/server/src/mission-helpers.ts
rm apps/server/src/mission-helpers.ts.bak
```

- [ ] **Step 2**: Verify:

```bash
grep "openclaw" apps/server/src/mission-helpers.ts
```

Expected: no output.

- [ ] **Step 3**: Run any related test:

```bash
pnpm --filter @digitalagent/server vitest run
```

Expected: PASS (if any test asserts `openclaw_runner`, fix it now).

- [ ] **Step 4**: Commit.

```bash
git add apps/server/src/mission-helpers.ts apps/server/src/mission-helpers.test.ts 2>/dev/null
git commit -m "refactor(server): rename openclaw_runner agent instance id to pi_runner"
```

---

## Task 22: Rename `openclaw` in `artifact-evaluation.ts` + wire new extractor

**Files:**
- Modify: `apps/server/src/artifact-evaluation.ts`
- Modify: `apps/server/src/artifact-evaluation.test.ts` (if exists)

- [ ] **Step 1**: In `artifact-evaluation.ts`, replace all 15 occurrences of `openclaw` → `pi`. Also rename the local function `extractSourcesFromContent` to operate on the renamed `content.pi` key:

```bash
sed -i.bak 's/openclaw/pi/g' apps/server/src/artifact-evaluation.ts
rm apps/server/src/artifact-evaluation.ts.bak
```

- [ ] **Step 2**: Inspect the diff to ensure no false-positive replacement (the word "openclaw" should appear nowhere meaningful outside of the variable/key names; verify):

```bash
git diff apps/server/src/artifact-evaluation.ts | head -80
```

- [ ] **Step 3**: Update the call site that previously invoked `extractSourcesFromOpenClawOutput` so it now uses `extractSourcesFromPiOutput`. Pass `[]` for pre-collected sources for now — the wiring with `result.sources` is set up in Task 24's server.ts changes.

Find the call site:

```bash
grep -n "extractSourcesFromOpenClawOutput\|extractSourcesFromPiOutput" apps/server/src/artifact-evaluation.ts
```

If the name is still old, update it to `extractSourcesFromPiOutput`. Add the second argument:

```typescript
const sources = extractSourcesFromPiOutput(pi, /* preCollected */ []);
```

- [ ] **Step 4**: Run tests:

```bash
pnpm --filter @digitalagent/server vitest run
```

Expected: PASS.

- [ ] **Step 5**: Commit.

```bash
git add apps/server/src/artifact-evaluation.ts apps/server/src/artifact-evaluation.test.ts
git commit -m "refactor(server): rename openclaw to pi in artifact-evaluation + use renamed extractor"
```

---

## Task 23: Rename `/api/health` field and `/api/openclaw/run` route

**Files:**
- Modify: `apps/server/src/api.ts`
- Modify: `apps/server/src/api.test.ts`

- [ ] **Step 1**: In `api.ts`:
  - Change `openclaw: await deps.runtime.health()` → `pi: await deps.runtime.health()`.
  - Change route `request.path === "/api/openclaw/run"` → `request.path === "/api/pi/run"`.

- [ ] **Step 2**: In `api.test.ts`, update any assertion or request that uses the old strings:

```bash
grep -n "openclaw" apps/server/src/api.test.ts
```

For each hit, replace `openclaw` → `pi` (after confirming context).

- [ ] **Step 3**: Run the API tests:

```bash
pnpm --filter @digitalagent/server vitest run src/api.test.ts
```

Expected: PASS.

- [ ] **Step 4**: Commit.

```bash
git add apps/server/src/api.ts apps/server/src/api.test.ts
git commit -m "refactor(server): rename /api/health field and /api/openclaw/run to /api/pi/run"
```

---

## Task 24: Wire `PiSdkAdapter` in `server.ts` and pass `result.sources` through

**Files:**
- Modify: `apps/server/src/server.ts`
- Modify: `apps/server/src/artifact-evaluation.ts` (call site refinement)

- [ ] **Step 1**: In `server.ts`, replace the `PiCliAdapter` instantiation with `PiSdkAdapter`. Search for the existing line:

```bash
grep -n "PiCliAdapter\|new PiCli" apps/server/src/server.ts
```

Replace with:

```typescript
import { PiSdkAdapter, createWebSearchTool } from "@digitalagent/runtime";

const runtime = new PiSdkAdapter({
  apiKey: process.env.LLM_API_KEY ?? process.env.ANTHROPIC_API_KEY ?? "",
  modelProvider: process.env.LLM_PROVIDER ?? "anthropic",
  modelId: process.env.LLM_MODEL ?? "claude-3-5-haiku-latest",
  tools: [
    createWebSearchTool({}),
  ],
});
```

- [ ] **Step 2**: In `mission-service.ts` (or wherever the executeTask result feeds into artifact creation), pass `result.sources` into the artifact content so `extractSourcesFromPiOutput` receives them:

Find the section where `content: { pi: ..., stderr: ... }` is assembled. Replace with:

```typescript
content: { pi: result.output, stderr: result.stderr, sources: result.sources ?? [] }
```

Then update `artifact-evaluation.ts` to read sources from this field as the pre-collected input:

```typescript
const preCollected = Array.isArray((content as any).sources)
  ? ((content as any).sources as Source[])
  : [];
const sources = extractSourcesFromPiOutput(pi, preCollected);
```

- [ ] **Step 3**: Run full server tests:

```bash
pnpm --filter @digitalagent/server vitest run
```

Expected: PASS.

- [ ] **Step 4**: Commit.

```bash
git add apps/server/src/server.ts apps/server/src/mission-service.ts apps/server/src/artifact-evaluation.ts
git commit -m "feat(server): wire PiSdkAdapter and propagate result.sources to artifacts"
```

---

## Task 25: Write failing tests for `store-migration.ts`

**Files:**
- Create: `apps/server/src/store-migration.test.ts`

- [ ] **Step 1**: Create the failing tests covering 4 core cases:

```typescript
import { describe, expect, it } from "vitest";
import { migrateOpenClawToPi } from "./store-migration.js";

describe("migrateOpenClawToPi", () => {
  it("returns unchanged store when no openclaw key present", () => {
    const store = { missions: [], migrationDone: true };
    const result = migrateOpenClawToPi(JSON.stringify(store));
    expect(JSON.parse(result.json)).toEqual(store);
    expect(result.migrated).toBe(false);
  });

  it("rewrites openclaw substrings to pi in keys and values", () => {
    const store = {
      tasks: [
        {
          artifact: {
            content: { openclaw: { searchResults: [{ url: "https://x" }] } },
            evidence: ["openclaw:local"],
          },
          assignedTo: "openclaw_runner",
        },
      ],
    };
    const result = migrateOpenClawToPi(JSON.stringify(store));
    const parsed = JSON.parse(result.json);
    expect(parsed.tasks[0].artifact.content.pi).toBeDefined();
    expect(parsed.tasks[0].artifact.content.openclaw).toBeUndefined();
    expect(parsed.tasks[0].artifact.evidence).toEqual(["pi:local"]);
    expect(parsed.tasks[0].assignedTo).toBe("pi_runner");
    expect(parsed.migrationDone).toBe(true);
    expect(result.migrated).toBe(true);
  });

  it("is idempotent on a store already migrated", () => {
    const store = { tasks: [{ content: { pi: 1 } }], migrationDone: true };
    const result = migrateOpenClawToPi(JSON.stringify(store));
    expect(JSON.parse(result.json)).toEqual(store);
    expect(result.migrated).toBe(false);
  });

  it("handles empty store", () => {
    const result = migrateOpenClawToPi("{}");
    expect(JSON.parse(result.json)).toEqual({ migrationDone: true });
    expect(result.migrated).toBe(false);
  });
});
```

- [ ] **Step 2**: Run:

```bash
pnpm --filter @digitalagent/server vitest run src/store-migration.test.ts
```

Expected: FAIL — module does not exist.

---

## Task 26: Implement `store-migration.ts`

**Files:**
- Create: `apps/server/src/store-migration.ts`

- [ ] **Step 1**: Create the module:

```typescript
export interface MigrationResult {
  json: string;
  migrated: boolean;
}

export function migrateOpenClawToPi(input: string): MigrationResult {
  const trimmed = input.trim();
  if (!trimmed) {
    return { json: JSON.stringify({ migrationDone: true }), migrated: false };
  }

  const parsed = JSON.parse(trimmed);
  if (parsed && typeof parsed === "object" && parsed.migrationDone === true) {
    return { json: JSON.stringify(parsed), migrated: false };
  }

  const rewritten = input.replace(/openclaw/g, "pi");
  const reparsed = JSON.parse(rewritten);
  reparsed.migrationDone = true;
  return { json: JSON.stringify(reparsed), migrated: input !== rewritten };
}
```

(Pre-launch project, no real data — string `replaceAll` is sufficient and the simplest correct implementation. See spec § Decisions.)

- [ ] **Step 2**: Run the failing tests from Task 25:

```bash
pnpm --filter @digitalagent/server vitest run src/store-migration.test.ts
```

Expected: PASS.

- [ ] **Step 3**: Commit.

```bash
git add apps/server/src/store-migration.ts apps/server/src/store-migration.test.ts
git commit -m "feat(server): add one-shot store migration openclaw -> pi"
```

---

## Task 27: Wire `store-migration` into server startup

**Files:**
- Modify: `apps/server/src/mission-service.ts` (or wherever the store is loaded on startup)

- [ ] **Step 1**: Locate where the store JSON is read on startup. Likely in `mission-service.ts` constructor / `loadFromDisk()`. Add a single migration call right after the read:

```typescript
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { migrateOpenClawToPi } from "./store-migration.js";

// inside loadFromDisk() or equivalent:
if (existsSync(storePath)) {
  const raw = readFileSync(storePath, "utf8");
  const migration = migrateOpenClawToPi(raw);
  if (migration.migrated) {
    writeFileSync(storePath, migration.json, "utf8");
    console.log("[store-migration] rewrote openclaw -> pi keys");
  }
  const json = migration.migrated ? migration.json : raw;
  // continue with existing parse logic using `json`
}
```

(Exact lines/variable names depend on the existing code shape; preserve them.)

- [ ] **Step 2**: Run server tests:

```bash
pnpm --filter @digitalagent/server vitest run
```

Expected: PASS.

- [ ] **Step 3**: Commit.

```bash
git add apps/server/src/mission-service.ts
git commit -m "feat(server): run store-migration on startup"
```

---

## Task 28: Add `lint:no-openclaw` CI rule

**Files:**
- Modify: `package.json` (root)

- [ ] **Step 1**: Add a script that fails if `openclaw` appears anywhere in source/tests except the migration code itself and historical docs:

```json
"scripts": {
  "lint:no-openclaw": "! grep -rn 'openclaw' packages apps --include='*.ts' --include='*.json' | grep -v 'store-migration' | grep -v 'CHANGELOG' && echo 'no openclaw residues'"
}
```

(The `!` plus `grep -v` exclusion keeps the rule clean — migration code is allowed to reference it; everything else fails the build.)

- [ ] **Step 2**: Hook it into the existing test command. If `package.json` has `"test": "pnpm -r test"`, change to:

```json
"test": "pnpm lint:no-openclaw && pnpm -r test"
```

- [ ] **Step 3**: Run:

```bash
pnpm lint:no-openclaw
```

Expected: prints "no openclaw residues" and exits 0. If it fails, that means a Task 19–24 rename was missed — fix the offending file now before continuing.

- [ ] **Step 4**: Commit.

```bash
git add package.json
git commit -m "ci: add lint:no-openclaw guard to prevent rename regressions"
```

---

## Task 29: Delete `pi-cli-adapter.*` and `pi-resolver.*`

**Files:**
- Delete: `packages/runtime/src/pi-cli-adapter.ts`
- Delete: `packages/runtime/src/pi-cli-adapter.test.ts`
- Delete: `packages/runtime/src/pi-cli-adapter.smoke.test.ts`
- Delete: `packages/runtime/src/pi-resolver.ts`
- Modify: `packages/runtime/src/index.ts`

- [ ] **Step 1**: Delete the files:

```bash
rm packages/runtime/src/pi-cli-adapter.ts \
   packages/runtime/src/pi-cli-adapter.test.ts \
   packages/runtime/src/pi-cli-adapter.smoke.test.ts \
   packages/runtime/src/pi-resolver.ts
```

If `pi-resolver.test.ts` exists, also delete it (`ls packages/runtime/src/pi-resolver.test.ts && rm packages/runtime/src/pi-resolver.test.ts`).

- [ ] **Step 2**: Update `packages/runtime/src/index.ts`:

```typescript
export * from "./pi-sdk-adapter.js";
export * from "./pi-hooks.js";
export * from "./pi-extensions/web-search.js";
export * from "./llm/index.js";
```

(Removed `pi-cli-adapter.js` and `pi-resolver.js` exports.)

- [ ] **Step 3**: Typecheck + test:

```bash
pnpm typecheck && pnpm test
```

Expected: all green.

- [ ] **Step 4**: Commit.

```bash
git add -A packages/runtime/src/
git commit -m "refactor(runtime): remove pi-cli-adapter and pi-resolver (replaced by pi-sdk-adapter)"
```

---

## Task 30: Remove `@earendil-works/pi-coding-agent` dep

**Files:**
- Modify: `packages/runtime/package.json`

- [ ] **Step 1**: Remove the dep:

```json
"dependencies": {
  "@earendil-works/pi-agent-core": "0.74.0",
  "@earendil-works/pi-ai": "0.74.0",
  "typebox": "^1.1.38"
}
```

- [ ] **Step 2**: `pnpm install` to update lockfile.

- [ ] **Step 3**: Run full suite:

```bash
pnpm typecheck && pnpm test
```

Expected: all green.

- [ ] **Step 4**: Commit.

```bash
git add packages/runtime/package.json pnpm-lock.yaml
git commit -m "chore(deps): drop @earendil-works/pi-coding-agent (no longer used)"
```

---

## Task 31: PI_SMOKE smoke test for Stage 2

**Files:**
- Create: `packages/runtime/src/pi-sdk-adapter.smoke.test.ts`

- [ ] **Step 1**: Create the smoke test:

```typescript
import { describe, expect, it } from "vitest";
import { PiSdkAdapter } from "./pi-sdk-adapter.js";
import { createWebSearchTool } from "./pi-extensions/web-search.js";

const SMOKE = process.env.PI_SMOKE === "1";

describe.skipIf(!SMOKE)("PiSdkAdapter smoke (real LLM)", () => {
  it("completes a minimal prompt and yields a final assistant message", async () => {
    const apiKey = process.env.LLM_API_KEY ?? process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error("PI_SMOKE=1 set but LLM_API_KEY/ANTHROPIC_API_KEY not provided");
    }
    const adapter = new PiSdkAdapter({
      apiKey,
      modelProvider: process.env.LLM_PROVIDER ?? "anthropic",
      modelId: process.env.LLM_MODEL ?? "claude-3-5-haiku-latest",
      tools: [createWebSearchTool({})],
    });

    const result = await adapter.runAgentTask({
      message: "Reply with exactly the word OK.",
      timeoutSeconds: 30,
      systemPrompt: "You are a test fixture. Reply tersely.",
      sessionId: "smoke-stage-2",
    });

    expect(result.status).toBe("completed");
    expect(JSON.stringify(result.output)).toMatch(/OK/i);
  }, 60_000);
});
```

- [ ] **Step 2**: Verify it skips by default:

```bash
pnpm --filter @digitalagent/runtime vitest run src/pi-sdk-adapter.smoke.test.ts
```

Expected: 0 tests run (skipped).

- [ ] **Step 3**: Run for real (manual):

```bash
PI_SMOKE=1 ANTHROPIC_API_KEY=$YOUR_KEY pnpm --filter @digitalagent/runtime vitest run src/pi-sdk-adapter.smoke.test.ts
```

Expected: PASS, cost < $0.5.

- [ ] **Step 4**: Commit.

```bash
git add packages/runtime/src/pi-sdk-adapter.smoke.test.ts
git commit -m "test(runtime): add PiSdkAdapter PI_SMOKE smoke test"
```

---

## Task 32: Stage 2 verification + PR

**Files:** none (verification + PR creation)

- [ ] **Step 1**: Run the full project test suite plus the openclaw lint:

```bash
pnpm typecheck && pnpm test
```

Expected: all green. The `lint:no-openclaw` step (chained into `pnpm test` by Task 28) confirms no residual `openclaw` strings outside the migration file.

- [ ] **Step 2**: Manually run the Stage 2 smoke test once:

```bash
PI_SMOKE=1 ANTHROPIC_API_KEY=$YOUR_KEY pnpm --filter @digitalagent/runtime vitest run src/pi-sdk-adapter.smoke.test.ts
```

Expected: PASS.

- [ ] **Step 3**: Confirm `mission-store.json` migration works on a real dev store. From repo root:

```bash
cp apps/server/data/mission-store.json /tmp/store-before.json
pnpm dev &
SERVER_PID=$!
sleep 5
kill $SERVER_PID
grep -c "openclaw" apps/server/data/mission-store.json
grep -c "pi_runner\|content.*pi\":" apps/server/data/mission-store.json || true
```

Expected: `grep -c "openclaw"` returns 0 after first startup; `migrationDone: true` is now in the file.

- [ ] **Step 4**: Push branch and open the Stage 2 PR:

```bash
git push -u origin HEAD
gh pr create --title "feat(runtime): Plan 6 v2 Stage 2 — pi SDK embed + event stream + rename" --body "$(cat <<'EOF'
## Summary
- Replace pi CLI subprocess with in-process `PiSdkAdapter` (`pi-agent-core` `Agent`); exception isolation fence + hard timeout protect server stability.
- Source extraction now consumes pi event stream (`tool_execution_end` for `web_search`) instead of parsing final JSON.
- Same-Mission task chain shares `sessionId` for pi-ai prompt cache.
- Rename all remaining `openclaw` strings: 15 code sites + dev `mission-store.json` keys (one-shot startup migration, replaceAll-based, idempotent).
- Delete `pi-cli-adapter`, `pi-resolver`, `@earendil-works/pi-coding-agent` dep.
- Add `lint:no-openclaw` CI guard.

## Test plan
- [x] `pnpm typecheck` — green
- [x] `pnpm test` (includes `lint:no-openclaw`) — full suite green
- [x] `PI_SMOKE=1 pnpm --filter @digitalagent/runtime vitest run src/pi-sdk-adapter.smoke.test.ts` — manual once, cost < \$0.5
- [x] Dev `mission-store.json` migrated successfully on first boot

Reference: docs/superpowers/specs/2026-05-11-plan-6-pi-runtime-migration-v2-design.md
EOF
)"
```

Expected: PR URL printed. Wait for review.

- [ ] **Step 5**: After PR merged, update `ROADMAP.md` to mark Plan 6 v2 as completed (Phase A wrap-up) — this is a follow-on docs commit, not part of Stage 2 PR.

---

## Out of Scope / Deferred

- **Role-tool customization** (v2.1, 3-4 days): HR / Reviewer / Content Strategist etc. lose default `bash`/`edit` tools and get role-specific tool sets. Stage 2 leaves all roles with the same `tools: [...]` array as Stage 1.
- **24-hour observation window**: explicitly skipped — project pre-launch, test coverage is the safety net.
- **Token usage/cost dashboard**: independent observability work.
- **Browser automation**: Plan 4 territory.
- **Mission template additions**: separate work.
- **pi RPC connection pool / long-running session**: monitor v2 startup cost; only revisit if pi `new Agent()` shows up as a hot path.

## Notes for the implementer

- **Versions pinned**: both `@earendil-works/pi-ai` and `@earendil-works/pi-agent-core` use exact version `0.74.0` (no `^`). Upgrade requires manual test sweep — see spec § Risk.
- **Hooks**: keep all `beforeToolCall` / `afterToolCall` / `shouldStopAfterTurn` wiring centralized in `packages/runtime/src/pi-hooks.ts`. If you find yourself adding hook config in `pi-sdk-adapter.ts`, move it to `pi-hooks.ts` first.
- **Stage 1 PR must merge before starting Stage 2 work.** Stage 2 tasks assume the new factory shape from Stage 1.
- **Stage 2 commits land on a clean branch off `master`** after Stage 1 is merged — do not stack Stage 2 commits on the Stage 1 branch.
