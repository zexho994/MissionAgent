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
});
