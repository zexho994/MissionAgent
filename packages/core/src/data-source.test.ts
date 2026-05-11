import { describe, expect, it } from "vitest";
import { createMissionDataSource } from "./data-source.js";

describe("createMissionDataSource", () => {
  it("creates a data source with id, default status idle, and empty fetch history", () => {
    const ds = createMissionDataSource({
      missionId: "m1",
      name: "GSC",
      adapter: "http",
      config: { url: "https://api.example.com/gsc", method: "GET" },
    });
    expect(ds.id).toMatch(/^datasource_/);
    expect(ds.missionId).toBe("m1");
    expect(ds.name).toBe("GSC");
    expect(ds.adapter).toBe("http");
    expect(ds.status).toBe("idle");
    expect(ds.fetchHistory).toEqual([]);
    expect(ds.config.url).toBe("https://api.example.com/gsc");
    expect(ds.config.method).toBe("GET");
  });

  it("rejects empty name", () => {
    expect(() =>
      createMissionDataSource({
        missionId: "m1",
        name: " ",
        adapter: "http",
        config: { url: "https://x", method: "GET" },
      }),
    ).toThrow("name");
  });

  it("rejects empty url", () => {
    expect(() =>
      createMissionDataSource({
        missionId: "m1",
        name: "X",
        adapter: "http",
        config: { url: "", method: "GET" },
      }),
    ).toThrow("url");
  });

  it("rejects empty missionId", () => {
    expect(() =>
      createMissionDataSource({
        missionId: " ",
        name: "X",
        adapter: "http",
        config: { url: "https://x", method: "GET" },
      }),
    ).toThrow("missionId");
  });
});
