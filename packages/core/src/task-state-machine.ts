import type { Task, TaskEvent, TaskStatus } from "./types.js";

type TransitionHandler = (task: Task, event: TaskEvent) => Task;

function invalid(task: Task, event: TaskEvent): never {
  throw new Error(`Invalid task transition: ${task.status} -> ${event.type}`);
}

function withStatus(task: Task, status: TaskStatus): Task {
  return { ...task, status };
}

const transitions: Record<TaskStatus, TransitionHandler> = {
  draft(task, event) {
    if (event.type === "contract.completed") return withStatus(task, "ready");
    if (event.type === "task.cancelled") return withStatus(task, "cancelled");
    return invalid(task, event);
  },
  ready(task, event) {
    if (event.type === "dependencies.met") return withStatus(task, "queued");
    if (event.type === "task.cancelled") return withStatus(task, "cancelled");
    return invalid(task, event);
  },
  queued(task, event) {
    if (event.type === "worker.assigned") {
      return { ...task, status: "running", assigneeAgentId: event.agentInstanceId };
    }
    if (event.type === "task.cancelled") return withStatus(task, "cancelled");
    return invalid(task, event);
  },
  running(task, event) {
    if (event.type === "tool.requested") return withStatus(task, "waiting_tool");
    if (event.type === "approval.required") return withStatus(task, "waiting_approval");
    if (event.type === "artifact.submitted") {
      return { ...task, status: "submitted", artifactId: event.artifactId };
    }
    if (event.type === "task.failed") {
      return { ...task, status: "failed", failureReason: event.reason };
    }
    if (event.type === "task.cancelled") return withStatus(task, "cancelled");
    return invalid(task, event);
  },
  waiting_tool(task, event) {
    if (event.type === "tool.completed") return withStatus(task, "running");
    if (event.type === "task.failed") {
      return { ...task, status: "failed", failureReason: event.reason };
    }
    if (event.type === "task.cancelled") return withStatus(task, "cancelled");
    return invalid(task, event);
  },
  waiting_approval(task, event) {
    if (event.type === "approval.granted") return withStatus(task, "running");
    if (event.type === "task.cancelled") return withStatus(task, "cancelled");
    return invalid(task, event);
  },
  submitted(task, event) {
    if (event.type === "review.started") return withStatus(task, "reviewing");
    return invalid(task, event);
  },
  reviewing(task, event) {
    if (event.type === "review.approved") {
      return { ...task, status: "completed", reviewId: event.reviewId };
    }
    if (event.type === "review.revision_requested") {
      return { ...task, status: "revision_needed", reviewId: event.reviewId };
    }
    if (event.type === "review.rejected") {
      return {
        ...task,
        status: "failed",
        reviewId: event.reviewId,
        failureReason: event.reason,
      };
    }
    return invalid(task, event);
  },
  revision_needed(task, event) {
    if (event.type === "task.updated") return withStatus(task, "ready");
    if (event.type === "task.cancelled") return withStatus(task, "cancelled");
    return invalid(task, event);
  },
  failed(task, event) {
    if (event.type === "task.retry") {
      const { failureReason: _failureReason, ...retryTask } = task;
      return { ...retryTask, status: "ready" };
    }
    if (event.type === "task.cancelled") return withStatus(task, "cancelled");
    return invalid(task, event);
  },
  completed(task, event) {
    return invalid(task, event);
  },
  cancelled(task, event) {
    return invalid(task, event);
  },
};

export function transitionTask(task: Task, event: TaskEvent): Task {
  return transitions[task.status](task, event);
}
