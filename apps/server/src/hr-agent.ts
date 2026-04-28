import {
  createId,
  validateRoleSpec,
  type RoleSpec,
  type MissionBrief,
  type ValidationResult,
} from "@digitalagent/core";
import type { LlmService } from "@digitalagent/runtime";

export interface MissionAnalysis {
  missionGoal: string;
  requiredCapabilities: string[];
  estimatedTeamSize: number;
  priorityRoles: string[];
  complexity: "low" | "medium" | "high";
  riskFactors: string[];
}

export interface TeamProposal {
  missionId: string;
  roles: RoleSpec[];
  proposedBy: string;
  totalBudget: {
    maxRuntimeMinutes: number;
    maxTasks: number;
  };
  estimatedDuration: string;
  riskAssessment: string[];
  collaborationPlan: {
    workflow: string;
    communicationChannels: string[];
    decisionMaking: string;
  };
  createdAt: Date;
}

export interface HRAgentOptions {
  llm: LlmService;
  maxTeamSize?: number;
  preferredTeamSize?: [number, number];
}

export function createHRAgent(options: HRAgentOptions) {
  const {
    llm,
    maxTeamSize = 8,
    preferredTeamSize = [2, 5],
  } = options;

  return {
    receiveMissionBrief,
    generateRoleSpecs,
    proposeTeam,
    negotiateRoleSpec,
  };

  async function receiveMissionBrief(brief: MissionBrief): Promise<MissionAnalysis> {
    const systemPrompt = buildHRAgentSystemPrompt();
    const userPrompt = buildMissionAnalysisPrompt(brief);

    try {
      const response = await llm.call([
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ]);

      const baseAnalysis = parseMissionAnalysis(response.content);
      return {
        ...baseAnalysis,
        missionGoal: brief.goal,
      } as MissionAnalysis;
    } catch (error) {
      const fallback = fallbackMissionAnalysis(brief);
      return {
        ...fallback,
        missionGoal: brief.goal,
      } as MissionAnalysis;
    }
  }

  async function generateRoleSpecs(
    missionId: string,
    analysis: MissionAnalysis,
  ): Promise<RoleSpec[]> {
    const systemPrompt = buildHRAgentSystemPrompt();
    const userPrompt = buildRoleSpecsPrompt(missionId, analysis);

    try {
      const response = await llm.call([
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ]);

      const roleSpecs = parseRoleSpecs(response.content, missionId);

      for (const spec of roleSpecs) {
        const validation = validateRoleSpec(spec);
        if (!validation.isValid) {
          throw new Error(`Invalid role spec ${spec.name}: ${validation.errors.join(", ")}`);
        }
      }

      return roleSpecs;
    } catch (error) {
      return fallbackRoleSpecs(missionId, analysis);
    }
  }

  async function proposeTeam(
    missionId: string,
    roleSpecs: RoleSpec[],
  ): Promise<TeamProposal> {
    const totalBudget = roleSpecs.reduce(
      (acc, spec) => ({
        maxRuntimeMinutes: acc.maxRuntimeMinutes + spec.budget.maxRuntimeMinutes,
        maxTasks: acc.maxTasks + spec.budget.maxTasks,
      }),
      { maxRuntimeMinutes: 0, maxTasks: 0 },
    );

    const estimatedDuration = estimateDuration(totalBudget.maxRuntimeMinutes);
    const riskAssessment = assessRisks(roleSpecs);
    const collaborationPlan = designCollaborationPlan(roleSpecs);

    return {
      missionId,
      roles: roleSpecs,
      proposedBy: `hr_${createId("agent")}`,
      totalBudget,
      estimatedDuration,
      riskAssessment,
      collaborationPlan,
      createdAt: new Date(),
    };
  }

  async function negotiateRoleSpec(
    missionId: string,
    initialSpec: RoleSpec,
    ownerFeedback: string,
  ): Promise<RoleSpec | RoleSpec[]> {
    const systemPrompt = buildHRAgentSystemPrompt();
    const userPrompt = buildNegotiationPrompt(initialSpec, ownerFeedback);

    try {
      const response = await llm.call([
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ]);

      return parseNegotiationResponse(response.content, missionId, initialSpec);
    } catch (error) {
      return fallbackNegotiation(initialSpec, ownerFeedback);
    }
  }
}

function buildHRAgentSystemPrompt(): string {
  return [
    "You are an experienced HR Agent specializing in team assembly for software projects.",
    "Your role is to analyze mission requirements and propose optimal team compositions.",
    "Always consider:",
    "- Required skills and capabilities",
    "- Team size constraints (prefer 2-5 members)",
    "- Budget limitations",
    "- Role dependencies and collaboration needs",
    "- Risk factors and mitigation strategies",
    "",
    "When proposing teams, ensure:",
    "- Each role has clear responsibilities",
    "- Success criteria are measurable",
    "- Tool permissions are appropriate",
    "- Budget allocation is realistic",
    "",
    "Respond with structured JSON that can be parsed directly.",
  ].join("\n");
}

function buildMissionAnalysisPrompt(brief: MissionBrief): string {
  return [
    "Analyze this mission brief and provide a comprehensive team analysis:",
    "",
    `**Goal:** ${brief.goal}`,
    `**Scope:** ${brief.scope}`,
    `**Success Metrics:** ${brief.successMetrics.join(", ")}`,
    `**Constraints:** ${brief.constraints.join(", ")}`,
    `**Target Audience:** ${brief.targetAudience || "Not specified"}`,
    `**Timeline:** ${brief.timeline || "Not specified"}`,
    "",
    "Provide a JSON response with this structure:",
    "{",
    '  "requiredCapabilities": ["capability1", "capability2"],',
    '  "estimatedTeamSize": 3,',
    '  "priorityRoles": ["role1", "role2"],',
    '  "complexity": "medium",',
    '  "riskFactors": ["risk1", "risk2"]',
    "}",
  ].join("\n");
}

function buildRoleSpecsPrompt(missionId: string, analysis: MissionAnalysis): string {
  return [
    "Generate detailed role specifications for this mission:",
    "",
    `**Mission Goal:** ${analysis.missionGoal}`,
    `**Required Capabilities:** ${analysis.requiredCapabilities.join(", ")}`,
    `**Team Size:** ${analysis.estimatedTeamSize}`,
    `**Priority Roles:** ${analysis.priorityRoles.join(", ")}`,
    `**Complexity:** ${analysis.complexity}`,
    "",
    "Provide an array of role specifications with this structure:",
    "[",
    "  {",
    '    "name": "Role Name",',
    '    "purpose": "Role purpose statement",',
    '    "responsibilities": ["responsibility1", "responsibility2"],',
    '    "capabilities": ["capability1", "capability2"],',
    '    "allowedTools": ["tool1", "tool2"],',
    '    "successCriteria": ["criterion1", "criterion2"],',
    '    "budget": { "maxRuntimeMinutes": 120, "maxTasks": 5 }',
    "  }",
    "]",
  ].join("\n");
}

function buildNegotiationPrompt(spec: RoleSpec, feedback: string): string {
  return [
    "The owner provided feedback on this role specification. Adjust accordingly:",
    "",
    `**Current Role:** ${spec.name}`,
    `**Purpose:** ${spec.purpose}`,
    `**Responsibilities:** ${spec.responsibilities.join(", ")}`,
    `**Budget:** ${spec.budget.maxRuntimeMinutes}min, ${spec.budget.maxTasks} tasks`,
    "",
    `**Owner Feedback:** ${feedback}`,
    "",
    "If the feedback suggests splitting the role, return an array of alternative roles.",
    "If the feedback suggests adjustments, return a single revised role.",
    "",
    "Response format:",
    "- For revision: { revised role object }",
    "- For split: [ { role1 }, { role2 } ]",
  ].join("\n");
}

function parseMissionAnalysis(content: string): Omit<MissionAnalysis, "missionGoal"> & { missionGoal?: string } {
  try {
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error("No JSON found in response");
    }

    const parsed = JSON.parse(jsonMatch[0]);

    return {
      requiredCapabilities: parsed.requiredCapabilities || [],
      estimatedTeamSize: parsed.estimatedTeamSize || 2,
      priorityRoles: parsed.priorityRoles || [],
      complexity: parsed.complexity || "medium",
      riskFactors: parsed.riskFactors || [],
    };
  } catch (error) {
    return {
      requiredCapabilities: ["general"],
      estimatedTeamSize: 2,
      priorityRoles: ["generalist"],
      complexity: "medium",
      riskFactors: [],
    };
  }
}

function parseRoleSpecs(content: string, missionId: string): RoleSpec[] {
  try {
    const jsonMatch = content.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      throw new Error("No array found in response");
    }

    const parsed = JSON.parse(jsonMatch[0]);

    return parsed.map((spec: Omit<RoleSpec, "id" | "inputContract" | "outputContract"> & { inputContract?: Record<string, unknown>; outputContract?: Record<string, unknown> }) => ({
      ...spec,
      id: createId("role"),
      inputContract: spec.inputContract || {},
      outputContract: spec.outputContract || {},
    }));
  } catch (error) {
    return [];
  }
}

function parseNegotiationResponse(
  content: string,
  missionId: string,
  originalSpec: RoleSpec,
): RoleSpec | RoleSpec[] {
  try {
    const arrayMatch = content.match(/\[[\s\S]*\]/);
    const objectMatch = content.match(/\{[\s\S]*\}/);

    if (arrayMatch) {
      const parsed = JSON.parse(arrayMatch[0]);
      if (Array.isArray(parsed)) {
        return parsed.map((spec) => ({
          ...spec,
          id: createId("role"),
          inputContract: spec.inputContract || {},
          outputContract: spec.outputContract || {},
        }));
      }
    }

    if (objectMatch) {
      const parsed = JSON.parse(objectMatch[0]);
      return {
        ...parsed,
        id: createId("role"),
        inputContract: parsed.inputContract || {},
        outputContract: parsed.outputContract || {},
      };
    }

    return originalSpec;
  } catch (error) {
    return originalSpec;
  }
}

function fallbackMissionAnalysis(brief: MissionBrief): Omit<MissionAnalysis, "missionGoal"> {
  const capabilities = new Set<string>();
  const goalLower = brief.goal.toLowerCase();

  if (goalLower.includes("research") || goalLower.includes("分析")) {
    capabilities.add("research");
  }
  if (goalLower.includes("develop") || goalLower.includes("code") || goalLower.includes("开发")) {
    capabilities.add("development");
  }
  if (goalLower.includes("design") || goalLower.includes("设计")) {
    capabilities.add("design");
  }
  if (goalLower.includes("test") || goalLower.includes("测试")) {
    capabilities.add("testing");
  }

  return {
    requiredCapabilities: Array.from(capabilities).length > 0
      ? Array.from(capabilities)
      : ["general"],
    estimatedTeamSize: Math.min(Math.max(brief.successMetrics.length, 2), 5),
    priorityRoles: ["generalist"],
    complexity: "medium",
    riskFactors: [],
  };
}

function fallbackRoleSpecs(missionId: string, analysis: MissionAnalysis): RoleSpec[] {
  return [
    {
      id: createId("role"),
      name: "Mission Operator",
      purpose: `Execute the mission: ${analysis.missionGoal}`,
      responsibilities: [
        "Analyze requirements",
        "Execute primary tasks",
        "Review results",
      ],
      allowedTools: ["web_search", "code_editor", "file_operations"],
      inputContract: { task: "string" },
      outputContract: { result: "object" },
      successCriteria: ["Mission objectives met"],
      budget: {
        maxRuntimeMinutes: 120,
        maxTasks: 5,
      },
    },
  ];
}

function fallbackNegotiation(spec: RoleSpec, feedback: string): RoleSpec {
  const feedbackLower = feedback.toLowerCase();

  if (feedbackLower.includes("split") || feedbackLower.includes("separate")) {
    const midPoint = Math.floor(spec.responsibilities.length / 2);

    return {
      ...spec,
      id: createId("role"),
      name: `${spec.name} (Primary)`,
      purpose: `${spec.purpose} - Primary focus`,
      responsibilities: spec.responsibilities.slice(0, midPoint),
      budget: {
        maxRuntimeMinutes: Math.max(Math.floor(spec.budget.maxRuntimeMinutes * 0.6), 30),
        maxTasks: Math.max(Math.floor(spec.budget.maxTasks * 0.6), 1),
      },
    };
  }

  if (feedbackLower.includes("reduce") || feedbackLower.includes("less")) {
    return {
      ...spec,
      id: createId("role"),
      budget: {
        maxRuntimeMinutes: Math.max(Math.floor(spec.budget.maxRuntimeMinutes * 0.7), 30),
        maxTasks: Math.max(Math.floor(spec.budget.maxTasks * 0.7), 1),
      },
    };
  }

  return spec;
}

function estimateDuration(totalMinutes: number): string {
  if (totalMinutes < 60) {
    return `${totalMinutes} minutes`;
  }
  const hours = Math.round(totalMinutes / 60);
  if (hours < 24) {
    return `${hours} hours`;
  }
  const days = Math.round(hours / 24);
  return `${days} days`;
}

function assessRisks(roleSpecs: RoleSpec[]): string[] {
  const risks: string[] = [];

  if (roleSpecs.length > 6) {
    risks.push("Large team size may slow coordination");
  }

  const totalBudget = roleSpecs.reduce(
    (sum, spec) => sum + spec.budget.maxRuntimeMinutes,
    0,
  );

  if (totalBudget > 480) {
    risks.push("High budget allocation may exceed constraints");
  }

  const hasComplexTools = roleSpecs.some(spec =>
    spec.allowedTools.some(tool =>
      tool.includes("external") || tool.includes("api"),
    ),
  );

  if (hasComplexTools) {
    risks.push("External dependencies may introduce delays");
  }

  return risks.length > 0 ? risks : ["Standard project risks apply"];
}

function designCollaborationPlan(roleSpecs: RoleSpec[]) {
  const workflow = roleSpecs.length > 3 ? "Collaborative" : "Sequential";
  const communicationChannels = ["Direct messages"];

  if (roleSpecs.length > 2) {
    communicationChannels.push("Shared workspace");
  }

  const decisionMaking = roleSpecs.some(spec =>
    spec.name.includes("Architect") || spec.name.includes("Lead"),
  )
    ? "Lead-driven"
    : "Consensus";

  return {
    workflow,
    communicationChannels,
    decisionMaking,
  };
}