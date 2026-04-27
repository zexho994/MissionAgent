const state = {
  snapshot: { missions: [], tasks: [], artifacts: [], reviews: [], executions: [] },
  pollTimer: undefined,
  activeTab: "agent",
};

const $ = (id) => document.getElementById(id);

/* ── API ── */
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

/* ── Refresh ── */
async function refresh() {
  const health = await api("/api/health");
  $("openclaw-status").textContent = health.openclaw.available
    ? `OpenClaw ${health.openclaw.version || "unknown"}`
    : `不可用`;
  $("openclaw-dot").classList.toggle("ok", Boolean(health.openclaw.available));

  state.snapshot = await api("/api/snapshot");
  renderPipeline();
  renderMissionDetail();
  renderTaskPanel();
  renderArtifactPanel();
  renderReviewPanel();
  renderExecSection();
}

/* ── Pipeline progress bar ── */
function renderPipeline() {
  const { missions, tasks, executions } = state.snapshot;
  const hasMission = missions.length > 0;
  const hasTask = tasks.length > 0;
  const hasExec = executions.some((e) => e.status === "completed" || e.status === "running");
  const hasResult = executions.some((e) => e.status === "completed");
  const execRunning = executions.some((e) => e.status === "running");

  setStep("pipe-mission", hasMission ? "done" : "", hasMission ? missions[0].goal.slice(0, 28) + "…" : "创建目标与约束");
  setStep("pipe-task", hasTask ? "done" : "", hasTask ? `${tasks.length} 个任务` : "自动生成初始任务");
  setStep("pipe-exec", execRunning ? "active" : hasExec ? "done" : "", execRunning ? "执行中…" : hasExec ? "已完成" : "等待执行");
  setStep("pipe-result", hasResult ? "done" : "", hasResult ? "已生成" : "等待产物");
}

function setStep(id, cls, sub) {
  const el = $(id);
  el.className = "pipeline-step " + cls;
  const subEl = el.querySelector(".step-sub");
  if (subEl && sub) subEl.textContent = sub;
}

/* ── Mission detail card ── */
function renderMissionDetail() {
  const { missions } = state.snapshot;
  const container = $("mission-detail");
  if (missions.length === 0) {
    container.innerHTML = "";
    return;
  }
  const m = missions[0];
  container.innerHTML = `
    <div class="mission-card">
      <div class="mission-goal">${esc(m.goal)}</div>
      <div class="mission-meta">
        <span class="mission-tag">${m.status}</span>
        <span class="mission-tag green">预算 ${m.budget.maxRuntimeMinutes}min${m.budget.maxTokenSpendUsd ? ` / $${m.budget.maxTokenSpendUsd}` : ""}</span>
        ${m.successMetrics.map((s) => `<span class="mission-tag">${esc(s)}</span>`).join("")}
      </div>
    </div>
  `;
}

/* ── Exec section ── */
function renderExecSection() {
  const container = $("exec-section");
  const { missions, tasks } = state.snapshot;
  if (missions.length === 0 || tasks.length === 0) {
    container.innerHTML = "";
    return;
  }
  const runningExec = state.snapshot.executions.find((e) => e.status === "running");
  const hasIncomplete = tasks.some((t) => t.status !== "completed" && t.status !== "cancelled");

  container.innerHTML = `
    <div class="panel" style="margin-top:14px">
      <h2>⚡ 执行任务</h2>
      ${!hasIncomplete ? '<p style="font-size:13px;color:#5b667a">所有任务已完成</p>' : `
      <label>
        发送给 OpenClaw 的指令
        <textarea id="run-message" rows="3">请根据当前 Mission 设计一个 harness 学习产物：说明核心概念、拆解视觉结构，并给出可用于 ChatGPT Image 2 的图片生成提示词。请输出简洁 JSON。</textarea>
      </label>
      <button id="run-openclaw" class="primary" type="button" ${runningExec ? "disabled" : ""}>
        ${runningExec ? "⏳ 执行中…" : "▶ 执行当前任务"}
      </button>
      `}
      <div id="exec-status-area"></div>
    </div>
  `;

  const btn = $("run-openclaw");
  if (btn && !runningExec) {
    btn.addEventListener("click", runTask);
  }
}

/* ── Task panel (timeline) ── */
function renderTaskPanel() {
  const container = $("task-panel");
  const { tasks } = state.snapshot;
  if (tasks.length === 0) {
    container.innerHTML = `<div class="panel"><div class="empty"><div class="icon">📦</div>创建 Mission 后自动生成任务</div></div>`;
    return;
  }

  container.innerHTML = `
    <div class="panel" style="margin-bottom:18px">
      <h2>📦 任务拆解</h2>
      <div class="task-flow">
        ${tasks.map((t, i) => {
          const dotCls = t.status === "completed" ? "completed"
            : t.status === "running" ? "running"
            : t.status === "failed" ? "failed" : "";
          const isLast = i === tasks.length - 1;
          const deps = t.dependencies.length > 0
            ? `<div class="task-contract">依赖: ${t.dependencies.join(", ")}</div>` : "";
          const assignee = t.assigneeAgentId
            ? `<div class="task-contract">执行者: ${esc(t.assigneeAgentId)}</div>` : "";
          return `
            <div class="task-node">
              <div class="task-dot-col">
                <div class="task-dot ${dotCls}"></div>
                ${!isLast ? '<div class="task-line"></div>' : ""}
              </div>
              <div class="task-body">
                <div class="task-title">${esc(t.title)}</div>
                <span class="task-status-badge ${t.status}">${statusLabel(t.status)}</span>
                <div class="task-objective">${esc(t.contract.objective)}</div>
                <div class="task-contract">
                  验收: ${t.contract.successCriteria.map(esc).join("；")}
                </div>
                ${deps}${assignee}
              </div>
            </div>
          `;
        }).join("")}
      </div>
    </div>
  `;
}

/* ── Artifact panel ── */
function renderArtifactPanel() {
  const container = $("artifact-panel");
  const { artifacts, executions } = state.snapshot;
  const runningExec = executions.find((e) => e.status === "running");

  if (runningExec && artifacts.length === 0) {
    container.innerHTML = `
      <div class="panel" style="margin-bottom:18px">
        <h2>⏳ 执行中</h2>
        <div class="execution-panel">
          <div class="dot running"></div>
          <div class="execution-info">
            <strong>OpenClaw Agent 正在运行</strong>
            <p>模型推理中，通常需要 30-90 秒…</p>
          </div>
        </div>
        <div class="meta-bar">
          <span>开始: ${new Date(runningExec.startedAt).toLocaleTimeString("zh-CN")}</span>
          <span>已用: <strong id="elapsed-timer">${elapsed(runningExec.startedAt)}</strong></span>
        </div>
      </div>
    `;
    return;
  }

  if (artifacts.length === 0) {
    container.innerHTML = "";
    return;
  }

  const a = artifacts[0];
  const agentText = extractAgentText(a.content);
  const rawJson = JSON.stringify(a.content, null, 2);
  const meta = extractMeta(a.content);
  const exec = executions.find((e) => e.artifactId === a.id);

  container.innerHTML = `
    <div class="panel" style="margin-bottom:18px">
      <h2>📄 执行产物</h2>
      <div class="artifact-card">
        <span class="artifact-type">${a.type}</span>
        <span class="mission-tag green" style="margin-left:8px">quality: ${a.qualityScore ?? "-"}</span>
        ${exec ? `<div class="meta-bar" style="margin-top:8px">
          ${meta ? `<span>${meta}</span>` : ""}
          <span>耗时: <strong>${exec.startedAt && exec.completedAt ? ((new Date(exec.completedAt) - new Date(exec.startedAt)) / 1000).toFixed(1) + "s" : "-"}</strong></span>
        </div>` : ""}
      </div>
      <div class="result-area">
        <div class="result-tabs">
          <div class="result-tab ${state.activeTab === "agent" ? "active" : ""}" data-tab="agent">Agent 回复</div>
          <div class="result-tab ${state.activeTab === "raw" ? "active" : ""}" data-tab="raw">原始 JSON</div>
        </div>
        <div class="result-content">${esc(state.activeTab === "agent" ? (agentText || rawJson) : rawJson)}</div>
      </div>
    </div>
  `;

  container.querySelectorAll(".result-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      state.activeTab = tab.dataset.tab;
      renderArtifactPanel();
    });
  });
}

/* ── Review panel ── */
function renderReviewPanel() {
  const container = $("review-panel");
  const { reviews } = state.snapshot;
  if (reviews.length === 0) { container.innerHTML = ""; return; }

  container.innerHTML = `
    <div class="panel">
      <h2>✅ 审核</h2>
      ${reviews.map((r) => `
        <div style="margin-bottom:10px">
          <span class="review-badge ${r.decision}">${decisionIcon(r.decision)} ${r.decision}</span>
          <span style="font-size:12px;color:#5b667a;margin-left:8px">by ${esc(r.reviewerAgentId)}</span>
          <div style="font-size:13px;color:#5b667a;margin-top:4px">${r.comments.map(esc).join("；")}</div>
        </div>
      `).join("")}
    </div>
  `;
}

/* ── Run task ── */
async function runTask() {
  const task = state.snapshot.tasks.find((t) => t.status !== "completed" && t.status !== "cancelled");
  const mission = state.snapshot.missions[0];
  if (!mission || !task) return;

  const btn = $("run-openclaw");
  btn.disabled = true;
  btn.textContent = "⏳ 执行中…";

  try {
    const result = await api("/api/openclaw/run", {
      method: "POST",
      body: {
        missionId: mission.id,
        taskId: task.id,
        message: $("run-message")?.value || "Execute task",
      },
    });
    state.snapshot = result.snapshot;
    renderAll();
    startPolling(result.execution.id);
  } catch (error) {
    const area = $("exec-status-area");
    if (area) area.innerHTML = `<div class="execution-panel" style="margin-top:10px"><div class="dot error"></div><div class="execution-info"><strong>执行失败</strong><p>${esc(error instanceof Error ? error.message : String(error))}</p></div></div>`;
    if (btn) { btn.disabled = false; btn.textContent = "▶ 执行当前任务"; }
  }
}

/* ── Polling ── */
function startPolling(executionId) {
  clearPolling();
  state.pollTimer = window.setInterval(async () => {
    try {
      state.snapshot = await api("/api/snapshot");
      const execution = state.snapshot.executions.find((e) => e.id === executionId);
      if (!execution) throw new Error(`Execution not found: ${executionId}`);
      renderAll();
      if (execution.status !== "running") {
        clearPolling();
        renderExecSection();
      }
    } catch (error) {
      clearPolling();
      renderExecSection();
    }
  }, 2000);
}

function clearPolling() {
  if (state.pollTimer !== undefined) {
    window.clearInterval(state.pollTimer);
    state.pollTimer = undefined;
  }
}

function renderAll() {
  renderPipeline();
  renderMissionDetail();
  renderTaskPanel();
  renderArtifactPanel();
  renderReviewPanel();
}

/* ── Helpers ── */
function esc(v) {
  return String(v ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function statusLabel(s) {
  const map = { draft: "草稿", ready: "就绪", queued: "排队中", running: "执行中", waiting_tool: "等待工具", waiting_approval: "等待审批", submitted: "已提交", reviewing: "审核中", revision_needed: "需修改", completed: "已完成", failed: "失败", cancelled: "已取消" };
  return map[s] || s;
}

function decisionIcon(d) {
  return d === "approve" ? "✅" : d === "revise" ? "🔄" : "❌";
}

function elapsed(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  return (ms / 1000).toFixed(0) + "s";
}

function extractAgentText(content) {
  try {
    const oc = content.openclaw;
    if (!oc) return null;
    if (oc.payloads && Array.isArray(oc.payloads)) {
      return oc.payloads.map((p) => p.text || p.content || JSON.stringify(p)).filter((t) => t && t !== "{}").join("\n");
    }
    if (typeof oc.text === "string") return oc.text;
    if (typeof oc.output === "string") return oc.output;
  } catch { /* */ }
  return null;
}

function extractMeta(content) {
  try {
    const m = content.openclaw?.meta;
    if (!m) return null;
    const parts = [];
    if (m.agentMeta?.model) parts.push(`模型: ${m.agentMeta.model}`);
    if (m.durationMs) parts.push(`推理: ${(m.durationMs / 1000).toFixed(1)}s`);
    if (m.agentMeta?.usage?.total) parts.push(`tokens: ${m.agentMeta.usage.total}`);
    return parts.join(" · ") || null;
  } catch { return null; }
}

/* ── Events ── */
$("mission-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const goal = $("goal").value;
  const successMetrics = $("metrics").value.split(",").map((s) => s.trim()).filter(Boolean);
  const constraints = $("constraints").value.split(",").map((s) => s.trim()).filter(Boolean);
  await api("/api/missions", { method: "POST", body: { goal, successMetrics, constraints } });
  await refresh();
});

$("refresh").addEventListener("click", refresh);

refresh().catch((error) => {
  $("openclaw-status").textContent = error instanceof Error ? error.message : String(error);
});
