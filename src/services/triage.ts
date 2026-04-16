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
        rawPatch,
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
   * Orchestrates automatic fallback across prioritized Gemini and Groq models.
   */
  async performDeepAnalysis(
    incomingDiff: string,
    incomingMeta: { number: number, title: string, author: string },
    candidates: any[],
    visionDoc: string | null = null
  ): Promise<AnalysisResult> {
    const { modelRouter } = await import("./modelRouter.js");

    while (true) {
      const model = modelRouter.getNextAvailableModel();
      
      if (!model) {
        throw new Error("❌ ALL MODELS RATE-LIMITED. Cannot proceed with reasoning.");
      }

      try {
        console.log(`\n   🧠 [PR #${incomingMeta.number}] Judging with ${model.id} (${model.provider.toUpperCase()})...`);
        
        // Resilience Wrapper: Handle 503 with retries before falling back
        const executeWithRetry = async (retries = 3, backoff = 2000) => {
          for (let attempt = 0; attempt < retries; attempt++) {
            try {
              return model.provider === 'gemini' 
                ? await geminiService.analyzeRedundancy(incomingDiff, incomingMeta, candidates, visionDoc, model.id)
                : await groqService.analyzeRedundancy(incomingDiff, incomingMeta, candidates, visionDoc, model.id);
            } catch (err: any) {
              const isServiceErr = err?.message?.includes('503') || err?.message?.includes('504') || err?.message?.includes('Service Unavailable');
              if (isServiceErr && attempt < retries - 1) {
                const wait = backoff * Math.pow(2, attempt) + (Math.random() * 1000);
                console.warn(`      ⚠️  Model ${model.id} busy (503). Retrying in ${Math.round(wait)}ms... (Attempt ${attempt + 1}/${retries})`);
                await new Promise(r => setTimeout(r, wait));
                continue;
              }
              throw err; // Out of retries or different error
            }
          }
          throw new Error(`Max retries reached for model ${model.id}`);
        };

        const result = await executeWithRetry();
        if (!result) throw new Error("LLM returned empty result after retries");

        // --- SANITY CHECK: Ensure type 'unique' never has isDuplicate = true ---
        if (result.type === 'unique') {
          result.isDuplicate = false;
        } else if (!result.isDuplicate) {
          // If already flagged as false, ensure type is recorded as unique
          result.type = 'unique';
        }

        modelRouter.recordUsage(model.id);
        return { ...result, modelId: model.id };

      } catch (err: any) {
        // Detect Rate Limit (429) or persistent Service Error (503 after retries)
        const isRateLimit = err?.message?.includes('429') || 
                           err?.message?.includes('quota') || 
                           err?.message?.includes('Rate limit');
        
        const isPersistentServiceErr = err?.message?.includes('503') || err?.message?.includes('504');

        if (isRateLimit || isPersistentServiceErr) {
          // If it's a persistent 503, cooler down for this session
          modelRouter.markRateLimited(model.id);
          console.warn(`🔄 ${isRateLimit ? "Rate limit" : "Persistent 503"} hit. Falling back to next available model...`);
          continue; // Try next model in loop
        }

        // For other errors, log and bubble up
        console.error(`⚠️  Model ${model.id} failed with non-recoverable error:`, err.message);
        throw err;
      }
    }
  }
}

export const triageService = new TriageService();
