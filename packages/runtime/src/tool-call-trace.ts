export interface ToolCallTraceEvent {
  status: "start" | "end";
  traceLabel: string;
  toolName: string;
  toolCallId: string;
  sessionId?: string;
  args?: unknown;
  ok?: boolean;
  details?: unknown;
  error?: unknown;
}
