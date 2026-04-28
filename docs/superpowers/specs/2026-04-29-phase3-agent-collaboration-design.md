# Phase 3: Agent-to-Agent Collaboration Design

## Overview

Phase 3 transforms agent communication from structured events into LLM-driven conversations. Agents think independently, respond to events with natural language, and collaborate through four mechanisms: report, request, notify, and discuss.

### Key Decisions

- **LLM drives each agent**: Every agent independently calls LLM to reason and respond
- **Event-driven**: No background loops. Events trigger agent responses via ConversationBus
- **Dynamic context retrieval**: Context is built from existing data at conversation time (no vector DB)
- **Max conversation depth**: 5 rounds per trigger to prevent infinite loops

## 1. Core Type Changes

### 1.1 New AgentMessageTypes

Add to existing `AgentMessageType` union:

```typescript
type AgentMessageType =
  // existing
  | "user_message" | "mission_brief" | "owner_followup"
  | "team_created" | "task_plan"
  | "execution_started" | "execution_completed" | "execution_failed"
  | "review_completed"
  // new
  | "agent_chat"       // free-form conversation
  | "agent_report"     // subordinate → superior status update
  | "agent_request"    // asking another agent for information/assistance
  | "agent_notify"     // proactive anomaly/insight broadcast
  | "agent_discussion" // multi-agent topic thread
```

### 1.2 AgentMessage Extensions

New optional fields on `AgentMessage`:

```typescript
interface AgentMessage {
  // ...existing fields unchanged
  threadId?: string;              // links messages in same conversation thread
  replyToId?: string;             // which message this replies to
  mentionedAgentIds?: string[];   // @mentioned agents (discussion/notify)
  metadata?: Record<string, unknown>; // extra info (urgency, etc.)
}
```

All new fields are optional. Existing message types never use them.

### 1.3 ConversationThread

New top-level type for tracking multi-message conversations:

```typescript
interface ConversationThread {
  id: string;
  missionId: string;
  topic: string;                  // LLM-generated topic summary
  participantAgentIds: string[];
  status: "active" | "resolved" | "abandoned";
  triggerEventId?: string;        // event that started this thread
  createdAt: string;
  resolvedAt?: string;
}
```

Stored in `InMemoryMissionService.threads` map, included in `MissionSnapshot`.

## 2. AgentConversationBus

### 2.1 Architecture

The bus is a class inside `InMemoryMissionService`, not a standalone service. It hooks into existing event emission points.

```
Event happens (execution_completed, review_revision_needed, etc.)
  → Bus.dispatchEvent(event, context)
  → Bus matches relevant agents via rules
  → For each matched agent:
      → Build conversation context (persona + history + shared context)
      → Call LLM
      → Parse response into AgentConversationResponse
      → Store as AgentMessage
      → If shouldPropagate: dispatch new event (depth + 1)
  → Guard: max depth 5, cooldown 30s per agent pair, dedup acknowledgments
```

### 2.2 Bus Class

```typescript
class AgentConversationBus {
  constructor(deps: {
    llm: LlmService;
    personas: AgentPersonaRegistry;
    contextRetriever: ContextRetriever;
    missionService: InMemoryMissionService;
  });

  dispatchEvent(input: {
    missionId: string;
    event: BusEvent;
    triggerDepth?: number;
  }): Promise<void>;
}
```

### 2.3 BusEvent

```typescript
type BusEvent =
  | { type: "execution_completed"; agentId: string; taskId: string; artifactId: string }
  | { type: "execution_failed"; agentId: string; taskId: string; error: string }
  | { type: "review_completed"; agentId: string; taskId: string; decision: string }
  | { type: "review_revision_needed"; agentId: string; taskId: string; comments: string[] }
  | { type: "agent_request"; fromAgentId: string; toAgentId: string; content: string }
  | { type: "agent_notify"; fromAgentId: string; content: string; mentionedAgentIds: string[] }
  | { type: "user_message"; content: string };
```

### 2.4 Agent Relevance Rules

| Event | Always Notify (status update) | LLM Responds |
|-------|-------------------------------|---------------|
| execution_completed | Reviewer (existing flow) | Owner, Planner |
| execution_failed | Owner | Planner, Worker |
| review_revision_needed | Worker (existing flow) | Planner |
| agent_request | Target Agent | Target Agent |
| agent_notify | mentionedAgentIds | mentionedAgentIds |
| review_completed | Task assignee | Owner |

### 2.5 Loop Prevention

- **Max depth**: 5 conversation rounds per trigger event
- **Cooldown**: Same agent pair cannot re-engage within 30 seconds
- **Dedup**: If LLM response is acknowledgment without new info (`shouldPropagate: false`), chain stops
- **Human gate**: Actions like "publish content" or "spend budget" always require user approval

## 3. Agent Persona and Prompt System

### 3.1 AgentPersona

```typescript
interface AgentPersona {
  role: string;
  systemPrompt: string;         // role definition
  communicationStyle: string;   // how this agent talks
  responseGuidelines: string;   // when to respond vs stay silent
  availableActions: string[];   // actions this agent can take
}
```

Stored in `apps/server/src/agent-personas.ts`. Each agent role has a persona definition.

Example — Researcher:
- systemPrompt: "You are a data researcher responsible for information gathering and analysis"
- communicationStyle: "Speak with data, be concise, proactively report anomalies"
- responseGuidelines: "Must respond to information requests; proactively notify on anomalous findings"
- availableActions: ["report_findings", "request_data", "notify_anomaly"]

### 3.2 Context Building

When an agent is triggered, the prompt is constructed as:

```
[System] Agent persona + mission goal + team composition
[Context] Shared context snippets (artifacts, recent messages, task state)
[History] Current thread messages (if continuing a thread)
[Event] What triggered this conversation
[Instructions] "Respond in JSON with { message, type, mentionedAgentIds, shouldPropagate, action? }"
```

### 3.3 ContextRetriever

```typescript
interface ContextSnippet {
  source: "artifact" | "message" | "task" | "mission";
  sourceId: string;
  summary: string;
  relevance: number;    // 0-1
  createdAt: string;
}

interface ContextRetriever {
  getRelevantContext(input: {
    missionId: string;
    agentId: string;
    currentTopic: string;
    threadId?: string;
  }): ContextSnippet[];
}
```

Retrieval priority:
1. Current task's artifacts and reviews
2. Messages in the current thread
3. Recent messages mentioning this agent's role (keyword match)
4. MissionBrief and mission-level constraints

Total context capped at ~3000 tokens to leave room for conversation history and output.

### 3.4 LLM Response Parsing

```typescript
interface AgentConversationResponse {
  message: string;                // what the agent says
  type: AgentMessageType;         // chat | report | request | notify | discussion
  mentionedAgentIds?: string[];   // @mentioned agents
  shouldPropagate: boolean;       // whether to continue the chain
  action?: {
    type: "request_info" | "notify_owner" | "escalate" | "acknowledge";
    targetAgentId?: string;
    payload?: Record<string, unknown>;
  };
}
```

LLM is instructed to output JSON. If parsing fails, treat as plain text `agent_chat` (graceful degradation).

### 3.5 Relationship to Phase 1 Owner Prompts

Owner already has its own prompt system (`owner/prompts.ts`). Agent conversation prompts are a parallel module. Owner's persona is registered in the Persona Registry but Owner's conversation flow continues through existing `continueMission` path. The Bus does not override Owner's LLM interaction.

## 4. Collaboration Patterns

### 4.1 Report (汇报)

- **Direction**: Subordinate → Superior
- **Trigger**: Bus fires after `execution_completed`. Worker/Researcher LLM generates structured report (not just "done" but "what I found, what I noticed")
- **Recipients**: Planner and Owner
- **Message type**: `agent_report`

### 4.2 Request (请求)

- **Direction**: Any → Any
- **Trigger**: Agent's LLM decides it needs external information. Response contains `action.type = "request_info"` with `targetAgentId`
- **Bus routes** request to target agent, target agent responds via LLM
- **Message type**: `agent_request`

### 4.3 Notify (通知)

- **Direction**: Broadcast
- **Trigger**: Agent's LLM discovers anomaly/risk/important finding during analysis
- **Recipients**: All relevant agents (matched via AgentRelation + role)
- **No response required** but recipients may choose to respond
- **Message type**: `agent_notify`

### 4.4 Discussion (讨论)

- **Direction**: Multi-agent round-robin
- **Trigger**: Report or Request that needs multiple perspectives. Creates a `ConversationThread`
- **Participants** reply in the thread, Bus manages turn-taking
- **Auto-resolves** after 5 rounds or when no agent has `shouldPropagate: true`
- **Message type**: `agent_discussion`

## 5. Frontend Changes

### 5.1 Conversation Feed Tab

New tab in Mission Detail page alongside existing Timeline/Artifacts tabs:

- Chronological feed of agent conversations
- Thread headers with topic and participant count
- Message type badges (report, request, notify, discussion)
- @mention highlighting
- "Thinking..." indicators for agents currently calling LLM
- SSE real-time updates (reuses existing streaming infrastructure)

### 5.2 Agent Card Enhancements

- Show current thread participation
- Status shows conversation state (reporting, discussing, thinking)
- Click to expand agent's current context panel

### 5.3 Shared Context Panel

Expandable panel showing what context each agent sees:
- Mission Brief summary
- Team artifacts (with author)
- Recent task activity

## 6. Integration Points

### 6.1 Existing Flow Preservation

- `submitExecutionResult`: Existing artifact creation + review flow unchanged. After review completes, Bus fires `execution_completed` event
- `failExecution`: Existing error recording unchanged. After recording, Bus fires `execution_failed` event
- `startExecution`: Existing execution setup unchanged

### 6.2 New Methods on InMemoryMissionService

```typescript
// Internal: called at end of existing methods (submitExecutionResult, failExecution, etc.)
// Does NOT replace existing logic — adds conversation layer on top
private async dispatchToBus(event: BusEvent, missionId: string): Promise<void>

// Public: allows user to send a message directly to an agent (like Owner continueMission but for any agent)
async triggerAgentConversation(input: {
  missionId: string;
  agentId: string;
  message: string;
}): Promise<AgentMessage>
```

### 6.3 New API Endpoints

```
POST /api/missions/converse       — User sends message to specific agent
GET  /api/missions/threads         — List conversation threads for a mission
GET  /api/missions/threads/:id     — Get messages in a thread
```

### 6.4 Config Extension

Add to `agent-system.json`:

```json
{
  "agentCollaboration": {
    "maxConversationDepth": 5,
    "cooldownMs": 30000,
    "contextTokenBudget": 3000,
    "personas": {
      "researcher": { ... },
      "planner": { ... },
      "image_creator": { ... },
      "reviewer": { ... }
    }
  }
}
```

## 7. Error Handling

- **LLM call failure**: Log error, create fallback template message, don't propagate
- **JSON parse failure**: Treat as plain `agent_chat`, set `shouldPropagate: false`
- **Bus depth exceeded**: Stop chain, mark thread as `resolved`
- **Target agent not found**: Log warning, skip that agent
- **No LLM configured**: All collaboration features silently disabled, existing event flow works as before

## 8. Testing Strategy

- **Unit**: AgentPersona prompt building, ContextRetriever relevance scoring, AgentConversationResponse parsing, Bus depth/cooldown guards
- **Integration**: Full event → Bus → LLM → message chain with FakeLlmAdapter
- **Snapshot**: Verify ConversationThread and new AgentMessage fields persist correctly
- **API**: New endpoints with FakeLlmAdapter
- **Backward compat**: All existing tests pass without modification (new fields are optional)
