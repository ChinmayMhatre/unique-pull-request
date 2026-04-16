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
    visionDoc: string | null = null
  ): Promise<AnalysisResult> {
    const { ContextOptimizer } = await import("./optimizer.js");
    
    // Constraint: 1,500 characters per diff for maximum efficiency
    const incomingDiff = ContextOptimizer.cleanDiff(rawIncomingDiff, 1500);
    const activeCandidates = ContextOptimizer.pruneCandidates(rawCandidates, 3);

    const candidatesText = (activeCandidates && activeCandidates.length > 0)
      ? activeCandidates.map(c => `
Candidate #${c.number}
Title: ${c.title}
Author: ${c.author}
Similarity Score: ${(c.score || 0).toFixed(4)}
Diff Snippet:
${ContextOptimizer.cleanDiff(c.diff, 1500)}
`).join('\n---\n')
      : "[NO CANDIDATES]";

    const visionSection = visionDoc ? `
[PROJECT VISION]
${visionDoc}

[Vision Evaluation Rule]
Evaluate if the CURRENT PR aligns with the rules above. Set "alignsWithVision" to false if it violates architectural constraints.
` : "";

    const prompt = `Assess the relationship between these Pull Requests with the precision of a Lead Software Architect.

[CURRENT PR]
#${incomingMetadata.number}: ${incomingMetadata.title}
Diff:
${incomingDiff}

[CANDIDATES]
${candidatesText}
${visionSection}

[Redundancy Evaluation Rules]
1. "unique": No significant logic overlap.
2. "shadow": Solve the EXACT same problem with different implementation details.
3. "superset": This PR (or a candidate) is a small fix covered by a larger refactor in another. 
4. "competing": Both solve the same bug/feature but with conflicting architectural approaches.

[Output Format]
Return ONLY a JSON object with:
{
  "isDuplicate": boolean,
  "type": "unique" | "shadow" | "superset" | "competing",
  "confidence": number (0-1),
  "primaryMatchPr": number | null,
  "reasoning": "Concise architectural explanation.",
  "alignsWithVision": boolean,
  "qualityScore": number
}
`;

    try {
      const response = await this.groq.chat.completions.create({
        messages: [{ role: "user", content: prompt }],
        model: "llama-3.3-70b-specdec", // Optimal for JSON reasoning
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
