import type {
  BeforeToolCallContext,
  AfterToolCallContext,
  ShouldStopAfterTurnContext,
  BeforeToolCallResult,
  AfterToolCallResult,
} from "@earendil-works/pi-agent-core";

export type {
  BeforeToolCallContext,
  AfterToolCallContext,
  ShouldStopAfterTurnContext,
  BeforeToolCallResult,
  AfterToolCallResult,
};

export const noopBeforeToolCall = undefined;
export const noopAfterToolCall = undefined;
export const noopShouldStopAfterTurn = undefined;
