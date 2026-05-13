# HR 招募 LLM 驱动化改造设计

**日期**: 2026-05-13
**作者**: 与 Claude 共创
**状态**: 草案 / 待审阅

---

## 1. 背景

当前 DigitalAgent 在 Mission 激活时存在 **两条 HR 招募路径**：

| 路径 | 入口 | 实现 |
|---|---|---|
| A. LLM 招人(主路径) | `mission-service.ts:activateMissionWithHR()` → `negotiation-manager.ts` → `hr-agent.ts:analyzeAndPlan()` | LLM 分析 MissionBrief，输出 RoleSpec[] |
| B. 关键词招人(fallback) | `mission-service.ts:activateMission()` → `team-planning.ts:planMissionTeam()` | goal 文本匹配 `agent-system.json` 中固化的 4 条 keyword rules |
| C. 重复代码(死代码) | `hr-activation.ts:activateWithHRAgent()` | 仅测试在引用，未被生产代码调用 |

**核心问题**：路径 A 在 LLM 调用失败时(超时、网络、JSON 解析错误)会**静默降级**到路径 B(`mission-service.ts:833` 处的 catch)。从外部完全看不出来 — 用户以为"HR 招人成功"，实际可能是关键词兜底拼出来的团队。

这一行为导致：
- 招募质量不可控(LLM 抖动时静默退化)
- 测试不可观察("成语接龙"等用例无法验证 HR 真的有判断力)
- 死代码累积(`hr-activation.ts` 和 `team-planning.ts` 维护成本高)

## 2. 目标

把 HR 招募改造为**纯 LLM 驱动、出错可见**的单一路径：

1. **删除关键词路径**：彻底去除 `team-planning.ts` 及其在 `agent-system.json` 中的配置依赖
2. **删除 fallback 行为**：LLM 失败时不再静默降级，改为内部重试 3 次后抛错
3. **删除重复代码**：清理 `hr-activation.ts`(死代码)
4. **错误透传**：API 层返回 503，前端显示重试按钮
5. **清理测试**：删除关键词路径相关测试，新增重试逻辑测试

## 3. 非目标

- **不改 LLM HR 的 prompt 内容**：现有 `hr-agent.ts:buildHRAgentSystemPrompt()` 输出质量已通过验证，本次只动控制流
- **不改前端整体架构**：仅在 HR Agent 卡片增加重试状态显示与重试按钮
- **不改 Owner Agent / Negotiation 协商逻辑**：本次只覆盖"激活时的首次 HR 招募"，不涉及后续 Owner 反馈与团队协商
- **不引入新的 LLM 服务/模型**：复用现有 `@digitalagent/runtime` 的 LlmService

## 4. 改造后的流程

```
用户在 UI 确认 MissionBrief
        ↓
HTTP API: /missions/:id/activate
        ↓
mission-service.activateMission()    ← 名字保留，但内部只走 LLM 这一条
        ↓
negotiation-manager.startNegotiation(brief)
        ↓
   ┌──→ hr-agent.analyzeAndPlan(brief)  ← LLM 调用
   │       ↓
   │   失败？──→ 重试 ≤3 次(间隔 1s/2s/4s)
   │       ↓
   │   成功
   │       ↓
   │   RoleSpec[] → 创建 WarRoomAgent
   │       ↓
   │   进入 Owner 协商流程
   │
   └── 3 次都失败 → HR 状态置 "failed" → 抛错 → API 返回 503
                                                    ↓
                                          前端显示"招募失败，点击重试"
```

**保证**：整个系统不再存在任何"LLM 不行就走老路"的隐藏分支。

## 5. 文件级影响清单

### 删除

| 文件 | 原因 |
|---|---|
| `apps/server/src/team-planning.ts` | 关键词匹配入口，无人调用。⚠️ **注意**：文件中的 `matcherFor()` 工具函数被 `mission-service.ts:3372-3374` 引用(用于 capability 匹配)，删除前需先将其搬迁到 `mission-service.ts` 或新建 `regex-utils.ts` |
| `apps/server/src/team-planning.test.ts` | 对应测试 |
| `apps/server/src/hr-activation.ts` | 重复 LLM HR 入口，仅测试在用 |

### 修改

| 文件 | 改造点 |
|---|---|
| `apps/server/src/mission-service.ts` | 删除老 `activateMission()`(line 725-771)；把 `activateMissionWithHR()` 改名为 `activateMission()`；去掉 `catch (error) ... return this.activateMission(input)` 那段 fallback(line 832-835) |
| `apps/server/src/negotiation-manager.ts` | `startNegotiation()` 外层包重试逻辑：捕获 `analyzeAndPlan` 异常 → 重试 ≤3 次(1s/2s/4s 指数退避)；耗尽后把 HR Agent 状态改为 "failed" + 抛错 |
| `apps/server/src/system-config.ts` | 从 `AgentSystemConfig` 类型中删除被砍掉的字段；调整 `loadAgentSystemConfig` 的校验逻辑 |
| `apps/server/src/api.ts` | `/missions/:id/activate` 路径：捕获 HR 抛错时返回 `503 Service Unavailable` + `Retry-After: 5` 头 |
| `apps/server/src/mission-service.test.ts` | 删除关键词路径相关 case；保留 LLM 路径 case 但去掉对 fallback 行为的断言 |

### 配置瘦身 `apps/server/config/agent-system.json`

**保留**:
```
owner.*                       (Owner Agent 的 prompt)
teamPlanner.baseAgents        (owner + hr 这两个系统级角色)
teamPlanner.capabilityMatchers (被 mission-service.ts:firstAgentWithCapability 使用,与 HR 招募无关)
agentCollaboration.*          (LLM 角色互动配置)
ui.*                          (前端文案)
```

**删除**:
```
teamPlanner.rules             (4 条关键词规则)
teamPlanner.fallbackAgent     (Mission Operator 兜底角色)
teamPlanner.reviewAgent       (彻底重构 — 由 LLM HR 决定要不要 reviewer)
teamPlanner.relationLabels    (LLM HR 不使用)
teamPlanner.initialTasks      (跟随 rules 一起失效)
```

## 6. 错误处理 + 重试策略

### 6.1 重试逻辑位置

放在 `negotiation-manager.ts` 的 `startNegotiation()` 中，**不放在 `hr-agent.ts`** — `hr-agent` 职责只是"调 LLM + 解析返回"，重试属于编排层关注点，便于隔离测试。

### 6.2 触发重试的错误类型

| 错误类型 | 改造后行为 |
|---|---|
| LLM 调用超时 / 网络断 | 重试 |
| LLM 返回的 JSON 解析失败 | 重试 |
| LLM 返回的 RoleSpec 字段校验不通过 | 重试 |
| `analyzeAndPlan` 抛出任何其他异常 | 重试 |
| 3 次都失败 | HR 状态置 "failed"，向上抛出最后一次错误 |

### 6.3 重试间隔

固定指数退避：**第 1 次重试等 1s，第 2 次等 2s，第 3 次等 4s**(总等待时间最多 7s，不含 LLM 调用本身耗时)。

### 6.4 HR Agent 状态机

| 阶段 | status | lastAction |
|---|---|---|
| 初次调用前 | `running` | "正在分析 MissionBrief..." |
| 第 N 次重试中 | `running` | "第 N 次重试中..."(流推到前端) |
| 全部成功 | `idle` | "团队招募完成" |
| 全部失败 | `failed` | "招募失败 (3 次重试均失败)" |

### 6.5 HTTP 错误码

- 成功：保持现有 200 行为
- 失败：返回 **503 Service Unavailable** + `Retry-After: 5` 头
- 前端拿到 503 后在 HR Agent 卡片上展示"重试"按钮，点击重新触发 `/activate` 接口

### 6.6 副作用与状态恢复

- HR 失败时 **不删除已创建的 HR Agent 记录** — 保留 `failed` 状态供用户感知
- 重试时复用同一个 HR Agent 记录(不重复创建)
- MissionBrief 本身保持不变 — 用户无需重填表单
- 不影响 Mission 的状态(仍处于待激活状态)

## 7. 测试策略

### 7.1 确定性测试(Mock LLM, 进 CI)

加在 `negotiation-manager.test.ts` 与 `mission-service.test.ts`：

| 测试用例 | 验收 |
|---|---|
| 重试成功路径 | Mock LLM 前 2 次抛错、第 3 次成功 → HR 最终 `idle`、团队创建成功 |
| 重试耗尽路径 | Mock LLM 始终抛错 → HR 最终 `failed`、错误冒到 API 返回 503 |
| 重试间隔验证 | Fake timer 检查每次重试间隔为 1s/2s/4s |
| JSON 损坏触发重试 | Mock LLM 返回不合法 JSON → 走重试流程 |
| RoleSpec 校验失败触发重试 | Mock LLM 返回缺字段的 RoleSpec → 走重试流程 |
| 无 fallback 验证 | 编译期保证 — `team-planning.ts` 已删除，调用方无处可去 |
| HR 状态消息流 | 每次重试时,前端 stream 收到对应文案 |

### 7.2 端到端验收(真 LLM, 手动/定时)

放入 `npm run test:smoke:hr` 独立命令，**不进 CI**。

LLM 输出非确定，验收标准只能写**结构化**断言：

```
用例 E1：基础协作 — 成语接龙
  Mission: "5 个 agent 协作玩成语接龙,完成 50 次以上才算成功"
  验收:
    ✓ HR 招出的团队规模在 2-5 个(preferredTeamSize 范围内)
    ✓ 每个角色有非空 name / responsibility / budget
    ✓ Mission 可激活并进入 running 状态
    ✓ (人工 review)角色名字"听起来合理"

用例 E2:基础协作 + 文件读写
  Mission: "5 个 agent 协作玩成语接龙,每轮把当前接到的成语写到 chain.txt"
  额外验收:
    ✓ 至少一个角色的 allowedTools 包含 file/read/write 相关 tool

用例 E3:基础协作 + 网页搜索
  (后续随网页搜索能力上线再补)

用例 E4:基础协作 + 记忆系统
  (后续随记忆系统上线再补)
```

### 7.3 删除的测试

- `team-planning.test.ts` 整个文件
- `mission-service.test.ts` 中关键词路径相关 case

## 8. 实施顺序

按"低风险 → 高风险"分 4 段,每段独立 PR、单独可回滚。

### 阶段 1: 加重试(纯加法)
- 在 `negotiation-manager.ts` 加重试逻辑 + 单测
- 关键词 fallback 保留(暂时不动)
- **风险**: 0 — 纯加功能,行为向后兼容
- **预估**: 2-3h

### 阶段 2: 拆 fallback(行为变化)
- 删 `activateMissionWithHR` 里的 catch fallback
- API 错误返回 503
- 加 HR 状态 `failed` + 状态消息流
- 更新对应测试(去掉 fallback 断言)
- **风险**: 中 — 用户首次能感知到 LLM HR 失败
- **回滚信号**: 失败率 >5% 或用户反馈"招不到人 mission 起不来"
- **预估**: 1-2h

### 阶段 3: 删除死代码(机械清理)
- 删 `team-planning.ts` / `team-planning.test.ts` / `hr-activation.ts`
- `mission-service.ts` 中 `activateMission` 重命名
- `agent-system.json` 瘦身
- `system-config.ts` 类型同步
- 清理 `mission-service.test.ts`
- **风险**: 低(逻辑) / 高(diff churn) — 大量删除,审阅工作量大
- **预估**: 2-3h

### 阶段 4: UI/UX 提示(前端)
- HR Agent 卡片显示重试状态文案
- 失败时显示"重试"按钮 + 重新调 activate
- 对齐 503 错误文案
- **风险**: 0 — 纯前端
- **预估**: 1-2h

### 回滚矩阵

| 阶段 | 回滚成本 | 触发条件 |
|---|---|---|
| 1 | 0 | 几乎不可能 |
| 2 | 低 | revert 一个 commit; LLM HR 失败率突增 |
| 3 | 中 | 阶段 2 后续暴露问题且已 ship 阶段 3 — 推荐直接修阶段 2 而非回滚阶段 3 |
| 4 | 低 | 文案/样式小问题 |

## 9. 验收标准

- [ ] `team-planning.ts` 不存在
- [ ] `hr-activation.ts` 不存在
- [ ] `agent-system.json` 不含 `rules` / `fallbackAgent` / `reviewAgent` / `relationLabels` / `initialTasks` 字段
- [ ] 全文 grep `planMissionTeam` 0 个匹配
- [ ] `pnpm typecheck` 通过
- [ ] `pnpm test` 全绿,且包含新增的重试逻辑测试
- [ ] 手动 smoke test:输入"成语接龙"goal → HR 能给出合理团队(非兜底)
- [ ] 手动 smoke test:LLM 错误注入 → 前端能看到重试状态 → 最终 503 + 重试按钮

## 10. 风险与开放问题

| 风险 | 缓解措施 |
|---|---|
| LLM HR 实际失败率高于预期 | 阶段 2 后密切观察生产环境,失败率 >5% 即回滚阶段 2 |
| 重试间隔 1s/2s/4s 不够长,LLM 服务恢复前用完重试 | 后续可调整(配置化);本次先用经验值 |
| 删除 `team-planning.ts` 时 `matcherFor` 工具函数仍被引用 | 已确认被 `mission-service.ts:firstAgentWithCapability` 使用;实施时先搬迁,再删文件 |
| `baseAgents` 中 hr 的 systemPrompt 与 `hr-agent.ts:buildHRAgentSystemPrompt()` 内容重复 | 本次不处理,后续单独优化点 |

---

**审阅请关注**:
1. 第 4 节流程是否对得上你的预期
2. 第 6.3 节重试间隔(1s/2s/4s)是否合理
3. 第 7.2 节端到端测试用例是否覆盖你的验收需求
4. 第 8 节实施顺序是否能容忍中间状态(尤其阶段 2 完成、阶段 3 未做时)
