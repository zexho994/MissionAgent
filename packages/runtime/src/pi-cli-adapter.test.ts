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
