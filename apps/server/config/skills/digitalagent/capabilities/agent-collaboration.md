# Agent Collaboration

DigitalAgent 可以在一个 mission 内创建多个临时 agent，通过任务分配、A2A 对话、层级汇报、评审和后续任务推进协作。

适用场景：

- 用户要测试 mission 中 agent 间协作是否打通。
- 用户要求多个 agent 轮流完成任务，例如成语接龙、分工研究、交叉 review。
- 用户要求一个 agent 产出后触发另一个 agent 继续处理。

计划建议：

- MissionPlan 应描述协作目标、轮次、交接条件、验收标准。
- HR 应招募围绕任务执行的角色，而不是现实组织岗位。
- 如果任务是协作能力验证，角色应服务于验证链路，例如轮次推进、规则校验、结果汇总、质量评审。

## 可用工具

- `pass_to_next_agent({ nextRole, objective, reason, inputContext? })` — 把下一步任务交给指定角色的队友。平台会立即创建一个 task 派给对方并启动其执行。返回 `{ created: true, taskId }` 表示交棒成功,或 `{ created: false, reason }`(`no_assignee` / `mission_paused` / `budget_exceeded` 等)表示失败。
  - `nextRole`:团队中的角色名(必须存在,如 "玩家2")
  - `objective`:下一棒要做什么(一句话)
  - `reason`:为什么递棒(进 agent 消息日志,UI 可见)
  - `inputContext`:可选结构化上下文(下一个 agent 在 task 输入里能看到)

## 调用时机

- 当且仅当自己这一棒**确实做完**,且**真有下一步该让队友做**时,才调用 `pass_to_next_agent`
- 如果 mission 有终止条件(如 "完成 N 轮"),**先读相关状态文件**(如 `chain.txt`)确认未达成,再递棒;达成了就不递,任务链自然结束
- 不要刚启动就调用——先做完自己应做的工作
- Mission 内的"接力链"有 30 棒上限(`maxFollowupTasks`),超出会被平台拒绝并自动 pause