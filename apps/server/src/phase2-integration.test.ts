import { describe, it, expect, beforeEach } from "vitest";
import {
  type MissionBrief,
  type RoleSpec,
  createId,
  type Mission,
} from "@digitalagent/core";
import { InMemoryMissionService } from "./mission-service.js";
import { createHRAgent } from "./hr-agent.js";
import { createNegotiationService } from "./negotiation-service.js";
import { createAgentFactory } from "./agent-factory.js";
import type { LlmService } from "@digitalagent/runtime";

describe("Phase 2 Integration Tests", () => {
  let mockLlm: LlmService;
  let missionService: InMemoryMissionService;
  let missionBrief: MissionBrief;
  let testMissionId: string;
  let llmCallCount = 0;

  beforeEach(() => {
    llmCallCount = 0;
    mockLlm = {
      call: async () => {
        llmCallCount++;
        // First call is for mission analysis (returns object)
        if (llmCallCount === 1) {
          return {
            content: `Here's my analysis:

\`\`\`json
{
  "requiredCapabilities": ["development", "testing"],
  "estimatedTeamSize": 3,
  "priorityRoles": ["developer", "tester"],
  "complexity": "medium",
  "riskFactors": ["Time constraints"]
}
\`\`\``,
            model: "test-model",
            usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
            finishReason: "stop",
          };
        }
        // Subsequent calls are for role specs (returns array)
        return {
          content: `Here are the role specifications:

\`\`\`json
[
  {
    "name": "Developer",
    "purpose": "Implement the core system functionality",
    "responsibilities": ["Write clean code", "Implement features", "Fix bugs"],
    "capabilities": ["development", "testing"],
    "allowedTools": ["code_editor", "git", "terminal"],
    "successCriteria": ["All features implemented", "Code reviewed"],
    "budget": { "maxRuntimeMinutes": 120, "maxTasks": 5 }
  },
  {
    "name": "QA Engineer",
    "purpose": "Ensure quality and reliability",
    "responsibilities": ["Write tests", "Perform manual testing", "Report bugs"],
    "capabilities": ["testing", "quality_assurance"],
    "allowedTools": ["testing_frameworks", "bug_tracker"],
    "successCriteria": ["Test coverage > 80%", "No critical bugs"],
    "budget": { "maxRuntimeMinutes": 90, "maxTasks": 4 }
  }
]
\`\`\``,
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

    missionService = new InMemoryMissionService({
      llm: mockLlm,
      storageFile: undefined,
    });

    missionBrief = {
      goal: "Build a collaborative agent system",
      scope: "Design and implement the core architecture",
      constraints: ["Time limit: 2 weeks", "Budget: $10k"],
      successMetrics: ["System is operational", "Documentation complete"],
      keyAssumptions: ["Team has experience with TypeScript"],
      targetAudience: "Software developers",
      timeline: "Q2 2026",
    };

    testMissionId = createId("mission");
  });

  describe("Complete HR Flow", () => {
    it("should handle full flow: MissionBrief → HR generates RoleSpecs → Owner negotiates → agents created", async () => {
      // Step 1: HR receives MissionBrief and generates analysis
      const hrAgent = createHRAgent({ llm: mockLlm });
      const analysis = await hrAgent.receiveMissionBrief(missionBrief);

      expect(analysis.missionGoal).toBe(missionBrief.goal);
      expect(analysis.requiredCapabilities).toBeDefined();
      expect(analysis.estimatedTeamSize).toBeGreaterThan(0);
      expect(analysis.priorityRoles).toBeDefined();

      // Step 2: HR generates role specifications
      const roleSpecs = await hrAgent.generateRoleSpecs(testMissionId, analysis);

      expect(roleSpecs.length).toBeGreaterThan(0);
      expect(roleSpecs.length).toBeLessThanOrEqual(8); // Max team size constraint

      roleSpecs.forEach((spec) => {
        expect(spec.id).toBeDefined();
        expect(spec.name).toBeDefined();
        expect(spec.purpose).toBeDefined();
        expect(spec.responsibilities.length).toBeGreaterThan(0);
        expect(spec.allowedTools.length).toBeGreaterThan(0);
        expect(spec.successCriteria.length).toBeGreaterThan(0);
        expect(spec.budget.maxRuntimeMinutes).toBeGreaterThan(0);
        expect(spec.budget.maxTasks).toBeGreaterThan(0);
      });

      // Step 3: HR proposes team
      const teamProposal = await hrAgent.proposeTeam(testMissionId, roleSpecs);

      expect(teamProposal.missionId).toBe(testMissionId);
      expect(teamProposal.roles.length).toBe(roleSpecs.length);
      expect(teamProposal.totalBudget.maxRuntimeMinutes).toBeGreaterThan(0);
      expect(teamProposal.totalBudget.maxTasks).toBeGreaterThan(0);
      expect(teamProposal.estimatedDuration).toBeDefined();
      expect(teamProposal.riskAssessment).toBeDefined();
      expect(teamProposal.collaborationPlan).toBeDefined();

      // Step 4: Owner responds with feedback (negotiation starts)
      const negotiationService = createNegotiationService({ llm: mockLlm });
      const ownerContext = {
        ownerAgentId: createId("owner"),
        preferences: {
          teamSize: [2, 5] as [number, number],
          maxBudget: { maxRuntimeMinutes: 500, maxTasks: 20 },
          preferredCapabilities: ["development", "testing"],
          avoidCapabilities: [],
        },
        constraints: ["Must complete within 2 weeks"],
        previousFeedback: [],
      };

      const negotiation = await negotiationService.startNegotiation(
        teamProposal,
        ownerContext,
      );

      expect(negotiation.status).toBe("active");
      expect(negotiation.rounds.length).toBe(1);
      expect(negotiation.rounds[0]?.messages.length ?? 0).toBe(1);
      expect(negotiation.initiatorId).toBe(teamProposal.proposedBy);
      expect(negotiation.participantId).toBe(ownerContext.ownerAgentId);

      // Step 5: Agreement reached (simulation)
      const { createNegotiationMessage } = await import("@digitalagent/core");
      const agreementMessage = createNegotiationMessage({
        senderId: ownerContext.ownerAgentId,
        receiverId: teamProposal.proposedBy,
        type: "agreement",
        content: {
          message: "I agree with the proposed team composition",
          agreedProposal: teamProposal,
        },
      });

      const finalNegotiation = await negotiationService.processRound(
        negotiation,
        agreementMessage,
      );

      expect(finalNegotiation.status).toBe("agreed");
      expect(finalNegotiation.endedAt).toBeDefined();

      // Step 6: Agents created with correct prompts
      const agentFactory = createAgentFactory();
      const agents = roleSpecs.map((spec, index) =>
        agentFactory.createAgentFromRoleSpec(testMissionId, spec, index),
      );

      expect(agents.length).toBe(roleSpecs.length);
      agents.forEach((agent, index) => {
        const spec = roleSpecs[index];
        if (!spec) return;

        expect(agent.id).toBeDefined();
        expect(agent.missionId).toBe(testMissionId);
        expect(agent.name).toBe(spec.name);
        expect(agent.responsibility).toBe(spec.purpose);
        expect(agent.toolPermissions).toEqual(spec.allowedTools);
        expect(agent.budget).toEqual(spec.budget);
        expect(agent.sortOrder).toBe(index);
      });

      // Step 7: AgentRelations established correctly
      const relations = agentFactory.setupRelations(agents);

      expect(relations.length).toBeGreaterThan(0);
      relations.forEach((relation) => {
        expect(relation.id).toBeDefined();
        expect(relation.missionId).toBe(testMissionId);
        expect(relation.fromAgentId).toBeDefined();
        expect(relation.toAgentId).toBeDefined();
        expect(relation.label).toBeDefined();
        expect(["active", "waiting", "done"]).toContain(relation.status);
        expect(relation.createdAt).toBeDefined();
      });

      // Verify no duplicate relations
      const relationPairs = new Set(
        relations.map((r) => `${r.fromAgentId}-${r.toAgentId}`),
      );
      expect(relationPairs.size).toBe(relations.length);
    });
  });

  describe("Edge Cases", () => {
    it("should handle empty MissionBrief gracefully", async () => {
      const emptyBrief: MissionBrief = {
        goal: "",
        scope: "",
        constraints: [],
        successMetrics: [],
        keyAssumptions: [],
        targetAudience: "",
        timeline: "",
      };

      const hrAgent = createHRAgent({ llm: mockLlm });

      const analysis = await hrAgent.receiveMissionBrief(emptyBrief);

      expect(analysis).toBeDefined();
      expect(analysis.missionGoal).toBe("");
      expect(analysis.requiredCapabilities).toBeDefined();
      expect(analysis.estimatedTeamSize).toBeGreaterThan(0);

      const roleSpecs = await hrAgent.generateRoleSpecs(testMissionId, analysis);

      expect(roleSpecs).toBeDefined();
      expect(Array.isArray(roleSpecs)).toBe(true);
    });

    it("should handle negotiation failure / escalation", async () => {
      const hrAgent = createHRAgent({ llm: mockLlm });
      const analysis = await hrAgent.receiveMissionBrief(missionBrief);
      const roleSpecs = await hrAgent.generateRoleSpecs(testMissionId, analysis);
      const teamProposal = await hrAgent.proposeTeam(testMissionId, roleSpecs);

      const negotiationService = createNegotiationService({
        llm: mockLlm,
        maxRounds: 2,
      });

      const ownerContext = {
        ownerAgentId: createId("owner"),
        preferences: {
          teamSize: [2, 3] as [number, number], // Conflicts with proposal
          maxBudget: { maxRuntimeMinutes: 100, maxTasks: 2 },
          preferredCapabilities: [],
          avoidCapabilities: ["development", "testing"], // Conflicts
        },
        constraints: ["Impossible constraints"],
        previousFeedback: ["Reject everything"],
      };

      const negotiation = await negotiationService.startNegotiation(
        teamProposal,
        ownerContext,
      );

      expect(negotiation.status).toBe("active");

      // Simulate rejection
      const { createNegotiationMessage } = await import("@digitalagent/core");
      const rejectionMessage = createNegotiationMessage({
        senderId: ownerContext.ownerAgentId,
        receiverId: teamProposal.proposedBy,
        type: "rejection",
        content: {
          reason: "Team composition does not meet requirements",
        },
      });

      const failedNegotiation = await negotiationService.processRound(
        negotiation,
        rejectionMessage,
      );

      expect(failedNegotiation.status).toBe("failed");
      expect(failedNegotiation.endedAt).toBeDefined();
    });

    it("should handle conflicting role requirements", async () => {
      const conflictingSpecs: RoleSpec[] = [
        {
          id: createId("role"),
          name: "Full Stack Developer",
          purpose: "Handle all development tasks",
          responsibilities: [
            "Frontend development",
            "Backend development",
            "Database design",
            "UI/UX design",
            "Testing",
            "DevOps",
          ],
          allowedTools: ["all"],
          inputContract: {},
          outputContract: {},
          successCriteria: ["Everything works"],
          budget: {
            maxRuntimeMinutes: 60,
            maxTasks: 1,
          },
        },
        {
          id: createId("role"),
          name: "Specialist Developer",
          purpose: "Focused development",
          responsibilities: ["Write code"],
          allowedTools: ["editor"],
          inputContract: {},
          outputContract: {},
          successCriteria: ["Code is written"],
          budget: {
            maxRuntimeMinutes: 300,
            maxTasks: 10,
          },
        },
      ];

      const agentFactory = createAgentFactory();
      const agents = conflictingSpecs.map((spec, index) =>
        agentFactory.createAgentFromRoleSpec(testMissionId, spec, index),
      );

      expect(agents.length).toBe(2);
      expect(agents[0]?.budget?.maxRuntimeMinutes).toBe(60);
      expect(agents[1]?.budget?.maxRuntimeMinutes).toBe(300);

      const relations = agentFactory.setupRelations(agents);
      expect(relations.length).toBeGreaterThan(0);
    });

    it("should handle budget constraints", async () => {
      const hrAgent = createHRAgent({ llm: mockLlm });
      const analysis = await hrAgent.receiveMissionBrief(missionBrief);

      // Create role specs with high budget requirements
      const highBudgetSpecs: RoleSpec[] = [
        {
          id: createId("role"),
          name: "Senior Developer",
          purpose: "Lead development",
          responsibilities: ["Architecture", "Development", "Testing"],
          allowedTools: ["all"],
          inputContract: {},
          outputContract: {},
          successCriteria: ["System delivered"],
          budget: {
            maxRuntimeMinutes: 500,
            maxTasks: 20,
          },
        },
        {
          id: createId("role"),
          name: "Junior Developer",
          purpose: "Support development",
          responsibilities: ["Coding", "Testing"],
          allowedTools: ["basic"],
          inputContract: {},
          outputContract: {},
          successCriteria: ["Tasks completed"],
          budget: {
            maxRuntimeMinutes: 300,
            maxTasks: 10,
          },
        },
      ];

      const teamProposal = await hrAgent.proposeTeam(testMissionId, highBudgetSpecs);

      expect(teamProposal.totalBudget.maxRuntimeMinutes).toBe(800);
      expect(teamProposal.totalBudget.maxTasks).toBe(30);

      const negotiationService = createNegotiationService({ llm: mockLlm });
      const ownerContext = {
        ownerAgentId: createId("owner"),
        preferences: {
          teamSize: [2, 5] as [number, number],
          maxBudget: { maxRuntimeMinutes: 400, maxTasks: 15 }, // Budget constraint
          preferredCapabilities: ["development"],
          avoidCapabilities: [],
        },
        constraints: ["Budget limit: 400 minutes"],
        previousFeedback: [],
      };

      const negotiation = await negotiationService.startNegotiation(
        teamProposal,
        ownerContext,
      );

      expect(negotiation.status).toBe("active");

      // Check that proposal exceeds budget
      const budgetCheck = negotiationService.checkAgreement(
        { maxRuntimeMinutes: 800, maxTasks: 30 },
        { maxRuntimeMinutes: 400, maxTasks: 15 },
      );

      expect(budgetCheck).toBeLessThan(1); // Should indicate disagreement
    });

    it("should handle maximum rounds escalation", async () => {
      const negotiationService = createNegotiationService({
        llm: mockLlm,
        maxRounds: 1,
      });

      const hrAgent = createHRAgent({ llm: mockLlm });
      const analysis = await hrAgent.receiveMissionBrief(missionBrief);
      const roleSpecs = await hrAgent.generateRoleSpecs(testMissionId, analysis);
      const teamProposal = await hrAgent.proposeTeam(testMissionId, roleSpecs);

      const ownerContext = {
        ownerAgentId: createId("owner"),
        preferences: {
          teamSize: [2, 5] as [number, number],
          maxBudget: { maxRuntimeMinutes: 500, maxTasks: 20 },
          preferredCapabilities: ["development"],
          avoidCapabilities: [],
        },
        constraints: [],
        previousFeedback: [],
      };

      const negotiation = await negotiationService.startNegotiation(
        teamProposal,
        ownerContext,
      );

      expect(negotiation.currentRound).toBe(1);

      const { createNegotiationMessage } = await import("@digitalagent/core");
      const counterMessage = createNegotiationMessage({
        senderId: ownerContext.ownerAgentId,
        receiverId: teamProposal.proposedBy,
        type: "counter_proposal",
        content: {
          message: "I need different team composition",
        },
      });

      // This should trigger escalation since maxRounds = 1
      const escalatedNegotiation = await negotiationService.processRound(
        negotiation,
        counterMessage,
      );

      expect(escalatedNegotiation.status).toBe("escalated");
      expect(escalatedNegotiation.escalationReason).toBeDefined();
    });
  });

  describe("Agent Factory Integration", () => {
    it("should generate system prompts correctly for different role types", async () => {
      const hrAgent = createHRAgent({ llm: mockLlm });
      const analysis = await hrAgent.receiveMissionBrief(missionBrief);
      const roleSpecs = await hrAgent.generateRoleSpecs(testMissionId, analysis);

      const agentFactory = createAgentFactory();

      roleSpecs.forEach((spec) => {
        const persona = agentFactory.inferAgentPersona(spec);
        expect(persona.id).toBeDefined();
        expect(persona.name).toBeDefined();
        expect(persona.personality).toBeDefined();
        expect(persona.communicationStyle).toBeDefined();
        expect(persona.decisionMaking).toBeDefined();
        expect(persona.systemPrompt).toBeDefined();
        expect(persona.systemPrompt.length).toBeGreaterThan(100);

        const systemPrompt = agentFactory.generateSystemPrompt(spec, persona);
        expect(systemPrompt).toContain(spec.name);
        expect(systemPrompt).toContain(spec.purpose);
        expect(systemPrompt).toContain("## Your Role");
      });
    });

    it("should setup correct agent relations based on roles", async () => {
      const roleSpecs: RoleSpec[] = [
        {
          id: "owner",
          name: "Owner",
          purpose: "Mission owner",
          responsibilities: ["Set goals", "Review progress"],
          allowedTools: ["all"],
          inputContract: {},
          outputContract: {},
          successCriteria: ["Mission success"],
          budget: { maxRuntimeMinutes: 100, maxTasks: 5 },
        },
        {
          id: "hr",
          name: "HR Agent",
          purpose: "Team coordination",
          responsibilities: ["Assemble team", "Monitor performance"],
          allowedTools: ["team"],
          inputContract: {},
          outputContract: {},
          successCriteria: ["Team assembled"],
          budget: { maxRuntimeMinutes: 80, maxTasks: 3 },
        },
        {
          id: "developer",
          name: "Developer",
          purpose: "Implementation",
          responsibilities: ["Write code", "Test code"],
          allowedTools: ["code"],
          inputContract: {},
          outputContract: {},
          successCriteria: ["Features implemented"],
          budget: { maxRuntimeMinutes: 120, maxTasks: 5 },
        },
        {
          id: "reviewer",
          name: "Reviewer",
          purpose: "Quality assurance",
          responsibilities: ["Review code", "Provide feedback"],
          allowedTools: ["review"],
          inputContract: {},
          outputContract: {},
          successCriteria: ["Quality maintained"],
          budget: { maxRuntimeMinutes: 60, maxTasks: 3 },
        },
      ];

      const agentFactory = createAgentFactory();
      const agents = roleSpecs.map((spec, index) =>
        agentFactory.createAgentFromRoleSpec(testMissionId, spec, index),
      );

      const relations = agentFactory.setupRelations(agents);

      expect(agents.length).toBe(4);
      expect(relations.length).toBeGreaterThan(0);

      // Check that owner has relations to other agents
      const ownerRelations = relations.filter(
        (r) => r.fromAgentId === agents[0]?.id,
      );
      expect(ownerRelations.length).toBeGreaterThan(0);

      // Check that workers have relations to reviewer
      const developerRelations = relations.filter(
        (r) => r.fromAgentId === agents[2]?.id && r.toAgentId === agents[3]?.id,
      );
      expect(developerRelations.length).toBe(1);
      expect(developerRelations[0]?.label).toContain("review");
    });
  });

  describe("Mission Service Integration", () => {
    it("should integrate HR flow with mission service", async () => {
      const createRequest = {
        goal: missionBrief.goal,
        successMetrics: missionBrief.successMetrics,
        constraints: missionBrief.constraints,
      };

      const mission = await missionService.createMission(createRequest);

      expect(mission.id).toBeDefined();
      expect(mission.goal).toBe(missionBrief.goal);
      expect(mission.status).toBeDefined(); // Status may be 'draft' or 'active' depending on LLM interaction

      // HR would normally process this mission
      const hrAgent = createHRAgent({ llm: mockLlm });
      const analysis = await hrAgent.receiveMissionBrief(missionBrief);
      const roleSpecs = await hrAgent.generateRoleSpecs(mission.id, analysis);

      expect(roleSpecs.length).toBeGreaterThan(0);

      // Create agents from role specs
      const agentFactory = createAgentFactory();
      const agents = roleSpecs.map((spec, index) =>
        agentFactory.createAgentFromRoleSpec(mission.id, spec, index),
      );

      expect(agents.length).toBe(roleSpecs.length);

      // Setup relations
      const relations = agentFactory.setupRelations(agents);
      expect(relations.length).toBeGreaterThan(0);
    });
  });

  describe("Negotiation Summary Generation", () => {
    it("should generate comprehensive negotiation summaries", async () => {
      const hrAgent = createHRAgent({ llm: mockLlm });
      const analysis = await hrAgent.receiveMissionBrief(missionBrief);
      const roleSpecs = await hrAgent.generateRoleSpecs(testMissionId, analysis);
      const teamProposal = await hrAgent.proposeTeam(testMissionId, roleSpecs);

      const negotiationService = createNegotiationService({ llm: mockLlm });
      const ownerContext = {
        ownerAgentId: createId("owner"),
        preferences: {
          teamSize: [2, 5] as [number, number],
          maxBudget: { maxRuntimeMinutes: 500, maxTasks: 20 },
          preferredCapabilities: ["development"],
          avoidCapabilities: [],
        },
        constraints: [],
        previousFeedback: [],
      };

      const negotiation = await negotiationService.startNegotiation(
        teamProposal,
        ownerContext,
      );

      const summary = await negotiationService.generateNegotiationSummary(
        negotiation,
      );

      expect(summary.outcome).toBeDefined();
      expect(summary.roundsCompleted).toBe(1);
      expect(summary.keyDecisions).toBeDefined();
      expect(Array.isArray(summary.keyDecisions)).toBe(true);

      // Test with failed negotiation
      const { createNegotiationMessage } = await import("@digitalagent/core");
      const rejectionMessage = createNegotiationMessage({
        senderId: ownerContext.ownerAgentId,
        receiverId: teamProposal.proposedBy,
        type: "rejection",
        content: {
          reason: "Not suitable",
        },
      });

      const failedNegotiation = await negotiationService.processRound(
        negotiation,
        rejectionMessage,
      );

      const failureSummary = await negotiationService.generateNegotiationSummary(
        failedNegotiation,
      );

      expect(failureSummary.outcome).toBe("failed");
      expect(failureSummary.failureReason).toBeDefined();
      expect(failureSummary.alternatives).toBeDefined();
      expect(Array.isArray(failureSummary.alternatives)).toBe(true);
    });
  });
});