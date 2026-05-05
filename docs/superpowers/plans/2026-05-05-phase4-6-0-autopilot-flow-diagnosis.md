# Phase 4.6.0 Autopilot Flow Diagnosis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a read-only autopilot diagnosis service, API, and War Room panel that explains why a Mission is not running yet.

**Architecture:** Keep diagnosis deterministic and side-effect free. `InMemoryMissionService` computes Mission state from existing snapshot data plus API-supplied runtime signals; `api.ts` supplies OpenClaw availability; plain frontend JavaScript loads and renders the diagnosis under the automation pulse.

**Tech Stack:** TypeScript, Vitest, existing server API handler, plain browser JavaScript, existing War Room CSS.

---

## File Structure

- Modify `apps/server/src/mission-service.ts`: add diagnosis types and `getAutopilotDiagnosis()`.
- Modify `apps/server/src/mission-service.test.ts`: unit tests for diagnosis stage rules.
- Modify `apps/server/src/api.ts`: add `GET /api/missions/:id/autopilot-diagnosis`.
- Modify `apps/server/src/api.test.ts`: API coverage with OpenClaw available/unavailable.
- Modify `apps/server/public/app.js`: store and load diagnosis when War Room state loads.
- Modify `apps/server/public/war-room.js`: render diagnostic panel below automation pulse.
- Modify `apps/server/public/styles.css`: add diagnostic panel styles.

---

### Task 1: Mission Service Autopilot Diagnosis

**Files:**
- Modify: `apps/server/src/mission-service.ts`
- Modify: `apps/server/src/mission-service.test.ts`

- [ ] **Step 1: Add failing diagnosis tests**

Append these tests inside the existing `describe("InMemoryMissionService", () => { ... })` block in `apps/server/src/mission-service.test.ts`:

```ts
  async function createConfirmedMission(service: InMemoryMissionService) {
    const mission = await service.createMission({ goal: "Run a mission" });
    await service.continueMission({ missionId: mission.id, message: "Audience is developers. Timeline is one month." });
    const withBrief = service.snapshot().missions.find((candidate) => candidate.id === mission.id);
    if (!withBrief?.brief) throw new Error("brief should exist");
    service.confirmBrief({ missionId: mission.id });
    return mission;
  }

  async function createConfirmedActivatedMission(service: InMemoryMissionService) {
    const mission = await createConfirmedMission(service);
    return service.activateMission({ missionId: mission.id });
  }

  it("diagnoses a new mission as briefing", async () => {
    const service = new InMemoryMissionService();
    const mission = await service.createMission({ goal: "Grow GitHub repositories" });

    expect(service.getAutopilotDiagnosis(mission.id, { hasExecutionRunner: true })).toMatchObject({
      missionId: mission.id,
      stage: "briefing",
      ready: false,
      signals: {
        briefConfirmed: false,
        hasPlan: false,
        teamReady: false,
        hasInitialTasks: false,
        hasExecutionRunner: true,
        hasScheduleRules: false,
        hasRunningExecution: false,
      },
    });
  });

  it("diagnoses a brief-confirmed mission without plan as missing_plan", async () => {
    const service = new InMemoryMissionService({ llm: new FakeLlmAdapter(() => JSON.stringify({
      goal: "Grow GitHub repositories",
      scope: "GitHub growth",
      constraints: ["one month"],
      successMetrics: ["two repositories exceed 1k stars"],
      keyAssumptions: ["developer audience"],
    })) });
    const mission = await createConfirmedMission(service);

    const diagnosis = service.getAutopilotDiagnosis(mission.id, { hasExecutionRunner: true });

    expect(diagnosis.stage).toBe("missing_plan");
    expect(diagnosis.blockers[0]).toMatchObject({
      code: "mission_plan_missing",
    });
  });

  it("diagnoses running execution before other blockers", async () => {
    const service = new InMemoryMissionService({ llm: new FakeLlmAdapter(() => JSON.stringify({
      goal: "Run a mission",
      scope: "Execution test",
      constraints: [],
      successMetrics: ["Mission is runnable"],
      keyAssumptions: [],
    })) });
    const mission = await createConfirmedActivatedMission(service);
    const task = service.snapshot().tasks.find((candidate) => candidate.missionId === mission.id);
    expect(task).toBeDefined();
    service.startExecution({ missionId: mission.id, taskId: task!.id });

    expect(service.getAutopilotDiagnosis(mission.id, { hasExecutionRunner: true }).stage).toBe("running");
  });

  it("diagnoses failed execution as blocked", async () => {
    const service = new InMemoryMissionService({ llm: new FakeLlmAdapter(() => JSON.stringify({
      goal: "Run a mission",
      scope: "Execution test",
      constraints: [],
      successMetrics: ["Mission is runnable"],
      keyAssumptions: [],
    })) });
    const mission = await createConfirmedActivatedMission(service);
    const task = service.snapshot().tasks.find((candidate) => candidate.missionId === mission.id);
    expect(task).toBeDefined();
    const execution = service.startExecution({ missionId: mission.id, taskId: task!.id });
    service.failExecution({ executionId: execution.id, error: "runner unavailable" });

    const diagnosis = service.getAutopilotDiagnosis(mission.id, { hasExecutionRunner: true });

    expect(diagnosis.stage).toBe("blocked");
    expect(diagnosis.blockers[0]).toMatchObject({
      code: "execution_blocked",
    });
  });

  it("diagnoses missing execution runner when executable tasks exist", async () => {
    const service = new InMemoryMissionService({ llm: new FakeLlmAdapter(() => JSON.stringify({
      goal: "Run a mission",
      scope: "Execution test",
      constraints: [],
      successMetrics: ["Mission is runnable"],
      keyAssumptions: [],
    })) });
    const mission = await createConfirmedActivatedMission(service);

    const diagnosis = service.getAutopilotDiagnosis(mission.id, {
      hasExecutionRunner: false,
      hasPlan: true,
    });

    expect(diagnosis.stage).toBe("missing_execution_runner");
    expect(diagnosis.blockers.some((blocker) => blocker.code === "execution_runner_missing")).toBe(true);
  });

  it("diagnoses missing schedule after earlier blockers are cleared", async () => {
    const service = new InMemoryMissionService({ llm: new FakeLlmAdapter(() => JSON.stringify({
      goal: "Run a mission",
      scope: "Execution test",
      constraints: [],
      successMetrics: ["Mission is runnable"],
      keyAssumptions: [],
    })) });
    const mission = await createConfirmedActivatedMission(service);

    const diagnosis = service.getAutopilotDiagnosis(mission.id, {
      hasExecutionRunner: true,
      hasPlan: true,
    });

    expect(diagnosis.stage).toBe("missing_schedule");
    expect(diagnosis.blockers.some((blocker) => blocker.code === "schedule_rules_missing")).toBe(true);
  });
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
pnpm --filter @digitalagent/server test -- mission-service.test.ts -t "diagnoses"
```

Expected: FAIL with `getAutopilotDiagnosis is not a function`.

- [ ] **Step 3: Add diagnosis types**

In `apps/server/src/mission-service.ts`, add near `AutomationSummary`:

```ts
export type AutopilotStage =
  | "briefing"
  | "missing_plan"
  | "team_not_ready"
  | "missing_initial_tasks"
  | "missing_execution_runner"
  | "missing_schedule"
  | "ready"
  | "running"
  | "blocked";

export type AutopilotBlockerCode =
  | "brief_not_confirmed"
  | "mission_plan_missing"
  | "team_not_ready"
  | "initial_tasks_missing"
  | "execution_runner_missing"
  | "schedule_rules_missing"
  | "execution_blocked";

export interface AutopilotBlocker {
  code: AutopilotBlockerCode;
  message: string;
  nextAction: string;
}

export interface AutopilotDiagnosisSignals {
  briefConfirmed: boolean;
  hasPlan: boolean;
  teamReady: boolean;
  hasInitialTasks: boolean;
  hasExecutionRunner: boolean;
  hasScheduleRules: boolean;
  hasRunningExecution: boolean;
}

export interface AutopilotDiagnosis {
  missionId: string;
  stage: AutopilotStage;
  ready: boolean;
  blockers: AutopilotBlocker[];
  signals: AutopilotDiagnosisSignals;
}

export interface AutopilotRuntimeSignals {
  hasExecutionRunner: boolean;
  hasPlan?: boolean;
}
```

- [ ] **Step 4: Implement diagnosis method**

Add this public method near `getAutomationSummary()`:

```ts
  getAutopilotDiagnosis(missionId: string, runtime: AutopilotRuntimeSignals): AutopilotDiagnosis {
    const mission = this.missions.get(missionId);
    if (!mission) {
      throw new Error(`Mission not found: ${missionId}`);
    }

    const missionAgents = [...this.agents.values()].filter((agent) => agent.missionId === missionId);
    const missionTasks = [...this.tasks.values()].filter((task) => task.missionId === missionId);
    const missionExecutions = [...this.executions.values()].filter((execution) => execution.missionId === missionId);
    const hasRunningExecution = missionExecutions.some((execution) => execution.status === "running");
    const hasFailedExecution = missionExecutions.some((execution) => execution.status === "failed");
    const hasBlockedAgent = missionAgents.some((agent) => agent.status === "blocked");
    const briefConfirmed = mission.briefConfirmed === true;
    const hasPlan = runtime.hasPlan === true;
    const teamReady = missionAgents.some((agent) => agent.role !== "owner" && agent.role !== "hr");
    const hasInitialTasks = missionTasks.some((task) =>
      task.status !== "completed" && task.status !== "failed" && task.status !== "cancelled"
    );
    const hasScheduleRules = mission.scheduleRules.length > 0;
    const signals: AutopilotDiagnosisSignals = {
      briefConfirmed,
      hasPlan,
      teamReady,
      hasInitialTasks,
      hasExecutionRunner: runtime.hasExecutionRunner,
      hasScheduleRules,
      hasRunningExecution,
    };
    const blockers: AutopilotBlocker[] = [];

    if (hasFailedExecution || hasBlockedAgent) {
      blockers.push({
        code: "execution_blocked",
        message: "Mission has a failed execution or blocked Agent.",
        nextAction: "Inspect the failed execution or blocked Agent before starting more automation.",
      });
    }
    if (!briefConfirmed) {
      blockers.push({
        code: "brief_not_confirmed",
        message: "MissionBrief has not been confirmed.",
        nextAction: "Finish Owner clarification and confirm the MissionBrief.",
      });
    }
    if (briefConfirmed && !hasPlan) {
      blockers.push({
        code: "mission_plan_missing",
        message: "MissionBrief is confirmed, but no MissionPlan exists yet.",
        nextAction: "Phase 4.6.1 should generate and confirm a MissionPlan before HR assembly.",
      });
    }
    if (briefConfirmed && hasPlan && !teamReady) {
      blockers.push({
        code: "team_not_ready",
        message: "No execution team has been assembled for this Mission.",
        nextAction: "Run plan-driven HR assembly to create the execution team.",
      });
    }
    if (briefConfirmed && hasPlan && teamReady && !hasInitialTasks) {
      blockers.push({
        code: "initial_tasks_missing",
        message: "The team is ready, but there are no executable tasks.",
        nextAction: "Generate initial tasks from the confirmed MissionPlan.",
      });
    }
    if (briefConfirmed && hasPlan && teamReady && hasInitialTasks && !runtime.hasExecutionRunner) {
      blockers.push({
        code: "execution_runner_missing",
        message: "Executable tasks exist, but no execution runner is available.",
        nextAction: "Configure OpenClaw or implement the Phase 4.6.4 execution runner abstraction.",
      });
    }
    if (briefConfirmed && hasPlan && teamReady && hasInitialTasks && runtime.hasExecutionRunner && !hasScheduleRules) {
      blockers.push({
        code: "schedule_rules_missing",
        message: "Mission has executable work, but no schedule rules are registered.",
        nextAction: "Bootstrap default daily check and weekly review schedules.",
      });
    }

    const stage: AutopilotStage = hasRunningExecution
      ? "running"
      : hasFailedExecution || hasBlockedAgent
        ? "blocked"
        : !briefConfirmed
          ? "briefing"
          : !hasPlan
            ? "missing_plan"
            : !teamReady
              ? "team_not_ready"
              : !hasInitialTasks
                ? "missing_initial_tasks"
                : !runtime.hasExecutionRunner
                  ? "missing_execution_runner"
                  : !hasScheduleRules
                    ? "missing_schedule"
                    : "ready";

    return {
      missionId,
      stage,
      ready: stage === "ready" || stage === "running",
      blockers,
      signals,
    };
  }
```

- [ ] **Step 5: Run diagnosis tests**

Run:

```bash
pnpm --filter @digitalagent/server test -- mission-service.test.ts -t "diagnoses"
```

Expected: PASS.

- [ ] **Step 6: Run mission service tests**

Run:

```bash
pnpm --filter @digitalagent/server test -- mission-service.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/mission-service.ts apps/server/src/mission-service.test.ts
git commit -m "feat: diagnose mission autopilot state"
```

---

### Task 2: Autopilot Diagnosis API

**Files:**
- Modify: `apps/server/src/api.ts`
- Modify: `apps/server/src/api.test.ts`

- [ ] **Step 1: Add failing API tests**

Append inside `describe("handleApiRequest", () => { ... })` in `apps/server/src/api.test.ts`:

```ts
  it("GET /api/missions/:id/autopilot-diagnosis returns diagnosis with OpenClaw available", async () => {
    const missions = new InMemoryMissionService();
    const mission = await missions.createMission({ goal: "Grow GitHub repositories" });

    const resp = await handleApiRequest(
      { method: "GET", path: `/api/missions/${mission.id}/autopilot-diagnosis` },
      { missions, openclaw: fakeOpenClaw() },
    );

    expect(resp.status).toBe(200);
    expect(resp.body).toMatchObject({
      diagnosis: {
        missionId: mission.id,
        stage: "briefing",
        ready: false,
        signals: {
          hasExecutionRunner: true,
        },
      },
    });
  });

  it("GET /api/missions/:id/autopilot-diagnosis reports missing runner when OpenClaw is unavailable", async () => {
    const missions = new InMemoryMissionService();
    const mission = await createMissionViaApi(missions);
    const unavailableOpenClaw: Pick<OpenClawCliAdapter, "health" | "runAgentTask"> = {
      async health() {
        return { available: false, error: "openclaw missing" };
      },
      async runAgentTask() {
        throw new Error("openclaw missing");
      },
    };

    const resp = await handleApiRequest(
      { method: "GET", path: `/api/missions/${mission}/autopilot-diagnosis` },
      { missions, openclaw: unavailableOpenClaw },
    );

    expect(resp.status).toBe(200);
    expect((resp.body as { diagnosis: { signals: { hasExecutionRunner: boolean } } }).diagnosis.signals.hasExecutionRunner).toBe(false);
  });
```

- [ ] **Step 2: Run API tests and verify failure**

Run:

```bash
pnpm --filter @digitalagent/server test -- api.test.ts -t "autopilot-diagnosis"
```

Expected: FAIL with 404 response or missing route.

- [ ] **Step 3: Add API route**

In `apps/server/src/api.ts`, before `automationSummaryMatch`, add:

```ts
    const autopilotDiagnosisMatch = request.path.match(/^\/api\/missions\/([^/]+)\/autopilot-diagnosis$/);
    if (autopilotDiagnosisMatch) {
      const missionId = autopilotDiagnosisMatch[1];
      if (!missionId) {
        return json(400, { error: "Mission ID required" });
      }
      if (request.method === "GET") {
        const openclawHealth = await deps.openclaw.health();
        return json(200, {
          diagnosis: deps.missions.getAutopilotDiagnosis(missionId, {
            hasExecutionRunner: openclawHealth.available,
          }),
        });
      }
    }
```

- [ ] **Step 4: Run targeted API tests**

Run:

```bash
pnpm --filter @digitalagent/server test -- api.test.ts -t "autopilot-diagnosis"
```

Expected: PASS.

- [ ] **Step 5: Run API test file**

Run:

```bash
pnpm --filter @digitalagent/server test -- api.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/api.ts apps/server/src/api.test.ts
git commit -m "feat: expose autopilot diagnosis API"
```

---

### Task 3: War Room Autopilot Diagnosis Panel

**Files:**
- Modify: `apps/server/public/app.js`
- Modify: `apps/server/public/war-room.js`
- Modify: `apps/server/public/styles.css`

- [ ] **Step 1: Add frontend diagnosis state and loader**

In `apps/server/public/app.js`, add to `state`:

```js
  autopilotDiagnosisByMissionId: {},
```

After `loadAutomationState(missionId)`, add:

```js
async function loadAutopilotDiagnosis(missionId) {
  if (!missionId) return;
  const result = await api(`/api/missions/${missionId}/autopilot-diagnosis`);
  state.autopilotDiagnosisByMissionId[missionId] = result.diagnosis;
}
```

- [ ] **Step 2: Load diagnosis with War Room refresh**

In `refreshMissionAutomation()`, after `await loadAutomationState(mission.id);`, add:

```js
  await loadAutopilotDiagnosis(mission.id);
```

In the `[data-open-war-room]` click handler, after each `await loadAutomationState(mission.id);`, add:

```js
      await loadAutopilotDiagnosis(mission.id);
```

- [ ] **Step 3: Render diagnosis panel**

In `apps/server/public/war-room.js`, add after `renderAutomationPulse(...)` in `renderWarOverview(data)`:

```js
    ${renderAutopilotDiagnosis(state.autopilotDiagnosisByMissionId[data.mission.id])}
```

Add before `renderAutomationPulse(data, summary)`:

```js
function renderAutopilotDiagnosis(diagnosis) {
  if (!diagnosis) {
    return `
      <div class="autopilot-diagnosis">
        <div>
          <span>Autopilot 状态</span>
          <strong>正在读取启动诊断</strong>
          <p>系统正在判断 Mission 为什么还没有自动运行。</p>
        </div>
      </div>
    `;
  }
  const blocker = diagnosis.blockers[0];
  const signals = diagnosis.signals;
  return `
    <div class="autopilot-diagnosis ${diagnosis.ready ? "ready" : "blocked"}">
      <div class="autopilot-main">
        <span>Autopilot 状态</span>
        <strong>${esc(autopilotStageText(diagnosis.stage))}</strong>
        <p>${blocker ? esc(blocker.message) : "Mission 已具备启动自动运行的基础条件。"}</p>
        ${blocker ? `<p class="autopilot-next">下一步：${esc(blocker.nextAction)}</p>` : ""}
      </div>
      <div class="autopilot-signals">
        ${renderAutopilotSignal("Brief", signals.briefConfirmed)}
        ${renderAutopilotSignal("Plan", signals.hasPlan)}
        ${renderAutopilotSignal("Team", signals.teamReady)}
        ${renderAutopilotSignal("Tasks", signals.hasInitialTasks)}
        ${renderAutopilotSignal("Runner", signals.hasExecutionRunner)}
        ${renderAutopilotSignal("Schedule", signals.hasScheduleRules)}
      </div>
    </div>
  `;
}

function renderAutopilotSignal(label, ok) {
  return `<span class="${ok ? "ok" : "missing"}">${esc(label)}</span>`;
}

function autopilotStageText(stage) {
  const map = {
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
  return map[stage] || stage;
}
```

- [ ] **Step 4: Add diagnosis styles**

In `apps/server/public/styles.css`, add near `.automation-pulse`:

```css
.autopilot-diagnosis {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 14px;
  align-items: center;
  margin-bottom: 18px;
  border: 1px solid #d8dee8;
  border-radius: 12px;
  background: #ffffff;
  padding: 16px;
}
.autopilot-diagnosis.blocked {
  border-color: #f2c94c;
  background: #fffaf0;
}
.autopilot-diagnosis.ready {
  border-color: #abefc6;
  background: #f6fef9;
}
.autopilot-main span {
  display: block;
  margin-bottom: 5px;
  color: #667085;
  font-size: 12px;
  font-weight: 900;
}
.autopilot-main strong {
  display: block;
  margin-bottom: 5px;
  font-size: 16px;
}
.autopilot-main p {
  margin: 0;
  color: #5d6675;
  font-size: 13px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}
.autopilot-main .autopilot-next {
  margin-top: 5px;
  color: #344054;
  font-weight: 800;
}
.autopilot-signals {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 6px;
  max-width: 320px;
}
.autopilot-signals span {
  border-radius: 999px;
  padding: 5px 8px;
  font-size: 12px;
  font-weight: 900;
}
.autopilot-signals .ok {
  background: #ecfdf3;
  color: #067647;
}
.autopilot-signals .missing {
  background: #f2f4f7;
  color: #667085;
}
@media (max-width: 760px) {
  .autopilot-diagnosis {
    grid-template-columns: 1fr;
  }
  .autopilot-signals {
    justify-content: flex-start;
    max-width: none;
  }
}
```

- [ ] **Step 5: Build**

Run:

```bash
pnpm --filter @digitalagent/server build
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/server/public/app.js apps/server/public/war-room.js apps/server/public/styles.css
git commit -m "feat: show autopilot diagnosis in war room"
```

---

### Task 4: Verification And Browser Acceptance

**Files:**
- No code changes expected unless verification finds defects.

- [ ] **Step 1: Run targeted server tests**

Run:

```bash
pnpm --filter @digitalagent/server test -- mission-service.test.ts api.test.ts -t "diagnoses|autopilot-diagnosis"
```

Expected: PASS.

- [ ] **Step 2: Run full server tests**

Run:

```bash
pnpm --filter @digitalagent/server test
```

Expected: PASS.

- [ ] **Step 3: Run workspace typecheck**

Run:

```bash
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 4: Start local server**

Run:

```bash
pnpm dev
```

Expected output includes:

```text
DigitalAgent running at http://127.0.0.1:3000
```

- [ ] **Step 5: Browser verify War Room panel**

Use the in-app browser at `http://127.0.0.1:3000`.

Expected:

- Enter War Room for an existing Mission.
- Automation pulse still appears.
- Autopilot panel appears below automation pulse.
- Panel shows stage text, blocker message, next action, and signal chips.
- There are no new action buttons in the panel.
- Browser console has no errors.

- [ ] **Step 6: Verify API manually**

Run:

```bash
MISSION_ID=$(curl -s http://127.0.0.1:3000/api/snapshot | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{const s=JSON.parse(d); console.log(s.missions[0]?.id || "");})')
curl -s "http://127.0.0.1:3000/api/missions/$MISSION_ID/autopilot-diagnosis" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>console.log(JSON.stringify(JSON.parse(d), null, 2)));'
```

Expected:

- JSON includes `diagnosis.stage`.
- JSON includes `diagnosis.signals`.
- JSON includes `diagnosis.blockers`.

- [ ] **Step 7: Stop dev server**

Stop the `pnpm dev` process with `Ctrl-C`.

- [ ] **Step 8: Commit fixes if verification found defects**

If verification required code changes:

```bash
git add apps/server/src apps/server/public
git commit -m "fix: stabilize autopilot diagnosis"
```

If no code changes were needed, do not create an empty commit.
