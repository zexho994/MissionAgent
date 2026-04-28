import { describe, expect, it } from "vitest";
import { InMemoryMissionService } from "./mission-service.js";
import { FakeLlmAdapter } from "@digitalagent/runtime";

describe("SSE Streaming Integration", () => {
  it("should stream tokens during LLM calls", async () => {
    const streamEvents: Array<{ type: string; content?: string }> = [];
    const llm = new FakeLlmAdapter(() => "Test streaming response");

    const service = new InMemoryMissionService({ llm });

    // Create mission first to get the ID
    const mission = await service.createMission({
      goal: "Test streaming functionality",
    });

    // Continue mission to trigger LLM call while subscribed
    const subscription = service.subscribeToMissionStream(mission.id, (event) => {
      streamEvents.push(event);
    });

    // Trigger another LLM call
    await service.continueMission({
      missionId: mission.id,
      message: "Continue streaming test",
    });

    // Wait a bit for streaming to complete
    await new Promise((resolve) => setTimeout(resolve, 100));

    subscription.unsubscribe();

    // Verify we got streaming events
    expect(streamEvents.length).toBeGreaterThan(0);
    expect(streamEvents.some((e) => e.type === "done")).toBe(true);
  });

  it("should parse choices from owner responses with streaming", async () => {
    const llm = new FakeLlmAdapter(() => `Please select your preferred approach:

A. Use React for the frontend
B. Use Vue for the frontend
C. Use Angular for the frontend`);

    const service = new InMemoryMissionService({ llm });

    const mission = await service.createMission({
      goal: "Choose a frontend framework",
    });

    // Wait for LLM processing
    await new Promise((resolve) => setTimeout(resolve, 100));

    const snapshot = service.snapshot();
    const ownerMessages = snapshot.agentMessages.filter(
      (msg) => msg.missionId === mission.id && msg.fromAgentId !== "user"
    );

    expect(ownerMessages.length).toBeGreaterThan(0);
    const lastMessage = ownerMessages[ownerMessages.length - 1];
    expect(lastMessage?.options).toBeDefined();
    expect(lastMessage?.options?.length).toBe(3);
    expect(lastMessage?.options?.[0]?.label).toBe("A");
    expect(lastMessage?.options?.[0]?.value).toBe("Use React for the frontend");
  });

  it("should handle multiple subscribers to the same mission stream", async () => {
    const llm = new FakeLlmAdapter(() => "Test response");
    const service = new InMemoryMissionService({ llm });

    const mission = await service.createMission({
      goal: "Test multiple subscribers",
    });

    const events1: Array<{ type: string; content?: string }> = [];
    const events2: Array<{ type: string; content?: string }> = [];

    const sub1 = service.subscribeToMissionStream(mission.id, (event) => {
      events1.push(event);
    });

    const sub2 = service.subscribeToMissionStream(mission.id, (event) => {
      events2.push(event);
    });

    // Trigger LLM call while both are subscribed
    await service.continueMission({
      missionId: mission.id,
      message: "Test multiple subscribers",
    });

    await new Promise((resolve) => setTimeout(resolve, 100));

    sub1.unsubscribe();
    sub2.unsubscribe();

    expect(events1.length).toBeGreaterThan(0);
    expect(events2.length).toBeGreaterThan(0);
    expect(events1.length).toEqual(events2.length);
  });

  it("should unsubscribe correctly from mission streams", async () => {
    const llm = new FakeLlmAdapter(() => "Response 1");
    const service = new InMemoryMissionService({ llm });

    const mission = await service.createMission({
      goal: "Test unsubscribe",
    });

    const events: Array<{ type: string; content?: string }> = [];

    const subscription = service.subscribeToMissionStream(mission.id, (event) => {
      events.push(event);
    });

    await new Promise((resolve) => setTimeout(resolve, 100));

    subscription.unsubscribe();

    const eventsBeforeUnsubscribe = events.length;

    // Continue mission to trigger more streaming
    await service.continueMission({
      missionId: mission.id,
      message: "Another message",
    });

    await new Promise((resolve) => setTimeout(resolve, 100));

    // Events should not have increased after unsubscribe
    expect(events.length).toBe(eventsBeforeUnsubscribe);
  });
});