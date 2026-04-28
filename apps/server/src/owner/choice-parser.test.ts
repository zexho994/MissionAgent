import { describe, expect, it } from "vitest";
import { parseChoices, extractQuestionWithOptions } from "./choice-parser.js";

describe("choice-parser", () => {
  describe("parseChoices", () => {
    it("detects no choices when text lacks choice keywords", () => {
      const result = parseChoices("Hello, how are you today?");
      expect(result.hasChoices).toBe(false);
      expect(result.choices).toEqual([]);
      expect(result.textWithoutChoices).toBe("Hello, how are you today?");
    });

    it("detects no choices when only one option is present", () => {
      const result = parseChoices("Please choose from the options below:\nA. Only option");
      expect(result.hasChoices).toBe(false);
    });

    it("parses letter format choices (A. B. C.)", () => {
      const text = `Please select your preferred approach:
A. Use React for the frontend
B. Use Vue for the frontend
C. Use Angular for the frontend`;
      const result = parseChoices(text);

      expect(result.hasChoices).toBe(true);
      expect(result.choices).toEqual([
        { label: "A", value: "Use React for the frontend" },
        { label: "B", value: "Use Vue for the frontend" },
        { label: "C", value: "Use Angular for the frontend" },
      ]);
      expect(result.textWithoutChoices).toContain("Please select your preferred approach:");
    });

    it("parses numbered format choices (1. 2. 3.)", () => {
      const text = `Choose from the following options:
1. Implement with TypeScript
2. Implement with JavaScript
3. Implement with Python`;
      const result = parseChoices(text);

      expect(result.hasChoices).toBe(true);
      expect(result.choices).toEqual([
        { label: "1", value: "Implement with TypeScript" },
        { label: "2", value: "Implement with JavaScript" },
        { label: "3", value: "Implement with Python" },
      ]);
    });

    it("parses bullet format choices", () => {
      const text = `Please pick from:
- Option one with description
- Option two with description
- Option three with description`;
      const result = parseChoices(text);

      expect(result.hasChoices).toBe(true);
      expect(result.choices).toEqual([
        { label: "A", value: "Option one with description" },
        { label: "B", value: "Option two with description" },
        { label: "C", value: "Option three with description" },
      ]);
    });

    it("parses parentheses format choices ((A) (B) (C))", () => {
      const text = `Select your preference:
(A) High performance mode
(B) Balanced mode
(C) Energy saving mode`;
      const result = parseChoices(text);

      expect(result.hasChoices).toBe(true);
      expect(result.choices).toEqual([
        { label: "A", value: "High performance mode" },
        { label: "B", value: "Balanced mode" },
        { label: "C", value: "Energy saving mode" },
      ]);
    });

    it("handles Chinese choice keywords", () => {
      const text = `请从以下选项中选择：
A. 使用 React 构建
B. 使用 Vue 构建
C. 使用 Angular 构建`;
      const result = parseChoices(text);

      expect(result.hasChoices).toBe(true);
      expect(result.choices).toEqual([
        { label: "A", value: "使用 React 构建" },
        { label: "B", value: "使用 Vue 构建" },
        { label: "C", value: "使用 Angular 构建" },
      ]);
    });

    it("removes choice text from the result", () => {
      const text = `What's your preferred development approach?

Please choose from the options below:
A. Test-driven development
B. Behavior-driven development
C. No specific methodology

Let me know your preference.`;
      const result = parseChoices(text);

      expect(result.hasChoices).toBe(true);
      expect(result.textWithoutChoices).toContain("What's your preferred development approach?");
      expect(result.textWithoutChoices).toContain("Let me know your preference.");
      expect(result.textWithoutChoices).not.toContain("A. Test-driven development");
    });
  });

  describe("extractQuestionWithOptions", () => {
    it("extracts question and options when choices are present", () => {
      const text = `Would you like to proceed with the implementation?

Please select from:
A. Yes, proceed immediately
B. Yes, but with review first
C. No, need more discussion`;

      const result = extractQuestionWithOptions(text);

      expect(result).not.toBeNull();
      expect(result?.question).toContain("Would you like to proceed");
      expect(result?.options).toEqual([
        { label: "A", value: "Yes, proceed immediately" },
        { label: "B", value: "Yes, but with review first" },
        { label: "C", value: "No, need more discussion" },
      ]);
    });

    it("returns null when no choices are present", () => {
      const text = "This is just a regular message without any choices.";
      const result = extractQuestionWithOptions(text);

      expect(result).toBeNull();
    });

    it("handles Chinese questions with choices", () => {
      const text = `您希望如何进行这个项目？

请选择：
1. 快速原型开发
2. 完整规划后开发
3. 迭代式开发`;

      const result = extractQuestionWithOptions(text);

      expect(result).not.toBeNull();
      expect(result?.question).toContain("您希望如何进行这个项目");
      expect(result?.options).toEqual([
        { label: "1", value: "快速原型开发" },
        { label: "2", value: "完整规划后开发" },
        { label: "3", value: "迭代式开发" },
      ]);
    });
  });
});