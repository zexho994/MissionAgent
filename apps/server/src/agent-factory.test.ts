import { describe, it, expect, beforeEach } from "vitest";
import {
  createId,
  type RoleSpec,
  type AgentPersona,
  type AgentTemplate,
  type TeamContext,
} from "@digitalagent/core";
import {
  createAgentFactory,
  type AgentFactory,
  type WarRoomAgent,
  type AgentRelation,
} from "./agent-factory.js";

describe("AgentFactory", () => {
  let agentFactory: AgentFactory;
  let mockRoleSpec: RoleSpec;

  beforeEach(() => {
    agentFactory = createAgentFactory();

    mockRoleSpec = {
      id: "role-1",
      name: "System Architect",
      purpose: "Design system architecture and define technical specifications",
      responsibilities: [
        "Design system architecture",
        "Define component interfaces",
        "Create technical documentation",
        "Review implementation proposals",
      ],
      allowedTools: ["code_editor", "diagram_generator", "documentation_tools"],
      inputContract: {
        requirements: "array",
        constraints: "array",
      },
      outputContract: {
        architecture: "object",
        specifications: "array",
        documentation: "string",
      },
      successCriteria: [
        "Architecture approved by stakeholders",
        "Technical specifications complete",
        "Documentation reviewed",
      ],
      budget: {
        maxRuntimeMinutes: 120,
        maxTasks: 5,
      },
    };
  });

  describe("createAgentFromRoleSpec", () => {
    it("should create WarRoomAgent from RoleSpec", () => {
      const agent = agentFactory.createAgentFromRoleSpec(
        "mission-123",
        mockRoleSpec,
        1,
      );

      expect(agent.missionId).toBe("mission-123");
      expect(agent.role).toBe(mockRoleSpec.id);
      expect(agent.name).toBe(mockRoleSpec.name);
      expect(agent.responsibility).toBe(mockRoleSpec.purpose);
      expect(agent.status).toBe("idle");
      expect(agent.avatarSeed).toBeDefined();
      expect(agent.sortOrder).toBe(1);
    });

    it("should assign unique ID to each agent", () => {
      const agent1 = agentFactory.createAgentFromRoleSpec(
        "mission-123",
        mockRoleSpec,
        1,
      );
      const agent2 = agentFactory.createAgentFromRoleSpec(
        "mission-123",
        mockRoleSpec,
        2,
      );

      expect(agent1.id).not.toBe(agent2.id);
      expect(agent1.id).toMatch(/^agent_/);
      expect(agent2.id).toMatch(/^agent_/);
    });

    it("should map role spec capabilities to agent permissions", () => {
      const agent = agentFactory.createAgentFromRoleSpec(
        "mission-123",
        mockRoleSpec,
        1,
      );

      expect(agent.toolPermissions).toEqual(mockRoleSpec.allowedTools);
    });

    it("should include role spec budget in agent configuration", () => {
      const agent = agentFactory.createAgentFromRoleSpec(
        "mission-123",
        mockRoleSpec,
        1,
      );

      expect(agent.budget).toEqual(mockRoleSpec.budget);
    });

    it("should set appropriate initial status and last action", () => {
      const agent = agentFactory.createAgentFromRoleSpec(
        "mission-123",
        mockRoleSpec,
        1,
      );

      expect(agent.status).toBe("idle");
      expect(agent.lastAction).toBe("Waiting for task assignment");
      expect(agent.currentTaskId).toBeUndefined();
    });
  });

  describe("generateSystemPrompt", () => {
    it("should generate personalized system prompt from role spec", () => {
      const persona: AgentPersona = {
        id: "persona-1",
        name: "Analytical Architect",
        personality: "analytical",
        communicationStyle: "formal",
        decisionMaking: "data-driven",
        systemPrompt:
          "You are a systematic architect who approaches problems with rigorous analysis.",
        createdAt: new Date(),
      };

      const prompt = agentFactory.generateSystemPrompt(mockRoleSpec, persona);

      expect(prompt).toContain("System Architect");
      expect(prompt).toContain(mockRoleSpec.purpose);
      expect(prompt).toContain("Responsibilities"); // Capitalized
      expect(prompt).toContain("Success Criteria"); // Capitalized
      expect(prompt).toContain("analytical");
      expect(prompt).toContain("data-driven");
    });

    it("should include all responsibilities in prompt", () => {
      const persona: AgentPersona = {
        id: "persona-1",
        name: "Standard Persona",
        personality: "collaborative",
        communicationStyle: "neutral",
        decisionMaking: "balanced",
        systemPrompt: "You are a helpful agent.",
        createdAt: new Date(),
      };

      const prompt = agentFactory.generateSystemPrompt(mockRoleSpec, persona);

      mockRoleSpec.responsibilities.forEach((responsibility) => {
        expect(prompt).toContain(responsibility);
      });
    });

    it("should include all success criteria in prompt", () => {
      const persona: AgentPersona = {
        id: "persona-1",
        name: "Standard Persona",
        personality: "collaborative",
        communicationStyle: "neutral",
        decisionMaking: "balanced",
        systemPrompt: "You are a helpful agent.",
        createdAt: new Date(),
      };

      const prompt = agentFactory.generateSystemPrompt(mockRoleSpec, persona);

      mockRoleSpec.successCriteria.forEach((criterion) => {
        expect(prompt).toContain(criterion);
      });
    });

    it("should incorporate contract specifications", () => {
      const persona: AgentPersona = {
        id: "persona-1",
        name: "Standard Persona",
        personality: "collaborative",
        communicationStyle: "neutral",
        decisionMaking: "balanced",
        systemPrompt: "You are a helpful agent.",
        createdAt: new Date(),
      };

      const prompt = agentFactory.generateSystemPrompt(mockRoleSpec, persona);

      expect(prompt).toContain("Input Contract"); // Capitalized
      expect(prompt).toContain("Output Contract"); // Capitalized
    });

    it("should adapt prompt based on persona", () => {
      const formalPersona: AgentPersona = {
        id: "persona-1",
        name: "Formal Architect",
        personality: "analytical",
        communicationStyle: "formal",
        decisionMaking: "data-driven",
        systemPrompt: "You maintain professional standards.",
        createdAt: new Date(),
      };

      const casualPersona: AgentPersona = {
        id: "persona-2",
        name: "Casual Architect",
        personality: "friendly",
        communicationStyle: "casual",
        decisionMaking: "intuitive",
        systemPrompt: "You keep things simple and direct.",
        createdAt: new Date(),
      };

      const formalPrompt = agentFactory.generateSystemPrompt(
        mockRoleSpec,
        formalPersona,
      );
      const casualPrompt = agentFactory.generateSystemPrompt(
        mockRoleSpec,
        casualPersona,
      );

      expect(formalPrompt).toContain("formal");
      expect(casualPrompt).toContain("casual");
      expect(formalPrompt).not.toBe(casualPrompt);
    });
  });

  describe("setupRelations", () => {
    it("should create agent relations based on role dependencies", () => {
      const agents: WarRoomAgent[] = [
        {
          id: "agent-1",
          missionId: "mission-123",
          role: "owner",
          name: "Owner",
          responsibility: "Oversee mission",
          status: "idle",
          currentTaskId: undefined,
          lastAction: "Waiting",
          avatarSeed: "owner",
          sortOrder: 0,
          toolPermissions: [],
          budget: { maxRuntimeMinutes: 180, maxTasks: 10 },
        },
        {
          id: "agent-2",
          missionId: "mission-123",
          role: "architect",
          name: "Architect",
          responsibility: "Design system",
          status: "idle",
          currentTaskId: undefined,
          lastAction: "Waiting",
          avatarSeed: "architect",
          sortOrder: 1,
          toolPermissions: ["code", "diagrams"],
          budget: { maxRuntimeMinutes: 120, maxTasks: 5 },
        },
        {
          id: "agent-3",
          missionId: "mission-123",
          role: "developer",
          name: "Developer",
          responsibility: "Implement features",
          status: "idle",
          currentTaskId: undefined,
          lastAction: "Waiting",
          avatarSeed: "developer",
          sortOrder: 2,
          toolPermissions: ["code"],
          budget: { maxRuntimeMinutes: 180, maxTasks: 8 },
        },
      ];

      const relations = agentFactory.setupRelations(agents);

      expect(relations.length).toBeGreaterThan(0);

      // Check that relations are properly structured
      relations.forEach((relation) => {
        expect(relation.id).toBeDefined();
        expect(relation.missionId).toBe("mission-123");
        expect(relation.fromAgentId).toBeDefined();
        expect(relation.toAgentId).toBeDefined();
        expect(relation.label).toBeDefined();
        expect(relation.status).toMatch(/^(active|waiting|done)$/);
        expect(relation.createdAt).toBeDefined();
      });
    });

    it("should establish owner to specialist relations", () => {
      const agents: WarRoomAgent[] = [
        {
          id: "agent-1",
          missionId: "mission-123",
          role: "owner",
          name: "Owner",
          responsibility: "Oversee mission",
          status: "idle",
          currentTaskId: undefined,
          lastAction: "Waiting",
          avatarSeed: "owner",
          sortOrder: 0,
          toolPermissions: [],
          budget: { maxRuntimeMinutes: 180, maxTasks: 10 },
        },
        {
          id: "agent-2",
          missionId: "mission-123",
          role: "researcher",
          name: "Researcher",
          responsibility: "Conduct research",
          status: "idle",
          currentTaskId: undefined,
          lastAction: "Waiting",
          avatarSeed: "researcher",
          sortOrder: 1,
          toolPermissions: ["web_search"],
          budget: { maxRuntimeMinutes: 60, maxTasks: 3 },
        },
      ];

      const relations = agentFactory.setupRelations(agents);

      const ownerToResearcher = relations.find(
        (r) => r.fromAgentId === "agent-1" && r.toAgentId === "agent-2",
      );

      expect(ownerToResearcher).toBeDefined();
      expect(ownerToResearcher?.label).toBeDefined();
      expect(ownerToResearcher?.status).toBe("active");
    });

    it("should establish sequential workflow relations", () => {
      const agents: WarRoomAgent[] = [
        {
          id: "agent-1",
          missionId: "mission-123",
          role: "researcher",
          name: "Researcher",
          responsibility: "Gather requirements",
          status: "idle",
          currentTaskId: undefined,
          lastAction: "Waiting",
          avatarSeed: "researcher",
          sortOrder: 0,
          toolPermissions: ["web_search"],
          budget: { maxRuntimeMinutes: 60, maxTasks: 3 },
        },
        {
          id: "agent-2",
          missionId: "mission-123",
          role: "architect",
          name: "Architect",
          responsibility: "Design based on research",
          status: "idle",
          currentTaskId: undefined,
          lastAction: "Waiting",
          avatarSeed: "architect",
          sortOrder: 1,
          toolPermissions: ["code", "diagrams"],
          budget: { maxRuntimeMinutes: 120, maxTasks: 5 },
        },
        {
          id: "agent-3",
          missionId: "mission-123",
          role: "developer",
          name: "Developer",
          responsibility: "Implement design",
          status: "idle",
          currentTaskId: undefined,
          lastAction: "Waiting",
          avatarSeed: "developer",
          sortOrder: 2,
          toolPermissions: ["code"],
          budget: { maxRuntimeMinutes: 180, maxTasks: 8 },
        },
      ];

      const relations = agentFactory.setupRelations(agents);

      // Check for sequential dependencies
      const researchToArchitect = relations.find(
        (r) => r.fromAgentId === "agent-1" && r.toAgentId === "agent-2",
      );
      const architectToDeveloper = relations.find(
        (r) => r.fromAgentId === "agent-2" && r.toAgentId === "agent-3",
      );

      expect(researchToArchitect).toBeDefined();
      expect(architectToDeveloper).toBeDefined();
    });

    it("should handle reviewer relations", () => {
      const agents: WarRoomAgent[] = [
        {
          id: "agent-1",
          missionId: "mission-123",
          role: "developer",
          name: "Developer",
          responsibility: "Implement features",
          status: "idle",
          currentTaskId: undefined,
          lastAction: "Waiting",
          avatarSeed: "developer",
          sortOrder: 0,
          toolPermissions: ["code"],
          budget: { maxRuntimeMinutes: 180, maxTasks: 8 },
        },
        {
          id: "agent-2",
          missionId: "mission-123",
          role: "reviewer",
          name: "Reviewer",
          responsibility: "Review implementation",
          status: "idle",
          currentTaskId: undefined,
          lastAction: "Waiting",
          avatarSeed: "reviewer",
          sortOrder: 1,
          toolPermissions: ["code_review"],
          budget: { maxRuntimeMinutes: 60, maxTasks: 5 },
        },
      ];

      const relations = agentFactory.setupRelations(agents);

      const developerToReviewer = relations.find(
        (r) => r.fromAgentId === "agent-1" && r.toAgentId === "agent-2",
      );

      expect(developerToReviewer).toBeDefined();
      expect(developerToReviewer?.label).toContain("review");
    });

    it("should create unique relation IDs", () => {
      const agents: WarRoomAgent[] = [
        {
          id: "agent-1",
          missionId: "mission-123",
          role: "owner",
          name: "Owner",
          responsibility: "Oversee",
          status: "idle",
          currentTaskId: undefined,
          lastAction: "Waiting",
          avatarSeed: "owner",
          sortOrder: 0,
          toolPermissions: [],
          budget: { maxRuntimeMinutes: 180, maxTasks: 10 },
        },
        {
          id: "agent-2",
          missionId: "mission-123",
          role: "specialist",
          name: "Specialist",
          responsibility: "Execute tasks",
          status: "idle",
          currentTaskId: undefined,
          lastAction: "Waiting",
          avatarSeed: "specialist",
          sortOrder: 1,
          toolPermissions: ["tools"],
          budget: { maxRuntimeMinutes: 120, maxTasks: 5 },
        },
      ];

      const relations = agentFactory.setupRelations(agents);
      const ids = new Set(relations.map((r) => r.id));

      expect(ids.size).toBe(relations.length);
      relations.forEach((relation) => {
        expect(relation.id).toMatch(/^relation_/);
      });
    });
  });

  describe("inferAgentPersona", () => {
    it("should infer appropriate persona from role spec", () => {
      const architectSpec: RoleSpec = {
        ...mockRoleSpec,
        name: "System Architect",
        purpose: "Design robust system architecture",
      };

      const persona = agentFactory.inferAgentPersona(architectSpec);

      expect(persona.personality).toBeDefined();
      expect(persona.communicationStyle).toBeDefined();
      expect(persona.decisionMaking).toBeDefined();
      expect(persona.systemPrompt).toContain("System Architect");
    });

    it("should adapt persona based on role responsibilities", () => {
      const creativeSpec: RoleSpec = {
        ...mockRoleSpec,
        name: "Content Creator",
        purpose: "Create engaging content for users",
        responsibilities: ["Write articles", "Design graphics", "Engage audience"],
      };

      const persona = agentFactory.inferAgentPersona(creativeSpec);

      expect(persona.personality).toMatch(/^(creative|friendly)$/);
      expect(persona.systemPrompt).toContain("Content Creator");
    });

    it("should default to balanced persona for generic roles", () => {
      const genericSpec: RoleSpec = {
        ...mockRoleSpec,
        name: "Assistant",
        purpose: "Help with various tasks",
        responsibilities: ["Support team", "Handle requests"],
      };

      const persona = agentFactory.inferAgentPersona(genericSpec);

      expect(persona).toBeDefined();
      expect(persona.decisionMaking).toBe("balanced");
    });
  });
});