import { GoogleGenerativeAI } from "@google/generative-ai";
import fetch from "node-fetch";
import * as dotenv from 'dotenv';

dotenv.config();

const apiKey = process.env.GEMINI_API_KEY || '';
const genAI = new GoogleGenerativeAI(apiKey);

export interface AnalysisResult {
  isDuplicate: boolean;
  type: 'unique' | 'shadow' | 'superset' | 'competing' | 'complementary';
  confidence: number;
  primaryMatchPr?: number;
  reasoning: string;
  alignsWithVision: boolean;
  qualityScore: number;
  modelId?: string; // Track which model provided the result
}

export class GeminiService {
  /**
   * Generates enriched embeddings using Gemini 2's native 1536D output.
   * Eliminates the need for manual vector slicing and preserves semantic fidelity.
   */
  async generateEmbedding(text: string, title?: string): Promise<number[]> {
    try {
      const model = genAI.getGenerativeModel({ model: "gemini-embedding-2-preview" });
      const fullText = title ? `TITLE: ${title}\nDIFF:\n${text}` : text;

      const result = await model.embedContent({
        content: { parts: [{ text: fullText }] },
        taskType: 1, // RETRIEVAL_DOCUMENT
        outputDimensionality: 1536
      } as any);

      return result.embedding.values;
    } catch (error) {
      console.error("Gemini 2 Embedding Error:", error);
      throw error;
    }
  }

  /**
   * Primary deep reasoning engine for both Bot and Audit flows.
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

    try {
      const result = await model.generateContent(prompt);
      const response = JSON.parse(result.response.text());
      console.log(`\n   🔍 [PR #${incomingMetadata.number}] RAW LLM RESULT:`, JSON.stringify(response, null, 2));

      return {
        isDuplicate: response.type === 'complementary' ? false : (response.isDuplicate || false),
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
