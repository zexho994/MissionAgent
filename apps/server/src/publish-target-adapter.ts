export type PublishResult =
  | { ok: true; response: unknown }
  | { ok: false; error: string };

export interface PublishPayload {
  artifactId: string;
  artifactContent: unknown;
  missionGoal: string;
  taskTitle?: string;
}

export interface PublishTargetAdapter {
  publish(payload: PublishPayload, config: unknown): Promise<PublishResult>;
}

export class PublishTargetAdapterRegistry {
  private readonly adapters = new Map<string, PublishTargetAdapter>();

  register(type: string, adapter: PublishTargetAdapter): void {
    this.adapters.set(type, adapter);
  }

  has(type: string): boolean {
    return this.adapters.has(type);
  }

  get(type: string): PublishTargetAdapter {
    const adapter = this.adapters.get(type);
    if (!adapter) {
      throw new Error(`No adapter registered for publish target type "${type}"`);
    }
    return adapter;
  }
}

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export interface HttpPublishTargetAdapterDeps {
  fetch?: FetchFn;
}

export class HttpPublishTargetAdapter implements PublishTargetAdapter {
  private readonly fetchFn: FetchFn;

  constructor(deps: HttpPublishTargetAdapterDeps = {}) {
    this.fetchFn = deps.fetch ?? (globalThis.fetch as FetchFn);
  }

  async publish(payload: PublishPayload, config: unknown): Promise<PublishResult> {
    const cfg = config as
      | {
          url?: string;
          method?: "POST" | "PUT";
          headers?: Record<string, string>;
        }
      | undefined;

    if (!cfg?.url || typeof cfg.url !== "string" || !cfg.url.trim()) {
      return { ok: false, error: "missing url" };
    }
    const method = cfg.method ?? "POST";
    try {
      const headers: Record<string, string> = { "content-type": "application/json", ...(cfg.headers ?? {}) };
      const body = JSON.stringify({
        artifactId: payload.artifactId,
        missionGoal: payload.missionGoal,
        taskTitle: payload.taskTitle,
        artifact: payload.artifactContent,
      });
      const res = await this.fetchFn(cfg.url, { method, headers, body });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
      }
      const contentType = res.headers.get("content-type") ?? "";
      const response = contentType.includes("application/json")
        ? await res.json()
        : await res.text();
      return { ok: true, response };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
