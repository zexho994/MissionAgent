export type DataSourceFetchResult =
  | { ok: true; data: unknown; attemptCount: number }
  | { ok: false; error: string; attemptCount: number };

export interface DataSourceAdapter {
  fetch(config: unknown): Promise<DataSourceFetchResult>;
}

export class DataSourceAdapterRegistry {
  private readonly adapters = new Map<string, DataSourceAdapter>();

  register(type: string, adapter: DataSourceAdapter): void {
    this.adapters.set(type, adapter);
  }

  has(type: string): boolean {
    return this.adapters.has(type);
  }

  get(type: string): DataSourceAdapter {
    const adapter = this.adapters.get(type);
    if (!adapter) {
      throw new Error(`No adapter registered for data source type "${type}"`);
    }
    return adapter;
  }
}

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;
type SleepFn = (ms: number) => Promise<void>;

export interface HttpRetryConfig {
  maxAttempts: number;
  initialDelayMs: number;
}

export const DEFAULT_HTTP_RETRY: HttpRetryConfig = {
  maxAttempts: 3,
  initialDelayMs: 200,
};

export interface HttpDataSourceAdapterDeps {
  fetch?: FetchFn;
  sleep?: SleepFn;
  retry?: HttpRetryConfig;
}

export class HttpDataSourceAdapter implements DataSourceAdapter {
  private readonly fetchFn: FetchFn;
  private readonly sleepFn: SleepFn;
  private readonly retry: HttpRetryConfig;

  constructor(deps: HttpDataSourceAdapterDeps = {}) {
    this.fetchFn = deps.fetch ?? (globalThis.fetch as FetchFn);
    this.sleepFn = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.retry = deps.retry ?? DEFAULT_HTTP_RETRY;
  }

  async fetch(config: unknown): Promise<DataSourceFetchResult> {
    const cfg = config as
      | {
          url?: string;
          method?: "GET" | "POST";
          headers?: Record<string, string>;
          body?: string;
        }
      | undefined;

    if (!cfg?.url || typeof cfg.url !== "string" || !cfg.url.trim()) {
      return { ok: false, error: "missing url", attemptCount: 0 };
    }
    const method = cfg.method ?? "GET";
    let lastError = "";
    for (let attempt = 1; attempt <= this.retry.maxAttempts; attempt += 1) {
      try {
        const init: RequestInit = { method };
        if (cfg.headers) init.headers = cfg.headers;
        if (method === "POST" && cfg.body !== undefined) init.body = cfg.body;
        const res = await this.fetchFn(cfg.url, init);
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          lastError = `HTTP ${res.status}: ${text.slice(0, 200)}`;
        } else {
          const contentType = res.headers.get("content-type") ?? "";
          const data = contentType.includes("application/json")
            ? await res.json()
            : await res.text();
          return { ok: true, data, attemptCount: attempt };
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
