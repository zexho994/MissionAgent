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
};

const $ = (id) => document.getElementById(id);

function emptySnapshot() {
  return {
    missions: [],
    tasks: [],
    artifacts: [],
    reviews: [],
    executions: [],
    agents: [],
    agentMessages: [],
    threads: [],
    taskEvents: [],
    toolCalls: [],
    decisions: [],
    agentRelations: [],
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
  const confirmPanel = renderConfirmPanel(data);
  $("app-view").innerHTML = `
    <section class="home-page">
      <div class="conversation-area">
        <div id="chat-stream" class="chat-stream">
          ${renderChatContent(data)}
        </div>
        ${confirmPanel ? `<div class="confirm-panel">${confirmPanel}</div>` : ""}
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
  );
  for (const message of conversationMessages) {
    if (message.type === "mission_brief") {
      parts.push(renderBriefMessage(data));
    } else {
      parts.push(renderConversationMessage(message));
      // Add choice buttons after owner_followup messages with options
      if (message.type === "owner_followup" && message.options && message.options.length > 0) {
        parts.push(renderChoiceButtons(message.options));
      }
    }
  }

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

  if (data.mission.briefConfirmed) {
    parts.push(`
      <div class="choice-row" style="margin-top: 12px;">
        <button type="button" data-open-war-room>${data.tasks.length > 0 ? "进入作战室" : "确认并创建作战室"}</button>
      </div>
    `);
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

function renderConversationMessage(message) {
  const isUser = message.type === "user_message";
  const content = isUser ? message.content : ownerBodyText(message.content);
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
          <button type="button" class="choice-option" data-fill-choice="${esc(option.value)}">${esc(option.label)}</button>
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
  document.querySelectorAll("[data-open-war-room]").forEach((button) => {
    button.addEventListener("click", async () => {
      const mission = currentMission();
      if (!mission) return;
      if (scoped().tasks.length === 0) {
        const activation = api("/api/missions/activate-async", {
          method: "POST",
          body: { missionId: mission.id },
        });
        state.view = "mission";
        state.draftMode = false;
        state.warTab = "overview";
        renderAll();
        startPolling();
        const result = await activation;
        state.snapshot = result.snapshot;
        renderAll();
        return;
      }
      state.view = "mission";
      state.draftMode = false;
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

  const responseBubble = container.querySelector('.owner.thinking');
  if (!responseBubble) {
    eventSource.close();
    state.streamingMissionId = undefined;
    return;
  }

  const contentEl = responseBubble.querySelector('p');
  if (!contentEl) {
    eventSource.close();
    state.streamingMissionId = undefined;
    return;
  }

  contentEl.innerHTML = '<span class="streaming-cursor">▋</span>';

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
        const cursor = contentEl.querySelector('.streaming-cursor');
        const text = contentEl.textContent.replace('▋', '') + data.content;
        contentEl.innerHTML = esc(text) + '<span class="streaming-cursor">▋</span>';
        const chatStream = $('chat-stream');
        if (chatStream) chatStream.scrollTop = chatStream.scrollHeight;
      }

      if (data.type === 'done') {
        eventSource.close();
        state.streamingMissionId = undefined;
        const cursor = contentEl.querySelector('.streaming-cursor');
        if (cursor) cursor.remove();

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

      if (hasChanges) {
        state.snapshot = newSnapshot;
        syncSelectedMission();
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
        <button type="button" data-fill-choice="${esc(option.value)}">${esc(option.label)}</button>
      `).join('')}
    </div>
  `;
}

refresh().catch(showTopbarError);
