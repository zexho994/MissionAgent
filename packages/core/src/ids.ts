let nextId = 1;

export function createId(prefix: string): string {
  if (!prefix.trim()) {
    throw new Error("ID prefix is required");
  }

  const id = `${prefix}_${nextId}`;
  nextId += 1;
  return id;
}
