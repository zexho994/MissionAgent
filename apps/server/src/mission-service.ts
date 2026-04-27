import {
  createArtifact,
  createId,
  createMission,
  createReview,
  createTask,
  transitionTask,
  type Artifact,
  type Mission,
  type Review,
  type Task,
} from "@digitalagent/core";

export interface CreateMissionRequest {
  goal: string;
  successMetrics: string[];
  constraints: string[];
}

export interface SubmitExecutionResultRequest {
  executionId: string;
  missionId: string;
  taskId: string;
  content: Record<string, unknown>;
  evidence: string[];
}

export interface StartExecutionRequest {
  missionId: string;
  taskId: string;
}

export interface FailExecutionRequest {
  executionId: string;
  error: string;
}

export interface Execution {
  id: string;
  missionId: string;
  taskId: string;
  status: "running" | "completed" | "failed";
  startedAt: string;
  completedAt?: string;
  artifactId?: string;
  reviewId?: string;
  error?: string;
}

export interface MissionSnapshot {
  missions: Mission[];
  tasks: Task[];
  artifacts: Artifact[];
  reviews: Review[];
  executions: Execution[];
}

export class InMemoryMissionService {
  private readonly missions = new Map<string, Mission>();
  private readonly tasks = new Map<string, Task>();
  private readonly artifacts = new Map<string, Artifact>();
  private readonly reviews = new Map<string, Review>();
  private readonly executions = new Map<string, Execution>();

  createMission(input: CreateMissionRequest): Mission {
    const mission = createMission({
      ...input,
      budget: {
        maxRuntimeMinutes: 180,
        maxTokenSpendUsd: 20,
      },
    });

    const initialTask = createTask({
      missionId: mission.id,
      title: "Define mission team and first execution plan",
      dependencies: [],
      contract: {
        objective: "Create a first-pass team plan and execution plan for this mission",
        input: {
          goal: mission.goal,
          successMetrics: mission.successMetrics,
          constraints: mission.constraints,
        },
        outputSchema: {
          teamPlan: "array",
          firstTasks: "array",
          risks: "array",
        },
        successCriteria: [
          "Every proposed role has a clear responsibility",
          "First tasks are executable and reviewable",
        ],
      },
      approvalRequired: false,
    });

    this.missions.set(mission.id, mission);
    this.tasks.set(initialTask.id, initialTask);
    return mission;
  }

  startExecution(input: StartExecutionRequest): Execution {
    const mission = this.missions.get(input.missionId);
    if (!mission) {
      throw new Error(`Mission not found: ${input.missionId}`);
    }

    const task = this.tasks.get(input.taskId);
    if (!task || task.missionId !== mission.id) {
      throw new Error(`Task not found in mission: ${input.taskId}`);
    }

    const existing = [...this.executions.values()].find(
      (execution) => execution.taskId === task.id && execution.status === "running",
    );
    if (existing) {
      throw new Error(`Task already has a running execution: ${task.id}`);
    }

    const runningTask = ensureTaskRunning(task);
    this.tasks.set(runningTask.id, runningTask);

    const execution: Execution = {
      id: createId("execution"),
      missionId: mission.id,
      taskId: runningTask.id,
      status: "running",
      startedAt: new Date().toISOString(),
    };
    this.executions.set(execution.id, execution);
    return execution;
  }

  submitExecutionResult(input: SubmitExecutionResultRequest): { artifact: Artifact; review: Review } {
    const mission = this.missions.get(input.missionId);
    if (!mission) {
      throw new Error(`Mission not found: ${input.missionId}`);
    }

    const task = this.tasks.get(input.taskId);
    if (!task || task.missionId !== mission.id) {
      throw new Error(`Task not found in mission: ${input.taskId}`);
    }

    const execution = this.executions.get(input.executionId);
    if (!execution || execution.taskId !== task.id || execution.status !== "running") {
      throw new Error(`Running execution not found: ${input.executionId}`);
    }

    const runningTask = task.status === "running" ? task : ensureTaskRunning(task);
    const artifact = createArtifact({
      taskId: runningTask.id,
      type: "execution_log",
      content: input.content,
      evidence: input.evidence,
      qualityScore: 0.8,
    });
    const submittedTask = transitionTask(runningTask, {
      type: "artifact.submitted",
      artifactId: artifact.id,
    });
    const reviewingTask = transitionTask(submittedTask, { type: "review.started" });
    const review = createReview({
      artifactId: artifact.id,
      reviewerAgentId: "system_evaluator",
      decision: "approve",
      comments: ["Execution artifact captured for the next planning step"],
    });
    const completedTask = transitionTask(reviewingTask, {
      type: "review.approved",
      reviewId: review.id,
    });

    this.artifacts.set(artifact.id, artifact);
    this.reviews.set(review.id, review);
    this.tasks.set(completedTask.id, completedTask);
    this.executions.set(execution.id, {
      ...execution,
      status: "completed",
      completedAt: new Date().toISOString(),
      artifactId: artifact.id,
      reviewId: review.id,
    });

    return { artifact, review };
  }

  failExecution(input: FailExecutionRequest): Execution {
    if (!input.error.trim()) {
      throw new Error("Execution error is required");
    }

    const execution = this.executions.get(input.executionId);
    if (!execution || execution.status !== "running") {
      throw new Error(`Running execution not found: ${input.executionId}`);
    }

    const failed: Execution = {
      ...execution,
      status: "failed",
      completedAt: new Date().toISOString(),
      error: input.error,
    };
    this.executions.set(failed.id, failed);
    return failed;
  }

  snapshot(): MissionSnapshot {
    return {
      missions: [...this.missions.values()],
      tasks: [...this.tasks.values()],
      artifacts: [...this.artifacts.values()],
      reviews: [...this.reviews.values()],
      executions: [...this.executions.values()],
    };
  }
}

function ensureTaskRunning(task: Task): Task {
  if (task.status === "running") {
    return task;
  }
  if (task.status !== "draft") {
    throw new Error(`Task cannot be executed from status: ${task.status}`);
  }

  const ready = transitionTask(task, { type: "contract.completed" });
  const queued = transitionTask(ready, { type: "dependencies.met" });
  return transitionTask(queued, { type: "worker.assigned", agentInstanceId: "openclaw_runner" });
}
