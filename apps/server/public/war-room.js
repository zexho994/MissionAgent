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
  document.querySelectorAll("[data-accept-adjustment]").forEach((button) => {
    button.addEventListener("click", () => {
      const missionId = button.dataset.missionId;
      const adjustmentId = button.dataset.acceptAdjustment;
      if (missionId && adjustmentId) {
        void updateStrategyAdjustmentStatus(missionId, adjustmentId, "accepted");
      }
    });
  });
  document.querySelectorAll("[data-reject-adjustment]").forEach((button) => {
    button.addEventListener("click", () => {
      const missionId = button.dataset.missionId;
      const adjustmentId = button.dataset.rejectAdjustment;
      if (missionId && adjustmentId) {
        void updateStrategyAdjustmentStatus(missionId, adjustmentId, "rejected");
      }
    });
  });
  document.querySelectorAll(".task-card").forEach((card) => {
    card.addEventListener("click", (e) => {
      if ((e.target).closest(".task-run-btn")) return;
      const taskId = card.dataset.taskId;
      if (state.selectedTaskId === taskId) {
        state.selectedTaskId = undefined;
      } else {
        state.selectedTaskId = taskId;
      }
      renderWarRoom();
    });
  });
  document.querySelectorAll("[data-run-task]").forEach((button) => {
    button.addEventListener("click", (e) => {
      e.stopPropagation();
      const missionId = button.dataset.missionId;
      const taskId = button.dataset.runTask;
      if (missionId && taskId) {
        void runTask(missionId, taskId);
      }
    });
  });
  const closeTaskDetail = document.querySelector("[data-close-task-detail]");
  if (closeTaskDetail) {
    closeTaskDetail.addEventListener("click", () => {
      state.selectedTaskId = undefined;
      renderWarRoom();
    });
  }
  const feedbackDetailsBtn = document.querySelector("[data-feedback-details]");
  if (feedbackDetailsBtn) {
    feedbackDetailsBtn.addEventListener("click", () => {
      const details = document.querySelector(".feedback-details");
      const isHidden = details?.hidden;
      if (details) {
        details.hidden = !isHidden;
        feedbackDetailsBtn.textContent = isHidden ? "收起详情" : "查看详情";
      }
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
  const hasDetails = evaluation || failure || adjustment;
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
      ${adjustment ? renderStrategyAdjustmentCard(adjustment, summary.missionId) : ""}
      ${hasDetails ? `<div class="feedback-details-toggle"><button type="button" class="feedback-details-btn" data-feedback-details>查看详情</button></div>` : ""}
      <div class="feedback-details" hidden>
        ${evaluation ? renderEvaluationDetail(evaluation) : ""}
        ${failure ? renderFailureAnalysisDetail(failure) : ""}
        ${adjustment ? renderStrategyAdjustmentDetail(adjustment) : ""}
      </div>
    </div>
  `;
}

function renderEvaluationDetail(evaluation) {
  return `
    <div class="feedback-detail-section" data-detail-type="evaluation">
      <div class="detail-section-header">
        <span>评估详情</span>
        <span class="detail-meta">${esc(evaluation.outcome)} · 贡献度 ${Math.round(evaluation.contributionScore * 100)}% · ${esc(formatTime(evaluation.createdAt))}</span>
      </div>
      <div class="detail-content">
        ${evaluation.evidence.length ? `<div class="detail-item"><strong>证据：</strong><ul>${evaluation.evidence.map(e => `<li>${esc(e)}</li>`).join("")}</ul></div>` : ""}
        ${evaluation.risks.length ? `<div class="detail-item"><strong>风险：</strong><ul>${evaluation.risks.map(r => `<li>${esc(r)}</li>`).join("")}</ul></div>` : ""}
        ${evaluation.recommendedNextActions.length ? `<div class="detail-item"><strong>建议下一步：</strong><ul>${evaluation.recommendedNextActions.map(a => `<li>${esc(a)}</li>`).join("")}</ul></div>` : ""}
      </div>
    </div>
  `;
}

function renderFailureAnalysisDetail(failure) {
  return `
    <div class="feedback-detail-section" data-detail-type="failure">
      <div class="detail-section-header">
        <span>失败分析详情</span>
        <span class="detail-meta">${esc(failure.failureType)} · ${esc(formatTime(failure.createdAt))}</span>
      </div>
      <div class="detail-content">
        <div class="detail-item"><strong>根因：</strong><p>${esc(failure.rootCause)}</p></div>
        <div class="detail-item"><strong>推荐恢复方式：</strong><span>${esc(failure.recommendedRecovery)}</span></div>
        ${failure.recommendedNextActions.length ? `<div class="detail-item"><strong>建议下一步：</strong><ul>${failure.recommendedNextActions.map(a => `<li>${esc(a)}</li>`).join("")}</ul></div>` : ""}
      </div>
    </div>
  `;
}

function renderStrategyAdjustmentDetail(adjustment) {
  return `
    <div class="feedback-detail-section" data-detail-type="strategy">
      <div class="detail-section-header">
        <span>策略提案详情</span>
        <span class="detail-meta">${esc(adjustment.status)} · ${esc(formatTime(adjustment.createdAt))}</span>
      </div>
      <div class="detail-content">
        <div class="detail-item"><strong>原策略：</strong><p>${esc(adjustment.previousStrategy)}</p></div>
        <div class="detail-item"><strong>提案策略：</strong><p>${esc(adjustment.proposedStrategy)}</p></div>
        <div class="detail-item"><strong>理由：</strong><p>${esc(adjustment.rationale)}</p></div>
        ${adjustment.affectedAgentRoles.length ? `<div class="detail-item"><strong>影响角色：</strong><span>${adjustment.affectedAgentRoles.map(r => esc(r)).join(", ")}</span></div>` : ""}
        ${adjustment.proposedTaskGoals.length ? `<div class="detail-item"><strong>提案任务目标：</strong><ul>${adjustment.proposedTaskGoals.map(g => `<li>${esc(g)}</li>`).join("")}</ul></div>` : ""}
        ${adjustment.requiresHrReview ? `<div class="detail-item"><strong>需要 HR 审核：</strong><span>是</span></div>` : ""}
      </div>
    </div>
  `;
}

function renderStrategyAdjustmentCard(adjustment, missionId) {
  const statusLabels = {
    proposed: "待审批",
    accepted: "已接受",
    rejected: "已拒绝",
    superseded: "已替代",
  };
  const statusClass = {
    proposed: "pending",
    accepted: "accepted",
    rejected: "rejected",
    superseded: "superseded",
  };
  const canRespond = adjustment.status === "proposed";
  return `
    <div class="strategy-adjustment-card">
      <div class="strategy-adjustment-header">
        <div>
          <strong>策略提案</strong>
          <span class="strategy-status ${statusClass[adjustment.status]}">${statusLabels[adjustment.status] || adjustment.status}</span>
        </div>
        <time>${esc(formatTime(adjustment.createdAt))}</time>
      </div>
      <div class="strategy-adjustment-body">
        <div class="strategy-field">
          <span class="field-label">原策略</span>
          <span class="field-value">${esc(adjustment.previousStrategy)}</span>
        </div>
        <div class="strategy-field">
          <span class="field-label">新策略</span>
          <span class="field-value proposed">${esc(adjustment.proposedStrategy)}</span>
        </div>
        <div class="strategy-field">
          <span class="field-label">理由</span>
          <span class="field-value">${esc(adjustment.rationale)}</span>
        </div>
        ${adjustment.affectedAgentRoles.length ? `
          <div class="strategy-field">
            <span class="field-label">影响角色</span>
            <span class="field-value">${esc(adjustment.affectedAgentRoles.join(", "))}</span>
          </div>
        ` : ""}
      </div>
      ${canRespond ? `
        <div class="strategy-adjustment-actions">
          <button type="button" class="strategy-btn accept" data-accept-adjustment="${esc(adjustment.id)}" data-mission-id="${esc(missionId)}">接受策略</button>
          <button type="button" class="strategy-btn reject" data-reject-adjustment="${esc(adjustment.id)}" data-mission-id="${esc(missionId)}">拒绝策略</button>
        </div>
      ` : ""}
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
  const roleClass = roleAvatarClass(agent.role);
  return `
    <article class="agent-node ${tone}" data-agent-id="${esc(agent.id)}">
      <div class="pixel-avatar ${tone} ${roleClass}" aria-hidden="true">
        <div class="hair"></div>
        <div class="face">
          <span class="eye left"></span>
          <span class="eye right"></span>
          <span class="glasses"></span>
          <span class="mouth"></span>
        </div>
        <div class="body"></div>
        ${renderRoleAccessory(agent.role)}
      </div>
      <div class="agent-card">
        <header class="agent-card-header">
          <strong class="agent-name">${esc(agent.role || shortAgentName(agent.name) || "Agent")}</strong>
          <span class="agent-status status-${esc(agent.status || "idle")}">${esc(agentStatusLabel(agent.status || "idle"))}</span>
        </header>
        <div class="agent-task">
          <span class="field-label">任务</span>
          <span class="field-value">${esc(taskTitle(data, agent.currentTaskId) || agent.responsibility || "—")}</span>
        </div>
        <div class="agent-output">
          <span class="field-label">产出</span>
          <span class="field-value">${esc(agentOutputText(data, agent) || "等待产出")}</span>
        </div>
      </div>
    </article>
  `;
}

function roleAvatarClass(role) {
  const roleLower = (role || "").toLowerCase();
  if (roleLower.includes("owner")) return "role-owner";
  if (roleLower.includes("hr")) return "role-hr";
  if (roleLower.includes("researcher")) return "role-researcher";
  if (roleLower.includes("worker") || roleLower.includes("engineer")) return "role-worker";
  return "";
}

function renderRoleAccessory(role) {
  const roleLower = (role || "").toLowerCase();
  if (roleLower.includes("hr")) {
    return '<div class="role-accessory tie"></div>';
  }
  if (roleLower.includes("worker") || roleLower.includes("engineer")) {
    return '<div class="role-accessory wrench"></div>';
  }
  return "";
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
      intro: "点击任务查看详情和执行结果。",
      items: [],
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

  if (state.warTab === "tasks") {
    const artifactByTaskId = new Map(data.artifacts.map((a) => [a.taskId, a]));
    const agentById = new Map(data.agents.map((a) => [a.id, a]));
    const sortedTasks = [...data.tasks].sort((a, b) => {
      const statusOrder = ["running", "queued", "ready", "revision_needed", "draft", "completed", "failed"];
      return statusOrder.indexOf(a.status) - statusOrder.indexOf(b.status);
    });
    return `
      <div class="tab-panel tasks-panel">
        <h1>${esc(content.title)}</h1>
        <p>${esc(content.intro)}</p>
        <div class="task-list">
          ${sortedTasks.length ? sortedTasks.map((task) => renderTaskCard(data, task, artifactByTaskId.get(task.id), agentById)).join("") : `<div class="empty-state">暂无任务</div>`}
        </div>
        ${state.selectedTaskId ? renderTaskDetailPanel(data, state.selectedTaskId, artifactByTaskId.get(state.selectedTaskId), agentById) : ""}
      </div>
    `;
  }

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

function renderTaskCard(data, task, artifact, agentById) {
  const isSelected = state.selectedTaskId === task.id;
  const assignee = task.assigneeAgentId ? agentById.get(task.assigneeAgentId) : null;
  const outputPreview = artifact ? artifactPreview(artifact) : null;
  const isRunnable = task.status === "ready" || task.status === "queued" || task.status === "revision_needed";
  const isRunning = task.status === "running";
  const isCompleted = task.status === "completed" || task.status === "failed";
  const execution = isRunning ? data.executions.find(e => e.taskId === task.id && e.status === "running") : null;
  const review = artifact ? data.reviews.find(r => r.artifactId === artifact.id) : null;

  return `
    <article class="task-card ${isSelected ? "selected" : ""}" data-task-id="${esc(task.id)}">
      <header class="task-card-header">
        <span class="task-status status-${esc(task.status)}">${esc(statusLabel(task.status))}</span>
        ${assignee ? `<span class="task-assignee">${esc(assignee.name || assignee.role)}</span>` : ""}
      </header>
      <div class="task-title">${esc(task.title)}</div>
      ${isRunning && execution ? `<div class="task-execution-status">执行中...</div>` : ""}
      ${outputPreview ? `<div class="task-output-preview">${esc(outputPreview)}</div>` : ""}
      ${isCompleted && review ? `<div class="task-review-decision review-${esc(review.decision)}">${review.decision === "approve" ? "通过" : review.decision === "revise" ? "需修改" : "拒绝"}</div>` : ""}
      ${isRunnable ? `<button type="button" class="task-run-btn" data-run-task="${esc(task.id)}" data-mission-id="${esc(task.missionId)}">执行</button>` : ""}
    </article>
  `;
}

function artifactPreview(artifact) {
  if (!artifact || !artifact.content) return null;
  const content = artifact.content;
  if (content.summary) return shortText(String(content.summary), 80);
  if (content.text) return shortText(String(content.text), 80);
  if (content.result) return shortText(String(content.result), 80);
  if (content.output) return shortText(String(content.output), 80);
  if (content.conclusion) return shortText(String(content.conclusion), 80);
  if (content.findings) {
    const findings = Array.isArray(content.findings) ? content.findings : [content.findings];
    return shortText(findings.map((f) => typeof f === "string" ? f : f.insight || JSON.stringify(f)).join("; "), 80);
  }
  if (content.data) {
    const data = typeof content.data === "string" ? content.data : JSON.stringify(content.data);
    return shortText(data, 80);
  }
  return null;
}

function renderTaskDetailPanel(data, taskId, artifact, agentById) {
  const task = data.tasks.find((t) => t.id === taskId);
  if (!task) return "";
  const assignee = task.assigneeAgentId ? agentById.get(task.assigneeAgentId) : null;
  const reviews = data.reviews.filter((r) => r.artifactId === artifact?.id);

  return `
    <div class="task-detail-panel">
      <header class="task-detail-header">
        <div>
          <h3>${esc(task.title)}</h3>
          <span class="task-status status-${esc(task.status)}">${esc(statusLabel(task.status))}</span>
        </div>
        <button type="button" class="task-detail-close" data-close-task-detail>关闭</button>
      </header>
      <dl class="task-detail-info">
        ${assignee ? `<div><dt>负责人</dt><dd>${esc(assignee.name)} · ${esc(assignee.role)}</dd></div>` : ""}
        ${task.contract?.objective ? `<div><dt>目标</dt><dd>${esc(task.contract.objective)}</dd></div>` : ""}
        ${task.failureReason ? `<div class="task-failure"><dt>失败原因</dt><dd>${esc(task.failureReason)}</dd></div>` : ""}
      </dl>
      ${artifact ? renderArtifactDetail(artifact, reviews) : "<p class=\"task-no-output\">暂无产出</p>"}
    </div>
  `;
}

function renderArtifactDetail(artifact, reviews) {
  const quality = artifact.qualityScore != null ? Math.round(artifact.qualityScore * 100) : null;
  return `
    <div class="artifact-detail">
      <h4>产出内容</h4>
      ${quality != null ? `<div class="artifact-quality"><span>质量评分</span><strong>${quality}%</strong></div>` : ""}
      <div class="artifact-content">
        ${formatArtifactContent(artifact.content)}
      </div>
      ${artifact.sources?.length ? `<div class="artifact-sources"><h5>来源</h5>${artifact.sources.map((s) => renderSource(s)).join("")}</div>` : ""}
      ${artifact.evidence?.length ? `<div class="artifact-evidence"><h5>证据</h5>${artifact.evidence.map((e) => `<span>${esc(e)}</span>`).join("")}</div>` : ""}
      ${reviews.length ? `<div class="artifact-reviews"><h5>审核结果</h5>${reviews.map((r) => `<div class="review-item"><span class="review-decision review-${esc(r.decision)}">${r.decision === "approve" ? "通过" : r.decision === "revise" ? "需修改" : "拒绝"}</span><p>${esc(r.comments.join(" "))}</p></div>`).join("")}</div>` : ""}
    </div>
  `;
}

function renderSource(source) {
  if (!source) return "";
  const url = source.url || "";
  const title = source.title || source.searchKeyword || url || "来源";
  const snippet = source.snippet || "";
  if (url) {
    return `<div class="source-item"><a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(title)}</a>${snippet ? `<p class="source-snippet">${esc(snippet)}</p>` : ""}</div>`;
  }
  return `<div class="source-item"><span>${esc(title)}</span>${snippet ? `<p class="source-snippet">${esc(snippet)}</p>` : ""}</div>`;
}

function formatArtifactContent(content) {
  if (!content) return "<p>无内容</p>";
  if (content.summary) return `<p>${esc(content.summary)}</p>`;
  if (content.text) return `<p>${esc(content.text)}</p>`;
  if (content.result) return `<p>${esc(content.result)}</p>`;
  if (content.output) return `<p>${esc(content.output)}</p>`;
  if (content.conclusion) return `<p>${esc(content.conclusion)}</p>`;
  if (content.findings) {
    const findings = Array.isArray(content.findings) ? content.findings : [content.findings];
    return findings.map((f) => {
      if (typeof f === "string") return `<p>${esc(f)}</p>`;
      return `<p>${esc(f.insight || JSON.stringify(f))}</p>`;
    }).join("");
  }
  if (content.data) {
    const data = typeof content.data === "string" ? content.data : JSON.stringify(content.data, null, 2);
    return `<pre>${esc(data)}</pre>`;
  }
  return `<p>${esc(JSON.stringify(content))}</p>`;
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
