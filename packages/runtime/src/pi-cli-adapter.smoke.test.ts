import { describe, expect, it } from "vitest";
import { PiCliAdapter } from "./pi-cli-adapter.js";

const SMOKE = process.env.PI_SMOKE === "1";

/**
 * Smoke test against a real `pi` binary.
 *
 * Skipped unless PI_SMOKE=1 is set. Run before merging Plan 6 v1 with:
 *
 *   pnpm test:smoke
 *
 * Requirements:
 * - `pi` is on PATH (or PI_COMMAND points at the binary).
 * - At least one provider is configured for pi (e.g. ANTHROPIC_API_KEY env or
 *   credentials in ~/.pi/agent/settings.json).
 *
 * Cost target: under USD 0.01 per run on the cheapest tool-capable model.
 */
describe.skipIf(!SMOKE)("PiCliAdapter smoke (PI_SMOKE=1)", () => {
  it("calls real pi binary --version successfully", async () => {
    const adapter = new PiCliAdapter({
      command: process.env.PI_COMMAND ?? "pi",
    });
    const health = await adapter.health();
    expect(health.available).toBe(true);
    expect(health.version).toBeTruthy();
  }, 30_000);

  it("runs a trivial JSON round-trip against pi", async () => {
    const adapter = new PiCliAdapter({
      command: process.env.PI_COMMAND ?? "pi",
    });

    const result = await adapter.runAgentTask({
      message:
        'Reply with the JSON object {"result":"ok"} and nothing else. Do not use any tools.',
      timeoutSeconds: 60,
      systemPrompt:
        "You are a smoke-test agent. Your only job is to reply with a single valid JSON object.",
      tools: [],
      extensions: [],
    });

    expect(result.status).toBe("completed");
    expect(result.output).toEqual(expect.objectContaining({ result: "ok" }));
  }, 90_000);
});
