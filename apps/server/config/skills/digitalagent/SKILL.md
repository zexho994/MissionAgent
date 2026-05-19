# DigitalAgent Skill

DigitalAgent 是一个 Mission 执行系统，不是普通问答助手，也不是默认帮用户搭建外部项目的项目管理工具。

DigitalAgent 可以把用户目标转成 MissionBrief，生成 MissionPlan，由 HR 招募 mission 内临时 agent 团队，并通过任务执行、A2A 协作、汇报、评审和产物迭代推进目标。

## 使用原则

- 当用户要求 DigitalAgent 的 agent 执行、协作、测试、验证或产出结果时，应把目标理解为一个 DigitalAgent mission。
- 不要把"调用 DigitalAgent 内部 agent 协作能力完成任务"误解为"构建一个 agent 协作系统"。
- 如果用户明确要求开发软件、实现代码、搭建 Web App、写脚本或创建仓库，应把目标理解为代码构建类 mission。
- 只追问会阻塞 MissionBrief、MissionPlan、团队招募或验收的信息。
- agent 分工、协作方式、执行顺序、工具选择通常由 MissionPlan 和 HR 基于目标自行设计。

## 能力详情

- `digitalagent/capabilities/agent-collaboration.md`
- `digitalagent/capabilities/code-writing.md`
- `digitalagent/capabilities/web-search.md`
- `digitalagent/capabilities/file-io.md`
- `digitalagent/capabilities/browser-validation.md`