import { geminiService, AnalysisResult } from "./gemini.js";
import { groqService } from "./groq.js";
import { upstashService, PRMetadata } from "./upstash.js";
import { ProbotOctokit } from "probot";

export interface TriageResult {
  isDuplicate: boolean;
  alignsWithVision: boolean;
  reasoning: string;
  qualityScore: number;
  duplicateOfUrl?: string;
  type?: string;
}

export class TriageService {
  /**
   * High-level entry point for real-time PR triage (Main Bot Flow).
   */
  async triagePR(
    octokit: InstanceType<typeof ProbotOctokit>,
    owner: string,
    repo: string,
    prNumber: number,
    visionDoc: string | null
  ): Promise<TriageResult | null> {
    try {
      // 1. Fetch Incoming PR
      const prRes = await octokit.pulls.get({ owner, repo, pull_number: prNumber });
      const pr = prRes.data;
      
      const filesRes = await octokit.pulls.listFiles({ owner, repo, pull_number: prNumber, per_page: 100 });
      
      // Constraint: Skip PRs with > 15 files
      if (filesRes.data.length > 15) {
        console.warn(`PR #${prNumber} too large (${filesRes.data.length} files). Skipping.`);
        return null;
      }
      
      const { ContextOptimizer } = await import("./optimizer.js");
      const rawPatch = filesRes.data.map((f: any) => f.patch || "").join("\n");
      const combinedPatch = ContextOptimizer.cleanDiff(rawPatch, 1500);

      if (!combinedPatch.trim()) return null;

      // 2. Generate Embedding & Search
      const embedding = await geminiService.generateEmbedding(combinedPatch);
      if (!embedding.length) return null;

      const namespace = `${owner}/${repo}`;
      // Broaden the net: Fetch 8 candidates to bypass structural noise, but prune later
      const similarPRs = await upstashService.findSimilarPRs(embedding, namespace, 8);
      const validCandidates = similarPRs.filter((m: any) => {
         const meta = m.metadata as unknown as PRMetadata;
         return meta.pr_number !== prNumber && (m.score || 0) > 0.85;
      });

      // 3. Fetch Candidate Details
      const candidates = await Promise.all(validCandidates.map(async (m: any) => {
        const meta = m.metadata as unknown as PRMetadata;
        try {
          const histFiles = await octokit.pulls.listFiles({ owner, repo, pull_number: meta.pr_number, per_page: 100 });
          const histPatch = histFiles.data.map((f: any) => f.patch || "").join("\n");
          return {
            number: meta.pr_number,
            title: meta.title,
            author: meta.author,
            diff: histPatch,
            score: m.score,
            url: meta.pr_url
          };
        } catch {
          return null;
        }
      }));

      const activeCandidates = candidates.filter(c => c !== null) as any[];

      // 4. Perform Unified Deep Analysis
      const analysis = await this.performDeepAnalysis(
        combinedPatch,
        { number: pr.number, title: pr.title, author: pr.user.login },
        activeCandidates,
        visionDoc
      );

      // Map primary match URL for reporting
      let duplicateOfUrl = undefined;
      if (analysis.isDuplicate && analysis.primaryMatchPr) {
        const match = activeCandidates.find(c => c.number === analysis.primaryMatchPr);
        duplicateOfUrl = match?.url;
      }

      return {
        isDuplicate: analysis.isDuplicate,
        alignsWithVision: analysis.alignsWithVision,
        reasoning: analysis.reasoning,
        qualityScore: analysis.qualityScore,
        duplicateOfUrl,
        type: analysis.type
      };
    } catch (e) {
      console.error(`Error triaging PR #${prNumber}:`, e);
      return null;
    }
  }

  /**
   * Shared reasoning engine for both Bot and Sweep flows.
   * Logic: Gemini 2.0 -> Groq Fallback.
   */
  async performDeepAnalysis(
    incomingDiff: string,
    incomingMeta: { number: number, title: string, author: string },
    candidates: any[],
    visionDoc: string | null = null
  ): Promise<AnalysisResult> {
    try {
      // Primary Pass: Gemini 2.0 (High Depth + Vision Support)
      return await geminiService.analyzeRedundancy(incomingDiff, incomingMeta, candidates, visionDoc);
    } catch (err) {
      console.warn("🔄 Gemini failure. Falling back to Groq Layer...");
      // Secondary Pass: Groq (Llama 3 70B)
      return await groqService.analyzeRedundancy(incomingDiff, incomingMeta, candidates, visionDoc);
    }
  }
}

export const triageService = new TriageService();
