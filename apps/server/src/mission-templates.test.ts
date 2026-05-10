import { describe, expect, it } from "vitest";
import {
  MISSION_TEMPLATES,
  getMissionTemplate,
  listMissionTemplates,
} from "./mission-templates.js";

describe("mission-templates", () => {
  it("speakin-content template is registered with required fields", () => {
    const template = MISSION_TEMPLATES["speakin-content"];
    expect(template).toBeDefined();
    expect(template?.goal).toContain("speakin");
    expect(template?.successMetrics.length).toBeGreaterThan(0);
    expect(template?.constraints.length).toBeGreaterThan(0);
    expect(template?.dataSources?.length).toBeGreaterThanOrEqual(1);
    expect(template?.publishTargets?.length).toBeGreaterThanOrEqual(1);
  });

  it("getMissionTemplate returns template by id", () => {
    const template = getMissionTemplate("speakin-content");
    expect(template.id).toBe("speakin-content");
  });

  it("getMissionTemplate throws on unknown id", () => {
    expect(() => getMissionTemplate("does-not-exist")).toThrow(/Unknown mission template/);
  });

  it("listMissionTemplates returns id+goal pairs", () => {
    const list = listMissionTemplates();
    expect(list.length).toBeGreaterThanOrEqual(1);
    const speakin = list.find((t) => t.id === "speakin-content");
    expect(speakin?.goal).toContain("speakin");
  });
});
