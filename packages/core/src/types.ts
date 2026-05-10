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
  dataSources?: MissionDataSource[];
  publishTargets?: MissionPublishTarget[];
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

export type TaskOriginType = "initial" | "scheduled" | "followup";

export interface TaskOrigin {
  type: TaskOriginType;
  reason?: string;
  sourceTaskId?: string;
  triggeredByEventId?: string;
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
  origin?: TaskOrigin;
}

export type ArtifactType = "research_report" | "content_draft" | "metric_snapshot" | "execution_log";

export interface Source {
  url?: string;
  title?: string;
  snippet?: string;
  searchKeyword?: string;
}

export interface Artifact {
  id: string;
  taskId: string;
  type: ArtifactType;
  content: Record<string, unknown>;
  evidence: string[];
  sources: Source[];
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

export type MissionOutcomeEvaluationSource = "execution_result" | "execution_failure" | "manual";
export type MissionOutcome = "advanced" | "neutral" | "blocked" | "regressed";

export interface MissionOutcomeEvaluation {
  id: string;
  missionId: string;
  taskId: string;
  artifactId?: string;
  reviewId?: string;
  source: MissionOutcomeEvaluationSource;
  outcome: MissionOutcome;
  contributionScore: number;
  summary: string;
  evidence: string[];
  risks: string[];
  recommendedNextActions: string[];
  createdAt: string;
}

export type TaskFailureType =
  | "missing_information"
  | "agent_mismatch"
  | "unclear_task"
  | "external_blocker"
  | "low_quality_output"
  | "execution_error";

export type RecommendedRecovery =
  | "ask_user"
  | "revise_task"
  | "split_task"
  | "reassign_agent"
  | "adjust_strategy";

export interface TaskFailureAnalysis {
  id: string;
  missionId: string;
  taskId: string;
  artifactId?: string;
  reviewId?: string;
  failureType: TaskFailureType;
  summary: string;
  rootCause: string;
  recommendedRecovery: RecommendedRecovery;
  recommendedNextActions: string[];
  createdAt: string;
}

export type StrategyAdjustmentStatus = "proposed" | "accepted" | "rejected" | "superseded";

export interface StrategyAdjustment {
  id: string;
  missionId: string;
  triggeredByEvaluationId?: string;
  triggeredByFailureAnalysisId?: string;
  status: StrategyAdjustmentStatus;
  previousStrategy: string;
  proposedStrategy: string;
  rationale: string;
  affectedAgentRoles: string[];
  proposedTaskGoals: string[];
  requiresHrReview: boolean;
  createdAt: string;
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

export interface ScheduledTaskTemplate {
  id: string;                            // "daily_metric_check"
  name: string;                          // "Daily metric check"
  description: string;                   // shown to HR's LLM as catalog
  applicableRolePatterns: string[];      // regex strings — which roles fit
  trigger: ScheduleTrigger;              // pre-baked
  taskTemplate: {
    titleTemplate: string;               // "{{role.name}} 每日数据检查"
    contract: TaskContract;
    priority: "low" | "normal" | "high";
  };
  maxConcurrent: number;
  metadata: Record<string, unknown>;     // includes { source: "builtin", templateId }
}

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

export type MissionDataSourceStatus = "idle" | "fetching" | "ok" | "failed";

export interface HttpDataSourceConfig {
  url: string;
  method: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
}

export interface DataSourceFetchRecord {
  id: string;
  fetchedAt: string;
  status: "ok" | "failed";
  knowledgeEntryId?: string;
  errorMessage?: string;
}

export interface MissionDataSource {
  id: string;
  missionId: string;
  name: string;
  adapter: "http";
  config: HttpDataSourceConfig;
  status: MissionDataSourceStatus;
  fetchHistory: DataSourceFetchRecord[];
  createdAt: string;
  lastFetchedAt?: string;
}

export type MissionPublishTargetStatus = "idle" | "publishing" | "ok" | "failed";

export interface HttpPublishTargetConfig {
  url: string;
  method: "POST" | "PUT";
  headers?: Record<string, string>;
}

export interface PublishAttempt {
  id: string;
  targetId: string;
  artifactId: string;
  attemptedAt: string;
  status: "ok" | "failed";
  responseSnippet?: string;
  errorMessage?: string;
}

export interface MissionPublishTarget {
  id: string;
  missionId: string;
  name: string;
  adapter: "http";
  config: HttpPublishTargetConfig;
  status: MissionPublishTargetStatus;
  contentTypes: string[];
  attempts: PublishAttempt[];
  createdAt: string;
  lastAttemptAt?: string;
}
