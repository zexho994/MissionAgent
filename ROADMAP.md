# DigitalAgent Roadmap

## Vision

一个AI驱动的目标达成系统。用户提供目标（如"小红书1个月涨粉1000"），AI负责从战略对齐、团队组建、任务执行到持续优化的全流程。系统像真正的团队一样紧密协作——分析师定期看数据、项目经理协调调整、内容策划响应变化。

## Current State

- 核心领域模型（Mission/Task/Artifact/Review/Agent）已建立
- Owner Agent 和 HR Agent 作为预设角色存在
- 关键词匹配驱动的团队组建
- 线性任务编排（plan → execute → review → done）
- 结构化事件消息，无Agent间对话

---

## Phase 1: AI-Powered Owner — 智能目标澄清

**目标**: Owner Agent 能像真正的项目经理一样，通过多轮对话理解用户目标，主动追问缺失信息，直到达成战略共识。

### 1.1 LLM集成基础
- [x] 设计通用的LLM调用接口（支持多provider：OpenAI、Claude、GLM）
- [x] 实现LLM调用服务，包含重试、超时、token统计
- [x] 在MissionService中注入LLM服务依赖

### 1.2 Owner多轮对话
- [x] 设计对话上下文管理（累积用户补充的信息）
- [x] Owner根据目标内容主动生成追问（而非模板填充）
- [x] Owner判断信息是否足够进入下一阶段（战略共识判断）
- [x] 用户确认环节：Owner输出战略摘要，等待用户确认

### 1.3 战略对齐输出
- [x] 定义 `MissionBrief` 结构体（目标、范围、约束、成功指标、关键假设）
- [x] Owner将多轮对话结果汇总为结构化MissionBrief
- [x] MissionBrief作为后续HR招募的输入

**验收标准**: 用户输入"运营一个小红书账号，一个月涨到1000粉丝"，Owner能追问账号现状、内容方向、目标人群等，最终生成结构化的MissionBrief。

---

## Phase 2: AI-Powered HR — 智能团队组建

**目标**: HR Agent能根据MissionBrief分析岗位需求，动态生成RoleSpec，与Owner谈判直到达成共识，然后创建团队成员。

### 2.1 HR岗位需求分析
- [x] HR接收MissionBrief，分析需要哪些角色（`activateMissionWithHR()` 已实现，但尚未设为默认路径）
- [x] HR生成每个角色的RoleSpec（职责、能力要求、工具权限、预算）（`generateRoleSpecs()` 已实现）
- [x] 替换当前的关键词匹配逻辑（`planMissionTeam` → LLM驱动）（`activateMissionWithHR()` 已设为默认路径，走谈判流程）

### 2.2 HR与Owner谈判循环
- [x] 设计Agent间多轮对话协议（request → respond → negotiate → agree）（`NegotiationRound` 支持多轮）
- [x] HR向Owner提出团队方案，Owner审核并提出修改意见（`proposeTeamPlan()` / `respondToNegotiation()`）
- [x] 谈判循环：双方可以多轮协商直到达成一致
- [x] 谈判失败时的升级机制（请求用户介入）（`NegotiationManager` maxRounds + 自动升级）

### 2.3 动态Agent创建
- [x] 根据协商结果动态创建WarRoomAgent（`agent-factory.ts` 的 `createAgentFromSpec()`）
- [x] 为每个Agent生成个性化的system prompt（`buildSystemPrompt()`）
- [x] 建立Agent间的协作关系（AgentRelation）
- [x] HR向每个Agent"交代"岗位职责和任务上下文（onboarding 流程）

**验收标准**: 用户确认MissionBrief后，HR能分析出需要数据分析师、内容策划、文案写手等角色，并与Owner就团队构成达成一致，然后自动创建团队。

---

## Phase 3: Agent-to-Agent Collaboration — Agent间协作

**目标**: Agent之间能像真正团队成员一样主动沟通、汇报、讨论，而非仅通过结构化事件传递信息。

### 3.1 对话式通信
- [x] 扩展AgentMessage支持自由文本对话（不只是结构化事件类型）
- [x] 设计对话上下文：Agent能理解之前的对话历史
- [x] Agent可以主动发起对话（不限于API触发）（`AgentAutonomyService` 周期性自评 + LLM决策）

### 3.2 团队协作机制
- [x] 汇报机制：下级Agent定期向上级汇报进展（`findSuperiors()` + `periodic_report` 事件 + `report_to_superior` action）
- [x] 请求机制：Agent可以向其他Agent请求信息或协助
- [x] 通知机制：异常情况主动通知相关负责人
- [x] 讨论机制：多个Agent围绕一个议题展开讨论

### 3.3 共享上下文
- [x] 设计团队级别的共享知识库（Mission级记忆）（`KnowledgeEntry` + CRUD + 持久化）
- [x] Agent能读取其他Agent的工作产出（Artifact共享）
- [ ] 上下文窗口管理策略（长期任务中保持关键信息不丢失）（推迟到 Phase 6）

**验收标准**: 数据分析师能主动告诉项目经理"昨天互动率下降30%"，项目经理能与内容策划讨论调整方案，整个过程无需用户介入。

---

## Phase 4: Scheduler & Periodic Execution — 调度与周期执行

**目标**: 支持长期Mission中的定时任务、周期性检查、和条件触发的执行。

### 4.1 任务调度器
- [x] 设计调度器接口（cron表达式 + 任务模板）（`MissionScheduler` + `SchedulerDeps`）
- [x] 实现调度器服务，支持注册/取消/修改调度（`MissionScheduler.start/stop/addRule/removeRule/updateRule`）
- [x] 调度触发时自动创建Task并分配给对应Agent（执行入口已通过 `MissionService.executeTask` + `executeScheduledTask` 回调接通）
- [x] 调度持久化（系统重启后恢复调度）（`InMemoryMissionService.restoreSchedulers`）

### 4.2 周期性任务模板
- [ ] **AI 量身定制周期任务**（opt-in 能力，默认关闭）：HR 在 `scheduleStrategy: "auto" | "llm"` 时调用 LLM 按 mission brief 生成定制化 schedulePlan，失败抛 `SchedulePlanGenerationError`；当前生产默认走"模板套用"，AI 路径作为隐藏开关保留
- [x] AI 模式端到端测试（hr-agent.test.ts `AC1`：LLM 返空时正确抛 `SchedulePlanGenerationError`）
- [x] 定义 `ScheduledTaskTemplate`（触发规则、执行模板、分配角色）（`packages/core/src/types.ts` + `schedule-templates.ts`）
- [x] 支持常见模式：每日检查、每周汇报、每两周回顾（`BUILTIN_SCHEDULE_TEMPLATES` 4 个内置：daily_metric_check / weekly_team_report / biweekly_strategy_retrospective / engagement_drop_alert）
- [x] Mission 创建时自动注册相关调度模板（`confirmNegotiation` 后自动启动 `MissionScheduler`，`createScheduleRulesFromProposal` 支持 `templateId` 展开）
- [x] Mission 完成/取消时清理调度（`completeMission` / `cancelMission` 停 scheduler + 停 autonomy loop + 终止态守卫禁止再 `addScheduleRule`）

### 4.3 条件触发器
- [ ] 设计条件触发规则（如"互动率下降超过20%"）
- [ ] 触发器绑定到特定Agent（如数据分析师检测到异常 → 通知项目经理）
- [ ] 触发器与外部数据源集成（预留接口）

**验收标准**: 系统能自动在每天早上触发数据分析师检查数据，每周一触发项目经理和内容策划开"选题会"，无需人工操作。

---

## Phase 4.5: War Room 体验重构（与 Phase 5 可并行）

**目标**: 让 War Room 真实呈现团队协作状态，让用户一眼看清"谁在做什么、刚才发生了什么、下一步是什么"，而不是被一堆 role_xxx hash 和大段产出文本淹没。

### 4.5.1 信息架构修复
- [ ] **[P1]** 角色卡用 `spec.name`（人类可读名称）替代 `role_xxx` UUID
- [ ] **[P1]** agent 状态分层视图（活跃 / 等待 / 已完成 三档分组或排序）
- [ ] **[P1]** 协作关系连线渲染独立层，不被卡片挤压截断

### 4.5.2 产出阅读
- [ ] 产出文本默认折叠 + 自动摘要标题 + 点击展开
- [ ] 产出与下游任务的引用关系可视化
- [ ] 关键事件（首任务完成、调度触发、review 决策）时间线视图

### 4.5.3 实时反馈
- [ ] agent 状态切换的过渡动画（避免突变看不出变化）
- [ ] 当前 mission 的 token / 预算消耗实时显示

**验收标准**：用户打开 War Room，5 秒内能回答"现在谁在做什么、刚才发生了什么、下一步等什么"。

---

## Phase 5: Feedback Loops & Adaptation — 反馈闭环与自适应

**目标**: 执行结果能驱动策略调整，形成"执行→监控→分析→调整→再执行"的闭环。

### 5.0 反馈基础设施
- [x] 反馈领域类型定义（`MissionOutcomeEvaluation`, `TaskFailureAnalysis`, `StrategyAdjustment`）
- [x] 确定性反馈生成（执行结果/执行失败 → 反馈记录）
- [x] 反馈持久化（随 Mission 状态恢复）
- [x] 反馈 API（summary、evaluations、failure-analyses、strategy-adjustments）
- [x] War Room 反馈面板展示

### 5.1 执行结果反馈
- [x] 任务完成后自动触发评估（`submitExecutionResult()` → `buildExecutionResultFeedback()`）
- [x] 评估结果通知相关Agent（`review_completed` / `review_revision_needed` 事件已 dispatch 到 `AgentConversationBus`）
- [x] 反馈记录持久化与查询
- [ ] 失败任务的自动重规划（不是简单重试，而是调整策略）

### 5.2 策略自适应
- [ ] **[P0]** `AgentAutonomyService` action 类型新增 `create_followup_task` / `spawn_task`（当前只有 acknowledge / report_to_superior / request_info / notify_owner / escalate，没有派活能力）
- [ ] **[P0]** Owner / 项目经理 persona 在收到 `review_completed` / `execution_completed` 事件后，能基于产出 + 成功指标决定派下一波任务，而不是只回一句 acknowledge
- [ ] **[P0]** 自动派活的循环安全限制（每个 review 最多触发 N 个 followup、mission 总任务数上限、防止 LLM 失控自我繁殖）
- [ ] Owner/项目经理根据执行数据判断是否需要调整Mission策略
- [ ] 策略调整时重新触发HR评估（是否需要新角色、调整现有角色职责）
- [ ] 调整历史记录（追踪为什么做这个调整）

### 5.3 外部系统集成
- [ ] 设计外部数据源适配器接口
- [ ] 实现社媒数据采集适配器（小红书、知乎等）
- [ ] 数据自动摄入 → 分析师Agent处理 → 结果流入反馈循环
- [ ] 支持Agent调用外部API（发布内容、查看数据等）

**验收标准**: 内容发布后，系统自动采集互动数据，分析师发现问题后项目经理调整内容策略，内容策划根据新策略修改后续选题，整个过程形成闭环。

---

## Phase 6: Long-Running Mission Lifecycle — 长期任务生命周期

**目标**: 支持天/周/月级别的长期Mission，包含持久化、恢复、检查点等机制。

### 6.1 长期Mission管理
- [ ] Mission状态扩展：加入 `milestone` 概念
- [ ] 定期检查点：自动保存Mission进展快照
- [ ] Mission暂停/恢复机制
- [ ] Mission时间线可视化

### 6.2 Agent长期记忆
- [ ] Agent记忆持久化（跨session保持）
- [ ] 记忆摘要机制（避免上下文窗口溢出）
- [ ] 重要事件归档（关键决策、转折点、教训）

### 6.3 资源与成本管理
- [ ] 长期Mission的预算跟踪和预警
- [ ] Agent级别的资源消耗统计
- [ ] 超预算时的自动降级策略

---

## Phase 7: Native Lightweight Runtime — 原生轻量执行引擎

**目标**: 用基于 `LlmService` 的原生 runtime 替代 OpenClaw CLI 子进程，消除冷启动开销，掌控工具链与产出格式。当前每个任务都要起一次 OpenClaw 子进程，启动延迟和不可预测性是性能瓶颈。

### 7.1 工具注册与执行
- [ ] **[P2]** 设计 `ToolRegistry`（web_search / file_read / file_write / shell / image_gen 等原子工具）
- [ ] **[P2]** LLM 驱动的 agent loop（思考 → 工具调用 → 观察 → 继续）实现
- [ ] **[P2]** 沙盒与权限边界（mission 级隔离，防止互相影响）

### 7.2 与 OpenClaw 共存与切换
- [ ] 在 `MissionExecutionRuntime` 接口下并行支持两套 backend（native / openclaw）
- [ ] 性能对比基线（启动时间、token 成本、产出质量、稳定性）
- [ ] 默认切换到 native，OpenClaw 仅作为回退（feature flag 控制）

**验收标准**: 相同 mission 在 native runtime 下首任务启动延迟 < 500ms（OpenClaw 当前 5-10s 量级），产出质量持平或更优，token 成本可解释。

---

**项目最终验收标准**: 一个为期1个月的小红书运营Mission能从始至终持续运行，中途可以暂停恢复，有检查点，最终有完整的执行报告。
