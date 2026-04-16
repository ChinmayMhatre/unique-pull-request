import { Context } from "probot";
import { geminiService } from "./gemini.js";
import { upstashService } from "./upstash.js";
import { triageService, TriageResult } from "./triage.js";

export class PRProcessor {
  private readonly colors = {
    reset: "\x1b[0m",
    bold: "\x1b[1m",
    cyan: "\x1b[36m",
    green: "\x1b[32m",
    red: "\x1b[31m",
    yellow: "\x1b[33m",
    dim: "\x1b[2m"
  };

  /**
   * Main entry point for processing a Pull Request event.
   */
  async processPR(context: Context<"pull_request.opened" | "pull_request.synchronize">): Promise<void> {
    const { octokit, payload, log } = context;
    const pr = payload.pull_request;
    const author = pr.user.login;
    const { owner, repo } = context.repo();

    log.info(`Processing PR #${pr.number} by ${author}`);

    // 1. Policy check (Bypass)
    if (this.shouldBypass(author)) {
      log.info(`Bypassing PR from bot: ${author}`);
      return;
    }

    // 2. Context Gathering (Vision Doc)
    const visionDoc = await this.fetchVisionDoc(context);

    // 3. Performance Triage
    this.logDetectionStart(pr, author);
    
    process.stdout.write(`${this.colors.yellow}🔍 Scouring Vector Space for semantic siblings...${this.colors.reset}`);
    const review = await triageService.triagePR(octokit as any, owner, repo, pr.number, visionDoc);
    process.stdout.write(` ${this.colors.green}Done.${this.colors.reset}\n`);

    if (!review) {
      console.log(`${this.colors.dim}⏭️  SKIP: PR #${pr.number} (No relevant logic changes).${this.colors.reset}`);
      return;
    }

    // 4. Reporting (CLI & GitHub)
    this.reportToCLI(review, pr.number);
    await this.reportToGitHub(context, review);

    // 5. Memory Sync (Vector DB)
    await this.syncMemory(context);
  }

  /**
   * Logic to determine if a PR should be processed or bypassed.
   */
  private shouldBypass(author: string): boolean {
    return author.includes("[bot]") || 
           author === "dependabot[bot]" || 
           author === "renovate[bot]";
  }

  /**
   * Fetches the VISION.md file from the repository if it exists.
   */
  private async fetchVisionDoc(context: Context<any>): Promise<string | null> {
    const { owner, repo } = context.repo();
    try {
      const visionRes = await context.octokit.repos.getContent({
        owner,
        repo,
        path: "VISION.md"
      });
      if ("content" in visionRes.data) {
        return Buffer.from(visionRes.data.content, 'base64').toString();
      }
    } catch (e) {
      context.log.info("No VISION.md found. Skipping alignment check.");
    }
    return null;
  }

  /**
   * Logs the initial detection header to the CLI.
   */
  private logDetectionStart(pr: any, author: string): void {
    const c = this.colors;
    console.log(`\n${c.cyan}${c.bold}${"=".repeat(60)}${c.reset}`);
    console.log(`${c.cyan}${c.bold}🛡️  REPO SHIELD SENTINEL:${c.reset} New PR Detected [#${pr.number}]`);
    console.log(`${c.dim}👤 Author: ${author}${c.reset}`);
    console.log(`${c.dim}📝 Title:  "${pr.title}"${c.reset}`);
    console.log(`${c.cyan}${c.bold}${"=".repeat(60)}${c.reset}`);
  }

  /**
   * Displays the structured triage result in the CLI.
   */
  private reportToCLI(review: TriageResult, prNumber: number): void {
    const c = this.colors;
    console.log(`\n${c.cyan}┌────────────────────────────────────────────────────────────┐${c.reset}`);
    console.log(`${c.cyan}│${c.reset} ${c.bold}${"TRIAGE RESULT: PR #" + prNumber}${c.reset}${"".padEnd(38 - prNumber.toString().length)} ${c.cyan}│${c.reset}`);
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
  }

  /**
   * Adds labels and comments to the PR based on the triage result.
   */
  private async reportToGitHub(context: Context<"pull_request">, review: TriageResult): Promise<void> {
    const { owner, repo } = context.repo();
    const prNumber = context.payload.pull_request.number;
    const labels = [];
    
    if (review.isDuplicate) labels.push("duplicate");
    if (!review.alignsWithVision) labels.push("alignment-mismatch");

    if (labels.length > 0) {
      await context.octokit.issues.addLabels({
        owner,
        repo,
        issue_number: prNumber,
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
  }

  /**
   * Synchronizes the Vector DB with the new PR's embedding.
   */
  private async syncMemory(context: Context<"pull_request">): Promise<void> {
    const { owner, repo } = context.repo();
    const pr = context.payload.pull_request;
    const author = pr.user.login;

    try {
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
    } catch (e) {
      context.log.error(e as any, `Failed to sync memory for PR #${pr.number}`);
    }
  }
}

export const prProcessor = new PRProcessor();
