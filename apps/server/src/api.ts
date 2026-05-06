import { createScheduleRule, type ScheduleRule, type Source } from "@digitalagent/core";
import type { OpenClawCliAdapter } from "@digitalagent/runtime";
import type { InMemoryMissionService, ScheduleTemplateRequest } from "./mission-service.js";

export interface ApiRequest {
  method: string;
  path: string;
  body?: unknown;
}

export interface ApiResponse {
  status: number;
  body: unknown;
}

export interface ApiDependencies {
  missions: InMemoryMissionService;
  openclaw: Pick<OpenClawCliAdapter, "health" | "runAgentTask">;
}

export async function handleApiRequest(
  request: ApiRequest,
  deps: ApiDependencies,
): Promise<ApiResponse> {
  try {
    if (request.method === "GET" && request.path === "/api/health") {
      const snapshot = deps.missions.snapshot();
      return json(200, {
        ok: true,
        openclaw: await deps.openclaw.health(),
        counts: {
          missions: snapshot.missions.length,
          tasks: snapshot.tasks.length,
          artifacts: snapshot.artifacts.length,
          reviews: snapshot.reviews.length,
          executions: snapshot.executions.length,
        },
      });
    }

    if (request.method === "GET" && request.path === "/api/snapshot") {
      return json(200, deps.missions.snapshot());
    }

    if (request.method === "GET" && request.path === "/api/config") {
      return json(200, deps.missions.publicConfig());
    }

    if (request.method === "POST" && request.path === "/api/missions") {
      const body = expectObject(request.body);
      const createMissionInput: {
        goal: string;
        successMetrics?: string[];
        constraints?: string[];
      } = {
        goal: expectString(body.goal, "goal"),
      };
      if (body.successMetrics !== undefined) {
        createMissionInput.successMetrics = expectStringArray(body.successMetrics, "successMetrics");
      }
      if (body.constraints !== undefined) {
        createMissionInput.constraints = expectStringArray(body.constraints, "constraints");
      }
      const mission = await deps.missions.createMission(createMissionInput);
      return json(201, { mission, snapshot: deps.missions.snapshot() });
    }

    if (request.method === "POST" && request.path === "/api/missions/continue") {
      const body = expectObject(request.body);
      const mission = await deps.missions.continueMission({
        missionId: expectString(body.missionId, "missionId"),
        message: expectString(body.message, "message"),
      });
      return json(200, { mission, snapshot: deps.missions.snapshot() });
    }

    if (request.method === "POST" && request.path === "/api/missions/activate") {
      const body = expectObject(request.body);
      const mission = await deps.missions.activateMissionWithHR({
        missionId: expectString(body.missionId, "missionId"),
      });
      return json(200, { mission, snapshot: deps.missions.snapshot() });
    }

    if (request.method === "POST" && request.path === "/api/missions/activate-async") {
      const body = expectObject(request.body);
      const missionId = expectString(body.missionId, "missionId");
      const mission = deps.missions.beginMissionActivation({ missionId });
      setTimeout(() => {
        void deps.missions.activateMissionWithHR({ missionId }).catch((error: unknown) => {
          console.error("[API] Async mission activation failed:", error instanceof Error ? error.message : String(error));
        });
      }, 0);
      return json(202, { mission, snapshot: deps.missions.snapshot() });
    }

    if (request.method === "POST" && request.path === "/api/missions/negotiate/start") {
      const body = expectObject(request.body);
      const proposal = await deps.missions.startNegotiation({
        missionId: expectString(body.missionId, "missionId"),
      });
      return json(200, { proposal, snapshot: deps.missions.snapshot() });
    }

    if (request.method === "POST" && request.path === "/api/missions/negotiate/respond") {
      const body = expectObject(request.body);
      const result = await deps.missions.respondToNegotiation({
        missionId: expectString(body.missionId, "missionId"),
        feedback: expectString(body.feedback, "feedback"),
      });
      return json(200, { ...result, snapshot: deps.missions.snapshot() });
    }

    if (request.method === "POST" && request.path === "/api/missions/negotiate/confirm") {
      const body = expectObject(request.body);
      const mission = deps.missions.confirmNegotiation({
        missionId: expectString(body.missionId, "missionId"),
      });
      return json(200, { mission, snapshot: deps.missions.snapshot() });
    }

    if (request.method === "GET" && request.path.startsWith("/api/missions/") && request.path.endsWith("/negotiation")) {
      const missionId = request.path.split("/")[3];
      if (!missionId) {
        return json(400, { error: "Mission ID required" });
      }
      const negotiation = deps.missions.getNegotiation({ missionId });
      if (!negotiation) {
        return json(404, { error: "No active negotiation for this mission" });
      }
      return json(200, { negotiation });
    }

    if (request.method === "POST" && request.path === "/api/missions/confirm-brief") {
      const body = expectObject(request.body);
      const mission = deps.missions.confirmBrief({
        missionId: expectString(body.missionId, "missionId"),
      });
      return json(200, { mission, snapshot: deps.missions.snapshot() });
    }

    if (request.method === "POST" && request.path === "/api/missions/converse") {
      const body = expectObject(request.body);
      const message = await deps.missions.triggerAgentConversation({
        missionId: expectString(body.missionId, "missionId"),
        agentId: expectString(body.agentId, "agentId"),
        message: expectString(body.message, "message"),
      });
      return json(200, { message, snapshot: deps.missions.snapshot() });
    }

    if (request.method === "GET" && request.path.startsWith("/api/missions/threads?")) {
      const missionId = new URL(request.path, "http://digitalagent.local").searchParams.get("missionId");
      if (!missionId?.trim()) {
        return json(400, { error: "missionId query parameter is required" });
      }
      return json(200, { threads: deps.missions.listThreads({ missionId }) });
    }

    if (request.method === "GET" && request.path.startsWith("/api/missions/threads/")) {
      const threadId = request.path.split("/")[4];
      if (!threadId) {
        return json(400, { error: "Thread ID required" });
      }
      const result = deps.missions.getThread({ threadId });
      if (!result) {
        return json(404, { error: "Thread not found" });
      }
      return json(200, result);
    }

    if (request.method === "GET" && request.path.startsWith("/api/missions/knowledge?")) {
      const missionId = new URL(request.path, "http://digitalagent.local").searchParams.get("missionId");
      if (!missionId?.trim()) {
        return json(400, { error: "missionId query parameter is required" });
      }
      return json(200, { entries: deps.missions.listKnowledge({ missionId }) });
    }

    if (request.method === "POST" && request.path === "/api/missions/knowledge") {
      const body = expectObject(request.body);
      const entry = deps.missions.setKnowledge({
        missionId: expectString(body.missionId, "missionId"),
        key: expectString(body.key, "key"),
        value: expectString(body.value, "value"),
        agentId: expectString(body.agentId, "agentId"),
      });
      return json(201, { entry, snapshot: deps.missions.snapshot() });
    }

    if (request.method === "POST" && request.path === "/api/openclaw/run") {
      const body = expectObject(request.body);
      const missionId = expectString(body.missionId, "missionId");
      const taskId = expectString(body.taskId, "taskId");
      const message = expectString(body.message, "message");
      const snapshot = deps.missions.snapshot();
      const mission = snapshot.missions.find((candidate) => candidate.id === missionId);
      const task = snapshot.tasks.find((candidate) => candidate.id === taskId);
      if (!mission) {
        throw new Error(`Mission not found: ${missionId}`);
      }
      if (!task || task.missionId !== mission.id) {
        throw new Error(`Task not found in mission: ${taskId}`);
      }
      const execution = deps.missions.startExecution({ missionId, taskId });

      void deps.openclaw
        .runAgentTask({
          message: buildOpenClawMessage({ message, mission, task }),
          timeoutSeconds: 300,
        })
        .then((result) => {
          const sources = extractSourcesFromOpenClawOutput(result.output);
          deps.missions.submitExecutionResult({
            executionId: execution.id,
            missionId,
            taskId,
            content: {
              openclaw: result.output,
              stderr: result.stderr,
            },
            evidence: ["openclaw:local"],
            sources,
          });
        })
        .catch((error: unknown) => {
          deps.missions.failExecution({
            executionId: execution.id,
            error: error instanceof Error ? error.message : String(error),
          });
        });

      return json(202, { execution, snapshot: deps.missions.snapshot() });
    }

    const planMatch = request.path.match(/^\/api\/missions\/([^/]+)\/plan(?:\/(generate|confirm))?$/);
    if (planMatch) {
      const missionId = planMatch[1];
      const action = planMatch[2];
      if (!missionId) {
        return json(400, { error: "Mission ID required" });
      }

      if (request.method === "GET" && !action) {
        const plan = deps.missions.getMissionPlan({ missionId });
        return json(200, plan ? { plan } : {});
      }

      if (request.method === "POST" && action === "generate") {
        const body = expectObject(request.body ?? {});
        const feedback = body.feedback === undefined ? undefined : expectString(body.feedback, "feedback");
        const plan = await deps.missions.generateMissionPlan({
          missionId,
          ...(feedback !== undefined ? { feedback } : {}),
        });
        return json(200, { plan, snapshot: deps.missions.snapshot() });
      }

      if (request.method === "POST" && action === "confirm") {
        const body = expectObject(request.body);
        const planId = expectString(body.planId, "planId");
        const mission = deps.missions.confirmMissionPlan({ missionId, planId });
        const plan = deps.missions.getMissionPlan({ missionId });
        return json(200, { mission, plan, snapshot: deps.missions.snapshot() });
      }
    }

    const autopilotDiagnosisMatch = request.path.match(/^\/api\/missions\/([^/]+)\/autopilot-diagnosis$/);
    if (autopilotDiagnosisMatch) {
      const missionId = autopilotDiagnosisMatch[1];
      if (!missionId) {
        return json(400, { error: "Mission ID required" });
      }
      if (request.method === "GET") {
        const openclawHealth = await deps.openclaw.health();
        const diagnosis = deps.missions.getAutopilotDiagnosis(missionId, {
          hasExecutionRunner: openclawHealth.available,
        });
        return json(200, { diagnosis });
      }
    }

    const automationSummaryMatch = request.path.match(/^\/api\/missions\/([^/]+)\/automation-summary$/);
    if (automationSummaryMatch) {
      const missionId = automationSummaryMatch[1];
      if (!missionId) {
        return json(400, { error: "Mission ID required" });
      }
      if (request.method === "GET") {
        return json(200, { summary: deps.missions.getAutomationSummary(missionId) });
      }
    }

    const feedbackSummaryMatch = request.path.match(/^\/api\/missions\/([^/]+)\/feedback-summary$/);
    if (feedbackSummaryMatch) {
      const missionId = feedbackSummaryMatch[1];
      if (!missionId) {
        return json(400, { error: "Mission ID required" });
      }
      if (request.method === "GET") {
        return json(200, { summary: deps.missions.getFeedbackSummary(missionId) });
      }
    }

    const feedbackCollectionMatch = request.path.match(
      /^\/api\/missions\/([^/]+)\/feedback\/(evaluations|failure-analyses|strategy-adjustments)$/,
    );
    if (feedbackCollectionMatch) {
      const missionId = feedbackCollectionMatch[1];
      const collection = feedbackCollectionMatch[2];
      if (!missionId) {
        return json(400, { error: "Mission ID required" });
      }
      if (request.method === "GET" && collection === "evaluations") {
        return json(200, { evaluations: deps.missions.getMissionOutcomeEvaluations(missionId) });
      }
      if (request.method === "GET" && collection === "failure-analyses") {
        return json(200, { failureAnalyses: deps.missions.getTaskFailureAnalyses(missionId) });
      }
      if (request.method === "GET" && collection === "strategy-adjustments") {
        return json(200, { strategyAdjustments: deps.missions.getStrategyAdjustments(missionId) });
      }
    }

    const strategyAdjustmentStatusMatch = request.path.match(
      /^\/api\/missions\/([^/]+)\/feedback\/strategy-adjustments\/([^/]+)\/status$/,
    );
    if (strategyAdjustmentStatusMatch) {
      const missionId = strategyAdjustmentStatusMatch[1];
      const adjustmentId = strategyAdjustmentStatusMatch[2];
      if (!missionId || !adjustmentId) {
        return json(400, { error: "Mission ID and adjustment ID required" });
      }
      if (request.method === "PATCH") {
        const body = expectObject(request.body);
        const newStatus = expectString(body.status, "status");
        const validStatuses = ["proposed", "accepted", "rejected", "superseded"];
        if (!validStatuses.includes(newStatus)) {
          return json(400, { error: `Invalid status. Must be one of: ${validStatuses.join(", ")}` });
        }
        const updated = deps.missions.updateStrategyAdjustmentStatus(
          missionId,
          adjustmentId,
          newStatus as "proposed" | "accepted" | "rejected" | "superseded",
        );
        return json(200, { strategyAdjustment: updated, snapshot: deps.missions.snapshot() });
      }
    }

    const scheduleProductActionMatch = request.path.match(
      /^\/api\/missions\/([^/]+)\/schedule\/(trigger-next|templates|pause|resume)$/,
    );
    if (scheduleProductActionMatch) {
      const missionId = scheduleProductActionMatch[1];
      const action = scheduleProductActionMatch[2];
      if (!missionId) {
        return json(400, { error: "Mission ID required" });
      }

      if (request.method === "POST" && action === "trigger-next") {
        const task = deps.missions.triggerNextScheduleRule(missionId);
        return json(200, { task, snapshot: deps.missions.snapshot() });
      }

      if (request.method === "POST" && action === "templates") {
        const body = expectObject(request.body);
        const templateType = expectString(body.templateType, "templateType");
        let input: ScheduleTemplateRequest;
        if (templateType === "daily_check" || templateType === "weekly_review") {
          input = {
            templateType,
            assigneeRole: expectString(body.assigneeRole, "assigneeRole"),
            taskGoal: expectString(body.taskGoal, "taskGoal"),
          };
        } else if (templateType === "condition_response") {
          input = {
            templateType,
            sourceAgentRole: expectString(body.sourceAgentRole, "sourceAgentRole"),
            condition: expectString(body.condition, "condition"),
            responseAssigneeRole: expectString(body.responseAssigneeRole, "responseAssigneeRole"),
            responseTaskGoal: expectString(body.responseTaskGoal, "responseTaskGoal"),
          };
        } else {
          throw new Error(`Unsupported schedule template: ${templateType}`);
        }
        const rule = deps.missions.createScheduleRuleFromTemplate(missionId, input);
        return json(201, { rule, snapshot: deps.missions.snapshot() });
      }

      if (request.method === "POST" && action === "pause") {
        deps.missions.pauseMissionAutomation(missionId);
        return json(200, { summary: deps.missions.getAutomationSummary(missionId), snapshot: deps.missions.snapshot() });
      }

      if (request.method === "POST" && action === "resume") {
        deps.missions.resumeMissionAutomation(missionId);
        return json(200, { summary: deps.missions.getAutomationSummary(missionId), snapshot: deps.missions.snapshot() });
      }
    }

    const scheduleMatch = request.path.match(
      /^\/api\/missions\/([^/]+)\/schedule(?:\/([^/]+)(?:\/(trigger))?)?$/,
    );
    if (scheduleMatch) {
      const missionId = scheduleMatch[1];
      const ruleId = scheduleMatch[2];
      const action = scheduleMatch[3];

      if (!missionId) {
        return json(400, { error: "Mission ID required" });
      }

      if (request.method === "GET" && !ruleId) {
        const rules = deps.missions.getScheduleRules(missionId).map((rule) => ({
          ...rule,
          nextRunAt: deps.missions.getScheduleRuleNextRunAt(missionId, rule.id),
        }));
        return json(200, { rules });
      }

      if (request.method === "POST" && !ruleId) {
        const body = expectObject(request.body);
        const trigger = expectObject(body.trigger);
        const template = expectObject(body.taskTemplate);
        const contract = expectObject(template.contract);
        const triggerType = expectString(trigger.type, "trigger.type");

        if (triggerType !== "cron" && triggerType !== "condition") {
          return json(400, { error: "trigger must be cron or condition" });
        }

        const rule = createScheduleRule({
          name: expectString(body.name, "name"),
          missionId,
          enabled: body.enabled !== false,
          trigger: triggerType === "cron"
            ? {
                type: "cron",
                expression: expectString(trigger.expression, "trigger.expression"),
                timezone: expectString(trigger.timezone ?? "UTC", "trigger.timezone"),
              }
            : {
                type: "condition",
                description: expectString(trigger.description, "trigger.description"),
                sourceAgentRole: expectString(trigger.sourceAgentRole, "trigger.sourceAgentRole"),
                evaluatePrompt: expectString(trigger.evaluatePrompt, "trigger.evaluatePrompt"),
              },
          taskTemplate: {
            title: expectString(template.title, "taskTemplate.title"),
            contract: {
              objective: expectString(contract.objective, "taskTemplate.contract.objective"),
              input: expectRecord(contract.input ?? {}, "taskTemplate.contract.input"),
              outputSchema: expectRecord(contract.outputSchema ?? {}, "taskTemplate.contract.outputSchema"),
              successCriteria: expectStringArray(contract.successCriteria ?? [], "taskTemplate.contract.successCriteria"),
            },
            assigneeRole: expectString(template.assigneeRole, "taskTemplate.assigneeRole"),
            priority: parsePriority(template.priority),
          },
          maxConcurrent: typeof body.maxConcurrent === "number" ? body.maxConcurrent : 1,
          metadata: expectRecord(body.metadata ?? {}, "metadata"),
        });

        deps.missions.addScheduleRule(missionId, rule);
        return json(201, { rule, snapshot: deps.missions.snapshot() });
      }

      if (request.method === "PATCH" && ruleId && !action) {
        const body = expectObject(request.body);
        const existing = deps.missions.getScheduleRules(missionId).find((rule) => rule.id === ruleId);
        if (!existing) {
          throw new Error(`Schedule rule not found: ${ruleId}`);
        }
        const patch = parseScheduleRulePatch(body);
        deps.missions.updateScheduleRule(missionId, ruleId, patch);
        const updated = deps.missions.getScheduleRules(missionId).find((rule) => rule.id === ruleId);
        return json(200, { rule: updated, snapshot: deps.missions.snapshot() });
      }

      if (request.method === "DELETE" && ruleId && !action) {
        deps.missions.removeScheduleRule(missionId, ruleId);
        return json(200, { snapshot: deps.missions.snapshot() });
      }

      if (request.method === "POST" && ruleId && action === "trigger") {
        deps.missions.triggerScheduleRule(missionId, ruleId);
        return json(200, { triggered: true, snapshot: deps.missions.snapshot() });
      }
    }

    return json(404, { error: "Not found" });
  } catch (error) {
    return json(400, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function json(status: number, body: unknown): ApiResponse {
  return { status, body };
}

function expectObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Request body must be an object");
  }
  return value as Record<string, unknown>;
}

function expectString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function expectStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`${field} must be a string array`);
  }
  return [...value];
}

function expectRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function parsePriority(value: unknown): "low" | "normal" | "high" {
  if (value === "low" || value === "normal" || value === "high") {
    return value;
  }
  return "normal";
}

function parseScheduleRulePatch(body: Record<string, unknown>): Partial<ScheduleRule> {
  const allowed = new Set(["name", "enabled", "trigger", "taskTemplate", "maxConcurrent", "metadata"]);
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) {
      throw new Error(`Unsupported schedule patch field: ${key}`);
    }
  }

  const patch: Partial<ScheduleRule> = {};
  if (body.name !== undefined) {
    patch.name = expectString(body.name, "name");
  }
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== "boolean") {
      throw new Error("enabled must be a boolean");
    }
    patch.enabled = body.enabled;
  }
  if (body.trigger !== undefined) {
    const trigger = expectObject(body.trigger);
    const triggerType = expectString(trigger.type, "trigger.type");
    if (triggerType !== "cron" && triggerType !== "condition") {
      throw new Error("trigger must be cron or condition");
    }
    patch.trigger = triggerType === "cron"
      ? {
          type: "cron",
          expression: expectString(trigger.expression, "trigger.expression"),
          timezone: expectString(trigger.timezone, "trigger.timezone"),
        }
      : {
          type: "condition",
          description: expectString(trigger.description, "trigger.description"),
          sourceAgentRole: expectString(trigger.sourceAgentRole, "trigger.sourceAgentRole"),
          evaluatePrompt: expectString(trigger.evaluatePrompt, "trigger.evaluatePrompt"),
        };
  }
  if (body.taskTemplate !== undefined) {
    const template = expectObject(body.taskTemplate);
    const contract = expectObject(template.contract);
    patch.taskTemplate = {
      title: expectString(template.title, "taskTemplate.title"),
      contract: {
        objective: expectString(contract.objective, "taskTemplate.contract.objective"),
        input: expectRecord(contract.input ?? {}, "taskTemplate.contract.input"),
        outputSchema: expectRecord(contract.outputSchema ?? {}, "taskTemplate.contract.outputSchema"),
        successCriteria: expectStringArray(contract.successCriteria ?? [], "taskTemplate.contract.successCriteria"),
      },
      assigneeRole: expectString(template.assigneeRole, "taskTemplate.assigneeRole"),
      priority: parsePriority(template.priority),
    };
  }
  if (body.maxConcurrent !== undefined) {
    if (typeof body.maxConcurrent !== "number") {
      throw new Error("maxConcurrent must be a number");
    }
    patch.maxConcurrent = body.maxConcurrent;
  }
  if (body.metadata !== undefined) {
    patch.metadata = expectRecord(body.metadata, "metadata");
  }

  return patch;
}

function buildOpenClawMessage(input: {
  message: string;
  mission: unknown;
  task: unknown;
}): string {
  return [
    "You are executing a DigitalAgent Mission task.",
    "Use the mission context below. Do not look for local Mission files.",
    "Return one valid JSON object only.",
    "",
    "Mission context:",
    JSON.stringify(
      {
        mission: input.mission,
        task: input.task,
      },
      null,
      2,
    ),
    "",
    "User instruction:",
    input.message,
  ].join("\n");
}

/**
 * Extracts source information from OpenClaw agent output.
 * The OpenClaw output may contain search results in various formats:
 * - searchResults: Array of {url, title, snippet, searchKeyword}
 * - sources: Array of {url, title, snippet}
 * - webSearch: Object with searchKeyword and results
 */
function extractSourcesFromOpenClawOutput(output: unknown): Source[] {
  const sources: Source[] = [];

  if (!output || typeof output !== "object") {
    return sources;
  }

  const record = output as Record<string, unknown>;

  // Check for searchResults array
  const searchResults = record.searchResults as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(searchResults)) {
    for (const result of searchResults) {
      if (result.url && typeof result.url === "string") {
        const src: Source = { url: result.url };
        if (typeof result.title === "string") src.title = result.title;
        if (typeof result.snippet === "string") src.snippet = result.snippet;
        if (typeof result.searchKeyword === "string") src.searchKeyword = result.searchKeyword;
        sources.push(src);
      }
    }
    if (sources.length > 0) {
      return sources;
    }
  }

  // Check for sources array
  const directSources = record.sources as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(directSources)) {
    for (const source of directSources) {
      if (source.url && typeof source.url === "string") {
        const src: Source = { url: source.url };
        if (typeof source.title === "string") src.title = source.title;
        if (typeof source.snippet === "string") src.snippet = source.snippet;
        sources.push(src);
      }
    }
    if (sources.length > 0) {
      return sources;
    }
  }

  // Check for webSearch object
  const webSearch = record.webSearch as Record<string, unknown> | undefined;
  if (webSearch && typeof webSearch === "object") {
    const searchKeyword = typeof webSearch.searchKeyword === "string" ? webSearch.searchKeyword : undefined;
    const results = webSearch.results as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(results)) {
      for (const result of results) {
        if (result.url && typeof result.url === "string") {
          const src: Source = { url: result.url };
          if (typeof result.title === "string") src.title = result.title;
          if (typeof result.snippet === "string") src.snippet = result.snippet;
          if (searchKeyword) src.searchKeyword = searchKeyword;
          sources.push(src);
        }
      }
    }
  }

  // Check payloads for source references (common pattern in OpenClaw outputs)
  const payloads = record.payloads as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(payloads)) {
    for (const payload of payloads) {
      if (payload.sources && Array.isArray(payload.sources)) {
        for (const source of payload.sources as Array<Record<string, unknown>>) {
          if (source.url && typeof source.url === "string") {
            const src: { url: string; title?: string; snippet?: string } = { url: source.url };
            if (typeof source.title === "string") src.title = source.title;
            if (typeof source.snippet === "string") src.snippet = source.snippet;
            sources.push(src);
          }
        }
      }
      // Also check for searchResults within payload
      const payloadSearchResults = payload.searchResults as Array<Record<string, unknown>> | undefined;
      if (Array.isArray(payloadSearchResults)) {
        for (const result of payloadSearchResults) {
          if (result.url && typeof result.url === "string") {
            const src: { url: string; title?: string; snippet?: string; searchKeyword?: string } = { url: result.url };
            if (typeof result.title === "string") src.title = result.title;
            if (typeof result.snippet === "string") src.snippet = result.snippet;
            if (typeof result.searchKeyword === "string") src.searchKeyword = result.searchKeyword;
            sources.push(src);
          }
        }
      }
    }
  }

  return sources;
}
