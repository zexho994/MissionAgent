export interface MigrationResult {
  json: string;
  migrated: boolean;
}

export function migrateOpenClawToPi(input: string): MigrationResult {
  const trimmed = input.trim();
  if (!trimmed) {
    return { json: JSON.stringify({ migrationDone: true }), migrated: false };
  }

  const parsed = JSON.parse(trimmed);
  if (parsed && typeof parsed === "object" && parsed.migrationDone === true) {
    return { json: JSON.stringify(parsed), migrated: false };
  }

  const rewritten = input.replace(/openclaw/g, "pi");
  const reparsed = JSON.parse(rewritten);
  if (reparsed && typeof reparsed === "object") {
    reparsed.migrationDone = true;
  }
  return { json: JSON.stringify(reparsed), migrated: input !== rewritten };
}
