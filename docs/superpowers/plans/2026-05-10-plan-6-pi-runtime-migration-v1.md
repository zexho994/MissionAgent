# Plan 6 v1 Implementation Plan — pi CLI swap

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the OpenClaw CLI runtime with a pi CLI runtime, hard cut, behind the same `MissionExecutionRuntime` contract; add a pi web-search extension; preserve OpenClaw-shaped JSON output via prompt engineering.

**Architecture:** A new `PiCliAdapter` (parallel to `OpenClawCliAdapter`, same interface) spawns `pi -p --no-session --tools ... --system-prompt ... -e <web-search-ext> "<message>"`. A pi extension exports a `web_search` tool. Per-role system prompts are loaded from `agent-system.json` and passed via `--system-prompt`. The OpenClaw adapter is deleted.

**Tech Stack:** Node `child_process.spawn`, vitest, pi 0.x CLI, `@earendil-works/pi-coding-agent` (extension types), typebox.

**Reference spec:** `docs/superpowers/specs/2026-05-10-plan-6-pi-runtime-migration-design.md`

---

## File Structure

**New:**
- `packages/runtime/src/pi-cli-adapter.ts` — PiCliAdapter class.
- `packages/runtime/src/pi-cli-adapter.test.ts` — unit tests parallel to openclaw-cli-adapter.test.ts.
- `packages/runtime/src/pi-cli-adapter.smoke.test.ts` — PI_SMOKE=1 gated, real binary.
- `packages/runtime/src/pi-extensions/web-search.ts` — pi extension exposing `web_search` tool.
- `packages/runtime/src/pi-extensions/web-search.test.ts` — unit tests for the extension's search function (without spinning up pi).

**Modified:**
- `apps/server/src/runtime-bridge.ts` — `buildOpenClawMessage` → `buildAgentMessage`; system prompt no longer in body. Add optional `systemPrompt` to `MissionExecutionRuntime` input.
- `apps/server/src/mission-service.ts` — resolve role's systemPrompt; pass to runtime.
- `apps/server/src/api.ts` — `ApiDependencies.openclaw` → `ApiDependencies.runtime`. Health response JSON shape unchanged in v1.
- `apps/server/src/server.ts` — instantiate `PiCliAdapter` instead of `OpenClawCliAdapter`.
- `apps/server/src/system-config.ts` — surface per-role `systemPrompt` lookup.
- `apps/server/config/agent-system.json` — add `systemPrompt` to each role: baseAgents (owner, hr), rules[].agent (researcher, content_strategist, system_architect, image_creator), fallbackAgent (mission_operator), reviewAgent.
- `packages/runtime/src/index.ts` — replace OpenClaw export with Pi.
- `package.json` (root) — add `test:smoke` script.

**Deleted:**
- `packages/runtime/src/openclaw-cli-adapter.ts`
- `packages/runtime/src/openclaw-cli-adapter.test.ts`

---

## Task 1: Add `systemPrompt` to MissionExecutionRuntime contract

**Files:**
- Modify: `apps/server/src/runtime-bridge.ts`

- [ ] **Step 1**: Extend the interface so callers may pass an optional `systemPrompt`:

```typescript
export interface MissionExecutionRuntime {
  runAgentTask(input: {
    message: string;
    timeoutSeconds: number;
    systemPrompt?: string;
  }): Promise<{ status: string; output: unknown; stderr: string }>;
}
```

- [ ] **Step 2**: Run `pnpm --filter @digitalagent/server typecheck` — expected pass (existing callers don't pass `systemPrompt` and the field is optional).

- [ ] **Step 3**: Commit `feat(runtime): allow optional systemPrompt on agent task runtime input`.

---

## Task 2: Write PiCliAdapter — health + helpers (TDD)

**Files:**
- Create: `packages/runtime/src/pi-cli-adapter.ts`
- Create: `packages/runtime/src/pi-cli-adapter.test.ts`

- [ ] **Step 1**: Write failing tests for `health()` (success / failure) and `parsePiOutputJson()` (valid / leading garbage / empty / invalid). Mirror the OpenClaw test shape but reference `pi` and `pi --version`.

- [ ] **Step 2**: Run tests — expected fail (`pi-cli-adapter.ts` doesn't exist yet).

- [ ] **Step 3**: Create `pi-cli-adapter.ts` with `PiCliAdapter` class, `CommandRunner` injection, `health()` method, and `parsePiOutputJson()` exported helper. Reuse the `findJsonStarts` + best-effort JSON parsing pattern from openclaw-cli-adapter.

- [ ] **Step 4**: Run tests — expected pass.

- [ ] **Step 5**: Commit `feat(runtime): add PiCliAdapter health check and JSON parser`.

---

## Task 3: PiCliAdapter — runAgentTask

**Files:**
- Modify: `packages/runtime/src/pi-cli-adapter.ts`
- Modify: `packages/runtime/src/pi-cli-adapter.test.ts`

- [ ] **Step 1**: Add tests for `runAgentTask`:
  - Standard call with systemPrompt + message + tools — verify args structure.
  - Without systemPrompt — `--system-prompt` flag absent.
  - Success: pi prints JSON on stdout → returns `{status:"completed", output:<parsed>, stderr}`.
  - Pi exit code != 0 → throws.
  - Empty message → throws "pi agent task message is required".
  - Timeout 0 / negative → throws.
  - Custom extension paths injected via constructor option.

- [ ] **Step 2**: Run tests — expected fail.

- [ ] **Step 3**: Implement `runAgentTask`. Spawn args:
  ```
  pi -p --no-session --tools <list> [--system-prompt <prompt>] [-e <ext-path>...] <message>
  ```
  - Default tools: `read,grep,find,ls,bash,web_search`.
  - Default extensions: bundled `web-search` extension's compiled path.
  - Both configurable via constructor.
  - Timeout: pass via the existing run runner's timeoutSeconds + 30 buffer (mirrors OpenClaw).

- [ ] **Step 4**: Run tests — expected pass.

- [ ] **Step 5**: Commit `feat(runtime): implement PiCliAdapter.runAgentTask`.

---

## Task 4: Web-search pi extension (TDD)

**Files:**
- Create: `packages/runtime/src/pi-extensions/web-search.ts`
- Create: `packages/runtime/src/pi-extensions/web-search.test.ts`

- [ ] **Step 1**: Write failing tests for an exported pure function `searchWeb(query, options)` that takes:
  - `fetch` (injectable) — defaults to global fetch
  - `apiKey` and `endpoint` — env-driven defaults
  - Returns `{ results: Array<{ url, title?, snippet? }>, raw? }`.
  Cover: normal response, empty results, 5xx error, missing apiKey returns empty + warning.

- [ ] **Step 2**: Run tests — expected fail.

- [ ] **Step 3**: Implement `searchWeb` using a JSON-result web search API (default to a Brave Search API endpoint shape — `https://api.search.brave.com/res/v1/web/search`, `X-Subscription-Token` header, `q` query param). Make endpoint and headers fully overridable so any compatible JSON API works.

- [ ] **Step 4**: Add the pi extension entrypoint:
  ```typescript
  // packages/runtime/src/pi-extensions/web-search.ts (default export)
  export default function (pi: ExtensionAPI) {
    pi.registerTool({
      name: "web_search",
      label: "Web Search",
      description: "Search the public web. Returns a list of {url, title, snippet}.",
      parameters: Type.Object({ query: Type.String() }),
      async execute(_id, params) {
        const { results } = await searchWeb(params.query);
        return {
          content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
          details: { searchResults: results, sources: results },
        };
      },
    });
  }
  ```

- [ ] **Step 5**: Run tests — expected pass.

- [ ] **Step 6**: Commit `feat(runtime): add pi web-search extension with searchWeb function`.

---

## Task 5: Add per-role systemPrompt to agent-system.json

**Files:**
- Modify: `apps/server/config/agent-system.json`
- Modify: `apps/server/src/system-config.ts`

- [ ] **Step 1**: Add `systemPrompt` (string) to each agent role definition. Each prompt:
  1. States the role and its responsibility (carry over from existing `responsibility` field).
  2. Instructs the agent that its **final assistant message must be a single valid JSON object** with the shape:
     ```json
     { "summary": "...", "payloads": [...], "searchResults": [...], "sources": [{"url":"...","title":"...","snippet":"..."}] }
     ```
  3. For non-research roles, allows `searchResults` / `sources` to be empty arrays.
  
  Add the field to: `teamPlanner.baseAgents[*]`, each `teamPlanner.rules[*].agent`, `teamPlanner.fallbackAgent`, `teamPlanner.reviewAgent`.

- [ ] **Step 2**: In `system-config.ts`, expose a helper `getRoleSystemPrompt(roleName: string): string | undefined` that searches all role buckets and returns the matching `systemPrompt`. Empty string falls back to undefined.

- [ ] **Step 3**: Run typecheck — expected pass.

- [ ] **Step 4**: Commit `feat(config): add per-role systemPrompt to agent-system.json`.

---

## Task 6: Update runtime-bridge.ts

**Files:**
- Modify: `apps/server/src/runtime-bridge.ts`

- [ ] **Step 1**: Rename `buildOpenClawMessage` → `buildAgentMessage`. Body changes: drop the "You are executing a DigitalAgent Mission task" preamble (that becomes part of the systemPrompt). Body now contains only:
  - "Mission context:" + JSON of {mission, task}
  - "User instruction:" + the original message

- [ ] **Step 2**: Keep `extractSourcesFromOpenClawOutput` as-is (function name and logic unchanged in v1; renamed in v2).

- [ ] **Step 3**: Run any existing runtime-bridge consumers' tests — adjust callsites if compile errors. Mostly the only consumer is `mission-service.ts:1088`.

- [ ] **Step 4**: Commit `refactor(server): rename buildOpenClawMessage to buildAgentMessage; drop preamble`.

---

## Task 7: Update mission-service.ts to pass systemPrompt

**Files:**
- Modify: `apps/server/src/mission-service.ts`

- [ ] **Step 1**: At the call site (~line 1088), resolve the executor agent's role and look up the systemPrompt via `getRoleSystemPrompt(agent.role)` (from `system-config.ts`). Pass to `runtime.runAgentTask`:

```typescript
const executor = this.executionAgent(input.missionId);
const systemPrompt = getRoleSystemPrompt(executor.role);
void runtime
  .runAgentTask({
    message: buildAgentMessage({ message: input.message, mission, task }),
    timeoutSeconds: 300,
    ...(systemPrompt ? { systemPrompt } : {}),
  })
  .then(...)
```

- [ ] **Step 2**: Run `pnpm --filter @digitalagent/server test` — all existing tests should still pass (mocks ignore systemPrompt).

- [ ] **Step 3**: Commit `feat(mission-service): pass per-role systemPrompt to runtime`.

---

## Task 8: Wire PiCliAdapter in server.ts and api.ts

**Files:**
- Modify: `apps/server/src/server.ts`
- Modify: `apps/server/src/api.ts`

- [ ] **Step 1**: In `api.ts`, rename `ApiDependencies.openclaw: Pick<OpenClawCliAdapter, ...>` → `ApiDependencies.runtime: Pick<PiCliAdapter, "health" | "runAgentTask">`. Update the single internal reference (`deps.openclaw.health()` → `deps.runtime.health()`). Keep the JSON response key `openclaw` in the `/api/health` body (deferred to v2 — note in code with a brief comment).

- [ ] **Step 2**: In `server.ts`, replace OpenClaw instantiation with `new PiCliAdapter()`. Pass through the env-driven extension path.

- [ ] **Step 3**: Run `pnpm --filter @digitalagent/server typecheck` — expected pass.

- [ ] **Step 4**: Run `pnpm --filter @digitalagent/server test` — expected pass.

- [ ] **Step 5**: Commit `feat(server): wire PiCliAdapter as runtime dependency`.

---

## Task 9: Update packages/runtime/src/index.ts

**Files:**
- Modify: `packages/runtime/src/index.ts`

- [ ] **Step 1**: Replace `export * from "./openclaw-cli-adapter.js"` with `export * from "./pi-cli-adapter.js"`. Keep the LLM exports.

- [ ] **Step 2**: Run typecheck across the tree.

- [ ] **Step 3**: Commit `refactor(runtime): export PiCliAdapter instead of OpenClawCliAdapter`.

---

## Task 10: Smoke test (PI_SMOKE gated)

**Files:**
- Create: `packages/runtime/src/pi-cli-adapter.smoke.test.ts`
- Modify: root `package.json`

- [ ] **Step 1**: Write a smoke test gated by `process.env.PI_SMOKE === "1"`:

```typescript
import { describe, it, expect } from "vitest";
import { PiCliAdapter } from "./pi-cli-adapter.js";

const SMOKE = process.env.PI_SMOKE === "1";

describe.skipIf(!SMOKE)("PiCliAdapter smoke (PI_SMOKE=1)", () => {
  it("calls real pi binary with a trivial prompt and parses JSON", async () => {
    const adapter = new PiCliAdapter();
    const health = await adapter.health();
    expect(health.available).toBe(true);

    const result = await adapter.runAgentTask({
      message: 'Reply with the JSON object {"result":"ok"} and nothing else.',
      timeoutSeconds: 60,
      systemPrompt: 'You must respond with a single valid JSON object.',
    });
    expect(result.status).toBe("completed");
    expect(result.output).toEqual(expect.objectContaining({ result: "ok" }));
  }, 90_000);
});
```

- [ ] **Step 2**: Add to root `package.json`:
```json
"scripts": {
  "test:smoke": "PI_SMOKE=1 pnpm -r --workspace-concurrency=1 test"
}
```

- [ ] **Step 3**: Commit `test(runtime): add PI_SMOKE-gated pi adapter smoke test`.

---

## Task 11: Delete OpenClaw adapter + cleanup

**Files:**
- Delete: `packages/runtime/src/openclaw-cli-adapter.ts`
- Delete: `packages/runtime/src/openclaw-cli-adapter.test.ts`

- [ ] **Step 1**: `git rm packages/runtime/src/openclaw-cli-adapter.ts packages/runtime/src/openclaw-cli-adapter.test.ts`.

- [ ] **Step 2**: Confirm no remaining references to `OpenClawCliAdapter` in source: `grep -rn "OpenClawCliAdapter" packages/ apps/`.

- [ ] **Step 3**: Run typecheck across all packages.

- [ ] **Step 4**: Run all tests (mocked) across all packages — expected pass.

- [ ] **Step 5**: Commit `chore(runtime): remove OpenClawCliAdapter and tests`.

---

## Task 12: Verify — typecheck + full mocked test suite

- [ ] **Step 1**: From repo root, `pnpm typecheck`.

- [ ] **Step 2**: From repo root, `pnpm test`.

- [ ] **Step 3**: `grep -ri openclaw packages/ apps/` — only acceptable hit is the artifact `content.openclaw` envelope key (per spec, deferred to v2) and the comment in api.ts noting the JSON shape is intentionally preserved.

---

## Task 13: Code review

- [ ] **Step 1**: Run code review via `superpowers:requesting-code-review` or dispatch `superpowers:code-reviewer` agent. Pass spec + plan + diff.

- [ ] **Step 2**: Address CRITICAL and HIGH findings. Re-run typecheck and tests after each fix. Commit fixes.

- [ ] **Step 3**: When review is clean (or only LOW remain with rationale), report ready for user verification.

---

## Out of Scope / Deferred

- **Pi binary install**: tests are gated by `PI_SMOKE`; if pi is not installed locally, the smoke test is `skipIf`-skipped, all other tests pass. Pre-merge instruction: install pi (`npm i -g @earendil-works/pi-coding-agent`) and run `pnpm test:smoke` once.
- **Web-search backend choice**: defaults to Brave Search API shape; `WEB_SEARCH_BACKEND_URL`, `WEB_SEARCH_API_KEY`, `WEB_SEARCH_HEADER_NAME` env vars override.
- **Artifact content envelope rename** (`openclaw` → `runtime`): v2.
- **`/api/health` JSON key rename** (`openclaw` → `runtime`): v2.
- **`extractSourcesFromOpenClawOutput` rename + event-stream rewrite**: v2.
- **LlmService consolidation**: v2.
