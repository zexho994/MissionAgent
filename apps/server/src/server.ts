import "dotenv/config";
import { createReadStream, existsSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PiSdkAdapter,
  createPiAgentLlmService,
  createSkillTools,
  createWebSearchTool,
} from "@digitalagent/runtime";
import { loadAgentSystemConfig } from "./system-config.js";
import { handleApiRequest } from "./api.js";
import { InMemoryMissionService } from "./mission-service.js";
import type { MissionExecutionRuntime } from "./runtime-bridge.js";

const port = Number(process.env.PORT ?? 3000);
const root = fileURLToPath(new URL(".", import.meta.url));
const publicDir = join(root, "public");
const dataFile = process.env.DIGITALAGENT_STORE_FILE ?? join(root, "..", "data", "mission-store.json");

const configFile = join(root, "..", "config", "agent-system.json");
const agentConfig = loadAgentSystemConfig(configFile);
const skillRoot = join(root, "..", agentConfig.skills.rootDir);
const skillTools = createSkillTools({ rootDir: skillRoot });

const apiKey =
  process.env.LLM_API_KEY ??
  process.env.MINIMAX_API_KEY ??
  process.env.ANTHROPIC_API_KEY ??
  "";

const llm = createPiAgentLlmService({
  apiKey,
  modelProvider: process.env.LLM_PROVIDER ?? "minimax-cn",
  modelId: process.env.LLM_MODEL ?? "MiniMax-M2.7-highspeed",
  tools: skillTools,
});

const pi = new PiSdkAdapter({
  apiKey,
  modelProvider: process.env.LLM_PROVIDER ?? "minimax-cn",
  modelId: process.env.LLM_MODEL ?? "MiniMax-M2.7-highspeed",
  tools: [...skillTools, createWebSearchTool({})],
});

const runtime: MissionExecutionRuntime = {
  runAgentTask: (input) => pi.runAgentTask(input),
};

const missions = new InMemoryMissionService({ storageFile: dataFile, llm, runtime });
missions.restoreSchedulers();

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, `${url.pathname}${url.search}`);
      return;
    }

    if (url.pathname === "/favicon.ico") {
      res.writeHead(204, { "cache-control": "no-store" });
      res.end();
      return;
    }

    await serveStatic(url.pathname, res);
  } catch (error) {
    writeJson(res, 500, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`DigitalAgent running at http://127.0.0.1:${port}`);
});

async function handleApi(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
  if (path.startsWith("/api/missions/") && path.endsWith("/stream")) {
    const missionId = path.split("/")[3];
    if (!missionId) {
      writeJson(res, 400, { error: "Mission ID required" });
      return;
    }

    const snapshot = missions.snapshot();
    const missionExists = snapshot.missions.some((m) => m.id === missionId);
    if (!missionExists) {
      writeJson(res, 404, { error: "Mission not found" });
      return;
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      "X-Content-Type-Options": "nosniff",
    });

    const timeout = setTimeout(() => {
      res.write(`data: ${JSON.stringify({ type: "done", reason: "timeout" })}\n\n`);
      res.end();
    }, 5 * 60 * 1000);

    const subscription = missions.subscribeToMissionStream(missionId, (event) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
      if (event.type === "done") {
        clearTimeout(timeout);
        res.end();
      }
    });

    req.on("close", () => {
      clearTimeout(timeout);
      subscription.unsubscribe();
    });

    return;
  }

  const body = await readJsonBody(req);
  const response = await handleApiRequest(
    {
      method: req.method ?? "GET",
      path,
      ...(body === undefined ? {} : { body }),
    },
    { missions, runtime: pi },
  );
  writeJson(res, response.status, response.body, response.headers);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  if (req.method !== "POST" && req.method !== "PUT" && req.method !== "PATCH") {
    return undefined;
  }

  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

function writeJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    ...headers,
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function serveStatic(pathname: string, res: ServerResponse): Promise<void> {
  const requestedPath = pathname === "/" ? "index.html" : pathname.replace(/^[/\\]+/, "");
  const safePath = normalize(requestedPath);
  if (safePath === ".." || safePath.startsWith(`..${"/"}`) || safePath.startsWith(`..${"\\"}`)) {
    writeJson(res, 400, { error: "Invalid static path" });
    return;
  }

  const filePath = join(publicDir, safePath);
  if (!filePath.startsWith(publicDir) || !existsSync(filePath)) {
    writeJson(res, 404, { error: "Not found" });
    return;
  }

  const contentType = contentTypeFor(filePath);
  res.writeHead(200, {
    "content-type": contentType,
    "cache-control": "no-store",
  });
  createReadStream(filePath).pipe(res);
}

function contentTypeFor(filePath: string): string {
  switch (extname(filePath)) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}
