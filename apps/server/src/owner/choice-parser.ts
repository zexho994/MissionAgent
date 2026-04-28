export interface ParsedChoice {
  label: string;
  value: string;
}

export interface ChoiceParseResult {
  hasChoices: boolean;
  choices: ParsedChoice[];
  textWithoutChoices: string;
}

const CHOICE_PATTERNS: Array<{
  regex: RegExp;
  extractLabel: (match: RegExpExecArray, index: number) => string;
  extractValue: (match: RegExpExecArray) => string;
}> = [
  // Letter format: A. option 1, B. option 2, etc.
  {
    regex: /^([A-Z])\.\s*(.+?)(?:\n|$)/gm,
    extractLabel: (match: RegExpExecArray) => match[1]!,
    extractValue: (match: RegExpExecArray) => match[2]!.trim(),
  },
  // Numbered format: 1. option 1, 2. option 2, etc.
  {
    regex: /^(\d+)\.\s*(.+?)(?:\n|$)/gm,
    extractLabel: (match: RegExpExecArray) => match[1]!,
    extractValue: (match: RegExpExecArray) => match[2]!.trim(),
  },
  // Bullet format with choices: - option 1, - option 2
  {
    regex: /^[-•]\s*(.+?)(?:\n|$)/gm,
    extractLabel: (_match: RegExpExecArray, index: number) => String.fromCharCode(65 + index),
    extractValue: (match: RegExpExecArray) => match[1]!.trim(),
  },
  // Parentheses: (A) option 1, (B) option 2
  {
    regex: /^\(([A-Z])\)\s*(.+?)(?:\n|$)/gm,
    extractLabel: (match: RegExpExecArray) => match[1]!,
    extractValue: (match: RegExpExecArray) => match[2]!.trim(),
  },
];

const CHOICE_KEYWORDS = [
  "choose from",
  "select from",
  "pick from",
  "options",
  "choices",
  "alternatives",
  "请选择",
  "选项",
  "选择",
  "请从",
];

export function parseChoices(text: string): ChoiceParseResult {
  let bestResult: ChoiceParseResult = {
    hasChoices: false,
    choices: [],
    textWithoutChoices: text,
  };

  // Try each pattern to find the best match
  for (const pattern of CHOICE_PATTERNS) {
    const matches = Array.from(text.matchAll(pattern.regex));

    if (matches.length >= 2) {
      const choices: ParsedChoice[] = [];
      let lastIndex = 0;
      const choiceRanges: [number, number][] = [];

      for (let i = 0; i < matches.length; i++) {
        const match = matches[i];
        if (!match || match.index === undefined) continue;

        const label = pattern.extractLabel(match, i);
        const value = pattern.extractValue(match);

        if (value.length > 0) {
          choices.push({ label, value });
          choiceRanges.push([match.index, (match.index ?? 0) + match[0].length]);
          lastIndex = Math.max(lastIndex, (match.index ?? 0) + match[0].length);
        }
      }

      if (choices.length >= 2) {
        // Remove choices from text
        let textWithoutChoices = text;
        for (const [start, end] of choiceRanges.sort((a, b) => b[0]! - a[0]!)) {
          textWithoutChoices = textWithoutChoices.slice(0, start!) + textWithoutChoices.slice(end!);
        }

        return {
          hasChoices: true,
          choices,
          textWithoutChoices: textWithoutChoices.trim(),
        };
      }
    }
  }

  return bestResult;
}

export function extractQuestionWithOptions(text: string): {
  question: string;
  options: ParsedChoice[];
} | null {
  const result = parseChoices(text);

  if (!result.hasChoices) {
    return null;
  }

  // Extract the question (all text before the choices, cleaned up)
  const question = result.textWithoutChoices.trim();

  return {
    question,
    options: result.choices,
  };
}