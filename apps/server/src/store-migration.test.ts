import { describe, expect, it } from "vitest";
import { migrateOpenClawToPi } from "./store-migration.js";

describe("migrateOpenClawToPi", () => {
  it("returns unchanged store when no openclaw key present", () => {
    const store = { missions: [] as unknown[], migrationDone: true };
    const result = migrateOpenClawToPi(JSON.stringify(store));
    expect(JSON.parse(result.json)).toEqual(store);
    expect(result.migrated).toBe(false);
  });

  it("rewrites openclaw substrings to pi in keys and values", () => {
    const store = {
      tasks: [
        {
          artifact: {
            content: { openclaw: { searchResults: [{ url: "https://x" }] } },
            evidence: ["openclaw:local"],
          },
          assignedTo: "openclaw_runner",
        },
      ],
    };
    const result = migrateOpenClawToPi(JSON.stringify(store));
    const parsed = JSON.parse(result.json);
    expect(parsed.tasks[0].artifact.content.pi).toBeDefined();
    expect(parsed.tasks[0].artifact.content.openclaw).toBeUndefined();
    expect(parsed.tasks[0].artifact.evidence).toEqual(["pi:local"]);
    expect(parsed.tasks[0].assignedTo).toBe("pi_runner");
    expect(parsed.migrationDone).toBe(true);
    expect(result.migrated).toBe(true);
  });

  it("is idempotent on a store already migrated", () => {
    const store = { tasks: [{ content: { pi: 1 } }], migrationDone: true };
    const result = migrateOpenClawToPi(JSON.stringify(store));
    expect(JSON.parse(result.json)).toEqual(store);
    expect(result.migrated).toBe(false);
  });

  it("handles empty store", () => {
    const result = migrateOpenClawToPi("{}");
    expect(JSON.parse(result.json)).toEqual({ migrationDone: true });
    expect(result.migrated).toBe(false);
  });
});
