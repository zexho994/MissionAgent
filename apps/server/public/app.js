const state = {
  snapshot: emptySnapshot(),
  config: undefined,
  selectedMissionId: undefined,
  draftMode: false,
  view: "home",
  warTab: "overview",
  popoverOpen: false,
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
      state.view = "home";
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
        <div class="home-title">
          <p>Owner Agent</p>
          <h1>告诉我你想完成什么，我来补齐 Mission。</h1>
        </div>
        <div id="chat-stream" class="chat-stream">
          ${renderChatContent(data)}
        </div>
        <div class="confirm-panel">
          ${renderConfirmPanel(data)}
        </div>
        <form id="mission-form" class="composer">
          <textarea id="goal" rows="4" placeholder="${esc(uiConfig().emptyPrompt)}">${esc(defaultGoal(data))}</textarea>
          <button type="submit">${data.mission ? "补充给 Owner" : "发送给 Owner"}</button>
        </form>
      </div>
    </section>
  `;
  bindChoiceButtons();
}

function renderChatContent(data) {
  if (!data.mission) {
    return `
      <div class="bubble owner">
        <strong>Owner Agent</strong>
        <p>你不用先写成功指标和约束。只要告诉我目标，我会分析缺口、追问必要细节，并生成 Mission 团队。</p>
        <div class="choice-row">
          ${uiConfig().starterPrompts.map((prompt) => `<button type="button" data-fill="${esc(prompt.value)}">${esc(prompt.label)}</button>`).join("")}
        </div>
      </div>
    `;
  }

  const ownerMessage = data.messages.find((message) => message.type === "mission_brief");
  const followups = data.messages.filter((message) => message.type === "user_message" || message.type === "owner_followup");
  const ownerText = ownerMessage?.content || `Mission 已创建：${data.mission.goal}`;
  return `
    <div class="bubble user">
      <strong>你</strong>
      <p>${esc(data.mission.goal)}</p>
    </div>
    <div class="bubble owner">
      <strong>Owner Agent</strong>
      <p>${esc(ownerText)}</p>
      <div class="thought-list">
        ${data.mission.successMetrics.slice(0, 3).map((item, index) => `
          <div><span>思考节点 ${index + 1}</span>${esc(item)}</div>
        `).join("")}
      </div>
      <div class="choice-row">
        <button type="button" data-append="更偏向快速产出 demo">快速 demo</button>
        <button type="button" data-append="更偏向质量和可复盘">质量优先</button>
        <button type="button" data-open-war-room>${data.tasks.length > 0 ? "进入作战室" : "确认并创建作战室"}</button>
      </div>
    </div>
    ${followups.map((message) => renderConversationMessage(message)).join("")}
  `;
}

function renderConversationMessage(message) {
  const isUser = message.type === "user_message";
  return `
    <div class="bubble ${isUser ? "user" : "owner"}">
      <strong>${isUser ? "你" : "Owner Agent"}</strong>
      <p>${esc(message.content)}</p>
    </div>
  `;
}

function renderConfirmPanel(data) {
  if (!data.mission) {
    return `
      <strong>Owner 会自动补齐这些内容</strong>
      <div class="confirm-options">
        <span>目标定义</span>
        <span>成功标准</span>
        <span>执行边界</span>
        <span>需要的 Agent</span>
      </div>
    `;
  }

  return `
    <strong>用户确认表单区域</strong>
    <div class="confirm-grid">
      ${data.mission.constraints.slice(0, 4).map((item) => `<label><input type="checkbox" checked /> ${esc(item)}</label>`).join("")}
    </div>
  `;
}

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

function renderAgentNetwork(data) {
  const agents = [...data.agents].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
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
  document.querySelectorAll("[data-open-war-room]").forEach((button) => {
    button.addEventListener("click", async () => {
      const mission = currentMission();
      if (!mission) return;
      if (scoped().tasks.length === 0) {
        const result = await api("/api/missions/activate", {
          method: "POST",
          body: { missionId: mission.id },
        });
        state.snapshot = result.snapshot;
      }
      state.view = "mission";
      state.draftMode = false;
      renderAll();
    });
  });
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

function shortAgentName(name) {
  return String(name).replace(/\s*Agent$/i, "");
}

function nextTaskText(data) {
  const runningTask = data.tasks.find((task) => task.status === "running");
  if (runningTask) return runningTask.title;
  const revisionTask = data.tasks.find((task) => task.status === "revision_needed");
  if (revisionTask) return `等待修正：${revisionTask.title}`;
  return data.tasks.at(-1)?.title || "Owner 正在补齐 Mission 定义。";
}

function latestOutputText(data) {
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
});

$("home-button").addEventListener("click", () => {
  state.view = "home";
  state.popoverOpen = false;
  renderAll();
});

$("new-chat-button").addEventListener("click", () => {
  state.selectedMissionId = undefined;
  state.draftMode = true;
  state.view = "home";
  state.popoverOpen = false;
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

refresh().catch(showTopbarError);
