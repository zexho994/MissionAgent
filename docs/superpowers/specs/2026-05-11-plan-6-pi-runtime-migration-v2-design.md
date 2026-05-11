# Plan 6 v2: 运行时底座迁移收尾 — pi SDK 嵌入与 LLM 网关统一 — 产品设计

## 概述

v1（2026-05-10 已完成）通过子进程方式把 OpenClaw 换成了 pi。v2 是这次迁移的最后一段：

1. **砍掉子进程边界**——pi 不再以外部命令存在，作为 npm 包嵌入到我们 Node 进程里直接跑。
2. **统一 LLM 调度层**——删掉我们自己写的 1340 行 OpenAI / Anthropic 多供应商封装（`packages/runtime/src/llm/`），改用 pi 自带的 `pi-ai` 网关。后者已经覆盖 25+ 主流厂商 + 任何 OpenAI 兼容服务，且支持订阅登录（用户用 ChatGPT Plus / GitHub Copilot 订阅就能跑，不用绑 API key）。
3. **接 pi 事件流**——artifact 里"source 引用"不再靠"读最终 JSON 输出再找字段"，改成订阅 pi 的工具调用事件实时收集。更准、更稳，不依赖输出格式约定。
4. **任务记忆复用**——同一 Mission 多个任务能复用对话上下文（pi-ai 的 sessionId 机制），省 token。
5. **改名清理**——v1 故意保留的 `openclaw` 残留字符串（代码 15 处 + 本地 store 132 处）一起改成 `pi`。

**v2 范围之外**（推到 v2.1）：让 HR / 审稿人 / 内容策略师这类不写代码的角色去掉默认编码工具、配各自专用工具集。

**v2 不包括**：浏览器自动化（Plan 4 范围）、UI 改动、新增 Mission 模板、token 上限追踪（独立工作）。

## 决策清单

| 项 | 决定 |
|---|---|
| v2 范围 | 砍子进程 + LLM 网关 + 事件流 + 任务记忆 + 改名清理。角色工具集清理推到 v2.1。 |
| 交付顺序 | 分两个 PR。阶段一只换 LLM 网关；阶段二做剩下全部。 |
| 回滚策略 | 不保留 fallback 路径。出问题靠 `git revert`，靠测试覆盖防止上线后才发现。 |
| 改名 | v2 一起做。简化版迁移脚本（项目尚未上线，无真实数据保护需求）。 |
| 上线观察期 | 不设。合并即清理老依赖。 |

**总工期估算**：阶段一 3 天 + 阶段二 5 天 = **8 个工作日**（约 1.5-2 周日历周）。

## 阶段一：LLM 调度层替换

### 范围

只动 `packages/runtime/src/llm/` 这一个目录，以及所有持有 `LlmService` 的调用方。`MissionService.executeTask` 这条"执行任务"链路完全不动（继续走子进程 pi）。

### 改动清单

**删除（移除约 600 行手写多供应商封装）：**

- `packages/runtime/src/llm/anthropic-adapter.ts`（281 行）
- `packages/runtime/src/llm/anthropic-adapter.test.ts`
- `packages/runtime/src/llm/openai-adapter.ts`（316 行）
- `packages/runtime/src/llm/openai-adapter.test.ts`
- `packages/runtime/package.json` 依赖：移除 `@anthropic-ai/sdk`、`openai`

**重写：**

- `packages/runtime/src/llm/llm-factory.ts`（123 行 → 约 80 行薄壳）
  - `createLlmService` / `createLlmServiceFromEnv` 改为内部调用 pi-ai 的 `getModel()` 拿 Model 描述符 + `stream()` / `complete()` 跑请求
  - 环境变量识别保持兼容：`ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `LLM_PROVIDER` / `LLM_MODEL` 等照常工作
  - pi-ai 的`Context` 对象由 `LlmMessage` 数组转换得到，`tools` / `systemPrompt` 一对一映射
- `packages/runtime/src/llm/llm-factory.test.ts` — 调整断言到新的工厂行为

**保留（不动）：**

- `packages/runtime/src/llm/types.ts` — `LlmMessage` / `LlmCallOptions` / `LlmResponse` 接口对外契约不变
- `packages/runtime/src/llm/llm-service.ts` — `LlmService` 接口不变
- `packages/runtime/src/llm/fake-llm-adapter.ts` — 测试用假适配器
- 所有 12+ 处 `this.llm.call(...)` 调用站点（mission-service、artist-evaluation 等）— 接口契约不变所以不动

**新增：**

- `packages/runtime/package.json` 依赖：`@earendil-works/pi-ai@0.74.0`（精确版本，不带 `^`）

### 关键设计点

- **接口边界不变**：`LlmService.call()` 签名保持原样，调用方零改动。pi-ai 的概念（Model / Context / Tool）封装在工厂里。这保证阶段一可以独立合并、独立验证。
- **环境变量兼容**：用户当前 `.env` 里的 `ANTHROPIC_API_KEY` 等不需要改。新增可选 `LLM_OAUTH_PROVIDER` 之类的（如启用 GitHub Copilot 订阅登录）作为后续可选项，v2 不强制。
- **模型 ID 注册**：pi-ai 自带主流模型注册表，但我们项目里的 `claude-opus-4-7` 这种自定义 ID 需要核对是否在 pi-ai 已支持范围。若不在，按 pi-ai 的 Custom Models 模式注册（10-20 行配置）。

### 验证标准

- 单元测试：`llm-factory.test.ts` + 所有用 `LlmService` 的测试（约 50+ 个）全绿
- 集成测试：`speakin-mission.integration.test.ts` 端到端跑通（用 FakeLlm 不烧钱）
- 烟囱测试（手动）：`PI_SMOKE=1 pnpm test:smoke` 跑一次真实 Anthropic 调用，验证 pi-ai 工厂跟我们的 LlmService 接口对接正常
- typecheck 全绿

## 阶段二：SDK 嵌入 + 事件流 + 任务记忆 + 改名

### 范围

砍掉 pi 子进程，改用 `@earendil-works/pi-agent-core` 在主进程内创建 Agent 实例。同时完成事件流改造、任务记忆复用、`openclaw` 改名。

### 改动清单

**删除（移除子进程相关基础设施）：**

- `packages/runtime/src/pi-cli-adapter.ts`（189 行 — 子进程 spawn / parsePiOutputJson 等）
- `packages/runtime/src/pi-cli-adapter.test.ts`
- `packages/runtime/src/pi-cli-adapter.smoke.test.ts`
- `packages/runtime/src/pi-resolver.ts` + 测试（不再需要找 pi 二进制文件）
- `packages/runtime/package.json` 依赖：移除 `@earendil-works/pi-coding-agent`

**新增：**

- `packages/runtime/src/pi-sdk-adapter.ts` — 实现 `MissionExecutionRuntime` 接口，内部用 `new Agent({ initialState, sessionId, ... })` 创建 pi agent 实例
- `packages/runtime/src/pi-sdk-adapter.test.ts` — mock pi 的事件流（不实际跑 LLM），覆盖工具调用序列、超时、异常、终止条件
- `packages/runtime/src/pi-sdk-adapter.smoke.test.ts` — `PI_SMOKE=1` 门控，真实跑一次最小任务
- `packages/runtime/src/pi-hooks.ts` — 集中封装项目用到的 pi-agent-core 扩展点（beforeToolCall / afterToolCall / shouldStopAfterTurn / subscribe）。当前空实现，未来扩展不污染 sdk-adapter。
- `apps/server/src/store-migration.ts` — 启动时一次性扫描 `mission-store.json`，全文替换 `openclaw` → `pi` 写回。完成后自删除迁移痕迹（如设一个 `migrationDone: true` 字段）。
- `packages/runtime/package.json` 依赖：加 `@earendil-works/pi-agent-core@0.74.0`（精确版本）

**改造：**

- `packages/runtime/src/pi-extensions/web-search.ts` — 从"子进程扩展协议"重构为 pi-agent-core 的 `AgentTool` 对象。接口形态变了（`tools: [...]`)，搜索能力本身不变。
- `apps/server/src/runtime-bridge.ts`
  - `extractSourcesFromOpenClawOutput` → `extractSourcesFromPiOutput`
  - 从"消费已 parse JSON"改成"消费 pi 事件流"——agent.subscribe 监听 `tool_execution_end` 事件，从 web_search 工具的结果里实时累加 sources
  - 接口签名变化：函数现在接受一个 `Source[]`（pi-sdk-adapter 内部已经收集好的），不再从 JSON 提取
- `apps/server/src/mission-service.ts`
  - 字符串改名：`toolName: "openclaw.agent"` → `"pi.agent"`、`content: { openclaw, stderr }` → `content: { pi, stderr }`、`evidence: ["openclaw:local"]` → `["pi:local"]`
  - `mission-helpers.ts` 里 `agentInstanceId: "openclaw_runner"` → `"pi_runner"`
  - sessionId 传入：调 `runtime.runAgentTask` 时多传一个 `sessionId: task.missionId`（让同一 Mission 多任务共享 prompt cache）
- `apps/server/src/artifact-evaluation.ts` — 15 处 `openclaw` 字面量改名 + 函数签名调整
- `apps/server/src/api.ts`
  - `/api/health` 返回字段 `openclaw: ...` → `pi: ...`
  - 路由 `/api/openclaw/run` → `/api/pi/run`
- `apps/server/src/api.test.ts` 等所有相关测试 — 跟改名同步
- `apps/server/src/mission-service.ts` 启动钩子 — 调用 `store-migration` 一次

### 关键设计点

- **异常隔离围栏**：pi-sdk-adapter 是 pi 异常进入主进程的唯一通道。这一层用 try/catch 包住所有 `agent.prompt` / `agent.subscribe` 调用，把任何 pi 内部异常转化为 `{ status: 'failed', error }` 而不是让异常向上冒泡撕掉 server。
- **事件流超时熔断**：agent.prompt 调用配置硬超时（`timeoutSeconds + 30s`），超时后强制 abort agent。防止 pi 内部卡死拖死任务调度。
- **sessionId 命名**：用 `task.missionId` 作为 sessionId（不是 `task.id`），让同一 Mission 内的多任务共享上下文。这是 prompt cache 起作用的前提。
- **改名"一次性脚本"**：store-migration 在 server 启动时检查 `mission-store.json`，若发现含 `openclaw` 字符串则做一次全文 `replaceAll`，写回，记录 `migrationDone: true`。下次启动跳过。三个月后这个文件可以删（v2.5 清理 PR）。
- **CI 改名守门**：新增 lint 规则——除了 `store-migration.ts`、CHANGELOG、本设计文档外，全项目代码出现 "openclaw" 字符串就 CI 报红。防止漏改。

### 验证标准

- 单元测试：pi-sdk-adapter / store-migration / 改造后 artifact-evaluation 全部测试绿（约 100+ 新增/调整测试）
- 集成测试：speakin-mission.integration.test.ts 在新基础上端到端跑通
- 烟囱测试（手动）：`PI_SMOKE=1 pnpm test:smoke` 一次真实跑通最小 Mission（创建 → Owner 对话 2 轮 → 任务执行 → 产出），验证事件流 + sessionId + 异常围栏整体协作
- typecheck 全绿
- `grep -r "openclaw" packages apps --include="*.ts"` 输出仅命中允许的少数文件（lint 规则把关）
- `grep -c "openclaw" mission-store.json` 输出 0（迁移完成后）

## 风险评估

| 风险 | 等级 | 应对 |
|---|---|---|
| pi 嵌入主进程后内部异常拖垮 server | 中 | 异常隔离围栏 + 事件流超时熔断 |
| 改名遗漏导致某条产线安静失效 | 低 | CI 加 grep 守门规则 |
| pi 0.74 → 0.75 升级带破坏性变化 | 低-中 | package.json 锁精确版本；升级时人工跑完整测试 + 烟囱测试 |
| pi-agent-core 废弃我们用的 hook | 低 | hooks 集中封装在 `pi-hooks.ts` 一个文件，未来上游改了名只动一处 |
| pi-ai 不支持某家未来需要的私有 LLM 供应商 | 极低 | 95% 主流厂商 + Ollama / 任意 OpenAI 兼容服务已支持。真碰上私有协议时再加一个 provider 文件（约 200 行，模板参照 pi-ai 内置 provider）|
| 阶段一阶段二之间存在"用了 pi-ai 但仍走子进程"的中间状态 | 低 | 阶段一阶段二接口边界都已稳定（`LlmService` / `MissionExecutionRuntime`），中间状态可正常生产工作 |

## 测试策略

**3 层验证，全部跑过才允许合并：**

1. **单元测试**（每 PR 必须全绿）
   - 阶段一：LlmService 接口对 pi-ai 工厂的对接、模型/参数映射、错误处理
   - 阶段二：pi-sdk-adapter 在 mock pi 事件流下的行为（工具调用序列、超时、异常、终止）；store-migration 覆盖几个核心 case（空 store、已含 openclaw、已迁移过、二次启动幂等）

2. **集成测试**（每 PR 必须全绿）
   - 复用现有 speakin-mission.integration.test.ts 端到端测试
   - 用 FakeLlmAdapter + mock pi（不烧 API 费用）
   - 项目现有 500+ 个测试做回归保护

3. **在线烟囱测试**（合并前手动跑一次）
   - 真实 LLM key + 真实 pi SDK，跑最小 Mission
   - 预算 < $0.5/次
   - 阶段一上线前 1 次、阶段二上线前 1 次

## Non-Goals

- 不做 A/B 对比框架或运行时切换开关。回滚依赖 git revert。
- 不做 token 用量/延迟/成本仪表盘。属于独立可观测性项目。
- 不做角色工具集清理（HR / 审稿人 / 内容策略师等去掉默认编码工具）。推到 v2.1。
- 不做 UI 变化、不增 Mission 模板、不动浏览器自动化（Plan 4 范围）。
- 不做长期记忆/Milestone/检查点（独立大项）。
- 不做 pi RPC 长连接池（pi 启动开销若 v2 后续度量发现是问题，单独跟进）。
- 不做"上线前 24 小时观察期"——项目未上线、无真实数据，靠测试覆盖即可。
- 不为历史 artifact 内容做兼容（项目未上线，store-migration 一次性全部重写）。

## 工期与里程碑

| 阶段 | 工作量 | 产出 |
|---|---|---|
| 阶段一 PR | 3 个工作日 | LLM 调度层切到 pi-ai，1340 行 → ~300 行薄壳；所有测试绿；烟囱测试一次过 |
| 阶段二 PR | 5 个工作日 | SDK 嵌入 + 事件流 + 任务记忆 + 改名 + store 迁移；所有测试绿；烟囱测试一次过；项目代码彻底无 `openclaw` 字符串 |
| **总计** | **8 个工作日**（约 1.5-2 周日历周） | Plan 6 v2 完成，ROADMAP Plan 6 状态从 "v1 已完成" 改为 "v2 已完成" |

## 后续

- **v2.1（独立小项目，3-4 天）**：角色工具集清理。pi-agent-core 嵌入后，给 HR / Owner / 审稿人 / 内容策略师 / 图像创作者等非编码角色配各自工具集（不再统一带 bash / 文件编辑）。需要梳理 9 个角色的实际工具清单。

- **v2.5（清理 PR，1 小时）**：三个月后删除 `store-migration.ts` 与 `migrationDone` 字段（迁移已不可能再触发）。
