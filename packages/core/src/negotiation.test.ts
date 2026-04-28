import { describe, it, expect } from "vitest";
import {
  createNegotiation,
  createNegotiationMessage,
  transitionNegotiation,
  calculateAgreementScore,
} from "./negotiation.js";

describe("Negotiation State Machine", () => {
  describe("createNegotiation", () => {
    it("should create a negotiation in pending state", () => {
      const negotiation = createNegotiation({
        missionId: "mission_1",
        initiatorId: "hr_agent_1",
        participantId: "owner_agent_1",
        topic: "team_composition",
      });

      expect(negotiation.id).toMatch(/^negotiation_\d+$/);
      expect(negotiation.missionId).toBe("mission_1");
      expect(negotiation.initiatorId).toBe("hr_agent_1");
      expect(negotiation.participantId).toBe("owner_agent_1");
      expect(negotiation.topic).toBe("team_composition");
      expect(negotiation.status).toBe("pending");
      expect(negotiation.rounds).toEqual([]);
      expect(negotiation.currentRound).toBe(0);
      expect(negotiation.createdAt).toBeInstanceOf(Date);
    });

    it("should throw error if missionId is empty", () => {
      expect(() =>
        createNegotiation({
          missionId: "",
          initiatorId: "hr_agent_1",
          participantId: "owner_agent_1",
          topic: "team_composition",
        })
      ).toThrow("Mission ID is required");
    });

    it("should throw error if initiatorId is empty", () => {
      expect(() =>
        createNegotiation({
          missionId: "mission_1",
          initiatorId: "",
          participantId: "owner_agent_1",
          topic: "team_composition",
        })
      ).toThrow("Initiator ID is required");
    });

    it("should throw error if participantId is empty", () => {
      expect(() =>
        createNegotiation({
          missionId: "mission_1",
          initiatorId: "hr_agent_1",
          participantId: "",
          topic: "team_composition",
        })
      ).toThrow("Participant ID is required");
    });

    it("should throw error if topic is empty", () => {
      expect(() =>
        createNegotiation({
          missionId: "mission_1",
          initiatorId: "hr_agent_1",
          participantId: "owner_agent_1",
          topic: "",
        })
      ).toThrow("Topic is required");
    });
  });

  describe("createNegotiationMessage", () => {
    it("should create a valid proposal message", () => {
      const message = createNegotiationMessage({
        senderId: "hr_agent_1",
        receiverId: "owner_agent_1",
        type: "proposal",
        content: { roles: ["analyst", "creator"], budget: 200 },
      });

      expect(message.id).toMatch(/^msg_\d+$/);
      expect(message.senderId).toBe("hr_agent_1");
      expect(message.receiverId).toBe("owner_agent_1");
      expect(message.type).toBe("proposal");
      expect(message.content).toEqual({ roles: ["analyst", "creator"], budget: 200 });
      expect(message.timestamp).toBeInstanceOf(Date);
    });

    it("should create a counter_proposal message", () => {
      const message = createNegotiationMessage({
        senderId: "owner_agent_1",
        receiverId: "hr_agent_1",
        type: "counter_proposal",
        content: { roles: ["analyst"], budget: 150, reason: "Budget constraints" },
      });

      expect(message.type).toBe("counter_proposal");
      expect(message.content).toEqual({
        roles: ["analyst"],
        budget: 150,
        reason: "Budget constraints"
      });
    });

    it("should create an agreement message", () => {
      const message = createNegotiationMessage({
        senderId: "owner_agent_1",
        receiverId: "hr_agent_1",
        type: "agreement",
        content: { confirmed: true, finalRoles: ["analyst", "creator"] },
      });

      expect(message.type).toBe("agreement");
    });

    it("should throw error for invalid message type", () => {
      expect(() =>
        createNegotiationMessage({
          senderId: "hr_agent_1",
          receiverId: "owner_agent_1",
          type: "invalid_type" as any,
          content: {},
        })
      ).toThrow("Invalid message type");
    });
  });

  describe("transitionNegotiation", () => {
    it("should transition from pending to active on proposal", () => {
      const negotiation = createNegotiation({
        missionId: "mission_1",
        initiatorId: "hr_agent_1",
        participantId: "owner_agent_1",
        topic: "team_composition",
      });

      const message = createNegotiationMessage({
        senderId: "hr_agent_1",
        receiverId: "owner_agent_1",
        type: "proposal",
        content: { roles: ["analyst"] },
      });

      const updated = transitionNegotiation(negotiation, message);
      expect(updated.status).toBe("active");
      expect(updated.currentRound).toBe(1);
      expect(updated.rounds).toHaveLength(1);
    });

    it("should transition from active to agreed on agreement", () => {
      let negotiation = createNegotiation({
        missionId: "mission_1",
        initiatorId: "hr_agent_1",
        participantId: "owner_agent_1",
        topic: "team_composition",
      });

      const proposal = createNegotiationMessage({
        senderId: "hr_agent_1",
        receiverId: "owner_agent_1",
        type: "proposal",
        content: { roles: ["analyst"] },
      });

      negotiation = transitionNegotiation(negotiation, proposal);

      const agreement = createNegotiationMessage({
        senderId: "owner_agent_1",
        receiverId: "hr_agent_1",
        type: "agreement",
        content: { confirmed: true },
      });

      const updated = transitionNegotiation(negotiation, agreement);
      expect(updated.status).toBe("agreed");
      expect(updated.endedAt).toBeInstanceOf(Date);
    });

    it("should transition from active to failed on rejection", () => {
      let negotiation = createNegotiation({
        missionId: "mission_1",
        initiatorId: "hr_agent_1",
        participantId: "owner_agent_1",
        topic: "team_composition",
      });

      const proposal = createNegotiationMessage({
        senderId: "hr_agent_1",
        receiverId: "owner_agent_1",
        type: "proposal",
        content: { roles: ["analyst"] },
      });

      negotiation = transitionNegotiation(negotiation, proposal);

      const rejection = createNegotiationMessage({
        senderId: "owner_agent_1",
        receiverId: "hr_agent_1",
        type: "rejection",
        content: { reason: "Strategic misalignment" },
      });

      const updated = transitionNegotiation(negotiation, rejection);
      expect(updated.status).toBe("failed");
      expect(updated.endedAt).toBeInstanceOf(Date);
    });

    it("should handle counter_proposals in active state", () => {
      let negotiation = createNegotiation({
        missionId: "mission_1",
        initiatorId: "hr_agent_1",
        participantId: "owner_agent_1",
        topic: "team_composition",
      });

      const proposal = createNegotiationMessage({
        senderId: "hr_agent_1",
        receiverId: "owner_agent_1",
        type: "proposal",
        content: { roles: ["analyst", "creator"] },
      });

      negotiation = transitionNegotiation(negotiation, proposal);

      const counter = createNegotiationMessage({
        senderId: "owner_agent_1",
        receiverId: "hr_agent_1",
        type: "counter_proposal",
        content: { roles: ["analyst"] },
      });

      const updated = transitionNegotiation(negotiation, counter);
      expect(updated.status).toBe("active");
      expect(updated.currentRound).toBe(2);
      expect(updated.rounds).toHaveLength(2);
    });

    it("should throw error for invalid transitions", () => {
      const negotiation = createNegotiation({
        missionId: "mission_1",
        initiatorId: "hr_agent_1",
        participantId: "owner_agent_1",
        topic: "team_composition",
      });

      const message = createNegotiationMessage({
        senderId: "hr_agent_1",
        receiverId: "owner_agent_1",
        type: "agreement",
        content: { confirmed: true },
      });

      expect(() => transitionNegotiation(negotiation, message)).toThrow(
        "Invalid negotiation transition"
      );
    });

    it("should not allow transitions from terminal states", () => {
      let negotiation = createNegotiation({
        missionId: "mission_1",
        initiatorId: "hr_agent_1",
        participantId: "owner_agent_1",
        topic: "team_composition",
      });

      const proposal = createNegotiationMessage({
        senderId: "hr_agent_1",
        receiverId: "owner_agent_1",
        type: "proposal",
        content: { roles: ["analyst"] },
      });

      negotiation = transitionNegotiation(negotiation, proposal);

      const rejection = createNegotiationMessage({
        senderId: "owner_agent_1",
        receiverId: "hr_agent_1",
        type: "rejection",
        content: { reason: "No" },
      });

      negotiation = transitionNegotiation(negotiation, rejection);

      const newMessage = createNegotiationMessage({
        senderId: "hr_agent_1",
        receiverId: "owner_agent_1",
        type: "proposal",
        content: { roles: ["analyst", "creator"] },
      });

      expect(() => transitionNegotiation(negotiation, newMessage)).toThrow(
        "Cannot transition from terminal state"
      );
    });
  });

  describe("calculateAgreementScore", () => {
    it("should calculate high score for matching proposals", () => {
      const proposal1 = { roles: ["analyst", "creator"], budget: 200 };
      const proposal2 = { roles: ["analyst", "creator"], budget: 200 };

      const score = calculateAgreementScore(proposal1, proposal2);
      expect(score).toBeGreaterThan(0.8);
    });

    it("should calculate low score for different proposals", () => {
      const proposal1 = { roles: ["analyst", "creator", "manager"], budget: 300 };
      const proposal2 = { roles: ["analyst"], budget: 100 };

      const score = calculateAgreementScore(proposal1, proposal2);
      expect(score).toBeLessThan(0.5);
    });

    it("should handle empty proposals", () => {
      const proposal1 = {};
      const proposal2 = {};

      const score = calculateAgreementScore(proposal1, proposal2);
      expect(score).toBe(1); // Empty proposals are considered identical
    });
  });
});