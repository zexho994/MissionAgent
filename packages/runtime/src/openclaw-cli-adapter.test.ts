import { describe, expect, it } from "vitest";
import { OpenClawCliAdapter, parseAgentList, parseOpenClawJson } from "./openclaw-cli-adapter.js";

describe("OpenClawCliAdapter", () => {
  it("detects local OpenClaw availability through version output", async () => {
    const adapter = new OpenClawCliAdapter({
      run: async (command, args) => {
        expect(command).toBe("openclaw");
        expect(args).toEqual(["--version"]);
        return { exitCode: 0, stdout: "2026.4.10\n", stderr: "" };
      },
    });

    await expect(adapter.health()).resolves.toEqual({
      available: true,
      version: "2026.4.10",
    });
  });

  it("returns unavailable health when the command fails", async () => {
    const adapter = new OpenClawCliAdapter({
      run: async () => ({ exitCode: 127, stdout: "", stderr: "not found" }),
    });

    await expect(adapter.health()).resolves.toEqual({
      available: false,
      error: "not found",
    });
  });

  it("runs a local OpenClaw agent turn with JSON output", async () => {
    const adapter = new OpenClawCliAdapter({
      run: async (command, args, options) => {
        expect(command).toBe("openclaw");
        if (args.join(" ") === "agents list") {
          return {
            exitCode: 0,
            stdout: "Agents:\n- cross-border-ecommerce-manager (default) (Cross-border E-commerce Manager)\n",
            stderr: "",
          };
        }
        expect(args).toEqual([
          "agent",
          "--local",
          "--json",
          "--agent",
          "cross-border-ecommerce-manager",
          "--timeout",
          "30",
          "--message",
          "Summarize mission status",
        ]);
        expect(options).toEqual({ timeoutSeconds: 60 });
        return {
          exitCode: 0,
          stdout: JSON.stringify({ text: "Mission status is ready" }),
          stderr: "",
        };
      },
    });

    await expect(
      adapter.runAgentTask({
        message: "Summarize mission status",
        timeoutSeconds: 30,
      }),
    ).resolves.toEqual({
      status: "completed",
      output: { text: "Mission status is ready" },
      stderr: "",
    });
  });

  it("allows the OpenClaw agent id to be configured", async () => {
    const adapter = new OpenClawCliAdapter({
      defaultAgentId: "digitalagent",
      run: async (_command, args) => {
        expect(args).toContain("digitalagent");
        return {
          exitCode: 0,
          stdout: JSON.stringify({ text: "ok" }),
          stderr: "",
        };
      },
    });

    await expect(
      adapter.runAgentTask({
        message: "Summarize mission status",
        timeoutSeconds: 30,
      }),
    ).resolves.toMatchObject({
      status: "completed",
      output: { text: "ok" },
    });
  });

  it("fails fast when OpenClaw returns invalid JSON", async () => {
    const adapter = new OpenClawCliAdapter({
      defaultAgentId: "digitalagent",
      run: async () => ({ exitCode: 0, stdout: "plain text", stderr: "" }),
    });

    await expect(
      adapter.runAgentTask({ message: "Do work", timeoutSeconds: 30 }),
    ).rejects.toThrow("OpenClaw returned non-JSON output");
  });

  it("parses the default agent from noisy OpenClaw list output", () => {
    expect(
      parseAgentList(`Config warning
Agents:
- cross-border-ecommerce-manager (default) (Cross-border E-commerce Manager)
  Identity: IDENTITY.md
- researcher (Researcher)
`),
    ).toEqual([
      { id: "cross-border-ecommerce-manager", isDefault: true },
      { id: "researcher", isDefault: false },
    ]);
  });

  it("parses JSON after OpenClaw warning noise", () => {
    expect(
      parseOpenClawJson(`Config warning
plugin loaded
{
  "payloads": [
    {
      "text": "ok"
    }
  ]
}`),
    ).toEqual({
      payloads: [{ text: "ok" }],
    });
  });

  describe("retry on transient failure", () => {
    it("retries runAgentTask once on transient non-zero exit and succeeds", async () => {
      let agentTaskCalls = 0;
      const adapter = new OpenClawCliAdapter({
        defaultAgentId: "agent-x",
        run: async (_command, args) => {
          if (args[0] !== "agent") {
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          agentTaskCalls += 1;
          if (agentTaskCalls === 1) {
            return { exitCode: 1, stdout: "", stderr: "transient error" };
          }
          return {
            exitCode: 0,
            stdout: JSON.stringify({ text: "ok after retry" }),
            stderr: "",
          };
        },
        retry: { maxAttempts: 2, initialDelayMs: 0 },
        sleep: async () => undefined,
      });

      const result = await adapter.runAgentTask({
        message: "go",
        timeoutSeconds: 30,
      });

      expect(result.status).toBe("completed");
      expect(agentTaskCalls).toBe(2);
    });

    it("gives up after maxAttempts attempts and throws with the last stderr", async () => {
      let agentTaskCalls = 0;
      const adapter = new OpenClawCliAdapter({
        defaultAgentId: "agent-x",
        run: async (_command, args) => {
          if (args[0] !== "agent") {
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          agentTaskCalls += 1;
          return { exitCode: 1, stdout: "", stderr: `attempt ${agentTaskCalls} failed` };
        },
        retry: { maxAttempts: 3, initialDelayMs: 0 },
        sleep: async () => undefined,
      });

      await expect(
        adapter.runAgentTask({ message: "go", timeoutSeconds: 30 }),
      ).rejects.toThrow(/attempt 3 failed/);
      expect(agentTaskCalls).toBe(3);
    });

    it("does NOT retry on timeout (exit code 124)", async () => {
      let agentTaskCalls = 0;
      const adapter = new OpenClawCliAdapter({
        defaultAgentId: "agent-x",
        run: async (_command, args) => {
          if (args[0] !== "agent") {
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          agentTaskCalls += 1;
          return {
            exitCode: 124,
            stdout: "",
            stderr: "OpenClaw command timed out after 30 seconds",
          };
        },
        retry: { maxAttempts: 3, initialDelayMs: 0 },
        sleep: async () => undefined,
      });

      await expect(
        adapter.runAgentTask({ message: "go", timeoutSeconds: 30 }),
      ).rejects.toThrow(/timed out/);
      expect(agentTaskCalls).toBe(1);
    });

    it("uses exponential backoff between retry attempts", async () => {
      const sleeps: number[] = [];
      let agentTaskCalls = 0;
      const adapter = new OpenClawCliAdapter({
        defaultAgentId: "agent-x",
        run: async (_command, args) => {
          if (args[0] !== "agent") {
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          agentTaskCalls += 1;
          return { exitCode: 1, stdout: "", stderr: "fail" };
        },
        retry: { maxAttempts: 3, initialDelayMs: 100 },
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      });

      await expect(
        adapter.runAgentTask({ message: "go", timeoutSeconds: 30 }),
      ).rejects.toThrow();
      expect(sleeps).toEqual([100, 200]);
    });
  });
});
