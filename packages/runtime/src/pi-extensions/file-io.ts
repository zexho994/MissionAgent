/**
 * File IO pi extension — mission-scoped workspace read/write.
 *
 * Two tools:
 * - `file_write({ path, content, mode? })` — write text content to a path
 *   inside the workspace. `mode` is "overwrite" (default) or "append".
 * - `file_read({ path })` — read text content; returns `{ exists: false }`
 *   without throwing if the file does not exist.
 *
 * Sandboxed: paths must be relative, resolved path must remain inside
 * `workspaceRoot`. Caps: 1 MB per call, 100 files per workspace.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, appendFileSync } from "node:fs";
import { isAbsolute, relative, resolve, dirname } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";

const MAX_BYTES_PER_CALL = 1_048_576; // 1 MB
const MAX_FILES_PER_WORKSPACE = 100;

export interface FileToolOptions {
  workspaceRoot: string;
}

const FileWriteParameters = Type.Object({
  path: Type.String({ description: "Relative path inside the mission workspace, e.g. 'chain.txt'." }),
  content: Type.String({ description: "Text content to write." }),
  mode: Type.Optional(Type.Union([Type.Literal("overwrite"), Type.Literal("append")], {
    description: "Write mode. 'overwrite' (default) replaces file; 'append' adds to the end.",
  })),
});

const FileReadParameters = Type.Object({
  path: Type.String({ description: "Relative path inside the mission workspace." }),
});

function validateRelativePath(rawPath: string, workspaceRoot: string): { ok: true; absolute: string } | { ok: false; error: string } {
  if (typeof rawPath !== "string" || rawPath.trim() === "") {
    return { ok: false, error: "path must be a non-empty string" };
  }
  if (isAbsolute(rawPath)) {
    return { ok: false, error: "path must be relative to the workspace (absolute paths are rejected)" };
  }
  if (rawPath.split(/[\\/]+/).includes("..")) {
    return { ok: false, error: "path cannot contain parent traversal ('..')" };
  }
  const absolute = resolve(workspaceRoot, rawPath);
  const rel = relative(workspaceRoot, absolute);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    return { ok: false, error: "resolved path escapes workspace root" };
  }
  return { ok: true, absolute };
}

function countWorkspaceFiles(workspaceRoot: string): number {
  if (!existsSync(workspaceRoot)) return 0;
  let count = 0;
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) count += 1;
    }
  };
  walk(workspaceRoot);
  return count;
}

function errorResult(message: string): { content: { type: "text"; text: string }[]; details: Record<string, unknown> } {
  return {
    content: [{ type: "text", text: JSON.stringify({ ok: false, error: message }) }],
    details: { ok: false, error: message },
  };
}

export function createFileTools(options: FileToolOptions): AgentTool<any>[] {
  const { workspaceRoot } = options;

  const writeTool: AgentTool<typeof FileWriteParameters> = {
    name: "file_write",
    label: "File Write",
    description:
      "Write text content to a file in the mission workspace. Path must be relative (e.g. 'chain.txt'). Mode is 'overwrite' (default) or 'append'. Max 1 MB per call, max 100 files per workspace.",
    parameters: FileWriteParameters,
    async execute(_toolCallId, params: any) {
      const validation = validateRelativePath(params.path, workspaceRoot);
      if (!validation.ok) return errorResult(validation.error);

      const content: string = params.content ?? "";
      const byteLength = Buffer.byteLength(content, "utf8");
      if (byteLength > MAX_BYTES_PER_CALL) {
        return errorResult(`content size ${byteLength} exceeds the per-call limit of ${MAX_BYTES_PER_CALL} bytes (1 MB)`);
      }

      const mode = params.mode === "append" ? "append" : "overwrite";

      const existedBefore = existsSync(validation.absolute);
      if (!existedBefore) {
        const currentCount = countWorkspaceFiles(workspaceRoot);
        if (currentCount >= MAX_FILES_PER_WORKSPACE) {
          return errorResult(`workspace already contains ${currentCount} files (limit ${MAX_FILES_PER_WORKSPACE}); refuse to create more`);
        }
      }

      mkdirSync(dirname(validation.absolute), { recursive: true });
      if (mode === "append") {
        appendFileSync(validation.absolute, content, "utf8");
      } else {
        writeFileSync(validation.absolute, content, "utf8");
      }

      const finalSize = statSync(validation.absolute).size;
      const details = { ok: true, bytesWritten: byteLength, path: params.path, totalSizeBytes: finalSize, mode };
      return {
        content: [{ type: "text", text: JSON.stringify(details) }],
        details,
      };
    },
  };

  const readTool: AgentTool<typeof FileReadParameters> = {
    name: "file_read",
    label: "File Read",
    description:
      "Read text content from a file in the mission workspace. Returns { exists: false, content: '', sizeBytes: 0 } if the file does not exist (does not throw). Max 1 MB per read.",
    parameters: FileReadParameters,
    async execute(_toolCallId, params: any) {
      const validation = validateRelativePath(params.path, workspaceRoot);
      if (!validation.ok) return errorResult(validation.error);

      if (!existsSync(validation.absolute)) {
        const details = { ok: true, exists: false, content: "", sizeBytes: 0, path: params.path };
        return {
          content: [{ type: "text", text: JSON.stringify(details) }],
          details,
        };
      }

      const stat = statSync(validation.absolute);
      if (stat.size > MAX_BYTES_PER_CALL) {
        return errorResult(`file size ${stat.size} exceeds the per-call limit of ${MAX_BYTES_PER_CALL} bytes (1 MB)`);
      }

      const content = readFileSync(validation.absolute, "utf8");
      const details = { ok: true, exists: true, content, sizeBytes: stat.size, path: params.path };
      return {
        content: [{ type: "text", text: JSON.stringify(details) }],
        details,
      };
    },
  };

  return [readTool, writeTool];
}
