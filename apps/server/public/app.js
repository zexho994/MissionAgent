const state = {
  snapshot: emptySnapshot(),
  config: undefined,
  selectedMissionId: undefined,
  draftMode: false,
  view: "home",
  warTab: "overview",
  popoverOpen: false,
  streamingMissionId: undefined,
  pollingInterval: undefined,
  automationSummaryByMissionId: {},
  feedbackSummaryByMissionId: {},
  strategyAdjustmentsByMissionId: {},
  autopilotDiagnosisByMissionId: {},
  scheduleRulesByMissionId: {},
  scheduleActionPending: false,
  scheduleFormOpen: false,
  scheduleError: "",
  planActionMissionId: undefined,
  planUiByMissionId: {},
};

const $ = (id) => document.getElementById(id);

function emptySnapshot() {
  return {
    missions: [],
    plans: [],
    tasks: [],
    artifacts: [],
    reviews: [],
    executions: [],
    agents: [],
    agentMessages: [],
    threads: [],
    taskEvents: [],
    scheduleTriggerEvents: [],
    toolCalls: [],
    decisions: [],
    agentRelations: [],
    knowledgeEntries: [],
    missionOutcomeEvaluations: [],
    taskFailureAnalyses: [],
    strategyAdjustments: [],
  };
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const json = await response.json();
  if (!response.ok) throw new Error(json.error || `HTTP ${response.status}`);
  return json;
}

async function loadAutomationState(missionId) {
  if (!missionId) return;
  const [summaryResult, scheduleResult] = await Promise.all([
    api(`/api/missions/${missionId}/automation-summary`),
    api(`/api/missions/${missionId}/schedule`),
  ]);
  state.automationSummaryByMissionId[missionId] = summaryResult.summary;
  state.scheduleRulesByMissionId[missionId] = scheduleResult.rules;
}

async function loadFeedbackState(missionId) {
  if (!missionId) return;
  const result = await api(`/api/missions/${missionId}/feedback-summary`);
  state.feedbackSummaryByMissionId[missionId] = result.summary;
}

async function loadStrategyAdjustments(missionId) {
  if (!missionId) return;
  const result = await api(`/api/missions/${missionId}/feedback/strategy-adjustments`);
  state.strategyAdjustmentsByMissionId[missionId] = result.strategyAdjustments || [];
}

async function loadAutopilotDiagnosis(missionId) {
  if (!missionId) return;
  const result = await api(`/api/missions/${missionId}/autopilot-diagnosis`);
  state.autopilotDiagnosisByMissionId[missionId] = result.diagnosis;
}

async function refreshMissionAutomation() {
  const mission = currentMission();
  if (!mission) return;
  await loadAutomationState(mission.id);
  await loadFeedbackState(mission.id);
  await loadStrategyAdjustments(mission.id);
  await loadAutopilotDiagnosis(mission.id);
}

async function triggerNextSchedule(missionId) {
  state.scheduleActionPending = true;
  state.scheduleError = "";
  renderAll();
  try {
    const result = await api(`/api/missions/${missionId}/schedule/trigger-next`, { method: "POST", body: {} });
    state.snapshot = result.snapshot;
    await loadAutomationState(missionId);
  } catch (error) {
    state.scheduleError = error instanceof Error ? error.message : String(error);
  } finally {
    state.scheduleActionPending = false;
    renderAll();
  }
}

async function pauseAutomation(missionId) {
  state.scheduleActionPending = true;
  state.scheduleError = "";
  renderAll();
  try {
    const result = await api(`/api/missions/${missionId}/schedule/pause`, { method: "POST", body: {} });
    state.snapshot = result.snapshot;
    state.automationSummaryByMissionId[missionId] = result.summary;
    await loadAutomationState(missionId);
  } catch (error) {
    state.scheduleError = error instanceof Error ? error.message : String(error);
  } finally {
    state.scheduleActionPending = false;
    renderAll();
  }
}

async function resumeAutomation(missionId) {
  state.scheduleActionPending = true;
  state.scheduleError = "";
  renderAll();
  try {
    const result = await api(`/api/missions/${missionId}/schedule/resume`, { method: "POST", body: {} });
    state.snapshot = result.snapshot;
    state.automationSummaryByMissionId[missionId] = result.summary;
    await loadAutomationState(missionId);
  } catch (error) {
    state.scheduleError = error instanceof Error ? error.message : String(error);
  } finally {
    state.scheduleActionPending = false;
    renderAll();
  }
}

async function createScheduleTemplate(missionId, payload, runNow) {
  state.scheduleActionPending = true;
  state.scheduleError = "";
  renderAll();
  try {
    const result = await api(`/api/missions/${missionId}/schedule/templates`, { method: "POST", body: payload });
    state.snapshot = result.snapshot;
    if (runNow) {
      const trigger = await api(`/api/missions/${missionId}/schedule/${result.rule.id}/trigger`, { method: "POST", body: {} });
      state.snapshot = trigger.snapshot || state.snapshot;
    }
    await loadAutomationState(missionId);
    state.scheduleFormOpen = false;
  } catch (error) {
    state.scheduleError = error instanceof Error ? error.message : String(error);
  } finally {
    state.scheduleActionPending = false;
    renderAll();
  }
}

async function refresh() {
  state.config = await api("/api/config");
  const health = await api("/api/health");
  const version = health.openclaw.version || "unknown";
  $("openclaw-status").textContent = health.openclaw.available
    ? (version.startsWith("OpenClaw") ? version : `OpenClaw ${version}`)
    : "OpenClaw 不可用";
  $("openclaw-dot").classList.toggle("ok", Boolean(health.openclaw.available));

  state.snapshot = await api("/api/snapshot");
  syncSelectedMission();
  if (state.view === "mission" && currentMission()) {
    await refreshMissionAutomation();
  }
  renderAll();
}

function syncSelectedMission() {
  const missions = state.snapshot.missions;
  if (missions.length === 0) {
    state.selectedMissionId = undefined;
    state.draftMode = true;
    state.view = "home";
    return;
  }
  if (!state.draftMode && (!state.selectedMissionId || !missions.some((mission) => mission.id === state.selectedMissionId))) {
    state.selectedMissionId = missions.at(-1).id;
  }
}

function currentMission() {
  if (state.draftMode) return undefined;
  return state.snapshot.missions.find((mission) => mission.id === state.selectedMissionId);
}

function currentMissionPlan() {
  const mission = currentMission();
  if (!mission) return undefined;
  const latestDraft = [...state.snapshot.plans]
    .filter((plan) => plan.missionId === mission.id && plan.status === "draft")
    .sort((a, b) => b.revision - a.revision)[0];
  if (latestDraft) return latestDraft;
  if (!mission.confirmedPlanId) return undefined;
  return state.snapshot.plans.find((plan) => plan.id === mission.confirmedPlanId);
}

function isPlanPending() {
  const mission = currentMission();
  return Boolean(mission && state.planActionMissionId === mission.id);
}

function planUiState(missionId) {
  if (!state.planUiByMissionId[missionId]) {
    state.planUiByMissionId[missionId] = {
      revisionOpen: false,
      revisionFeedback: "",
      error: "",
    };
  }
  return state.planUiByMissionId[missionId];
}

function currentPlanUiState() {
  const mission = currentMission();
  if (!mission) {
    return {
      revisionOpen: false,
      revisionFeedback: "",
      error: "",
    };
  }
  return planUiState(mission.id);
}

function scoped() {
  const mission = currentMission();
  if (!mission) {
    return {
      mission: undefined,
      tasks: [],
      artifacts: [],
      reviews: [],
      executions: [],
      agents: [],
      messages: [],
      threads: [],
      events: [],
      toolCalls: [],
      decisions: [],
      relations: [],
    };
  }
  const tasks = state.snapshot.tasks.filter((task) => task.missionId === mission.id);
  const taskIds = new Set(tasks.map((task) => task.id));
  const executions = state.snapshot.executions.filter((execution) => execution.missionId === mission.id);
  const artifacts = state.snapshot.artifacts.filter((artifact) => taskIds.has(artifact.taskId));
  const reviews = state.snapshot.reviews.filter((review) => artifacts.some((artifact) => artifact.id === review.artifactId));
  return {
    mission,
    tasks,
    artifacts,
    reviews,
    executions,
    agents: state.snapshot.agents.filter((agent) => agent.missionId === mission.id),
    messages: state.snapshot.agentMessages.filter((message) => message.missionId === mission.id),
    threads: (state.snapshot.threads || []).filter((thread) => thread.missionId === mission.id),
    relations: (state.snapshot.agentRelations || []).filter((relation) => relation.missionId === mission.id),
    events: state.snapshot.taskEvents.filter((event) => event.missionId === mission.id),
    toolCalls: state.snapshot.toolCalls.filter((call) => call.missionId === mission.id),
    decisions: state.snapshot.decisions.filter((decision) => decision.missionId === mission.id),
  };
}

function renderAll() {
  renderMissionPopover();
  if (state.view === "mission" && currentMission()) {
    renderWarRoom();
  } else {
    state.view = "home";
    renderHome();
  }
}

function renderMissionPopover() {
  const button = $("mission-button");
  const popover = $("mission-popover");
  button.setAttribute("aria-expanded", String(state.popoverOpen));
  popover.hidden = !state.popoverOpen;

  if (state.snapshot.missions.length === 0) {
    popover.innerHTML = `<div class="empty-state">还没有 Mission。先和 Owner 对话生成一个。</div>`;
    return;
  }

  popover.innerHTML = `
    <div class="popover-head">正在运行的 Mission</div>
    <div class="mission-list">
      ${state.snapshot.missions.map((mission) => missionMenuItem(mission)).join("")}
    </div>
  `;

  popover.querySelectorAll("[data-select-mission]").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedMissionId = button.dataset.selectMission;
      state.draftMode = false;
      const hasTasks = state.snapshot.tasks.some((task) => task.missionId === state.selectedMissionId);
      state.view = hasTasks ? "mission" : "home";
      state.popoverOpen = false;
      renderAll();
    });
  });
}

function missionMenuItem(mission) {
  const tasks = state.snapshot.tasks.filter((task) => task.missionId === mission.id);
  const executions = state.snapshot.executions.filter((execution) => execution.missionId === mission.id);
  const selected = mission.id === state.selectedMissionId;
  return `
    <button class="mission-card ${selected ? "selected" : ""}" data-select-mission="${esc(mission.id)}" type="button">
      <strong>${esc(shortText(mission.goal, 46))}</strong>
      <span>${missionStateText(executions)} · ${tasks.length} 个任务</span>
    </button>
  `;
}

function renderHome() {
  const data = scoped();
  $("app-view").innerHTML = `
    <section class="home-page">
      <div class="conversation-area">
        <div id="chat-stream" class="chat-stream">
          ${renderChatContent(data)}
        </div>
        <form id="mission-form" class="composer">
          <textarea id="goal" rows="4" placeholder="${esc(uiConfig().emptyPrompt)}">${esc(defaultGoal(data))}</textarea>
          <button type="submit">${data.mission ? "补充给 Owner" : "发送给 Owner"}</button>
        </form>
      </div>
    </section>
  `;
  setTimeout(bindChoiceButtons, 0);
}

function renderChatContent(data) {
  if (!data.mission) {
    return `
      <div class="bubble owner">
        <p>你不用先写成功指标和约束。只要告诉我目标，我会分析缺口、追问必要细节，并生成 Mission 团队。</p>
        <div class="choice-row">
          ${uiConfig().starterPrompts.map((prompt) => `<button type="button" data-fill="${esc(prompt.value)}">${esc(prompt.label)}</button>`).join("")}
        </div>
      </div>
    `;
  }

  const parts = [];

  parts.push(`
    <div class="bubble user">
      <p>${esc(data.mission.goal)}</p>
    </div>
  `);

  const conversationMessages = data.messages.filter(
    (message) => message.type === "owner_followup" || message.type === "user_message" || message.type === "mission_brief"
  ).sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

  // Track if we've rendered the brief to avoid duplicates
  let briefRendered = false;
  for (const message of conversationMessages) {
    if (message.type === "mission_brief") {
      // Only render brief once - the first mission_brief message
      if (!briefRendered) {
        parts.push(renderBriefMessage(data));
        briefRendered = true;
      }
    } else {
      parts.push(renderConversationMessage(message));
    }
  }

  // Collect options from the latest owner_followup message only
  const ownerFollowupsWithOptions = conversationMessages
    .filter((message) => message.type === "owner_followup" && message.options && message.options.length > 0);
  const latestOwnerMessageWithOptions = ownerFollowupsWithOptions.length > 0
    ? ownerFollowupsWithOptions[ownerFollowupsWithOptions.length - 1]
    : null;
  const latestOptions = latestOwnerMessageWithOptions?.options || [];

  // Only show options if the latest owner question hasn't been answered yet
  // Find latest owner_followup with options and check if there's a user message after it
  const latestOwnerWithOptions = [...conversationMessages]
    .reverse()
    .find((m) => m.type === "owner_followup" && m.options && m.options.length > 0);
  const latestUserMessage = [...conversationMessages]
    .reverse()
    .find((m) => m.type === "user_message");
  const hasUserRespondedToLatestQuestion = latestOwnerWithOptions && latestUserMessage &&
    new Date(latestUserMessage.createdAt) > new Date(latestOwnerWithOptions.createdAt);

  const ownerThinking = isOwnerThinking();
  if (!data.mission.brief && ownerThinking) {
    parts.push(`
      <div class="bubble owner thinking">
        <p>${conversationMessages.length === 0 ? "正在分析你的目标..." : "正在思考你的回复..."}</p>
      </div>
    `);
  }

  if (data.mission.brief && !data.mission.briefConfirmed) {
    parts.push(`
      <div class="choice-row" style="margin-top: 12px;">
        <button type="button" data-confirm-brief>确认 MissionBrief 并继续</button>
        <button type="button" data-append="我想修改一些内容">需要修改</button>
      </div>
    `);
  }

  // Render latest owner_followup options as choice buttons at the bottom
  // Only show options if user hasn't responded to the latest question
  if (latestOptions.length > 0 && !hasUserRespondedToLatestQuestion) {
    parts.push(`
      <div class="confirm-grid" style="margin-top: 12px;">
        ${latestOptions.map((option) => `
          <button type="button" class="choice-option" data-fill-choice="${esc(option.value)}">${esc(option.value)}</button>
        `).join("")}
      </div>
    `);
  }

  if (data.mission.briefConfirmed) {
    parts.push(renderMissionPlanReview(data));
  }

  return parts.join("");
}

function renderBriefMessage(data) {
  const brief = data.mission.brief;
  if (!brief) return "";
  return `
    <div class="bubble owner brief">
      <strong>Owner Agent · MissionBrief</strong>
      <div class="brief-summary">
        <div><span>目标</span>${esc(brief.goal)}</div>
        <div><span>范围</span>${esc(brief.scope)}</div>
        ${brief.targetAudience ? `<div><span>目标人群</span>${esc(brief.targetAudience)}</div>` : ""}
        ${brief.timeline ? `<div><span>时间线</span>${esc(brief.timeline)}</div>` : ""}
      </div>
      <div class="brief-metrics">
        <strong>成功指标</strong>
        ${brief.successMetrics.map((item) => `<div>${esc(item)}</div>`).join("")}
      </div>
      <div class="brief-constraints">
        <strong>约束</strong>
        ${brief.constraints.map((item) => `<div>${esc(item)}</div>`).join("")}
      </div>
    </div>
  `;
}

function renderMissionPlanReview(data) {
  const plan = currentMissionPlan();
  const pending = isPlanPending();
  const planUi = currentPlanUiState();
  const error = planUi.error ? `<p class="plan-error">${esc(planUi.error)}</p>` : "";
  if (!plan) {
    const legacyWarRoomAction = data.tasks.length > 0 ? `
        <div class="choice-row">
          <button type="button" data-open-existing-war-room ${pending ? "disabled" : ""}>进入作战室</button>
        </div>
      ` : "";
    return `
      <div class="mission-plan-card">
        <strong>Owner Agent · MissionPlan</strong>
        ${error}
        <button type="button" data-generate-plan ${pending ? "disabled" : ""}>${pending ? "正在生成计划..." : "生成执行计划"}</button>
        ${legacyWarRoomAction}
      </div>
    `;
  }

  return `
    <div class="mission-plan-card">
      <strong>Owner Agent · MissionPlan</strong>
      <div class="plan-summary">
        <div><span>目标</span>${esc(plan.goal)}</div>
        <div><span>状态</span>${plan.status === "confirmed" ? "已确认" : `草稿 v${esc(String(plan.revision))}`}</div>
      </div>
      <div class="plan-section">
        <strong>阶段</strong>
        ${plan.phases.map((phase) => `<p>${esc(phase.name)}：${esc(phase.objective)}</p>`).join("")}
      </div>
      <div class="plan-section">
        <strong>工作流</strong>
        ${plan.workstreams.map((stream) => `<p>${esc(stream.requiredRole)}：${esc(stream.firstTaskGoal)}</p>`).join("")}
      </div>
      <div class="plan-section">
        <strong>节奏</strong>
        ${plan.scheduleRhythms.map((rhythm) => `<p>${esc(rhythm.name)} · ${esc(rhythm.cadence)} · ${esc(rhythm.ownerRole)}</p>`).join("")}
      </div>
      ${error}
      ${plan.status === "draft" ? `
        <div class="choice-row">
          <button type="button" data-confirm-plan="${esc(plan.id)}" ${pending ? "disabled" : ""}>确认 MissionPlan</button>
          <button type="button" data-toggle-plan-revision ${pending ? "disabled" : ""}>提出修改建议</button>
        </div>
        ${planUi.revisionOpen ? `
          <div class="plan-revision-box">
            <textarea id="plan-revision-feedback" rows="3" placeholder="修改建议">${esc(planUi.revisionFeedback)}</textarea>
            <button type="button" data-submit-plan-revision="${esc(plan.id)}" ${pending ? "disabled" : ""}>重新生成计划</button>
          </div>
        ` : ""}
      ` : `
        <div class="choice-row">
          <button type="button" data-open-war-room ${pending ? "disabled" : ""}>${data.tasks.length > 0 ? "进入作战室" : "创建作战室"}</button>
        </div>
      `}
    </div>
  `;
}

function renderConversationMessage(message) {
  const isUser = message.type === "user_message";
  // For owner messages with options, show full content so user sees the question
  // For owner messages without options, also show full content
  const content = isUser ? message.content : message.content;
  if (!content.trim()) return "";
  return `
    <div class="bubble ${isUser ? "user" : "owner"}">
      <p>${esc(content)}</p>
    </div>
  `;
}

function renderConfirmPanel(data) {
  if (!data.mission) {
    return "";
  }

  // Check if the latest owner message has options
  const conversationMessages = data.messages.filter(
    (message) => message.type === "owner_followup" || message.type === "user_message" || message.type === "mission_brief"
  );
  const latestOwnerMessage = [...conversationMessages].reverse().find(
    (message) => message.type === "owner_followup"
  );

  if (latestOwnerMessage && latestOwnerMessage.options && latestOwnerMessage.options.length > 0) {
    return `
      <strong>${esc(ownerQuestionText(latestOwnerMessage.content) || "选择回复或输入自定义内容")}</strong>
      <div class="confirm-grid">
        ${latestOwnerMessage.options.map((option) => `
          <button type="button" class="choice-option" data-fill-choice="${esc(option.value)}">${esc(option.value)}</button>
        `).join("")}
      </div>
    `;
  }

  return "";
}

function ownerBodyText(content) {
  const text = String(content || "").trim();
  const questionMarkIndex = Math.max(text.lastIndexOf("？"), text.lastIndexOf("?"));
  if (questionMarkIndex === -1) return text;
  const beforeQuestion = text.slice(0, questionMarkIndex + 1);
  const sentenceStart = Math.max(
    beforeQuestion.lastIndexOf("。", beforeQuestion.length - 2),
    beforeQuestion.lastIndexOf("！", beforeQuestion.length - 2),
    beforeQuestion.lastIndexOf("!", beforeQuestion.length - 2),
    beforeQuestion.lastIndexOf(".", beforeQuestion.length - 2),
  );
  return text.slice(0, sentenceStart + 1).trim();
}

function ownerQuestionText(content) {
  const text = String(content || "").trim();
  const questionMarkIndex = Math.max(text.lastIndexOf("？"), text.lastIndexOf("?"));
  if (questionMarkIndex === -1) return "";
  const beforeQuestion = text.slice(0, questionMarkIndex + 1);
  const sentenceStart = Math.max(
    beforeQuestion.lastIndexOf("。", beforeQuestion.length - 2),
    beforeQuestion.lastIndexOf("！", beforeQuestion.length - 2),
    beforeQuestion.lastIndexOf("!", beforeQuestion.length - 2),
    beforeQuestion.lastIndexOf(".", beforeQuestion.length - 2),
  );
  return beforeQuestion.slice(sentenceStart + 1).replace(/\s+/g, " ").trim();
}

function bindChoiceButtons() {
  document.querySelectorAll("[data-fill]").forEach((button) => {
    button.addEventListener("click", () => {
      $("goal").value = button.dataset.fill;
      $("goal").focus();
    });
  });
  document.querySelectorAll("[data-append]").forEach((button) => {
    button.addEventListener("click", () => {
      $("goal").value = `${currentMission()?.goal || ""}，${button.dataset.append}`;
      $("goal").focus();
    });
  });
  document.querySelectorAll("[data-fill-choice]").forEach((button) => {
    button.addEventListener("click", () => {
      const choiceValue = button.dataset.fillChoice;
      const mission = currentMission();
      if (!mission || !choiceValue) return;

      // Fill and auto-submit
      $("goal").value = choiceValue;
      const form = $("mission-form");
      if (form) {
        form.dispatchEvent(new Event('submit'));
      }
    });
  });
  document.querySelectorAll("[data-generate-plan]").forEach((button) => {
    button.addEventListener("click", async () => {
      const mission = currentMission();
      if (!mission) return;
      state.planActionMissionId = mission.id;
      planUiState(mission.id).error = "";
      renderAll();
      try {
        const result = await api(`/api/missions/${mission.id}/plan/generate`, { method: "POST", body: {} });
        state.snapshot = result.snapshot;
        const planUi = planUiState(mission.id);
        planUi.revisionOpen = false;
        planUi.revisionFeedback = "";
      } catch (error) {
        planUiState(mission.id).error = error instanceof Error ? error.message : String(error);
      } finally {
        state.planActionMissionId = undefined;
        renderAll();
      }
    });
  });
  document.querySelectorAll("[data-confirm-plan]").forEach((button) => {
    button.addEventListener("click", async () => {
      const mission = currentMission();
      if (!mission) return;
      const planId = button.getAttribute("data-confirm-plan");
      if (!planId) throw new Error("Missing MissionPlan id");
      state.planActionMissionId = mission.id;
      planUiState(mission.id).error = "";
      renderAll();
      try {
        const result = await api(`/api/missions/${mission.id}/plan/confirm`, { method: "POST", body: { planId } });
        state.snapshot = result.snapshot;
        await loadAutopilotDiagnosis(mission.id);
      } catch (error) {
        planUiState(mission.id).error = error instanceof Error ? error.message : String(error);
      } finally {
        state.planActionMissionId = undefined;
        renderAll();
      }
    });
  });
  document.querySelectorAll("[data-toggle-plan-revision]").forEach((button) => {
    button.addEventListener("click", () => {
      const mission = currentMission();
      if (!mission) return;
      const planUi = planUiState(mission.id);
      planUi.revisionOpen = !planUi.revisionOpen;
      renderAll();
    });
  });
  const revisionTextarea = $("plan-revision-feedback");
  if (revisionTextarea) {
    revisionTextarea.addEventListener("input", (event) => {
      const mission = currentMission();
      if (!mission) return;
      planUiState(mission.id).revisionFeedback = event.target.value;
    });
  }
  document.querySelectorAll("[data-submit-plan-revision]").forEach((button) => {
    button.addEventListener("click", async () => {
      const mission = currentMission();
      if (!mission) return;
      const planUi = planUiState(mission.id);
      const feedback = planUi.revisionFeedback.trim();
      if (!feedback) {
        planUi.error = "请输入修改建议。";
        renderAll();
        return;
      }
      state.planActionMissionId = mission.id;
      planUi.error = "";
      renderAll();
      try {
        const result = await api(`/api/missions/${mission.id}/plan/generate`, { method: "POST", body: { feedback } });
        state.snapshot = result.snapshot;
        planUi.revisionOpen = false;
        planUi.revisionFeedback = "";
      } catch (error) {
        planUi.error = error instanceof Error ? error.message : String(error);
      } finally {
        state.planActionMissionId = undefined;
        renderAll();
      }
    });
  });
  document.querySelectorAll("[data-open-war-room]").forEach((button) => {
    button.addEventListener("click", async () => {
      const mission = currentMission();
      if (!mission) return;
      if (scoped().tasks.length === 0) {
        state.planActionMissionId = mission.id;
        planUiState(mission.id).error = "";
        renderAll();
        try {
          const result = await api("/api/missions/activate-async", {
            method: "POST",
            body: { missionId: mission.id },
          });
          state.snapshot = result.snapshot;
          state.view = "mission";
          state.draftMode = false;
          state.warTab = "overview";
          await loadAutomationState(mission.id);
          await loadFeedbackState(mission.id);
          await loadStrategyAdjustments(mission.id);
          await loadAutopilotDiagnosis(mission.id);
          renderAll();
          startPolling();
        } catch (error) {
          planUiState(mission.id).error = `作战室创建失败：${error instanceof Error ? error.message : String(error)}`;
          renderAll();
        } finally {
          state.planActionMissionId = undefined;
          renderAll();
        }
        return;
      }
      state.view = "mission";
      state.draftMode = false;
      await loadAutomationState(mission.id);
      await loadFeedbackState(mission.id);
      await loadStrategyAdjustments(mission.id);
      await loadAutopilotDiagnosis(mission.id);
      renderAll();
    });
  });
  document.querySelectorAll("[data-open-existing-war-room]").forEach((button) => {
    button.addEventListener("click", async () => {
      const mission = currentMission();
      if (!mission) return;
      if (scoped().tasks.length === 0) {
        planUiState(mission.id).error = "请先生成并确认 MissionPlan。";
        renderAll();
        return;
      }
      state.view = "mission";
      state.draftMode = false;
      state.warTab = "overview";
      await loadAutomationState(mission.id);
      await loadFeedbackState(mission.id);
      await loadAutopilotDiagnosis(mission.id);
      renderAll();
    });
  });
  document.querySelectorAll("[data-confirm-brief]").forEach((button) => {
    button.addEventListener("click", async () => {
      const mission = currentMission();
      if (!mission) return;
      const result = await api("/api/missions/confirm-brief", {
        method: "POST",
        body: { missionId: mission.id },
      });
      state.snapshot = result.snapshot;
      renderAll();
    });
  });
  const ownerThinking = isOwnerThinking();
  const form = $("mission-form");
  if (form) {
    const submitBtn = form.querySelector("button[type=submit]");
    if (submitBtn) {
      submitBtn.disabled = ownerThinking;
      submitBtn.textContent = ownerThinking ? "Owner 正在思考..." : (currentMission() ? "补充给 Owner" : "发送给 Owner");
    }
  }
}

function defaultGoal(data) {
  return data.mission ? "" : "";
}

function taskTitle(data, taskId) {
  return data.tasks.find((task) => task.id === taskId)?.title;
}

function agentOutputText(data, agent) {
  if (agent.role.includes("review")) {
    const review = data.reviews.at(-1);
    return review ? `${review.decision}: ${review.comments[0] || "已完成审核"}` : "";
  }
  if (agent.role === "hr") {
    const message = data.messages.filter((item) => {
      return agent.id === item.fromAgentId
        && item.type === "team_created"
        && !item.content.includes("正在分析 MissionBrief");
    }).at(-1);
    return message?.content;
  }
  if (/worker|creator|operator|engineer|content|image|research/.test(agent.role)) {
    const artifact = data.artifacts.at(-1);
    return artifact ? `Artifact ${artifact.id.slice(-6)}` : "";
  }
  const message = data.messages.filter((item) => {
    return agent.id === item.fromAgentId;
  }).at(-1);
  return message?.content;
}

function toneClass(index) {
  return `tone-${index % 6}`;
}

function uiConfig() {
  if (!state.config?.ui) {
    throw new Error("UI config is not loaded");
  }
  return state.config.ui;
}

function isOwnerThinking() {
  const data = scoped();
  if (!data.mission) return false;
  const owner = data.agents.find((agent) => agent.role === "owner");
  return owner?.status === "thinking";
}

function shortAgentName(name) {
  return String(name).replace(/\s*Agent$/i, "");
}

function nextTaskText(data) {
  if (data.tasks.length === 0 && data.agents.some((agent) => agent.role === "hr" && agent.status === "running")) {
    return "HR 正在分析 MissionBrief 并招募团队。";
  }
  const runningTask = data.tasks.find((task) => task.status === "running");
  if (runningTask) return runningTask.title;
  const revisionTask = data.tasks.find((task) => task.status === "revision_needed");
  if (revisionTask) return `等待修正：${revisionTask.title}`;
  return data.tasks.at(-1)?.title || "Owner 正在补齐 Mission 定义。";
}

function latestOutputText(data) {
  const hrMessage = [...data.messages].reverse().find((message) => message.type === "team_created");
  if (hrMessage) return hrMessage.content;
  const review = data.reviews.at(-1);
  if (review) return `${review.decision}: ${review.comments[0] || "已完成审核"}`;
  const artifact = data.artifacts.at(-1);
  if (artifact) return `已生成产物：${artifact.type}`;
  const message = data.messages.at(-1);
  return message?.content || "等待第一个阶段产出。";
}

function outputItems(data) {
  const artifactItems = data.artifacts.map((artifact) => `产物：${artifact.type} · 质量分 ${Math.round(artifact.qualityScore * 100)}`);
  const reviewItems = data.reviews.map((review) => `审核：${review.decision} · ${review.comments[0] || "无补充说明"}`);
  return [...artifactItems, ...reviewItems];
}

function missionStateText(executions) {
  if (executions.some((execution) => execution.status === "running")) return "执行中";
  if (executions.some((execution) => execution.status === "completed")) return "已产出";
  if (executions.some((execution) => execution.status === "failed")) return "执行失败";
  return "规划中";
}

document.addEventListener("submit", async (event) => {
  if (!(event.target instanceof HTMLFormElement) || event.target.id !== "mission-form") return;
  event.preventDefault();
  const goal = $("goal").value.trim();
  if (!goal) return;
  const mission = currentMission();
  const result = mission
    ? await api("/api/missions/continue", {
      method: "POST",
      body: { missionId: mission.id, message: goal },
    })
    : await api("/api/missions", {
      method: "POST",
      body: { goal },
    });
  state.selectedMissionId = result.mission.id;
  state.snapshot = result.snapshot;
  state.draftMode = false;
  state.view = "home";
  state.warTab = "overview";
  renderAll();

  // Start SSE streaming
  const chatStream = $('chat-stream');
  if (chatStream) {
    streamOwnerResponse(result.mission.id, chatStream);
    startPolling();
  }
});

$("home-button").addEventListener("click", () => {
  state.view = "home";
  state.popoverOpen = false;
  stopPolling();
  renderAll();
});

$("new-chat-button").addEventListener("click", () => {
  state.selectedMissionId = undefined;
  state.draftMode = true;
  state.view = "home";
  state.popoverOpen = false;
  stopPolling();
  renderAll();
});

$("mission-button").addEventListener("click", (event) => {
  event.stopPropagation();
  state.popoverOpen = !state.popoverOpen;
  renderMissionPopover();
});

$("refresh").addEventListener("click", () => {
  refresh().catch(showTopbarError);
});

document.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof Node)) return;
  if (!$("mission-popover").contains(target) && !$("mission-button").contains(target)) {
    if (state.popoverOpen) {
      state.popoverOpen = false;
      renderMissionPopover();
    }
  }
});

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function shortText(value, length) {
  const text = String(value ?? "");
  return text.length > length ? `${text.slice(0, length)}...` : text;
}

function statusLabel(status) {
  const map = { draft: "草稿", ready: "就绪", queued: "排队", running: "执行中", revision_needed: "需修改", completed: "完成", failed: "失败" };
  return map[status] || status;
}

function agentStatusLabel(status) {
  const map = { idle: "空闲", thinking: "思考", running: "运行", blocked: "阻塞", done: "完成" };
  return map[status] || status;
}

function showTopbarError(error) {
  $("openclaw-status").textContent = error instanceof Error ? error.message : String(error);
  $("openclaw-dot").classList.remove("ok");
}

async function streamOwnerResponse(missionId, container) {
  if (state.streamingMissionId === missionId) return;

  state.streamingMissionId = missionId;
  const eventSource = new EventSource(`/api/missions/${missionId}/stream`);

  // Try to find the thinking bubble, but don't close SSE if it doesn't exist yet
  // The 'done' event will still trigger refresh() to update the UI
  let responseBubble = container.querySelector('.owner.thinking');
  let contentEl = responseBubble?.querySelector('p');

  // Set initial cursor if thinking bubble exists at start
  if (contentEl && !contentEl.querySelector('.streaming-cursor')) {
    contentEl.innerHTML = '<span class="streaming-cursor">▋</span>' + contentEl.textContent;
  }

  eventSource.addEventListener('message', (event) => {
    try {
      const data = JSON.parse(event.data);

      if (data.error) {
        console.error('[SSE] Error:', data.error);
        eventSource.close();
        state.streamingMissionId = undefined;
        return;
      }

      if (data.type === 'token' && data.content) {
        // If we haven't found the thinking bubble yet, try again (DOM might have updated)
        if (!responseBubble || !contentEl) {
          responseBubble = container.querySelector('.owner.thinking');
          contentEl = responseBubble?.querySelector('p');
        }

        if (contentEl) {
          hasReceivedToken = true;
          const cursor = contentEl.querySelector('.streaming-cursor');
          const text = contentEl.textContent.replace('▋', '') + data.content;
          contentEl.innerHTML = esc(text) + '<span class="streaming-cursor">▋</span>';
          const chatStream = $('chat-stream');
          if (chatStream) chatStream.scrollTop = chatStream.scrollHeight;
        }
      }

      if (data.type === 'done') {
        eventSource.close();
        state.streamingMissionId = undefined;
        if (contentEl) {
          const cursor = contentEl.querySelector('.streaming-cursor');
          if (cursor) cursor.remove();
        }

        setTimeout(async () => {
          await refresh();
        }, 500);
      }
    } catch (error) {
      console.error('[SSE] Parse error:', error);
    }
  });

  eventSource.addEventListener('error', (error) => {
    console.error('[SSE] Connection error:', error);
    eventSource.close();
    state.streamingMissionId = undefined;
    const cursor = contentEl.querySelector('.streaming-cursor');
    if (cursor) cursor.remove();
  });
}

function startPolling() {
  if (state.pollingInterval) return;

  state.pollingInterval = setInterval(async () => {
    try {
      const snapshot = await api('/api/snapshot');
      const currentData = scoped();
      const newSnapshot = {
        ...snapshot,
        missions: snapshot.missions.filter(m => !state.selectedMissionId || m.id === state.selectedMissionId || state.snapshot.missions.some(sm => sm.id === m.id)),
      };

      const hasChanges = JSON.stringify(currentData.messages) !== JSON.stringify(newSnapshot.agentMessages.filter(m => m.missionId === state.selectedMissionId)) ||
                        JSON.stringify(currentData.agents.map(a => a.status)) !== JSON.stringify(newSnapshot.agents.filter(a => a.missionId === state.selectedMissionId).map(a => a.status));
      const feedbackChanged = state.selectedMissionId && (
        JSON.stringify((state.snapshot.missionOutcomeEvaluations || []).filter(record => record.missionId === state.selectedMissionId)) !==
          JSON.stringify((newSnapshot.missionOutcomeEvaluations || []).filter(record => record.missionId === state.selectedMissionId)) ||
        JSON.stringify((state.snapshot.taskFailureAnalyses || []).filter(record => record.missionId === state.selectedMissionId)) !==
          JSON.stringify((newSnapshot.taskFailureAnalyses || []).filter(record => record.missionId === state.selectedMissionId)) ||
        JSON.stringify((state.snapshot.strategyAdjustments || []).filter(record => record.missionId === state.selectedMissionId)) !==
          JSON.stringify((newSnapshot.strategyAdjustments || []).filter(record => record.missionId === state.selectedMissionId))
      );

      if (hasChanges || feedbackChanged) {
        state.snapshot = newSnapshot;
        syncSelectedMission();
        if (state.selectedMissionId) {
          await loadFeedbackState(state.selectedMissionId);
        }
        renderAll();
      }
    } catch (error) {
      console.error('[Polling] Error:', error);
    }
  }, 2000);
}

function stopPolling() {
  if (state.pollingInterval) {
    clearInterval(state.pollingInterval);
    state.pollingInterval = undefined;
  }
}

function renderChoiceButtons(options) {
  if (!options || options.length === 0) return '';

  return `
    <div class="choice-row" style="margin-top: 12px;">
      ${options.map(option => `
        <button type="button" class="choice-option" data-fill-choice="${esc(option.value)}">${esc(option.value)}</button>
      `).join('')}
    </div>
  `;
}

refresh().catch(showTopbarError);
