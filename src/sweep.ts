import 'dotenv/config';
import { ProbotOctokit } from "probot";
import { triageService } from "./services/triage.js";
import { upstashService } from "./services/upstash.js";
import { geminiService } from "./services/gemini.js";

async function main() {
  const args = process.argv.slice(2);
  const isResume = args.includes("--resume");
  const limitArg = args.indexOf("--limit");
  const limit = limitArg !== -1 ? parseInt(args[limitArg + 1]) : 500;
  const repoFullPath = args.find(a => a.includes("/"));

  if (!repoFullPath) {
    console.error("Usage: npm run sweep <owner>/<repo> [--resume]");
    process.exit(1);
  }

  const [owner, repo] = repoFullPath.split("/");
  if (!owner || !repo) {
    console.error("Invalid repo format. Use owner/repo");
    process.exit(1);
  }

  console.log("\n" + "=".repeat(60));
  console.log(`🛡️  RepoShield Unified Sentinel Sweep: ${owner}/${repo}`);
  console.log(`🚀 Mode: ${isResume ? "RESUME" : "FRESH"}`);
  console.log("=".repeat(60) + "\n");

  const octokit = new ProbotOctokit({
    throttle: { enabled: false },
    retry: { enabled: false }
  });

  if (process.env.GITHUB_TOKEN) {
    octokit.hook.before("request", async (options) => {
      options.headers.authorization = `token ${process.env.GITHUB_TOKEN}`;
    });
  }

  try {
    // 0. Fetch PR history with Callback Sieve
    console.log(`🔍 Phase 0: Fetching relevant PR history (Target: ${limit})...`);
    let fetchedCount = 0;
    let filteredOutCount = 0;

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

        if (isBot || isDraft || !isValidBranch) {
          filteredOutCount++;
          return false;
        }

        fetchedCount++;
        return true;
      });

      // Stop fetching if we've fulfilled the requested limit
      if (fetchedCount >= limit) done();

      return filteredChunk;
    });

    console.log(`✅ Collected ${prs.length} relevant PRs (Filtered out ${filteredOutCount} bots/drafts).`);

    const namespace = `${owner}/${repo}`;
    const DEDUPE_THRESHOLD = 0.85; 
    const prCache: Record<number, { patch: string; embedding: number[]; title?: string; author?: string }> = {}; 

    // 1. Ingestion (Conditional)
    if (isResume) {
      console.log(`⏩ Skipping Phase 1 (Resume Mode active). Using existing Upstash data.\n`);
    } else {
      console.log(`🧠 Phase 1: Ingesting PRs into Project Memory (Upstash)...`);
      for (let i = 0; i < prs.length; i++) {
        const pr = prs[i];
        
        try {
          // SHA Fingerprinting: Check if cache is fresh
          const meta = await upstashService.getMetadataById(pr.number.toString(), namespace);
          if (meta && meta.latest_sha === pr.head.sha) {
            process.stdout.write(`\r[${i + 1}/${prs.length}] ✅ Fresh: #${pr.number} (SHA Match)`.padEnd(60));
            continue;
          }

          if (meta) {
             process.stdout.write(`\r[${i + 1}/${prs.length}] 🔄 Refreshing: #${pr.number} (Stale SHA)`.padEnd(60));
          } else {
             process.stdout.write(`\r[${i + 1}/${prs.length}] 📥 Ingesting: #${pr.number} (New)`.padEnd(60));
          }
          
          await new Promise(r => setTimeout(r, 1000)); 
          const filesRes = await octokit.pulls.listFiles({ owner, repo, pull_number: pr.number });
          
          // Constraint: 15 file limit
          if (filesRes.data.length > 15) continue; 

          const { ContextOptimizer } = await import("./services/optimizer.js");
          const rawPatch = filesRes.data.map(f => f.patch || "").join("\n");
          const patch = ContextOptimizer.cleanDiff(rawPatch, 1500);

          if (!patch.trim()) continue;

          const embedding = await geminiService.generateEmbedding(patch);
          prCache[pr.number] = { patch, embedding };

          await upstashService.upsertPREmbedding(pr.number.toString(), embedding, {
            pr_number: pr.number,
            pr_url: pr.html_url,
            author: pr.user?.login || "unknown",
            base_branch: pr.base.ref,
            title: pr.title,
            repo_name: `${owner}/${repo}`,
            latest_sha: pr.head.sha
          }, namespace);
        } catch (err: any) {
          process.stdout.write(`\n   ⚠️  Skipped Ingestion #${pr.number}: ${err?.message || "Error"}\n`);
        }
      }
      console.log(`\n✅ Ingestion Complete.\n`);
    }

    // 2. Vector Sieve
    console.log(`🔍 Phase 2: Vector Sieve (High-Speed Scanning)...`);
    const reasoningQueue: any[] = [];
    const CONCURRENCY_LIMIT = 5;

    for (let i = 0; i < prs.length; i += CONCURRENCY_LIMIT) {
      const chunk = prs.slice(i, i + CONCURRENCY_LIMIT);
      
      await Promise.all(chunk.map(async (pr, index) => {
        const globalIndex = i + index + 1;
        let embedding: number[] | undefined = prCache[pr.number]?.embedding;
        
        if (!embedding) {
          const vectorRes = await upstashService.fetchVectorById(pr.number.toString(), namespace);
          if (vectorRes) {
            embedding = vectorRes;
          }
        }

        if (!embedding) {
          try {
            process.stdout.write(`\r[${globalIndex}/${prs.length}] Generating Vector: #${pr.number}...`);
            const { ContextOptimizer } = await import("./services/optimizer.js");
            const filesRes = await octokit.pulls.listFiles({ owner, repo, pull_number: pr.number });
            if (filesRes.data.length > 15) return; // Enforce 15 file limit

            const rawPatch = filesRes.data.map(f => f.patch || "").join("\n");
            const patch = ContextOptimizer.cleanDiff(rawPatch, 1500);
            
            if (!patch.trim()) return;

            embedding = await geminiService.generateEmbedding(patch);
            prCache[pr.number] = { title: pr.title, author: pr.user?.login || "unknown", embedding, patch };
          } catch (err) {
            return;
          }
        }

        if (!embedding) return;

        // Discovery Pool: Fetch 8 candidates to bypass noise, will be pruned in reasoning phase
        const candidates = await upstashService.findSimilarPRs(embedding, namespace, 8);
        const validCandidates = candidates.filter(c => c.id !== pr.number.toString());
        
        const bestCandidate = validCandidates[0];
        process.stdout.write(`\r[${globalIndex}/${prs.length}] Top Score for #${pr.number}: ${(bestCandidate?.score || 0).toFixed(4)}...`);
        
        if (!bestCandidate || bestCandidate.score < DEDUPE_THRESHOLD) {
          return;
        }

        reasoningQueue.push({ pr, validCandidates, incomingPatch: prCache[pr.number]?.patch });
      }));
    }

    console.log(`\n\n✅ Scan Complete. ${prs.length - reasoningQueue.length} PRs Fast-Tracked as UNIQUE.`);

    // --- Option 1: Deduplicate symmetric pairs (A→B and B→A are the same pair) ---
    const seenPairs = new Set<string>();
    const dedupedQueue = reasoningQueue.filter(({ pr, validCandidates }) => {
      const topCandidateId = validCandidates[0]?.id;
      const pairKey = [pr.number.toString(), topCandidateId].sort().join("-");
      if (seenPairs.has(pairKey)) return false;
      seenPairs.add(pairKey);
      return true;
    });
    console.log(`🔑 Pair Dedup: ${reasoningQueue.length} flagged → ${dedupedQueue.length} unique pairs.`);
    console.log(`🧠 Phase 3: Unified Deep Reasoning (${dedupedQueue.length} PRs in queue)...`);

    const results = [];
    for (let i = 0; i < dedupedQueue.length; i++) {
       const { pr, validCandidates, incomingPatch: cachedPatch } = dedupedQueue[i];
       let incomingPatch = cachedPatch;

       process.stdout.write(`\r[${i + 1}/${dedupedQueue.length}] Reasoning Judge: #${pr.number}...`);

       // --- Option 2: Trust the vector at ≥0.97 — skip LLM entirely ---
       const topScore = validCandidates[0]?.score || 0;
       if (topScore >= 0.97) {
         results.push({
           number: pr.number,
           type: "shadow",
           duplicateOf: `#${validCandidates[0].id}`,
           reasoning: `Vector similarity ${topScore.toFixed(4)} — near-identical diff fingerprint. LLM skipped.`
         });
         process.stdout.write("\n");
         console.log(`   ⚡ [PR #${pr.number}] AUTO-FLAGGED (Score: ${topScore.toFixed(4)} ≥ 0.97) — LLM skipped.`);
         continue;
       }

       try {
         await new Promise(r => setTimeout(r, 12000)); // Gemini Free Tier pacing
         
         if (!incomingPatch) {
           const filesRes = await octokit.pulls.listFiles({ owner, repo, pull_number: pr.number });
           incomingPatch = filesRes.data.map(f => f.patch || "").join("\n");
         }

         const candidateDetails = (await Promise.all(validCandidates.map(async (c: any) => {
           try {
             const cFiles = await octokit.pulls.listFiles({ owner, repo, pull_number: parseInt(c.id) });
             const cPatch = cFiles.data.map(f => f.patch || "").join("\n");
             return { 
                number: parseInt(c.id), 
                title: c.metadata.title, 
                author: c.metadata.author, 
                diff: cPatch, 
                score: c.score 
             };
           } catch { return null; }
         }))).filter(c => c !== null) as any[];

         // USE UNIFIED SERVICE LAYER (Gemini -> Groq Fallback)
         const analysis = await triageService.performDeepAnalysis(
           incomingPatch,
           { number: pr.number, title: pr.title, author: pr.user?.login || "unknown" },
           candidateDetails,
           null // Constraint: Vision explicitly disabled for sweep
         );

         if (analysis.isDuplicate) {
           results.push({
             number: pr.number,
             type: analysis.type,
             duplicateOf: analysis.primaryMatchPr ? `#${analysis.primaryMatchPr}` : "-",
             reasoning: analysis.reasoning
           });
           process.stdout.write("\n");
           console.log(`   🔸 [PR #${pr.number}] ${analysis.type.toUpperCase()} detected! (Matches #${analysis.primaryMatchPr})`);
           console.log(`      Reasoning: ${analysis.reasoning.substring(0, 100)}...`);
         }
       } catch (err: any) {
         process.stdout.write(`\n   ⚠️  Error on Reasoning #${pr.number}: ${err?.message}\n`);
       }
    }

    // Final Summary Table
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

  } catch (e) {
    console.error("\n❌ Fatal Error during sweep:", e);
  }
}

main();
