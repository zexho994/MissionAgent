import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";

export interface SkillFileInfo {
  path: string;
  title: string;
}

export interface SkillToolOptions {
  rootDir: string;
}

const ListSkillFilesParameters = Type.Object({
  query: Type.Optional(Type.String({ description: "Optional case-insensitive filter for skill path, title, or content." })),
});

const LoadSkillParameters = Type.Object({
  path: Type.String({ description: "Relative markdown skill path, for example digitalagent/SKILL.md." }),
});

export async function listSkillFiles(input: { rootDir: string; query?: string }): Promise<SkillFileInfo[]> {
  const root = resolve(input.rootDir);
  if (!existsSync(root)) {
    throw new Error(`Skill root not found: ${root}`);
  }

  const files = await collectMarkdownFiles(root, root);
  const query = input.query?.trim().toLowerCase();
  const result: SkillFileInfo[] = [];

  for (const path of files.sort()) {
    const loaded = await loadSkillFile({ rootDir: root, path });
    const haystack = `${path}\n${loaded.content}`.toLowerCase();
    if (query && !haystack.includes(query)) continue;
    result.push({ path, title: firstMarkdownHeading(loaded.content) ?? path });
  }

  return result;
}

export async function loadSkillFile(input: { rootDir: string; path: string }): Promise<{ path: string; content: string }> {
  const root = resolve(input.rootDir);
  const requestedPath = input.path;

  if (isAbsolute(requestedPath)) {
    throw new Error("Skill path must be relative");
  }
  if (requestedPath.split(/[\\/]+/).includes("..")) {
    throw new Error("Skill path cannot contain path traversal");
  }
  if (!requestedPath.endsWith(".md")) {
    throw new Error("Only markdown skill files are supported");
  }

  const absolute = resolve(root, requestedPath);
  const relativePath = relative(root, absolute);
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error("Skill path escapes skill root");
  }
  if (!existsSync(absolute)) {
    throw new Error(`Skill file not found: ${requestedPath}`);
  }

  return {
    path: normalizeRelativePath(relativePath),
    content: await readFile(absolute, "utf8"),
  };
}

export function createSkillTools(options: SkillToolOptions): AgentTool<any>[] {
  return [
    {
      name: "list_skill_files",
      label: "List Skill Files",
      description: "List available DigitalAgent skill markdown files by relative path.",
      parameters: ListSkillFilesParameters,
      async execute(_toolCallId, params: any) {
        const files = await listSkillFiles({ rootDir: options.rootDir, query: params.query });
        return {
          content: [{ type: "text", text: JSON.stringify(files, null, 2) }],
          details: { count: files.length },
        };
      },
    },
    {
      name: "load_skill",
      label: "Load Skill",
      description: "Load a DigitalAgent skill markdown file by relative path.",
      parameters: LoadSkillParameters,
      async execute(_toolCallId, params: any) {
        const loaded = await loadSkillFile({ rootDir: options.rootDir, path: params.path });
        return {
          content: [{ type: "text", text: loaded.content }],
          details: { path: loaded.path },
        };
      },
    },
  ];
}

async function collectMarkdownFiles(root: string, dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const absolute = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectMarkdownFiles(root, absolute));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(normalizeRelativePath(relative(root, absolute)));
    }
  }
  return files;
}

function firstMarkdownHeading(content: string): string | undefined {
  const line = content.split(/\r?\n/).find((item) => item.startsWith("# "));
  return line?.replace(/^#\s+/, "").trim() || undefined;
}

function normalizeRelativePath(path: string): string {
  return path.split(sep).join("/");
}