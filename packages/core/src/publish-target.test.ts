import { describe, expect, it } from "vitest";
import { createMissionPublishTarget } from "./publish-target.js";

describe("createMissionPublishTarget", () => {
  it("creates a publish target with id, idle status, and empty attempts", () => {
    const t = createMissionPublishTarget({
      missionId: "m1",
      name: "speakin",
      adapter: "http",
      config: { url: "https://speakin.cc/api/posts", method: "POST" },
      contentTypes: ["content_draft"],
    });
    expect(t.id).toMatch(/^publishtarget_/);
    expect(t.missionId).toBe("m1");
    expect(t.name).toBe("speakin");
    expect(t.adapter).toBe("http");
    expect(t.status).toBe("idle");
    expect(t.attempts).toEqual([]);
    expect(t.contentTypes).toEqual(["content_draft"]);
    expect(t.config.url).toBe("https://speakin.cc/api/posts");
  });

  it("defaults contentTypes to ['*'] when empty", () => {
    const t = createMissionPublishTarget({
      missionId: "m1",
      name: "any",
      adapter: "http",
      config: { url: "https://x", method: "POST" },
      contentTypes: [],
    });
    expect(t.contentTypes).toEqual(["*"]);
  });

  it("rejects empty url", () => {
    expect(() =>
      createMissionPublishTarget({
        missionId: "m1",
        name: "X",
        adapter: "http",
        config: { url: "", method: "POST" },
        contentTypes: ["*"],
      }),
    ).toThrow("url");
  });

  it("rejects empty name", () => {
    expect(() =>
      createMissionPublishTarget({
        missionId: "m1",
        name: " ",
        adapter: "http",
        config: { url: "https://x", method: "POST" },
        contentTypes: ["*"],
      }),
    ).toThrow("name");
  });
});
