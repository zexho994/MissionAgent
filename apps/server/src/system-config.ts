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
  skills: {
    rootDir: string;
  };
  teamPlanner: {
    baseAgents: ConfigAgentSpec[];
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
  scheduler?: {
    defaultTimezone?: string;
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
  systemPrompt?: string;
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

const TASK_OUTPUT_FORMAT_DIRECTIVE = [
  "",
  "Output requirement:",
  "Your final assistant message MUST be a single valid JSON object (no surrounding prose, no markdown fences) with this shape:",
  "{",
  '  "summary": "<one-paragraph plain-text summary of what you produced>",',
  '  "payloads": [<task-specific outputs; can be empty array>],',
  '  "searchResults": [{"url":"...","title":"...","snippet":"...","searchKeyword":"..."}],',
  '  "sources": [{"url":"...","title":"...","snippet":"..."}]',
  "}",
  "If you did not perform web research, return empty arrays for searchResults and sources.",
].join("\n");

const RUNTIME_SKILL_TOOL_DIRECTIVE = [
  "",
  "DigitalAgent capability context:",
  "You have access to skill loading tools: list_skill_files and load_skill.",
  "",
  "The following capability skill files exist (the ONLY valid load_skill paths):",
  "  • digitalagent/SKILL.md (index)",
  "  • digitalagent/capabilities/file-io.md",
  "  • digitalagent/capabilities/agent-collaboration.md",
  "  • digitalagent/capabilities/web-search.md",
  "  • digitalagent/capabilities/browser-validation.md",
  "  • digitalagent/capabilities/code-writing.md",
  "",
  "When and how to load:",
  "- Load a skill file ONLY if your current task actually needs that capability AND you have not already loaded it in this conversation.",
  "- Check the tool-call history: if a load_skill result is already in your context, REUSE it — do NOT call load_skill again on the same path.",
  "- Do NOT invent paths. Calling load_skill on a path not listed above will fail.",
  "- Maximum 3 load_skill calls per task. After that, act with what you have.",
  "",
  "Skill files are the authoritative source for tool names and signatures. Do not assume tool names that are not listed in the loaded skill content.",
  "Do not expose skill loading details to the user.",
].join("\n");

export function getRoleSystemPrompt(roleName: string, config: AgentSystemConfig): string | undefined {
  const spec = findRoleSpec(roleName, config);
  if (!spec || !spec.systemPrompt || !spec.systemPrompt.trim()) {
    // Dynamic roles (HR-recruited) still get skill tool guidance
    return `${RUNTIME_SKILL_TOOL_DIRECTIVE}${TASK_OUTPUT_FORMAT_DIRECTIVE}`;
  }
  return `${spec.systemPrompt.trim()}${RUNTIME_SKILL_TOOL_DIRECTIVE}${TASK_OUTPUT_FORMAT_DIRECTIVE}`;
}

function findRoleSpec(roleName: string, config: AgentSystemConfig): ConfigAgentSpec | undefined {
  const buckets: ConfigAgentSpec[] = [
    ...config.teamPlanner.baseAgents,
  ];
  return buckets.find((agent) => agent.role === roleName);
}

function validateAgentSystemConfig(config: AgentSystemConfig): void {
  if (!config.owner?.brief?.summaryTemplate.trim()) throw new Error("owner.brief.summaryTemplate is required");
  if (!config.owner.brief.successMetrics.length) throw new Error("owner.brief.successMetrics is required");
  if (!config.owner.brief.constraints.length) throw new Error("owner.brief.constraints is required");
  if (!config.owner.followup.template.trim()) throw new Error("owner.followup.template is required");
  if (!config.skills?.rootDir?.trim()) throw new Error("skills.rootDir is required");
  if (!config.teamPlanner.baseAgents.length) throw new Error("teamPlanner.baseAgents is required");
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
