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
