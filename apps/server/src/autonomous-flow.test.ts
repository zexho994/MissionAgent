import { describe, expect, it } from "vitest";
import { createScheduleRule } from "@digitalagent/core";
import { InMemoryMissionService } from "./mission-service.js";
import type { MissionExecutionRuntime } from "./runtime-bridge.js";

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
