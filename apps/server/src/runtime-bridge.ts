import type { Source } from "@digitalagent/core";
import type { AgentTool, ToolCallTraceEvent } from "@digitalagent/runtime";

export interface MissionExecutionRuntime {
  runAgentTask(input: {
    message: string;
    timeoutSeconds: number;
    systemPrompt?: string;
    sessionId?: string;
    missionId?: string;
    agentId?: string;
    tools?: AgentTool<any>[];
    onToolEvent?: (event: ToolCallTraceEvent) => void;
  }): Promise<{
    status: string;
    output: unknown;
    stderr: string;
    sources?: Source[];
  }>;
}

export function buildAgentMessage(input: {
  message: string;
  mission: unknown;
  task: unknown;
}): string {
  const lines: string[] = [
    "Mission context:",
    JSON.stringify({ mission: input.mission, task: input.task }, null, 2),
  ];

  const taskRecord = (input.task && typeof input.task === "object" ? input.task : {}) as Record<string, unknown>;
  const origin = taskRecord.origin as { type?: string } | undefined;
  if (origin?.type === "followup") {
    lines.push(
      "",
      "Note: This is a follow-up task handed off from a teammate. Before producing new output, read any referenced files in the mission workspace (e.g. chain.txt) so you know what your teammate already produced.",
    );
  }

  lines.push("", "User instruction:", input.message);
  return lines.join("\n");
}

/**
 * Extracts source information from pi runtime output, merged with any sources
 * pre-collected from the pi event stream (`tool_execution_end` events).
 *
 * pi output may contain search results in various legacy formats (kept for
 * backwards compatibility with v1 artifacts):
 * - searchResults: Array of {url, title, snippet, searchKeyword}
 * - sources: Array of {url, title, snippet}
 * - webSearch: Object with searchKeyword and results
 * - payloads[].sources / payloads[].searchResults
 *
 * preCollected sources from the adapter's event-stream subscription take
 * precedence (deduped by URL).
 */
export function extractSourcesFromPiOutput(
  output: unknown,
  preCollected: Source[] = [],
): Source[] {
  const sources: Source[] = [...preCollected];
  const seen = new Set(sources.map((s) => s.url));

  if (!output || typeof output !== "object") {
    return sources;
  }

  const record = output as Record<string, unknown>;
  const push = (src: Source): void => {
    if (seen.has(src.url)) return;
    sources.push(src);
    seen.add(src.url);
  };

  // Check for searchResults array
  const searchResults = record.searchResults as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(searchResults)) {
    for (const result of searchResults) {
      if (result.url && typeof result.url === "string") {
        const src: Source = { url: result.url };
        if (typeof result.title === "string") src.title = result.title;
        if (typeof result.snippet === "string") src.snippet = result.snippet;
        if (typeof result.searchKeyword === "string") src.searchKeyword = result.searchKeyword;
        push(src);
      }
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
        push(src);
      }
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
          push(src);
        }
      }
    }
  }

  // Check payloads for source references (common pattern in v1 artifacts)
  const payloads = record.payloads as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(payloads)) {
    for (const payload of payloads) {
      if (payload.sources && Array.isArray(payload.sources)) {
        for (const source of payload.sources as Array<Record<string, unknown>>) {
          if (source.url && typeof source.url === "string") {
            const src: Source = { url: source.url };
            if (typeof source.title === "string") src.title = source.title;
            if (typeof source.snippet === "string") src.snippet = source.snippet;
            push(src);
          }
        }
      }
      const payloadSearchResults = payload.searchResults as Array<Record<string, unknown>> | undefined;
      if (Array.isArray(payloadSearchResults)) {
        for (const result of payloadSearchResults) {
          if (result.url && typeof result.url === "string") {
            const src: Source = { url: result.url };
            if (typeof result.title === "string") src.title = result.title;
            if (typeof result.snippet === "string") src.snippet = result.snippet;
            if (typeof result.searchKeyword === "string") src.searchKeyword = result.searchKeyword;
            push(src);
          }
        }
      }
    }
  }

  return sources;
}
