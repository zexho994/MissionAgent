import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface AgentSystemConfig {
  owner: {
    prompts?: {
      systemPrompt: string;
      gatheringInstruction: string;
      briefSchema: string;
      maxGatheringTurns: number;
    };
    brief: {
      summaryTemplate: string;
      successMetrics: string[];
      constraints: string[];
    };
    followup: {
      template: string;
    };
  };
  teamPlanner: {
    baseAgents: ConfigAgentSpec[];
    rules: Array<{
      id: string;
      keywords: string[];
      agent: ConfigAgentSpec;
    }>;
    fallbackAgent: ConfigAgentSpec;
    reviewAgent: ConfigAgentSpec;
    relationLabels: Array<{
      fromRole?: string;
      toRole?: string;
      fromRoleIncludes?: string;
      label: string;
    }>;
    initialTasks: Array<{
      requires: string[];
      title: string;
      objective: string;
    }>;
    capabilityMatchers: Record<"plan" | "execute" | "review", string[]>;
  };
  agentCollaboration?: {
    maxConversationDepth: number;
    maxDiscussionRounds?: number;
    cooldownMs: number;
    contextTokenBudget: number;
    personas?: Record<string, {
      role: string;
      systemPrompt: string;
      communicationStyle: string;
      responseGuidelines: string;
      availableActions: string[];
    }>;
  };
  agentAutonomy?: {
    tickIntervalMs?: number;
    maxConcurrentEvals?: number;
    reportFrequencyTicks?: number;
  };
  ui: {
    emptyPrompt: string;
    starterPrompts: Array<{ label: string; value: string }>;
  };
}

export interface ConfigAgentSpec {
  role: string;
  name: string;
  responsibility: string;
  status: "idle" | "thinking" | "running" | "blocked" | "done";
  currentTask: boolean;
  lastAction: string;
  avatarSeed: string;
}

export function loadAgentSystemConfig(configFile = join(process.cwd(), "config", "agent-system.json")): AgentSystemConfig {
  if (!existsSync(configFile)) {
    throw new Error(`Agent system config not found: ${configFile}`);
  }
  const config = JSON.parse(readFileSync(configFile, "utf8")) as AgentSystemConfig;
  validateAgentSystemConfig(config);
  return config;
}

function validateAgentSystemConfig(config: AgentSystemConfig): void {
  if (!config.owner?.brief?.summaryTemplate.trim()) throw new Error("owner.brief.summaryTemplate is required");
  if (!config.owner.brief.successMetrics.length) throw new Error("owner.brief.successMetrics is required");
  if (!config.owner.brief.constraints.length) throw new Error("owner.brief.constraints is required");
  if (!config.owner.followup.template.trim()) throw new Error("owner.followup.template is required");
  if (!config.teamPlanner.baseAgents.length) throw new Error("teamPlanner.baseAgents is required");
  if (!config.teamPlanner.rules.length) throw new Error("teamPlanner.rules is required");
  if (!config.teamPlanner.initialTasks.length) throw new Error("teamPlanner.initialTasks is required");
  if (!config.teamPlanner.capabilityMatchers.plan.length) throw new Error("teamPlanner.capabilityMatchers.plan is required");
  if (!config.ui.emptyPrompt.trim()) throw new Error("ui.emptyPrompt is required");
}

export function renderTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    if (!(key in values)) {
      throw new Error(`Missing template value: ${key}`);
    }
    return values[key] ?? "";
  });
}
