import { describe, it, expect } from "vitest";
import {
  BUILTIN_SCHEDULE_TEMPLATES,
  findTemplateById,
  describeTemplatesForPrompt,
} from "./schedule-templates.js";

describe("schedule-templates", () => {
  describe("BUILTIN_SCHEDULE_TEMPLATES", () => {
    it("has at least 4 built-in templates", () => {
      expect(BUILTIN_SCHEDULE_TEMPLATES.length).toBeGreaterThanOrEqual(4);
    });

    it("each template has required fields", () => {
      for (const t of BUILTIN_SCHEDULE_TEMPLATES) {
        expect(t.id).toBeTruthy();
        expect(t.name).toBeTruthy();
        expect(t.description).toBeTruthy();
        expect(t.applicableRolePatterns).toBeDefined();
        expect(t.trigger).toBeDefined();
        expect(t.taskTemplate).toBeDefined();
        expect(t.maxConcurrent).toBeGreaterThan(0);
      }
    });
  });

  describe("findTemplateById", () => {
    it("returns template for known id", () => {
      const template = findTemplateById("daily_metric_check");
      expect(template).toBeDefined();
      expect(template!.id).toBe("daily_metric_check");
    });

    it("returns undefined for unknown id", () => {
      expect(findTemplateById("nonexistent")).toBeUndefined();
    });
  });

  describe("describeTemplatesForPrompt", () => {
    it("returns a non-empty string", () => {
      const description = describeTemplatesForPrompt();
      expect(typeof description).toBe("string");
      expect(description.length).toBeGreaterThan(0);
    });

    it("includes template names", () => {
      const description = describeTemplatesForPrompt();
      expect(description).toContain("daily_metric_check");
      expect(description).toContain("weekly_team_report");
    });
  });
});
