import type { Source } from "@digitalagent/core";

export interface MissionExecutionRuntime {
  runAgentTask(input: {
    message: string;
    timeoutSeconds: number;
    systemPrompt?: string;
  }): Promise<{
    status: string;
    output: unknown;
    stderr: string;
  }>;
}

export function buildOpenClawMessage(input: {
  message: string;
  mission: unknown;
  task: unknown;
}): string {
  return [
    "You are executing a DigitalAgent Mission task.",
    "Use the mission context below. Do not look for local Mission files.",
    "Return one valid JSON object only.",
    "",
    "Mission context:",
    JSON.stringify(
      {
        mission: input.mission,
        task: input.task,
      },
      null,
      2,
    ),
    "",
    "User instruction:",
    input.message,
  ].join("\n");
}

/**
 * Extracts source information from OpenClaw agent output.
 * The OpenClaw output may contain search results in various formats:
 * - searchResults: Array of {url, title, snippet, searchKeyword}
 * - sources: Array of {url, title, snippet}
 * - webSearch: Object with searchKeyword and results
 */
export function extractSourcesFromOpenClawOutput(output: unknown): Source[] {
  const sources: Source[] = [];

  if (!output || typeof output !== "object") {
    return sources;
  }

  const record = output as Record<string, unknown>;

  // Check for searchResults array
  const searchResults = record.searchResults as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(searchResults)) {
    for (const result of searchResults) {
      if (result.url && typeof result.url === "string") {
        const src: Source = { url: result.url };
        if (typeof result.title === "string") src.title = result.title;
        if (typeof result.snippet === "string") src.snippet = result.snippet;
        if (typeof result.searchKeyword === "string") src.searchKeyword = result.searchKeyword;
        sources.push(src);
      }
    }
    if (sources.length > 0) {
      return sources;
    }
  }

  // Check for sources array
  const directSources = record.sources as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(directSources)) {
    for (const source of directSources) {
      if (source.url && typeof source.url === "string") {
        const src: Source = { url: source.url };
        if (typeof source.title === "string") src.title = source.title;
        if (typeof source.snippet === "string") src.snippet = source.snippet;
        sources.push(src);
      }
    }
    if (sources.length > 0) {
      return sources;
    }
  }

  // Check for webSearch object
  const webSearch = record.webSearch as Record<string, unknown> | undefined;
  if (webSearch && typeof webSearch === "object") {
    const searchKeyword = typeof webSearch.searchKeyword === "string" ? webSearch.searchKeyword : undefined;
    const results = webSearch.results as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(results)) {
      for (const result of results) {
        if (result.url && typeof result.url === "string") {
          const src: Source = { url: result.url };
          if (typeof result.title === "string") src.title = result.title;
          if (typeof result.snippet === "string") src.snippet = result.snippet;
          if (searchKeyword) src.searchKeyword = searchKeyword;
          sources.push(src);
        }
      }
    }
  }

  // Check payloads for source references (common pattern in OpenClaw outputs)
  const payloads = record.payloads as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(payloads)) {
    for (const payload of payloads) {
      if (payload.sources && Array.isArray(payload.sources)) {
        for (const source of payload.sources as Array<Record<string, unknown>>) {
          if (source.url && typeof source.url === "string") {
            const src: { url: string; title?: string; snippet?: string } = { url: source.url };
            if (typeof source.title === "string") src.title = source.title;
            if (typeof source.snippet === "string") src.snippet = source.snippet;
            sources.push(src);
          }
        }
      }
      // Also check for searchResults within payload
      const payloadSearchResults = payload.searchResults as Array<Record<string, unknown>> | undefined;
      if (Array.isArray(payloadSearchResults)) {
        for (const result of payloadSearchResults) {
          if (result.url && typeof result.url === "string") {
            const src: { url: string; title?: string; snippet?: string; searchKeyword?: string } = { url: result.url };
            if (typeof result.title === "string") src.title = result.title;
            if (typeof result.snippet === "string") src.snippet = result.snippet;
            if (typeof result.searchKeyword === "string") src.searchKeyword = result.searchKeyword;
            sources.push(src);
          }
        }
      }
    }
  }

  return sources;
}
