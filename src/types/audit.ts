export interface PRSummary {
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

export interface IngestionEntry {
  number: number;
  title: string;
  status: 'sha_hit' | 'refreshed' | 'embedded' | 'skipped_large' | 'skipped_empty' | 'error';
  rawPatchChars?: number;
  optimizedPatchChars?: number;
  reductionPct?: number;
  error?: string;
}

export interface SieveEntry {
  number: number;
  title: string;
  url: string;
  topScore: number;
  topCandidateId: string;
  allCandidates: Array<{ id: string; score: number; title?: string }>;
  status: 'fast_tracked' | 'queued';
}

export interface LLMEntry {
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
