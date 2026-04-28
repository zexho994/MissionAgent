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

export interface SseRequest {
  method: string;
  path: string;
  missionId: string;
}

export interface SseDependencies {
  missions: InMemoryMissionService;
}

export function handleSseConnection(
  request: SseRequest,
  deps: SseDependencies,
  onEvent: (event: { data: string }) => void,
  onComplete: () => void,
): () => void {
  const mission = deps.missions.snapshot().missions.find((m) => m.id === request.missionId);
  if (!mission) {
    onEvent({ data: JSON.stringify({ error: "Mission not found" }) });
    onComplete();
    return () => {};
  }

  const subscription = deps.missions.subscribeToMissionStream(request.missionId, (event) => {
    onEvent({ data: JSON.stringify(event) });
    if (event.type === "done") {
      onComplete();
    }
  });

  return () => {
    subscription.unsubscribe();
    onComplete();
  };
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
      const mission = deps.missions.activateMission({
        missionId: expectString(body.missionId, "missionId"),
      });
      return json(200, { mission, snapshot: deps.missions.snapshot() });
    }

    if (request.method === "POST" && request.path === "/api/missions/confirm-brief") {
      const body = expectObject(request.body);
      const mission = deps.missions.confirmBrief({
        missionId: expectString(body.missionId, "missionId"),
      });
      return json(200, { mission, snapshot: deps.missions.snapshot() });
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
  return value;
}

function expectStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`${field} must be a string array`);
  }
  return [...value];
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
