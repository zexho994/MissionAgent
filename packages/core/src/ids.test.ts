import { describe, expect, it } from "vitest";
import { createId } from "./ids.js";

describe("createId", () => {
  it("creates prefixed ids that do not depend on process-local counters", () => {
    const id = createId("mission");

    expect(id).toMatch(
      /^mission_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("fails fast when prefix is blank", () => {
    expect(() => createId(" ")).toThrow("ID prefix is required");
  });
});
