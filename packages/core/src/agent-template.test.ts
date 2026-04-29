import { describe, it, expect } from "vitest";
import {
  createAgentTemplate,
  createAgentPersona,
  createAgentOnboardingContext,
  generateSystemPrompt,
} from "./agent-template.js";

const uuidSuffix = "[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";

describe("Agent Template Types", () => {
  describe("createAgentTemplate", () => {
    it("should create a valid AgentTemplate", () => {
      const template = createAgentTemplate({
        name: "Data Analyst",
        roleType: "data_analyst",
        baseCapabilities: ["data_analysis", "reporting"],
        defaultTools: ["analytics", "charts"],
      });

      expect(template.id).toMatch(new RegExp(`^template_${uuidSuffix}$`));
      expect(template.name).toBe("Data Analyst");
      expect(template.roleType).toBe("data_analyst");
      expect(template.baseCapabilities).toEqual(["data_analysis", "reporting"]);
      expect(template.defaultTools).toEqual(["analytics", "charts"]);
      expect(template.createdAt).toBeInstanceOf(Date);
    });

    it("should throw error if name is empty", () => {
      expect(() =>
        createAgentTemplate({
          name: "",
          roleType: "analyst",
          baseCapabilities: ["analysis"],
          defaultTools: ["tool"],
        })
      ).toThrow("Template name is required");
    });

    it("should throw error if roleType is empty", () => {
      expect(() =>
        createAgentTemplate({
          name: "Analyst",
          roleType: "",
          baseCapabilities: ["analysis"],
          defaultTools: ["tool"],
        })
      ).toThrow("Role type is required");
    });

    it("should throw error if no capabilities provided", () => {
      expect(() =>
        createAgentTemplate({
          name: "Analyst",
          roleType: "analyst",
          baseCapabilities: [],
          defaultTools: ["tool"],
        })
      ).toThrow("At least one capability is required");
    });

    it("should throw error if no tools provided", () => {
      expect(() =>
        createAgentTemplate({
          name: "Analyst",
          roleType: "analyst",
          baseCapabilities: ["analysis"],
          defaultTools: [],
        })
      ).toThrow("At least one tool is required");
    });
  });

  describe("createAgentPersona", () => {
    it("should create a valid AgentPersona", () => {
      const persona = createAgentPersona({
        name: "Strategic Analyst",
        personality: "analytical",
        communicationStyle: "formal",
        decisionMaking: "data-driven",
        systemPrompt: "You are a careful data analyst...",
      });

      expect(persona.id).toMatch(new RegExp(`^persona_${uuidSuffix}$`));
      expect(persona.name).toBe("Strategic Analyst");
      expect(persona.personality).toBe("analytical");
      expect(persona.communicationStyle).toBe("formal");
      expect(persona.decisionMaking).toBe("data-driven");
      expect(persona.systemPrompt).toBe("You are a careful data analyst...");
      expect(persona.createdAt).toBeInstanceOf(Date);
    });

    it("should use default values for optional fields", () => {
      const persona = createAgentPersona({
        name: "Analyst",
        personality: "friendly",
        systemPrompt: "You are helpful.",
      });

      expect(persona.communicationStyle).toBe("neutral");
      expect(persona.decisionMaking).toBe("balanced");
    });

    it("should throw error if name is empty", () => {
      expect(() =>
        createAgentPersona({
          name: "",
          personality: "analytical",
          systemPrompt: "Prompt",
        })
      ).toThrow("Persona name is required");
    });

    it("should throw error if systemPrompt is empty", () => {
      expect(() =>
        createAgentPersona({
          name: "Analyst",
          personality: "analytical",
          systemPrompt: "",
        })
      ).toThrow("System prompt is required");
    });
  });

  describe("createAgentOnboardingContext", () => {
    it("should create a valid AgentOnboardingContext", () => {
      const context = createAgentOnboardingContext({
        agentId: "agent_1",
        missionId: "mission_1",
        roleSpec: {
          id: "role_1",
          name: "Data Analyst",
          purpose: "Analyze data",
          responsibilities: ["Daily reports"],
          allowedTools: ["analytics"],
          inputContract: {},
          outputContract: {},
          successCriteria: ["Accuracy"],
          budget: { maxRuntimeMinutes: 30, maxTasks: 10 },
        },
        teamContext: {
          teamMembers: ["owner", "hr"],
          reportingLine: "owner",
          collaborators: ["hr"],
        },
        initialInstructions: "Start by analyzing yesterday's data",
      });

      expect(context.id).toMatch(new RegExp(`^onboarding_${uuidSuffix}$`));
      expect(context.agentId).toBe("agent_1");
      expect(context.missionId).toBe("mission_1");
      expect(context.roleSpec.name).toBe("Data Analyst");
      expect(context.teamContext.teamMembers).toEqual(["owner", "hr"]);
      expect(context.initialInstructions).toBe("Start by analyzing yesterday's data");
      expect(context.createdAt).toBeInstanceOf(Date);
    });

    it("should throw error if agentId is empty", () => {
      expect(() =>
        createAgentOnboardingContext({
          agentId: "",
          missionId: "mission_1",
          roleSpec: {
            id: "role_1",
            name: "Analyst",
            purpose: "Analyze",
            responsibilities: ["Report"],
            allowedTools: ["tool"],
            inputContract: {},
            outputContract: {},
            successCriteria: ["Good"],
            budget: { maxRuntimeMinutes: 30, maxTasks: 10 },
          },
          teamContext: {
            teamMembers: [],
            reportingLine: "",
            collaborators: [],
          },
        })
      ).toThrow("Agent ID is required");
    });

    it("should throw error if missionId is empty", () => {
      expect(() =>
        createAgentOnboardingContext({
          agentId: "agent_1",
          missionId: "",
          roleSpec: {
            id: "role_1",
            name: "Analyst",
            purpose: "Analyze",
            responsibilities: ["Report"],
            allowedTools: ["tool"],
            inputContract: {},
            outputContract: {},
            successCriteria: ["Good"],
            budget: { maxRuntimeMinutes: 30, maxTasks: 10 },
          },
          teamContext: {
            teamMembers: [],
            reportingLine: "",
            collaborators: [],
          },
        })
      ).toThrow("Mission ID is required");
    });
  });

  describe("generateSystemPrompt", () => {
    it("should generate a comprehensive system prompt", () => {
      const persona = createAgentPersona({
        name: "Data Analyst",
        personality: "analytical",
        communicationStyle: "formal",
        decisionMaking: "data-driven",
        systemPrompt: "You are a careful data analyst...",
      });

      const roleSpec = {
        name: "Senior Analyst",
        purpose: "Provide insights",
        responsibilities: ["Analyze metrics", "Generate reports"],
        successCriteria: ["Accuracy > 95%"],
      };

      const prompt = generateSystemPrompt(persona, roleSpec);

      expect(prompt).toContain("careful data analyst");
      expect(prompt).toContain("Senior Analyst");
      expect(prompt).toContain("Provide insights");
      expect(prompt).toContain("Analyze metrics");
      expect(prompt).toContain("Accuracy > 95%");
      expect(prompt).toContain("analytical");
      expect(prompt).toContain("formal");
      expect(prompt).toContain("data-driven");
    });

    it("should handle minimal inputs", () => {
      const persona = createAgentPersona({
        name: "Helper",
        personality: "friendly",
        systemPrompt: "You help.",
      });

      const roleSpec = {
        name: "Assistant",
        purpose: "Assist",
        responsibilities: ["Help users"],
        successCriteria: ["User satisfaction"],
      };

      const prompt = generateSystemPrompt(persona, roleSpec);

      expect(prompt).toContain("You help.");
      expect(prompt).toContain("Assistant");
      expect(prompt).toContain("Assist");
      expect(prompt).toContain("Help users");
      expect(prompt).toContain("User satisfaction");
    });
  });
});
