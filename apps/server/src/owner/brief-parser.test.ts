import { describe, expect, it } from "vitest";
import { detectBriefInResponse, parseMissionBrief } from "./brief-parser.js";

describe("detectBriefInResponse", () => {
  it("detects raw JSON with required fields", () => {
    expect(detectBriefInResponse('{"goal":"test","successMetrics":["m1"],"constraints":[]}')).toBe(true);
  });

  it("detects JSON in markdown code block", () => {
    const text = "Here is the brief:\n```json\n{\"goal\":\"test\",\"successMetrics\":[\"m1\"],\"constraints\":[]}\n```";
    expect(detectBriefInResponse(text)).toBe(true);
  });

  it("detects JSON after preamble text", () => {
    const text = 'Based on our conversation, here is the MissionBrief:\n{"goal":"test","successMetrics":["m1"],"constraints":[]}';
    expect(detectBriefInResponse(text)).toBe(true);
  });

  it("returns false for plain text without JSON", () => {
    expect(detectBriefInResponse("What platform do you want to use?")).toBe(false);
  });

  it("returns false for JSON without required fields", () => {
    expect(detectBriefInResponse('{"some":"json"}')).toBe(false);
  });
});

describe("parseMissionBrief", () => {
  it("parses a complete MissionBrief JSON", () => {
    const text = '{"goal":"Grow Xiaohongshu","scope":"Content creation","constraints":["human approval"],"successMetrics":["1000 followers"],"keyAssumptions":["Existing account"],"targetAudience":"Young adults","timeline":"1 month"}';

    const brief = parseMissionBrief(text);

    expect(brief.goal).toBe("Grow Xiaohongshu");
    expect(brief.scope).toBe("Content creation");
    expect(brief.constraints).toEqual(["human approval"]);
    expect(brief.successMetrics).toEqual(["1000 followers"]);
    expect(brief.keyAssumptions).toEqual(["Existing account"]);
    expect(brief.targetAudience).toBe("Young adults");
    expect(brief.timeline).toBe("1 month");
  });

  it("parses brief with minimal required fields", () => {
    const text = '{"goal":"Test goal","scope":"","constraints":[],"successMetrics":[]}';

    const brief = parseMissionBrief(text);

    expect(brief.goal).toBe("Test goal");
    expect(brief.keyAssumptions).toEqual([]);
    expect(brief.targetAudience).toBeUndefined();
    expect(brief.timeline).toBeUndefined();
  });

  it("parses JSON wrapped in markdown code block", () => {
    const text = "```json\n{\"goal\":\"Test\",\"successMetrics\":[\"m\"],\"constraints\":[]}\n```";

    const brief = parseMissionBrief(text);
    expect(brief.goal).toBe("Test");
  });

  it("throws when no JSON is found", () => {
    expect(() => parseMissionBrief("just plain text")).toThrow("No JSON object found");
  });

  it("throws when goal is empty", () => {
    expect(() => parseMissionBrief('{"goal":"","successMetrics":[],"constraints":[]}')).toThrow("non-empty goal");
  });

  it("throws when successMetrics is not an array", () => {
    expect(() => parseMissionBrief('{"goal":"test","successMetrics":"bad","constraints":[]}')).toThrow("successMetrics array");
  });
});
