import { describe, expect, it } from "vitest";
import { PiCliAdapter, parsePiOutputJson } from "./pi-cli-adapter.js";

describe("PiCliAdapter health", () => {
  it("detects local pi availability through version output", async () => {
    const adapter = new PiCliAdapter({
      run: async (command, args) => {
        expect(command).toBe("pi");
        expect(args).toEqual(["--version"]);
        return { exitCode: 0, stdout: "pi 0.42.0\n", stderr: "" };
      },
    });

    await expect(adapter.health()).resolves.toEqual({
      available: true,
      version: "pi 0.42.0",
    });
  });

  it("returns unavailable health when the command fails", async () => {
    const adapter = new PiCliAdapter({
      run: async () => ({ exitCode: 127, stdout: "", stderr: "command not found: pi" }),
    });

    await expect(adapter.health()).resolves.toEqual({
      available: false,
      error: "command not found: pi",
    });
  });

  it("uses configurable command path", async () => {
    const adapter = new PiCliAdapter({
      command: "/usr/local/bin/pi",
      run: async (command) => {
        expect(command).toBe("/usr/local/bin/pi");
        return { exitCode: 0, stdout: "pi 0.42.0", stderr: "" };
      },
    });

    await expect(adapter.health()).resolves.toMatchObject({ available: true });
  });
});

describe("parsePiOutputJson", () => {
  it("parses a clean JSON object", () => {
    expect(parsePiOutputJson('{"result":"ok"}')).toEqual({ result: "ok" });
  });

  it("parses a clean JSON array", () => {
    expect(parsePiOutputJson("[1,2,3]")).toEqual([1, 2, 3]);
  });

  it("recovers when JSON is preceded by warnings", () => {
    const noisy = "[warning] cache miss\nUsing default model.\n{\"result\":\"ok\"}\n";
    expect(parsePiOutputJson(noisy)).toEqual({ result: "ok" });
  });

  it("throws on empty output", () => {
    expect(() => parsePiOutputJson("")).toThrow();
    expect(() => parsePiOutputJson("   \n\t")).toThrow();
  });

  it("throws when no JSON is found", () => {
    expect(() => parsePiOutputJson("just plain text, no JSON here")).toThrow();
  });
});

describe("PiCliAdapter runAgentTask", () => {
  it("invokes pi in print mode with default tools and the provided message", async () => {
    const adapter = new PiCliAdapter({
      run: async (command, args, options) => {
        expect(command).toBe("pi");
        expect(args).toEqual([
          "-p",
          "--no-session",
          "--tools",
          "read,grep,find,ls,bash,web_search",
          "Summarize mission status",
        ]);
        expect(options).toEqual({ timeoutSeconds: 60 });
        return {
          exitCode: 0,
          stdout: JSON.stringify({ summary: "Mission status is ready" }),
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
      output: { summary: "Mission status is ready" },
      stderr: "",
    });
  });

  it("forwards systemPrompt as --system-prompt when provided", async () => {
    const adapter = new PiCliAdapter({
      run: async (_command, args) => {
        const idx = args.indexOf("--system-prompt");
        expect(idx).toBeGreaterThan(-1);
        expect(args[idx + 1]).toBe("You are a researcher.");
        return { exitCode: 0, stdout: "{\"ok\":true}", stderr: "" };
      },
    });

    await adapter.runAgentTask({
      message: "go",
      timeoutSeconds: 10,
      systemPrompt: "You are a researcher.",
    });
  });

  it("omits --system-prompt when not provided", async () => {
    const adapter = new PiCliAdapter({
      run: async (_command, args) => {
        expect(args).not.toContain("--system-prompt");
        return { exitCode: 0, stdout: "{}", stderr: "" };
      },
    });

    await adapter.runAgentTask({ message: "x", timeoutSeconds: 5 });
  });

  it("forwards configured extensions via -e flags in declaration order", async () => {
    const adapter = new PiCliAdapter({
      defaultExtensions: ["/tmp/web-search.js", "/tmp/other.js"],
      run: async (_command, args) => {
        const flags = args.reduce<string[]>((acc, value, index) => {
          if (value === "-e") acc.push(args[index + 1] ?? "");
          return acc;
        }, []);
        expect(flags).toEqual(["/tmp/web-search.js", "/tmp/other.js"]);
        return { exitCode: 0, stdout: "{}", stderr: "" };
      },
    });

    await adapter.runAgentTask({ message: "x", timeoutSeconds: 5 });
  });

  it("allows per-call extension override", async () => {
    const adapter = new PiCliAdapter({
      defaultExtensions: ["/tmp/default.js"],
      run: async (_command, args) => {
        const flags = args.reduce<string[]>((acc, value, index) => {
          if (value === "-e") acc.push(args[index + 1] ?? "");
          return acc;
        }, []);
        expect(flags).toEqual(["/tmp/per-call.js"]);
        return { exitCode: 0, stdout: "{}", stderr: "" };
      },
    });

    await adapter.runAgentTask({
      message: "x",
      timeoutSeconds: 5,
      extensions: ["/tmp/per-call.js"],
    });
  });

  it("allows per-call tools override", async () => {
    const adapter = new PiCliAdapter({
      run: async (_command, args) => {
        const idx = args.indexOf("--tools");
        expect(args[idx + 1]).toBe("read,grep");
        return { exitCode: 0, stdout: "{}", stderr: "" };
      },
    });

    await adapter.runAgentTask({
      message: "x",
      timeoutSeconds: 5,
      tools: ["read", "grep"],
    });
  });

  it("throws when message is empty", async () => {
    const adapter = new PiCliAdapter({ run: async () => ({ exitCode: 0, stdout: "", stderr: "" }) });
    await expect(adapter.runAgentTask({ message: "   ", timeoutSeconds: 30 })).rejects.toThrow(
      /message is required/i,
    );
  });

  it("throws when timeoutSeconds is non-positive", async () => {
    const adapter = new PiCliAdapter({ run: async () => ({ exitCode: 0, stdout: "", stderr: "" }) });
    await expect(adapter.runAgentTask({ message: "go", timeoutSeconds: 0 })).rejects.toThrow();
    await expect(adapter.runAgentTask({ message: "go", timeoutSeconds: -1 })).rejects.toThrow();
  });

  it("throws with stderr when pi exits non-zero", async () => {
    const adapter = new PiCliAdapter({
      run: async () => ({ exitCode: 2, stdout: "", stderr: "model not configured" }),
    });
    await expect(adapter.runAgentTask({ message: "go", timeoutSeconds: 30 })).rejects.toThrow(
      /model not configured/,
    );
  });

  it("throws when pi returns non-JSON output", async () => {
    const adapter = new PiCliAdapter({
      run: async () => ({ exitCode: 0, stdout: "I am not JSON", stderr: "" }),
    });
    await expect(adapter.runAgentTask({ message: "go", timeoutSeconds: 30 })).rejects.toThrow(
      /non-JSON/,
    );
  });

  it("falls back to stderr when stdout is empty", async () => {
    const adapter = new PiCliAdapter({
      run: async () => ({ exitCode: 0, stdout: "", stderr: '{"result":"ok"}' }),
    });
    await expect(adapter.runAgentTask({ message: "go", timeoutSeconds: 30 })).resolves.toEqual({
      status: "completed",
      output: { result: "ok" },
      stderr: '{"result":"ok"}',
    });
  });

  it("buffers timeoutSeconds when invoking the runner", async () => {
    const adapter = new PiCliAdapter({
      run: async (_command, _args, options) => {
        expect(options?.timeoutSeconds).toBe(30 + 30);
        return { exitCode: 0, stdout: "{}", stderr: "" };
      },
    });
    await adapter.runAgentTask({ message: "x", timeoutSeconds: 30 });
  });
});
