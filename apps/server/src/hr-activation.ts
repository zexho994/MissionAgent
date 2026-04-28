import {
  createId,
  createTask,
  type Mission,
  type Task,
  type TeamContext,
} from "@digitalagent/core";
import type { LlmService } from "@digitalagent/runtime";
import { createHRAgent } from "./hr-agent.js";
import { createAgentFactory } from "./agent-factory.js";
import { createAgentOnboardingContext } from "@digitalagent/core";
import type { WarRoomAgent, AgentRelation, AgentMessage } from "./mission-service.js";

export interface HRActivationResult {
  task: Task;
  agents: WarRoomAgent[];
  relations: AgentRelation[];
  messages: Omit<AgentMessage, "id" | "createdAt">[];
}

export async function activateWithHRAgent(
  mission: Mission,
  llm: LlmService,
): Promise<HRActivationResult> {
  const hrAgent = createHRAgent({ llm });
  const agentFactory = createAgentFactory();

  const analysis = await hrAgent.receiveMissionBrief(mission.brief!);
  const roleSpecs = await hrAgent.generateRoleSpecs(mission.id, analysis);
  const proposal = await hrAgent.proposeTeam(mission.id, roleSpecs);

  const agents = proposal.roles.map((spec, index) =>
    agentFactory.createAgentFromRoleSpec(mission.id, spec, index + 1),
  );
  const relations = agentFactory.setupRelations(agents);

  const initialTask = createTask({
    missionId: mission.id,
    title: `Execute: ${mission.goal}`,
    dependencies: [],
    contract: {
      objective: `Execute the mission: ${mission.goal}`,
      input: {
        goal: mission.goal,
        successMetrics: mission.successMetrics,
        constraints: mission.constraints,
        teamProposal: proposal,
      },
      outputSchema: { results: "array", risks: "array" },
      successCriteria: [
        "All deliverables produced according to role specs",
        "Success metrics from mission brief are addressed",
      ],
    },
    approvalRequired: false,
  });

  const hrAgentRecord: WarRoomAgent = {
    id: createId("agent"),
    missionId: mission.id,
    role: "hr",
    name: "HR Agent",
    responsibility: "Team assembly and agent coordination",
    status: "done",
    currentTaskId: undefined,
    lastAction: "Assembled team via LLM analysis",
    avatarSeed: "hr",
    sortOrder: agents.length + 1,
  };

  const messages: Omit<AgentMessage, "id" | "createdAt">[] = [];

  for (const agent of agents) {
    if (agent.role !== "owner" && agent.role !== "hr") {
      const teamMembers = agents.filter((a) => a.id !== agent.id).map((a) => a.name);
      const collaborators = agents
        .filter((a) => a.role !== "owner" && a.role !== "hr" && a.id !== agent.id)
        .map((a) => a.name);

      const teamContext: TeamContext = {
        teamMembers,
        reportingLine: "owner",
        collaborators,
      };

      const spec = proposal.roles.find((r) => r.id === agent.role);
      if (spec) {
        const onboarding = createAgentOnboardingContext({
          agentId: agent.id,
          missionId: mission.id,
          roleSpec: spec,
          teamContext,
          initialInstructions: `Welcome to mission: ${mission.goal}. Your role: ${agent.responsibility}`,
        });
        messages.push({
          missionId: mission.id,
          fromAgentId: hrAgentRecord.id,
          toAgentId: agent.id,
          type: "team_created",
          content: `Onboarding context created for ${agent.name}: ${onboarding.initialInstructions}`,
        });
      }
    }
  }

  messages.push({
    missionId: mission.id,
    fromAgentId: hrAgentRecord.id,
    type: "team_created",
    content: `HR Agent assembled a team of ${agents.length} agents for this mission. Roles: ${proposal.roles.map((r) => r.name).join(", ")}. Estimated duration: ${proposal.estimatedDuration}.`,
  });

  return {
    task: initialTask,
    agents: [...agents, hrAgentRecord],
    relations,
    messages,
  };
}
