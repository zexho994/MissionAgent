# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

DigitalAgent is a Mission Harness for long-running agent teamwork. The core owns missions, teams, tasks, contracts, artifacts, reviews, memory, and budgets. Execution runtimes (OpenClaw, Codex CLI, Claude Code, browser workers) are adapters — agents are work units inside a controlled mission system, not the system itself.

## Commands

```bash
pnpm install          # Install all dependencies
pnpm build            # Build all packages (core → runtime → server)
pnpm dev              # Build and start server on http://127.0.0.1:3000
pnpm test             # Run all tests across packages
pnpm typecheck        # Type-check all packages
```

### Running a single test

```bash
pnpm --filter @digitalagent/core vitest run src/mission.test.ts
pnpm --filter @digitalagent/server vitest run src/api.test.ts
```

### Build order matters

The server depends on built outputs of core and runtime. Server scripts handle this via `prebuild`/`pretest`/`pretypecheck`, but if working directly on core types you may need: `pnpm --filter @digitalagent/core build` first.

## Architecture

### Monorepo structure (pnpm workspaces)

```
packages/core/       → @digitalagent/core    — Domain layer (pure TypeScript, no I/O)
packages/runtime/    → @digitalagent/runtime  — Execution adapters (OpenClaw CLI, etc.)
apps/server/         → @digitalagent/server   — HTTP server + in-memory mission service + static UI
```

### Core domain model (`@digitalagent/core`)

Immutable domain objects and a strict task state machine. All types live in `packages/core/src/types.ts`:

- **Mission** → top-level goal with budget, status, success metrics
- **Task** → work unit with a contract (objective, input, output schema, success criteria)
- **TaskStateMachine** → 12-status FSM with 16 event types, enforced via `transitionTask()`. Transitions are defined per-status and throw on invalid moves
- **Artifact** → task output with quality score
- **Review** → artifact evaluation (approve/revise/reject)

Task lifecycle: `draft → ready → queued → running → (waiting_tool | waiting_approval | submitted) → reviewing → (completed | revision_needed | failed)`

### Runtime adapters (`@digitalagent/runtime`)

`OpenClawCliAdapter` spawns the `openclaw` CLI as a child process. Key methods: `health()`, `listAgents()`, `runAgentTask()`. Agent resolution: uses `OPENCLAW_AGENT_ID` env var, then falls back to auto-discovery via `openclaw agents list`.

### Server (`@digitalagent/server`)

- **`server.ts`** — Node HTTP server, serves static files from `public/` and routes `/api/*` to the API handler
- **`api.ts`** — Pure function `handleApiRequest(request, deps)` — stateless handler with dependency injection, no Express
- **`mission-service.ts`** — `InMemoryMissionService` — the main orchestrator. Manages missions, tasks, executions, agents (WarRoom), agent relations, messages, tool calls, and decisions. Persists to JSON file (`DIGITALAGENT_STORE_FILE` env var, defaults to `apps/server/data/mission-store.json`)
- **`system-config.ts`** — Loads `config/agent-system.json` which defines the team planner rules, agent specs, and UI strings

### Team planning system

Mission creation triggers rule-based team assembly:
1. Goal text is matched against keyword rules in `agent-system.json` (research, social, product, image)
2. Matching rules add specialized agents to the team
3. Agents are linked via `AgentRelation` with labeled connections
4. An initial task is selected based on which rules matched
5. Agent capabilities (plan/execute/review) are matched via regex patterns against role names

### Artifact quality evaluation

`evaluateArtifactQuality()` in `mission-service.ts` scores execution output on a 0–1 scale based on: output presence, relevance to mission goal (keyword overlap), media generation evidence, and success metric coverage.

## Key conventions

- **Immutability**: All domain objects are created via factory functions (`createMission`, `createTask`, etc.) and never mutated. State transitions return new objects.
- **Test-first development**: Core behavior is developed with failing tests first. Tests use Vitest.
- **No Express**: The server uses raw Node `http` with a hand-rolled request handler. `handleApiRequest` is a pure async function for testability.
- **Config-driven team planning**: Agent roles, rules, and prompts are in `apps/server/config/agent-system.json`, not hardcoded.
- **TypeScript strict mode** with `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess` enabled.
