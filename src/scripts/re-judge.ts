import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';
import { geminiService } from '../services/gemini.js';
import { groqService } from '../services/groq.js';

/**
 * RE-JUDGE SCRIPT
 * Usage: node dist/scripts/re-judge.js <logDir> <prNumber> [provider]
 */

async function main() {
  const args = process.argv.slice(2);
  const logDir = args[0];
  const prNumber = parseInt(args[1]);
  const provider = args[2] || 'gemini'; // 'gemini' or 'groq'

  if (!logDir || isNaN(prNumber)) {
    console.error("Usage: node dist/scripts/re-judge.js <logDir> <prNumber> [provider]");
    process.exit(1);
  }

  try {
    const queuePath = path.join(logDir, '04_reasoning_queue.json');
    const queueData = JSON.parse(await fs.readFile(queuePath, 'utf-8'));
    
    // Find the entry in the queue
    const entry = queueData.queue.find((e: any) => e.pr_number === prNumber);
    if (!entry) {
      console.error(`PR #${prNumber} not found in reasoning queue: ${queuePath}`);
      process.exit(1);
    }

    console.log(`\n⚖️  Re-judging PR #${prNumber}: "${entry.pr_title}"`);
    console.log(`🔗 URL: ${entry.pr_url}`);
    console.log(`🏢 Provider: ${provider.toUpperCase()}`);

    // For simplicity in the script, we'll fetch the diffs from the queue or mock them 
    // if logic requires it. Actually, the queue should ideally have the diffs 
    // IF we updated it to include them. 
    // Since 04_reasoning_queue.json doesn't have the diff text (it stays in memory),
    // we'll need to fetch them once more for this ONE PR pair if we aren't using 
    // a full-snapshot log.
    
    // WAIT: I want this to be TRULY token efficient. 
    // I will modify the sweep script to save the 'incomingPatch' and 'candidateDiffs' 
    // to a debug file so we can rerun without fetching.
    
    // FOR NOW: Let's assume we fetch them once for the targeted PR to keep it simple.
    // Or better: Use the 'prs' data from 01_fetched_prs.json and upstash if needed.
    
    // Actually, I'll just use the Octokit to fetch for this one pair. 
    // It's just one call.
    
    const { ProbotOctokit } = await import("probot");
    const octokit = new ProbotOctokit({ auth: process.env.GITHUB_TOKEN });
    const [owner, repo] = (process.env.TARGET_REPO || "shadcn-ui/ui").split("/");

    console.log(`📡 Fetching diff for PR #${prNumber}...`);
    const prFiles = await octokit.pulls.listFiles({ owner, repo, pull_number: prNumber });
    const incomingDiff = prFiles.data.map((f: any) => f.patch || "").join("\n");

    const candidates = await Promise.all(entry.all_candidates.slice(0, 3).map(async (c: any) => {
      console.log(`📡 Fetching diff for Candidate #${c.id}...`);
      const cFiles = await octokit.pulls.listFiles({ owner, repo, pull_number: parseInt(c.id) });
      return {
        number: parseInt(c.id),
        title: c.title,
        author: "unknown",
        diff: cFiles.data.map((f: any) => f.patch || "").join("\n"),
        url: c.url,
        score: c.score
      };
    }));

    const result = provider === 'gemini' 
      ? await geminiService.analyzeRedundancy(incomingDiff, { number: prNumber, title: entry.pr_title, author: entry.pr_author }, candidates)
      : await groqService.analyzeRedundancy(incomingDiff, { number: prNumber, title: entry.pr_title, author: entry.pr_author }, candidates);

    console.log("\n" + "=".repeat(40));
    console.log(`RESULT (Duplicate: ${result.isDuplicate})`);
    console.log(`Type: ${result.type.toUpperCase()}`);
    console.log(`Confidence: ${result.confidence}`);
    console.log(`Reasoning: ${result.reasoning}`);
    console.log("=".repeat(40) + "\n");

  } catch (err: any) {
    console.error("Error during re-judge:", err);
  }
}

main();
