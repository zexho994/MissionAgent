function renderWarRoom() {
  const data = scoped();
  if (!data.mission) {
    state.view = "home";
    renderHome();
    return;
  }

  $("app-view").innerHTML = `
    <section class="war-room-page">
      <aside class="war-nav">
        ${warNavButton("overview", "总控看板")}
        ${warNavButton("agents", "Agents")}
        ${warNavButton("conversations", "协作对话")}
        ${warNavButton("tasks", "任务列表")}
        ${warNavButton("schedule", "定时任务")}
        ${warNavButton("outputs", "产出列表")}
      </aside>
      <section class="war-content">
        ${state.warTab === "overview" ? renderWarOverview(data) : renderWarTab(data)}
      </section>
    </section>
  `;

  document.querySelectorAll("[data-war-tab]").forEach((button) => {
    button.addEventListener("click", () => {
      state.warTab = button.dataset.warTab;
      renderWarRoom();
    });
  });

  const triggerNext = document.querySelector("[data-trigger-next]");
  if (triggerNext) {
    triggerNext.addEventListener("click", () => {
      const mission = currentMission();
      if (mission) void triggerNextSchedule(mission.id);
    });
  }
  const toggleAutomation = document.querySelector("[data-toggle-automation]");
  if (toggleAutomation) {
    toggleAutomation.addEventListener("click", () => {
      const mission = currentMission();
      if (!mission) return;
      if (toggleAutomation.dataset.toggleAutomation === "resume") {
        void resumeAutomation(mission.id);
      } else {
        void pauseAutomation(mission.id);
      }
    });
  }
  const toggleScheduleForm = document.querySelector("[data-toggle-schedule-form]");
  if (toggleScheduleForm) {
    toggleScheduleForm.addEventListener("click", () => {
      state.scheduleFormOpen = !state.scheduleFormOpen;
      renderWarRoom();
    });
  }
  const scheduleTemplateForm = document.querySelector("#schedule-template-form");
  if (scheduleTemplateForm) {
    scheduleTemplateForm.addEventListener("submit", (event) => {
      event.preventDefault();
      const mission = currentMission();
      if (!mission) return;
      const formData = new FormData(scheduleTemplateForm);
      const templateType = formData.get("templateType");
      const runNow = formData.get("runNow") === "on";
      const payload = templateType === "condition_response"
        ? {
            templateType,
            sourceAgentRole: formData.get("sourceAgentRole"),
            condition: formData.get("condition"),
            responseAssigneeRole: formData.get("responseAssigneeRole"),
            responseTaskGoal: formData.get("responseTaskGoal"),
          }
        : {
            templateType,
            assigneeRole: formData.get("assigneeRole"),
            taskGoal: formData.get("taskGoal"),
          };
      void createScheduleTemplate(mission.id, payload, runNow);
    });
  }
}

function warNavButton(tab, label) {
  return `<button class="${state.warTab === tab ? "active" : ""}" data-war-tab="${tab}" type="button">${label}</button>`;
}

function renderWarOverview(data) {
  return `
    <div class="war-head">
      <div>
        <p>Mission 作战室</p>
        <h1>${esc(shortText(data.mission.goal, 84))}</h1>
      </div>
      <span>${missionStateText(data.executions)}</span>
    </div>
    ${renderAutomationPulse(data, state.automationSummaryByMissionId[data.mission.id])}
    ${renderFeedbackPanel(state.feedbackSummaryByMissionId[data.mission.id])}
    ${renderStrategyAdjustmentsPanel(state.strategyAdjustmentsByMissionId[data.mission.id])}
    ${renderAutopilotDiagnosis(state.autopilotDiagnosisByMissionId[data.mission.id])}
    <div class="war-stage">
      <div class="stage-note">
        <strong>War Room</strong>
        <span>蓝色连线表示当前活跃协作，虚线表示等待中的交接。</span>
      </div>
      <div class="relation-summary">
        ${renderRelationSummary(data)}
      </div>
      <div class="agent-network">
        ${renderAgentNetwork(data)}
      </div>
    </div>
    <div class="war-bottom">
      <div>
        <strong>当前关键任务</strong>
        <p>${esc(nextTaskText(data))}</p>
      </div>
      <div>
        <strong>最近产出</strong>
        <p>${esc(latestOutputText(data))}</p>
      </div>
    </div>
  `;
}

function renderFeedbackPanel(summary) {
  if (!summary) {
    return `
      <div class="feedback-panel">
        <div>
          <span>反馈闭环</span>
          <strong>正在读取反馈状态</strong>
          <p>系统会在任务完成或失败后记录 Mission 层面的学习结果。</p>
        </div>
      </div>
    `;
  }
  const evaluation = summary.latestEvaluation;
  const failure = summary.latestFailureAnalysis;
  const adjustment = summary.latestStrategyAdjustment;
  return `
    <div class="feedback-panel">
      <div class="feedback-main">
        <span>反馈闭环</span>
        <strong>${evaluation ? esc(evaluation.summary) : "还没有任务反馈"}</strong>
        <p>${evaluation ? `结果：${esc(evaluation.outcome)} · 贡献度 ${Math.round(evaluation.contributionScore * 100)}%` : "完成或失败一个任务后，这里会显示系统学到了什么。"}</p>
      </div>
      <div class="feedback-stats">
        <div><strong>${summary.counts.evaluations}</strong><span>评估</span></div>
        <div><strong>${summary.counts.failureAnalyses}</strong><span>失败分析</span></div>
        <div><strong>${summary.counts.strategyAdjustments}</strong><span>策略提案</span></div>
      </div>
      ${failure ? `<div class="feedback-note blocked"><strong>阻塞</strong><p>${esc(failure.summary)}</p></div>` : ""}
      ${adjustment ? `<div class="feedback-note"><strong>策略提案</strong><p>${esc(adjustment.proposedStrategy)}</p></div>` : ""}
    </div>
  `;
}

function renderStrategyAdjustmentsPanel(adjustments) {
  if (!adjustments || adjustments.length === 0) {
    return `
      <div class="strategy-panel">
        <div>
          <span>策略调整</span>
          <strong>暂无策略调整记录</strong>
          <p>当 Mission 策略发生变更时，会在此处显示历史记录。</p>
        </div>
      </div>
    `;
  }

  return `
    <div class="strategy-panel">
      <div class="strategy-header">
        <span>策略调整</span>
      </div>
      ${adjustments.map(adj => `
        <div class="strategy-record">
          <div class="strategy-rationale">${esc(adj.rationale)}</div>
          <div class="strategy-diff">
            <span class="strategy-from">${esc(adj.previousStrategy)}</span>
            <span class="strategy-arrow">→</span>
            <span class="strategy-to">${esc(adj.proposedStrategy)}</span>
          </div>
          <div class="strategy-meta">
            ${adj.affectedAgentRoles.length > 0 ? `影响角色: ${adj.affectedAgentRoles.join(", ")}` : ""}
            · ${new Date(adj.createdAt).toLocaleString()}
          </div>
        </div>
      `).join("")}
    </div>
  `;
}

function renderAutopilotDiagnosis(diagnosis) {
  if (!diagnosis) {
    return `
      <section class="autopilot-diagnosis">
        <div class="autopilot-diagnosis-main">
          <span>Autopilot 状态</span>
          <strong>正在读取 Autopilot 诊断。</strong>
          <p>等待当前 Mission 的自动运行前置条件。</p>
        </div>
      </section>
    `;
  }

  const blocker = diagnosis.blockers[0];
  const nextAction = blocker?.nextAction || (diagnosis.ready ? "保持现有运行节奏，继续观察执行结果。" : "等待系统更新下一步建议。");
  const signals = diagnosis.signals;
  return `
    <section class="autopilot-diagnosis ${diagnosis.ready ? "ready" : ""}">
      <div class="autopilot-diagnosis-main">
        <span>Autopilot 状态</span>
        <strong>${esc(autopilotStageText(diagnosis.stage))}</strong>
        <p>${blocker ? esc(blocker.message) : "当前没有阻塞项。"}</p>
      </div>
      <div class="autopilot-next">
        <span>下一步建议</span>
        <p>${esc(nextAction)}</p>
      </div>
      <div class="autopilot-signals">
        ${renderAutopilotSignal("Brief 已确认", signals.briefConfirmed)}
        ${renderAutopilotSignal("计划已就绪", signals.hasPlan)}
        ${renderAutopilotSignal("团队已就绪", signals.teamReady)}
        ${renderAutopilotSignal("初始任务", signals.hasInitialTasks)}
        ${renderAutopilotSignal("执行器", signals.hasExecutionRunner)}
        ${renderAutopilotSignal("运行节奏", signals.hasScheduleRules)}
        ${renderAutopilotSignal("正在执行", signals.hasRunningExecution)}
      </div>
    </section>
  `;
}

function renderAutopilotSignal(label, ok) {
  return `<span class="autopilot-signal ${ok ? "ok" : "warn"}">${ok ? "OK" : "!"} ${esc(label)}</span>`;
}

function autopilotStageText(stage) {
  const stageText = {
    briefing: "等待 Brief 确认",
    missing_plan: "缺少执行计划",
    team_not_ready: "团队未就绪",
    missing_initial_tasks: "缺少初始任务",
    missing_execution_runner: "缺少执行器",
    missing_schedule: "缺少运行节奏",
    ready: "已准备自动运行",
    running: "正在执行",
    blocked: "执行受阻",
  };
  return stageText[stage] || stage;
}

function renderAutomationPulse(data, summary) {
  if (!summary) {
    return `
      <div class="automation-pulse">
        <div>
          <strong>自动运行</strong>
          <p>正在读取 Mission 自动运行状态。</p>
        </div>
      </div>
    `;
  }

  const next = summary.nextAction;
  const current = summary.currentScheduledTasks || [];
  const paused = summary.automationPaused;
  const actionDisabled = state.scheduleActionPending ? "disabled" : "";
  return `
    <div class="automation-pulse ${paused ? "paused" : ""}">
      <div class="pulse-main">
        <span class="pulse-label">${paused ? "自动运行已暂停" : "下一次自动动作"}</span>
        <strong>${next ? esc(next.ruleName) : "还没有自动运行节奏"}</strong>
        <p>${next ? `${esc(formatTime(next.nextRunAt))} · ${esc(next.assigneeRole)} · ${esc(next.taskTitle)}` : "去定时任务页添加每日检查或每周复盘。"}</p>
      </div>
      <div class="pulse-side">
        <span>当前运行</span>
        <strong>${current.length ? `${current.length} 个任务` : "无排队任务"}</strong>
        <p>${summary.lastTrigger ? esc(summary.lastTrigger.message) : "暂无触发记录"}</p>
      </div>
      <div class="pulse-actions">
        <button type="button" data-trigger-next ${actionDisabled}>${state.scheduleActionPending ? "处理中..." : "立即触发下一步"}</button>
        <button type="button" data-toggle-automation="${paused ? "resume" : "pause"}" ${actionDisabled}>${paused ? "恢复自动运行" : "暂停自动运行"}</button>
      </div>
      ${state.scheduleError ? `<div class="inline-error">${esc(state.scheduleError)}</div>` : ""}
    </div>
  `;
}

function renderAgentNetwork(data) {
  const agents = [...data.agents].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
  if (agents.length === 0) {
    return `
      <div class="activation-empty">
        <strong>正在进入 Mission</strong>
        <p>等待 HR 接收 MissionBrief。</p>
      </div>
    `;
  }
  return agents.map((agent, index) => {
    const relation = data.relations.find((item) => item.fromAgentId === agent.id);
    const nextAgent = relation ? agents.find((candidate) => candidate.id === relation.toAgentId) : undefined;
    return `
      ${renderAgentNode(data, agent, index)}
      ${relation && nextAgent ? renderRelation(relation, agent, nextAgent) : ""}
    `;
  }).join("");
}

function renderAgentNode(data, agent, index) {
  const tone = toneClass(index);
  return `
    <article class="agent-node ${tone}" data-agent-id="${esc(agent.id)}">
      <div class="pixel-avatar ${tone}" aria-hidden="true">
        <div class="hair"></div>
        <div class="face">
          <span class="eye left"></span>
          <span class="eye right"></span>
          <span class="glasses"></span>
          <span class="mouth"></span>
        </div>
        <div class="body"></div>
      </div>
      <div class="agent-card">
        <strong>${esc(agent.name || "Agent")}</strong>
        <span>状态：${esc(agentStatusLabel(agent.status || "idle"))}</span>
        <p>任务：${esc(taskTitle(data, agent.currentTaskId) || agent.responsibility)}</p>
        <p>产出：${esc(agentOutputText(data, agent) || "等待产出")}</p>
      </div>
    </article>
  `;
}

function renderRelation(relation, fromAgent, toAgent) {
  return `
    <div class="agent-relation ${relation.status === "active" ? "active" : ""}">
      <span></span>
      <strong>${esc(shortAgentName(fromAgent.name))} → ${esc(shortAgentName(toAgent.name))}：${esc(relation.label)}</strong>
    </div>
  `;
}

function renderRelationSummary(data) {
  if (data.relations.length === 0) return `<span>暂无 agent 工作关系</span>`;
  const byId = new Map(data.agents.map((agent) => [agent.id, agent]));
  return data.relations.map((relation) => {
    const fromAgent = byId.get(relation.fromAgentId);
    const toAgent = byId.get(relation.toAgentId);
    return `<span>${esc(shortAgentName(fromAgent?.name || "Agent"))} → ${esc(shortAgentName(toAgent?.name || "Agent"))}：${esc(relation.label)}</span>`;
  }).join("");
}

function renderWarTab(data) {
  if (state.warTab === "conversations") {
    return renderConversationFeed(data);
  }
  if (state.warTab === "schedule") {
    return renderScheduleTab(
      data,
      state.scheduleRulesByMissionId[data.mission.id] || [],
      state.automationSummaryByMissionId[data.mission.id],
    );
  }
  const map = {
    agents: {
      title: "Agents 看板",
      intro: "按角色查看每个 agent 的职责、状态、当前任务和最近动作。",
      items: [...data.agents]
        .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
        .map((agent) => `${agent.name}：${agent.lastAction || agent.responsibility}`),
    },
    tasks: {
      title: "任务列表",
      intro: "这里只展示代表任务，不把所有执行日志堆出来。",
      items: data.tasks.map((task) => `${statusLabel(task.status)}：${task.title}`),
    },
    schedule: {
      title: "定时任务",
      intro: "展示 24 小时运行中的定时复盘、巡检、发布等任务。",
      items: [],
    },
    outputs: {
      title: "产出列表",
      intro: "按时间线展示每个阶段的产出和审核结果。",
      items: outputItems(data),
    },
  };
  const content = map[state.warTab] || map.agents;
  return `
    <div class="tab-panel">
      <h1>${esc(content.title)}</h1>
      <p>${esc(content.intro)}</p>
      <div class="tab-list">
        ${content.items.length ? content.items.map((item) => `<div>${esc(item)}</div>`).join("") : `<div>暂无数据</div>`}
      </div>
    </div>
  `;
}

function renderScheduleTab(data, rules, summary) {
  const disabled = state.scheduleActionPending ? "disabled" : "";
  return `
    <div class="tab-panel schedule-panel">
      <div class="schedule-head">
        <div>
          <h1>定时任务</h1>
          <p>把 Mission 的日常检查、周复盘和条件响应固化成自动执行规则。</p>
        </div>
        <button type="button" data-toggle-schedule-form ${disabled}>${state.scheduleFormOpen ? "收起" : "新增规则"}</button>
      </div>
      ${state.scheduleError ? `<div class="inline-error">${esc(state.scheduleError)}</div>` : ""}
      ${renderTriggerHistory(summary)}
      ${state.scheduleFormOpen ? renderScheduleTemplateForm(data) : ""}
      <div class="schedule-rules">
        ${rules.length ? rules.map((rule) => renderScheduleRuleCard(data, rule)).join("") : `<div class="empty-state">暂无定时规则。新增每日检查、每周复盘或条件响应后，这里会显示运行节奏。</div>`}
      </div>
    </div>
  `;
}

function renderScheduleRuleCard(data, rule) {
  const trigger = rule.trigger.type === "cron"
    ? `Cron：${rule.trigger.expression} · ${rule.trigger.timezone}${rule.nextRunAt ? ` · 下次 ${formatTime(rule.nextRunAt)}` : ""}`
    : `条件：${rule.trigger.description} · 来源 ${rule.trigger.sourceAgentRole}`;
  const agent = data.agents.find((candidate) => candidate.role === rule.taskTemplate.assigneeRole);
  return `
    <article class="schedule-rule-card ${rule.enabled ? "" : "paused"}">
      <header>
        <div>
          <strong>${esc(rule.name)}</strong>
          <span>${esc(trigger)}</span>
        </div>
        <span class="schedule-rule-state">${rule.enabled ? "启用" : "暂停"}</span>
      </header>
      <dl>
        <div>
          <dt>负责人</dt>
          <dd>${esc(agent ? `${agent.name} / ${rule.taskTemplate.assigneeRole}` : rule.taskTemplate.assigneeRole)}</dd>
        </div>
        <div>
          <dt>任务</dt>
          <dd>${esc(rule.taskTemplate.title)}</dd>
        </div>
      </dl>
    </article>
  `;
}

function renderTriggerHistory(summary) {
  const current = summary?.currentScheduledTasks || [];
  return `
    <section class="schedule-history">
      <div>
        <span>最近触发</span>
        <strong>${summary?.lastTrigger ? esc(summary.lastTrigger.ruleName) : "暂无触发记录"}</strong>
        <p>${summary?.lastTrigger ? `${esc(formatTime(summary.lastTrigger.createdAt))} · ${esc(summary.lastTrigger.status)} · ${esc(summary.lastTrigger.message)}` : "手动或自动触发后会记录在这里。"}</p>
      </div>
      <div>
        <span>当前排队</span>
        <strong>${current.length ? `${current.length} 个任务` : "无排队任务"}</strong>
        <p>${current.length ? current.map((task) => esc(`${statusLabel(task.status)}：${task.title}`)).join("<br>") : "没有未完成的定时任务。"}</p>
      </div>
    </section>
  `;
}

function renderScheduleTemplateForm(data) {
  const roleOptions = data.agents
    .map((agent) => agent.role)
    .filter((role, index, roles) => roles.indexOf(role) === index)
    .map((role) => `<option value="${esc(role)}">${esc(role)}</option>`)
    .join("");
  return `
    <form id="schedule-template-form" class="schedule-template-form">
      <label>
        <span>模板</span>
        <select name="templateType">
          <option value="daily_check">每日检查</option>
          <option value="weekly_review">每周复盘</option>
          <option value="condition_response">条件响应</option>
        </select>
      </label>
      <div class="schedule-form-grid">
        <label>
          <span>负责人</span>
          <select name="assigneeRole">${roleOptions}</select>
        </label>
        <label>
          <span>任务目标</span>
          <input name="taskGoal" type="text" placeholder="例如：检查昨天的增长指标并给出下一步动作">
        </label>
        <label>
          <span>来源角色</span>
          <select name="sourceAgentRole">${roleOptions}</select>
        </label>
        <label>
          <span>触发条件</span>
          <input name="condition" type="text" placeholder="例如：核心指标连续两天下降">
        </label>
        <label>
          <span>响应负责人</span>
          <select name="responseAssigneeRole">${roleOptions}</select>
        </label>
        <label>
          <span>响应任务目标</span>
          <input name="responseTaskGoal" type="text" placeholder="例如：诊断异常并提出修正方案">
        </label>
      </div>
      <div class="schedule-form-actions">
        <label class="schedule-run-now">
          <input name="runNow" type="checkbox">
          <span>创建后立即运行一次</span>
        </label>
        <button type="submit" ${state.scheduleActionPending ? "disabled" : ""}>${state.scheduleActionPending ? "创建中..." : "创建规则"}</button>
      </div>
    </form>
  `;
}

function renderConversationFeed(data) {
  const threads = [...data.threads].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return `
    <div class="tab-panel conversation-panel">
      <h1>协作对话</h1>
      <p>展示 Agent 之间围绕执行、审核、请求和异常通知产生的上下文线程。</p>
      <div class="conversation-feed">
        ${threads.length ? threads.map((thread) => renderConversationThread(data, thread)).join("") : `<div class="empty-state">暂无 Agent 协作对话</div>`}
      </div>
    </div>
  `;
}

function renderConversationThread(data, thread) {
  const messages = data.messages.filter((message) => message.threadId === thread.id);
  return `
    <article class="thread-card">
      <header>
        <div>
          <strong>${esc(thread.topic)}</strong>
          <span>${thread.participantAgentIds.length} 个参与者 · ${thread.status === "active" ? "进行中" : "已结束"}</span>
        </div>
        <time>${esc(formatTime(thread.createdAt))}</time>
      </header>
      <div class="thread-messages">
        ${messages.map((message) => renderThreadMessage(data, message)).join("")}
      </div>
    </article>
  `;
}

function renderThreadMessage(data, message) {
  const agent = data.agents.find((candidate) => candidate.id === message.fromAgentId);
  const name = message.fromAgentId === "user" ? "你" : (agent?.name || "Agent");
  return `
    <div class="thread-message">
      <div>
        <strong>${esc(name)}</strong>
        <span class="message-badge">${esc(messageTypeLabel(message.type))}</span>
      </div>
      <p>${highlightMentions(esc(message.content), data)}</p>
    </div>
  `;
}

function messageTypeLabel(type) {
  const map = {
    agent_chat: "对话",
    agent_report: "汇报",
    agent_request: "请求",
    agent_notify: "通知",
    agent_discussion: "讨论",
    user_message: "用户",
  };
  return map[type] || type;
}

function highlightMentions(content, data) {
  let highlighted = content;
  for (const agent of data.agents) {
    const shortName = shortAgentName(agent.name);
    highlighted = highlighted.replaceAll(`@${shortName}`, `<mark>@${esc(shortName)}</mark>`);
  }
  return highlighted;
}

function formatTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", { hour12: false });
}
