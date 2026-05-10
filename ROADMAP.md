# DigitalAgent Roadmap

## Vision

DigitalAgent 是一个 **Mission Harness**——让用户为长期目标创建作战室（Mission），AI 团队在作战室内自动循环工作（**观察 → 分析 → 优化**），无需用户全程介入。

平台抽象 4 块通用能力（**看 / 做 / 想 / 不失控**），让任意"长循环"型 Mission 都能在同一套底层上跑：内容运营、股票投资、网站迭代、邮件营销、社群运营……都共享同一个引擎，差别只在"配置"。

## Mental Model

> 一个 Mission = 一个作战室。用户描述目标 → Owner 多轮对话明确战略 → HR 组建团队 → 团队进入作战室 → **平台保证作战室能接到真实世界并自我调整**。

平台不是"做某种业务的 AI"，平台是**"让任意长循环业务都能自动跑的容器"**。

---

## 当前状态（2026 Q2）

### ✅ 真正在跑的能力（用户实测通过）

| 能力 | 说明 |
|---|---|
| **Owner 多轮对话** | LLM 驱动，能追问、能输出 MissionBrief |
| **HR 智能组团** | LLM 分析需求、生成 RoleSpec、与 Owner 谈判 |
| **MissionPlan 生成** | 阶段、工作流、汇报线、调度节奏一次产出 |
| **War Room 可视化** | 协作图、任务列表、产出列表、定时任务、协作对话、反馈面板 UI 全在 |
| **Mission 持久化** | JSON store，重启自动恢复调度 |
| **Mission 完成/取消** | 终止态守卫、scheduler & autonomy 自动停 |

### ⚠️ 代码完成但端到端循环没串通（实测发现的关键缺口）

> **2026-05-09 用户实测**：创建 Mission → Owner 对话 → HR 组团 → 团队完成第 1 个任务 → 向 Owner 汇报 → **Owner 只回"了解"，Mission 停滞**。

下面这些虽然代码层面已经实现，但**端到端循环不通**：

| 能力 | 代码状态 | 实测发现 |
|---|---|---|
| **Agent 间通信** | ✅ 消息能传 | 但 Owner 收到只能 acknowledge |
| **Agent 自评循环** | ✅ 周期性触发 | 但所有 action 都是 acknowledge / report，**不能派活** |
| **任务调度器** | ✅ cron 能触发、能创建任务 | 但内置模板全是"自检/汇报"型，**不推进 Mission 实质工作** |
| **反馈基础设施** | ✅ 评估/失败分析自动生成 | 但生成完之后没人基于反馈做后续动作 |

**根因**：整个项目里"创建 task" 只发生在 2 个地方（Mission 启动初始化、Scheduler 定时触发），**没有任何代码路径会基于反馈派出新任务**。Owner / PM persona 的可用动作清单里没有 `create_followup_task`——LLM 无牌可打，只能选 acknowledge。

详细诊断：[2026-05-09 task-spawn gap diagnosis](docs/superpowers/plans/2026-05-09-task-spawn-machine-v1.md#诊断背景为什么这个-plan-存在)

### ❌ 真正缺的——4 块平台核心能力都不完整

| 能力 | 缺什么 | 后果 |
|---|---|---|
| **想**（反馈驱动决策） | **没有"派活"机制** | **Mission 在第 1 个任务后停滞** ← 这是当前最致命的问题 |
| **看**（外部数据接入） | 完全没有，runtime 只有 OpenClaw CLI | AI 团队"开假会"，看不到真实世界数据 |
| **做**（外部产出发布） | 完全没有，artifact 只在数据库里 | AI 写完没法挂到墙上，用户必须手动发 |
| **不失控**（熔断监控） | 只有基础预算计数 | 用户不敢真"按一次启动就不管" |

**结论**：平台 80% 的"对话/协作"骨架已经搭好，但**"想→看→做→不失控" 4 块能力依次缺失，其中"想"（派活）是当前阻塞所有循环的瓶颈**。

---

## Phase A: 平台核心能力补齐（5 个 Plan 按依赖顺序，约 3-4 周）

**目标**：把"看 / 做 / 想 / 不失控"4 块能力做出第一版，让任何"长循环"Mission 都能跑。

**执行原则遵循依赖关系**：
- 「**想**」是地基——没有派活机器，连基础接龙都接不起来
- 「**看 / 做**」是真实世界连接——在地基上加，让 AI 看到真实数据 / 输出到真实渠道
- 「**不失控**」是包装层——在已经能跑的循环外加保护

### A.3 让 Mission 能"想"——反馈驱动决策【最先做】

**是什么**：AI 项目经理收到执行结果或汇报后，**基于数据 LLM 决策派下一波任务**。

**A→C 演进路线**（4 个 v）：

| 版本 | 谁能派活 | 完成后能看到 | 包含在哪个 Plan |
|---|---|---|---|
| **v1**（MVP） | 仅 Owner | Mission 不再停滞、task 1 → 2 → 3 接龙 | **Plan 1** ✅ 已完成（2026-05-10） |
| v2 | Owner + Agent 提"建议"由 Owner 批 | Agent 体现专业判断，Owner 保有否决 | 暂未规划 |
| v3 | Agent 可派"角色内任务"，Owner 派"跨角色" | 各角色有自己节奏，Owner 解放 | 暂未规划 |
| v4 | 全员自治 + Owner 只管战略 | 真正"AI 团队"形态 | 暂未规划 |

**v1 已完成（2026-05-10）**：
- 新增 Agent action 类型 `create_followup_task`（types + parser + LLM prompt）
- Owner persona 的 `availableActions` 加入此 action（仅 Owner，非 Owner 角色继续 v2 再开放）
- 安全护栏：每 event 最多 1 个 followup、Mission 总任务数软上限触发 escalate
- Bus 与 Autonomy 都接入 dispatch 路径
- E2E 测试覆盖：初始 task 完成 → Owner 派 task #2 → task #2 自动执行
- 343 个测试全部通过，typecheck 通过

**这是原 ROADMAP Phase 5.2 标了 P0 但完全没动的那块——A.3 v1 就是它的最小实施。**

**验收**：speakin.cc Mission 启动后，第 1 个任务完成 → Owner 派出第 2 个具体任务（不是"自检"），且第 2 个任务自动执行、再触发第 3 个任务。
✅ 集成测试已验证此循环（`autonomous-flow.test.ts > Mission task spawning loop`）。手动 UI 验收待实际启动 speakin Mission 时进行（属于 Phase B Week 1）。

### A.1 让 Mission 能"看"——外部数据接入框架

**是什么**：用户在 Mission 配置里声明"要观察哪些数据源"，系统定期拉回来给 AI 团队查。

**包含**：
- **数据源适配器接口**（统一抽象） ✅ Plan 2 已完成
- **HTTP 接口适配器**（用户开放接口、Google Search Console 这种 API）→ **Plan 2** ✅ 已完成
- **浏览器自动化适配器**（无开放接口的平台，复用同一引擎）→ **Plan 4**（待写）
- **数据落到 Mission 知识库**（KnowledgeEntry 已建好，复用） ✅ Plan 2 已完成（fetch 成功后自动写入 `dataSource:{name}:{timestamp}` key）
- **失败重试 + 数据保鲜度标记** ⚠️ v1 单次 attempt + owner notify；多次重试与 cadence 调度推迟到 Plan 3

**v1 完成（2026-05-10）**：
- `MissionDataSource` 域类型 + 工厂
- `DataSourceAdapter` 接口 + `HttpDataSourceAdapter` 实现（依赖注入 fetch 便于测试）
- `MissionService.addDataSource / removeDataSource / listDataSources / triggerDataSourceFetch` 方法
- 拉取成功 → KnowledgeEntry；失败 → owner agent_notify
- REST endpoints: `POST/GET /api/missions/:id/data-sources`，`DELETE /:sourceId`，`POST /:sourceId/fetch`
- fetchHistory 上限 50 条
- 374 个测试全部通过，typecheck 通过

**验收**：speakin.cc Mission 跑起来后，AI 团队能在协作对话里引用真实的 GSC / 知乎 / 掘金 数据。
✅ HTTP 部分已具备（GSC 等开放 API）；知乎/掘金 需要 Plan 4 浏览器适配器。

### A.2 让 Mission 能"做"——外部产出发布框架

**是什么**：用户在 Mission 配置里声明"产出物发到哪些目标"，AI 写完自动发出去。

**包含**：
- **发布目标适配器接口**（与 A.1 同结构，对偶设计） ✅ Plan 2 已完成
- **HTTP 接口适配器**（用户自家发文接口、邮件平台等）→ **Plan 2** ✅ 已完成
- **浏览器自动化适配器**（复用 A.1 的引擎，给"发"用）→ **Plan 4**（待写）
- **发布失败重试 + 限流处理 + 人工 fallback** ⚠️ v1 单次 attempt + owner notify；多次重试与限流推迟到 Plan 3
- **发布状态追踪**（已发 / 待发 / 失败 / 待人工） ✅ Plan 2 已完成（每个 target 有 `attempts` 数组，含 status、attemptedAt）

**v1 完成（2026-05-10）**：
- `MissionPublishTarget` 域类型 + 工厂
- `PublishTargetAdapter` 接口 + `HttpPublishTargetAdapter` 实现
- `MissionService.addPublishTarget / removePublishTarget / listPublishTargets / triggerPublish` 方法
- **自动发布钩子**：artifact 审核通过后，按 `contentTypes` 匹配自动 publish（不阻塞 approval flow）
- 发布失败 → owner agent_notify
- REST endpoints: `POST/GET /api/missions/:id/publish-targets`，`DELETE /:targetId`，`POST /:targetId/publish`
- attempts 上限 50 条

**验收**：speakin.cc Mission 的累计产出物全部挂到 3 个真实渠道。
✅ HTTP 渠道（speakin 自家接口、邮件平台等）已具备；知乎/掘金 需要 Plan 4。

### A.4 让 Mission 不会失控——熔断和监控框架【**Plan 3**】

**是什么**：Mission 级安全机制，让用户敢真的"按一次启动就不管"。

**包含**：
- **任务上限护栏**（每次反馈最多派 N 个任务、Mission 总产出/总 token 上限、超限自动暂停叫人）
- **Mission 级熔断按钮**（用户随时一键叫停 Mission，scheduler + autonomy + runtime 全停）
- **异常事件主动通知**（账号被限/封、外部接口失败、超预算、循环异常等触发 push 给用户）
- **分层托管开关**（Mission 配置里能选"哪些动作 AI 自己做 / 哪些 AI 建议你拍板 / 哪些 AI 必须叫你"）

**验收**：speakin.cc Mission 跑通中至少触发 1 次"AI 主动叫人"且用户能在 War Room 直接看到原因 + 一键继续/中止。

---

## 5 个 Plan 的执行顺序与依赖

| # | 名称 | 包含的能力 | 依赖 | 状态 | 工作量 |
|---|---|---|---|---|---|
| **1** | **派活机器 v1**（Owner 派活） | A.3 v1 | 无 | ✅ 已完成（2026-05-10） | 3-4 天 |
| **2** | HTTP 接入与发布基础 | A.1 + A.2（HTTP 部分） | Plan 1 | ✅ 已完成（2026-05-10） | 3-4 天 |
| **3** | 安全和监控 | A.4 完整 + 多次重试 + cadence 调度 | Plan 1 + Plan 2 | 待写 | 3-4 天 |
| **4** | 浏览器自动化引擎 + 知乎/掘金适配 | A.1 + A.2（浏览器部分） | Plan 1 + Plan 2 | 待写 | 5-6 天 |
| **5** | speakin.cc Mission 第 1 跑 | Phase B 配置 + 4 周观察 | Plan 1+2 起步即可，3/4 完成会增强 | 待写 | 4 周观察 |

**节奏建议**：写 1 个 → 执行 1 个 → 用执行中学到的修正下一个 → 写下一个。**不要一次性写 5 个 plan**——执行中会暴露 ROADMAP 没考虑到的细节，后面 plan 都得改。

**总时间预估**：
- 平台层 Plan 1-4 ≈ 3-4 周（连续）
- Plan 5 Mission 观察 = 4 周（与 Plan 2/3/4 后期重叠）
- **整体 ≈ 6-7 周**（不是原本想的 4 周）

---

## Phase B: 首个真实 Mission 验证（与 Phase A 后期重叠，4 周观察）

**目标**：用 **speakin.cc 内容运营 Mission** 作为 Phase A 4 块能力的首验收场景。**这不是平台功能，是验收用例**。

**与 Phase A 的关系**：
- **Plan 1 完成**是 Mission 能启动的最小条件（基础接龙）
- Plan 2/3/4 完成会**逐步增强 Mission**
- 所以 Phase B 的 "Week 1" 实际是 Plan 1 完成后的第 1 周

### B.1 Mission 配置

| 平台能力 | speakin Mission 怎么用 |
|---|---|
| **看** | GSC（HTTP 适配器，Plan 2）+ 知乎/掘金后台数据（浏览器适配器，Plan 4） |
| **做** | speakin 发文接口（HTTP 适配器，Plan 2）+ 知乎/掘金发布（浏览器适配器，Plan 4） |
| **想** | 周循环：每周看上周数据 → 派下一波选题 + 写作任务（Plan 1 v1） |
| **不失控** | 标准护栏 + 熔断按钮 + "账号被限/超预算/循环异常"3 类必叫人（Plan 3） |

### B.2 4 周观察分周计划（按 Plan 完成节奏更新）

| 周 | 平台层完成 | Mission 此时的能力 | 这周结束你能看到 |
|---|---|---|---|
| **Week 1** | Plan 1（派活 v1）+ Plan 2（HTTP） | 基础接龙 + speakin 自动发文 + GSC 数据回流 | speakin.cc 上有 1 篇 AI 自写自发的博文，团队基于 GSC 数据讨论下一篇 |
| **Week 2** | Plan 3（安全） | + 安全护栏 + 熔断按钮 | 至少 1 次"AI 主动叫人"被触发，用户在 War Room 能看到原因 |
| **Week 3** | Plan 4 上半（浏览器引擎 + 知乎） | + 知乎适配 | 知乎上有 1 篇 AI 自写自发的文章，团队为博文+知乎 2 路协调 |
| **Week 4** | Plan 4 下半（掘金） | + 掘金适配 | 3 渠道并行产出，AI 团队为 3 路协调，累计约 6-8 篇 |

注：Week 1 比原版重，因为 Plan 1+2 都要在 Week 1 内完成才能让 Mission 真正"挂上墙"。如果时间紧，可拆成 Week 1 = Plan 1 完成 + Mission 启动只跑接龙；Week 2 = Plan 2 完成接通 speakin/GSC。

### B.3 成功标准（不是流量，是循环）

**算成功的事实**：
- 6-8 篇 AI 自写自发的内容挂到 3 个真实渠道
- 至少 1 篇博文被 Google 收录、至少 1 个搜索词带来真实点击
- 至少 1 个知乎/掘金帖有真实互动
- AI 团队的对话里能看到"基于 X 数据 → 决定本周写 Y"的归因
- 至少 1 次"AI 主动叫人"被正确触发

**不算失败的事**（SEO 周期天然慢）：
- speakin 没涨 1000 注册
- 知乎/掘金没涨 1000 粉
- AI 写得"合格但不出彩"

**真正的失败**：
- AI 产出和真实数据没任何关联（**循环没合上**）
- 系统出问题 AI 不叫你（**熔断没接通**）
- AI 之间扯皮没结论，内容发不出去（**多角色协调跑不动**）

---

## Phase C: 第 2 跑——基于 Phase B 真实数据决定方向（不预先选）

Phase B 跑完后看真实数据，从下面 3 条路径选一条：

| 路径 | 描述 | 适合什么情况 |
|---|---|---|
| **C-1: 横向扩**（渠道矩阵） | 复用浏览器自动化引擎加 小红书 / 微博 / B 站，验证"换平台只是换配置"的设计是否成立 | Week 4 后想验证"渠道矩阵覆盖更广" |
| **C-2: 纵向深**（增长闭环） | 加付费投放建议系统、A/B 测试、转化漏斗优化、邮件召回，扩展"看/做"的类型 | Week 4 后流量进来了但转化差 |
| **C-3: 切第二主线**（迭代主线） | 用户反馈采集 → AI 提需求 → 写代码 → PR（OpenClaw runtime 派上用场） | Week 4 后想验证"AI 真的能改产品" |
| **C-4: 派活权下放**（A.3 v2/v3/v4） | 让 Owner 之外的角色也能派"角色内任务"，向"真团队"形态演进 | Week 4 后觉得 Owner 单点决策太累/方向太集权 |

**重要**：Phase B 跑完 **不要现在就锁死** Phase C 走哪条。看真实数据再说。

---

## 已完成的能力（不动，作为 Phase A 的基础）

下面这些能力已经做完且实测可用，Phase A 直接复用：

| 原 Phase | 能力 | 复用点 |
|---|---|---|
| Phase 1 | Owner 多轮对话 + MissionBrief | Mission 创建入口不变 |
| Phase 2 | HR 智能组团 + 谈判 | 团队组建不变 |
| Phase 3（部分） | Agent 通信基础设施 + 共享知识库 | A.1 的数据落到 KnowledgeEntry，A.3 v1 在 conversation bus 加 `create_followup_task` 处理 |
| Phase 4.1 | 任务调度器（cron + 模板基础设施） | A.1 / A.2 的"定时拉数据 / 定时发布"复用；A.4 的"循环异常告警"也复用 |
| Phase 4.2 | 周期任务模板（基础设施） | 模板格式复用；现有 4 个内置模板内容（自检型）需要在 Phase B 时配置实质工作模板补充 |
| Phase 5.0 | 反馈基础设施域类型 | A.3 v1 的决策 LLM 输入用这些反馈数据 |
| Phase 5.1（部分） | 反馈面板 UI | War Room 显示反馈数据 |

---

## 暂时不做的能力（清楚是"暂缓"不是"砍掉"）

| 原 Phase | 能力 | 为什么暂缓 |
|---|---|---|
| Phase 4.3 | 条件触发器 | A.3 的"反馈驱动决策"实质上覆盖了大部分场景，纯条件触发可以等 Phase B 跑通后看是否真需要 |
| Phase 4.5 | War Room UX 重构 | 当前 UI 够用，体验不够好但不影响"循环跑通"，等 Phase B 后再优化 |
| Phase 5.2（仅"失败任务自动重规划"那条） | 失败任务自动重规划 | A.3 的决策能力升级后，重规划是其副产品。**Phase 5.2 主体已并入 A.3 v1（Plan 1）** |
| Phase 6 | 长期记忆 / Milestone / 检查点 | 月级 Mission 才需要，Phase B 是 4 周观察，不卡这个 |
| Phase 7 | 原生轻量 Runtime（替换 OpenClaw） | 性能优化，OpenClaw 当前够用，不在关键路径 |

---

## 其他已识别但未规划的问题

| 问题 | 影响 | 规划状态 |
|---|---|---|
| **任务执行有时跑、有时不跑**（用户实测） | 不稳定，可能 OpenClaw 子进程偶尔启动失败 | Plan 1 完成后单独诊断（不在 Plan 1 范围）。如果 Plan 1 完成后这个问题还在，开个独立诊断 + 修复 task |

---

## 项目最终验收标准

**原版**："1 个月小红书运营 Mission 能从始至终持续运行"

**新版**：
> 用户能在平台上**同时跑多个完全不同形态的 Mission**（如 speakin.cc 内容运营 + 个人股票组合监控 + 自家产品迭代），每个 Mission 都自动循环（观察→分析→优化），用户日常只需要看汇报和处理"AI 必叫人"的少数节点。

speakin.cc Mission 是**第一个**这样的 Mission，但平台不为它定制。
