export interface MigrationResult {
  json: string;
  migrated: boolean;
}

function rewriteLegacyDisplayCopy(input: string): string {
  return input
    .replace(
      /Started local OpenClaw execution for the current task\./g,
      "Started local pi-agent execution for the current task.",
    )
    .replace(/invoked OpenClaw local agent\./g, "invoked local pi-agent runtime.")
    .replace(/Artifact has no OpenClaw output/g, "Artifact has no pi-agent output")
    .replace(
      /Agent output is empty or too short/g,
      "Agent 输出为空或过短，无法作为有效结果验收。",
    )
    .replace(
      /Reassess strategy after "([^"]+)" failed to produce usable Mission progress\./g,
      "重新评估任务策略：当前任务“$1”没有产出可验收的 Mission 进展。",
    )
    .replace(
      /Reassess strategy after \\"([^"]+)\\" failed to produce usable Mission progress\./g,
      "重新评估任务策略：当前任务“$1”没有产出可验收的 Mission 进展。",
    );
}

export function migrateOpenClawToPi(input: string): MigrationResult {
  const trimmed = input.trim();
  if (!trimmed) {
    return { json: JSON.stringify({ migrationDone: true }), migrated: false };
  }

  const parsed = JSON.parse(trimmed);
  if (parsed && typeof parsed === "object" && parsed.migrationDone === true) {
    const displayRewritten = rewriteLegacyDisplayCopy(input);
    if (displayRewritten === input) {
      return { json: JSON.stringify(parsed), migrated: false };
    }
    const displayParsed = JSON.parse(displayRewritten);
    if (displayParsed && typeof displayParsed === "object") {
      displayParsed.migrationDone = true;
    }
    return { json: JSON.stringify(displayParsed), migrated: true };
  }

  const rewritten = rewriteLegacyDisplayCopy(input.replace(/openclaw/g, "pi"));
  const reparsed = JSON.parse(rewritten);
  if (reparsed && typeof reparsed === "object") {
    reparsed.migrationDone = true;
  }
  return { json: JSON.stringify(reparsed), migrated: input !== rewritten };
}
