# V1 文件协作与任务接力设计

**日期**: 2026-05-18
**作者**: 与 Claude 共创
**状态**: 草案 / 待审阅
**对应 Roadmap**: `docs/E2E-ROADMAP.md` → Iteration 1(V1-1 成语接龙 + 文件读写)

---

## 1. 背景

V0 已经把 HR 招募改造为纯 LLM 驱动:HR 能基于任意 mission goal 真分析、招出合理团队。

**但 V0 验收过的 mission 实际是"独 agent 自言自语"**:

- Runtime 已注册的工具只有 `web_search` 和 `list_skill_files` / `load_skill`
- 没有任何工具能让 agent **写文件**、**读文件**,也没有工具能让 agent **把任务交给下一个队友**
- HR 系统提示词里画了一些"agents can coordinate through `agent_send_message` / `agent_read_messages` / `turn_record`"的饼,但 runtime 里**根本没有这些工具的实现**——LLM 写进 `allowedTools` 也没用
- 即使 HR 招出了 5 个玩家,5 个玩家**之间无法交换中间状态**,也**没人能调度下一棒**

这意味着 V1 "成语接龙 + 文件读写" 用例(roadmap V1-1)在当前架构下根本跑不通——没有文件工具、没有接力机制。

## 2. 目标

让 5 个 agent 能真协作完成 V1-1 用例:

1. **agent 能通过共享文件传递中间状态**:每个 agent 接到自己这棒时,能读上一棒写的 `chain.txt`,写完自己的成语再保存回去
2. **agent 能把下一棒交给指定队友**:当前 agent 决定"我做完了,该 X 角色继续"时,平台立即创建并启动 X 的新任务
3. **接力链有安全阀**:不会跑偏(无限递归、超出预算等)
4. **每个 agent 的协作动作可观察**:Agents tab 上能看到"这个 agent 调用了什么工具、给谁递了棒"
5. **工具清单集中维护**:不在 prompt 里硬编码工具名,沉到 skill 文档,以后加工具只改一处

## 3. 非目标

- **不做工具权限卡点(per-agent allowedTools 强制)**:`allowedTools` 当前是"装饰",V1 保持现状,LLM 自觉按角色分工;后续迭代再做真权限化
- **不做并发接龙**:5 个玩家仍是顺序接力,而不是并行+文件锁
- **不做失败恢复**:进程挂了链子就断,V6 才解决
- **不做"主持人"独跑模式**:HR 招 5 个对等玩家(由 LLM 决定谁起头),不引入额外的协调者角色
- **不实现 `file_delete` / `file_list`**:V1 接龙不需要,YAGNI;后续真有需求再加
- **不引入新的 LLM 模型 / 服务**:复用现有 PiSdkAdapter + 现有 LLM 配置

## 4. 改造后的整体流程

```
用户输入 V1-1 goal: "5 个 agent 协作玩成语接龙,每轮把当前接到的成语写入 chain.txt..."
       ↓
Owner brief 确认 → MissionPlan 确认(沿用 V0 流程,不动)
       ↓
HR 招团队:
  - HR 通过 load_skill 加载 digitalagent/SKILL.md +
    capabilities/file-io.md + capabilities/agent-collaboration.md
  - HR 看到真实可用的工具清单(file_read / file_write / pass_to_next_agent)
  - HR 输出 5 个对等的玩家角色,allowedTools 包含上述工具
       ↓
Mission 激活 → 平台启动起手任务,assignee = 玩家1
       ↓
玩家1 执行:
  ├ load_skill 看自己有哪些工具
  ├ file_read("chain.txt") → exists: false(第一棒)
  ├ 想一个成语
  ├ file_write("chain.txt", mode="append")
  └ pass_to_next_agent(nextRole="玩家2", objective="...", reason="...")
        │
        │ 工具内部:
        │   1. createFollowupTask → 立即创建 task,assignee=玩家2
        │   2. executeTask 立即启动玩家2
        │   3. appendMessage("[递棒→玩家2] ...") → UI 可见
        ↓
玩家2 执行(玩家1 的 LLM 完成正常收尾)
  ├ file_read("chain.txt") → 拿到玩家1 写的成语
  ├ ...
  └ pass_to_next_agent(nextRole="玩家3", ...)
       ↓
... 继续接力 ...
       ↓
某玩家执行时 file_read 发现 chain.txt 已有 15 行,LLM 决定不再调 pass_to_next_agent
       ↓
最后一个 task 走正常完成流程 → Mission 进入 idle
```

**整条链没有调度器 tick、没有队列**——全部是同步函数调用栈一路展开(`mission-service.ts:3099-3105` 的 `executeTask` 是 `void` 异步,但接龙天然顺序所以等价于串行)。

## 5. 改动清单

### 5.1 新增:文件读写工具(`@digitalagent/runtime`)

**新文件**: `packages/runtime/src/pi-extensions/file-io.ts`

工具签名:

```typescript
file_write({ path: string, content: string, mode?: "overwrite" | "append" })
  → { bytesWritten: number, path: string }

file_read({ path: string })
  → { content: string, exists: boolean, sizeBytes: number }
```

工厂函数:

```typescript
export function createFileTools(opts: {
  workspaceRoot: string;   // 该 mission 的工作区绝对路径,如 ".../workspaces/<missionId>"
}): AgentTool<any>[]
```

**沙箱约束**(违反时返回 tool error,不抛进程异常):

- 路径必须相对,拒绝 `..` 和绝对路径
- `resolve(workspaceRoot, path)` 结果必须仍在 `workspaceRoot` 内(防 symlink 逃逸)
- 单次写入 ≤ 1 MB,单次读取 ≤ 1 MB
- 单个 mission 工作区最多 100 个文件(超出后 file_write 拒绝)
- 工作区目录懒创建(首次 file_write 时 `mkdir -p`),file_read 文件不存在时返回 `exists: false` 而不是错误

### 5.2 新增:任务接力工具(`@digitalagent/runtime`)

**新文件**: `packages/runtime/src/pi-extensions/agent-handoff.ts`

工具签名:

```typescript
pass_to_next_agent({
  nextRole: string,
  objective: string,
  reason: string,
  inputContext?: Record<string, unknown>,
})
  → { created: true, taskId: string }
  | { created: false, reason: "mission_cap" | "no_assignee" | "mission_paused" | "budget_exceeded" | "per_event_limit" }
```

工厂函数(per-call 注入闭包):

```typescript
export function createPassToNextAgentTool(deps: {
  missionId: string;
  sourceTaskId: string;
  sourceAgentId: string;
  createFollowupTask: (input: ...) => Promise<...>;  // 直接复用 mission-service 上的
  appendMessage: (msg: ...) => void;
}): AgentTool<any>
```

**内部行为**:

1. 调用 `createFollowupTask`,`triggeringEventId = "handoff:<sourceTaskId>:<toolCallId>"`
2. 同步调 `appendMessage` 落一条 `type: "agent_chat"` 消息,内容 `"[递棒→<nextRole>] <reason>"`(让 Agents tab 上能看到通信关系)
3. 返回 `createFollowupTask` 的结果对象给 LLM(LLM 看到 `created: true` 才知道交接成功)

**为什么不复用 autonomy 路径**:autonomy 的 `create_followup_task` 是 LLM 在执行后通过自评机制返回 action 触发,间接、依赖 autonomy 真运行。封装成 tool 让 LLM 在执行中显式调用,**直接、可观察(出现在 toolCalls 流水里)、不依赖 autonomy 行为**。

### 5.3 改:Mission 工作区生命周期

**改 `apps/server/src/server.ts`**:

引入 workspace 根目录(env var 可配,默认 `apps/server/data/workspaces`):

```typescript
const workspaceRoot = process.env.DIGITALAGENT_WORKSPACE_ROOT
  ?? join(root, "..", "data", "workspaces");
```

并把 workspace 根传给 `MissionService`(下面会用)。

**改 `apps/server/src/mission-service.ts`** 两处:

1. `executeTask` 内,调 `runtime.runAgentTask` 之前,per-call 构造文件工具 + 交棒工具:

   ```typescript
   const missionWorkspace = path.join(this.workspaceRoot, mission.id);
   const fileTools = createFileTools({ workspaceRoot: missionWorkspace });
   const handoffTool = createPassToNextAgentTool({
     missionId: mission.id,
     sourceTaskId: input.taskId,
     sourceAgentId: executor.id,
     createFollowupTask: (i) => this.createFollowupTask(i),
     appendMessage: (m) => this.appendMessage(m),
   });

   runtime.runAgentTask({
     ...,
     tools: [...fileTools, handoffTool],   // PiSdkAdapter 会和 adapter 自带工具合并
   });
   ```

2. `deleteMission` 末尾追加 workspace 清理(失败仅记日志,不阻塞主流程):

   ```typescript
   const workspaceDir = path.join(this.workspaceRoot, missionId);
   fs.promises.rm(workspaceDir, { recursive: true, force: true })
     .catch((err) => console.error(`[MissionService] Failed to clean workspace ${workspaceDir}:`, err));
   ```

### 5.4 改:Skill 文档(集中维护工具清单)

**改 `apps/server/config/skills/digitalagent/capabilities/file-io.md`**(已存在,补充):

在原文末尾追加 "## 可用工具" + "## 约束" 两节,列出 `file_read` / `file_write` 的签名、参数说明、上限值。

**改 `apps/server/config/skills/digitalagent/capabilities/agent-collaboration.md`**(已存在,补充):

在原文末尾追加 "## 可用工具" 节,列出 `pass_to_next_agent` 的签名,以及 "## 调用时机" 节说明何时该调、何时该停。

**完整变更详情见 §5.5 提示词改动**。

### 5.5 改:HR / Agent 系统提示词(最小化改动)

**核心原则**:**不在 prompt 里硬编码工具名**,只指引 agent 去 load_skill 查实际工具清单。

**改 `apps/server/src/hr-agent.ts`** 两处:

1. `hr-agent.ts:262` 那条提到 `agent_send_message` 的旧行(已知是画饼),替换为指引 HR 加载 skill:

   ```diff
   - "- Agents can coordinate through agent_send_message, agent_read_messages, and turn_record when the mission needs multi-agent handoff evidence.",
   + "- Before designing the team, you may load digitalagent/SKILL.md and any relevant capability files (file-io, agent-collaboration, web-search) to learn the actual runtime tools available, and assign them in allowedTools accordingly.",
   ```

2. `hr-agent.ts:408` 那条同样替换,改为指引(不列具体工具名):

   ```diff
   - "- For collaborative tasks, include agent_send_message, agent_read_messages, or turn_record in allowedTools when those tools help make handoffs observable.",
   + "- For collaborative or turn-based tasks, ensure the working roles' allowedTools cover the relevant capabilities you discovered via load_skill (typically file IO + agent handoff tools).",
   ```

**改 `apps/server/src/system-config.ts`**:

`RUNTIME_SKILL_TOOL_DIRECTIVE` 当前只说"need DigitalAgent capability context 时用 load_skill",改为更主动:

```diff
- "Load more specific skill files (e.g., digitalagent/capabilities/*.md) only when the mission requires specific capability context.",
+ "When you receive a task, load digitalagent/SKILL.md first to discover available tools and capabilities. Then load specific capability files (e.g., digitalagent/capabilities/file-io.md, digitalagent/capabilities/agent-collaboration.md) relevant to your task before acting.",
```

**改 `apps/server/src/runtime-bridge.ts:buildAgentMessage`**:

如果 `task.origin.type === "followup"`,prompt 里额外提示一句:"This is a follow-up task handed off from a teammate. Read any referenced files (e.g. chain.txt) before producing new output." —— 让 LLM 知道这不是从头开始,该先看上一棒留下了什么。

### 5.6 改:Agents tab 增加"工具操作流水"

**改 `apps/server/public/war-room.js`**:

在 `renderAgentDetailCard`(:609)末尾追加 `renderToolCallTimeline(data, agent)`,从 `data.toolCalls` 过滤出 `agentId === agent.id` 的记录,按 `startedAt` 升序展示最近 10 条。

每条记录显示:状态图标、时间、工具名、输入 JSON(截断到 200 字符)、结果总结。

针对几个常见工具加专属总结函数 `summarizeOutput(toolName, output)`,例如:
- `file_read` → "读取 X 字节" / "(文件不存在)"
- `file_write` → "写入 X 字节"
- `pass_to_next_agent` → "已派任务给 X" 或 "拒绝:<reason>"
- `web_search` → "X 条搜索结果"

**改 `apps/server/public/styles.css`**:加 `.agent-tool-timeline` / `.tool-call-item` / 状态色等样式。

### 5.7 安全阀

**复用现有 `mission.budget.maxFollowupTasks` + `followupSafetyConfig`**(`mission-service.ts:3003-3042` 已实现):

- 创建 mission 时,**确保 budget 里有 `maxFollowupTasks: 30`**(V1 接龙够用,30 棒上限)。在 `createMissionFromBrief` 或 mission template 处默认带上
- 不新增代码——`createFollowupTask` 已经会在超过预算时自动 pause mission 并通知 owner

## 6. 数据模型

**无新增持久化字段**。所有数据均复用现有结构:

- `ToolCallRecord`(`mission-service.ts:347`) 已包含 agentId / toolName / status / input / output / 时间戳,前端展示直接用
- `AgentMessage` 已支持 `agent_chat` 类型,接棒消息走它
- `Task` 已支持 `origin: { type: "followup", reason, sourceTaskId }`,接力出的任务标记天然存在

**新增文件系统状态**:

- `apps/server/data/workspaces/<missionId>/` 目录树(env var 可改根)
- Mission 删除时跟着删

## 7. 错误处理

| 场景 | 行为 |
|---|---|
| file_write 写入 > 1 MB | tool 返回 error,LLM 看到后自行决定怎么办 |
| file_read 读取不存在的文件 | 返回 `{ exists: false, content: "" }`,不抛错(接龙第一棒就是这种情况) |
| 路径含 `..` 或绝对路径 | tool 返回 error |
| 文件数超 100 | file_write 返回 error |
| pass_to_next_agent 的 nextRole 团队里没人 | 返回 `{ created: false, reason: "no_assignee" }` + 给 owner 发系统通知(`mission-service.ts:3056` 现有逻辑) |
| pass_to_next_agent 超 maxFollowupTasks | 返回 `{ created: false, reason: "budget_exceeded" }`,mission 自动 pause |
| Mission 删除时 workspace `fs.rm` 失败 | 仅 console.error,不阻塞 mission 删除 |

## 8. 测试策略

分三层,**新基建为零,跟现有风格对齐**。

### 8.1 单元测试(纯逻辑,默认跑)

| 新增/修改测试文件 | 验证内容 |
|---|---|
| `packages/runtime/src/pi-extensions/file-io.test.ts`(新增) | 路径沙箱、大小上限、append 模式、文件不存在的返回值、文件数上限、symlink 逃逸防御 |
| `packages/runtime/src/pi-extensions/agent-handoff.test.ts`(新增) | `pass_to_next_agent` 调用 `createFollowupTask` 参数映射、`appendMessage` 同步触发、`triggeringEventId` 携带 sourceTaskId |
| `apps/server/src/mission-service.test.ts`(修改) | `deleteMission` 删 workspace、清理失败不阻塞、`executeTask` 给 runtime 注入了 fileTools 和 handoffTool |

### 8.2 Smoke 测试(真 LLM,门控)

**新文件**: `apps/server/src/v1-collaboration.smoke.test.ts`

`it.runIf(process.env.PI_SMOKE === "1")` 模式,与现有 `PI_SMOKE` 测试对齐。流程:

1. Bootstrap 真 PiSdkAdapter + 真 LLM service
2. 自动创建 mission(V1-1 原文 goal)、确认 brief、确认 plan、激活
3. 轮询等 mission 进入 idle(超时 600s)
4. 断言:
   - mission 状态非 failed
   - 非 owner/hr agent 数量 ≥ 2(允许 LLM 招 2-10 个玩家)
   - 工作区 `chain.txt` 存在
   - chain.txt 行数 ≥ 15,每行长度 2-8 字符(成语典型范围)
   - 至少 1 次 file_write、1 次 file_read、10 次 pass_to_next_agent 的 toolCall
   - 每个玩家 agent 至少有 1 条 toolCall(没有摸鱼的)

不强校验"成语是否合法 / 是否首尾相接"——交给人工抽查。

### 8.3 手工验收(最终判定)

**新文件**: `docs/E2E-V1-ACCEPTANCE.md`

写一份手工步骤清单(roadmap 风格),覆盖 V0-1 + V1-1 全部自动化 + 人工验收点,放在固定路径供后续迭代回归使用。

## 9. 实施顺序建议

1. **新增文件工具**(`file-io.ts` + 单测)→ runtime 层先就绪,可独立验证
2. **新增接力工具**(`agent-handoff.ts` + 单测)→ 同上,独立验证
3. **改 mission-service**(per-call 注入工具 + workspace 清理 + budget 默认值)→ 这一步开始真接通
4. **更新 skill 文档** → HR 和 Agent 提示词同步改(skill 改完才能改 prompt)
5. **改 UI**(Agents tab 流水)→ 此时已可手工跑一次接龙观察效果
6. **写 smoke 测试 + 手工验收文档**
7. **跑一次完整 smoke 验证** → 通过即 V1 收敛

## 10. 风险与缓解

| 风险 | 缓解 |
|---|---|
| LLM 不调 `load_skill` 就乱用工具名 | Skill 文档列出**真实工具签名**,prompt 指引 "load first";若 LLM 仍乱调,tool not found 返回错误,LLM 自我纠正 |
| LLM 在 chain.txt 满 15 行后还继续 `pass_to_next_agent` | 安全阀 `maxFollowupTasks: 30` 兜底;超出后自动 pause,人工判定为失败信号 |
| 5 个玩家中某个 agent 一直摸鱼(其他 agent 总是不递棒给它) | smoke 测试断言"每个 worker agent 至少 1 条 toolCall",发现摸鱼立即 fail |
| Workspace 文件被多个 task 并发写(单进程串行下不太可能,但理论存在) | V1 不加文件锁(YAGNI);若实测出现,先在 file_write 加一层进程内 mutex |
| 工作区磁盘占用失控 | 单文件 1 MB + 单 mission 100 个文件 = 单 mission 上限 100 MB;mission 删除时跟着清 |
| 接力 chain 太深栈溢出 | `executeTask` 是 `void` async,新栈帧重新开始,不会无限增长;深度由 `maxFollowupTasks` 限制 |

## 11. 验收门槛(Definition of Done)

- [ ] V0-1 用例完整回归通过
- [ ] V1-1 自动化验收点全部通过(§8.2 smoke 测试 + §8.3 手工脚本)
- [ ] V1-1 人工验收点(成语合法、首尾相接、HR 角色合理)抽查通过
- [ ] 没有任何 prompt 文件里硬编码 `file_read` / `file_write` / `pass_to_next_agent` 的工具名(都沉到 skill 文档)
- [ ] `apps/server/data/workspaces/` 目录在 mission 删除后无残留
- [ ] Agents tab 上每个玩家卡片都能看到工具操作流水
