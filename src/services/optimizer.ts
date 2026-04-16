/**
 * TypeScript Context Optimizer
 * Semantic logic to reduce LLM token usage for PR duplication checks.
 */

export interface Candidate {
  number: number;
  title: string;
  author: string;
  diff: string;
  score?: number;
}

export class ContextOptimizer {
  private static NOISE_EXTENSIONS = ['.json', '.lock', '.md', '.txt', '.svg', '.png', '.jpg', '.jpeg', '.gif', '.pdf'];
  private static CRITICAL_FILES = ['package.json', 'tsconfig.json', 'tailwind.config'];

  /**
   * Cleans a git diff by stripping noise files, unchanged imports, and boilerplate.
   */
  static cleanDiff(diff: string, maxChars: number = 2500): string {
    if (!diff) return "";

    const lines = diff.split('\n');
    const cleanedLines: string[] = [];
    let currentFileIsNoise = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // File header detection (covers diff --git, --- a/, +++ b/)
      const fileMatch = line.match(/^(?:diff --git [ab]\/|--- [ab]\/|\+\+\+ [ab]\/)(.+)$/);
      if (fileMatch) {
        const filePath = fileMatch[1].trim().split(' ')[0]; // Handle "a/path b/path" in diff --git
        currentFileIsNoise = this.isNoiseFile(filePath);

        if (currentFileIsNoise) {
          const meta = `[METADATA ONLY] Modified: ${filePath} (Content Omitted)`;
          if (!cleanedLines.includes(meta)) {
            cleanedLines.push(meta);
          }
          continue;
        }
      }

      if (currentFileIsNoise) continue;

      // Identification Patterns
      const isImport = /^[\+\- ]*import\s+/.test(line) || /^[\+\- ]*from\s+['"]/.test(line);
      const isComment = /^[\+\- ]*(\/\/|\/\*|\*)/.test(line);
      const isChange = line.startsWith('+') || line.startsWith('-');

      // 1. Comment Sieve: Strip ALL comments
      if (isComment) continue;

      // 2. Import Sieve: Strip only if unchanged context
      if (isImport && !isChange) continue;

      // 3. Whitespace Compression
      const prefix = line.match(/^[\+\- ]/) ? line[0] : '';
      const mainContent = line.match(/^[\+\- ]/) ? line.slice(1) : line;
      const compressed = mainContent.trim().replace(/\s+/g, ' ');

      // Skip lines that are now empty (unless they were added/removed)
      if (!compressed && !isChange) continue;

      cleanedLines.push(`${prefix}${compressed}`);
    }

    let result = cleanedLines.join('\n');

    // If still too large, perform strict "Hunk-Only" extraction
    if (result.length > maxChars) {
      result = this.extractHunks(cleanedLines, maxChars);
    }

    // Deduplicate identical lines
    return this.deduplicateLines(result);
  }

  /**
   * Selects an optimal subset of candidates based on similarity scores.
   */
  static pruneCandidates(candidates: Candidate[], limit: number = 3): Candidate[] {
    if (candidates.length === 0) return [];

    const sorted = [...candidates].sort((a, b) => (b.score || 0) - (a.score || 0));
    const topScore = sorted[0].score || 0;

    if (topScore > 0.96) {
      return [sorted[0]];
    }

    return sorted
      .filter(c => (c.score || 0) > 0.82)
      .slice(0, limit);
  }

  /**
   * Extracts the unique file paths modified in a diff.
   */
  static getModifiedFiles(diff: string): string[] {
    if (!diff) return [];
    const lines = diff.split('\n');
    const files = new Set<string>();

    for (const line of lines) {
      const fileMatch = line.match(/^(?:diff --git [ab]\/|--- [ab]\/|\+\+\+ [ab]\/)(.+)$/);
      if (fileMatch) {
        const filePath = fileMatch[1].trim().split(' ')[0];
        files.add(filePath);
      }
    }

    return Array.from(files);
  }

  /**
   * Extracts unique "scopes" (top-level or double-level directories) from file paths.
   */
  static extractScopes(files: string[]): string[] {
    const scopes = new Set<string>();
    for (const file of files) {
      const parts = file.split('/');
      if (parts.length > 2) {
        // e.g., apps/www/components -> apps/www/components
        // e.g., packages/shadcn/src -> packages/shadcn
        scopes.add(parts.slice(0, 3).join('/'));
      } else if (parts.length > 1) {
        scopes.add(parts[0]);
      } else {
        scopes.add('root');
      }
    }
    return Array.from(scopes);
  }

  /**
   * Calculates the number of overlapping files between two sets of paths.
   */
  static calculatePathIntersection(filesA: string[], filesB: string[]): number {
    const setA = new Set(filesA);
    let intersection = 0;
    for (const file of filesB) {
      if (setA.has(file)) intersection++;
    }
    return intersection;
  }

  private static isNoiseFile(path: string): boolean {
    const lowerPath = path.toLowerCase();
    if (this.CRITICAL_FILES.some(f => lowerPath.includes(f))) {
      return false;
    }
    return this.NOISE_EXTENSIONS.some(ext => lowerPath.endsWith(ext));
  }

  /**
   * Extracts lines with + / - and preserves metadata + structural headers.
   */
  private static extractHunks(lines: string[], maxChars: number): string {
    const result: string[] = [];
    let charCount = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const isStructure = line.startsWith('@@') || line.startsWith('diff') || line.startsWith('---') || line.startsWith('+++') || line.startsWith('[METADATA');
      const isChange = line.startsWith('+') || line.startsWith('-');

      if (isStructure || isChange) {
        if (charCount + line.length > maxChars) {
          result.push("... [Diff truncated] ...");
          break;
        }
        result.push(line);
        charCount += line.length + 1;
      }
    }

    return result.join('\n');
  }

  private static deduplicateLines(text: string): string {
    const lines = text.split('\n');
    const seen = new Set<string>();
    const result: string[] = [];

    for (const line of lines) {
      if (line.length > 20 && seen.has(line)) {
        continue;
      }
      result.push(line);
      seen.add(line);
    }

    return result.join('\n');
  }
}
