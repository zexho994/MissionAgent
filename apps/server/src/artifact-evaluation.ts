import type { Mission } from "@digitalagent/core";

export function evaluateArtifactQuality(
  content: Record<string, unknown>,
  mission: Mission,
): { score: number; decision: "approve" | "revise" | "reject"; comments: string[] } {
  const comments: string[] = [];
  let score = 0.5;
  let decision: "approve" | "revise" | "reject" = "approve";

  const openclaw = content.openclaw as Record<string, unknown> | undefined;
  if (!openclaw) {
    return { score: 0.1, decision: "reject", comments: ["Artifact has no OpenClaw output"] };
  }

  const payloads = openclaw.payloads as Array<Record<string, unknown>> | undefined;
  const agentText = payloads?.[0]?.text as string | undefined;

  if (!agentText || agentText.trim().length < 20) {
    return { score: 0.1, decision: "reject", comments: ["Agent output is empty or too short"] };
  }
  score += 0.1;

  const goalLower = mission.goal.toLowerCase();
  const textLower = agentText.toLowerCase();
  const goalKeywords = goalLower.split(/[\s,，。、]+/).filter((w) => w.length >= 2);
  const matchCount = goalKeywords.filter((kw) => textLower.includes(kw)).length;
  const relevance = goalKeywords.length > 0 ? matchCount / goalKeywords.length : 0;
  if (relevance < 0.1) {
    comments.push("Output has low relevance to mission goal");
    decision = "revise";
  } else if (relevance >= 0.3) {
    score += 0.15;
    comments.push("Output addresses mission goal");
  }

  const hasMediaUrl = payloads?.some(
    (p) => p.mediaUrl && String(p.mediaUrl).length > 0,
  );
  if (hasMediaUrl) {
    score += 0.15;
    comments.push("Artifact contains generated image");
  } else if (mission.goal.includes("图片") || mission.goal.includes("image")) {
    const isOnlyTextJson = /^(\```json|\{|\[)/.test(agentText.trim());
    if (isOnlyTextJson) {
      comments.push("Mission requires an image but agent returned text/JSON only — revise to generate actual image");
      decision = "revise";
      score = Math.min(score, 0.5);
    } else {
      comments.push("Mission requires image; agent produced text content without actual image generation");
      decision = "revise";
    }
  } else {
    score += 0.1;
  }

  if (mission.successMetrics.length > 0) {
    const metricsHit = mission.successMetrics.filter(
      (metric) => textLower.includes(metric.toLowerCase().split(/\s/)[0] ?? ""),
    ).length;
    if (metricsHit > 0) {
      score += 0.05;
      comments.push(`Matches ${metricsHit}/${mission.successMetrics.length} success metrics`);
    }
  }

  score = Math.min(Math.max(score, 0), 1);

  if (decision === "approve" && score < 0.5) {
    decision = "revise";
  }

  if (decision === "approve") {
    comments.unshift("Artifact quality check passed");
  }

  return { score: Math.round(score * 100) / 100, decision, comments };
}
