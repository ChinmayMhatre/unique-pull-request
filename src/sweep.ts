import 'dotenv/config';
import { ProbotOctokit } from "probot";

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

  const { upstashService } = await import("./services/upstash.js");
  const { geminiService } = await import("./services/gemini.js");

  console.log("\n" + "=".repeat(60));
  console.log(`🛡️  RepoShield Two-Pass Sentinel Sweep: ${owner}/${repo}`);
  console.log(`🚀 Mode: ${isResume ? "RESUME (Reuse Upstash Context)" : "FRESH (Re-Ingest Everything)"}`);
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
    // 1. Fetch exactly 500 PRs
    console.log(`🔍 Phase 0: Fetching PR history (Target: 500)...`);
    let prs: any[] = [];
    const iterator = octokit.paginate.iterator(octokit.pulls.list, {
      owner, repo, state: "open", per_page: 100
    });

    for await (const { data } of iterator) {
      prs.push(...data);
      if (prs.length >= limit) {
        prs = prs.slice(0, limit);
        break;
      }
    }
    
    console.log(`✅ Collected ${prs.length} PRs.\n`);

    const DEDUPE_THRESHOLD = 0.85; // Production Threshold
    const prCache: Record<number, { patch: string; embedding: number[]; title?: string; author?: string }> = {}; 

    // 2. Pass 1: Ingestion (Conditional)
    if (isResume) {
      console.log(`⏩ Skipping Phase 1 (Resume Mode active). Using existing Upstash data.\n`);
    } else {
      console.log(`🧠 Phase 1: Ingesting PRs into Project Memory (Upstash)...`);
      for (let i = 0; i < prs.length; i++) {
        const pr = prs[i];
        process.stdout.write(`\r[${i + 1}/${prs.length}] Ingesting: "${pr.title.substring(0, 30)}..."`);
        
        try {
          if (pr.state !== 'open') continue; // Enforce open state strictly
          
          await new Promise(r => setTimeout(r, 1000)); 
          const filesRes = await octokit.pulls.listFiles({ owner, repo, pull_number: pr.number });
          if (filesRes.data.length > 20) continue; 

          const patch = filesRes.data.map(f => f.patch || "").join("\n").slice(0, 4000);
          if (!patch) continue;

          const embedding = await geminiService.generateEmbedding(patch);
          prCache[pr.number] = { patch, embedding };

          await upstashService.upsertPREmbedding(pr.number.toString(), embedding, {
            pr_number: pr.number,
            pr_url: pr.html_url,
            author: pr.user?.login || "unknown",
            base_branch: pr.base.ref,
            title: pr.title
          });
        } catch (err: any) {
          process.stdout.write(`\n   ⚠️  Skipped Ingestion #${pr.number}: ${err?.message || "Error"}\n`);
        }
      }
      console.log(`\n✅ Ingestion Complete.\n`);
    }

    // 3. Pass 2: Vector Sieve (Parallelized Scanning)
    console.log(`🔍 Phase 2: Vector Sieve (High-Speed Scanning)...`);
    const reasoningQueue: any[] = [];
    const CONCURRENCY_LIMIT = 5;

    for (let i = 0; i < prs.length; i += CONCURRENCY_LIMIT) {
      const chunk = prs.slice(i, i + CONCURRENCY_LIMIT);
      
      await Promise.all(chunk.map(async (pr, index) => {
        const globalIndex = i + index + 1;
        let embedding: number[] | undefined = prCache[pr.number]?.embedding;
        
        // RECOVERY: If in RESUME mode or cache is empty, fetch from Upstash
        if (!embedding) {
          const vectorRes = await upstashService.fetchVectorById(pr.number.toString());
          if (vectorRes) {
            embedding = vectorRes;
            prCache[pr.number] = { 
              embedding, 
              patch: "", 
              title: pr.title, 
              author: pr.user.login 
            };
          }
        }

        if (!embedding) {
          try {
            process.stdout.write(`\r[${globalIndex}/${prs.length}] Generating Vector (New PR): #${pr.number}...`);
            const filesRes = await octokit.pulls.listFiles({ owner, repo, pull_number: pr.number });
            const patch = filesRes.data.map(f => f.patch || "").join("\n").slice(0, 4000);
            embedding = await geminiService.generateEmbedding(patch);
            
            // Cache it for the rest of the run
            prCache[pr.number] = { 
              title: pr.title, 
              author: pr.user.login, 
              embedding, 
              patch 
            };
          } catch (err) {
            console.error(`\n⚠️ Failed to generate embedding for #${pr.number} (Skipping):`, err);
            return; // Move to next PR in chunk
          }
        }

        if (!embedding) return;

        const candidates = await upstashService.findSimilarPRs(embedding, 5);
        const validCandidates = candidates.filter(c => c.id !== pr.number.toString());
        
        const bestCandidate = validCandidates[0];
        process.stdout.write(`\r[${globalIndex}/${prs.length}] Top Score for #${pr.number}: ${(bestCandidate?.score || 0).toFixed(4)}...`);
        
        if (!bestCandidate || bestCandidate.score < DEDUPE_THRESHOLD) {
          return;
        }

        // Potential Duplicate Found
        reasoningQueue.push({
          pr,
          validCandidates,
          incomingPatch: prCache[pr.number]?.patch
        });
        process.stdout.write(`\r[${globalIndex}/${prs.length}] 🚩 HIGH RISK Found: #${pr.number} (Count: ${reasoningQueue.length})`);
      }));
    }

    console.log(`\n\n✅ Scan Complete. ${prs.length - reasoningQueue.length} PRs Fast-Tracked as UNIQUE.`);
    console.log(`🧠 Phase 3: Deep Multi-Way Reasoning (${reasoningQueue.length} PRs in queue)...`);
    
    const results = [];
    for (let i = 0; i < reasoningQueue.length; i++) {
      const { pr, validCandidates, incomingPatch: cachedPatch } = reasoningQueue[i];
      let incomingPatch = cachedPatch;

      process.stdout.write(`\r[${i + 1}/${reasoningQueue.length}] Reasoning Judge: #${pr.number}...`);

      try {
        // Rate-Limit Heartbeat (12s for Gemini Free Tier)
        await new Promise(r => setTimeout(r, 12000));
        
        // Recover patches on-the-fly if not cached
        if (!incomingPatch) {
          const filesRes = await octokit.pulls.listFiles({ owner, repo, pull_number: pr.number });
          incomingPatch = filesRes.data.map(f => f.patch || "").join("\n").slice(0, 4000);
        }

        const candidateDetails = (await Promise.all(validCandidates.map(async (c: any) => {
          try {
            const cFiles = await octokit.pulls.listFiles({ owner, repo, pull_number: parseInt(c.id) });
            const cPatch = cFiles.data.map(f => f.patch || "").join("\n").slice(0, 4000);
            return { number: parseInt(c.id), title: c.metadata.title, author: c.metadata.author, diff: cPatch, score: c.score };
          } catch {
            return null;
          }
        }))).filter(c => c !== null) as any[];

        let review;
        try {
          // Primary Reasoning: Gemini 2.0
          review = await geminiService.analyzeRedundancy(incomingPatch, {
            number: pr.number,
            title: pr.title,
            author: pr.user?.login || "unknown"
          }, candidateDetails);
        } catch (err) {
          console.log(`\n   🔄 Gemini Rate-Limited/Error. Falling back to Groq (Llama 3.1 70B)...`);
          const { groqService } = await import("./services/groq.js");
          review = await groqService.analyzeRedundancy(incomingPatch, {
            number: pr.number,
            title: pr.title,
            author: pr.user?.login || "unknown"
          }, candidateDetails);
        }

        if (review.isDuplicate) {
          results.push({
            number: pr.number,
            type: review.type,
            duplicateOf: review.primaryMatchPr ? `#${review.primaryMatchPr}` : "-",
            reasoning: review.reasoning
          });
          process.stdout.write("\n");
          console.log(`   🔸 [PR #${pr.number}] ${review.type.toUpperCase()} detected! (Matches #${review.primaryMatchPr})`);
          console.log(`      Reasoning: ${review.reasoning.substring(0, 100)}...`);
        }
      } catch (err: any) {
        process.stdout.write(`\n   ⚠️  Error on Reasoning #${pr.number}: ${err?.message || "Unknown error"}\n`);
      }
    }

    // 4. Final Premium Summary Table
    process.stdout.write("\n\n");
    console.log("┌" + "─".repeat(88) + "┐");
    console.log(`│ ${"REPO SHIELD OPTIMIZED RESUME SUMMARY".padEnd(86)} │`);
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
