export type DataSourceFetchResult =
  | { ok: true; data: unknown }
  | { ok: false; error: string };

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

export interface HttpDataSourceAdapterDeps {
  fetch?: FetchFn;
}

export class HttpDataSourceAdapter implements DataSourceAdapter {
  private readonly fetchFn: FetchFn;

  constructor(deps: HttpDataSourceAdapterDeps = {}) {
    this.fetchFn = deps.fetch ?? (globalThis.fetch as FetchFn);
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
      return { ok: false, error: "missing url" };
    }
    const method = cfg.method ?? "GET";
    try {
      const init: RequestInit = { method };
      if (cfg.headers) init.headers = cfg.headers;
      if (method === "POST" && cfg.body !== undefined) init.body = cfg.body;
      const res = await this.fetchFn(cfg.url, init);
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
      }
      const contentType = res.headers.get("content-type") ?? "";
      const data = contentType.includes("application/json")
        ? await res.json()
        : await res.text();
      return { ok: true, data };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
