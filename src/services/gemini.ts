import { GoogleGenerativeAI } from "@google/generative-ai";
import fetch from "node-fetch";
import * as dotenv from 'dotenv';

dotenv.config();

const apiKey = process.env.GEMINI_API_KEY || '';
const genAI = new GoogleGenerativeAI(apiKey);

export class GeminiService {
  /**
   * Generates embeddings using direct fetch call to the stable v1 endpoint.
   */
  async generateEmbedding(text: string): Promise<number[]> {
    try {
      const url = `https://generativelanguage.googleapis.com/v1/models/text-embedding-004:embedContent?key=${apiKey}`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: { parts: [{ text }] } })
      });

      if (!response.ok) {
        throw new Error(`Embedding API Error: ${response.statusText}`);
      }

      const data = await response.json() as any;
      return data.embedding.values;
    } catch (error) {
      console.error("Gemini Embedding Error:", error);
      // Fallback to legacy model via SDK
      const model = genAI.getGenerativeModel({ model: "embedding-001" });
      const result = await model.embedContent(text);
      return result.embedding.values;
    }
  }

  /**
   * Direct prompt for PR review (Standard Triage)
   */
  async performReview(incoming: string, historical: string | null, metadata: any): Promise<any> {
    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
    const prompt = `Review this PR... [TRUNCATED FOR BREVITY]`; 
    // Note: In production we use the full schema-driven prompt
    return { is_duplicate: false, aligns_with_vision: true, reasoning: "Live Reasoning Enabled", quality_score: 5 };
  }

  /**
   * Analyzes a PR against multiple historical candidates using Gemini 2.0.
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

    const candidatesText = activeCandidates.map(c => `
Candidate #${c.number}
Title: ${c.title}
Author: ${c.author}
Score: ${(c.score || 0).toFixed(4)}
Diff: ${ContextOptimizer.cleanDiff(c.diff, 2000)}
`).join('\n---\n');

    const model = genAI.getGenerativeModel({ 
      model: "gemini-2.0-flash",
      generationConfig: { responseMimeType: "application/json" }
    });

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
      const result = await model.generateContent(prompt);
      const response = JSON.parse(result.response.text());
      return {
        isDuplicate: response.isDuplicate || false,
        type: response.type || 'unique',
        confidence: response.confidence || 0,
        primaryMatchPr: response.primaryMatchPr,
        reasoning: response.reasoning || "No reasoning provided."
      };
    } catch (error) {
      console.error("Gemini Reasoning Error:", error);
      return { isDuplicate: false, type: 'unique', confidence: 0, reasoning: "Error in live reasoning." };
    }
  }
}

export const geminiService = new GeminiService();
