# Plan 6: Runtime Base Migration — pi Replacing OpenClaw — Product Design

## Overview

Plan 6 swaps the engine that actually runs AI agent tasks. Today the codebase shells out to the `openclaw` CLI per task. Plan 6 replaces it with the [pi](https://github.com/earendil-works/pi) project (47k stars, MIT, TypeScript, actively updated as of 2026-05-09).

The migration is split into two iterations:

- **v1** is a hard CLI swap: replace `openclaw` invocations with `pi`, keep the existing `MissionExecutionRuntime` interface untouched, and add the one capability pi does not ship with — a web search extension.
- **v2** embeds pi as an in-process SDK, removes the per-task subprocess boundary, and consolidates the project's separate multi-provider LLM layer (`LlmService`) onto pi's own LLM gateway (`pi-ai`).

OpenClaw is itself built on top of pi (its `package.json` references `@mariozechner/pi-coding-agent`) and ships an additional 30+ messaging-channel integrations (Slack, Discord, WhatsApp, Telegram, Feishu, MSTeams, etc.) that DigitalAgent does not use. The migration removes a heavyweight aggregator we never opted into.

## Current Problem

DigitalAgent's runtime touch surface is small but has accumulated friction:

1. **Untargeted dependency.** `openclaw` (370k stars, multi-channel AI gateway) is installed as a CLI binary but DigitalAgent only calls one subcommand: `openclaw agent --local --json`. Every install pulls in code paths for messaging adapters and channel integrations that are never used.
2. **Tied to one provider surface.** OpenClaw exposes its own "agent registry" (`openclaw agents add`, `openclaw agents list`) which DigitalAgent has to mirror. The provider matrix and tool surface are whatever OpenClaw chose to expose.
3. **Output is a single JSON blob.** The current execution path waits for OpenClaw to finish, then parses one JSON document from stdout. There is no streaming, no tool-execution event surface, no per-step visibility — even though the underlying agent was streaming under the hood.
4. **Two parallel multi-provider LLM layers.** `packages/runtime/src/llm/` (`LlmService`, `LlmMessage`, `FakeLlmAdapter`) is a hand-rolled multi-provider abstraction used by 12+ call sites for chat-style LLM use. It does roughly what `pi-ai` does, but in less coverage.

## Goals

- Replace OpenClaw with pi as the agent task runtime, end to end.
- Keep the `MissionExecutionRuntime` contract stable across v1 so all existing tests and call sites continue to work without modification.
- Add a pi web search extension so research/social Missions do not regress when OpenClaw's built-in search is gone.
- In v2, eliminate the per-task subprocess boundary and consolidate the project onto a single LLM gateway (`pi-ai`), reducing the maintained surface by one whole abstraction.
- Land v1 before Plan 5 (speakin Mission observation) starts, so the 4-week observation runs on a stable base.

## Non-Goals

### v1

- Do not introduce an A/B comparison framework or runtime feature flag. v1 is a hard cut; rollback is `git revert`.
- Do not collect token / latency / cost metrics. That belongs to a separate observability initiative.
- Do not pool pi processes or persist sessions across tasks. Per-task `spawn` is fine for v1.
- Do not integrate the broader pi extension marketplace. Only the in-tree `web-search` extension ships.
- Do not change the `MissionExecutionRuntime` interface, `Mission` / `Task` / `Artifact` domain types, or the public REST API shape.
- Do not change the artifact `content` schema. v1 keeps the existing `{ openclaw, stderr }` envelope so historical artifacts remain consistent.

### v2

- Do not write a backwards-compat shim for the removed `LlmService`. All 12+ call sites are migrated to `pi-ai` directly.
- Do not migrate historical artifact content. Old artifacts keep `content.openclaw`; new artifacts use `content.runtime`. Frontend compatibility (reading `runtime ?? openclaw`) is acknowledged as known unprettiness, scoped out as a separate frontend cleanup task.
- Do not build a UI for editing tool allowlists or system prompts. Configuration stays file-driven (`agent-system.json`).
- Do not absorb browser-tool work. Plan 4 covers that separately.
- Do not implement a pi RPC long-running pool. If process startup cost shows up in v2 measurements, that is a follow-up.

## Recommended Approach

A two-phase migration with a stable interface boundary between phases:

1. **v1 — CLI swap.** Replace the OpenClaw CLI adapter with a pi CLI adapter behind the same `MissionExecutionRuntime` contract. Use prompt engineering to coerce pi into emitting the same JSON output shape OpenClaw does, so the existing `extractSourcesFromOpenClawOutput` logic continues to work unchanged. Add a TypeScript pi extension that registers a `web_search` tool to backfill the one capability OpenClaw provided that pi does not.

2. **v2 — SDK embed plus LlmService removal.** Move pi from a child process to an in-process Node dependency (`@earendil-works/pi-coding-agent` + `@earendil-works/pi-agent-core`). Replace the prompt-engineered JSON envelope with consumption of pi's structured `tool_execution_end` events. Delete `packages/runtime/src/llm/` entirely and migrate all 12+ `LlmService` call sites to `pi-ai`'s `stream` / `complete` API.

### Rejected Alternatives

- **Coexistence with environment-variable switch (v1).** Two adapters in parallel, env var picks one. Allows live A/B and instant rollback. Rejected because the integration surface is genuinely small (one interface, four direct call sites, one health endpoint) and the rollback story (`git revert`) is acceptable for a one-PR change. Maintaining two adapters would double the testing burden during what should be a quick swap.

- **Per-Mission routing (v1).** New Missions pi, old Missions OpenClaw. Most conservative. Rejected for the same reason as above, plus it bakes in two-runtime branching that becomes harder to remove later.

- **Event-stream extractor in v1.** Skip the prompt-engineered JSON shape, rewrite `extractSourcesFromOpenClawOutput` immediately to consume pi's tool-call events. Rejected because v1 should change one thing (the runtime), not two (runtime + output protocol). The event-stream rewrite lands in v2 alongside the SDK embed where the new event shape is naturally available anyway.

- **Keep `LlmService` in v2.** SDK embed only; defer the LLM consolidation to a later plan. Rejected because once pi is in-process, `pi-ai` is already a transitive dependency. Keeping a parallel hand-rolled multi-provider layer means maintaining duplicate code that does the same thing, with the hand-rolled side covering fewer providers.

## Architecture — v1

### What Changes

**New files:**

- `packages/runtime/src/pi-cli-adapter.ts` — implements `MissionExecutionRuntime` by spawning the `pi` CLI in print + JSON mode and parsing the final assistant message.
- `packages/runtime/src/pi-extensions/web-search.ts` — a pi extension exporting a `web_search` tool. The search backend (Bing / Brave / SerpAPI / etc.) is injected via env vars; if no backend is configured, the tool is not registered and pi will not attempt to call it.
- `packages/runtime/src/pi-cli-adapter.test.ts` — unit tests mirroring the existing `openclaw-cli-adapter.test.ts` (mock command runner, cover health / task success / command failure / timeout / non-JSON output / JSON in stderr).
- `packages/runtime/src/pi-extensions/web-search.test.ts` — unit tests covering normal search response, empty results, and 5xx backend.
- `packages/runtime/src/pi-cli-adapter.smoke.test.ts` — gated by `PI_SMOKE=1`, runs real `pi` binary against a trivial prompt with the cheapest configured model. Default behavior is `it.skip`. Run manually before merging.

**Modified files:**

- `apps/server/src/runtime-bridge.ts` — rename `buildOpenClawMessage` → `buildAgentMessage`. The system-prompt portion of what was previously concatenated into the message body is removed; the message body now contains only the mission/task context plus the user instruction. The system prompt for the agent role is passed separately via the new `--system-prompt` flag in the adapter.
- `apps/server/src/mission-service.ts` — the single call site at line 1088 now injects `PiCliAdapter`. The artifact `content` envelope is unchanged in v1: `{ openclaw: result.output, stderr }` (renamed in v2).
- `apps/server/src/api.ts` — the dependency-injection type field is renamed: `ApiDependencies.openclaw: Pick<OpenClawCliAdapter, ...>` → `ApiDependencies.runtime: Pick<PiCliAdapter, ...>`. This is a type-level change internal to the server. The public JSON response shape from `/api/health` is **unchanged in v1** (still has key `openclaw`) to avoid a public API change in this iteration; that key is renamed in v2 alongside the artifact envelope rename.
- `apps/server/config/agent-system.json` — each agent role gets a new `systemPrompt` field. The team-planning code in `apps/server/src/team-planning.ts` passes this through to the adapter when it dispatches a task.
- `apps/server/src/server.ts` — startup wires `PiCliAdapter` instead of `OpenClawCliAdapter`.

**Deleted files:**

- `packages/runtime/src/openclaw-cli-adapter.ts`
- `packages/runtime/src/openclaw-cli-adapter.test.ts`
- The OpenClaw export line in `packages/runtime/src/index.ts`.

### CLI Invocation Shape

```
pi -p \
  --mode json \
  --no-session \
  --tools read,grep,find,ls,bash,web_search \
  --system-prompt "<role-specific system prompt from agent-system.json>" \
  --extension ./node_modules/@digitalagent/runtime/dist/pi-extensions/web-search.js \
  "<message body: mission context + user instruction>"
```

The adapter reads NDJSON events from stdout (`--mode json` produces line-delimited event objects). It collects events until the run terminates, then constructs the result envelope by extracting the final assistant message text and treating it as the JSON payload to hand back to the existing `extractSourcesFromOpenClawOutput` logic.

### Output Shape Coercion (v1 only)

The system prompt in `agent-system.json` includes an explicit instruction that the agent's final message must be a valid JSON object with `searchResults` / `sources` / `payloads` keys when the agent did web research. The existing `extractSourcesFromOpenClawOutput` continues to work without code changes.

When the agent returns malformed JSON, the extractor returns an empty source list (existing best-effort behavior), the artifact still lands, and a warning is logged. This is the same failure mode OpenClaw produces today.

## Architecture — v2

### What Changes

**Replace:**

- `pi-cli-adapter.ts` → `pi-sdk-runtime.ts`. Direct dependency on `@earendil-works/pi-coding-agent` + `@earendil-works/pi-agent-core`. Tasks execute in-process via `createAgentSession()`. No subprocess.

**Rewrite:**

- `extractSourcesFromOpenClawOutput` → `extractSourcesFromAgentEvents`. Consumes `tool_execution_end` events from pi for `web_search` tool calls. The system-prompt JSON-coercion language added in v1 is removed.
- The artifact `content` envelope: `{ openclaw, stderr }` → `{ runtime, events, stderr }`. New field `events` contains the structured pi event stream for downstream observability. Old artifacts keep their `content.openclaw` shape; backend reads new artifacts only via `content.runtime`.
- The `/api/health` JSON response key: `openclaw` → `runtime`. This is a public API shape change deferred from v1; the v2 PR description must call it out as a coordinated change with any frontend that reads `health.openclaw`.

**Delete:**

- `packages/runtime/src/llm/` — all of `LlmService`, `LlmMessage`, `FakeLlmAdapter`, and the multi-provider implementations.

**Migrate (12+ files):**

- `apps/server/src/agent-autonomy.ts`
- `apps/server/src/agent-conversation-bus.ts`
- `apps/server/src/hr-agent.ts`
- `apps/server/src/owner-streaming.ts`
- `apps/server/src/negotiation-manager.ts`
- `apps/server/src/negotiation-service.ts`
- `apps/server/src/mission-service.ts`
- `apps/server/src/hr-activation.ts`
- Plus the corresponding `.test.ts` files. Each `FakeLlmAdapter` mock is replaced by a `pi-ai` mock via the `streamFn` injection point that `pi-ai` provides for exactly this purpose.

The migration leans on TypeScript's strict mode: deleting `packages/runtime/src/llm/` first surfaces every consumer through `tsc` errors; each file is migrated until typecheck is clean.

### Optional in-Process Optimization

Pi supports per-session prompt caching via the `sessionId` parameter on `createAgentSession()`. The v2 SDK runtime should pass a per-Mission session ID so consecutive tasks within the same Mission can share cache state. This is mentioned here for completeness but is not a v2 acceptance gate — it is an optimization, not a correctness requirement.

## Testing

The project has no CI and the entire existing test suite mocks LLM access through `FakeLlmAdapter`. Plan 6 preserves this default and adds exactly **one** smoke test as a manual pre-merge gate:

- `pi-cli-adapter.smoke.test.ts` (v1) — env `PI_SMOKE=1` triggers the test; otherwise `it.skip`. Runs the real `pi` binary against a trivial prompt (`reply with the JSON object {"result":"ok"}`) on the cheapest configured model. Verifies pi is callable, the JSON envelope round-trips, and the adapter's parser handles real output. Cost per run is intended to stay under USD 0.01.
- v2 reuses the same smoke test name; the implementation switches from CLI invocation to direct SDK invocation. The test contract (env-gated, single trivial round-trip) does not change.

All other tests remain mock-based. The 12+ `runAgentTask` mocks in `mission-service.test.ts`, `autonomous-flow.test.ts`, and elsewhere are not touched in v1 because the runtime interface is stable. In v2 those mocks shift from mocking `LlmService` to mocking `pi-ai`'s `streamFn`.

A `pnpm test:smoke` script is added that sets `PI_SMOKE=1` and invokes vitest with a smoke-only filter. The PR description for v1 (and again for v2) must record that the smoke test ran green locally before merge.

## Risks & Rollback

| Risk | Mitigation |
|---|---|
| pi binary not installed on the deployment environment that previously had OpenClaw | Adapter calls `pi --version` at startup; missing binary fails fast with a clear error. Deployment runbook gets a one-line change. |
| pi does not honor the JSON output shape in v1 | Extractor stays best-effort (matches today's behavior). A failed extraction logs a warning and returns an empty source list; the artifact still lands. v2 removes this fragility entirely by consuming structured events. |
| Web search backend API key / rate limits / cost | The web-search extension reads its backend choice and credentials from env. When env is missing, the tool is not registered and pi does not attempt to call it. The default backend choice keeps cost predictable. |
| `pi-coding-agent` npm install size in v2 | v1 is unaffected (CLI binary, no `node_modules` cost). v2 imports `pi-agent-core` and `pi-ai` directly; the heavier `pi-coding-agent` package is avoided unless explicitly needed. |
| Hard cut means rollback is `git revert` | v1 is a single PR. Commits inside that PR are kept atomic so the revert is one command. The smoke test gate before merge is the primary safeguard. |
| LlmService removal in v2 may miss a call site | Deletion of `packages/runtime/src/llm/` is the first commit of the v2 PR; subsequent commits each fix a `tsc` error. The PR is not mergeable until typecheck is clean across the whole tree. |
| pi extension API may change between versions | Pin pi to a specific minor version at v1 install. Bump explicitly with PR notes. |

## Acceptance Criteria

### v1

- All existing tests pass with `PiCliAdapter` injected at the runtime boundary, with no modifications to test files outside `packages/runtime/`.
- `pi --version` health check returns success on a fresh dev machine after running the documented install step.
- `pi-cli-adapter.smoke.test.ts` passes with `PI_SMOKE=1` against a real pi binary and a real (cheapest-tier) LLM.
- One reference Mission run (manually executed in dev) produces an artifact with non-empty `content.openclaw` and at least one extracted source when the agent performed a web search.
- The OpenClaw adapter file and tests are deleted; `grep -ri openclaw packages/ apps/` returns only the intentional places (artifact key envelope, agent-system.json migration notes).

### v2

- `packages/runtime/src/llm/` no longer exists. `tsc` passes across the whole tree.
- `apps/server/src/server.ts` does not spawn any subprocess to execute agent tasks.
- The same smoke test passes against the SDK runtime (env `PI_SMOKE=1`).
- An end-to-end Mission cycle (start → task → artifact → review) completes against a real LLM via the in-process pi runtime.
- The artifact content envelope's `runtime` key is populated for new artifacts. Old artifacts' `content.openclaw` is left untouched. Frontend rendering compatibility (reading `runtime ?? openclaw`) is acknowledged as a separate frontend task; v2 acceptance only verifies the backend writes the new shape correctly.
- All `LlmService` consumers (12+ files) compile and pass tests with their `pi-ai`-based mocks.

## Dependencies

- v1 is decoupled from Plan 4 (browser automation) and Plan 5 (speakin observation).
- **Recommendation: land v1 before Plan 5 starts.** Switching the runtime mid-observation would contaminate Plan 5's data baseline.
- v2 can run parallel to Plan 5 without disrupting the observation as long as the smoke test passes; Plan 5's mocked tests are unaffected by the in-process switch.

## Open Items Acknowledged Out of Scope

- Web-search backend choice (Bing vs Brave vs SerpAPI vs custom) is left to the implementation plan, not the spec. The spec only mandates that the choice is environment-injected and that absence of credentials degrades gracefully.
- Frontend cleanup of the `runtime ?? openclaw` fallback in War Room is left to a future frontend task. The fallback is documented as known unprettiness, not a defect.
- Per-Mission `sessionId` for prompt caching in v2 is an optional optimization; the spec acknowledges the capability but does not require it for acceptance.
