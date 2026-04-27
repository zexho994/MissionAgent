const state = {
  snapshot: { missions: [], tasks: [], artifacts: [], reviews: [], executions: [] },
  pollTimer: undefined,
};

const $ = (id) => document.getElementById(id);

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const json = await response.json();
  if (!response.ok) {
    throw new Error(json.error || `HTTP ${response.status}`);
  }
  return json;
}

async function refresh() {
  const health = await api("/api/health");
  $("openclaw-status").textContent = health.openclaw.available
    ? `可用 · ${health.openclaw.version || "unknown"}`
    : `不可用 · ${health.openclaw.error || "unknown error"}`;
  $("openclaw-dot").classList.toggle("ok", Boolean(health.openclaw.available));

  state.snapshot = await api("/api/snapshot");
  renderSnapshot();
  renderExecutionStatus(latestExecution());
}

function renderSnapshot() {
  const { missions, tasks, artifacts, reviews, executions } = state.snapshot;
  $("snapshot").innerHTML = [
    bucket("Missions", missions, (mission) => [
      mission.goal,
      mission.status,
      mission.successMetrics.join(" / "),
    ]),
    bucket("Tasks", tasks, (task) => [
      task.title,
      task.status,
      task.contract.objective,
    ]),
    bucket("Artifacts", artifacts, (artifact) => [
      artifact.type,
      artifact.taskId,
      artifact.evidence.join(", "),
    ]),
    bucket("Reviews", reviews, (review) => [
      review.decision,
      review.reviewerAgentId,
      review.comments.join(" / "),
    ]),
    bucket("Executions", executions, (execution) => [
      execution.id,
      execution.status,
      execution.error || execution.completedAt || execution.startedAt,
    ]),
  ].join("");
}

function bucket(title, items, lines) {
  const body = items.length
    ? items
        .map((item) => {
          const [first, second, third] = lines(item);
          return `<div class="item"><strong>${escapeHtml(first)}</strong><span>${escapeHtml(second)}</span><span>${escapeHtml(third)}</span></div>`;
        })
        .join("")
    : `<p class="hint">暂无</p>`;
  return `<section class="bucket"><h3>${title}</h3>${body}</section>`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

$("mission-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const goal = $("goal").value;
  const successMetrics = $("metrics").value.split(",").map((item) => item.trim()).filter(Boolean);
  const constraints = $("constraints").value.split(",").map((item) => item.trim()).filter(Boolean);

  await api("/api/missions", {
    method: "POST",
    body: { goal, successMetrics, constraints },
  });
  await refresh();
});

$("run-openclaw").addEventListener("click", async () => {
  const task = state.snapshot.tasks.find((candidate) => candidate.status !== "completed");
  const mission = state.snapshot.missions[0];
  if (!mission || !task) {
    $("run-result").textContent = "请先创建 Mission，并确保存在未完成任务。";
    return;
  }

  $("run-openclaw").disabled = true;
  $("run-result").textContent = "OpenClaw 已启动，正在轮询运行状态...";
  try {
    const result = await api("/api/openclaw/run", {
      method: "POST",
      body: {
        missionId: mission.id,
        taskId: task.id,
        message: $("run-message").value,
      },
    });
    state.snapshot = result.snapshot;
    renderExecutionStatus(result.execution);
    renderSnapshot();
    startPolling(result.execution.id);
  } catch (error) {
    $("run-result").textContent = error instanceof Error ? error.message : String(error);
    $("run-openclaw").disabled = false;
  }
});

$("refresh").addEventListener("click", refresh);

refresh().catch((error) => {
  $("openclaw-status").textContent = error instanceof Error ? error.message : String(error);
});

function startPolling(executionId) {
  clearPolling();
  state.pollTimer = window.setInterval(async () => {
    try {
      state.snapshot = await api("/api/snapshot");
      const execution = state.snapshot.executions.find((candidate) => candidate.id === executionId);
      if (!execution) {
        throw new Error(`Execution not found: ${executionId}`);
      }

      renderSnapshot();
      renderExecutionStatus(execution);
      if (execution.status !== "running") {
        clearPolling();
        $("run-openclaw").disabled = false;
        renderExecutionResult(execution);
      }
    } catch (error) {
      clearPolling();
      $("run-openclaw").disabled = false;
      $("run-result").textContent = error instanceof Error ? error.message : String(error);
    }
  }, 1500);
}

function clearPolling() {
  if (state.pollTimer !== undefined) {
    window.clearInterval(state.pollTimer);
    state.pollTimer = undefined;
  }
}

function latestExecution() {
  return state.snapshot.executions.at(-1);
}

function renderExecutionStatus(execution) {
  $("execution-dot").classList.toggle("ok", execution?.status === "completed");
  $("execution-dot").classList.toggle("running", execution?.status === "running");
  $("execution-title").textContent = execution ? `Execution ${execution.id}` : "暂无执行";
  if (!execution) {
    $("execution-detail").textContent = "创建 Mission 后点击执行当前任务。";
    return;
  }

  const completed = execution.completedAt ? ` · 结束 ${execution.completedAt}` : "";
  $("execution-detail").textContent = `${execution.status} · 开始 ${execution.startedAt}${completed}`;
}

function renderExecutionResult(execution) {
  if (execution.status === "failed") {
    $("run-result").textContent = execution.error || "Execution failed";
    return;
  }

  const artifact = state.snapshot.artifacts.find((candidate) => candidate.id === execution.artifactId);
  $("run-result").textContent = artifact
    ? JSON.stringify(artifact.content, null, 2)
    : `Execution completed without artifact: ${execution.id}`;
}
