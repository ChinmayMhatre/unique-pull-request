import { geminiService } from "./gemini.js";
import { upstashService, PRMetadata } from "./upstash.js";
import { ProbotOctokit } from "probot";

export interface TriageResult {
  isDuplicate: boolean;
  alignsWithVision: boolean;
  reasoning: string;
  qualityScore: number;
  duplicateOfUrl?: string;
}

export class TriageService {
  async triagePR(
    octokit: InstanceType<typeof ProbotOctokit>,
    owner: string,
    repo: string,
    prNumber: number,
    visionDoc: string | null
  ): Promise<TriageResult | null> {
    try {
      // 1. Fetch and clean PR files
      const prRes = await octokit.pulls.get({ owner, repo, pull_number: prNumber });
      const pr = prRes.data;
      
      const filesRes = await octokit.pulls.listFiles({
        owner,
        repo,
        pull_number: prNumber,
        per_page: 100
      });
      
      const relevantFiles = filesRes.data.filter((f: any) => {
        const name = f.filename.toLowerCase();
        return !name.endsWith("package-lock.json") && 
               !name.endsWith("yarn.lock") && 
               !name.endsWith(".svg") &&
               !name.endsWith("pnpm-lock.yaml");
      });

      // Token Safety: Skip massive PRs and truncate diffs strictly
      if (relevantFiles.length > 15) {
        console.warn(`PR #${prNumber} too large (${relevantFiles.length} files). Skipping to protect tokens.`);
        return null;
      }
      
      const combinedPatch = relevantFiles.map((f: any) => f.patch || "").join("\n").substring(0, 3500);
      
      if (!combinedPatch.trim()) return null;

      // 2. Generate Embedding
      const embedding = await geminiService.generateEmbedding(combinedPatch);
      if (!embedding.length) return null;

      // 3. Vector Search
      const similarPRs = await upstashService.findSimilarPRs(embedding, 3);
      const topMatch = similarPRs.find((m: any) => {
         const meta = m.metadata as unknown as PRMetadata;
         return meta.pr_number !== prNumber && (m.score || 0) > 0.85;
      });

      let historicalPatch = null;
      let historicalMeta = null;

      if (topMatch) {
        historicalMeta = topMatch.metadata as unknown as PRMetadata;
        const histFiles = await octokit.pulls.listFiles({
          owner,
          repo,
          pull_number: historicalMeta.pr_number,
          per_page: 100
        });
        historicalPatch = histFiles.data.filter((f: any) => {
           const n = f.filename.toLowerCase();
           return !n.endsWith("lock.json") && !n.endsWith(".svg");
        }).map((f: any) => f.patch || "").join("\n").substring(0, 3500);
      }

      // 4. Gemini Review
      const review = await geminiService.performReview(combinedPatch, historicalPatch, {
        incomingBase: pr.base.ref,
        historicalBase: historicalMeta?.base_branch || null,
        incomingAuthor: pr.user.login,
        historicalAuthor: historicalMeta?.author || null,
        visionDoc: visionDoc
      });

      // 5. Sync Vector DB (Enabled for demo learning)
      await upstashService.upsertPREmbedding(prNumber.toString(), embedding, {
        pr_number: prNumber,
        pr_url: pr.html_url,
        author: pr.user.login,
        base_branch: pr.base.ref,
        title: pr.title
      });

      return {
        isDuplicate: review.is_duplicate,
        alignsWithVision: review.aligns_with_vision,
        reasoning: review.reasoning,
        qualityScore: review.quality_score,
        duplicateOfUrl: historicalMeta?.pr_url
      };
    } catch (e) {
      console.error(`Error triaging PR #${prNumber}:`, e);
      return null;
    }
  }
}

export const triageService = new TriageService();
