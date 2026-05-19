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
        timeoutSeconds: 600,
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

      // 4. 激活 mission(HR 同步 propose 团队)
      await missions.activateMission({ missionId: m.id });

      // 5. 确认协商,部署 worker agents + 创建首个 task + 启动 autonomy loop
      (
        missions as unknown as {
          confirmNegotiation: (input: { missionId: string }) => unknown;
        }
      ).confirmNegotiation({ missionId: m.id });

      // 6. 找到初始 task 并触发执行(平台不会自动跑首个 task,需主动调 executeTask)
      const initialTask = missions
        .snapshot()
        .tasks.find((t) => t.missionId === m.id && t.status === "draft");
      if (!initialTask) {
        throw new Error("[V1 smoke] initial task not created by confirmNegotiation");
      }
      // 列出团队成员以便 LLM 知道接力对象
      const teamRoster = missions
        .snapshot()
        .agents.filter(
          (a) => a.missionId === m.id && !["owner", "hr"].includes(a.role),
        )
        .map((a) => `- "${a.name || a.role}": ${a.responsibility ?? "成语接龙参与者"}`)
        .join("\n");

      const directiveMessage = [
        "你是接龙的第一棒。请按以下步骤执行:",
        "",
        "1. 调用 file_read({ path: 'chain.txt' }) 检查现状(第一棒应该 exists: false)。",
        "2. 想一个常用的 4 字成语作为起始词。",
        "3. 调用 file_write({ path: 'chain.txt', mode: 'append', content: '<成语>\\n' }) 写入。",
        "4. 调用 pass_to_next_agent({ nextRole: '<队友名字>', objective: '继续接龙', reason: '我接了 <成语>,下一棒首字 <尾字>' }) 把任务交给团队中的下一个队友。",
        "",
        "目标:整队接龙完成 15 轮(每棒一个新成语,首字承接上一棒尾字)。当 chain.txt 已经有 15 行成语时,不再 pass_to_next_agent,自然结束。",
        "",
        "你的队友(从其中挑一个 pass 给下一棒):",
        teamRoster,
      ].join("\n");

      console.log(`[V1 smoke] triggering initial task ${initialTask.id}: ${initialTask.title}`);
      console.log(`[V1 smoke] team roster:\n${teamRoster}`);
      missions.executeTask({
        missionId: m.id,
        taskId: initialTask.id,
        message: directiveMessage,
      });

      // === 轮询等 mission idle 或超时,每 30s 打印状态便于诊断 ===
      const deadline = Date.now() + 600_000; // 10 分钟
      let lastLogAt = 0;
      const dumpState = (tag: string): void => {
        const snap = missions.snapshot();
        const mis = snap.missions.find((x) => x.id === m.id);
        const agents = snap.agents.filter((a) => a.missionId === m.id);
        const tasks = snap.tasks.filter((t) => t.missionId === m.id);
        const calls = snap.toolCalls.filter((c) => c.missionId === m.id);
        console.log(
          `[V1 smoke] ${tag} mission.status=${mis?.status} agents=${agents.length} (${agents
            .map((a) => `${a.name || a.role}:${a.status}`)
            .join(",")}) tasks=${tasks.length} (${tasks
            .map((t) => t.status)
            .join(",")}) toolCalls=${calls.length}`,
        );
      };

      dumpState("post-activate");
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
          dumpState("terminal");
          break;
        }
        if (Date.now() - lastLogAt > 30_000) {
          dumpState(`waiting (${Math.round((Date.now() - lastLogAt) / 1000)}s)`);
          lastLogAt = Date.now();
        }
        await new Promise((r) => setTimeout(r, 3000));
      }

      // === 断言 ===
      const snapshot = missions.snapshot();
      const mission = snapshot.missions.find((x) => x.id === m.id);
      if (!mission) throw new Error("mission disappeared at end of run");

      dumpState("final-before-assert");

      // 诊断:打印 chain.txt 内容、所有 toolCalls、所有 tasks
      const finalSnap = missions.snapshot();
      const chainPathDbg = join(workspaceRoot, m.id, "chain.txt");
      if (existsSync(chainPathDbg)) {
        const chainContent = readFileSync(chainPathDbg, "utf8");
        console.log(`[V1 smoke] chain.txt content (${chainContent.length} bytes):\n---\n${chainContent}\n---`);
      } else {
        console.log("[V1 smoke] chain.txt NOT created");
      }
      const allCalls = finalSnap.toolCalls.filter((c) => c.missionId === m.id);
      console.log(`[V1 smoke] toolCalls (${allCalls.length}):`);
      for (const c of allCalls) {
        console.log(`  - ${c.toolName} agentId=${c.agentId} status=${c.status} input=${JSON.stringify(c.input).slice(0, 100)}`);
      }
      const allTasks = finalSnap.tasks.filter((t) => t.missionId === m.id);
      console.log(`[V1 smoke] tasks (${allTasks.length}):`);
      for (const t of allTasks) {
        console.log(`  - ${t.status} assignee=${t.assigneeAgentId ?? "?"} title="${t.title}"`);
      }

      expect(mission.status).not.toBe("cancelled");

      const workerAgents = snapshot.agents.filter(
        (a) =>
          a.missionId === m.id && !(["owner", "hr"] as string[]).includes(a.role),
      );
      expect(workerAgents.length).toBeGreaterThanOrEqual(2);
      expect(workerAgents.length).toBeLessThanOrEqual(10);

      // chain.txt 存在 + 至少 15 个 4 字成语模式
      const chainPath = join(workspaceRoot, m.id, "chain.txt");
      expect(existsSync(chainPath)).toBe(true);
      const chainContent = readFileSync(chainPath, "utf8");
      // 提取所有 4 个连续汉字,作为成语候选(不排重 — 接龙允许重复用字但每轮成语应不同)
      const idiomCandidates =
        chainContent.match(/[一-龥]{4}/g) ?? [];
      // 排除明显是 metadata 的(如"成语接龙"、"接龙员")
      const idiomPattern = idiomCandidates.filter(
        (s) => !["成语接龙", "接龙记录", "接龙员"].includes(s),
      );
      // 唯一成语数 >= 15
      expect(new Set(idiomPattern).size).toBeGreaterThanOrEqual(15);

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
    1_800_000, // 30 分钟,允许 HR + 多轮接龙
  );
});
