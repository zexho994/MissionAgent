import { randomUUID } from "node:crypto";

export function createId(prefix: string): string {
  if (!prefix.trim()) {
    throw new Error("ID prefix is required");
  }

  return `${prefix}_${randomUUID()}`;
}
