import {
  createId,
  validateRoleSpec,
  type RoleSpec,
  type MissionBrief,
  type ValidationResult,
} from "@digitalagent/core";
import type { LlmMessage, LlmService } from "@digitalagent/runtime";

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
}

export function createHRAgent(options: HRAgentOptions) {
  const {
    llm,
    maxTeamSize = 8,
    preferredTeamSize = [2, 5],
    timeoutMs = 90000,
    idleTimeoutMs = 10000,
    onToken,
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
  ): Promise<{ analysis: MissionAnalysis; roleSpecs: RoleSpec[] }> {
    const systemPrompt = buildHRAgentSystemPrompt();
    const userPrompt = buildAnalyzeAndPlanPrompt(brief);

    try {
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
    } catch (error) {
      console.error(
        "[HR Agent] analyzeAndPlan failed, using fallback:",
        error instanceof Error ? error.message : String(error),
      );
      const fallbackAnalysis: MissionAnalysis = {
        ...fallbackMissionAnalysis(brief),
        missionGoal: brief.goal,
      };
      return {
        analysis: fallbackAnalysis,
        roleSpecs: fallbackRoleSpecs(missionId, fallbackAnalysis),
      };
    }
  }

  async function proposeTeam(
    missionId: string,
    roleSpecs: RoleSpec[],
    brief?: MissionBrief,
    options?: { useLlmSchedule?: boolean },
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
    const schedulePlan = brief && options?.useLlmSchedule === true
      ? await proposeSchedulePlan(brief, enforcedSpecs)
      : designSchedulePlan(enforcedSpecs, brief);

    return {
      missionId,
      roles: enforcedSpecs,
      proposedBy: `hr_${createId("agent")}`,
      totalBudget,
      estimatedDuration,
      riskAssessment,
      collaborationPlan,
      schedulePlan,
      createdAt: new Date(),
    };
  }

  async function proposeSchedulePlan(
    brief: MissionBrief,
    roleSpecs: RoleSpec[],
  ): Promise<SchedulePlanItem[]> {
    const fallback = designSchedulePlan(roleSpecs, brief);
    const systemPrompt = buildHRAgentSystemPrompt();
    const userPromptContent = buildSchedulePlanPrompt(brief, roleSpecs);

    try {
      const content = await llmCallStream([
        { role: "system", content: systemPrompt },
        { role: "user", content: userPromptContent },
      ]);
      const parsed = parseSchedulePlan(content, roleSpecs);
      return parsed.length > 0 ? parsed : fallback;
    } catch (error) {
      console.error("[HR Agent] schedulePlan generation failed, using fallback:", error instanceof Error ? error.message : String(error));
      return fallback;
    }
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
    "When proposing teams, also suggest a work rhythm:",
    "- Recommend periodic tasks based on the mission goal and roles",
    "- Consider each role's responsibilities when scheduling recurring work",
    "- If anomaly detection is needed, describe the trigger condition and responder",
    "",
    "Respond with structured JSON that can be parsed directly.",
    "Use Chinese for user-facing role names, purposes, responsibilities, risk factors, schedule names, and schedule task descriptions.",
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

function buildAnalyzeAndPlanPrompt(brief: MissionBrief): string {
  return [
    "Analyze this mission brief and propose a team in a single response.",
    "Return user-facing text fields in Chinese for: role name, purpose, responsibilities, success criteria, riskFactors.",
    "",
    `**Goal:** ${brief.goal}`,
    `**Scope:** ${brief.scope}`,
    `**Success Metrics:** ${brief.successMetrics.join(", ")}`,
    `**Constraints:** ${brief.constraints.join(", ")}`,
    `**Target Audience:** ${brief.targetAudience || "Not specified"}`,
    `**Timeline:** ${brief.timeline || "Not specified"}`,
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
    "- The roleSpecs MUST cover the priorityRoles from the analysis (one role per priority role).",
    "- Keep team size between 2 and 5 unless the brief clearly demands otherwise.",
    "- Each role must have non-empty responsibilities, allowedTools, successCriteria, and a positive budget.",
  ].join("\n");
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

function designSchedulePlan(roleSpecs: RoleSpec[], brief?: MissionBrief): SchedulePlanItem[] {
  const primaryRole = roleSpecs[0];
  if (!primaryRole) return [];

  const missionText = brief
    ? `${brief.goal} ${brief.scope} ${brief.successMetrics.join(" ")} ${brief.constraints.join(" ")}`
    : "";
  const monitoringRole = roleSpecs.find((spec) =>
    /analyst|data|metric|monitor|research/i.test(roleSearchText(spec)),
  ) ?? primaryRole;
  const executionRole = roleSpecs.find((spec) =>
    /content|writer|creator|operator|execution|growth/i.test(roleSearchText(spec)),
  ) ?? primaryRole;

  const isXiaohongshu = /xiaohongshu|小红书|rednote/i.test(missionText);

  const plan: SchedulePlanItem[] = isXiaohongshu
    ? [
        {
          name: "Daily Xiaohongshu data check",
          cronExpression: "0 9 * * *",
          assigneeRole: monitoringRole.id,
          taskDescription: "Check yesterday's Xiaohongshu follower, engagement, and content performance data",
          justification: "Daily platform metrics are required to spot content performance changes early.",
        },
        {
          name: "Biweekly Xiaohongshu strategy review",
          cronExpression: "0 10 */14 * *",
          assigneeRole: executionRole.id,
          taskDescription: "Review two weeks of Xiaohongshu results and revise the content growth plan",
          justification: "A biweekly cadence is long enough to see content pattern signal without delaying strategy changes.",
        },
        {
          name: "Engagement drop alert",
          assigneeRole: monitoringRole.id,
          taskDescription: "Investigate Xiaohongshu engagement drop and propose corrective actions",
          justification: "Sudden engagement drops need immediate analysis outside the normal reporting cadence.",
          conditionDescription: "Engagement rate drops more than 20% compared with the previous period",
          conditionSourceRole: monitoringRole.id,
          conditionEvaluatePrompt: "Return true only if the artifact shows Xiaohongshu engagement rate dropped more than 20% compared with the previous period.",
        },
      ]
    : [
        {
          name: "Daily progress check",
          cronExpression: "0 9 * * *",
          assigneeRole: monitoringRole.id,
          taskDescription: `Review mission progress and report blockers for ${monitoringRole.name}`,
          justification: "Daily review keeps long-running missions from drifting without feedback.",
        },
      ];

  if (!isXiaohongshu && (roleSpecs.length > 1 || executionRole.id !== monitoringRole.id)) {
    plan.push({
      name: "Weekly execution review",
      cronExpression: "0 10 * * 1",
      assigneeRole: executionRole.id,
      taskDescription: `Summarize weekly execution results and propose next actions for ${executionRole.name}`,
      justification: "Weekly synthesis turns recurring work into concrete next-step decisions.",
    });
  }

  return plan;
}

function roleSearchText(spec: RoleSpec): string {
  return `${spec.id} ${spec.name} ${spec.purpose} ${spec.responsibilities.join(" ")}`;
}

function buildSchedulePlanPrompt(brief: MissionBrief, roleSpecs: RoleSpec[]): string {
  return [
    "Create a mission-specific schedulePlan for this team.",
    "",
    `Goal: ${brief.goal}`,
    `Scope: ${brief.scope}`,
    `Success metrics: ${brief.successMetrics.join(", ")}`,
    `Constraints: ${brief.constraints.join(", ")}`,
    `Timeline: ${brief.timeline ?? "Not specified"}`,
    "",
    "Roles:",
    JSON.stringify(roleSpecs.map((spec) => ({
      id: spec.id,
      name: spec.name,
      purpose: spec.purpose,
      responsibilities: spec.responsibilities,
    })), null, 2),
    "",
    "Return a JSON array of schedule items. Use role ids exactly as assigneeRole/source role.",
    "Each item must contain name, assigneeRole, taskDescription, justification.",
    "For periodic tasks include cronExpression using five-field cron only, and optional timezone.",
    "For condition triggers omit cronExpression and include conditionDescription, conditionSourceRole, conditionEvaluatePrompt.",
  ].join("\n");
}

function parseSchedulePlan(content: string, roleSpecs: RoleSpec[]): SchedulePlanItem[] {
  const json = extractJson(content, "array");
  if (!json) return [];

  const parsed = JSON.parse(json) as unknown;
  if (!Array.isArray(parsed)) return [];

  const roleIds = new Set(roleSpecs.map((spec) => spec.id));
  return parsed.flatMap((item): SchedulePlanItem[] => {
    if (!item || typeof item !== "object") return [];
    const candidate = item as Record<string, unknown>;
    const name = nonEmptyString(candidate.name);
    const assigneeRole = nonEmptyString(candidate.assigneeRole);
    const taskDescription = nonEmptyString(candidate.taskDescription);
    const justification = nonEmptyString(candidate.justification);
    if (!name || !assigneeRole || !taskDescription || !justification || !roleIds.has(assigneeRole)) {
      return [];
    }

    const cronExpression = optionalString(candidate.cronExpression);
    if (cronExpression) {
      const timezone = optionalString(candidate.timezone);
      return [{
        name,
        cronExpression,
        ...(timezone === undefined ? {} : { timezone }),
        assigneeRole,
        taskDescription,
        justification,
      }];
    }

    const conditionDescription = nonEmptyString(candidate.conditionDescription);
    const conditionSourceRole = nonEmptyString(candidate.conditionSourceRole);
    const conditionEvaluatePrompt = nonEmptyString(candidate.conditionEvaluatePrompt);
    if (!conditionDescription || !conditionSourceRole || !conditionEvaluatePrompt || !roleIds.has(conditionSourceRole)) {
      return [];
    }
    return [{
      name,
      assigneeRole,
      taskDescription,
      justification,
      conditionDescription,
      conditionSourceRole,
      conditionEvaluatePrompt,
    }];
  });
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
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
