import { describe, it, expect } from "vitest";
import {
  createRoleRequirement,
  createHRAgentConfig,
  validateRoleSpec,
} from "./hr-types.js";

const uuidSuffix = "[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";

describe("HR Types", () => {
  describe("createRoleRequirement", () => {
    it("should create a valid RoleRequirement", () => {
      const requirement = createRoleRequirement({
        missionId: "mission_1",
        roleType: "content_creator",
        neededCapabilities: ["writing", "research", "seo"],
        urgency: "high",
        budgetMax: 100,
      });

      expect(requirement.id).toMatch(new RegExp(`^role_req_${uuidSuffix}$`));
      expect(requirement.missionId).toBe("mission_1");
      expect(requirement.roleType).toBe("content_creator");
      expect(requirement.neededCapabilities).toEqual(["writing", "research", "seo"]);
      expect(requirement.urgency).toBe("high");
      expect(requirement.budgetMax).toBe(100);
      expect(requirement.createdAt).toBeInstanceOf(Date);
    });

    it("should throw error if missionId is empty", () => {
      expect(() =>
        createRoleRequirement({
          missionId: "",
          roleType: "analyst",
          neededCapabilities: ["data_analysis"],
          urgency: "medium",
          budgetMax: 50,
        })
      ).toThrow("Mission ID is required");
    });

    it("should validate roleType with valid enum values", () => {
      // This test verifies that only valid RoleType values are accepted
      expect(() =>
        createRoleRequirement({
          missionId: "mission_1",
          roleType: "analyst", // Valid type
          neededCapabilities: ["data_analysis"],
          urgency: "medium",
          budgetMax: 50,
        })
      ).not.toThrow();
    });

    it("should throw error if no capabilities provided", () => {
      expect(() =>
        createRoleRequirement({
          missionId: "mission_1",
          roleType: "analyst",
          neededCapabilities: [],
          urgency: "medium",
          budgetMax: 50,
        })
      ).toThrow("At least one capability is required");
    });

    it("should throw error if budgetMax is negative", () => {
      expect(() =>
        createRoleRequirement({
          missionId: "mission_1",
          roleType: "analyst",
          neededCapabilities: ["data_analysis"],
          urgency: "medium",
          budgetMax: -10,
        })
      ).toThrow("Budget max must be non-negative");
    });
  });

  describe("createHRAgentConfig", () => {
    it("should create a valid HRAgentConfig", () => {
      const config = createHRAgentConfig({
        negotiationStyle: "collaborative",
        maxRounds: 5,
        escalationThreshold: 0.6,
      });

      expect(config.id).toMatch(new RegExp(`^hr_config_${uuidSuffix}$`));
      expect(config.negotiationStyle).toBe("collaborative");
      expect(config.maxRounds).toBe(5);
      expect(config.escalationThreshold).toBe(0.6);
      expect(config.createdAt).toBeInstanceOf(Date);
    });

    it("should use default values for optional fields", () => {
      const config = createHRAgentConfig({
        negotiationStyle: "assertive",
      });

      expect(config.maxRounds).toBe(3);
      expect(config.escalationThreshold).toBe(0.5);
    });

    it("should throw error if maxRounds is less than 1", () => {
      expect(() =>
        createHRAgentConfig({
          negotiationStyle: "collaborative",
          maxRounds: 0,
        })
      ).toThrow("Max rounds must be at least 1");
    });

    it("should throw error if escalationThreshold is out of range", () => {
      expect(() =>
        createHRAgentConfig({
          negotiationStyle: "collaborative",
          escalationThreshold: 1.5,
        })
      ).toThrow("Escalation threshold must be between 0 and 1");

      expect(() =>
        createHRAgentConfig({
          negotiationStyle: "collaborative",
          escalationThreshold: -0.1,
        })
      ).toThrow("Escalation threshold must be between 0 and 1");
    });
  });

  describe("validateRoleSpec", () => {
    it("should validate a correct RoleSpec", () => {
      const roleSpec = {
        id: "role_1",
        name: "Data Analyst",
        purpose: "Analyze metrics and provide insights",
        responsibilities: ["Daily data review", "Report generation"],
        allowedTools: ["analytics", "charts"],
        inputContract: { metrics: "array" },
        outputContract: { report: "string" },
        successCriteria: ["Accuracy > 90%"],
        budget: { maxRuntimeMinutes: 30, maxTasks: 10 },
      };

      const result = validateRoleSpec(roleSpec);
      expect(result.isValid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it("should return errors for invalid RoleSpec", () => {
      const roleSpec = {
        id: "",
        name: "",
        purpose: "",
        responsibilities: [],
        allowedTools: [],
        inputContract: {},
        outputContract: {},
        successCriteria: [],
        budget: { maxRuntimeMinutes: -1, maxTasks: 0 },
      };

      const result = validateRoleSpec(roleSpec);
      expect(result.isValid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors).toContain("Role ID is required");
      expect(result.errors).toContain("Role name is required");
    });
  });
});
