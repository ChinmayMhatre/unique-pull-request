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
    incomingMetadata: { number: number; title: string; author: string },
    rawCandidates: Array<{ number: number; title: string; author: string; diff: string; score?: number }>,
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
4. "unique": No significant logic overlap between this PR and the candidate.

[Structural Awareness Guidelines]
- IMPORTANT: If "Path Intersection" is 0 (DISJOINT), the PRs are likely COMPLEMENTARY fixes for different files, not duplicates. 
- Only flag disjoint PRs as duplicates if one PR is a verified architectural replacement (Superset/Competing) for the other as specified in project-specific rules or vision.
- For Registry/JSON list files: Logic replication (e.g., adding an entry to the same array) is NOT a duplicate if the entries themselves are unique.

[Categorization Hierarchy]
If a PR pair qualifies for multiple categories, apply this order of precedence:
1. "superset" (Highest)
2. "shadow" (Use if scopes and target files are identical)
3. "competing" (Use if goals align but implementations clash)
4. "unique" (Lowest fallback)

[Output Format]
Return ONLY a JSON object with:
{
  "isDuplicate": boolean,
  "type": "unique" | "shadow" | "superset" | "competing",
  "confidence": number (0-1),
  "primaryMatchPr": number | null,
  "reasoning": "Concise architectural explanation explaining both logic and structural overlap.",
  "aligns_with_vision": boolean,
  "quality_score": number
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
        alignsWithVision: result.aligns_with_vision ?? true,
        qualityScore: result.quality_score || 5
      };
    } catch (error) {
      console.error("❌ Groq reasoning pass failed:", error);
      return { 
        isDuplicate: false, 
        type: "unique", 
        confidence: 0, 
        reasoning: "Groq Error",
        alignsWithVision: true,
        qualityScore: 5
      };
    }
  }
}

export const groqService = new GroqService();
