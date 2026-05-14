# Pi Agent Skill Loading Design

**Date**: 2026-05-14
**Status**: Draft for review

## 1. Problem

Owner, MissionPlan, HR, and runtime mission agents currently lack a shared understanding of what DigitalAgent itself can do. In the idiom-chain acceptance flow, Owner treated the request as if the user wanted to design or build an external project, instead of recognizing that the user wanted to use DigitalAgent's internal multi-agent collaboration capability to perform a mission.

The immediate need is not a full skill marketplace or permission system. The system needs a small, testable way for pi-agent-backed agents to dynamically load local DigitalAgent skill documents when they need product capability context.

## 2. Goals

1. Add a generic skill-loading capability backed by pi-agent tool calling.
2. Use file paths as the stable skill reference, not skill ids.
3. Make all skills visible to all LLM stages in the first version.
4. Let Owner, MissionPlan, HR, and runtime mission agents use the same skill loading tools.
5. Keep configuration in JSON and aligned with existing `agent-system.json`.
6. Preserve fastfail behavior for invalid paths, missing files, invalid config, and pi-agent failures.

## 3. Non-Goals

- No skill id registry.
- No stage-specific skill policy.
- No file size limit for skill documents.
- No skill install/update UI.
- No remote skill loading.
- No arbitrary filesystem read access.
- No business tool permission system in this phase.
- No attempt to solve all runtime tools such as code editing, browser validation, or file IO in this design.

## 4. Skill Files

Skills live under one configured root:

```txt
apps/server/config/skills/
  digitalagent/
    SKILL.md
    capabilities/
      agent-collaboration.md
      code-writing.md
      web-search.md
      file-io.md
      browser-validation.md
```

The path passed to the tool is always relative to the skill root:

```txt
digitalagent/SKILL.md
digitalagent/capabilities/agent-collaboration.md
```

`digitalagent/SKILL.md` is the entrypoint. It explains that DigitalAgent is a mission execution system and summarizes the capability files agents may load for more detail.

## 5. Configuration

The first version adds a small `skills` section to `apps/server/config/agent-system.json`:

```json
{
  "skills": {
    "rootDir": "config/skills"
  }
}
```

`rootDir` is resolved relative to `apps/server` runtime cwd, matching how the server already loads `config/agent-system.json`. Startup should fail if the configured directory does not exist.

No YAML is introduced. JSON keeps the implementation dependency-free and consistent with existing agent configuration.

## 6. Tool Interface

All pi-agent-backed stages receive the same two tools:

### `list_skill_files`

Input:

```json
{
  "query": "optional search text"
}
```

Behavior:

- Recursively lists `.md` files under the configured skill root.
- Returns relative paths only.
- If `query` is provided, filters by path and heading/summary text using simple case-insensitive matching.
- Does not expose absolute paths.

Output example:

```json
[
  {
    "path": "digitalagent/SKILL.md",
    "title": "DigitalAgent Skill"
  },
  {
    "path": "digitalagent/capabilities/agent-collaboration.md",
    "title": "Agent Collaboration"
  }
]
```

### `load_skill`

Input:

```json
{
  "path": "digitalagent/SKILL.md"
}
```

Behavior:

- Loads exactly one markdown skill file.
- Accepts only relative paths.
- Rejects absolute paths.
- Rejects `..` path traversal.
- Resolves the requested path and verifies it remains inside the skill root.
- Allows only `.md` files.
- Fails if the file does not exist or is not readable.
- Does not impose a file size limit in this version.

Output:

```json
{
  "path": "digitalagent/SKILL.md",
  "content": "# DigitalAgent Skill\n..."
}
```

## 7. Shared pi-agent Runner

The implementation should avoid two independent tool-calling systems. Introduce one shared helper in `packages/runtime`, conceptually:

```ts
runPiAgent({
  apiKey,
  modelProvider,
  modelId,
  systemPrompt,
  messages,
  tools,
  sessionId,
  timeoutSeconds,
  onEvent,
})
```

Responsibilities:

- Resolve the pi model.
- Create `new Agent({ initialState: { systemPrompt, model, tools, messages } })`.
- Subscribe to agent events.
- Run `agent.prompt(...)` with timeout.
- Return final messages and collected metadata.
- Surface failures as explicit errors or failed results; do not silently continue without tools.

This runner becomes the only place that constructs pi-agent instances for LLM/tool-calling flows.

## 8. LLM Stage Integration

Create a pi-agent-backed `LlmService` implementation, conceptually:

```ts
createPiAgentLlmService({
  apiKey,
  modelProvider,
  modelId,
  tools,
})
```

It implements the existing `LlmService.call(messages, options)` interface so current Owner, MissionPlan, and HR code can keep using `llm.call(...)`.

Internally it:

1. Splits system messages into `systemPrompt`.
2. Converts user/assistant messages into pi-agent initial messages.
3. Injects `list_skill_files` and `load_skill`.
4. Sends the latest user instruction to `agent.prompt(...)`.
5. Extracts the final assistant text from `agent.state.messages`.
6. Preserves `onStream` behavior when pi-agent emits token/text events; if token events are unavailable, it returns final content through the existing response path.

The server should construct this service instead of the current completion-only `LlmService` for Owner, MissionPlan, and HR paths.

## 9. Runtime Agent Integration

Runtime mission agents already use `PiSdkAdapter.runAgentTask(...)`. Refactor `PiSdkAdapter` to use the same shared `runPiAgent(...)` helper and include the same skill tools in the `tools` list.

The first version does not add per-agent business tool permissions. Existing runtime tools such as `web_search` may continue to be registered the way they are today. The key requirement is that runtime mission agents can also call:

```txt
list_skill_files
load_skill
```

This ensures a worker agent executing a code, research, collaboration, or validation task can dynamically load DigitalAgent capability guidance just like Owner, MissionPlan, and HR.

## 10. Prompt Updates

Owner, MissionPlan, HR, and runtime agent prompts should include a short instruction:

```text
You have access to skill loading tools. Use list_skill_files and load_skill when you need to understand DigitalAgent capabilities or task-specific operating guidance. Start with digitalagent/SKILL.md when interpreting how DigitalAgent should execute a user mission.
```

Owner-specific guidance should also say:

```text
Interpret user requests in the context of DigitalAgent capabilities. If the user wants DigitalAgent agents to perform or test a workflow, do not rewrite that into an external software-building project unless the user explicitly asks to build software.
```

This is not a hardcoded intent classifier. It gives Owner the product capability context needed to judge the request.

## 11. Error Handling

Fastfail cases:

- `skills.rootDir` is missing or does not exist at server startup.
- `load_skill.path` is absolute.
- `load_skill.path` contains path traversal.
- Resolved path escapes the skill root.
- Path does not end with `.md`.
- Skill file does not exist.
- Skill file cannot be read.
- pi-agent fails to execute a tool call.
- pi-agent returns no assistant content for an LLM stage that requires content.

Errors should be visible in the same place current LLM errors surface:

- Owner: `owner_error` and blocked/idle state according to existing Owner failure behavior.
- MissionPlan: API error from plan generation.
- HR: HR failed state after retry exhaustion.
- Runtime agent: failed tool call / failed execution result.

## 12. Tests

Unit tests:

- `list_skill_files` returns relative `.md` paths and never absolute paths.
- `list_skill_files` filters by query.
- `load_skill` loads a valid relative markdown path.
- `load_skill` rejects absolute paths.
- `load_skill` rejects `../` traversal.
- `load_skill` rejects non-markdown files.
- `load_skill` rejects missing files.
- Config validation fails if `skills.rootDir` is missing.

Integration tests:

- Pi-agent-backed `LlmService` receives skill tools.
- Owner can call `load_skill("digitalagent/SKILL.md")` before generating a MissionBrief.
- MissionPlan generation can load DigitalAgent capability context.
- HR can load DigitalAgent capability context before proposing roles.
- Runtime `PiSdkAdapter.runAgentTask(...)` includes skill tools.

Behavioral regression tests:

- A request like "5 个 agent 协作玩成语接龙,测试 mission 中 agent 协作是否通了" is not rewritten as "build an idiom-chain framework".
- A request like "实现一个成语接龙 Web App" remains a build-artifact mission and can still lead to code-writing planning.

## 13. Implementation Order

1. Add skill config type and validation in `system-config.ts`.
2. Add initial skill markdown files under `apps/server/config/skills`.
3. Implement skill filesystem helpers.
4. Implement `createSkillTools(...)`.
5. Extract shared `runPiAgent(...)` from current `PiSdkAdapter` logic.
6. Implement pi-agent-backed `LlmService`.
7. Wire server LLM creation to the pi-agent-backed service.
8. Refactor `PiSdkAdapter` to reuse `runPiAgent(...)` and include skill tools.
9. Update Owner, MissionPlan, HR, and runtime prompts with concise skill-tool guidance.
10. Add unit and integration tests.

## 14. Acceptance Criteria

- All LLM stages can access `list_skill_files` and `load_skill`.
- Skill paths are file paths relative to `apps/server/config/skills`.
- No skill id registry exists.
- No stage policy exists.
- No file size limit is enforced.
- Invalid skill paths fail fast.
- Owner can use skill context to distinguish DigitalAgent-internal mission execution from external project construction.
- Runtime mission agents can also load skill context through the same pi-agent tool-calling mechanism.
- Existing tests pass, with new coverage for skill tools and pi-agent-backed LLM calls.
