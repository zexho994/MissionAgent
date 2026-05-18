/**
 * Agent handoff pi extension — `pass_to_next_agent` tool.
 *
 * Lets the executing agent hand off the next concrete step to a teammate
 * by role name. Internally creates a follow-up task (assigned to that role)
 * AND appends an agent_chat message so the handoff is visible in the UI.
 *
 * Built per-call with closures over the current mission / task / agent ID
 * (those values cannot be statically bound to the adapter).
 */

import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";

export interface CreateFollowupTaskInput {
  missionId: string;
  triggeringEventId: string;
  payload: {
    title: string;
    objective: string;
    assigneeRole: string;
    reason: string;
    sourceTaskId?: string;
    inputContext: Record<string, unknown>;
  };
}

export type CreateFollowupTaskResult =
  | { created: true; taskId: string }
  | {
      created: false;
      reason: "per_event_limit" | "mission_cap" | "no_assignee" | "mission_paused" | "budget_exceeded";
      escalateMessageSent?: boolean;
    };

export interface AppendMessageInput {
  missionId: string;
  fromAgentId: string;
  type: "agent_chat";
  content: string;
}

export interface PassToNextAgentDeps {
  missionId: string;
  sourceTaskId: string;
  sourceAgentId: string;
  createFollowupTask: (input: CreateFollowupTaskInput) => Promise<CreateFollowupTaskResult>;
  appendMessage: (input: AppendMessageInput) => void;
}

const PassToNextAgentParameters = Type.Object({
  nextRole: Type.String({ description: "Role name of the teammate to receive the next task (must match a role in the mission team)." }),
  objective: Type.String({ description: "One-sentence description of what the next agent should do." }),
  reason: Type.String({ description: "Why the handoff is happening; appears in the agent message log." }),
  inputContext: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: "Optional structured context the next agent will see in their task input." })),
});

export function createPassToNextAgentTool(deps: PassToNextAgentDeps): AgentTool<typeof PassToNextAgentParameters> {
  return {
    name: "pass_to_next_agent",
    label: "Pass to Next Agent",
    description:
      "Hand off the next concrete step to a teammate by role name. The platform will immediately create a task assigned to that role and start them. Call ONLY when your own turn is complete AND there is genuinely a next step a teammate should take. Returns { created: true, taskId } on success or { created: false, reason } on failure.",
    parameters: PassToNextAgentParameters,
    async execute(toolCallId: string, params: any) {
      const nextRole: string = params.nextRole;
      const objective: string = params.objective;
      const reason: string = params.reason;
      const inputContext: Record<string, unknown> = params.inputContext ?? {};

      const triggeringEventId = `handoff:${deps.sourceTaskId}:${toolCallId}`;

      const result = await deps.createFollowupTask({
        missionId: deps.missionId,
        triggeringEventId,
        payload: {
          title: `${nextRole}: ${objective.slice(0, 40)}`,
          objective,
          assigneeRole: nextRole,
          reason,
          sourceTaskId: deps.sourceTaskId,
          inputContext,
        },
      });

      deps.appendMessage({
        missionId: deps.missionId,
        fromAgentId: deps.sourceAgentId,
        type: "agent_chat",
        content: `[递棒→${nextRole}] ${reason}`,
      });

      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: result as unknown as Record<string, unknown>,
      };
    },
  };
}
