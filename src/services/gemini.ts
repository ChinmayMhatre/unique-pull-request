import { GoogleGenerativeAI } from "@google/generative-ai";
import fetch from "node-fetch";
import * as dotenv from 'dotenv';

dotenv.config();

const apiKey = process.env.GEMINI_API_KEY || '';
const genAI = new GoogleGenerativeAI(apiKey);

export interface AnalysisResult {
  isDuplicate: boolean;
  type: 'unique' | 'shadow' | 'superset' | 'competing';
  confidence: number;
  primaryMatchPr?: number;
  reasoning: string;
  alignsWithVision: boolean;
  qualityScore: number;
}

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
      const model = genAI.getGenerativeModel({ model: "embedding-001" });
      const result = await model.embedContent(text);
      return result.embedding.values;
    }
  }

  /**
   * Primary deep reasoning engine for both Bot and Sweep flows.
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

    const candidatesText = activeCandidates.map(c => `
Candidate #${c.number}
Title: ${c.title}
Author: ${c.author}
Score: ${(c.score || 0).toFixed(4)}
Diff: ${ContextOptimizer.cleanDiff(c.diff, 1500)}
`).join('\n---\n');

    const model = genAI.getGenerativeModel({ 
      model: "gemini-2.0-flash",
      generationConfig: { responseMimeType: "application/json" }
    });

    const visionSection = visionDoc ? `
[PROJECT VISION]
The following document describes the mandatory architectural goals and constraints of this project.
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
  "alignsWithVision": boolean (default true if no vision doc provided),
  "qualityScore": number (1-10, assess code structure and clarity)
}
`;

    try {
      const result = await model.generateContent(prompt);
      const response = JSON.parse(result.response.text());
      return {
        isDuplicate: response.isDuplicate || false,
        type: response.type || 'unique',
        confidence: response.confidence || 0,
        primaryMatchPr: response.primaryMatchPr || undefined,
        reasoning: response.reasoning || "No reasoning provided.",
        alignsWithVision: response.alignsWithVision ?? true,
        qualityScore: response.qualityScore || 5
      };
    } catch (error) {
      console.error("Gemini Reasoning Error:", error);
      throw error; // Rethrow for TriageService to handle fallback
    }
  }

  /**
   * Legacy method - deprecated in favor of analyzeRedundancy
   */
  async performReview(incoming: string, historical: string | null, metadata: any): Promise<any> {
    const res = await this.analyzeRedundancy(incoming, {
      number: 0,
      title: "Unknown",
      author: metadata.incomingAuthor
    }, historical ? [{
      number: 0,
      title: "Historical",
      author: metadata.historicalAuthor || "Unknown",
      diff: historical
    }] : [], metadata.visionDoc);
    
    return {
      is_duplicate: res.isDuplicate,
      aligns_with_vision: res.alignsWithVision,
      reasoning: res.reasoning,
      quality_score: res.qualityScore
    };
  }
}

export const geminiService = new GeminiService();
