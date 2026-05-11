export type PublishResult =
  | { ok: true; response: unknown; attemptCount: number }
  | { ok: false; error: string; attemptCount: number };

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
type SleepFn = (ms: number) => Promise<void>;

export interface PublishHttpRetryConfig {
  maxAttempts: number;
  initialDelayMs: number;
}

export const DEFAULT_PUBLISH_RETRY: PublishHttpRetryConfig = {
  maxAttempts: 3,
  initialDelayMs: 200,
};

export interface HttpPublishTargetAdapterDeps {
  fetch?: FetchFn;
  sleep?: SleepFn;
  retry?: PublishHttpRetryConfig;
}

export class HttpPublishTargetAdapter implements PublishTargetAdapter {
  private readonly fetchFn: FetchFn;
  private readonly sleepFn: SleepFn;
  private readonly retry: PublishHttpRetryConfig;

  constructor(deps: HttpPublishTargetAdapterDeps = {}) {
    this.fetchFn = deps.fetch ?? (globalThis.fetch as FetchFn);
    this.sleepFn = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.retry = deps.retry ?? DEFAULT_PUBLISH_RETRY;
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
      return { ok: false, error: "missing url", attemptCount: 0 };
    }
    const method = cfg.method ?? "POST";
    const headers: Record<string, string> = {
      "content-type": "application/json",
      ...(cfg.headers ?? {}),
    };
    const body = JSON.stringify({
      artifactId: payload.artifactId,
      missionGoal: payload.missionGoal,
      taskTitle: payload.taskTitle,
      artifact: payload.artifactContent,
    });

    let lastError = "";
    for (let attempt = 1; attempt <= this.retry.maxAttempts; attempt += 1) {
      try {
        const res = await this.fetchFn(cfg.url, { method, headers, body });
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          lastError = `HTTP ${res.status}: ${text.slice(0, 200)}`;
        } else {
          const contentType = res.headers.get("content-type") ?? "";
          const response = contentType.includes("application/json")
            ? await res.json()
            : await res.text();
          return { ok: true, response, attemptCount: attempt };
        }
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
      if (attempt < this.retry.maxAttempts) {
        await this.sleepFn(this.retry.initialDelayMs * 2 ** (attempt - 1));
      }
    }
    return { ok: false, error: lastError, attemptCount: this.retry.maxAttempts };
  }
}
