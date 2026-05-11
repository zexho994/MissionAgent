import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Absolute filesystem paths to extensions bundled with @digitalagent/runtime.
 * Pass these to `PiCliAdapter` (via the `defaultExtensions` option or the
 * `extensions` arg of `runAgentTask`) so pi loads them via its `-e` flag.
 */
export const PI_EXTENSION_PATHS = {
  webSearch: fileURLToPath(new URL("./pi-extensions/web-search.js", import.meta.url)),
} as const;

/**
 * Resolves the absolute path to the `pi` bin shim shipped with
 * `@earendil-works/pi-coding-agent`. Walks up from this module's location
 * looking for the nearest `node_modules/.bin/pi` (handles pnpm's nested
 * workspace layout). Returns `null` if no shim is found, in which case
 * callers should fall back to PATH lookup (command "pi").
 */
export function resolvePiBinaryPath(): string | null {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i += 1) {
    const candidate = join(dir, "node_modules", ".bin", "pi");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}


