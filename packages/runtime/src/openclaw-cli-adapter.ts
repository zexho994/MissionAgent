import { spawn } from "node:child_process";

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface CommandRunOptions {
  timeoutSeconds?: number;
}

export type CommandRunner = (
  command: string,
  args: string[],
  options?: CommandRunOptions,
) => Promise<CommandResult>;

export interface OpenClawHealth {
  available: boolean;
  version?: string;
  error?: string;
}

export interface OpenClawAgentTask {
  message: string;
  timeoutSeconds: number;
  agentId?: string;
}

export interface OpenClawAgentInfo {
  id: string;
  isDefault: boolean;
}

export interface OpenClawAgentResult {
  status: "completed";
  output: unknown;
  stderr: string;
}

export interface OpenClawCliAdapterOptions {
  command?: string;
  defaultAgentId?: string;
  run?: CommandRunner;
}

export class OpenClawCliAdapter {
  private readonly command: string;
  private readonly configuredDefaultAgentId: string | undefined;
  private readonly runCommand: CommandRunner;

  constructor(options: OpenClawCliAdapterOptions = {}) {
    this.command = options.command ?? "openclaw";
    this.configuredDefaultAgentId = options.defaultAgentId ?? process.env.OPENCLAW_AGENT_ID;
    this.runCommand = options.run ?? runProcess;
  }

  async health(): Promise<OpenClawHealth> {
    const result = await this.runCommand(this.command, ["--version"]);
    if (result.exitCode !== 0) {
      return {
        available: false,
        error: result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`,
      };
    }

    return {
      available: true,
      version: result.stdout.trim(),
    };
  }

  async listAgents(): Promise<OpenClawAgentInfo[]> {
    const result = await this.runCommand(this.command, ["agents", "list"]);
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || result.stdout.trim() || `OpenClaw agents list exited ${result.exitCode}`);
    }

    return parseAgentList(result.stdout);
  }

  async runAgentTask(task: OpenClawAgentTask): Promise<OpenClawAgentResult> {
    if (!task.message.trim()) {
      throw new Error("OpenClaw agent task message is required");
    }
    if (task.timeoutSeconds <= 0) {
      throw new Error("OpenClaw agent task timeoutSeconds must be positive");
    }
    const agentId = task.agentId ?? (await this.resolveDefaultAgentId());
    if (!agentId.trim()) {
      throw new Error("OpenClaw agent id is required");
    }

    const result = await this.runCommand(this.command, [
      "agent",
      "--local",
      "--json",
      "--agent",
      agentId,
      "--timeout",
      String(task.timeoutSeconds),
      "--message",
      task.message,
    ], { timeoutSeconds: task.timeoutSeconds + 5 });

    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || result.stdout.trim() || `OpenClaw exited ${result.exitCode}`);
    }

    try {
      const output = result.stdout.trim() ? result.stdout : result.stderr;
      return {
        status: "completed",
        output: parseOpenClawJson(output),
        stderr: result.stderr,
      };
    } catch {
      throw new Error("OpenClaw returned non-JSON output");
    }
  }

  private async resolveDefaultAgentId(): Promise<string> {
    if (this.configuredDefaultAgentId?.trim()) {
      return this.configuredDefaultAgentId;
    }

    const agents = await this.listAgents();
    const defaultAgent = agents.find((agent) => agent.isDefault) ?? agents[0];
    if (!defaultAgent) {
      throw new Error("No OpenClaw agents are configured. Run `openclaw agents add` first.");
    }
    return defaultAgent.id;
  }
}

export function parseAgentList(output: string): OpenClawAgentInfo[] {
  return output
    .split("\n")
    .map((line) => line.match(/^- ([^\s]+)(?:\s+\((default)\))?/))
    .filter((match): match is RegExpMatchArray => Boolean(match))
    .map((match) => ({
      id: match[1] ?? "",
      isDefault: match[2] === "default",
    }))
    .filter((agent) => agent.id.length > 0);
}

export function parseOpenClawJson(output: string): unknown {
  const trimmed = output.trim();
  if (!trimmed) {
    throw new Error("OpenClaw returned empty JSON output");
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    for (const start of findJsonStarts(trimmed)) {
      try {
        return JSON.parse(trimmed.slice(start));
      } catch {
        // Keep scanning candidate JSON starts; OpenClaw may print warnings before the final JSON payload.
      }
    }
    throw new Error("OpenClaw returned non-JSON output");
  }
}

function findJsonStarts(value: string): number[] {
  const starts: number[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === "{" || value[index] === "[") {
      starts.push(index);
    }
  }
  return starts;
}

function runProcess(command: string, args: string[], options: CommandRunOptions = {}): Promise<CommandResult> {
  return new Promise((resolve) => {
    let completed = false;
    let timedOut = false;
    const child = spawn(command, args, {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timeout = options.timeoutSeconds
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
          setTimeout(() => {
            if (!completed) child.kill("SIGKILL");
          }, 2_000);
        }, options.timeoutSeconds * 1_000)
      : undefined;

    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      completed = true;
      if (timeout) clearTimeout(timeout);
      resolve({ exitCode: 127, stdout, stderr: error.message });
    });
    child.on("close", (code) => {
      completed = true;
      if (timeout) clearTimeout(timeout);
      const timeoutMessage = timedOut ? `OpenClaw command timed out after ${options.timeoutSeconds} seconds` : "";
      resolve({
        exitCode: timedOut ? 124 : code ?? 1,
        stdout,
        stderr: [stderr.trim(), timeoutMessage].filter(Boolean).join("\n"),
      });
    });
  });
}
