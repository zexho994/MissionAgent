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

export interface PiHealth {
  available: boolean;
  version?: string;
  error?: string;
}

export interface PiAgentTask {
  message: string;
  timeoutSeconds: number;
  systemPrompt?: string;
  tools?: string[];
  extensions?: string[];
}

export interface PiAgentResult {
  status: "completed";
  output: unknown;
  stderr: string;
}

export interface PiCliAdapterOptions {
  command?: string;
  defaultTools?: string[];
  defaultExtensions?: string[];
  run?: CommandRunner;
}

const DEFAULT_TOOLS = ["read", "grep", "find", "ls", "bash", "web_search"];

export class PiCliAdapter {
  private readonly command: string;
  private readonly defaultTools: string[];
  private readonly defaultExtensions: string[];
  private readonly runCommand: CommandRunner;

  constructor(options: PiCliAdapterOptions = {}) {
    this.command = options.command ?? "pi";
    this.defaultTools = options.defaultTools ?? DEFAULT_TOOLS;
    this.defaultExtensions = options.defaultExtensions ?? [];
    this.runCommand = options.run ?? runProcess;
  }

  async health(): Promise<PiHealth> {
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

  async runAgentTask(task: PiAgentTask): Promise<PiAgentResult> {
    if (!task.message.trim()) {
      throw new Error("pi agent task message is required");
    }
    if (task.timeoutSeconds <= 0) {
      throw new Error("pi agent task timeoutSeconds must be positive");
    }

    const tools = (task.tools ?? this.defaultTools).join(",");
    const extensions = task.extensions ?? this.defaultExtensions;
    const args: string[] = ["-p", "--no-session", "--tools", tools];

    if (task.systemPrompt) {
      args.push("--system-prompt", task.systemPrompt);
    }
    for (const ext of extensions) {
      args.push("-e", ext);
    }
    args.push(task.message);

    const result = await this.runCommand(this.command, args, {
      timeoutSeconds: task.timeoutSeconds + 30,
    });

    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || result.stdout.trim() || `pi exited ${result.exitCode}`);
    }

    const output = result.stdout.trim() ? result.stdout : result.stderr;
    return {
      status: "completed",
      output: parsePiOutputJson(output),
      stderr: result.stderr,
    };
  }
}

export function parsePiOutputJson(output: string): unknown {
  const trimmed = output.trim();
  if (!trimmed) {
    throw new Error("pi returned empty JSON output");
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    for (const start of findJsonStarts(trimmed)) {
      try {
        return JSON.parse(trimmed.slice(start));
      } catch {
        // Keep scanning candidate JSON starts; pi may print warnings before the final JSON payload.
      }
    }
    throw new Error("pi returned non-JSON output");
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
      const timeoutMessage = timedOut ? `pi command timed out after ${options.timeoutSeconds} seconds` : "";
      resolve({
        exitCode: timedOut ? 124 : code ?? 1,
        stdout,
        stderr: [stderr.trim(), timeoutMessage].filter(Boolean).join("\n"),
      });
    });
  });
}
