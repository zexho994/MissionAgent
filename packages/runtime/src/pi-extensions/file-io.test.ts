import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { createFileTools } from "./file-io.js";

describe("file-io tools", () => {
  let workspaceRoot: string;

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), "digitalagent-fileio-"));
  });

  afterEach(() => {
    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  function getTool(name: string) {
    const tools = createFileTools({ workspaceRoot });
    const tool = tools.find((t) => t.name === name);
    if (!tool) throw new Error(`Tool not found: ${name}`);
    return tool;
  }

  describe("file_write", () => {
    it("creates workspace dir lazily on first write and writes content", async () => {
      const tool = getTool("file_write");
      const result = await tool.execute("call-1", { path: "chain.txt", content: "信马由缰\n" });

      const written = readFileSync(join(workspaceRoot, "chain.txt"), "utf8");
      expect(written).toBe("信马由缰\n");
      expect(result.details).toMatchObject({ bytesWritten: expect.any(Number), path: "chain.txt" });
    });

    it("appends when mode is 'append'", async () => {
      const tool = getTool("file_write");
      await tool.execute("c1", { path: "chain.txt", content: "信马由缰\n" });
      await tool.execute("c2", { path: "chain.txt", content: "缰绳万缕\n", mode: "append" });

      const written = readFileSync(join(workspaceRoot, "chain.txt"), "utf8");
      expect(written).toBe("信马由缰\n缰绳万缕\n");
    });

    it("overwrites by default", async () => {
      const tool = getTool("file_write");
      await tool.execute("c1", { path: "chain.txt", content: "old\n" });
      await tool.execute("c2", { path: "chain.txt", content: "new\n" });

      const written = readFileSync(join(workspaceRoot, "chain.txt"), "utf8");
      expect(written).toBe("new\n");
    });

    it("rejects absolute paths", async () => {
      const tool = getTool("file_write");
      const result = await tool.execute("c1", { path: "/etc/passwd", content: "x" });
      expect(JSON.stringify(result)).toMatch(/path/i);
      expect(JSON.stringify(result)).toMatch(/absolute|relative/i);
    });

    it("rejects parent directory traversal", async () => {
      const tool = getTool("file_write");
      const result = await tool.execute("c1", { path: "../escaped.txt", content: "x" });
      expect(JSON.stringify(result)).toMatch(/path/i);
    });

    it("rejects content over 1 MB", async () => {
      const tool = getTool("file_write");
      const huge = "x".repeat(1_048_577);
      const result = await tool.execute("c1", { path: "big.txt", content: huge });
      expect(JSON.stringify(result)).toMatch(/size|large|limit/i);
    });

    it("rejects when workspace already contains 100 files", async () => {
      mkdirSync(workspaceRoot, { recursive: true });
      for (let i = 0; i < 100; i++) {
        writeFileSync(join(workspaceRoot, `f${i}.txt`), "x");
      }
      const tool = getTool("file_write");
      const result = await tool.execute("c1", { path: "overflow.txt", content: "y" });
      expect(JSON.stringify(result)).toMatch(/file.*limit|too many/i);
    });
  });

  describe("file_read", () => {
    it("returns exists:false when file missing (no throw)", async () => {
      const tool = getTool("file_read");
      const result = await tool.execute("c1", { path: "missing.txt" });
      expect(result.details).toMatchObject({ exists: false, content: "", sizeBytes: 0 });
    });

    it("returns content and size when file exists", async () => {
      mkdirSync(workspaceRoot, { recursive: true });
      writeFileSync(join(workspaceRoot, "chain.txt"), "信马由缰\n");
      const tool = getTool("file_read");
      const result = await tool.execute("c1", { path: "chain.txt" });

      expect(result.details).toMatchObject({
        exists: true,
        content: "信马由缰\n",
        sizeBytes: Buffer.byteLength("信马由缰\n", "utf8"),
      });
    });

    it("rejects absolute paths", async () => {
      const tool = getTool("file_read");
      const result = await tool.execute("c1", { path: "/etc/passwd" });
      expect(JSON.stringify(result)).toMatch(/path/i);
    });

    it("rejects parent traversal", async () => {
      const tool = getTool("file_read");
      const result = await tool.execute("c1", { path: "../etc/passwd" });
      expect(JSON.stringify(result)).toMatch(/path/i);
    });
  });
});
