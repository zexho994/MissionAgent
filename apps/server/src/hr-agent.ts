import {
  createId,
  validateRoleSpec,
  type RoleSpec,
  type MissionBrief,
  type MissionPlan,
  type ValidationResult,
} from "@digitalagent/core";
import type { LlmMessage, LlmService, ToolCallTraceEvent } from "@digitalagent/runtime";

export interface MissionAnalysis {
  missionGoal: string;
  requiredCapabilities: string[];
  estimatedTeamSize: number;
  priorityRoles: string[];
  complexity: "low" | "medium" | "high";
  riskFactors: string[];
}

export interface SchedulePlanItem {
  name: string;
  cronExpression?: string;
  timezone?: string;
  assigneeRole: string;
  taskDescription: string;
  justification: string;
  conditionDescription?: string;
  conditionSourceRole?: string;
  conditionEvaluatePrompt?: string;
  templateId?: string;
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
  schedulePlan: SchedulePlanItem[];
  createdAt: Date;
}

export interface HRAgentOptions {
  llm: LlmService;
  maxTeamSize?: number;
  preferredTeamSize?: [number, number];
  timeoutMs?: number;
  idleTimeoutMs?: number;
  onToken?: (token: string) => void;
  onToolEvent?: (event: ToolCallTraceEvent) => void;
}

export function createHRAgent(options: HRAgentOptions) {
  const {
    llm,
    maxTeamSize = 8,
    preferredTeamSize = [2, 5],
    timeoutMs = 90000,
    idleTimeoutMs = 10000,
    onToken,
    onToolEvent,
  } = options;

  return {
    receiveMissionBrief,
    generateRoleSpecs,
    analyzeAndPlan,
    proposeTeam,
    negotiateRoleSpec,
  };

  async function llmCallStream(
    messages: LlmMessage[],
  ): Promise<string> {
    let content = "";
    await llm.call(messages, {
      timeoutMs,
      idleTimeoutMs,
      onStream: (token: string) => {
        content += token;
        onToken?.(token);
      },
      ...(onToolEvent ? { onToolEvent } : {}),
    });
    return content;
  }

  async function receiveMissionBrief(brief: MissionBrief): Promise<MissionAnalysis> {
    const systemPrompt = buildHRAgentSystemPrompt();
    const userPrompt = buildMissionAnalysisPrompt(brief);

    try {
      const content = await llmCallStream([
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ]);

      const baseAnalysis = parseMissionAnalysis(content);
      return {
        ...baseAnalysis,
        missionGoal: brief.goal,
      } as MissionAnalysis;
    } catch (error) {
      console.error("[HR Agent] receiveMissionBrief failed, using fallback:", error instanceof Error ? error.message : String(error));
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
      const content = await llmCallStream([
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ]);

      const roleSpecs = parseRoleSpecs(content, missionId);

      for (const spec of roleSpecs) {
        const validation = validateRoleSpec(spec);
        if (!validation.isValid) {
          throw new Error(`Invalid role spec ${spec.name}: ${validation.errors.join(", ")}`);
        }
      }

      return roleSpecs;
    } catch (error) {
      console.error("[HR Agent] generateRoleSpecs failed, using fallback:", error instanceof Error ? error.message : String(error));
      return fallbackRoleSpecs(missionId, analysis);
    }
  }

  async function analyzeAndPlan(
    missionId: string,
    brief: MissionBrief,
    plan?: MissionPlan,
  ): Promise<{ analysis: MissionAnalysis; roleSpecs: RoleSpec[] }> {
    const systemPrompt = buildHRAgentSystemPrompt();
    const userPrompt = buildAnalyzeAndPlanPrompt(brief, plan);

    const content = await llmCallStream([
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ]);

    const json = extractJson(content, "object");
    if (!json) {
      throw new Error("No JSON object found in analyzeAndPlan response");
    }
    const parsed = JSON.parse(json) as {
      analysis?: unknown;
      roleSpecs?: unknown;
    };

    const analysis = buildAnalysis(parsed.analysis, brief);
    const roleSpecs = buildRoleSpecsFromArray(parsed.roleSpecs, missionId);
    if (roleSpecs.length === 0) {
      throw new Error("analyzeAndPlan response contained no valid roleSpecs");
    }
    for (const spec of roleSpecs) {
      const validation = validateRoleSpec(spec);
      if (!validation.isValid) {
        throw new Error(`Invalid role spec ${spec.name}: ${validation.errors.join(", ")}`);
      }
    }

    return { analysis, roleSpecs };
  }

  async function proposeTeam(
    missionId: string,
    roleSpecs: RoleSpec[],
    _brief?: MissionBrief,
  ): Promise<TeamProposal> {
    const enforcedSpecs = roleSpecs.length > maxTeamSize
      ? roleSpecs.slice(0, maxTeamSize)
      : roleSpecs;

    const totalBudget = enforcedSpecs.reduce(
      (acc, spec) => ({
        maxRuntimeMinutes: acc.maxRuntimeMinutes + spec.budget.maxRuntimeMinutes,
        maxTasks: acc.maxTasks + spec.budget.maxTasks,
      }),
      { maxRuntimeMinutes: 0, maxTasks: 0 },
    );

    const estimatedDuration = estimateDuration(totalBudget.maxRuntimeMinutes);
    const riskAssessment = assessRisks(enforcedSpecs);
    const collaborationPlan = designCollaborationPlan(enforcedSpecs);

    return {
      missionId,
      roles: enforcedSpecs,
      proposedBy: `hr_${createId("agent")}`,
      totalBudget,
      estimatedDuration,
      riskAssessment,
      collaborationPlan,
      schedulePlan: [],
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
      const content = await llmCallStream([
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ]);

      return parseNegotiationResponse(content, missionId, initialSpec);
    } catch (error) {
      console.error("[HR Agent] negotiateRoleSpec failed, using fallback:", error instanceof Error ? error.message : String(error));
      return fallbackNegotiation(initialSpec, ownerFeedback);
    }
  }
}

function buildHRAgentSystemPrompt(): string {
  return [
    "You are an experienced HR Agent for the DigitalAgent mission execution system.",
    "Your role is to analyze mission requirements and propose mission-internal agent teams.",
    "You have access to skill loading tools: list_skill_files and load_skill.",
    "Use load_skill with digitalagent/SKILL.md when you need DigitalAgent capability context.",
    "Do not expose skill loading details to the user.",
    "Do not assume the user wants to build an external software project unless they explicitly ask for software construction.",
    "Always consider:",
    "- Required skills and capabilities",
    "- Team size constraints (prefer 2-5 members)",
    "- Budget limitations",
    "- Role dependencies and collaboration needs",
    "- Risk factors and mitigation strategies",
    "- The platform can deploy multiple real runtime agents inside one mission.",
    "- If the mission asks for N agents to collaborate, propose N actual runtime participant roles unless the user explicitly asks for manager/coordinator-only roles.",
    "- Do not replace required participant agents with coordinators, supervisors, validators, or other meta roles.",
    "- Coordinator/reviewer roles may be added only when they do not reduce the required participant count.",
    "- The runtime exposes the capability list via the skill loader (see system directive for valid paths and load policy). Load at most 2-3 capability files relevant to this mission, then assign those tool names in each role's allowedTools.",
    "",
    "When proposing teams, ensure:",
    "- Each role has clear responsibilities",
    "- Success criteria are measurable",
    "- Tool permissions match each role's assigned mission responsibilities",
    "- Budget allocation is realistic",
    "",
    "角色命名必须使用具体业务岗位名（如\"小红书数据分析员\"、\"App Store 流量观察员\"、\"Python 代码审核员\"），禁止使用 Owner / HR / Manager / 协调者 这种泛化角色名。",
    "",
    "Respond with structured JSON that can be parsed directly.",
    "Use Chinese for user-facing role names, purposes, responsibilities, and risk factors.",
  ].join("\n");
}

function buildMissionAnalysisPrompt(brief: MissionBrief): string {
  return [
    "Analyze this mission brief and provide a comprehensive team analysis. Return user-facing text fields in Chinese:",
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
    "Generate detailed role specifications for this mission. Role names, purposes, responsibilities, and success criteria must be in Chinese:",
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
    '    "name": "中文角色名",',
    '    "purpose": "中文角色目标",',
    '    "responsibilities": ["中文职责1", "中文职责2"],',
    '    "capabilities": ["capability1", "capability2"],',
    '    "allowedTools": ["tool1", "tool2"],',
    '    "successCriteria": ["criterion1", "criterion2"],',
    '    "budget": { "maxRuntimeMinutes": 120, "maxTasks": 5 }',
    "  }",
    "]",
  ].join("\n");
}

function buildAnalyzeAndPlanPrompt(brief: MissionBrief, plan?: MissionPlan): string {
  const lines: string[] = [
    "Analyze this mission brief and propose a team in a single response.",
    "Return user-facing text fields in Chinese for: role name, purpose, responsibilities, success criteria, riskFactors.",
    "",
    `**Goal:** ${brief.goal}`,
    `**Scope:** ${brief.scope}`,
    `**Success Metrics:** ${brief.successMetrics.join(", ")}`,
    `**Constraints:** ${brief.constraints.join(", ")}`,
    `**Target Audience:** ${brief.targetAudience || "Not specified"}`,
    `**Timeline:** ${brief.timeline || "Not specified"}`,
  ];

  if (plan) {
    lines.push(
      "",
      "**Confirmed MissionPlan (authoritative team blueprint — your role list MUST staff every workstream below):**",
      "",
      "Workstreams:",
      ...plan.workstreams.map((ws, idx) =>
        `  ${idx + 1}. name="${ws.name}" | requiredRole="${ws.requiredRole}" | objective="${ws.objective}" | firstTaskGoal="${ws.firstTaskGoal}"`,
      ),
    );
    if (plan.scheduleRhythms.length > 0) {
      lines.push(
        "",
        "Schedule rhythms already designed by Owner (reuse, do not invent Daily/Weekly defaults):",
        ...plan.scheduleRhythms.map((r) => `  - ${r.name} · ${r.cadence} · owner=${r.ownerRole} · ${r.purpose}`),
      );
    }
    if (plan.reportingLines.length > 0) {
      lines.push(
        "",
        "Reporting lines:",
        ...plan.reportingLines.map((r) => `  - ${r.fromRole} → ${r.toRole} · ${r.cadence} · ${r.purpose}`),
      );
    }
  }

  lines.push(
    "",
    "Respond with a single JSON object that contains BOTH the mission analysis and the role specs:",
    "{",
    '  "analysis": {',
    '    "requiredCapabilities": ["capability1", "capability2"],',
    '    "estimatedTeamSize": 3,',
    '    "priorityRoles": ["role1", "role2"],',
    '    "complexity": "low" | "medium" | "high",',
    '    "riskFactors": ["risk1", "risk2"]',
    "  },",
    '  "roleSpecs": [',
    "    {",
    '      "name": "中文角色名",',
    '      "purpose": "中文角色目标",',
    '      "responsibilities": ["中文职责1", "中文职责2"],',
    '      "capabilities": ["capability1", "capability2"],',
    '      "allowedTools": ["tool1", "tool2"],',
    '      "successCriteria": ["中文成功标准"],',
    '      "budget": { "maxRuntimeMinutes": 120, "maxTasks": 5 }',
    "    }",
    "  ]",
    "}",
    "",
    "Constraints:",
  );

  if (plan) {
    lines.push(
      "- The MissionPlan above is authoritative. Each workstream's requiredRole MUST be staffed by at least one matching role in your roleSpecs.",
      "- If a workstream's requiredRole field encodes a range pattern such as 'Agent1-5', '玩家1-N', 'Worker1-3', or any text matching `\\w+\\d+-\\d+`, you MUST expand it into N separate peer roles (e.g. Agent1, Agent2, ..., Agent5), not collapse them into one role.",
      "- Peer roles in such a range share the same responsibilities but are distinct runtime participants — keep their names distinct.",
      "- Reuse the scheduleRhythms above instead of inventing generic Daily/Weekly check-ins; the rhythms below the team should reflect the Plan's cadences.",
      "- Team size may exceed 5 ONLY when the MissionPlan explicitly requires more participants (e.g. an Agent1-N range with N>3). Otherwise prefer 2–5.",
    );
  } else {
    lines.push(
      "- Keep team size between 2 and 5 unless the brief clearly demands otherwise.",
      "- If the brief explicitly asks for N participating agents, roleSpecs must contain N actual participant roles for that collaboration, not fewer meta roles.",
    );
  }

  lines.push(
    "- The roleSpecs MUST cover the priorityRoles from the analysis (one role per priority role).",
    "- Use coordinator, supervisor, validator, or reviewer roles only as additional roles when they do not replace required participants.",
    "- For collaborative or turn-based tasks, ensure the working roles' allowedTools list the actual tool names from the loaded capability files (typically file IO + agent handoff).",
    "- Each role must have non-empty responsibilities, allowedTools, successCriteria, and a positive budget.",
  );

  return lines.join("\n");
}

function buildNegotiationPrompt(spec: RoleSpec, feedback: string): string {
  return [
    "The owner provided feedback on this role specification. Adjust accordingly and keep user-facing fields in Chinese:",
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

function buildAnalysis(raw: unknown, brief: MissionBrief): MissionAnalysis {
  const candidate = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const complexityRaw = candidate.complexity;
  const complexity: MissionAnalysis["complexity"] =
    complexityRaw === "low" || complexityRaw === "high" ? complexityRaw : "medium";
  return {
    missionGoal: brief.goal,
    requiredCapabilities: stringArray(candidate.requiredCapabilities, ["general"]),
    estimatedTeamSize: typeof candidate.estimatedTeamSize === "number" && candidate.estimatedTeamSize > 0
      ? Math.floor(candidate.estimatedTeamSize)
      : 2,
    priorityRoles: stringArray(candidate.priorityRoles, ["generalist"]),
    complexity,
    riskFactors: stringArray(candidate.riskFactors, []),
  };
}

function buildRoleSpecsFromArray(raw: unknown, _missionId: string): RoleSpec[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
    .map((entry) => ({
      ...(entry as Omit<RoleSpec, "id" | "inputContract" | "outputContract"> & {
        inputContract?: Record<string, unknown>;
        outputContract?: Record<string, unknown>;
      }),
      id: createId("role"),
      inputContract: (entry.inputContract as Record<string, unknown> | undefined) ?? {},
      outputContract: (entry.outputContract as Record<string, unknown> | undefined) ?? {},
    }));
}

function stringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  const filtered = value.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "");
  return filtered.length > 0 ? filtered : fallback;
}

function parseMissionAnalysis(content: string): Omit<MissionAnalysis, "missionGoal"> & { missionGoal?: string } {
  try {
    const json = extractJson(content, "object");
    if (!json) {
      throw new Error("No JSON found in response");
    }

    const parsed = JSON.parse(json);

    return {
      requiredCapabilities: parsed.requiredCapabilities || [],
      estimatedTeamSize: parsed.estimatedTeamSize || 2,
      priorityRoles: parsed.priorityRoles || [],
      complexity: parsed.complexity || "medium",
      riskFactors: parsed.riskFactors || [],
    };
  } catch (error) {
    console.error("[HR Agent] Mission analysis parse failed:", error instanceof Error ? error.message : String(error));
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
    const json = extractJson(content, "array");
    if (!json) {
      throw new Error("No array found in response");
    }

    const parsed = JSON.parse(json);

    return parsed.map((spec: Omit<RoleSpec, "id" | "inputContract" | "outputContract"> & { inputContract?: Record<string, unknown>; outputContract?: Record<string, unknown> }) => ({
      ...spec,
      id: createId("role"),
      inputContract: spec.inputContract || {},
      outputContract: spec.outputContract || {},
    }));
  } catch (error) {
    console.error("[HR Agent] Role specs parse failed:", error instanceof Error ? error.message : String(error));
    return [];
  }
}

function parseNegotiationResponse(
  content: string,
  missionId: string,
  originalSpec: RoleSpec,
): RoleSpec | RoleSpec[] {
  try {
    const trimmed = content.trim();

    // If content starts with [, it's explicitly an array response
    if (trimmed.startsWith("[")) {
      const arrayJson = extractJson(content, "array");
      if (arrayJson) {
        const parsed = JSON.parse(arrayJson);
        if (Array.isArray(parsed) && parsed.length > 0 && parsed[0]?.name) {
          return parsed.map((spec) => ({
            ...spec,
            id: createId("role"),
            inputContract: spec.inputContract || {},
            outputContract: spec.outputContract || {},
          }));
        }
      }
    }

    // Otherwise try object — single revised role
    const objectJson = extractJson(content, "object");
    if (objectJson) {
      const parsed = JSON.parse(objectJson);
      if (parsed.name || parsed.purpose) {
        return {
          ...parsed,
          id: createId("role"),
          inputContract: parsed.inputContract || {},
          outputContract: parsed.outputContract || {},
        };
      }
    }

    return originalSpec;
  } catch (error) {
    console.error("[HR Agent] Negotiation response parse failed:", error instanceof Error ? error.message : String(error));
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
      name: "Mission 执行负责人",
      purpose: `执行 Mission：${analysis.missionGoal}`,
      responsibilities: [
        "分析任务要求",
        "执行核心任务",
        "复盘执行结果",
      ],
      allowedTools: ["web_search", "code_editor", "file_operations"],
      inputContract: { task: "string" },
      outputContract: { result: "object" },
      successCriteria: ["Mission 目标已达成"],
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
      name: `${spec.name}（主责）`,
      purpose: `${spec.purpose} - 主责范围`,
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
    risks.push("团队规模较大，可能增加协作成本");
  }

  const totalBudget = roleSpecs.reduce(
    (sum, spec) => sum + spec.budget.maxRuntimeMinutes,
    0,
  );

  if (totalBudget > 480) {
    risks.push("预算投入较高，可能超出约束");
  }

  const hasComplexTools = roleSpecs.some(spec =>
    spec.allowedTools.some(tool =>
      tool.includes("external") || tool.includes("api"),
    ),
  );

  if (hasComplexTools) {
    risks.push("外部依赖可能带来交付延迟");
  }

  return risks.length > 0 ? risks : ["存在常规项目风险，需要持续跟踪"];
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

export function extractJson(content: string, type: "object" | "array"): string | undefined {
  const opener = type === "object" ? "{" : "[";
  const closer = type === "object" ? "}" : "]";

  let depth = 0;
  let start = -1;

  for (let i = 0; i < content.length; i++) {
    if (content[i] === opener && (i === 0 || content[i - 1] !== "\\")) {
      if (depth === 0) start = i;
      depth++;
    } else if (content[i] === closer && (i === 0 || content[i - 1] !== "\\")) {
      depth--;
      if (depth === 0 && start >= 0) {
        const candidate = content.slice(start, i + 1);
        try {
          JSON.parse(candidate);
          return candidate;
        } catch {
          start = -1;
          continue;
        }
      }
    }
  }

  return undefined;
}
