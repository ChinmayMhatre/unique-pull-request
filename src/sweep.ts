import 'dotenv/config';
import { ProbotOctokit } from "probot";
import { triageService } from "./services/triage.js";
import { upstashService } from "./services/upstash.js";
import { geminiService } from "./services/gemini.js";
import fs from 'fs/promises';
import path from 'path';

// ─── Types ────────────────────────────────────────────────────────────────────

interface PRSummary {
  number: number;
  title: string;
  author: string;
  url: string;
  base: string;
  draft: boolean;
  sha: string;
  created_at: string;
  updated_at: string;
}

interface IngestionEntry {
  number: number;
  title: string;
  status: 'sha_hit' | 'refreshed' | 'embedded' | 'skipped_large' | 'skipped_empty' | 'error';
  rawPatchChars?: number;
  optimizedPatchChars?: number;
  reductionPct?: number;
  error?: string;
}

interface SieveEntry {
  number: number;
  title: string;
  url: string;
  topScore: number;
  topCandidateId: string;
  allCandidates: Array<{ id: string; score: number; title?: string }>;
  status: 'fast_tracked' | 'queued';
}

interface LLMEntry {
  number: number;
  title: string;
  url: string;
  isDuplicate: boolean;
  type: string;
  confidence?: number;
  primaryMatchPr?: number;
  primaryMatchUrl?: string;
  reasoning: string;
  qualityScore: number;
  llmProvider: string; // Dynamic provider/model name
  modelUsed?: string;
}

// ─── SweepLogger ──────────────────────────────────────────────────────────────

class SweepLogger {
  public logDir: string;
  public phaseTimings: Record<string, number> = {};
  private startTime: number;

  constructor(repo: string) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
    const safeRepo = repo.replace('/', '_');
    this.logDir = path.join(process.cwd(), 'logs', `${safeRepo}_${ts}`);
    this.startTime = Date.now();
  }

  async init(config: object) {
    await fs.mkdir(this.logDir, { recursive: true });
    await this.write('00_run_config.json', { ...config, logDir: this.logDir });
    console.log(`   📁 Logs → ${this.logDir}\n`);
  }

  async write(filename: string, data: object) {
    const filepath = path.join(this.logDir, filename);
    await fs.writeFile(filepath, JSON.stringify(data, null, 2), 'utf-8');
    console.log(`   💾 ${filename}`);
  }

  markPhase(name: string) {
    this.phaseTimings[name] = Date.now();
  }

  phaseMs(name: string): number {
    return this.phaseTimings[name] ? Date.now() - this.phaseTimings[name] : 0;
  }

  elapsedMs(): number {
    return Date.now() - this.startTime;
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const isResume = args.includes("--resume");
  const limitArg = args.indexOf("--limit");
  const limit = limitArg !== -1 ? parseInt(args[limitArg + 1]) : 500;
  const repoFullPath = args.find(a => a.includes("/"));

  if (!repoFullPath) {
    console.error("Usage: npm run sweep <owner>/<repo> [--resume] [--limit N]");
    process.exit(1);
  }

  const [owner, repo] = repoFullPath.split("/");
  if (!owner || !repo) {
    console.error("Invalid repo format. Use owner/repo");
    process.exit(1);
  }

  const DEDUPE_THRESHOLD = 0.85;
  const namespace = `${owner}-${repo}`;

  // ─── Init Logger ────────────────────────────────────────────────────────────
  const logger = new SweepLogger(repoFullPath);

  console.log("\n" + "=".repeat(60));
  console.log(`🛡️  RepoShield Unified Sentinel Sweep: ${owner}/${repo}`);
  console.log(`🚀 Mode: ${isResume ? "RESUME" : "FRESH"} | Limit: ${limit}`);
  console.log("=".repeat(60) + "\n");

  await logger.init({
    repo: repoFullPath,
    limit,
    mode: isResume ? 'resume' : 'fresh',
    timestamp: new Date().toISOString(),
    thresholds: { similarityMin: DEDUPE_THRESHOLD },
  });

  const octokit = new ProbotOctokit({
    throttle: { enabled: false },
    retry: { enabled: false },
  });

  if (process.env.GITHUB_TOKEN) {
    octokit.hook.before("request", async (options) => {
      options.headers.authorization = `token ${process.env.GITHUB_TOKEN}`;
    });
  }

  const prCache: Record<number, { patch: string; embedding: number[]; title?: string; author?: string }> = {};

  // Accumulated log data  
  const ingestionLog: IngestionEntry[] = [];
  const sieveLog: SieveEntry[] = [];
  const llmLog: LLMEntry[] = [];
  const errors: Array<{ phase: string; pr?: number; message: string }> = [];

  try {

    // ═══════════════════════════════════════════════════════════════════════════
    // PHASE 0: Fetch PRs from GitHub
    // ═══════════════════════════════════════════════════════════════════════════
    logger.markPhase('fetch');
    console.log(`🔍 Phase 0: Fetching relevant PR history (Target: ${limit})...`);

    let fetchedCount = 0;
    let filteredOutCount = 0;
    const filterBreakdown: Record<string, number> = { bot: 0, draft: 0, invalid_branch: 0 };

    const prs = await octokit.paginate(octokit.pulls.list, {
      owner,
      repo,
      state: "open",
      per_page: 100
      // Default Sort: created, Direction: desc
    }, (response, done) => {
      const filteredChunk = response.data.filter((pr: any) => {
        if (fetchedCount >= limit) return false;

        // 1. Skip Bot PRs
        const isBot = pr.user?.type === 'Bot' || pr.user?.login.includes('[bot]');

        // 2. Skip Drafts
        const isDraft = pr.draft === true;

        // 3. Target Branch Filtering (main/master/devel)
        const isValidBranch = ['main', 'master', 'devel'].includes(pr.base.ref);

        if (isBot) { filteredOutCount++; filterBreakdown.bot++; return false; }
        if (isDraft) { filteredOutCount++; filterBreakdown.draft++; return false; }
        if (!isValidBranch) { filteredOutCount++; filterBreakdown.invalid_branch++; return false; }

        fetchedCount++;
        return true;
      });

      // Stop fetching if we've fulfilled the requested limit
      if (fetchedCount >= limit) done();

      return filteredChunk;
    });

    console.log(`✅ Collected ${prs.length} relevant PRs (Filtered ${filteredOutCount}: ${filterBreakdown.bot} bots, ${filterBreakdown.draft} drafts, ${filterBreakdown.invalid_branch} off-branch).`);

    const fetchedPRsSummary: PRSummary[] = (prs as any[]).map(pr => ({
      number: pr.number,
      title: pr.title,
      author: pr.user?.login || 'unknown',
      url: pr.html_url,
      base: pr.base.ref,
      draft: pr.draft || false,
      sha: pr.head.sha,
      created_at: pr.created_at,
      updated_at: pr.updated_at,
    }));

    await logger.write('01_fetched_prs.json', {
      summary: {
        total_fetched: prs.length,
        total_filtered_out: filteredOutCount,
        filter_breakdown: filterBreakdown,
        phase_duration_ms: logger.phaseMs('fetch'),
      },
      prs: fetchedPRsSummary,
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // PHASE 1: Ingestion (SHA-aware embedding into Upstash)
    // ═══════════════════════════════════════════════════════════════════════════
    if (isResume) {
      console.log(`\n⏩ Skipping Phase 1 (Resume Mode). Using existing Upstash embeddings.\n`);
    } else {
      logger.markPhase('ingestion');
      console.log(`\n🧠 Phase 1: Ingesting PRs into Project Memory (Upstash)...`);

      for (let i = 0; i < prs.length; i++) {
        const pr = prs[i] as any;

        try {
          // SHA Fingerprinting: skip if embedding is fresh
          const meta = await upstashService.getMetadataById(pr.number.toString(), namespace);

          if (meta && meta.latest_sha === pr.head.sha) {
            process.stdout.write(`\r[${i + 1}/${prs.length}] ✅ Fresh (SHA hit): #${pr.number}`.padEnd(70));
            ingestionLog.push({ number: pr.number, title: pr.title, status: 'sha_hit' });
            continue;
          }

          const isRefresh = !!meta;
          process.stdout.write(`\r[${i + 1}/${prs.length}] ${isRefresh ? '🔄 Refreshing' : '📥 Ingesting'}: #${pr.number}`.padEnd(70));

          await new Promise(r => setTimeout(r, 4000)); // Throttled for Gemini 2 Free Tier (15 RPM)
          const filesRes = await octokit.pulls.listFiles({ owner, repo, pull_number: pr.number });

          if (filesRes.data.length > 15) {
            ingestionLog.push({ number: pr.number, title: pr.title, status: 'skipped_large', error: `${filesRes.data.length} files exceeds 15-file limit` });
            continue;
          }

          const { ContextOptimizer } = await import("./services/optimizer.js");
          const rawPatch = filesRes.data.map((f: any) => `--- a/${f.filename}\n+++ b/${f.filename}\n${f.patch || ""}`).join("\n");
          const patch = ContextOptimizer.cleanDiff(rawPatch, 1500);

          if (!patch.trim()) {
            ingestionLog.push({ number: pr.number, title: pr.title, status: 'skipped_empty' });
            continue;
          }

          const rawChars = rawPatch.length;
          const optimizedChars = patch.length;
          const reductionPct = Math.round((1 - optimizedChars / Math.max(rawChars, 1)) * 100);

          const embedding = await geminiService.generateEmbedding(patch);
          prCache[pr.number] = { patch, embedding, title: pr.title, author: pr.user?.login };

          await upstashService.upsertPREmbedding(pr.number.toString(), embedding, {
            pr_number: pr.number,
            pr_url: pr.html_url,
            author: pr.user?.login || "unknown",
            base_branch: pr.base.ref,
            title: pr.title,
            repo_name: `${owner}/${repo}`,
            latest_sha: pr.head.sha,
          }, namespace);

          ingestionLog.push({
            number: pr.number,
            title: pr.title,
            status: isRefresh ? 'refreshed' : 'embedded',
            rawPatchChars: rawChars,
            optimizedPatchChars: optimizedChars,
            reductionPct,
          });

        } catch (err: any) {
          process.stdout.write(`\n   ⚠️  Failed Ingestion #${pr.number}: ${err?.message}\n`);
          ingestionLog.push({ number: pr.number, title: pr.title, status: 'error', error: err?.message });
          errors.push({ phase: 'ingestion', pr: pr.number, message: err?.message });
        }
      }

      const statusCounts = ingestionLog.reduce((acc, e) => {
        acc[e.status] = (acc[e.status] || 0) + 1;
        return acc;
      }, {} as Record<string, number>);

      const embeddedEntries = ingestionLog.filter(e => e.status === 'embedded' || e.status === 'refreshed');
      const avgReduction = embeddedEntries.length > 0
        ? Math.round(embeddedEntries.reduce((s, e) => s + (e.reductionPct || 0), 0) / embeddedEntries.length)
        : 0;

      console.log(`\n✅ Ingestion Complete. Avg optimizer reduction: ${avgReduction}%.`);
      await logger.write('02_ingestion_log.json', {
        summary: {
          total: prs.length,
          status_breakdown: statusCounts,
          avg_optimizer_reduction_pct: avgReduction,
          phase_duration_ms: logger.phaseMs('ingestion'),
        },
        entries: ingestionLog,
      });
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // PHASE 2: Vector Sieve
    // ═══════════════════════════════════════════════════════════════════════════
    logger.markPhase('sieve');
    console.log(`\n🔍 Phase 2: Vector Sieve (High-Speed Scanning)...`);

    const reasoningQueue: any[] = [];
    const CONCURRENCY_LIMIT = 5;

    for (let i = 0; i < prs.length; i += CONCURRENCY_LIMIT) {
      if (i > 0) await new Promise(r => setTimeout(r, 3000)); // Pacing between search bursts
      const chunk = prs.slice(i, i + CONCURRENCY_LIMIT);

      await Promise.all(chunk.map(async (pr: any, index: number) => {
        const globalIndex = i + index + 1;
        let embedding: number[] | undefined = prCache[pr.number]?.embedding;

        if (!embedding) {
          const vectorRes = await upstashService.fetchVectorById(pr.number.toString(), namespace);
          if (vectorRes) embedding = vectorRes;
        }

        if (!embedding) {
          try {
            process.stdout.write(`\r[${globalIndex}/${prs.length}] Generating vector: #${pr.number}...`);
            const { ContextOptimizer } = await import("./services/optimizer.js");
            const filesRes = await octokit.pulls.listFiles({ owner, repo, pull_number: pr.number });
            if (filesRes.data.length > 15) return;

            const rawPatch = filesRes.data.map((f: any) => f.patch || "").join("\n");
            const patch = ContextOptimizer.cleanDiff(rawPatch, 1500);
            if (!patch.trim()) return;

            embedding = await geminiService.generateEmbedding(patch);
            prCache[pr.number] = { title: pr.title, author: pr.user?.login || "unknown", embedding, patch };
          } catch (err: any) {
            errors.push({ phase: 'sieve_embedding', pr: pr.number, message: err?.message });
            return;
          }
        }

        if (!embedding) return;

        const candidates = await upstashService.findSimilarPRs(embedding, namespace, 8);
        const validCandidates = candidates.filter((c: any) => c.id !== pr.number.toString());
        const bestCandidate = validCandidates[0];

        const topScore = bestCandidate?.score || 0;
        const isQueued = topScore >= DEDUPE_THRESHOLD;

        process.stdout.write(
          `\r[${globalIndex}/${prs.length}] #${pr.number} → Top: ${topScore.toFixed(4)} ${isQueued ? '🔶 QUEUED' : '✅ UNIQUE'}`.padEnd(70)
        );

        sieveLog.push({
          number: pr.number,
          title: pr.title,
          url: pr.html_url,
          topScore,
          topCandidateId: bestCandidate?.id || 'none',
          allCandidates: validCandidates.slice(0, 5).map((c: any) => ({
            id: c.id,
            score: c.score,
            title: c.metadata?.title as string || 'unknown',
          })),
          status: isQueued ? 'queued' : 'fast_tracked',
        });

        if (!isQueued) return;

        reasoningQueue.push({ pr, validCandidates, incomingPatch: prCache[pr.number]?.patch });
      }));
    }

    const fastTracked = sieveLog.filter(e => e.status === 'fast_tracked');
    const sieveQueued = sieveLog.filter(e => e.status === 'queued');

    console.log(`\n\n✅ Sieve Complete. ${fastTracked.length} PRs Fast-Tracked as UNIQUE. ${sieveQueued.length} flagged.`);

    await logger.write('03_sieve_results.json', {
      summary: {
        total_processed: sieveLog.length,
        fast_tracked_unique: fastTracked.length,
        queued_for_reasoning: sieveQueued.length,
        threshold_used: DEDUPE_THRESHOLD,
        score_distribution: {
          above_0_97: sieveLog.filter(e => e.topScore >= 0.97).length,
          above_0_90: sieveLog.filter(e => e.topScore >= 0.90 && e.topScore < 0.97).length,
          above_0_85: sieveLog.filter(e => e.topScore >= 0.85 && e.topScore < 0.90).length,
          below_0_85: sieveLog.filter(e => e.topScore < 0.85).length,
        },
        phase_duration_ms: logger.phaseMs('sieve'),
      },
      fast_tracked: fastTracked.map(e => ({ number: e.number, title: e.title, topScore: e.topScore })),
      queued: sieveQueued,
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // PHASE 3: Pair Dedup + LLM Reasoning
    // ═══════════════════════════════════════════════════════════════════════════
    logger.markPhase('reasoning');

    // --- Pair deduplication (A→B and B→A are the same pair) ---
    const seenPairs = new Set<string>();
    const dedupedQueue = reasoningQueue.filter(({ pr, validCandidates }) => {
      const topCandidateId = validCandidates[0]?.id;
      const pairKey = [pr.number.toString(), topCandidateId].sort().join("-");
      if (seenPairs.has(pairKey)) return false;
      seenPairs.add(pairKey);
      return true;
    });

    console.log(`\n🔑 Pair Dedup: ${reasoningQueue.length} flagged → ${dedupedQueue.length} unique pairs.`);
    console.log(`🧠 Phase 3: Unified Deep Reasoning (${dedupedQueue.length} PRs in queue)...`);

    // Write pre-LLM queue snapshot
    await logger.write('04_reasoning_queue.json', {
      summary: {
        raw_queue_size: reasoningQueue.length,
        after_dedup: dedupedQueue.length,
        pairs_eliminated_by_dedup: reasoningQueue.length - dedupedQueue.length,
      },
      queue: dedupedQueue.map(({ pr, validCandidates }) => ({
        pr_number: pr.number,
        pr_title: pr.title,
        pr_url: pr.html_url,
        pr_author: pr.user?.login,
        top_candidate: {
          id: validCandidates[0]?.id,
          score: validCandidates[0]?.score,
          title: validCandidates[0]?.metadata?.title,
          url: validCandidates[0]?.metadata?.pr_url,
        },
        all_candidates: validCandidates.slice(0, 5).map((c: any) => ({
          id: c.id,
          score: c.score,
          title: c.metadata?.title,
          url: c.metadata?.pr_url,
        })),
      })),
    });

    const { modelRouter } = await import("./services/modelRouter.js");
    const results: any[] = [];
    let llmCallCount = 0;

    for (let i = 0; i < dedupedQueue.length; i++) {
      const { pr, validCandidates, incomingPatch: cachedPatch } = dedupedQueue[i];
      let incomingPatch = cachedPatch;

      process.stdout.write(`\r[${i + 1}/${dedupedQueue.length}] Reasoning Judge: #${pr.number}...`.padEnd(60));

      // --- (REMOVED) Auto-flag logic ---
      // Force all candidates to the reasoning judge for 100% semantic accuracy.

      try {
        // --- Smart Pacing ---
        // 1. Skip delay for the first call
        // 2. Dynamic delay based on current model RPM
        if (llmCallCount > 0) {
          const currentModel = modelRouter.getNextAvailableModel();
          const rpm = currentModel?.rpm || 5;
          const delayMs = Math.max(1000, Math.floor(60000 / rpm) + 500);
          await new Promise(r => setTimeout(r, delayMs));
        }
        llmCallCount++;

        if (!incomingPatch) {
          const filesRes = await octokit.pulls.listFiles({ owner, repo, pull_number: pr.number });
          incomingPatch = filesRes.data.map((f: any) => `--- a/${f.filename}\n+++ b/${f.filename}\n${f.patch || ""}`).join("\n");
        }

        const candidateDetails = (await Promise.all(
          validCandidates.map(async (c: any) => {
            try {
              const cFiles = await octokit.pulls.listFiles({ owner, repo, pull_number: parseInt(c.id) });
              return {
                number: parseInt(c.id),
                title: c.metadata.title,
                author: c.metadata.author,
                diff: cFiles.data.map((f: any) => `--- a/${f.filename}\n+++ b/${f.filename}\n${f.patch || ""}`).join("\n"),
                score: c.score,
                url: c.metadata.pr_url,
              };
            } catch { return null; }
          })
        )).filter(c => c !== null) as any[];

        const analysis = await triageService.performDeepAnalysis(
          incomingPatch,
          { number: pr.number, title: pr.title, author: pr.user?.login || "unknown" },
          candidateDetails,
          null // Vision alignment disabled for sweep
        );

        const matchCandidate = candidateDetails.find(c => c.number === analysis.primaryMatchPr);
        const primaryMatchUrl = matchCandidate
          ? `https://github.com/${owner}/${repo}/pull/${analysis.primaryMatchPr}`
          : undefined;

        const llmEntry: LLMEntry = {
          number: pr.number,
          title: pr.title,
          url: pr.html_url,
          isDuplicate: analysis.isDuplicate,
          type: analysis.type,
          confidence: analysis.confidence,
          primaryMatchPr: analysis.primaryMatchPr,
          primaryMatchUrl,
          reasoning: analysis.reasoning,
          qualityScore: analysis.qualityScore,
          llmProvider: analysis.modelId || 'unknown',
          modelUsed: analysis.modelId,
        };
        llmLog.push(llmEntry);

        if (analysis.isDuplicate) {
          results.push({
            number: pr.number,
            type: analysis.type,
            duplicateOf: analysis.primaryMatchPr ? `#${analysis.primaryMatchPr}` : "-",
            reasoning: analysis.reasoning,
            model: analysis.modelId,
          });
          process.stdout.write("\n");
          console.log(`   🔸 [PR #${pr.number}] ${analysis.type.toUpperCase()} (via ${analysis.modelId}) → #${analysis.primaryMatchPr}`);
          console.log(`      ${analysis.reasoning.substring(0, 120)}...`);
        }

      } catch (err: any) {
        process.stdout.write(`\n   ⚠️  Error reasoning #${pr.number}: ${err?.message}\n`);
        errors.push({ phase: 'reasoning', pr: pr.number, message: err?.message });
      }
    }


    // Write Phase 3 LLM results
    await logger.write('05_llm_results.json', {
      summary: {
        total_analyzed: llmLog.length,
        duplicates_found: llmLog.filter(e => e.isDuplicate).length,
        unique: llmLog.filter(e => !e.isDuplicate).length,
        model_usage: modelRouter.getUsageSummary(),
        type_breakdown: llmLog
          .filter(e => e.isDuplicate)
          .reduce((acc, e) => { acc[e.type] = (acc[e.type] || 0) + 1; return acc; }, {} as Record<string, number>),
        phase_duration_ms: logger.phaseMs('reasoning'),
      },
      results: llmLog,
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // Final Terminal Table
    // ═══════════════════════════════════════════════════════════════════════════
    process.stdout.write("\n\n");
    console.log("┌" + "─".repeat(88) + "┐");
    console.log(`│ ${"REPO SHIELD UNIFIED SCAN SUMMARY".padEnd(86)} │`);
    console.log("├──────────┬─────────────────────────────────┬──────────┬───────────────────┤");
    console.log(`│ ${"PR #".padEnd(8)} │ ${"Redundancy Category".padEnd(31)} │ ${"Matches".padEnd(8)} │ ${"Status".padEnd(17)} │`);
    console.log("├──────────┼─────────────────────────────────┼──────────┼───────────────────┤");

    for (const r of results) {
      console.log(`│ #${r.number.toString().padEnd(7)} │ ${r.type.toUpperCase().padEnd(31)} │ ${r.duplicateOf.toString().padEnd(8)} │ ${"❌ REDUNDANT".padEnd(17)} │`);
    }

    console.log("└──────────┴─────────────────────────────────┴──────────┴───────────────────┘");
    console.log(`\n📊  SCAN COMPLETE: ${results.length} Redundancies Found in ${prs.length} PRs.\n`);

    // ═══════════════════════════════════════════════════════════════════════════
    // Final Summary Log
    // ═══════════════════════════════════════════════════════════════════════════
    await logger.write('06_summary.json', {
      repo: repoFullPath,
      run_mode: isResume ? 'resume' : 'fresh',
      timestamp: new Date().toISOString(),
      total_duration_ms: logger.elapsedMs(),
      total_duration_human: `${(logger.elapsedMs() / 1000 / 60).toFixed(1)} min`,
      prs_fetched: prs.length,
      ingestion: {
        sha_cache_hits: ingestionLog.filter(e => e.status === 'sha_hit').length,
        newly_embedded: ingestionLog.filter(e => e.status === 'embedded').length,
        refreshed: ingestionLog.filter(e => e.status === 'refreshed').length,
        skipped_large: ingestionLog.filter(e => e.status === 'skipped_large').length,
        skipped_empty: ingestionLog.filter(e => e.status === 'skipped_empty').length,
        errors: ingestionLog.filter(e => e.status === 'error').length,
      },
      sieve: {
        fast_tracked_unique: fastTracked.length,
        reasoning_queue_raw: reasoningQueue.length,
        reasoning_queue_after_dedup: dedupedQueue.length,
        dedup_pairs_eliminated: reasoningQueue.length - dedupedQueue.length,
      },
      reasoning: {
        total_analyzed: llmLog.length,
        duplicates_found: results.length,
        type_breakdown: results.reduce((acc, r) => {
          acc[r.type] = (acc[r.type] || 0) + 1;
          return acc;
        }, {} as Record<string, number>),
      },
      errors,
      log_files: [
        '00_run_config.json',
        '01_fetched_prs.json',
        '02_ingestion_log.json',
        '03_sieve_results.json',
        '04_reasoning_queue.json',
        '05_llm_results.json',
        '06_summary.json',
      ],
    });

    console.log(`📁 Full logs → ${logger.logDir}\n`);

  } catch (e: any) {
    console.error("\n❌ Fatal Error during sweep:", e);
    await logger.write('error.json', { fatal: e?.message, stack: e?.stack }).catch(() => { });
  }
}

main();
