import { createId } from "./ids.js";

export type NegotiationStatus =
  | "pending"
  | "active"
  | "agreed"
  | "failed"
  | "escalated";

export type NegotiationMessageType =
  | "proposal"
  | "counter_proposal"
  | "agreement"
  | "rejection"
  | "escalation_request";

export interface NegotiationMessage {
  id: string;
  senderId: string;
  receiverId: string;
  type: NegotiationMessageType;
  content: Record<string, unknown>;
  timestamp: Date;
}

export interface NegotiationRound {
  roundNumber: number;
  messages: NegotiationMessage[];
  startedAt: Date;
  endedAt: Date | undefined;
}

export interface Negotiation {
  id: string;
  missionId: string;
  initiatorId: string;
  participantId: string;
  topic: string;
  status: NegotiationStatus;
  rounds: NegotiationRound[];
  currentRound: number;
  createdAt: Date;
  endedAt?: Date;
  escalationReason?: string;
}

export interface CreateNegotiationInput {
  missionId: string;
  initiatorId: string;
  participantId: string;
  topic: string;
}

export function createNegotiation(
  input: CreateNegotiationInput
): Negotiation {
  if (!input.missionId.trim()) {
    throw new Error("Mission ID is required");
  }
  if (!input.initiatorId.trim()) {
    throw new Error("Initiator ID is required");
  }
  if (!input.participantId.trim()) {
    throw new Error("Participant ID is required");
  }
  if (!input.topic.trim()) {
    throw new Error("Topic is required");
  }

  return {
    id: createId("negotiation"),
    missionId: input.missionId,
    initiatorId: input.initiatorId,
    participantId: input.participantId,
    topic: input.topic,
    status: "pending",
    rounds: [],
    currentRound: 0,
    createdAt: new Date(),
  };
}

export interface CreateNegotiationMessageInput {
  senderId: string;
  receiverId: string;
  type: NegotiationMessageType;
  content: Record<string, unknown>;
}

const VALID_MESSAGE_TYPES: Set<NegotiationMessageType> = new Set([
  "proposal",
  "counter_proposal",
  "agreement",
  "rejection",
  "escalation_request",
]);

export function createNegotiationMessage(
  input: CreateNegotiationMessageInput
): NegotiationMessage {
  if (!VALID_MESSAGE_TYPES.has(input.type)) {
    throw new Error("Invalid message type");
  }

  return {
    id: createId("msg"),
    senderId: input.senderId,
    receiverId: input.receiverId,
    type: input.type,
    content: { ...input.content },
    timestamp: new Date(),
  };
}

function withStatus(
  negotiation: Negotiation,
  status: NegotiationStatus
): Negotiation {
  return { ...negotiation, status };
}

function isTerminalStatus(status: NegotiationStatus): boolean {
  return status === "agreed" || status === "failed" || status === "escalated";
}

function addToCurrentRound(
  negotiation: Negotiation,
  message: NegotiationMessage
): Negotiation {
  if (negotiation.rounds.length === 0) {
    const newRound: NegotiationRound = {
      roundNumber: negotiation.currentRound + 1,
      messages: [message],
      startedAt: new Date(),
      endedAt: undefined,
    };
    return {
      ...negotiation,
      rounds: [...negotiation.rounds, newRound],
      currentRound: newRound.roundNumber,
    };
  }

  const updatedRounds = [...negotiation.rounds];
  const currentRoundIndex = updatedRounds.length - 1;
  const currentRound = updatedRounds[currentRoundIndex];

  if (!currentRound) {
    throw new Error("Current round is undefined");
  }

  updatedRounds[currentRoundIndex] = {
    ...currentRound,
    messages: [...currentRound.messages, message],
  };

  return { ...negotiation, rounds: updatedRounds };
}

function startNewRound(
  negotiation: Negotiation,
  message: NegotiationMessage
): Negotiation {
  const newRound: NegotiationRound = {
    roundNumber: negotiation.currentRound + 1,
    messages: [message],
    startedAt: new Date(),
    endedAt: undefined,
  };

  return {
    ...negotiation,
    rounds: [...negotiation.rounds, newRound],
    currentRound: newRound.roundNumber,
  };
}

function endRound(negotiation: Negotiation): Negotiation {
  if (negotiation.rounds.length === 0) {
    return negotiation;
  }

  const updatedRounds = [...negotiation.rounds];
  const currentRoundIndex = updatedRounds.length - 1;
  const currentRound = updatedRounds[currentRoundIndex];

  if (!currentRound) {
    throw new Error("Current round is undefined");
  }

  updatedRounds[currentRoundIndex] = {
    ...currentRound,
    endedAt: new Date(),
  };

  return { ...negotiation, rounds: updatedRounds };
}

const transitions: Record<
  NegotiationStatus,
  (negotiation: Negotiation, message: NegotiationMessage) => Negotiation
> = {
  pending(negotiation, message) {
    if (message.type === "proposal") {
      const withMessage = addToCurrentRound(negotiation, message);
      return withStatus(withMessage, "active");
    }
    throw new Error(`Invalid negotiation transition: ${negotiation.status} + ${message.type}`);
  },

  active(negotiation, message) {
    if (message.type === "counter_proposal") {
      const withEndedRound = endRound(negotiation);
      return startNewRound(withEndedRound, message);
    }

    if (message.type === "proposal") {
      const withMessage = addToCurrentRound(negotiation, message);
      return withMessage;
    }

    if (message.type === "rejection") {
      const withMessage = addToCurrentRound(negotiation, message);
      const withEndedRound = endRound(withMessage);
      return {
        ...withStatus(withEndedRound, "failed"),
        endedAt: new Date(),
      };
    }

    if (message.type === "agreement") {
      const withMessage = addToCurrentRound(negotiation, message);
      const withEndedRound = endRound(withMessage);
      return {
        ...withStatus(withEndedRound, "agreed"),
        endedAt: new Date(),
      };
    }

    if (message.type === "escalation_request") {
      const withMessage = addToCurrentRound(negotiation, message);
      const withEndedRound = endRound(withMessage);
      return {
        ...withStatus(withEndedRound, "escalated"),
        endedAt: new Date(),
        escalationReason: String(message.content.reason ?? "Unknown"),
      };
    }

    throw new Error(`Invalid negotiation transition: ${negotiation.status} + ${message.type}`);
  },

  agreed(negotiation, message) {
    throw new Error(`Cannot transition from terminal state: ${negotiation.status}`);
  },

  failed(negotiation, message) {
    throw new Error(`Cannot transition from terminal state: ${negotiation.status}`);
  },

  escalated(negotiation, message) {
    throw new Error(`Cannot transition from terminal state: ${negotiation.status}`);
  },
};

export function transitionNegotiation(
  negotiation: Negotiation,
  message: NegotiationMessage
): Negotiation {
  if (isTerminalStatus(negotiation.status)) {
    throw new Error(`Cannot transition from terminal state: ${negotiation.status}`);
  }

  return transitions[negotiation.status](negotiation, message);
}

export function calculateAgreementScore(
  proposal1: Record<string, unknown>,
  proposal2: Record<string, unknown>
): number {
  const keys1 = Object.keys(proposal1);
  const keys2 = Object.keys(proposal2);
  const allKeys = new Set([...keys1, ...keys2]);

  if (allKeys.size === 0) {
    return 1;
  }

  let matches = 0;

  for (const key of allKeys) {
    const val1 = proposal1[key];
    const val2 = proposal2[key];

    if (val1 === val2) {
      matches++;
    } else if (Array.isArray(val1) && Array.isArray(val2)) {
      const intersection = val1.filter((item) => val2.includes(item));
      const union = new Set([...val1, ...val2]);
      matches += intersection.length / union.size;
    } else if (typeof val1 === "number" && typeof val2 === "number") {
      const diff = Math.abs(val1 - val2);
      const max = Math.max(val1, val2);
      matches += max > 0 ? (max - diff) / max : 1;
    }
  }

  return matches / allKeys.size;
}