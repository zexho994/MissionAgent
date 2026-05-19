# E2E V1 验收手工脚本

**对应**: `docs/E2E-ROADMAP.md` 的 V1-1 用例
**目的**: V1 收敛时跑这份清单全过 = 验收通过

---

## 0. 前置

- [ ] 干净 worktree,所有改动已 commit
- [ ] `pnpm install && pnpm build` 通过
- [ ] LLM api key 已配(`.env` 里 `LLM_API_KEY=` 或 `MINIMAX_API_KEY=`)

## 1. 自动化(可门控,跑得快)

- [ ] `pnpm test` —— 全部单元测试通过(含 file-io、agent-handoff、mission-service workspace 等)
- [ ] `pnpm --filter @digitalagent/server typecheck` —— 通过
- [ ] `PI_SMOKE=1 LLM_API_KEY=xxx pnpm --filter @digitalagent/server vitest run src/v1-collaboration.smoke.test.ts` —— 通过(约 5-10 分钟)

## 2. 浏览器手工跑

- [ ] `pnpm dev`,打开 `http://127.0.0.1:3000`
- [ ] 在主输入框粘贴 V1-1 goal 原文:
      > "5 个 agent 协作玩成语接龙,每轮把当前接到的成语写入 chain.txt 文件,下一个 agent 必须先读 chain.txt 拿到上一个成语,再接龙写回。完成 15 次才算成功。"
- [ ] 走完 Owner brief 确认
- [ ] 走完 MissionPlan 确认
- [ ] 激活 mission

### 期望观察(自动可验)

- [ ] HR Agent 进入 running → idle,没 failed
- [ ] 团队规模:**2-10 个**非 owner/hr agent
- [ ] Agents tab:每个玩家卡片下能看到"工具操作流水"块,有 file_read / file_write / pass_to_next_agent 的调用
- [ ] 找到 `apps/server/data/workspaces/<missionId>/chain.txt`,**存在**
- [ ] `cat chain.txt | wc -l` >= 15
- [ ] 每行 2-8 字符
- [ ] V0-1 兜底:不出现 "Mission Operator Agent" 这种泛角色

### 人工抽查(创意判断,不自动)

- [ ] 角色名跟"接龙 / 玩家 / 词汇"主题相关(不是 Generic Worker)
- [ ] chain.txt 至少 80% 是合法成语
- [ ] 抽样 5 个相邻条目,确认有"前一个尾字 ≈ 后一个首字"的接龙关系(允许同音变通)
- [ ] HR 招的角色不是所有人都用 file 工具——典型场景应该 1-2 个负责"记账",其他负责"出招"(看 allowedTools)

## 3. 删除验证

- [ ] 在 UI 上删掉刚跑的 mission
- [ ] `ls apps/server/data/workspaces/<missionId>` —— 应该 `No such file or directory`

## 4. V0 回归

- [ ] 重新跑一次 V0-1 用例(roadmap 原文 goal),确认没把老功能搞坏

---

任何一项 ❌ → 不算 V1 收敛,先看 roadmap "失败时的处理流程"修。
