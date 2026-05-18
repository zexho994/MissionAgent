const state = {
  snapshot: emptySnapshot(),
  config: undefined,
  selectedMissionId: undefined,
  draftMode: false,
  view: "home",
  warTab: "overview",
  popoverOpen: false,
  streamingMissionId: undefined,
  hrStreamingMissionId: undefined,
  toolConsoleMissionId: undefined,
  toolConsoleEventSource: undefined,
  pollingInterval: undefined,
  automationSummaryByMissionId: {},
  feedbackSummaryByMissionId: {},
  autopilotDiagnosisByMissionId: {},
  scheduleRulesByMissionId: {},
  scheduleActionPending: false,
  scheduleFormOpen: false,
  scheduleError: "",
  missionDeleteError: "",
  planActionMissionId: undefined,
  planUiByMissionId: {},
  negotiationUiByMissionId: {},
  selectedTaskId: undefined,
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

function expectPiHealth(health) {
  if (!health || typeof health !== "object") {
    throw new Error("Health response must be an object");
  }
  const pi = health.pi;
  if (!pi || typeof pi !== "object") {
    throw new Error("Health response missing pi runtime status");
  }
  if (typeof pi.available !== "boolean") {
    throw new Error("Health response pi.available must be boolean");
  }
  const version = typeof pi.version === "string" && pi.version.trim() ? pi.version.trim() : "unknown";
  return { available: pi.available, version };
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

async function deleteMission(missionId) {
  const mission = state.snapshot.missions.find((candidate) => candidate.id === missionId);
  if (!mission) throw new Error(`Mission not found: ${missionId}`);
  const confirmed = window.confirm(`删除 Mission：${mission.goal}\n\n相关任务、消息和执行记录都会一起删除。`);
  if (!confirmed) return;

  state.missionDeleteError = "";
  const result = await api(`/api/missions/${encodeURIComponent(missionId)}`, { method: "DELETE" });
  state.snapshot = result.snapshot;
  delete state.automationSummaryByMissionId[missionId];
  delete state.feedbackSummaryByMissionId[missionId];
  delete state.autopilotDiagnosisByMissionId[missionId];
  delete state.scheduleRulesByMissionId[missionId];
  delete state.planUiByMissionId[missionId];
  delete state.negotiationUiByMissionId[missionId];
  if (state.selectedMissionId === missionId) {
    state.selectedMissionId = undefined;
    state.draftMode = state.snapshot.missions.length === 0;
    state.view = "home";
    stopPolling();
  }
  syncSelectedMission();
  renderAll();
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

async function updateStrategyAdjustmentStatus(missionId, adjustmentId, newStatus) {
  state.scheduleActionPending = true;
  state.scheduleError = "";
  renderAll();
  try {
    const result = await api(
      `/api/missions/${missionId}/feedback/strategy-adjustments/${adjustmentId}/status`,
      { method: "PATCH", body: { status: newStatus } },
    );
    state.snapshot = result.snapshot;
    if (missionId) {
      await loadFeedbackState(missionId);
    }
    renderAll();
  } catch (error) {
    state.scheduleError = error instanceof Error ? error.message : String(error);
    renderAll();
  } finally {
    state.scheduleActionPending = false;
    renderAll();
  }
}

async function runTask(missionId, taskId, message = "Execute the assigned task.") {
  state.scheduleActionPending = true;
  state.scheduleError = "";
  streamToolCallConsole(missionId);
  renderAll();
  try {
    const result = await api(`/api/pi/run`, {
      method: "POST",
      body: { missionId, taskId, message },
    });
    state.snapshot = result.snapshot;
    renderAll();
  } catch (error) {
    state.scheduleError = error instanceof Error ? error.message : String(error);
    renderAll();
  } finally {
    state.scheduleActionPending = false;
    renderAll();
  }
}

async function generatePlanForMission(missionId, feedback) {
  state.planActionMissionId = missionId;
  const planUi = planUiState(missionId);
  planUi.error = "";
  renderAll({ forceChatBottom: true });
  try {
    const body = feedback === undefined ? {} : { feedback };
    const result = await api(`/api/missions/${missionId}/plan/generate`, { method: "POST", body });
    state.snapshot = result.snapshot;
    planUi.revisionOpen = false;
    planUi.revisionFeedback = "";
  } catch (error) {
    planUi.error = error instanceof Error ? error.message : String(error);
  } finally {
    state.planActionMissionId = undefined;
    renderAll({ forceChatBottom: true });
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

async function refresh(options = {}) {
  state.config = await api("/api/config");
  const health = await api("/api/health");
  const piHealth = expectPiHealth(health);
  const version = piHealth.version;
  $("openclaw-status").textContent = piHealth.available
    ? (version.startsWith("Pi") || version.startsWith("pi") ? version : `Pi ${version}`)
    : "Pi 不可用";
  $("openclaw-dot").classList.toggle("ok", piHealth.available);

  state.snapshot = await api("/api/snapshot");
  syncSelectedMission();
  if (state.view === "mission" && currentMission()) {
    await refreshMissionAutomation();
  }
  renderAll(options);
}

function syncSelectedMission() {
  const missions = state.snapshot.missions;
  if (missions.length === 0) {
    state.selectedMissionId = undefined;
    state.draftMode = true;
    state.view = "home";
    stopToolCallConsole();
    return;
  }
  if (!state.draftMode && (!state.selectedMissionId || !missions.some((mission) => mission.id === state.selectedMissionId))) {
    state.selectedMissionId = missions.at(-1).id;
  }
  if (!state.draftMode && state.selectedMissionId) {
    streamToolCallConsole(state.selectedMissionId);
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

function negotiationUiState(missionId) {
  if (!state.negotiationUiByMissionId[missionId]) {
    state.negotiationUiByMissionId[missionId] = {
      revisionOpen: false,
      revisionFeedback: "",
      error: "",
    };
  }
  return state.negotiationUiByMissionId[missionId];
}

function hasTeamConfirmed(data) {
  return data.agents.some((agent) => agent.role !== "owner" && agent.role !== "hr");
}

function latestActionableTeamProposal(data) {
  if (hasTeamConfirmed(data)) return undefined;
  return [...data.messages]
    .reverse()
    .find((message) => message.type === "team_created" && !isRecruitingTeamMessage(message));
}

function missionHasWarRoomState(missionId) {
  return state.snapshot.tasks.some((task) => task.missionId === missionId)
    || state.snapshot.agents.some((agent) => agent.missionId === missionId && agent.role !== "owner");
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

function renderAll(options = {}) {
  const chatScroll = captureChatScrollState();
  renderMissionPopover();
  if (state.view === "mission" && currentMission()) {
    renderWarRoom();
  } else {
    state.view = "home";
    renderHome();
  }
  restoreChatScrollState(chatScroll, options);
  maybeStartHrStreaming();
}

function maybeStartHrStreaming() {
  const mission = currentMission();
  if (!mission) return;
  const data = scoped();
  const hrRunning = data.agents.some((agent) => agent.role === "hr" && agent.status === "running");
  if (hrRunning && state.hrStreamingMissionId !== mission.id) {
    streamHrProgress(mission.id);
  }
}

function captureChatScrollState() {
  const chatStream = $("chat-stream");
  if (!chatStream) return undefined;
  const distanceFromBottom = chatStream.scrollHeight - chatStream.scrollTop - chatStream.clientHeight;
  return {
    scrollTop: chatStream.scrollTop,
    distanceFromBottom,
    wasNearBottom: distanceFromBottom < 80,
  };
}

function restoreChatScrollState(previous, options = {}) {
  const chatStream = $("chat-stream");
  if (!chatStream) return;
  requestAnimationFrame(() => {
    if (options.forceChatBottom || previous?.wasNearBottom) {
      chatStream.scrollTop = chatStream.scrollHeight;
      return;
    }
    if (previous) {
      chatStream.scrollTop = previous.scrollTop;
    }
  });
}

function scrollChatToBottom() {
  const chatStream = $("chat-stream");
  if (chatStream) chatStream.scrollTop = chatStream.scrollHeight;
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
    ${state.missionDeleteError ? `<div class="mission-popover-error">${esc(state.missionDeleteError)}</div>` : ""}
    <div class="mission-list">
      ${state.snapshot.missions.map((mission) => missionMenuItem(mission)).join("")}
    </div>
  `;

  popover.querySelectorAll("[data-select-mission]").forEach((button) => {
    button.addEventListener("click", async () => {
      state.selectedMissionId = button.dataset.selectMission;
      state.draftMode = false;
      streamToolCallConsole(state.selectedMissionId);
      const willEnterWarRoom = missionHasWarRoomState(state.selectedMissionId);
      state.view = willEnterWarRoom ? "mission" : "home";
      state.popoverOpen = false;
      if (willEnterWarRoom) {
        await Promise.all([
          loadAutomationState(state.selectedMissionId),
          loadFeedbackState(state.selectedMissionId),
          loadAutopilotDiagnosis(state.selectedMissionId),
        ]);
      }
      renderAll();
    });
  });
  popover.querySelectorAll("[data-delete-mission]").forEach((button) => {
    button.addEventListener("click", async (event) => {
      event.stopPropagation();
      try {
        await deleteMission(button.dataset.deleteMission);
      } catch (error) {
        state.missionDeleteError = error instanceof Error ? error.message : String(error);
        renderMissionPopover();
      }
    });
  });
}

function missionMenuItem(mission) {
  const tasks = state.snapshot.tasks.filter((task) => task.missionId === mission.id);
  const executions = state.snapshot.executions.filter((execution) => execution.missionId === mission.id);
  const selected = mission.id === state.selectedMissionId;
  return `
    <div class="mission-row">
      <button class="mission-card ${selected ? "selected" : ""}" data-select-mission="${esc(mission.id)}" type="button">
        <strong>${esc(shortText(mission.goal, 46))}</strong>
        <span>${missionStateText(executions)} · ${tasks.length} 个任务</span>
      </button>
      <button class="mission-delete-button" data-delete-mission="${esc(mission.id)}" type="button" aria-label="删除 Mission ${esc(shortText(mission.goal, 24))}">删除</button>
    </div>
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
    (message) => message.type === "owner_followup" || message.type === "user_message" || message.type === "mission_brief" || message.type === "team_created"
  ).sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  const latestTeamProposal = [...conversationMessages]
    .reverse()
    .find((message) => message.type === "team_created" && !isRecruitingTeamMessage(message));

  // Track if we've rendered the brief to avoid duplicates
  let briefRendered = false;
  for (const message of conversationMessages) {
    if (message.type === "mission_brief") {
      // Only render brief once - the first mission_brief message
      if (!briefRendered) {
        parts.push(renderBriefMessage(data, message));
        briefRendered = true;
      }
    } else if (message.type === "team_created") {
      if (latestTeamProposal && message !== latestTeamProposal) {
        continue;
      }
      parts.push(renderTeamProposalCard(message, data));
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

  const hrRunning = data.agents.some((agent) => agent.role === "hr" && agent.status === "running");
  if (data.mission.briefConfirmed && hrRunning && !latestTeamProposal) {
    parts.push(`
      <div class="bubble hr thinking" data-hr-bubble>
        <p>HR Agent 正在分析任务并组建团队…<br>
          <span class="hr-progress-meta">已生成 <span data-hr-tokens>0</span> 字符 <span class="streaming-cursor">▋</span></span>
        </p>
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

function renderBriefMessage(data, message) {
  // Try data.mission.brief first, fallback to parsing message.content as JSON
  let brief = data.mission.brief;
  if (!brief && message.content) {
    try {
      const parsed = JSON.parse(message.content);
      // Check if it looks like a brief object (has goal field)
      if (parsed && typeof parsed.goal === "string") {
        brief = parsed;
      }
    } catch {
      // Not valid JSON, ignore
    }
  }
  if (!brief) return "";
  const fullContent = `
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
  `;
  const isLong = fullContent.length > 300;
  const collapsedContent = esc(shortText([
    brief.goal,
    brief.scope,
    brief.targetAudience,
    brief.timeline,
  ].filter(Boolean).join(" "), 200));
  return `
    <div class="bubble owner brief ${isLong ? "is-collapsed" : ""}" data-collapsible>
      <div class="bubble-content" data-full ${isLong ? "hidden" : ""}>${fullContent}</div>
      ${isLong ? `<div class="bubble-collapsed" data-collapsed>${collapsedContent}</div>` : ""}
      ${isLong ? `<button type="button" class="expand-button" data-toggle-collapse>展开</button>` : ""}
    </div>
  `;
}

function renderTeamProposalCard(message, data) {
  const teamConfirmed = hasTeamConfirmed(data);
  const negotiationUi = negotiationUiState(data.mission.id);
  const error = negotiationUi.error ? `<p class="plan-error">${esc(negotiationUi.error)}</p>` : "";

  if (teamConfirmed) {
    // Team already confirmed, just show the message as a regular bubble
    return `
      <div class="bubble owner">
        <strong>HR Agent · 团队提案</strong>
        <div class="markdown-body">${renderMarkdownContent(message.content)}</div>
      </div>
    `;
  }

  return `
    <div class="bubble owner team-proposal">
      <strong>HR Agent · 团队提案</strong>
      <div class="markdown-body">${renderMarkdownContent(message.content)}</div>
      ${error}
      <div class="choice-row" style="margin-top: 12px;">
        <button type="button" data-confirm-negotiation>确认团队提案</button>
        <button type="button" data-toggle-negotiation-revision>提出修改建议</button>
      </div>
      ${negotiationUi.revisionOpen ? `
        <div class="plan-revision-box">
          <textarea id="negotiation-revision-feedback" rows="3" placeholder="请描述你对团队提案的修改建议，例如：需要增加一个设计师、减少团队规模等">${esc(negotiationUi.revisionFeedback)}</textarea>
          <button type="button" data-submit-negotiation-revision>提交修改建议</button>
        </div>
      ` : ""}
    </div>
  `;
}

function isRecruitingTeamMessage(message) {
  return message.content.includes("基于 MissionPlan 分析")
    || message.content.includes("Analyzing MissionPlan")
    || message.content.includes("正在分析 MissionBrief")
    || message.content.includes("Analyzing MissionBrief");
}

function renderMissionPlanReview(data) {
  const plan = currentMissionPlan();
  const pending = isPlanPending();
  const planUi = currentPlanUiState();
  const isRecruiting = data.tasks.length === 0 && data.agents.some((agent) => agent.role === "hr" && agent.status === "running");
  const hasExecutionTeam = data.agents.some((agent) => agent.role !== "owner" && agent.role !== "hr");
  const hasPendingTeamProposal = Boolean(latestActionableTeamProposal(data));
  const error = planUi.error ? `<p class="plan-error">${esc(planUi.error)}</p>` : "";
  if (!plan) {
    const legacyWarRoomAction = hasExecutionTeam ? `
        <div class="choice-row">
          <button type="button" data-open-existing-war-room ${pending ? "disabled" : ""}>进入作战室</button>
        </div>
      ` : "";
    return `
      <div class="mission-plan-card">
        <strong>Owner Agent · MissionPlan</strong>
        <p>${pending ? "正在自动生成执行计划..." : "确认 MissionBrief 后会自动生成执行计划。"}</p>
        ${error}
        ${error ? `<button type="button" data-generate-plan ${pending ? "disabled" : ""}>重新尝试生成计划</button>` : ""}
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
          <button type="button" data-confirm-plan="${esc(plan.id)}" ${pending ? "disabled" : ""}>确认 MissionPlan 并招募团队</button>
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
          <button type="button" data-open-war-room ${pending || isRecruiting || hasPendingTeamProposal ? "disabled" : ""}>${isRecruiting ? "招募中..." : (hasExecutionTeam ? "进入作战室" : (hasPendingTeamProposal ? "等待确认团队" : "创建作战室"))}</button>
        </div>
      `}
    </div>
  `;
}

function renderConversationMessage(message) {
  const isUser = message.type === "user_message";
  const content = isUser ? message.content : message.content;
  if (!content.trim()) return "";
  const isLong = content.length > 300;
  return `
    <div class="bubble ${isUser ? "user" : "owner"} ${isLong ? "is-collapsed" : ""}" data-collapsible>
      <div class="bubble-content markdown-body" data-full ${isLong ? "hidden" : ""}>${renderMarkdownContent(content)}</div>
      ${isLong ? `<div class="bubble-collapsed markdown-body" data-collapsed>${renderMarkdownContent(`${content.slice(0, 200)}...`)}</div>` : ""}
      ${isLong ? `<button type="button" class="expand-button" data-toggle-collapse>展开</button>` : ""}
    </div>
  `;
}

function renderMarkdownContent(content) {
  return DigitalAgentMarkdown.renderMarkdownMessage(content);
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
        form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      }
    });
  });
  document.querySelectorAll("[data-generate-plan]").forEach((button) => {
    button.addEventListener("click", async () => {
      const mission = currentMission();
      if (!mission) return;
      await generatePlanForMission(mission.id);
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
        startPolling();
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
      await generatePlanForMission(mission.id, feedback);
    });
  });
  document.querySelectorAll("[data-open-war-room]").forEach((button) => {
    button.addEventListener("click", async () => {
      const mission = currentMission();
      if (!mission) return;
      if (!missionHasWarRoomState(mission.id)) {
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
      await loadAutopilotDiagnosis(mission.id);
      renderAll();
    });
  });
  document.querySelectorAll("[data-open-existing-war-room]").forEach((button) => {
    button.addEventListener("click", async () => {
      const mission = currentMission();
      if (!mission) return;
      if (!missionHasWarRoomState(mission.id)) {
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
      planUiState(mission.id).error = "";
      state.planActionMissionId = mission.id;
      renderAll({ forceChatBottom: true });
      try {
        const result = await api("/api/missions/confirm-brief", {
          method: "POST",
          body: { missionId: mission.id },
        });
        state.snapshot = result.snapshot;
        await generatePlanForMission(mission.id);
      } catch (error) {
        planUiState(mission.id).error = error instanceof Error ? error.message : String(error);
        state.planActionMissionId = undefined;
        renderAll({ forceChatBottom: true });
      }
    });
  });
  document.querySelectorAll("[data-confirm-negotiation]").forEach((button) => {
    button.addEventListener("click", async () => {
      const mission = currentMission();
      if (!mission) return;
      const negotiationUi = negotiationUiState(mission.id);
      negotiationUi.error = "";
      renderAll();
      try {
        const result = await api("/api/missions/negotiate/confirm", {
          method: "POST",
          body: { missionId: mission.id },
        });
        state.snapshot = result.snapshot;
        negotiationUi.revisionOpen = false;
        negotiationUi.revisionFeedback = "";
        await loadAutopilotDiagnosis(mission.id);
      } catch (error) {
        negotiationUi.error = error instanceof Error ? error.message : String(error);
      }
      renderAll();
    });
  });
  document.querySelectorAll("[data-toggle-negotiation-revision]").forEach((button) => {
    button.addEventListener("click", () => {
      const mission = currentMission();
      if (!mission) return;
      const negotiationUi = negotiationUiState(mission.id);
      negotiationUi.revisionOpen = !negotiationUi.revisionOpen;
      renderAll();
    });
  });
  const negotiationRevisionTextarea = $("negotiation-revision-feedback");
  if (negotiationRevisionTextarea) {
    negotiationRevisionTextarea.addEventListener("input", (event) => {
      const mission = currentMission();
      if (!mission) return;
      negotiationUiState(mission.id).revisionFeedback = event.target.value;
    });
  }
  document.querySelectorAll("[data-submit-negotiation-revision]").forEach((button) => {
    button.addEventListener("click", async () => {
      const mission = currentMission();
      if (!mission) return;
      const negotiationUi = negotiationUiState(mission.id);
      const feedback = negotiationUi.revisionFeedback.trim();
      if (!feedback) {
        negotiationUi.error = "请输入修改建议。";
        renderAll();
        return;
      }
      negotiationUi.error = "";
      renderAll();
      try {
        const result = await api("/api/missions/negotiate/respond", {
          method: "POST",
          body: { missionId: mission.id, feedback },
        });
        state.snapshot = result.snapshot;
        negotiationUi.revisionOpen = false;
        negotiationUi.revisionFeedback = "";
      } catch (error) {
        negotiationUi.error = error instanceof Error ? error.message : String(error);
      }
      renderAll();
    });
  });
  // Collapsible bubble content
  document.querySelectorAll("[data-toggle-collapse]").forEach((button) => {
    button.addEventListener("click", (e) => {
      e.stopPropagation();
      const bubble = button.closest("[data-collapsible]");
      if (!bubble) return;
      const fullContent = bubble.querySelector("[data-full]");
      const collapsedContent = bubble.querySelector("[data-collapsed]");
      const isCollapsed = bubble.classList.contains("is-collapsed");
      if (isCollapsed) {
        bubble.classList.remove("is-collapsed");
        if (collapsedContent) collapsedContent.hidden = true;
        if (fullContent) fullContent.hidden = false;
        button.textContent = "收起";
      } else {
        bubble.classList.add("is-collapsed");
        if (fullContent) fullContent.hidden = true;
        if (collapsedContent) collapsedContent.hidden = false;
        button.textContent = "展开";
      }
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
        && !isRecruitingTeamMessage(item);
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
    return "HR 正在基于 MissionPlan 分析团队需求并招募团队。";
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
  const artifactItems = data.artifacts.map((artifact) => {
    let item = `产物：${artifact.type} · 质量分 ${Math.round((artifact.qualityScore || 0) * 100)}`;
    if (artifact.sources && artifact.sources.length > 0) {
      const sourceCount = artifact.sources.length;
      const urlCount = artifact.sources.filter((s) => s && s.url).length;
      item += ` · ${sourceCount}个来源${urlCount > 0 ? ` (${urlCount}个URL)` : ""}`;
    }
    return item;
  });
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
  renderAll({ forceChatBottom: true });

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
  stopToolCallConsole();
  stopPolling();
  renderAll();
});

$("new-chat-button").addEventListener("click", () => {
  state.selectedMissionId = undefined;
  state.draftMode = true;
  state.view = "home";
  state.popoverOpen = false;
  stopToolCallConsole();
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

function logToolCallToBrowserConsole(toolEvent) {
  if (!toolEvent || typeof toolEvent !== "object") return;
  const label = toolEvent.traceLabel || "unknown";
  const status = toolEvent.status || "event";
  const toolName = toolEvent.toolName || "unknown_tool";
  console.log(`[pi-agent tool][${label}] ${status} ${toolName}`, toolEvent);
}

function streamToolCallConsole(missionId) {
  if (!missionId) return;
  if (state.toolConsoleMissionId === missionId && state.toolConsoleEventSource) return;
  stopToolCallConsole();

  const eventSource = new EventSource(`/api/missions/${missionId}/stream`);
  state.toolConsoleMissionId = missionId;
  state.toolConsoleEventSource = eventSource;

  eventSource.addEventListener("message", (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type === "tool_call") {
        logToolCallToBrowserConsole(data.toolEvent);
      }
    } catch (error) {
      console.error("[ToolCall SSE] Parse error:", error);
    }
  });

  eventSource.addEventListener("error", (error) => {
    console.error("[ToolCall SSE] Connection error:", error);
    stopToolCallConsole();
  });
}

function stopToolCallConsole() {
  if (state.toolConsoleEventSource) {
    state.toolConsoleEventSource.close();
  }
  state.toolConsoleEventSource = undefined;
  state.toolConsoleMissionId = undefined;
}

async function streamOwnerResponse(missionId, container) {
  if (state.streamingMissionId === missionId) return;

  state.streamingMissionId = missionId;
  streamToolCallConsole(missionId);
  const eventSource = new EventSource(`/api/missions/${missionId}/stream`);

  // Try to find the thinking bubble, but don't close SSE if it doesn't exist yet
  // The 'done' event will still trigger refresh() to update the UI
  let responseBubble = container.querySelector('.owner.thinking');
  let contentEl = responseBubble?.querySelector('p');
  let hasReceivedToken = false;

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
          scrollChatToBottom();
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
          await refresh({ forceChatBottom: true });
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
    const cursor = contentEl?.querySelector('.streaming-cursor');
    if (cursor) cursor.remove();
  });
}

function streamHrProgress(missionId) {
  if (state.hrStreamingMissionId === missionId) return;
  state.hrStreamingMissionId = missionId;
  streamToolCallConsole(missionId);

  const eventSource = new EventSource(`/api/missions/${missionId}/stream`);

  const cleanup = () => {
    eventSource.close();
    if (state.hrStreamingMissionId === missionId) {
      state.hrStreamingMissionId = undefined;
    }
  };

  eventSource.addEventListener('message', (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type === 'hr_progress') {
        const counter = document.querySelector('[data-hr-bubble] [data-hr-tokens]');
        if (counter && typeof data.tokensReceived === 'number') {
          counter.textContent = String(data.tokensReceived);
        }
      } else if (data.type === 'hr_progress_done') {
        cleanup();
        setTimeout(async () => {
          await refresh({ forceChatBottom: true });
        }, 200);
      } else if (data.type === 'done') {
        cleanup();
      }
    } catch (error) {
      console.error('[SSE/HR] Parse error:', error);
    }
  });

  eventSource.addEventListener('error', (error) => {
    console.error('[SSE/HR] Connection error:', error);
    cleanup();
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
