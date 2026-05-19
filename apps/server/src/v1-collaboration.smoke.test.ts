import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { InMemoryMissionService } from "./mission-service.js";
import type { MissionExecutionRuntime } from "./runtime-bridge.js";
import {
  PiSdkAdapter,
  createPiAgentLlmService,
  createSkillTools,
  createWebSearchTool,
} from "@digitalagent/runtime";

const REAL_LLM = process.env.PI_SMOKE === "1";

const smokeDescribe = REAL_LLM ? describe : describe.skip;

smokeDescribe("V1 接龙:5 个 agent 协作完成 15 轮 (real LLM)", () => {
  it(
    "招出团队、agent 协作写 chain.txt、达到 15 行后链子终止",
    async () => {
      const workspaceRoot = mkdtempSync(join(tmpdir(), "v1-smoke-"));
      const storageFile = join(workspaceRoot, "store.json");

      const apiKey =
        process.env.LLM_API_KEY ??
        process.env.MINIMAX_API_KEY ??
        process.env.ANTHROPIC_API_KEY ??
        "";
      if (!apiKey) {
        throw new Error(
          "V1 smoke requires LLM_API_KEY / MINIMAX_API_KEY / ANTHROPIC_API_KEY",
        );
      }

      const skillRoot = join(process.cwd(), "config", "skills");
      const skillTools = createSkillTools({ rootDir: skillRoot });

      const llm = createPiAgentLlmService({
        apiKey,
        modelProvider: process.env.LLM_PROVIDER ?? "minimax-cn",
        modelId: process.env.LLM_MODEL ?? "MiniMax-M2.7-highspeed",
        tools: skillTools,
      });

      const pi = new PiSdkAdapter({
        apiKey,
        modelProvider: process.env.LLM_PROVIDER ?? "minimax-cn",
        modelId: process.env.LLM_MODEL ?? "MiniMax-M2.7-highspeed",
        tools: [...skillTools, createWebSearchTool({})],
      });

      const runtime: MissionExecutionRuntime = {
        runAgentTask: (input) => pi.runAgentTask(input),
      };

      const missions = new InMemoryMissionService({
        storageFile,
        workspaceRoot,
        llm,
        runtime,
      });

      // === 创建 mission, 走 brief → plan → 激活 ===
      const m = await missions.createMission({
        goal:
          "5 个 agent 协作玩成语接龙,每轮把当前接到的成语写入 chain.txt 文件,下一个 agent 必须先读 chain.txt 拿到上一个成语,再接龙写回。完成 15 次才算成功。",
        successMetrics: ["chain.txt 包含 15 个合法成语,首尾相接"],
        constraints: [],
      });

      // 真实流程:Owner LLM 异步生成 brief → confirm → 生成 MissionPlan → confirm → 激活。
      // Owner 可能追问澄清问题(needs_info / owner_followup),需自动回话推进。
      const getMission = () =>
        missions.snapshot().missions.find((x) => x.id === m.id);

      const waitForOwnerIdle = async (timeoutMs: number): Promise<void> => {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
          const snap = missions.snapshot();
          const owner = snap.agents.find(
            (a) => a.missionId === m.id && a.role === "owner",
          );
          if (owner && owner.status !== "thinking" && owner.status !== "running") return;
          await new Promise((r) => setTimeout(r, 2000));
        }
        throw new Error("[V1 smoke] timeout waiting for Owner to settle");
      };

      // 自动回话直到 Owner 把 brief 写出来,最多 8 轮(maxGatheringTurns 默认 5,加余量)
      const continueMission = (
        missions as unknown as {
          continueMission: (input: {
            missionId: string;
            message: string;
          }) => Promise<unknown>;
        }
      ).continueMission.bind(missions);

      const autoReplies = [
        "就按你理解的目标走,不需要再追问。",
        "保持目标:5 个 agent 协作接龙,完成 15 次。直接生成 brief。",
        "目标已经够清晰了,请立刻输出 mission brief。",
        "不需要再讨论,生成 brief。",
        "Confirm,生成 brief。",
        "Generate the brief now.",
        "OK 就这样。",
        "Yes 直接生成。",
      ];

      let attempt = 0;
      while (!getMission()?.brief && attempt < autoReplies.length) {
        await waitForOwnerIdle(180_000);
        if (getMission()?.brief) break;
        const reply = autoReplies[attempt] ?? "go";
        console.log(`[V1 smoke] auto-reply attempt ${attempt + 1}: ${reply}`);
        await continueMission({ missionId: m.id, message: reply });
        attempt += 1;
      }

      if (!getMission()?.brief) {
        throw new Error(
          `[V1 smoke] Owner failed to produce brief after ${attempt} auto-replies`,
        );
      }

      const anyMissions = missions as unknown as {
        confirmBrief: (input: { missionId: string }) => unknown;
        generateMissionPlan: (input: {
          missionId: string;
        }) => Promise<{ id: string }>;
        confirmMissionPlan: (input: {
          missionId: string;
          planId: string;
        }) => unknown;
      };

      // 2. confirm brief
      anyMissions.confirmBrief({ missionId: m.id });

      // 3. 生成 + confirm plan
      const plan = await anyMissions.generateMissionPlan({ missionId: m.id });
      anyMissions.confirmMissionPlan({
        missionId: m.id,
        planId: plan.id,
      });

      // 4. 激活 mission (HR 开始招团队)
      await missions.activateMission({ missionId: m.id });

      // === 轮询等 mission idle 或超时 ===
      const deadline = Date.now() + 600_000; // 10 分钟
      while (Date.now() < deadline) {
        const snapshot = missions.snapshot();
        const mission = snapshot.missions.find((x) => x.id === m.id);
        if (!mission) throw new Error("mission disappeared mid-run");
        const tasks = snapshot.tasks.filter((t) => t.missionId === m.id);
        const allTerminal =
          tasks.length > 0 &&
          tasks.every((t) =>
            (["completed", "failed"] as string[]).includes(t.status),
          );
        const terminalMissionStatuses: string[] = [
          "completed",
          "cancelled",
        ];
        if (terminalMissionStatuses.includes(mission.status) || allTerminal) {
          break;
        }
        await new Promise((r) => setTimeout(r, 3000));
      }

      // === 断言 ===
      const snapshot = missions.snapshot();
      const mission = snapshot.missions.find((x) => x.id === m.id);
      if (!mission) throw new Error("mission disappeared at end of run");

      expect(mission.status).not.toBe("cancelled");

      const workerAgents = snapshot.agents.filter(
        (a) =>
          a.missionId === m.id && !(["owner", "hr"] as string[]).includes(a.role),
      );
      expect(workerAgents.length).toBeGreaterThanOrEqual(2);
      expect(workerAgents.length).toBeLessThanOrEqual(10);

      // chain.txt 存在 + 行数
      const chainPath = join(workspaceRoot, m.id, "chain.txt");
      expect(existsSync(chainPath)).toBe(true);
      const lines = readFileSync(chainPath, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean);
      expect(lines.length).toBeGreaterThanOrEqual(15);
      for (const line of lines) {
        expect(line.trim().length).toBeGreaterThanOrEqual(2);
        expect(line.trim().length).toBeLessThanOrEqual(8);
      }

      // 工具调用证据
      const calls = snapshot.toolCalls.filter((c) => c.missionId === m.id);
      expect(calls.some((c) => c.toolName === "file_write")).toBe(true);
      expect(calls.some((c) => c.toolName === "file_read")).toBe(true);
      expect(
        calls.filter((c) => c.toolName === "pass_to_next_agent").length,
      ).toBeGreaterThanOrEqual(10);

      // 每个 worker agent 至少有 1 条 toolCall(没人摸鱼)
      for (const a of workerAgents) {
        const own = calls.filter((c) => c.agentId === a.id);
        expect(own.length).toBeGreaterThan(0);
      }

      rmSync(workspaceRoot, { recursive: true, force: true });
    },
    700_000,
  );
});
