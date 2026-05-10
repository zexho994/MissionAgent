import { describe, expect, it } from "vitest";
import { createScheduleRule } from "@digitalagent/core";
import { InMemoryMissionService } from "./mission-service.js";
import type { MissionExecutionRuntime } from "./runtime-bridge.js";
import { FakeLlmAdapter } from "@digitalagent/runtime";

function fakeApprovableRuntime(): MissionExecutionRuntime & { calls: number } {
  const wrapper = {
    calls: 0,
    async runAgentTask() {
      wrapper.calls += 1;
      return {
        status: "completed",
        output: {
          payloads: [
            {
              text: `research github growth metrics delivered with daily review (run ${wrapper.calls}).`,
            },
          ],
          searchResults: [
            { url: "https://example.com/source", title: "src", snippet: "x" },
          ],
        },
        stderr: "",
      };
    },
  };
  return wrapper;
}

describe("autonomous mission flow", () => {
  it("executes first task automatically and continues with scheduled tasks via runtime", async () => {
    const runtime = fakeApprovableRuntime();
    const missions = new InMemoryMissionService({ runtime });
    const mission = await missions.createMission({
      goal: "research GitHub growth metrics",
      successMetrics: ["daily review generated"],
    });
    missions.activateMission({ missionId: mission.id });

    // Step 1: first mission task auto-executes via runtime
    const initialTask = missions
      .snapshot()
      .tasks.find((t) => t.missionId === mission.id);
    if (!initialTask) throw new Error("missing initial task");

    missions.executeTask({
      missionId: mission.id,
      taskId: initialTask.id,
      message: "first run",
    });
    for (let i = 0; i < 6; i += 1) {
      await new Promise((r) => setImmediate(r));
    }

    expect(runtime.calls).toBe(1);
    const initialTaskFinal = missions
      .snapshot()
      .tasks.find((t) => t.id === initialTask.id);
    expect(initialTaskFinal?.status).toBe("completed");

    // Step 2: register a schedule rule and trigger it; the runtime should fire again
    const rule = createScheduleRule({
      name: "Daily growth check",
      missionId: mission.id,
      enabled: true,
      trigger: { type: "cron", expression: "0 9 * * *", timezone: "UTC" },
      taskTemplate: {
        title: "Track GitHub growth follow-up",
        contract: {
          objective: "Track GitHub growth follow-up",
          input: {},
          outputSchema: {},
          successCriteria: ["Follow-up summarized"],
        },
        assigneeRole: "researcher",
        priority: "normal",
      },
      maxConcurrent: 1,
      metadata: {},
    });
    missions.addScheduleRule(mission.id, rule);

    const scheduledTask = missions.triggerNextScheduleRule(mission.id);
    for (let i = 0; i < 6; i += 1) {
      await new Promise((r) => setImmediate(r));
    }

    expect(runtime.calls).toBe(2);
    const scheduledTaskFinal = missions
      .snapshot()
      .tasks.find((t) => t.id === scheduledTask.id);
    expect(scheduledTaskFinal?.status).toBe("completed");
    expect(scheduledTaskFinal?.scheduleRuleId).toBe(rule.id);

    // Worker agent should still be reusable (not stuck in done) after both runs
    const worker = missions
      .snapshot()
      .agents.find((a) => a.role === "researcher" && a.missionId === mission.id);
    expect(worker?.status).toBe("idle");
  });
});

describe("Mission task spawning loop (A.3 v1)", () => {
  function buildOwnerLlm(spawnTitles: string[]): FakeLlmAdapter {
    let spawnIndex = 0;
    return new FakeLlmAdapter((messages) => {
      const systemContent = messages.find((m) => m.role === "system")?.content ?? "";
      const userContent = messages.find((m) => m.role === "user")?.content ?? "";
      const sysText = typeof systemContent === "string" ? systemContent : "";
      const userText = typeof userContent === "string" ? userContent : "";
      const isOwner = sysText.includes("Owner Agent");
      // Bus prompts contain `Event:` in the user message; owner-streaming and HR don't.
      const isBusEvent = userText.includes("Event:");
      // Only Owner-via-bus gets create_followup_task; everyone else acknowledges.
      if (isOwner && isBusEvent && spawnIndex < spawnTitles.length) {
        const title = spawnTitles[spawnIndex++]!;
        return JSON.stringify({
          message: `Spawning ${title}`,
          type: "agent_chat",
          mentionedAgentIds: [],
          shouldPropagate: false,
          action: {
            type: "create_followup_task",
            payload: {
              title,
              objective: `Deliver ${title}`,
              assigneeRole: "researcher",
              reason: `Continuation after previous task`,
            },
          },
        });
      }
      // Bus prompts (any non-owner agent) get acknowledge
      if (isBusEvent) {
        return JSON.stringify({
          message: "ok",
          type: "agent_chat",
          mentionedAgentIds: [],
          shouldPropagate: false,
          action: { type: "acknowledge" },
        });
      }
      // Other LLM calls (owner streaming, HR, etc.) — return a benign response so they don't crash.
      // The first reply during createMission goes through runOwnerLlmStreaming and expects a goal/scope structure.
      return JSON.stringify({
        message: "Acknowledged.",
        goal: "test mission",
        scope: "test",
        constraints: [],
        successMetrics: ["test metric"],
        keyAssumptions: [],
      });
    });
  }

  function makeRuntime() {
    const wrapper = {
      calls: 0,
      async runAgentTask() {
        wrapper.calls += 1;
        return {
          status: "completed" as const,
          output: {
            payloads: [
              {
                text: `research GitHub growth metrics delivered with daily review (run ${wrapper.calls}).`,
              },
            ],
          },
          stderr: "",
        };
      },
    };
    return wrapper;
  }

  async function flush(rounds = 12) {
    for (let i = 0; i < rounds; i += 1) {
      await new Promise((r) => setImmediate(r));
    }
  }

  it("after first task is approved, Owner spawns a followup task that auto-executes", async () => {
    const llm = buildOwnerLlm(["Step 2"]);
    const runtime = makeRuntime();
    const missions = new InMemoryMissionService({ runtime, llm });
    const mission = await missions.createMission({
      goal: "research GitHub growth metrics",
      successMetrics: ["daily review generated"],
    });
    missions.activateMission({ missionId: mission.id });

    const initialTask = missions.snapshot().tasks.find((t) => t.missionId === mission.id);
    if (!initialTask) throw new Error("missing initial task");

    missions.executeTask({
      missionId: mission.id,
      taskId: initialTask.id,
      message: "first run",
    });
    await flush();

    const tasks = missions.snapshot().tasks.filter((t) => t.missionId === mission.id);
    expect(tasks.length).toBeGreaterThanOrEqual(2);
    const step2 = tasks.find((t) => t.title === "Step 2");
    expect(step2).toBeDefined();
    expect(step2?.origin?.type).toBe("followup");
    expect(step2?.origin?.sourceTaskId).toBeUndefined(); // owner LLM did not include sourceTaskId
    expect(step2?.assigneeAgentId).toBeDefined();

    // Followup auto-executed via runtime
    expect(runtime.calls).toBeGreaterThanOrEqual(2);
  });

  it("respects per-event limit: same triggeringEventId only creates one followup (unit-level guard verified in mission-service.test.ts; here we verify total task count is bounded by per-event=1 across one review)", async () => {
    // With a single review_completed event, even if the LLM tries multiple times,
    // the bus passes a unique triggeringEventId per-(thread,target,message) so each
    // owner response could in theory spawn one followup. Per-event=1 is verified
    // exhaustively in mission-service.test.ts. Here we just sanity-check that we
    // never exceed maxTotalTasksPerMission of 2 (initial + step2).
    const llm = buildOwnerLlm(["Step 2"]);
    const runtime = makeRuntime();
    const missions = new InMemoryMissionService({
      runtime,
      llm,
      followupSafety: { maxFollowupsPerEvent: 1, maxTotalTasksPerMission: 2 },
    });
    const mission = await missions.createMission({ goal: "research GitHub growth metrics" });
    missions.activateMission({ missionId: mission.id });

    const initialTask = missions.snapshot().tasks.find((t) => t.missionId === mission.id);
    if (!initialTask) throw new Error("missing initial task");

    missions.executeTask({
      missionId: mission.id,
      taskId: initialTask.id,
      message: "go",
    });
    await flush();

    const tasks = missions.snapshot().tasks.filter((t) => t.missionId === mission.id);
    expect(tasks.length).toBeLessThanOrEqual(2);
  });

  it("escalates to owner when total task cap reached", async () => {
    const llm = buildOwnerLlm(["Step 2", "Step 3"]);
    const runtime = makeRuntime();
    // Total cap is 1: initial task already counts, so any followup is blocked
    const missions = new InMemoryMissionService({
      runtime,
      llm,
      followupSafety: { maxFollowupsPerEvent: 99, maxTotalTasksPerMission: 1 },
    });
    const mission = await missions.createMission({ goal: "Cap test mission" });
    missions.activateMission({ missionId: mission.id });

    const initialTask = missions.snapshot().tasks.find((t) => t.missionId === mission.id);
    if (!initialTask) throw new Error("missing initial task");

    missions.executeTask({
      missionId: mission.id,
      taskId: initialTask.id,
      message: "go",
    });
    await flush();

    const tasks = missions.snapshot().tasks.filter((t) => t.missionId === mission.id);
    expect(tasks.length).toBe(1); // only the initial task; followup blocked

    const messages = missions.snapshot().agentMessages.filter((m) => m.missionId === mission.id);
    const capNotice = messages.find(
      (m) => m.type === "agent_notify" && m.content.toLowerCase().includes("mission cap"),
    );
    expect(capNotice).toBeDefined();
  });
});
