import 'dotenv/config';
import Groq from "groq-sdk";
import { AnalysisResult } from "./gemini.js";

export class GroqService {
  private groq: Groq;

  constructor() {
    const apiKey = process.env.GROQ_API_KEY;
    this.groq = new Groq({ apiKey: apiKey || 'dummy' });
  }

  /**
   * High-speed redundancy analysis using Llama 3 on Groq.
   * Matches signature and capabilities of GeminiService.
   */
  async analyzeRedundancy(
    rawIncomingDiff: string,
    incomingMetadata: { number: number; title: string; author: string; body?: string },
    rawCandidates: Array<{ number: number; title: string; author: string; diff: string; score?: number; body?: string }>,
    visionDoc: string | null = null,
    overrideModelId?: string
  ): Promise<AnalysisResult> {
    const { ContextOptimizer } = await import("./optimizer.js");
    
    // 1. Structural Analysis
    const incomingFiles = ContextOptimizer.getModifiedFiles(rawIncomingDiff);
    const incomingScopes = ContextOptimizer.extractScopes(incomingFiles);
    
    // Constraint: 1,500 characters per diff for maximum efficiency
    const incomingDiff = ContextOptimizer.cleanDiff(rawIncomingDiff, 1500);
    const activeCandidates = ContextOptimizer.pruneCandidates(rawCandidates, 3);

    const candidatesText = (activeCandidates && activeCandidates.length > 0)
      ? activeCandidates.map(c => {
          const cFiles = ContextOptimizer.getModifiedFiles(c.diff);
          const cScopes = ContextOptimizer.extractScopes(cFiles);
          const intersection = ContextOptimizer.calculatePathIntersection(incomingFiles, cFiles);

          return `
Candidate #${c.number}
Title: ${c.title}
Author: ${c.author}
Description: ${c.body || "None provided"}
Similarity Score: ${(c.score || 0).toFixed(4)}
[STRUCTURE]
Modified Files: ${cFiles.length}
Scopes: ${cScopes.join(", ")}
Path Intersection: ${intersection} ${intersection === 0 ? "(DISJOINT)" : ""}
Diff Snippet:
${ContextOptimizer.cleanDiff(c.diff, 1500)}
`;
      }).join('\n---\n')
      : "[NO CANDIDATES]";

    const visionSection = visionDoc ? `
[PROJECT VISION & REPO RULES]
${visionDoc}

[Vision Evaluation Rule]
Evaluate if the CURRENT PR aligns with the rules above. Set "alignsWithVision" to false if it violates architectural constraints.
` : "";

    const prompt = `Assess the relationship between these Pull Requests with the precision of a Lead Software Architect.

[CURRENT PR]
#${incomingMetadata.number}: ${incomingMetadata.title}
Author: ${incomingMetadata.author}
Description: ${incomingMetadata.body || "None provided"}
Modified Files: ${incomingFiles.length}
Scopes: ${incomingScopes.join(", ")}
Diff:
${incomingDiff}

[CANDIDATES]
${candidatesText}
${visionSection}

[Redundancy Evaluation Rules]
1. "superset": The PRs solve the same problem, but one PR completely encompasses the other's logic while providing additional coverage, files, or fixes.
2. "shadow": The PRs solve the EXACT same problem with nearly identical logic, files, and scope.
3. "competing": Both PRs solve the same bug/feature but with conflicting architectural approaches or divergent code paths.
4. "complementary": Both PRs address the exact same bug/feature but modify completely disjoint files. These are technically redundant in goal but not in execution.
5. "unique": No significant logic overlap between this PR and the candidate.

[Holistic Evaluation Rule]
- You are provided with up to 3 candidates. You MUST evaluate the relationship between the CURRENT PR and EVERY candidate separately before deciding on the final categorization.
- Priority: If ANY candidate is a "shadow" or "superset", the PR is a Duplicate.
- Core Goal: If the CURRENT PR and a candidate address the same functional root cause or logic failure, even if their structural implementation (file paths or line ranges) differ slightly, they should be considered redundant.

[Semantic Payload Verification]
- Values Matter: Extract and compare the literal semantic payloads (identifiers, logic-level values, specific metadata constants).
- **Hardening Rule**: If the PRs modify a DATA-DRIVEN configuration file (e.g., registries, directories, package-lists), the literal string values are the primary differentiator. If unique identifiers (URLs, names) differ, categorize as UNIQUE regardless of structural similarity.
- If the changes introduce distinct semantic entities or divergent logic branches, categorize as UNIQUE.
- If the changes target the same logic-level state or configuration with equivalent outcomes, categorize as DUPLICATE.

[Categorization Hierarchy]
If a PR pair qualifies for multiple categories, apply this order of precedence:
1. "superset" (Highest)
2. "shadow"
3. "competing"
4. "complementary"
5. "unique" (Lowest fallback)

[Output Format]
Return ONLY a JSON object with:
{
  "isDuplicate": boolean (MUST be true for "shadow", "superset", or "competing"),
  "type": "unique" | "complementary" | "shadow" | "superset" | "competing",
  "confidence": number (0-1),
  "primaryMatchPr": number | null (The ID of the candidate that triggered the duplicate/overlap status),
  "reasoning": "Concise architectural explanation of your decision for the primary match.",
  "alignsWithVision": boolean,
  "qualityScore": number (1-10)
}
`;

    const modelId = overrideModelId || "llama-3.3-70b-versatile";

    try {
      const response = await this.groq.chat.completions.create({
        messages: [{ role: "user", content: prompt }],
        model: modelId,
        response_format: { type: "json_object" }
      });

      const content = response.choices[0]?.message?.content || "{}";
      const result = JSON.parse(content);

      return {
        isDuplicate: result.isDuplicate || false,
        type: result.type || 'unique',
        confidence: result.confidence || 0,
        primaryMatchPr: result.primaryMatchPr || undefined,
        reasoning: result.reasoning || "No reasoning provided.",
        alignsWithVision: result.alignsWithVision ?? true,
        qualityScore: result.qualityScore || 5
      };
    } catch (error) {
      console.error("❌ Groq reasoning pass failed:", error);
      throw error; // Rethrow so TriageService can handle the fallback logic
    }
  }
}

export const groqService = new GroqService();
