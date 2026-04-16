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
  modelId?: string; // Track which model provided the result
}

export class GeminiService {
  /**
   * Generates embeddings using direct fetch call to the stable v1 endpoint.
   */
  async generateEmbedding(text: string): Promise<number[]> {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent?key=${apiKey}`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          content: { parts: [{ text }] },
          outputDimensionality: 1536
        })
      });

      if (!response.ok) {
        throw new Error(`Embedding API Error: ${response.statusText}`);
      }

      const data = await response.json() as any;
      return data.embedding.values;
    } catch (error) {
      console.error("Gemini Embedding Error:", error);
      // Fallback to SDK method using the modern model name
      const model = genAI.getGenerativeModel({ model: "gemini-embedding-001" });
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

    const candidatesText = activeCandidates.map(c => {
      const cFiles = ContextOptimizer.getModifiedFiles(c.diff);
      const cScopes = ContextOptimizer.extractScopes(cFiles);
      const intersection = ContextOptimizer.calculatePathIntersection(incomingFiles, cFiles);
      
      return `
Candidate #${c.number}
Title: ${c.title}
Author: ${c.author}
Score: ${(c.score || 0).toFixed(4)}
[STRUCTURE]
Modified Files: ${cFiles.length}
Scopes: ${cScopes.join(", ")}
Path Intersection: ${intersection} ${intersection === 0 ? "(DISJOINT)" : ""}
Diff:
${ContextOptimizer.cleanDiff(c.diff, 1500)}
`;
    }).join('\n---\n');

    const modelId = overrideModelId || "gemini-2.0-flash";
    const model = genAI.getGenerativeModel({ 
      model: modelId,
      generationConfig: { responseMimeType: "application/json" }
    });

    const visionSection = visionDoc ? `
[PROJECT VISION & REPO RULES]
The following document describes the mandatory architectural goals and constraints of this project.
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
