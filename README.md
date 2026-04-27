# DigitalAgent

DigitalAgent is a Mission Harness for long-running agent teamwork.

The core idea is simple:

- `DigitalAgent Core` owns missions, teams, tasks, contracts, artifacts, reviews, memory, and budgets.
- Execution runtimes such as OpenClaw, Codex CLI, Claude Code, or browser workers are adapters.
- Agents are work units inside a controlled mission system, not the system itself.

## Current Code

The first package is `@digitalagent/core`.

It currently contains the minimal domain layer:

- `Mission`
- `RoleSpec`
- `AgentInstance`
- `Task`
- `TaskStateMachine`
- `Artifact`
- `Review`

## Commands

```bash
pnpm install
pnpm test
pnpm typecheck
```

## Development Rule

Core behavior is developed test-first. New runtime behavior should start with a failing test that describes the expected system contract.
