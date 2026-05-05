export type MissionStatus = "active" | "paused" | "completed" | "cancelled";

export interface MissionBudget {
  maxRuntimeMinutes: number;
  maxTokenSpendUsd?: number;
}

export interface MissionBrief {
  goal: string;
  scope: string;
  constraints: string[];
  successMetrics: string[];
  keyAssumptions: string[];
  targetAudience?: string | undefined;
  timeline?: string | undefined;
}

export type MissionPlanStatus = "draft" | "confirmed" | "superseded";

export interface MissionPlanPhase {
  name: string;
  objective: string;
  deliverables: string[];
  successCriteria: string[];
}

export interface MissionPlanWorkstream {
  name: string;
  objective: string;
  requiredRole: string;
  responsibilities: string[];
  firstTaskGoal: string;
}

export interface MissionPlanReportingLine {
  fromRole: string;
  toRole: string;
  cadence: string;
  purpose: string;
}

export interface MissionPlanScheduleRhythm {
  name: string;
  cadence: string;
  ownerRole: string;
  purpose: string;
}

export interface MissionPlan {
  id: string;
  missionId: string;
  status: MissionPlanStatus;
  createdAt: Date;
  confirmedAt?: Date;
  revision: number;
  feedback?: string;
  goal: string;
  successMetrics: string[];
  phases: MissionPlanPhase[];
  workstreams: MissionPlanWorkstream[];
  reportingLines: MissionPlanReportingLine[];
  scheduleRhythms: MissionPlanScheduleRhythm[];
  risks: string[];
  checkpoints: string[];
}

export interface Mission {
  id: string;
  goal: string;
  successMetrics: string[];
  constraints: string[];
  status: MissionStatus;
  budget: MissionBudget;
  createdAt: Date;
  brief?: MissionBrief;
  briefConfirmed?: boolean;
  confirmedPlanId?: string;
  scheduleRules: ScheduleRule[];
}

export interface RoleBudget {
  maxRuntimeMinutes: number;
  maxTasks: number;
}

export interface RoleSpec {
  id: string;
  name: string;
  purpose: string;
  responsibilities: string[];
  allowedTools: string[];
  inputContract: Record<string, unknown>;
  outputContract: Record<string, unknown>;
  successCriteria: string[];
  budget: RoleBudget;
}

export type AgentStatus = "idle" | "running" | "blocked" | "retired";
export type MemoryScope = "mission" | "task" | "none";

export interface AgentInstance {
  id: string;
  missionId: string;
  roleSpec: RoleSpec;
  status: AgentStatus;
  memoryScope: MemoryScope;
  toolPermissions: string[];
  budget: RoleBudget;
}

export type TaskStatus =
  | "draft"
  | "ready"
  | "queued"
  | "running"
  | "waiting_tool"
  | "waiting_approval"
  | "submitted"
  | "reviewing"
  | "revision_needed"
  | "completed"
  | "failed"
  | "cancelled";

export interface TaskContract {
  objective: string;
  input: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  successCriteria: string[];
}

export interface Task {
  id: string;
  missionId: string;
  title: string;
  status: TaskStatus;
  dependencies: string[];
  contract: TaskContract;
  approvalRequired: boolean;
  assigneeAgentId?: string;
  artifactId?: string;
  reviewId?: string;
  failureReason?: string;
  scheduleRuleId?: string;
}

export type ArtifactType = "research_report" | "content_draft" | "metric_snapshot" | "execution_log";

export interface Artifact {
  id: string;
  taskId: string;
  type: ArtifactType;
  content: Record<string, unknown>;
  evidence: string[];
  qualityScore?: number;
  createdAt: Date;
}

export type ReviewDecision = "approve" | "revise" | "reject";

export interface Review {
  id: string;
  artifactId: string;
  reviewerAgentId: string;
  decision: ReviewDecision;
  comments: string[];
  createdAt: Date;
}

export type TaskEvent =
  | { type: "contract.completed" }
  | { type: "dependencies.met" }
  | { type: "worker.assigned"; agentInstanceId: string }
  | { type: "tool.requested"; toolCallId: string }
  | { type: "tool.completed" }
  | { type: "approval.required" }
  | { type: "approval.granted" }
  | { type: "artifact.submitted"; artifactId: string }
  | { type: "review.started" }
  | { type: "review.approved"; reviewId: string }
  | { type: "review.revision_requested"; reviewId: string }
  | { type: "review.rejected"; reviewId: string; reason: string }
  | { type: "task.updated" }
  | { type: "task.failed"; reason: string }
  | { type: "task.retry" }
  | { type: "task.cancelled" };

// --- Schedule Types ---

export interface CronTrigger {
  type: "cron";
  expression: string;
  timezone: string;
}

export interface ConditionTrigger {
  type: "condition";
  description: string;
  sourceAgentRole: string;
  evaluatePrompt: string;
}

export type ScheduleTrigger = CronTrigger | ConditionTrigger;

export interface ScheduleRule {
  id: string;
  name: string;
  missionId: string;
  enabled: boolean;
  trigger: ScheduleTrigger;
  taskTemplate: {
    title: string;
    contract: TaskContract;
    assigneeRole: string;
    priority: "low" | "normal" | "high";
  };
  maxConcurrent: number;
  metadata: Record<string, unknown>;
}
