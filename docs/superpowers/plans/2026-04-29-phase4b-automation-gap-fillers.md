# Phase 4B Automation Gap Fillers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fill the automation gaps after Mission activation so text-capable agents can execute tasks with LLMs, review results notify the team, follow-up tasks are orchestrated automatically, and completed Missions produce a report.

**Architecture:** Keep the current Mission lifecycle as the spine: `startExecution()` still creates a running execution, `submitExecutionResult()` still creates the Artifact and Review, and Phase 4B adds small services around that flow. `llm-executor.ts` owns prompt building and LLM output parsing, `task-orchestrator.ts` owns event-driven follow-up decisions, and `mission-report.ts` owns final completion reports. `mission-service.ts` wires these services without changing the core task state machine.

**Tech Stack:** TypeScript, Vitest, existing `@digitalagent/core` task/artifact types, existing `@digitalagent/runtime` `LlmService`, server-local in-memory persistence.

---

## File Structure

| File | Responsibility |
|------|---------------|
| `apps/server/src/system-config.ts` | Add typed `execution` and `orchestration` config sections with validation defaults. |
| `apps/server/config/agent-system.json` | Configure default executor, role executor overrides, orchestration limits, cooldown, and completion threshold. |
| `apps/server/src/llm-executor.ts` | Build execution prompts, infer artifact type, parse LLM output into artifact content/evidence. |
| `apps/server/src/llm-executor.test.ts` | Unit tests for prompt content, JSON parsing, text wrapping, artifact type inference, and malformed JSON behavior. |
| `apps/server/src/artifact-evaluation.ts` | Accept reviewable LLM executor artifacts without requiring an OpenClaw payload. |
| `apps/server/src/mission-report.ts` | Define `MissionReport`, parse completion check output, build final report from mission snapshot data. |
| `apps/server/src/mission-report.test.ts` | Unit tests for completion check parsing and report generation. |
| `apps/server/src/task-orchestrator.ts` | Event-driven orchestration for mission activation, task completion, task failure, completion checks, guardrails. |
| `apps/server/src/task-orchestrator.test.ts` | Unit tests for task planning, follow-up creation, cooldown, task limits, completion, and failure recovery. |
| `apps/server/src/mission-service.ts` | Integrate LLM executor, review bus dispatch, orchestrator lifecycle hooks, report storage, completion methods. |
| `apps/server/src/mission-service.test.ts` | Service integration tests for review bus events, LLM execution, orchestrator hooks, reports, and completion flow. |
| `apps/server/src/agent-conversation-bus.ts` | Already contains review event targeting; add explicit tests to lock the behavior. |
| `apps/server/src/agent-conversation-bus.test.ts` | Add regression tests for `review_completed` and `review_revision_needed` target selection. |
| `apps/server/src/api.ts` | Add task execute, manual completion check, and report endpoints. |
| `apps/server/src/api.test.ts` | API tests for executor routing, fallback, completion check, and report retrieval. |

---

### Task 1: Config Types And Defaults

**Files:**
- Modify: `apps/server/src/system-config.ts`
- Modify: `apps/server/config/agent-system.json`
- Test: `apps/server/src/mission-service.test.ts`

- [ ] **Step 1: Write the failing config exposure test**

Append this test near the existing config-related tests in `apps/server/src/mission-service.test.ts`:

```typescript
  it("loads execution and orchestration config defaults", () => {
    const service = new InMemoryMissionService();
    const snapshot = service.snapshot();

    expect(snapshot.missions).toEqual([]);
    expect(service.publicConfig()).toEqual({
      ui: expect.any(Object),
    });
  });
```

Run: `pnpm --filter @digitalagent/server test -- mission-service.test.ts -t "loads execution and orchestration config defaults"`

Expected: PASS before implementation because this is a smoke test for config loading. The implementation in the next step must keep this passing while adding stricter config typing.

- [ ] **Step 2: Add config interfaces**

In `apps/server/src/system-config.ts`, add these types above `AgentSystemConfig`:

```typescript
export type TaskExecutorKind = "openclaw" | "llm";

export interface ExecutionConfig {
  defaultExecutor: TaskExecutorKind;
  fallbackToLlm: boolean;
  roleExecutorOverrides: Record<string, TaskExecutorKind>;
}

export interface OrchestrationConfig {
  maxTasksPerMission: number;
  orchestrationCooldownMs: number;
  humanApprovalThreshold: number;
  completionConfidenceThreshold: number;
}
```

Then add these optional sections to `AgentSystemConfig` before `ui`:

```typescript
  execution?: ExecutionConfig;
  orchestration?: OrchestrationConfig;
```

- [ ] **Step 3: Add fast-fail validation**

Append these helpers near the bottom of `apps/server/src/system-config.ts`:

```typescript
function validateExecutor(value: unknown, field: string): void {
  if (value !== "openclaw" && value !== "llm") {
    throw new Error(`${field} must be openclaw or llm`);
  }
}

function validatePositiveNumber(value: unknown, field: string): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${field} must be a positive number`);
  }
}
```

Add this block to `validateAgentSystemConfig()` after the `agentAutonomy` checks and before the `ui` checks:

```typescript
  if (config.execution) {
    validateExecutor(config.execution.defaultExecutor, "execution.defaultExecutor");
    if (typeof config.execution.fallbackToLlm !== "boolean") {
      throw new Error("execution.fallbackToLlm must be a boolean");
    }
    for (const [role, executor] of Object.entries(config.execution.roleExecutorOverrides)) {
      if (!role.trim()) throw new Error("execution.roleExecutorOverrides contains an empty role");
      validateExecutor(executor, `execution.roleExecutorOverrides.${role}`);
    }
  }
  if (config.orchestration) {
    validatePositiveNumber(config.orchestration.maxTasksPerMission, "orchestration.maxTasksPerMission");
    validatePositiveNumber(config.orchestration.orchestrationCooldownMs, "orchestration.orchestrationCooldownMs");
    validatePositiveNumber(config.orchestration.humanApprovalThreshold, "orchestration.humanApprovalThreshold");
    validatePositiveNumber(config.orchestration.completionConfidenceThreshold, "orchestration.completionConfidenceThreshold");
    if (config.orchestration.completionConfidenceThreshold > 1) {
      throw new Error("orchestration.completionConfidenceThreshold must be <= 1");
    }
  }
```

- [ ] **Step 4: Add JSON config sections**

In `apps/server/config/agent-system.json`, insert this object after `agentAutonomy` if it exists, otherwise after `agentCollaboration`:

```json
  "execution": {
    "defaultExecutor": "openclaw",
    "fallbackToLlm": true,
    "roleExecutorOverrides": {
      "researcher": "llm",
      "content_strategist": "llm",
      "mission_operator": "llm",
      "system_architect": "llm"
    }
  },
  "orchestration": {
    "maxTasksPerMission": 50,
    "orchestrationCooldownMs": 30000,
    "humanApprovalThreshold": 10,
    "completionConfidenceThreshold": 0.8
  },
```

- [ ] **Step 5: Run config tests**

Run: `pnpm --filter @digitalagent/server test -- mission-service.test.ts -t "loads execution and orchestration config defaults"`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/system-config.ts apps/server/config/agent-system.json apps/server/src/mission-service.test.ts
git commit -m "feat: add automation execution config"
```

---

### Task 2: LLM Executor Unit

**Files:**
- Create: `apps/server/src/llm-executor.ts`
- Create: `apps/server/src/llm-executor.test.ts`

- [ ] **Step 1: Write failing LLM executor tests**

Create `apps/server/src/llm-executor.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import type { TaskContract } from "@digitalagent/core";
import {
  buildExecutionPrompt,
  inferArtifactType,
  parseLlmOutputToArtifactContent,
} from "./llm-executor.js";

const contract: TaskContract = {
  objective: "Create a concise research summary",
  input: { topic: "DigitalAgent automation" },
  outputSchema: { summary: "string", risks: "array" },
  successCriteria: ["Summary is concrete", "Risks are listed"],
};

describe("llm-executor", () => {
  it("builds a direct JSON execution prompt with mission context", () => {
    const prompt = buildExecutionPrompt({
      agentRole: "researcher",
      agentPurpose: "Collect facts and summarize evidence",
      taskObjective: contract.objective,
      taskInput: contract.input,
      outputSchema: contract.outputSchema,
      successCriteria: contract.successCriteria,
      missionGoal: "Close automation gaps",
      relevantContext: "Existing artifact: scheduler plan",
    });

    expect(prompt).toContain("你是 researcher");
    expect(prompt).toContain("Create a concise research summary");
    expect(prompt).toContain("\"summary\":\"string\"");
    expect(prompt).toContain("不要解释，只输出 JSON");
  });

  it("parses valid JSON output into artifact content", () => {
    expect(parseLlmOutputToArtifactContent("{\"summary\":\"done\",\"risks\":[\"none\"]}")).toEqual({
      summary: "done",
      risks: ["none"],
    });
  });

  it("wraps non-JSON output as text", () => {
    expect(parseLlmOutputToArtifactContent("plain answer")).toEqual({ text: "plain answer" });
  });

  it("extracts fenced JSON output", () => {
    expect(parseLlmOutputToArtifactContent("```json\n{\"summary\":\"done\"}\n```")).toEqual({
      summary: "done",
    });
  });

  it("infers artifact type from role", () => {
    expect(inferArtifactType("researcher")).toBe("research_report");
    expect(inferArtifactType("content_strategist")).toBe("content_draft");
    expect(inferArtifactType("data_analyst")).toBe("metric_snapshot");
    expect(inferArtifactType("mission_operator")).toBe("execution_log");
  });
});
```

Run: `pnpm --filter @digitalagent/server test -- llm-executor.test.ts`

Expected: FAIL with module not found for `./llm-executor.js`.

- [ ] **Step 2: Implement LLM executor helpers**

Create `apps/server/src/llm-executor.ts`:

```typescript
import type { ArtifactType } from "@digitalagent/core";

export interface ExecutionPromptContext {
  agentRole: string;
  agentPurpose: string;
  taskObjective: string;
  taskInput: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  successCriteria: string[];
  missionGoal: string;
  relevantContext: string;
}

export function buildExecutionPrompt(context: ExecutionPromptContext): string {
  return [
    `你是 ${context.agentRole}，${context.agentPurpose}。`,
    "",
    `任务目标：${context.taskObjective}`,
    `任务输入：${JSON.stringify(context.taskInput)}`,
    `输出格式：${JSON.stringify(context.outputSchema)}`,
    `成功标准：${context.successCriteria.join("; ")}`,
    "",
    `Mission 背景：${context.missionGoal}`,
    "",
    "相关上下文：",
    context.relevantContext || "(none)",
    "",
    "请直接输出符合输出格式的 JSON 结果。不要解释，只输出 JSON。",
  ].join("\n");
}

export function parseLlmOutputToArtifactContent(output: string): Record<string, unknown> {
  const trimmed = output.trim();
  const json = extractJsonObject(trimmed);
  if (!json) return { text: trimmed };
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { text: trimmed };
    }
    return parsed as Record<string, unknown>;
  } catch {
    return { text: trimmed };
  }
}

export function inferArtifactType(agentRole: string): ArtifactType {
  const normalized = agentRole.toLowerCase();
  if (/research|analyst/.test(normalized)) return "research_report";
  if (/content|writer|strategist|planner/.test(normalized)) return "content_draft";
  if (/metric|data/.test(normalized)) return "metric_snapshot";
  return "execution_log";
}

function extractJsonObject(content: string): string | undefined {
  const fenced = content.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/);
  const candidate = fenced?.[1]?.trim() ?? content;
  const start = candidate.indexOf("{");
  if (start === -1) return undefined;

  let depth = 0;
  let inString = false;
  let escape = false;
  for (let index = start; index < candidate.length; index += 1) {
    const char = candidate[index];
    if (escape) {
      escape = false;
      continue;
    }
    if (char === "\\" && inString) {
      escape = true;
      continue;
    }
    if (char === "\"") {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return candidate.slice(start, index + 1);
    }
  }
  return undefined;
}
```

- [ ] **Step 3: Run LLM executor tests**

Run: `pnpm --filter @digitalagent/server test -- llm-executor.test.ts`

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/llm-executor.ts apps/server/src/llm-executor.test.ts
git commit -m "feat: add llm task executor helpers"
```

---

### Task 3: Mission Service LLM Execution

**Files:**
- Modify: `apps/server/src/mission-service.ts`
- Modify: `apps/server/src/artifact-evaluation.ts`
- Modify: `apps/server/src/mission-service.test.ts`

- [ ] **Step 1: Write the failing service test for direct LLM execution**

Append to `apps/server/src/mission-service.test.ts`:

```typescript
  it("executes a running task with LLM and submits the artifact through review", async () => {
    const fake = new FakeLlmAdapter((messages) => {
      const prompt = messages.at(-1)?.content ?? "";
      expect(prompt).toContain("任务目标");
      expect(prompt).toContain("Mission 背景");
      return JSON.stringify({
        summary: "LLM produced a concrete automation plan",
        risks: ["No external data source"],
      });
    });
    const service = new InMemoryMissionService({ llm: fake });
    const mission = await service.createMission({
      goal: "Close automation gaps",
      successMetrics: ["automation plan produced"],
      constraints: ["text output only"],
    });
    service.activateMission({ missionId: mission.id });
    const task = service.snapshot().tasks[0];
    if (!task) throw new Error("missing task");
    service.startExecution({ missionId: mission.id, taskId: task.id });

    const artifact = await service.executeTaskWithLlm({ missionId: mission.id, taskId: task.id });

    const snapshot = service.snapshot();
    expect(artifact.content).toEqual(expect.objectContaining({
      summary: "LLM produced a concrete automation plan",
      risks: ["No external data source"],
      executor: "llm",
    }));
    expect(snapshot.executions[0]?.status).toBe("completed");
    expect(snapshot.reviews).toHaveLength(1);
    expect(snapshot.reviews[0]?.decision).not.toBe("reject");
    expect(snapshot.artifacts[0]?.id).toBe(artifact.id);
  });
```

Run: `pnpm --filter @digitalagent/server test -- mission-service.test.ts -t "executes a running task with LLM"`

Expected: FAIL with `executeTaskWithLlm is not a function`.

- [ ] **Step 2: Import LLM executor helpers**

In `apps/server/src/mission-service.ts`, add:

```typescript
import { buildExecutionPrompt, inferArtifactType, parseLlmOutputToArtifactContent } from "./llm-executor.js";
```

- [ ] **Step 3: Add request type**

Add near the existing request interfaces in `apps/server/src/mission-service.ts`:

```typescript
export interface ExecuteTaskWithLlmRequest {
  missionId: string;
  taskId: string;
}
```

- [ ] **Step 4: Implement `executeTaskWithLlm()`**

Add this public method after `startExecution()` in `apps/server/src/mission-service.ts`:

```typescript
  async executeTaskWithLlm(input: ExecuteTaskWithLlmRequest): Promise<Artifact> {
    if (!this.llm) {
      throw new Error("LLM is required for LLM task execution");
    }
    const mission = this.missions.get(input.missionId);
    if (!mission) {
      throw new Error(`Mission not found: ${input.missionId}`);
    }
    const task = this.tasks.get(input.taskId);
    if (!task || task.missionId !== mission.id) {
      throw new Error(`Task not found in mission: ${input.taskId}`);
    }
    if (task.status !== "running") {
      throw new Error(`Task must be running before LLM execution: ${task.id}`);
    }
    const execution = [...this.executions.values()].find(
      (candidate) => candidate.taskId === task.id && candidate.status === "running",
    );
    if (!execution) {
      throw new Error(`Running execution not found for task: ${task.id}`);
    }

    const assignee = task.assigneeAgentId ? this.agents.get(task.assigneeAgentId) : undefined;
    const worker = assignee ?? this.executionAgent(mission.id);
    const persona = this.personas.personaFor(worker);
    const context = this.contextRetriever.getRelevantContext({
      missionId: mission.id,
      agentId: worker.id,
      currentTopic: task.title,
    });
    const relevantContext = context.map((snippet) => `- ${snippet.source}: ${snippet.summary}`).join("\n");
    const prompt = buildExecutionPrompt({
      agentRole: worker.role,
      agentPurpose: worker.responsibility,
      taskObjective: task.contract.objective,
      taskInput: task.contract.input,
      outputSchema: task.contract.outputSchema,
      successCriteria: task.contract.successCriteria,
      missionGoal: mission.goal,
      relevantContext,
    });

    const result = await this.llm.call([
      { role: "system", content: persona.systemPrompt },
      { role: "user", content: prompt },
    ], { temperature: 0.2 });
    const content = parseLlmOutputToArtifactContent(result.content);
    const submitted = this.submitExecutionResult({
      executionId: execution.id,
      missionId: mission.id,
      taskId: task.id,
      content: {
        ...content,
        executor: "llm",
      },
      evidence: [`llm:${result.model}`],
    });
    return submitted.artifact;
  }
```

- [ ] **Step 5: Accept LLM artifacts in quality evaluation**

In `apps/server/src/artifact-evaluation.ts`, replace the initial OpenClaw-only extraction block:

```typescript
  const openclaw = content.openclaw as Record<string, unknown> | undefined;
  if (!openclaw) {
    return { score: 0.1, decision: "reject", comments: ["Artifact has no OpenClaw output"] };
  }

  const payloads = openclaw.payloads as Array<Record<string, unknown>> | undefined;
  const agentText = payloads?.[0]?.text as string | undefined;
```

with:

```typescript
  const openclaw = content.openclaw as Record<string, unknown> | undefined;
  const isLlmArtifact = content.executor === "llm";
  const payloads = openclaw?.payloads as Array<Record<string, unknown>> | undefined;
  const agentText = payloads?.[0]?.text as string | undefined;
  const llmText = isLlmArtifact ? JSON.stringify(withoutExecutor(content)) : undefined;
  const reviewText = agentText ?? llmText;

  if (!openclaw && !isLlmArtifact) {
    return { score: 0.1, decision: "reject", comments: ["Artifact has no executable output"] };
  }
```

Then replace every later `agentText` read with `reviewText`. Add this helper at the bottom of the file:

```typescript
function withoutExecutor(content: Record<string, unknown>): Record<string, unknown> {
  const { executor: _executor, ...rest } = content;
  return rest;
}
```

The empty output check should become:

```typescript
  if (!reviewText || reviewText.trim().length < 20) {
    return { score: 0.1, decision: "reject", comments: ["Agent output is empty or too short"] };
  }
```

- [ ] **Step 6: Run the direct LLM execution test**

Run: `pnpm --filter @digitalagent/server test -- mission-service.test.ts -t "executes a running task with LLM"`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/mission-service.ts apps/server/src/artifact-evaluation.ts apps/server/src/mission-service.test.ts
git commit -m "feat: execute mission tasks with llm"
```

---

### Task 4: Artifact Type Hint And Review Bus Dispatch

**Files:**
- Modify: `apps/server/src/mission-service.ts`
- Modify: `apps/server/src/mission-service.test.ts`
- Modify: `apps/server/src/agent-conversation-bus.test.ts`

- [ ] **Step 1: Write the failing artifact type test**

Append to `apps/server/src/mission-service.test.ts`:

```typescript
  it("uses LLM executor artifact type hints instead of execution_log", async () => {
    const fake = new FakeLlmAdapter(() => JSON.stringify({ summary: "research report" }));
    const service = new InMemoryMissionService({ llm: fake });
    const mission = await service.createMission({
      goal: "Research automation",
      successMetrics: ["research report"],
      constraints: [],
    });
    service.activateMission({ missionId: mission.id });
    const task = service.snapshot().tasks[0];
    if (!task) throw new Error("missing task");
    service.startExecution({ missionId: mission.id, taskId: task.id });

    const artifact = await service.executeTaskWithLlm({ missionId: mission.id, taskId: task.id });

    expect(artifact.type).toBe("research_report");
  });
```

Run: `pnpm --filter @digitalagent/server test -- mission-service.test.ts -t "uses LLM executor artifact type hints"`

Expected: FAIL because `submitExecutionResult()` currently always creates `execution_log`.

- [ ] **Step 2: Allow an optional artifact type hint**

In `apps/server/src/mission-service.ts`, change `SubmitExecutionResultRequest` to:

```typescript
export interface SubmitExecutionResultRequest {
  executionId: string;
  missionId: string;
  taskId: string;
  content: Record<string, unknown>;
  evidence: string[];
  artifactType?: Artifact["type"];
}
```

In `executeTaskWithLlm()`, change the submit call content and add `artifactType`:

```typescript
    const artifactType = inferArtifactType(worker.role);
    const submitted = this.submitExecutionResult({
      executionId: execution.id,
      missionId: mission.id,
      taskId: task.id,
      content: {
        ...content,
        executor: "llm",
      },
      evidence: [`llm:${result.model}`],
      artifactType,
    });
```

In `submitExecutionResult()`, change artifact creation to:

```typescript
    const artifact = createArtifact({
      taskId: runningTask.id,
      type: input.artifactType ?? "execution_log",
      content: input.content,
      evidence: input.evidence,
      qualityScore: qualityResult.score,
    });
```

- [ ] **Step 3: Write the failing review bus dispatch test**

Append to `apps/server/src/mission-service.test.ts`:

```typescript
  it("dispatches review completion events to the conversation bus", async () => {
    let callCount = 0;
    const fake = new FakeLlmAdapter(() => {
      callCount += 1;
      return JSON.stringify({
        message: callCount === 1 ? "Review result acknowledged by owner" : "Worker acknowledged revision state",
        type: "agent_report",
        mentionedAgentIds: [],
        shouldPropagate: false,
        action: { type: "acknowledge" },
      });
    });
    const service = new InMemoryMissionService({ llm: fake });
    const mission = await service.createMission({
      goal: "Grow Xiaohongshu account",
      successMetrics: ["daily review generated"],
      constraints: [],
    });
    service.activateMission({ missionId: mission.id });
    const task = service.snapshot().tasks[0];
    if (!task) throw new Error("missing task");
    const execution = service.startExecution({ missionId: mission.id, taskId: task.id });

    service.submitExecutionResult({
      executionId: execution.id,
      missionId: mission.id,
      taskId: task.id,
      content: { openclaw: { payloads: [{ text: "daily review generated successfully" }] } },
      evidence: ["openclaw:local"],
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(service.snapshot().agentMessages.some((message) =>
      message.type === "agent_report" && message.content.includes("Review result acknowledged"),
    )).toBe(true);
  });
```

Run: `pnpm --filter @digitalagent/server test -- mission-service.test.ts -t "dispatches review completion events"`

Expected: FAIL because only `execution_completed` is dispatched.

- [ ] **Step 4: Dispatch review events after review completion**

In `submitExecutionResult()`, immediately after the existing `void this.dispatchToBus({ type: "execution_completed", ... })` call, add:

```typescript
    const reviewEvent: BusEvent = review.decision === "revise"
      ? {
          type: "review_revision_needed",
          agentId: worker.id,
          taskId: task.id,
          comments: review.comments,
        }
      : {
          type: "review_completed",
          agentId: worker.id,
          taskId: task.id,
          decision: review.decision,
        };
    void this.dispatchToBus(reviewEvent, mission.id);
```

- [ ] **Step 5: Add explicit bus relevance regression tests**

Append to the `describe("multi-round discussion", ...)` block in `apps/server/src/agent-conversation-bus.test.ts`:

```typescript
  it("targets owner and worker for review_completed events", async () => {
    const { bus, threads } = makeBusDeps();
    await bus.dispatchEvent({
      missionId: "m1",
      event: {
        type: "review_completed",
        agentId: "analyst",
        taskId: "task_1",
        decision: "approve",
      },
    });

    expect(threads[0]?.participantAgentIds).toEqual(expect.arrayContaining(["owner", "analyst"]));
  });

  it("targets planner and worker for review_revision_needed events", async () => {
    const { bus, threads } = makeBusDeps();
    await bus.dispatchEvent({
      missionId: "m1",
      event: {
        type: "review_revision_needed",
        agentId: "analyst",
        taskId: "task_1",
        comments: ["Needs evidence"],
      },
    });

    expect(threads[0]?.participantAgentIds).toEqual(expect.arrayContaining(["planner", "analyst"]));
  });
```

- [ ] **Step 6: Run review bus tests**

Run: `pnpm --filter @digitalagent/server test -- mission-service.test.ts -t "artifact type hints|review completion events"`

Expected: PASS.

Run: `pnpm --filter @digitalagent/server test -- agent-conversation-bus.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/mission-service.ts apps/server/src/mission-service.test.ts apps/server/src/agent-conversation-bus.test.ts
git commit -m "feat: dispatch review events to agent bus"
```

---

### Task 5: Mission Report And Completion Check

**Files:**
- Create: `apps/server/src/mission-report.ts`
- Create: `apps/server/src/mission-report.test.ts`

- [ ] **Step 1: Write failing mission report tests**

Create `apps/server/src/mission-report.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import type { Artifact, Mission, Review, Task } from "@digitalagent/core";
import { buildMissionReport, parseCompletionCheck } from "./mission-report.js";
import type { AgentMessage } from "./mission-service.js";

const mission: Mission = {
  id: "mission_1",
  goal: "Close automation gaps",
  successMetrics: ["LLM execution works", "Mission completes"],
  constraints: [],
  status: "active",
  budget: { maxRuntimeMinutes: 60 },
  createdAt: new Date("2026-04-29T00:00:00.000Z"),
  scheduleRules: [],
};

const tasks: Task[] = [
  {
    id: "task_1",
    missionId: "mission_1",
    title: "Implement executor",
    status: "completed",
    dependencies: [],
    contract: {
      objective: "Implement LLM executor",
      input: {},
      outputSchema: {},
      successCriteria: ["Executor exists"],
    },
    approvalRequired: false,
    artifactId: "artifact_1",
  },
];

const artifacts: Artifact[] = [
  {
    id: "artifact_1",
    taskId: "task_1",
    type: "research_report",
    content: { summary: "Executor complete" },
    evidence: ["llm:fake"],
    qualityScore: 1,
    createdAt: new Date("2026-04-29T00:10:00.000Z"),
  },
];

const reviews: Review[] = [
  {
    id: "review_1",
    artifactId: "artifact_1",
    reviewerAgentId: "agent_reviewer",
    decision: "approve",
    comments: ["Approved"],
    createdAt: new Date("2026-04-29T00:11:00.000Z"),
  },
];

describe("mission-report", () => {
  it("parses valid completion check JSON", () => {
    expect(parseCompletionCheck(JSON.stringify({
      completed: true,
      achievementSummary: "All metrics achieved",
      confidence: 0.91,
      remainingWork: "",
    }))).toEqual({
      completed: true,
      achievementSummary: "All metrics achieved",
      confidence: 0.91,
      remainingWork: "",
    });
  });

  it("fails fast on invalid completion JSON", () => {
    expect(() => parseCompletionCheck("not json")).toThrow("Completion check returned invalid JSON");
  });

  it("builds a final mission report from snapshot data", () => {
    const report = buildMissionReport({
      mission,
      tasks,
      artifacts,
      reviews,
      messages: [{
        id: "message_1",
        missionId: "mission_1",
        fromAgentId: "agent_owner",
        type: "agent_report",
        content: "Decision: use LLM executor for text work",
        createdAt: "2026-04-29T00:05:00.000Z",
      } as AgentMessage],
      completion: {
        completed: true,
        achievementSummary: "All metrics achieved",
        confidence: 0.9,
        remainingWork: "",
      },
      achievedAt: new Date("2026-04-29T00:12:00.000Z"),
    });

    expect(report.missionId).toBe("mission_1");
    expect(report.totalTasks).toBe(1);
    expect(report.completedTasks).toBe(1);
    expect(report.failedTasks).toBe(0);
    expect(report.metricsAssessment).toHaveLength(2);
    expect(report.keyDecisions).toContain("Decision: use LLM executor for text work");
  });
});
```

Run: `pnpm --filter @digitalagent/server test -- mission-report.test.ts`

Expected: FAIL with module not found.

- [ ] **Step 2: Implement mission report module**

Create `apps/server/src/mission-report.ts`:

```typescript
import type { Artifact, Mission, Review, Task } from "@digitalagent/core";
import type { AgentMessage } from "./mission-service.js";

export interface CompletionCheckResult {
  completed: boolean;
  achievementSummary: string;
  confidence: number;
  remainingWork: string;
}

export interface MissionReport {
  missionId: string;
  goal: string;
  achievedAt: string;
  duration: string;
  totalTasks: number;
  completedTasks: number;
  failedTasks: number;
  achievementSummary: string;
  metricsAssessment: Array<{
    metric: string;
    achieved: boolean;
    evidence: string;
  }>;
  budgetUsed: number;
  keyDecisions: string[];
  lessonsLearned: string[];
}

export function parseCompletionCheck(content: string): CompletionCheckResult {
  try {
    const parsed = JSON.parse(content) as Partial<CompletionCheckResult>;
    if (typeof parsed.completed !== "boolean") throw new Error("completed is required");
    if (typeof parsed.achievementSummary !== "string") throw new Error("achievementSummary is required");
    if (typeof parsed.confidence !== "number" || parsed.confidence < 0 || parsed.confidence > 1) {
      throw new Error("confidence must be between 0 and 1");
    }
    if (typeof parsed.remainingWork !== "string") throw new Error("remainingWork is required");
    return {
      completed: parsed.completed,
      achievementSummary: parsed.achievementSummary,
      confidence: parsed.confidence,
      remainingWork: parsed.remainingWork,
    };
  } catch (error) {
    throw new Error(`Completion check returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function buildMissionReport(input: {
  mission: Mission;
  tasks: Task[];
  artifacts: Artifact[];
  reviews: Review[];
  messages: AgentMessage[];
  completion: CompletionCheckResult;
  achievedAt: Date;
}): MissionReport {
  const completedTasks = input.tasks.filter((task) => task.status === "completed");
  const failedTasks = input.tasks.filter((task) => task.status === "failed");
  const artifactText = input.artifacts
    .map((artifact) => JSON.stringify(artifact.content))
    .join("\n");
  return {
    missionId: input.mission.id,
    goal: input.mission.goal,
    achievedAt: input.achievedAt.toISOString(),
    duration: durationText(input.mission.createdAt, input.achievedAt),
    totalTasks: input.tasks.length,
    completedTasks: completedTasks.length,
    failedTasks: failedTasks.length,
    achievementSummary: input.completion.achievementSummary,
    metricsAssessment: input.mission.successMetrics.map((metric) => ({
      metric,
      achieved: input.completion.completed,
      evidence: artifactText.includes(metric) ? metric : input.completion.achievementSummary,
    })),
    budgetUsed: input.tasks.length,
    keyDecisions: input.messages
      .filter((message) => /decision|决定|选择|use /i.test(message.content))
      .map((message) => message.content),
    lessonsLearned: input.reviews.flatMap((review) => review.comments).slice(0, 10),
  };
}

function durationText(start: Date, end: Date): string {
  const seconds = Math.max(0, Math.round((end.getTime() - start.getTime()) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds}s`;
}
```

- [ ] **Step 3: Run mission report tests**

Run: `pnpm --filter @digitalagent/server test -- mission-report.test.ts`

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/mission-report.ts apps/server/src/mission-report.test.ts
git commit -m "feat: generate mission completion reports"
```

---

### Task 6: Task Orchestrator Unit

**Files:**
- Create: `apps/server/src/task-orchestrator.ts`
- Create: `apps/server/src/task-orchestrator.test.ts`

- [ ] **Step 1: Write failing task orchestrator tests**

Create `apps/server/src/task-orchestrator.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { FakeLlmAdapter } from "@digitalagent/runtime";
import { TaskOrchestrator } from "./task-orchestrator.js";

function makeDeps(llmText: string, now = new Date("2026-04-29T00:00:00.000Z")) {
  const calls: string[] = [];
  const createdTasks: Array<{ title: string; assigneeRole: string; executor: "llm" | "openclaw" }> = [];
  const ownerNotifications: string[] = [];
  const completions: string[] = [];
  const llm = new FakeLlmAdapter((messages) => {
    calls.push(messages.at(-1)?.content ?? "");
    return llmText;
  });
  const deps = {
    llm,
    clock: () => now,
    config: {
      maxTasksPerMission: 50,
      orchestrationCooldownMs: 30_000,
      humanApprovalThreshold: 10,
      completionConfidenceThreshold: 0.8,
    },
    getMissionState: () => ({
      mission: {
        id: "mission_1",
        goal: "Close automation gaps",
        successMetrics: ["LLM execution works"],
        constraints: [],
        status: "active",
        budget: { maxRuntimeMinutes: 60 },
        createdAt: now,
        scheduleRules: [],
      },
      agents: [
        { id: "agent_owner", role: "owner", name: "Owner", responsibility: "Own mission" },
        { id: "agent_researcher", role: "researcher", name: "Researcher", responsibility: "Research" },
      ],
      tasks: [],
      artifacts: [],
      messages: [],
    }),
    createTask: (input) => {
      createdTasks.push(input);
      return `task_${createdTasks.length}`;
    },
    startTaskExecution: async () => undefined,
    completeMission: async (missionId) => { completions.push(missionId); },
    notifyOwner: (_missionId, message) => { ownerNotifications.push(message); },
  };
  return { deps, calls, createdTasks, ownerNotifications, completions };
}

describe("TaskOrchestrator", () => {
  it("creates initial LLM tasks on mission activation", async () => {
    const { deps, createdTasks } = makeDeps(JSON.stringify({
      tasks: [{
        title: "Research automation gaps",
        objective: "Summarize missing automation pieces",
        assigneeRole: "researcher",
        dependencies: [],
        priority: "normal",
        executor: "llm",
      }],
    }));
    const orchestrator = new TaskOrchestrator(deps);

    await orchestrator.onMissionActivated("mission_1");

    expect(createdTasks).toEqual([{
      title: "Research automation gaps",
      objective: "Summarize missing automation pieces",
      assigneeRole: "researcher",
      executor: "llm",
    }]);
  });

  it("creates follow-up tasks after completion", async () => {
    const { deps, createdTasks } = makeDeps(JSON.stringify({
      actions: [{
        type: "create_task",
        title: "Draft final report",
        objective: "Create the final report",
        assigneeRole: "researcher",
        priority: "normal",
        executor: "llm",
      }],
      missionProgress: 0.5,
      assessment: "Halfway complete",
    }));
    const orchestrator = new TaskOrchestrator(deps);

    await orchestrator.onTaskCompleted({
      missionId: "mission_1",
      taskId: "task_1",
      artifactId: "artifact_1",
    });

    expect(createdTasks[0]?.title).toBe("Draft final report");
  });

  it("does not orchestrate twice inside cooldown", async () => {
    const { deps, createdTasks } = makeDeps(JSON.stringify({
      actions: [{
        type: "create_task",
        title: "Follow up",
        objective: "Follow up",
        assigneeRole: "researcher",
        priority: "normal",
        executor: "llm",
      }],
      missionProgress: 0.5,
      assessment: "Continue",
    }));
    const orchestrator = new TaskOrchestrator(deps);

    await orchestrator.onTaskCompleted({ missionId: "mission_1", taskId: "task_1", artifactId: "artifact_1" });
    await orchestrator.onTaskCompleted({ missionId: "mission_1", taskId: "task_2", artifactId: "artifact_2" });

    expect(createdTasks).toHaveLength(1);
  });

  it("runs completion check when progress is high", async () => {
    let call = 0;
    const llm = new FakeLlmAdapter(() => {
      call += 1;
      if (call === 1) {
        return JSON.stringify({ actions: [], missionProgress: 0.95, assessment: "Nearly done" });
      }
      return JSON.stringify({
        completed: true,
        achievementSummary: "All metrics achieved",
        confidence: 0.9,
        remainingWork: "",
      });
    });
    const completions: string[] = [];
    const { deps } = makeDeps("{}", new Date("2026-04-29T00:00:00.000Z"));
    const orchestrator = new TaskOrchestrator({
      ...deps,
      llm,
      completeMission: async (missionId) => { completions.push(missionId); },
    });

    await orchestrator.onTaskCompleted({ missionId: "mission_1", taskId: "task_1", artifactId: "artifact_1" });

    expect(completions).toEqual(["mission_1"]);
  });
});
```

Run: `pnpm --filter @digitalagent/server test -- task-orchestrator.test.ts`

Expected: FAIL with module not found.

- [ ] **Step 2: Implement orchestrator types and prompts**

Create `apps/server/src/task-orchestrator.ts`:

```typescript
import type { Artifact, Mission, Task } from "@digitalagent/core";
import type { LlmService } from "@digitalagent/runtime";
import type { OrchestrationConfig } from "./system-config.js";
import { parseCompletionCheck, type MissionReport } from "./mission-report.js";
import type { AgentMessage, WarRoomAgent } from "./mission-service.js";

export interface OrchestratorMissionState {
  mission: Mission;
  agents: Array<Pick<WarRoomAgent, "id" | "role" | "name" | "responsibility">>;
  tasks: Task[];
  artifacts: Artifact[];
  messages: AgentMessage[];
}

export interface OrchestratorDeps {
  llm: LlmService;
  clock: () => Date;
  config: OrchestrationConfig;
  getMissionState: (missionId: string) => OrchestratorMissionState;
  createTask: (input: {
    missionId: string;
    title: string;
    objective: string;
    assigneeRole: string;
    executor: "llm" | "openclaw";
  }) => string;
  startTaskExecution: (input: {
    missionId: string;
    taskId: string;
    executor: "llm" | "openclaw";
  }) => Promise<void>;
  completeMission: (missionId: string, completion: ReturnType<typeof parseCompletionCheck>) => Promise<MissionReport | undefined>;
  notifyOwner: (missionId: string, message: string) => void;
}

interface PlannedTask {
  title: string;
  objective: string;
  assigneeRole: string;
  dependencies?: string[];
  priority?: "low" | "normal" | "high";
  executor?: "llm" | "openclaw";
}

interface OrchestrationDecision {
  actions: Array<{
    type: "create_task";
    title: string;
    objective: string;
    assigneeRole: string;
    priority: "low" | "normal" | "high";
    executor: "llm" | "openclaw";
  }>;
  missionProgress: number;
  assessment: string;
}

export class TaskOrchestrator {
  private readonly lastRunByMission = new Map<string, number>();

  constructor(private readonly deps: OrchestratorDeps) {}

  async onMissionActivated(missionId: string): Promise<void> {
    const state = this.deps.getMissionState(missionId);
    this.ensureTaskBudget(state);
    const response = await this.deps.llm.call([
      { role: "system", content: "Plan first executable Mission tasks. Return JSON only." },
      { role: "user", content: buildActivationPrompt(state) },
    ], { temperature: 0.2 });
    const parsed = JSON.parse(response.content) as { tasks: PlannedTask[] };
    for (const task of parsed.tasks) {
      await this.createAndStart(missionId, task);
    }
  }

  async onTaskCompleted(input: { missionId: string; taskId: string; artifactId: string }): Promise<void> {
    if (!this.claimCooldown(input.missionId)) return;
    const state = this.deps.getMissionState(input.missionId);
    this.ensureTaskBudget(state);
    const response = await this.deps.llm.call([
      { role: "system", content: "You are a task orchestrator. Return JSON only." },
      { role: "user", content: buildOrchestrationPrompt(state) },
    ], { temperature: 0.2 });
    const decision = parseOrchestrationDecision(response.content);
    if (decision.missionProgress >= 0.9) {
      const completed = await this.completionCheck(input.missionId);
      if (completed) return;
    }
    for (const action of decision.actions) {
      await this.createAndStart(input.missionId, action);
    }
  }

  async onTaskFailed(input: { missionId: string; taskId: string; failureReason: string }): Promise<void> {
    if (!this.claimCooldown(input.missionId)) return;
    this.deps.notifyOwner(input.missionId, `Task ${input.taskId} failed: ${input.failureReason}`);
  }

  async completionCheck(missionId: string): Promise<boolean> {
    const state = this.deps.getMissionState(missionId);
    const response = await this.deps.llm.call([
      { role: "system", content: "You are a Mission completion evaluator. Return JSON only." },
      { role: "user", content: buildCompletionPrompt(state) },
    ], { temperature: 0.1 });
    const completion = parseCompletionCheck(response.content);
    if (completion.completed && completion.confidence >= this.deps.config.completionConfidenceThreshold) {
      await this.deps.completeMission(missionId, completion);
      return true;
    }
    return false;
  }

  private async createAndStart(missionId: string, task: PlannedTask): Promise<void> {
    const taskId = this.deps.createTask({
      missionId,
      title: task.title,
      objective: task.objective,
      assigneeRole: task.assigneeRole,
      executor: task.executor ?? "llm",
    });
    await this.deps.startTaskExecution({
      missionId,
      taskId,
      executor: task.executor ?? "llm",
    });
  }

  private claimCooldown(missionId: string): boolean {
    const now = this.deps.clock().getTime();
    const previous = this.lastRunByMission.get(missionId);
    if (previous !== undefined && now - previous < this.deps.config.orchestrationCooldownMs) {
      return false;
    }
    this.lastRunByMission.set(missionId, now);
    return true;
  }

  private ensureTaskBudget(state: OrchestratorMissionState): void {
    if (state.tasks.length >= this.deps.config.maxTasksPerMission) {
      this.deps.notifyOwner(state.mission.id, `Mission reached task limit: ${this.deps.config.maxTasksPerMission}`);
      throw new Error(`Mission reached task limit: ${state.mission.id}`);
    }
  }
}

function parseOrchestrationDecision(content: string): OrchestrationDecision {
  const parsed = JSON.parse(content) as OrchestrationDecision;
  if (!Array.isArray(parsed.actions)) throw new Error("orchestration actions must be an array");
  if (typeof parsed.missionProgress !== "number") throw new Error("missionProgress must be a number");
  if (typeof parsed.assessment !== "string") throw new Error("assessment must be a string");
  return parsed;
}

function buildActivationPrompt(state: OrchestratorMissionState): string {
  return [
    `Mission goal: ${state.mission.goal}`,
    `Success metrics: ${state.mission.successMetrics.join("; ")}`,
    `Team roles: ${state.agents.map((agent) => `${agent.role}: ${agent.responsibility}`).join("; ")}`,
    "Return JSON: {\"tasks\":[{\"title\":\"...\",\"objective\":\"...\",\"assigneeRole\":\"...\",\"dependencies\":[],\"priority\":\"normal\",\"executor\":\"llm\"}]}",
  ].join("\n");
}

function buildOrchestrationPrompt(state: OrchestratorMissionState): string {
  return [
    `Mission goal: ${state.mission.goal}`,
    `Success metrics: ${state.mission.successMetrics.join("; ")}`,
    `Completed tasks: ${state.tasks.filter((task) => task.status === "completed").map((task) => task.title).join("; ")}`,
    `In progress tasks: ${state.tasks.filter((task) => task.status === "running").map((task) => task.title).join("; ")}`,
    `Failed tasks: ${state.tasks.filter((task) => task.status === "failed").map((task) => `${task.title}: ${task.failureReason ?? ""}`).join("; ")}`,
    `Recent messages: ${state.messages.slice(-10).map((message) => message.content).join("\n")}`,
    "Return JSON: {\"actions\":[{\"type\":\"create_task\",\"title\":\"...\",\"objective\":\"...\",\"assigneeRole\":\"...\",\"priority\":\"normal\",\"executor\":\"llm\"}],\"missionProgress\":0.0,\"assessment\":\"...\"}",
  ].join("\n");
}

function buildCompletionPrompt(state: OrchestratorMissionState): string {
  return [
    `Mission goal: ${state.mission.goal}`,
    `Success metrics: ${state.mission.successMetrics.join("; ")}`,
    `Task history: ${state.tasks.map((task) => `${task.title}: ${task.status}`).join("; ")}`,
    `Artifacts: ${state.artifacts.map((artifact) => JSON.stringify(artifact.content)).join("\n")}`,
    `Discussion: ${state.messages.slice(-20).map((message) => message.content).join("\n")}`,
    "Return JSON: {\"completed\":true,\"achievementSummary\":\"...\",\"confidence\":0.0,\"remainingWork\":\"...\"}",
  ].join("\n");
}
```

- [ ] **Step 3: Run orchestrator tests**

Run: `pnpm --filter @digitalagent/server test -- task-orchestrator.test.ts`

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/task-orchestrator.ts apps/server/src/task-orchestrator.test.ts
git commit -m "feat: add task orchestrator"
```

---

### Task 7: Mission Service Orchestrator And Completion Integration

**Files:**
- Modify: `apps/server/src/mission-service.ts`
- Modify: `apps/server/src/mission-service.test.ts`

- [ ] **Step 1: Write failing integration tests**

Append to `apps/server/src/mission-service.test.ts`:

```typescript
  it("stores a mission report when completion check succeeds", async () => {
    let call = 0;
    const fake = new FakeLlmAdapter(() => {
      call += 1;
      if (call === 1) {
        return JSON.stringify({ actions: [], missionProgress: 0.95, assessment: "Ready for completion" });
      }
      return JSON.stringify({
        completed: true,
        achievementSummary: "Automation gaps are closed",
        confidence: 0.9,
        remainingWork: "",
      });
    });
    const service = new InMemoryMissionService({ llm: fake });
    const mission = await service.createMission({
      goal: "Close automation gaps",
      successMetrics: ["Automation gaps are closed"],
      constraints: [],
    });
    service.activateMission({ missionId: mission.id });
    const task = service.snapshot().tasks[0];
    if (!task) throw new Error("missing task");
    const execution = service.startExecution({ missionId: mission.id, taskId: task.id });

    service.submitExecutionResult({
      executionId: execution.id,
      missionId: mission.id,
      taskId: task.id,
      content: { openclaw: { payloads: [{ text: "Automation gaps are closed" }] } },
      evidence: ["openclaw:local"],
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(service.snapshot().missions[0]?.status).toBe("completed");
    expect(service.getMissionReport(mission.id)?.achievementSummary).toBe("Automation gaps are closed");
  });

  it("does not start orchestrator when no LLM is configured", async () => {
    const service = new InMemoryMissionService();
    const mission = await service.createMission({ goal: "Plain mission" });
    service.activateMission({ missionId: mission.id });
    const taskCount = service.snapshot().tasks.length;
    const task = service.snapshot().tasks[0];
    if (!task) throw new Error("missing task");
    const execution = service.startExecution({ missionId: mission.id, taskId: task.id });

    service.submitExecutionResult({
      executionId: execution.id,
      missionId: mission.id,
      taskId: task.id,
      content: { openclaw: { payloads: [{ text: "Plain mission result" }] } },
      evidence: ["openclaw:local"],
    });

    expect(service.snapshot().tasks).toHaveLength(taskCount);
  });
```

Run: `pnpm --filter @digitalagent/server test -- mission-service.test.ts -t "mission report|orchestrator"`

Expected: FAIL because `getMissionReport()` and orchestrator integration do not exist.

- [ ] **Step 2: Add report storage to snapshot persistence**

In `apps/server/src/mission-service.ts`, import:

```typescript
import { buildMissionReport, type CompletionCheckResult, type MissionReport } from "./mission-report.js";
import { TaskOrchestrator } from "./task-orchestrator.js";
```

Add a map next to the other private maps:

```typescript
  private readonly missionReports = new Map<string, MissionReport>();
  private taskOrchestrator: TaskOrchestrator | undefined;
```

Add `missionReports` to `MissionSnapshot`:

```typescript
  missionReports: MissionReport[];
```

Add it to `snapshot()`:

```typescript
      missionReports: [...this.missionReports.values()],
```

Update test snapshot literals that are typed as `MissionSnapshot` by adding `missionReports: []`:

```typescript
  missionReports: [],
```

The current typed literals are in:

```text
apps/server/src/agent-conversation-bus.test.ts
apps/server/src/agent-autonomy.test.ts
```

Add `missionReports` to `StoredMissionSnapshot` load/save handling in the existing persistence functions. When reading old snapshots, use:

```typescript
      missionReports: (snapshot as StoredMissionSnapshot & { missionReports?: MissionReport[] }).missionReports ?? [],
```

and restore with:

```typescript
    for (const report of snapshot.missionReports) {
      this.missionReports.set(report.missionId, report);
    }
```

- [ ] **Step 3: Add completion/report public methods**

Add these public methods near the schedule public methods:

```typescript
  async checkMissionCompletion(missionId: string): Promise<boolean> {
    if (!this.llm) {
      throw new Error("LLM is required for mission completion checks");
    }
    return this.getTaskOrchestrator().completionCheck(missionId);
  }

  getMissionReport(missionId: string): MissionReport | undefined {
    return this.missionReports.get(missionId);
  }

  private async completeMissionFromCheck(missionId: string, completion: CompletionCheckResult): Promise<MissionReport> {
    const mission = this.missions.get(missionId);
    if (!mission) throw new Error(`Mission not found: ${missionId}`);
    const achievedAt = new Date();
    const completed: Mission = { ...mission, status: "completed" };
    this.missions.set(missionId, completed);
    this.schedulers.get(missionId)?.stop();
    this.autonomyService?.stopLoop(missionId);
    const report = buildMissionReport({
      mission: completed,
      tasks: [...this.tasks.values()].filter((task) => task.missionId === missionId),
      artifacts: [...this.artifacts.values()].filter((artifact) => {
        const task = this.tasks.get(artifact.taskId);
        return task?.missionId === missionId;
      }),
      reviews: [...this.reviews.values()],
      messages: this.agentMessagesForMission(missionId),
      completion,
      achievedAt,
    });
    this.missionReports.set(missionId, report);
    this.appendMessage({
      missionId,
      fromAgentId: "system",
      type: "agent_report",
      content: `Mission completed: ${completion.achievementSummary}`,
    });
    await this.dispatchToBus({
      type: "agent_notify",
      fromAgentId: "system",
      content: `Mission completed: ${completion.achievementSummary}`,
      mentionedAgentIds: this.agentsForMission(missionId).map((agent) => agent.id),
    }, missionId);
    this.persist();
    return report;
  }
```

`AgentAutonomyService` already exposes `stopLoop(missionId)`, so use that existing method.

- [ ] **Step 4: Add task creation and execution helpers for orchestrator**

Add this private method to `mission-service.ts`:

```typescript
  private getTaskOrchestrator(): TaskOrchestrator {
    if (!this.llm) {
      throw new Error("LLM is required for task orchestration");
    }
    if (!this.taskOrchestrator) {
      this.taskOrchestrator = new TaskOrchestrator({
        llm: this.llm,
        clock: InMemoryMissionService.realClock,
        config: {
          maxTasksPerMission: this.config.orchestration?.maxTasksPerMission ?? 50,
          orchestrationCooldownMs: this.config.orchestration?.orchestrationCooldownMs ?? 30_000,
          humanApprovalThreshold: this.config.orchestration?.humanApprovalThreshold ?? 10,
          completionConfidenceThreshold: this.config.orchestration?.completionConfidenceThreshold ?? 0.8,
        },
        getMissionState: (missionId) => ({
          mission: this.missions.get(missionId)!,
          agents: this.agentsForMission(missionId),
          tasks: [...this.tasks.values()].filter((task) => task.missionId === missionId),
          artifacts: [...this.artifacts.values()].filter((artifact) => this.tasks.get(artifact.taskId)?.missionId === missionId),
          messages: this.agentMessagesForMission(missionId),
        }),
        createTask: (input) => this.createOrchestratedTask(input),
        startTaskExecution: async (input) => {
          this.startExecution({ missionId: input.missionId, taskId: input.taskId });
          if (input.executor === "llm") {
            await this.executeTaskWithLlm({ missionId: input.missionId, taskId: input.taskId });
          }
        },
        completeMission: async (missionId, completion) => this.completeMissionFromCheck(missionId, completion),
        notifyOwner: (missionId, message) => this.notifyOwner(missionId, message),
      });
    }
    return this.taskOrchestrator;
  }

  private createOrchestratedTask(input: {
    missionId: string;
    title: string;
    objective: string;
    assigneeRole: string;
  }): string {
    const mission = this.missions.get(input.missionId);
    if (!mission) throw new Error(`Mission not found: ${input.missionId}`);
    const agent = this.agentsForMission(input.missionId).find((candidate) => candidate.role === input.assigneeRole);
    if (!agent) {
      this.notifyOwner(input.missionId, `Orchestrator skipped task "${input.title}": no agent for role "${input.assigneeRole}"`);
      throw new Error(`No agent found for role: ${input.assigneeRole}`);
    }
    const task = createTask({
      missionId: input.missionId,
      title: input.title,
      dependencies: [],
      contract: {
        objective: input.objective,
        input: { missionGoal: mission.goal },
        outputSchema: { result: "object" },
        successCriteria: mission.successMetrics.length ? mission.successMetrics : ["Task produces a reviewable result"],
      },
      approvalRequired: false,
    });
    const assigned = { ...task, assigneeAgentId: agent.id };
    this.tasks.set(assigned.id, assigned);
    this.appendMessage({
      missionId: input.missionId,
      fromAgentId: "system",
      toAgentId: agent.id,
      type: "task_plan",
      content: `Orchestrator assigned task "${input.title}" to ${agent.name}.`,
    });
    this.persist();
    return assigned.id;
  }
```

Add helper methods if they are not already present:

```typescript
  private agentsForMission(missionId: string): WarRoomAgent[] {
    return [...this.agents.values()].filter((agent) => agent.missionId === missionId);
  }

  private notifyOwner(missionId: string, message: string): void {
    const owner = this.agentsForMission(missionId).find((agent) => agent.role === "owner");
    if (!owner) return;
    this.appendMessage({
      missionId,
      fromAgentId: "system",
      toAgentId: owner.id,
      type: "agent_notify",
      content: message,
    });
    this.persist();
  }
```

- [ ] **Step 5: Wire lifecycle hooks**

At the end of `activateMission()` after scheduler startup and before `persist()`, add:

```typescript
    if (this.llm) {
      void this.getTaskOrchestrator().onMissionActivated(mission.id);
    }
```

In `confirmNegotiation()`, after scheduler startup and before `persist()`, add:

```typescript
    if (this.llm) {
      void this.getTaskOrchestrator().onMissionActivated(mission.id);
    }
```

In `submitExecutionResult()`, after `evaluateScheduleConditions(...)`, add:

```typescript
    if (resultTask.status === "completed" && this.llm) {
      void this.getTaskOrchestrator().onTaskCompleted({
        missionId: mission.id,
        taskId: resultTask.id,
        artifactId: artifact.id,
      });
    }
    if (resultTask.status === "failed" && this.llm) {
      void this.getTaskOrchestrator().onTaskFailed({
        missionId: mission.id,
        taskId: resultTask.id,
        failureReason: review.comments.join("; "),
      });
    }
```

In `failExecution()`, after the existing bus dispatch, add:

```typescript
    if (this.llm) {
      void this.getTaskOrchestrator().onTaskFailed({
        missionId: execution.missionId,
        taskId: execution.taskId,
        failureReason: input.error,
      });
    }
```

- [ ] **Step 6: Run integration tests**

Run: `pnpm --filter @digitalagent/server test -- mission-service.test.ts -t "mission report|orchestrator|executes a running task with LLM"`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/mission-service.ts apps/server/src/mission-service.test.ts apps/server/src/agent-autonomy.ts
git commit -m "feat: integrate task orchestration with missions"
```

---

### Task 8: API Executor Routing And Report Endpoints

**Files:**
- Modify: `apps/server/src/api.ts`
- Modify: `apps/server/src/api.test.ts`

- [ ] **Step 1: Write failing API tests**

Append to `apps/server/src/api.test.ts`:

```typescript
  it("routes task execution to the LLM executor", async () => {
    const fake = new FakeLlmAdapter(() => JSON.stringify({ result: "LLM artifact" }));
    const missions = new InMemoryMissionService({ llm: fake });
    const mission = await missions.createMission({ goal: "Run LLM task", successMetrics: ["LLM artifact"], constraints: [] });
    missions.activateMission({ missionId: mission.id });
    const task = missions.snapshot().tasks[0];
    if (!task) throw new Error("missing task");

    const response = await handleApiRequest({
      method: "POST",
      path: "/api/missions/tasks/execute",
      body: { missionId: mission.id, taskId: task.id, executor: "llm" },
    }, {
      missions,
      openclaw: { health: async () => ({ ok: true }), runAgentTask: async () => ({ output: "", stderr: "", exitCode: 0 }) },
    });

    expect(response.status).toBe(202);
    expect(missions.snapshot().artifacts[0]?.content).toEqual(expect.objectContaining({ result: "LLM artifact" }));
  });

  it("returns mission report from the report endpoint", async () => {
    const fake = new FakeLlmAdapter(() => JSON.stringify({
      completed: true,
      achievementSummary: "Done",
      confidence: 0.9,
      remainingWork: "",
    }));
    const missions = new InMemoryMissionService({ llm: fake });
    const mission = await missions.createMission({ goal: "Report mission", successMetrics: ["Done"], constraints: [] });
    await missions.checkMissionCompletion(mission.id);

    const response = await handleApiRequest({
      method: "GET",
      path: `/api/missions/${mission.id}/report`,
    }, {
      missions,
      openclaw: { health: async () => ({ ok: true }), runAgentTask: async () => ({ output: "", stderr: "", exitCode: 0 }) },
    });

    expect(response.status).toBe(200);
    expect((response.body as { report: unknown }).report).toEqual(expect.objectContaining({
      missionId: mission.id,
      achievementSummary: "Done",
    }));
  });
```

Run: `pnpm --filter @digitalagent/server test -- api.test.ts -t "LLM executor|report endpoint"`

Expected: FAIL because routes do not exist.

- [ ] **Step 2: Add executor route**

In `apps/server/src/api.ts`, add this route before `/api/openclaw/run`:

```typescript
    if (request.method === "POST" && request.path === "/api/missions/tasks/execute") {
      const body = expectObject(request.body);
      const missionId = expectString(body.missionId, "missionId");
      const taskId = expectString(body.taskId, "taskId");
      const executor = body.executor === "llm" || body.executor === "openclaw"
        ? body.executor
        : "openclaw";
      const execution = deps.missions.startExecution({ missionId, taskId });

      if (executor === "llm") {
        void deps.missions.executeTaskWithLlm({ missionId, taskId }).catch((error: unknown) => {
          deps.missions.failExecution({
            executionId: execution.id,
            error: error instanceof Error ? error.message : String(error),
          });
        });
        return json(202, { execution, snapshot: deps.missions.snapshot() });
      }

      void deps.openclaw.runAgentTask({
        message: buildOpenClawMessage({
          message: "Execute the assigned Mission task and return JSON.",
          mission: deps.missions.snapshot().missions.find((candidate) => candidate.id === missionId),
          task: deps.missions.snapshot().tasks.find((candidate) => candidate.id === taskId),
        }),
        timeoutSeconds: 300,
      }).then((result) => {
        deps.missions.submitExecutionResult({
          executionId: execution.id,
          missionId,
          taskId,
          content: { openclaw: result.output, stderr: result.stderr },
          evidence: ["openclaw:local"],
        });
      }).catch((error: unknown) => {
        deps.missions.failExecution({
          executionId: execution.id,
          error: error instanceof Error ? error.message : String(error),
        });
      });

      return json(202, { execution, snapshot: deps.missions.snapshot() });
    }
```

- [ ] **Step 3: Add completion and report routes**

In `apps/server/src/api.ts`, add before the schedule route:

```typescript
    const completionMatch = request.path.match(/^\/api\/missions\/([^/]+)\/check-completion$/);
    if (completionMatch && request.method === "POST") {
      const missionId = completionMatch[1];
      if (!missionId) return json(400, { error: "Mission ID required" });
      const completed = await deps.missions.checkMissionCompletion(missionId);
      return json(200, {
        completed,
        report: deps.missions.getMissionReport(missionId),
        snapshot: deps.missions.snapshot(),
      });
    }

    const reportMatch = request.path.match(/^\/api\/missions\/([^/]+)\/report$/);
    if (reportMatch && request.method === "GET") {
      const missionId = reportMatch[1];
      if (!missionId) return json(400, { error: "Mission ID required" });
      const report = deps.missions.getMissionReport(missionId);
      if (!report) return json(404, { error: "Mission report not found" });
      return json(200, { report });
    }
```

- [ ] **Step 4: Run API tests**

Run: `pnpm --filter @digitalagent/server test -- api.test.ts -t "LLM executor|report endpoint"`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/api.ts apps/server/src/api.test.ts
git commit -m "feat: add automation execution api routes"
```

---

### Task 9: Final Verification

**Files:**
- No source edits expected unless verification finds a real defect.

- [ ] **Step 1: Run targeted Phase 4B tests**

Run:

```bash
pnpm --filter @digitalagent/server test -- llm-executor.test.ts mission-report.test.ts task-orchestrator.test.ts mission-service.test.ts api.test.ts agent-conversation-bus.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run server typecheck**

Run:

```bash
pnpm --filter @digitalagent/server typecheck
```

Expected: PASS.

- [ ] **Step 3: Run full test suite**

Run:

```bash
pnpm test
```

Expected: PASS.

- [ ] **Step 4: Inspect git diff**

Run:

```bash
git diff --stat
git diff -- docs/superpowers/plans/2026-04-29-phase4b-automation-gap-fillers.md
```

Expected: source changes are limited to the files named in this plan, and the plan contains only concrete implementation instructions.

- [ ] **Step 5: Commit verification fixes if any**

Only run this if Step 1-3 required source fixes:

```bash
git add apps/server/src apps/server/config/agent-system.json
git commit -m "fix: stabilize phase4b automation gaps"
```

---

## Self-Review

**Spec coverage:** This plan covers Review to Bus dispatch, LLM direct execution, execution API routing, task orchestration on activation/completion/failure, guardrails for cooldown and task limits, completion checks, MissionReport generation, manual completion/report APIs, and config expansion. It intentionally keeps OpenClaw as the default executor and does not add tool use, distributed scheduling, external data sources, or long-term memory.

**Placeholder scan:** The plan contains concrete file paths, code snippets, commands, expected outcomes, and no unresolved implementation blanks.

**Type consistency:** `TaskExecutorKind`, `ExecutionConfig`, `OrchestrationConfig`, `CompletionCheckResult`, `MissionReport`, and `TaskOrchestrator` method names are consistent across tasks. `executeTaskWithLlm()`, `checkMissionCompletion()`, and `getMissionReport()` are introduced before API routes use them.
