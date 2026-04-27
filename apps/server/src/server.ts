import { createReadStream, existsSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { OpenClawCliAdapter, type OpenClawCliAdapterOptions } from "@digitalagent/runtime";
import { handleApiRequest } from "./api.js";
import { InMemoryMissionService } from "./mission-service.js";

const port = Number(process.env.PORT ?? 3000);
const root = fileURLToPath(new URL(".", import.meta.url));
const publicDir = join(root, "public");
const missions = new InMemoryMissionService();
const openclawOptions: OpenClawCliAdapterOptions = {
  command: "openclaw",
};
if (process.env.OPENCLAW_AGENT_ID) {
  openclawOptions.defaultAgentId = process.env.OPENCLAW_AGENT_ID;
}
const openclaw = new OpenClawCliAdapter(openclawOptions);

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url.pathname);
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
  const body = await readJsonBody(req);
  const response = await handleApiRequest(
    {
      method: req.method ?? "GET",
      path,
      ...(body === undefined ? {} : { body }),
    },
    { missions, openclaw },
  );
  writeJson(res, response.status, response.body);
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

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
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
