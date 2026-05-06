import { describe, it, expect, beforeEach } from "vitest";
import {
  type MissionBrief,
  type RoleSpec,
} from "@digitalagent/core";
import { createHRAgent, type MissionAnalysis } from "./hr-agent.js";
import type { LlmService } from "@digitalagent/runtime";

describe("HRAgent", () => {
  let mockLlm: LlmService;
  let missionBrief: MissionBrief;

  beforeEach(() => {
    mockLlm = {
      call: async (_messages, options) => {
        const content = "LLM response";
        if (options?.onStream) {
          for (const char of content) {
            options.onStream(char);
          }
        }
        return {
          content,
          model: "test-model",
          usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
          finishReason: "stop",
        };
      },
      stats: () => ({
        totalCalls: 0,
        totalPromptTokens: 0,
        totalCompletionTokens: 0,
      }),
    };

    missionBrief = {
      goal: "Build a collaborative agent system",
      scope: "Design and implement the core architecture",
      constraints: ["Time limit: 2 weeks", "Budget: $10k"],
      successMetrics: ["System is operational", "Documentation complete"],
      keyAssumptions: ["Team has experience with TypeScript"],
      targetAudience: "Software developers",
      timeline: "Q2 2026",
    };
  });

  describe("receiveMissionBrief", () => {
    it("should analyze mission brief and identify key requirements", async () => {
      const hrAgent = createHRAgent({ llm: mockLlm });

      const analysis = await hrAgent.receiveMissionBrief(missionBrief);

      expect(analysis.missionGoal).toBe(missionBrief.goal);
      expect(analysis.requiredCapabilities).toBeDefined();
      expect(analysis.estimatedTeamSize).toBeGreaterThan(0);
      expect(analysis.priorityRoles).toBeDefined();
    });

    it("should handle complex missions with multiple requirements", async () => {
      const complexBrief: MissionBrief = {
        ...missionBrief,
        goal: "Build a full-stack e-commerce platform with AI recommendations",
        successMetrics: [
          "User registration system",
          "Product catalog with search",
          "AI-powered product recommendations",
          "Payment processing",
          "Admin dashboard",
        ],
      };

      mockLlm.call = async (_messages, options) => {
        const content = JSON.stringify({
          requiredCapabilities: [
            "web_development",
            "ai_integration",
            "database_design",
            "payment_processing",
            "ui_design",
          ],
          estimatedTeamSize: 4,
          priorityRoles: ["system_architect", "ai_engineer", "frontend_developer", "backend_developer"],
          complexity: "high",
        });
        if (options?.onStream) {
          for (const char of content) {
            options.onStream(char);
          }
        }
        return {
          content,
          model: "test-model",
          usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
          finishReason: "stop",
        };
      };

      const hrAgent = createHRAgent({ llm: mockLlm });
      const analysis = await hrAgent.receiveMissionBrief(complexBrief);

      expect(analysis.requiredCapabilities.length).toBeGreaterThan(3);
      expect(analysis.estimatedTeamSize).toBeGreaterThanOrEqual(4);
      expect(analysis.priorityRoles).toContain("system_architect");
      expect(analysis.complexity).toBeDefined();
      expect(analysis.riskFactors).toBeDefined();
    });
  });

  describe("generateRoleSpecs", () => {
    it("should generate role specifications based on mission analysis", async () => {
      const hrAgent = createHRAgent({ llm: mockLlm });

      const analysis: MissionAnalysis = {
        missionGoal: missionBrief.goal,
        requiredCapabilities: ["system_architecture", "team_coordination"],
        estimatedTeamSize: 2,
        priorityRoles: ["architect", "coordinator"],
        complexity: "medium",
        riskFactors: [],
      };

      mockLlm.call = async (_messages, options) => {
        const content = JSON.stringify([
          {
            name: "System Architect",
            purpose: "Design the core system architecture",
            responsibilities: [
              "Design system architecture",
              "Define component interfaces",
              "Create technical specifications",
            ],
            capabilities: ["system_architecture", "technical_design"],
            allowedTools: ["code_editor", "diagram_generator"],
            successCriteria: ["Architecture approved", "Specifications complete"],
            budget: { maxRuntimeMinutes: 120, maxTasks: 5 },
          },
        ]);
        if (options?.onStream) {
          for (const char of content) {
            options.onStream(char);
          }
        }
        return {
          content,
          model: "test-model",
          usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
          finishReason: "stop",
        };
      };

      const roleSpecs = await hrAgent.generateRoleSpecs("mission-123", analysis);

      expect(roleSpecs).toHaveLength(1);
      const firstSpec = roleSpecs[0];
      if (firstSpec) {
        expect(firstSpec.name).toBe("System Architect");
        expect(firstSpec.responsibilities).toHaveLength(3);
        expect(firstSpec.allowedTools).toContain("diagram_generator");
      }
    });

    it("should validate generated role specs", async () => {
      const hrAgent = createHRAgent({ llm: mockLlm });

      const analysis: MissionAnalysis = {
        missionGoal: missionBrief.goal,
        requiredCapabilities: ["research"],
        estimatedTeamSize: 1,
        priorityRoles: ["researcher"],
        complexity: "low",
        riskFactors: [],
      };

      mockLlm.call = async (_messages, options) => {
        const content = JSON.stringify([
          {
            id: "role-1",
            name: "Research Agent",
            purpose: "Conduct research and analysis",
            responsibilities: ["Gather information", "Analyze data"],
            allowedTools: ["web_search", "data_analysis"],
            inputContract: { query: "string" },
            outputContract: { results: "array" },
            successCriteria: ["Research complete"],
            budget: { maxRuntimeMinutes: 60, maxTasks: 3 },
          },
        ]);
        if (options?.onStream) {
          for (const char of content) {
            options.onStream(char);
          }
        }
        return {
          content,
          model: "test-model",
          usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
          finishReason: "stop",
        };
      };

      const roleSpecs = await hrAgent.generateRoleSpecs("mission-123", analysis);

      const firstSpec = roleSpecs[0];
      if (firstSpec) {
        expect(firstSpec.id).toBeTruthy();
        expect(firstSpec.successCriteria).toBeDefined();
        expect(firstSpec.budget.maxTasks).toBeGreaterThan(0);
      }
    });
  });

  describe("proposeTeam", () => {
    it("should create team proposal for owner review", async () => {
      const hrAgent = createHRAgent({ llm: mockLlm });

      const roleSpecs: RoleSpec[] = [
        {
          id: "role-1",
          name: "Architect",
          purpose: "Design system",
          responsibilities: ["Design", "Document"],
          allowedTools: ["code", "diagrams"],
          inputContract: {},
          outputContract: {},
          successCriteria: ["Design complete"],
          budget: { maxRuntimeMinutes: 120, maxTasks: 5 },
        },
      ];

      const proposal = await hrAgent.proposeTeam("mission-123", roleSpecs);

      expect(proposal.missionId).toBe("mission-123");
      expect(proposal.roles).toHaveLength(1);
      expect(proposal.proposedBy).toContain("hr");
      expect(proposal.totalBudget).toBeDefined();
      expect(proposal.estimatedDuration).toBeDefined();
      expect(proposal.riskAssessment).toBeDefined();
      expect(proposal.schedulePlan).toHaveLength(1);
      expect(proposal.schedulePlan[0]?.assigneeRole).toBe("role-1");
    });

    it("should include collaboration suggestions in proposal", async () => {
      const hrAgent = createHRAgent({ llm: mockLlm });

      const roleSpecs: RoleSpec[] = [
        {
          id: "role-1",
          name: "Researcher",
          purpose: "Conduct research",
          responsibilities: ["Research", "Analyze"],
          allowedTools: ["web_search"],
          inputContract: {},
          outputContract: {},
          successCriteria: ["Research complete"],
          budget: { maxRuntimeMinutes: 60, maxTasks: 3 },
        },
        {
          id: "role-2",
          name: "Writer",
          purpose: "Write content",
          responsibilities: ["Write", "Edit"],
          allowedTools: ["text_editor"],
          inputContract: {},
          outputContract: {},
          successCriteria: ["Content complete"],
          budget: { maxRuntimeMinutes: 60, maxTasks: 3 },
        },
      ];

      const proposal = await hrAgent.proposeTeam("mission-123", roleSpecs);

      expect(proposal.collaborationPlan).toBeDefined();
      expect(proposal.collaborationPlan.workflow).toBeDefined();
      expect(proposal.roles.length).toBeGreaterThanOrEqual(2);
      expect(proposal.schedulePlan.length).toBeGreaterThanOrEqual(1);
    });

    it("should use MissionBrief context to generate mission-specific schedule plan", async () => {
      const calls: string[] = [];
      mockLlm.call = async (messages, options) => {
        calls.push(messages.map((message) => message.content).join("\n"));
        const content = JSON.stringify([
          {
            name: "Daily Xiaohongshu data check",
            cronExpression: "0 9 * * *",
            assigneeRole: "data_analyst",
            taskDescription: "Check yesterday's Xiaohongshu follower and engagement data",
            justification: "Daily data checks catch performance changes quickly",
          },
          {
            name: "Biweekly Xiaohongshu strategy review",
            cronExpression: "0 10 */14 * *",
            assigneeRole: "content_strategist",
            taskDescription: "Review two weeks of Xiaohongshu results and adjust the content plan",
            justification: "Biweekly strategy reviews align cadence with content performance signal",
          },
          {
            name: "Engagement drop alert",
            assigneeRole: "data_analyst",
            taskDescription: "Investigate engagement drop and propose corrective actions",
            justification: "Large engagement drops require immediate analysis",
            conditionDescription: "Engagement rate drops more than 20%",
            conditionSourceRole: "data_analyst",
            conditionEvaluatePrompt: "Return true if engagement rate dropped more than 20%.",
          },
        ]);
        if (options?.onStream) {
          for (const char of content) {
            options.onStream(char);
          }
        }
        return {
          content,
          model: "test-model",
          usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
          finishReason: "stop",
        };
      };
      const hrAgent = createHRAgent({ llm: mockLlm });
      const roleSpecs: RoleSpec[] = [
        {
          id: "data_analyst",
          name: "Data Analyst",
          purpose: "Track Xiaohongshu metrics",
          responsibilities: ["Analyze engagement", "Report follower growth"],
          allowedTools: ["analytics"],
          inputContract: {},
          outputContract: {},
          successCriteria: ["Metrics reported"],
          budget: { maxRuntimeMinutes: 60, maxTasks: 5 },
        },
        {
          id: "content_strategist",
          name: "Content Strategist",
          purpose: "Plan Xiaohongshu content",
          responsibilities: ["Plan posts", "Adjust strategy"],
          allowedTools: ["editor"],
          inputContract: {},
          outputContract: {},
          successCriteria: ["Plan updated"],
          budget: { maxRuntimeMinutes: 60, maxTasks: 5 },
        },
      ];

      const proposal = await hrAgent.proposeTeam("mission-123", roleSpecs, {
        ...missionBrief,
        goal: "Grow Xiaohongshu account to 1000 followers",
        scope: "Xiaohongshu content operations",
        successMetrics: ["followers >= 1000", "engagement rate improves"],
      });

      expect(calls.at(-1)).toContain("Grow Xiaohongshu account");
      expect(proposal.schedulePlan.map((item) => item.name)).toEqual([
        "Daily Xiaohongshu data check",
        "Biweekly Xiaohongshu strategy review",
        "Engagement drop alert",
      ]);
      expect(proposal.schedulePlan[2]?.conditionEvaluatePrompt).toContain("20%");
    });
  });

  describe("negotiateRoleSpec", () => {
    it("should handle role spec negotiation with owner", async () => {
      const hrAgent = createHRAgent({ llm: mockLlm });

      const initialSpec: RoleSpec = {
        id: "role-1",
        name: "Senior Developer",
        purpose: "Develop core features",
        responsibilities: ["Development", "Testing"],
        allowedTools: ["code_editor"],
        inputContract: {},
        outputContract: {},
        successCriteria: ["Features working"],
        budget: { maxRuntimeMinutes: 180, maxTasks: 8 },
      };

      const ownerFeedback = "Reduce budget and focus on core features only";

      mockLlm.call = async (_messages, options) => {
        const content = JSON.stringify({
          ...initialSpec,
          budget: { maxRuntimeMinutes: 120, maxTasks: 5 },
          responsibilities: ["Core feature development"],
        });
        if (options?.onStream) {
          for (const char of content) {
            options.onStream(char);
          }
        }
        return {
          content,
          model: "test-model",
          usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
          finishReason: "stop",
        };
      };

      const revisedSpec = await hrAgent.negotiateRoleSpec(
        "mission-123",
        initialSpec,
        ownerFeedback,
      );

      const revised = Array.isArray(revisedSpec) ? revisedSpec[0] : revisedSpec;
      if (revised) {
        expect(revised.budget.maxRuntimeMinutes).toBeLessThanOrEqual(
          initialSpec.budget.maxRuntimeMinutes,
        );
        expect(revised.responsibilities.length).toBeLessThanOrEqual(
          initialSpec.responsibilities.length,
        );
      }
    });

    it("should propose alternatives when requirements conflict", async () => {
      const hrAgent = createHRAgent({ llm: mockLlm });

      const initialSpec: RoleSpec = {
        id: "role-1",
        name: "Full-stack Developer",
        purpose: "Handle all development",
        responsibilities: ["Frontend", "Backend", "DevOps", "Testing"],
        allowedTools: ["code_editor"],
        inputContract: {},
        outputContract: {},
        successCriteria: ["All features working"],
        budget: { maxRuntimeMinutes: 60, maxTasks: 2 },
      };

      const ownerFeedback = "Too much scope for one role, suggest splitting";

      mockLlm.call = async (_messages, options) => {
        const content = JSON.stringify([
          {
            ...initialSpec,
            id: "role-1a",
            name: "Frontend Developer",
            purpose: "Handle frontend development",
            responsibilities: ["Frontend", "UI Testing"],
          },
          {
            ...initialSpec,
            id: "role-1b",
            name: "Backend Developer",
            purpose: "Handle backend development",
            responsibilities: ["Backend", "API Testing"],
          },
        ]);
        if (options?.onStream) {
          for (const char of content) {
            options.onStream(char);
          }
        }
        return {
          content,
          model: "test-model",
          usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
          finishReason: "stop",
        };
      };

      const alternatives = await hrAgent.negotiateRoleSpec(
        "mission-123",
        initialSpec,
        ownerFeedback,
      );

      expect(Array.isArray(alternatives)).toBe(true);
      if (Array.isArray(alternatives)) {
        expect(alternatives).toHaveLength(2);
        const first = alternatives[0];
        const second = alternatives[1];
        if (first) expect(first.name).toContain("Frontend");
        if (second) expect(second.name).toContain("Backend");
      }
    });
  });
});
