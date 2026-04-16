import 'dotenv/config';
import Groq from "groq-sdk";

export class GroqService {
  private groq: Groq;

  constructor() {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) {
      console.warn("⚠️ GROQ_API_KEY missing. Fallback reasoning disabled.");
    }
    this.groq = new Groq({ apiKey: apiKey || 'dummy' });
  }

  /**
   * High-speed redundancy analysis using Llama 3 70B on Groq.
   */
  async analyzeRedundancy(
    rawIncomingDiff: string,
    incomingMetadata: { number: number; title: string; author: string },
    rawCandidates: Array<{ number: number; title: string; author: string; diff: string; score?: number }>
  ): Promise<{
    isDuplicate: boolean;
    type: 'unique' | 'shadow' | 'superset' | 'competing';
    confidence: number;
    primaryMatchPr?: number;
    reasoning: string;
  }> {
    const { ContextOptimizer } = await import("./optimizer.js");
    const incomingDiff = ContextOptimizer.cleanDiff(rawIncomingDiff, 3000);
    const activeCandidates = ContextOptimizer.pruneCandidates(rawCandidates, 3);

    const candidatesText = (activeCandidates && activeCandidates.length > 0)
      ? activeCandidates.map(c => `
Candidate #${c.number}
Title: ${c.title}
Author: ${c.author}
Similarity Score: ${(c.score || 0).toFixed(4)}
Diff Snippet (Optimized):
${ContextOptimizer.cleanDiff(c.diff, 2000)}
`).join('\n---\n')
      : "[NO CANDIDATES]";

    const prompt = `Assess the relationship between these Pull Requests with the precision of a Lead Software Architect.

[CURRENT PR]
#${incomingMetadata.number}: ${incomingMetadata.title}
Diff:
${incomingDiff}

[CANDIDATES]
${candidatesText}

[Evaluation Rules]
1. "unique": No significant logic overlap.
2. "shadow": The PRs solve the EXACT same problem with different implementation details (e.g. different variable names but same logic flow).
3. "superset": This PR (or a candidate) is a small fix already covered by a larger, more comprehensive refactor in another. 
4. "competing": Both PRs solve the same bug/feature but with different, often conflicting, architectural approaches.

[Output Format]
Return ONLY a JSON object with:
{
  "isDuplicate": boolean,
  "type": "unique" | "shadow" | "superset" | "competing",
  "confidence": number (0-1),
  "primaryMatchPr": number (the PR number it matches),
  "reasoning": "A concise explanation of the architectural overlap."
}
`;

    try {
      const response = await this.groq.chat.completions.create({
        messages: [{ role: "user", content: prompt }],
        model: "llama-3.1-70b-versatile",
        response_format: { type: "json_object" }
      });

      const content = response.choices[0]?.message?.content || "{}";
      const result = JSON.parse(content);

      return {
        isDuplicate: result.isDuplicate || false,
        type: result.type || 'unique',
        confidence: result.confidence || 0,
        primaryMatchPr: result.primaryMatchPr,
        reasoning: result.reasoning || "No reasoning provided."
      };
    } catch (error) {
      console.error("❌ Groq reasoning pass failed:", error);
      return { isDuplicate: false, type: "unique", confidence: 0, reasoning: "Groq Error" };
    }
  }
}

export const groqService = new GroqService();
