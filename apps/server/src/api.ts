import { createScheduleRule, type ScheduleRule } from "@digitalagent/core";
import type { OpenClawCliAdapter } from "@digitalagent/runtime";
import type { InMemoryMissionService } from "./mission-service.js";

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
          deps.missions.submitExecutionResult({
            executionId: execution.id,
            missionId,
            taskId,
            content: {
              openclaw: result.output,
              stderr: result.stderr,
            },
            evidence: ["openclaw:local"],
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
        return json(200, { rules: deps.missions.getScheduleRules(missionId) });
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
        deps.missions.updateScheduleRule(missionId, ruleId, body as Partial<ScheduleRule>);
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
