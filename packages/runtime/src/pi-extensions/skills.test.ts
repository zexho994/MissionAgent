import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createSkillTools, listSkillFiles, loadSkillFile } from "./skills.js";

function createSkillRoot() {
  const root = join(tmpdir(), `digitalagent-skills-${Date.now()}-${Math.random()}`);
  mkdirSync(join(root, "digitalagent", "capabilities"), { recursive: true });
  writeFileSync(join(root, "digitalagent", "SKILL.md"), "# DigitalAgent Skill\n\nCore summary.");
  writeFileSync(join(root, "digitalagent", "capabilities", "agent-collaboration.md"), "# Agent Collaboration\n\nA2A collaboration.");
  writeFileSync(join(root, "digitalagent", "notes.txt"), "not markdown");
  return root;
}

describe("skill filesystem helpers", () => {
  it("lists markdown skill files as relative paths", async () => {
    const rootDir = createSkillRoot();

    const files = await listSkillFiles({ rootDir });

    expect(files).toEqual([
      { path: "digitalagent/SKILL.md", title: "DigitalAgent Skill" },
      { path: "digitalagent/capabilities/agent-collaboration.md", title: "Agent Collaboration" },
    ]);
  });

  it("filters skill files by query", async () => {
    const rootDir = createSkillRoot();

    const files = await listSkillFiles({ rootDir, query: "collaboration" });

    expect(files).toEqual([
      { path: "digitalagent/capabilities/agent-collaboration.md", title: "Agent Collaboration" },
    ]);
  });

  it("loads a relative markdown skill file", async () => {
    const rootDir = createSkillRoot();

    const loaded = await loadSkillFile({ rootDir, path: "digitalagent/SKILL.md" });

    expect(loaded).toEqual({
      path: "digitalagent/SKILL.md",
      content: "# DigitalAgent Skill\n\nCore summary.",
    });
  });

  it("rejects absolute paths", async () => {
    const rootDir = createSkillRoot();

    await expect(loadSkillFile({ rootDir, path: join(rootDir, "digitalagent", "SKILL.md") }))
      .rejects.toThrow("Skill path must be relative");
  });

  it("rejects path traversal", async () => {
    const rootDir = createSkillRoot();

    await expect(loadSkillFile({ rootDir, path: "../secret.md" }))
      .rejects.toThrow("Skill path cannot contain path traversal");
  });

  it("rejects non-markdown files", async () => {
    const rootDir = createSkillRoot();

    await expect(loadSkillFile({ rootDir, path: "digitalagent/notes.txt" }))
      .rejects.toThrow("Only markdown skill files are supported");
  });

  it("rejects missing files", async () => {
    const rootDir = createSkillRoot();

    await expect(loadSkillFile({ rootDir, path: "digitalagent/missing.md" }))
      .rejects.toThrow("Skill file not found");
  });
});

describe("createSkillTools", () => {
  it("creates list_skill_files and load_skill tools", async () => {
    const rootDir = createSkillRoot();
    const tools = createSkillTools({ rootDir });

    expect(tools.map((tool) => tool.name)).toEqual(["list_skill_files", "load_skill"]);

    const listResult = await tools[0]!.execute("call-1", {});
    const listText = (listResult.content[0] as { text?: string })?.text;
    expect(listText).toContain("digitalagent/SKILL.md");

    const loadResult = await tools[1]!.execute("call-2", { path: "digitalagent/SKILL.md" });
    const loadText = (loadResult.content[0] as { text?: string })?.text;
    expect(loadText).toContain("# DigitalAgent Skill");
    expect(loadResult.details).toEqual({ path: "digitalagent/SKILL.md" });
  });
});