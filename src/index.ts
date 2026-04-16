import { Probot } from "probot";
import { geminiService } from "./services/gemini.js";
import { upstashService } from "./services/upstash.js";
import { triageService } from "./services/triage.js";
import 'dotenv/config';

export default (app: Probot) => {
  app.on(["pull_request.opened", "pull_request.synchronize"], async (context) => {
    app.log.info("Received pull_request event");
    
    const payload = context.payload as any;
    const pr = payload.pull_request;
    const author = pr.user.login;
    const { owner, repo } = context.repo();
    
    // 1. Auto-Bypass
    if (author.includes("[bot]") || author === "dependabot[bot]" || author === "renovate[bot]") {
      app.log.info(`Bypassing PR from bot: ${author}`);
      return;
    }

    // 2. Fetch Project Vision
    let visionDoc: string | null = null;
    try {
      const visionRes = await context.octokit.repos.getContent({
        owner,
        repo,
        path: "VISION.md"
      });
      if ("content" in visionRes.data) {
        visionDoc = Buffer.from(visionRes.data.content, 'base64').toString();
      }
    } catch (e) {
      app.log.info("No VISION.md found. Skipping alignment check.");
    }
    
    // 3. Perform Triage
    const c = {
      reset: "\x1b[0m",
      bold: "\x1b[1m",
      cyan: "\x1b[36m",
      green: "\x1b[32m",
      red: "\x1b[31m",
      yellow: "\x1b[33m",
      dim: "\x1b[2m"
    };

    console.log(`\n${c.cyan}${c.bold}${"=".repeat(60)}${c.reset}`);
    console.log(`${c.cyan}${c.bold}🛡️  REPO SHIELD SENTINEL:${c.reset} New PR Detected [#${pr.number}]`);
    console.log(`${c.dim}👤 Author: ${author}${c.reset}`);
    console.log(`${c.dim}📝 Title:  "${pr.title}"${c.reset}`);
    console.log(`${c.cyan}${c.bold}${"=".repeat(60)}${c.reset}`);
    
    process.stdout.write(`${c.yellow}🔍 Scouring Vector Space for semantic siblings...${c.reset}`);
    const review = await triageService.triagePR(context.octokit as any, owner, repo, pr.number, visionDoc);
    process.stdout.write(` ${c.green}Done.${c.reset}\n`);

    if (!review) {
       console.log(`${c.dim}⏭️  SKIP: PR #${pr.number} (No relevant logic changes).${c.reset}`);
       return;
    }

    // 4. Premium CLI Report
    console.log(`\n${c.cyan}┌────────────────────────────────────────────────────────────┐${c.reset}`);
    console.log(`${c.cyan}│${c.reset} ${c.bold}${"TRIAGE RESULT: PR #" + pr.number}${c.reset}${"".padEnd(38 - pr.number.toString().length)} ${c.cyan}│${c.reset}`);
    console.log(`${c.cyan}├────────────────────────────────────────────────────────────┤${c.reset}`);
    
    const dupeStatus = review.isDuplicate ? `${c.red}❌ REJECTED (Duplicate)${c.reset}` : `${c.green}✅ UNIQUE${c.reset}`;
    console.log(`${c.cyan}│${c.reset} Duplicate Check: ${dupeStatus.padEnd(review.isDuplicate ? 48 : 36)} ${c.cyan}│${c.reset}`);
    
    if (review.isDuplicate) {
      const dupeId = review.duplicateOfUrl?.split('/').pop() || "unknown";
      console.log(`${c.cyan}│${c.reset} Matches PR:      ${(c.yellow + "#" + dupeId + c.reset).padEnd(52)} ${c.cyan}│${c.reset}`);
    }

    const visionStatus = review.alignsWithVision ? `${c.green}✅ ALIGNED${c.reset}` : `${c.red}🚩 MISMATCH (Violation)${c.reset}`;
    console.log(`${c.cyan}│${c.reset} Project Align:   ${visionStatus.padEnd(review.alignsWithVision ? 36 : 48)} ${c.cyan}│${c.reset}`);
    
    const scoreColor = review.qualityScore > 7 ? c.green : (review.qualityScore > 4 ? c.yellow : c.red);
    console.log(`${c.cyan}│${c.reset} Quality Score:   ${(scoreColor + review.qualityScore + "/10" + c.reset).padEnd(48)} ${c.cyan}│${c.reset}`);
    
    console.log(`${c.cyan}├────────────────────────────────────────────────────────────┤${c.reset}`);
    console.log(`${c.cyan}│${c.reset} ${c.bold}AI Reasoning:${c.reset}${"".padEnd(46)} ${c.cyan}│${c.reset}`);
    
    // Wrap reasoning text
    const reasoning = review.reasoning.substring(0, 110) + (review.reasoning.length > 110 ? "..." : "");
    const lines = reasoning.match(/.{1,56}/g) || [];
    lines.forEach(line => {
      console.log(`${c.cyan}│${c.reset} ${c.dim}${line.padEnd(58)}${c.reset} ${c.cyan}│${c.reset}`);
    });
    
    console.log(`${c.cyan}└────────────────────────────────────────────────────────────┘${c.reset}\n`);

    // 5. GitHub Actions (Labels & Comments)
    const labels = [];
    if (review.isDuplicate) labels.push("duplicate");
    if (!review.alignsWithVision) labels.push("alignment-mismatch");

    if (labels.length > 0) {
      await context.octokit.issues.addLabels({
        owner,
        repo,
        issue_number: pr.number,
        labels
      });

      let commentBody = "";
      if (review.isDuplicate) {
        commentBody += `⚠️ **Duplicate PR Detected**\nThis looks like a duplicate of ${review.duplicateOfUrl}.\n\n`;
      }
      if (!review.alignsWithVision) {
        commentBody += `🚩 **Project Alignment Mismatch**\nThis PR does not appear to align with core project goals.\n\n`;
      }
      commentBody += `**AI Reasoning:** ${review.reasoning}\n\n**Quality Score:** ${review.qualityScore}/10`;

      await context.octokit.issues.createComment(context.issue({ body: commentBody }));
    }

    // 5. Upsert Vector (Only if valid)
    const filesRes = await context.octokit.pulls.listFiles({ owner, repo, pull_number: pr.number });
    const patch = filesRes.data.map(f => f.patch || "").join("\n");
    const embedding = await geminiService.generateEmbedding(patch);
    if (embedding.length) {
      await upstashService.upsertPREmbedding(pr.number.toString(), embedding, {
        pr_number: pr.number,
        pr_url: pr.html_url,
        author: author,
        base_branch: pr.base.ref,
        title: pr.title
      });
    }
  });
};
