import { describe, expect, it } from "vitest";
import {
  HttpPublishTargetAdapter,
  PublishTargetAdapterRegistry,
  type PublishTargetAdapter,
} from "./publish-target-adapter.js";

describe("PublishTargetAdapterRegistry", () => {
  it("returns registered adapter by type", () => {
    const stub: PublishTargetAdapter = {
      async publish() {
        return { ok: true, response: { id: "p-1" } };
      },
    };
    const reg = new PublishTargetAdapterRegistry();
    reg.register("stub", stub);
    expect(reg.get("stub")).toBe(stub);
  });

  it("throws when unknown type requested", () => {
    const reg = new PublishTargetAdapterRegistry();
    expect(() => reg.get("unknown")).toThrow(/no adapter/i);
  });

  it("has() returns true for registered types", () => {
    const reg = new PublishTargetAdapterRegistry();
    reg.register("stub", { async publish() { return { ok: true, response: {} }; } });
    expect(reg.has("stub")).toBe(true);
  });
});

describe("HttpPublishTargetAdapter", () => {
  it("POSTs payload as JSON and returns parsed response", async () => {
    let captured: { url: string; init?: RequestInit | undefined } | undefined;
    const fakeFetch = async (url: string, init?: RequestInit) => {
      captured = { url, init };
      return new Response(JSON.stringify({ id: "post-42" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const adapter = new HttpPublishTargetAdapter({ fetch: fakeFetch });
    const result = await adapter.publish(
      {
        artifactId: "a-1",
        artifactContent: { text: "hello" },
        missionGoal: "g",
        taskTitle: "t",
      },
      { url: "https://api.example.com/posts", method: "POST" },
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.response).toEqual({ id: "post-42" });
    expect(captured?.url).toBe("https://api.example.com/posts");
    expect(captured?.init?.method).toBe("POST");
    const body = JSON.parse(captured?.init?.body as string);
    expect(body.artifactId).toBe("a-1");
    expect(body.artifact).toEqual({ text: "hello" });
  });

  it("returns error on non-2xx response", async () => {
    const fakeFetch = async () => new Response("bad request", { status: 400 });
    const adapter = new HttpPublishTargetAdapter({ fetch: fakeFetch });
    const result = await adapter.publish(
      { artifactId: "a", artifactContent: {}, missionGoal: "g" },
      { url: "https://x", method: "POST" },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/400/);
  });

  it("returns error when fetch throws", async () => {
    const fakeFetch = async () => {
      throw new Error("ECONNREFUSED");
    };
    const adapter = new HttpPublishTargetAdapter({ fetch: fakeFetch });
    const result = await adapter.publish(
      { artifactId: "a", artifactContent: {}, missionGoal: "g" },
      { url: "https://x", method: "POST" },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("ECONNREFUSED");
  });

  it("returns error when url is missing", async () => {
    const adapter = new HttpPublishTargetAdapter({ fetch: async () => new Response() });
    const result = await adapter.publish(
      { artifactId: "a", artifactContent: {}, missionGoal: "g" },
      { method: "POST" },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/url/i);
  });
});
