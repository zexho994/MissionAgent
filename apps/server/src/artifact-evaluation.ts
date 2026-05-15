import type { Mission, Source } from "@digitalagent/core";

export function evaluateArtifactQuality(
  content: Record<string, unknown>,
  mission: Mission,
): { score: number; decision: "approve" | "revise" | "reject"; comments: string[] } {
  const comments: string[] = [];
  let score = 0.5;
  let decision: "approve" | "revise" | "reject" = "approve";

  const pi = content.pi as Record<string, unknown> | undefined;
  if (!pi) {
    return { score: 0.1, decision: "reject", comments: ["Artifact has no pi-agent output"] };
  }

  const payloads = pi.payloads as Array<Record<string, unknown>> | undefined;
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

  // Evaluate sources for research missions
  const sources = extractSourcesFromContent(pi);
  if (sources.length > 0) {
    score += 0.1;
    comments.push(`Artifact includes ${sources.length} source(s)`);

    // Bonus for having URLs (verifiable sources)
    const sourcesWithUrls = sources.filter((s) => s.url && s.url.length > 0);
    if (sourcesWithUrls.length > 0) {
      score += 0.05;
      comments.push(`${sourcesWithUrls.length} source(s) have verifiable URLs`);
    }

    // Penalty if mission is clearly research-oriented but has no sources
    const isResearchMission = mission.goal.includes("research") ||
      mission.goal.includes("调研") ||
      mission.goal.includes("调查") ||
      mission.goal.includes("研究") ||
      mission.goal.includes("分析");
    if (isResearchMission && sources.length === 0) {
      comments.push("Research mission should include source citations");
      decision = "revise";
      score = Math.min(score, 0.4);
    }
  } else {
    // Check if this is a research mission that should have sources
    const isResearchMission = mission.goal.includes("research") ||
      mission.goal.includes("调研") ||
      mission.goal.includes("调查") ||
      mission.goal.includes("研究") ||
      mission.goal.includes("分析");
    if (isResearchMission) {
      comments.push("No sources found - research mission requires source citations");
      decision = "revise";
      score = Math.min(score, 0.35);
    }
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

/**
 * Extracts source information from pi-agent output content.
 */
function extractSourcesFromContent(pi: Record<string, unknown>): Source[] {
  const sources: Source[] = [];

  // Check for searchResults array
  const searchResults = pi.searchResults as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(searchResults)) {
    for (const result of searchResults) {
      if (result.url && typeof result.url === "string") {
        const src: Source = { url: result.url };
        if (typeof result.title === "string") src.title = result.title;
        if (typeof result.snippet === "string") src.snippet = result.snippet;
        if (typeof result.searchKeyword === "string") src.searchKeyword = result.searchKeyword;
        sources.push(src);
      }
    }
    if (sources.length > 0) {
      return sources;
    }
  }

  // Check for sources array
  const directSources = pi.sources as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(directSources)) {
    for (const source of directSources) {
      if (source.url && typeof source.url === "string") {
        const src: { url: string; title?: string; snippet?: string } = { url: source.url };
        if (typeof source.title === "string") src.title = source.title;
        if (typeof source.snippet === "string") src.snippet = source.snippet;
        sources.push(src);
      }
    }
    if (sources.length > 0) {
      return sources;
    }
  }

  // Check for webSearch object
  const webSearch = pi.webSearch as Record<string, unknown> | undefined;
  if (webSearch && typeof webSearch === "object") {
    const searchKeyword = typeof webSearch.searchKeyword === "string" ? webSearch.searchKeyword : undefined;
    const results = webSearch.results as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(results)) {
      for (const result of results) {
        if (result.url && typeof result.url === "string") {
          const src: { url: string; title?: string; snippet?: string; searchKeyword?: string } = { url: result.url };
          if (typeof result.title === "string") src.title = result.title;
          if (typeof result.snippet === "string") src.snippet = result.snippet;
          if (searchKeyword) src.searchKeyword = searchKeyword;
          sources.push(src);
        }
      }
    }
  }

  // Check payloads for source references
  const payloads = pi.payloads as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(payloads)) {
    for (const payload of payloads) {
      if (payload.sources && Array.isArray(payload.sources)) {
        for (const source of payload.sources as Array<Record<string, unknown>>) {
          if (source.url && typeof source.url === "string") {
            const src: { url: string; title?: string; snippet?: string } = { url: source.url };
            if (typeof source.title === "string") src.title = source.title;
            if (typeof source.snippet === "string") src.snippet = source.snippet;
            sources.push(src);
          }
        }
      }
      const payloadSearchResults = payload.searchResults as Array<Record<string, unknown>> | undefined;
      if (Array.isArray(payloadSearchResults)) {
        for (const result of payloadSearchResults) {
          if (result.url && typeof result.url === "string") {
            const src: { url: string; title?: string; snippet?: string; searchKeyword?: string } = { url: result.url };
            if (typeof result.title === "string") src.title = result.title;
            if (typeof result.snippet === "string") src.snippet = result.snippet;
            if (typeof result.searchKeyword === "string") src.searchKeyword = result.searchKeyword;
            sources.push(src);
          }
        }
      }
    }
  }

  return sources;
}
