import { describe, expect, it } from "vitest";
import { InMemoryMissionService } from "./mission-service.js";
import type { MissionExecutionRuntime } from "./runtime-bridge.js";
import { FakeLlmAdapter } from "@digitalagent/runtime";

/**
 * Plan 5 Task 3: end-to-end "speakin Mission Week 1" simulation.
 *
 * Verifies that Plan 1 (followup task spawning), Plan 2 (HTTP data source +
 * publish target), and Plan 3 (safety guards) compose correctly on a real
 * mission template (speakin-content), exercised over a realistic loop:
 *  - createMissionFromTemplate sets up data sources + publish targets
 *  - activateMission creates initial task
 *  - executeTask completes the initial task; review approves; Owner LLM
 *    spawns a followup task ("Write article on top keyword") via the
 *    create_followup_task action; the followup auto-executes
 *  - the approved artifacts auto-publish to speakin.cc /api/posts (HTTP)
 *  - manual data source fetch (GSC stub) writes a KnowledgeEntry
 *  - mission stays active (no budget overrun, no auto-pause)
 */

describe("speakin Mission week 1 integration (Plans 1+2+3)", () => {
  function makeApprovableRuntime(): MissionExecutionRuntime & { calls: number } {
    const wrapper = {
      calls: 0,
      async runAgentTask() {
        wrapper.calls += 1;
        return {
          status: "completed" as const,
          output: {
            payloads: [
              {
                text:
                  "research weekly content for speakin.cc with detailed keyword analysis " +
                  "and a tracked publication plan covering audience growth metrics.",
              },
            ],
            searchResults: [
              { url: "https://speakin.cc/blog/keywords", title: "Speakin keywords", snippet: "k" },
            ],
          },
          stderr: "",
        };
      },
    };
    return wrapper;
  }

  function makeOwnerLlm(spawnTitle: string): FakeLlmAdapter {
    let spawned = false;
    return new FakeLlmAdapter((messages) => {
      const sys = messages.find((m) => m.role === "system")?.content ?? "";
      const user = messages.find((m) => m.role === "user")?.content ?? "";
      const sysText = typeof sys === "string" ? sys : "";
      const userText = typeof user === "string" ? user : "";
      const isOwnerBus = sysText.includes("Owner Agent") && userText.includes("Event:");
      if (isOwnerBus && !spawned) {
        spawned = true;
        return JSON.stringify({
          message: `Spawning ${spawnTitle}`,
          type: "agent_chat",
          mentionedAgentIds: [],
          shouldPropagate: false,
          action: {
            type: "create_followup_task",
            payload: {
              title: spawnTitle,
              objective: `Deliver ${spawnTitle}`,
              assigneeRole: "researcher",
              reason: "GSC top keyword surfaced",
            },
          },
        });
      }
      // All other LLM paths get a benign response that is also a valid
      // owner-streaming brief (createMission flow expects this shape).
      return JSON.stringify({
        message: "Acknowledged.",
        goal: "research and publish weekly content for speakin.cc",
        scope: "weekly content production",
        constraints: [],
        successMetrics: ["weekly publish"],
        keyAssumptions: [],
        type: "agent_chat",
        shouldPropagate: false,
        action: { type: "acknowledge" },
      });
    });
  }

  async function flush(rounds = 14) {
    for (let i = 0; i < rounds; i += 1) {
      await new Promise((r) => setImmediate(r));
    }
  }

  it("template creation → initial task → followup → publish → fetch knowledge — all hooks fire", async () => {
    const fetched: Array<{ url: string; method: string; body?: string | undefined }> = [];
    const fakeFetch = async (url: string, init?: RequestInit) => {
      fetched.push({
        url,
        method: init?.method ?? "GET",
        body: typeof init?.body === "string" ? init.body : undefined,
      });
      // GSC endpoint returns keyword data; speakin endpoint returns post id.
      if (url.includes("googleapis.com")) {
        return new Response(
          JSON.stringify({ rows: [{ keys: ["speakin tutorial"], impressions: 100, clicks: 12 }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ id: "post-1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const runtime = makeApprovableRuntime();
    const llm = makeOwnerLlm("Write article on top keyword 'speakin tutorial'");
    const service = new InMemoryMissionService({ runtime, llm, fetch: fakeFetch });

    // Step 1: create mission from template (already adds data sources + publish targets)
    const mission = await service.createMissionFromTemplate({ templateId: "speakin-content" });
    expect(service.listDataSources(mission.id).length).toBeGreaterThanOrEqual(1);
    expect(service.listPublishTargets(mission.id).length).toBeGreaterThanOrEqual(1);

    // Step 2: activate to create initial task
    await service.activateMission({ missionId: mission.id });
    const initialTask = service.snapshot().tasks.find((t) => t.missionId === mission.id);
    if (!initialTask) throw new Error("missing initial task");

    // Step 3: execute initial task — runtime returns a valid artifact, review approves,
    //         and the auto-publish hook fires.
    service.executeTask({
      missionId: mission.id,
      taskId: initialTask.id,
      message: "first run",
    });
    await flush();

    // Step 4: confirm publish hit speakin endpoint
    const speakinCalls = fetched.filter((c) => c.url.includes("speakin.cc"));
    expect(speakinCalls.length).toBeGreaterThanOrEqual(1);

    // Step 5: confirm Owner spawned a followup task and it executed
    const tasks = service.snapshot().tasks.filter((t) => t.missionId === mission.id);
    expect(tasks.length).toBeGreaterThanOrEqual(2);
    const followup = tasks.find((t) => t.origin?.type === "followup");
    expect(followup).toBeDefined();
    expect(runtime.calls).toBeGreaterThanOrEqual(2); // initial + followup execution

    // Step 6: trigger GSC data source fetch manually (simulates weekly review)
    const gscSource = service.listDataSources(mission.id)[0]!;
    const fetchRecord = await service.triggerDataSourceFetch(mission.id, gscSource.id);
    expect(fetchRecord.status).toBe("ok");
    const knowledge = service.listKnowledge({ missionId: mission.id });
    expect(knowledge.some((k) => k.key.startsWith("dataSource:"))).toBe(true);

    // Step 7: mission still active (no budget overrun, no auto-pause)
    const finalMission = service.snapshot().missions.find((m) => m.id === mission.id);
    expect(finalMission?.status).toBe("active");

    // Step 8: GSC fetch was made
    const gscCalls = fetched.filter((c) => c.url.includes("googleapis.com"));
    expect(gscCalls.length).toBeGreaterThanOrEqual(1);
  });
});
