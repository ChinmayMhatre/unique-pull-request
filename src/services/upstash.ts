import 'dotenv/config';
import { Index } from "@upstash/vector";

export interface PRMetadata {
  pr_number: number;
  pr_url: string;
  author: string;
  base_branch: string;
  title: string;
  repo_name: string;    // Required for multi-repo isolation
  latest_sha: string;   // Required for cache-busting (SHA fingerprinting)
}

export class UpstashService {
  private index: Index;

  constructor() {
    const url = process.env.UPSTASH_VECTOR_REST_URL;
    const token = process.env.UPSTASH_VECTOR_REST_TOKEN;

    if (!url || !token) {
      throw new Error("❌ UPSTASH_VECTOR_REST_URL or UPSTASH_VECTOR_REST_TOKEN is missing from .env!");
    }
    
    this.index = new Index({ url, token });
  }

  async upsertPREmbedding(id: string, vector: number[], metadata: PRMetadata, namespace: string) {
    await this.index.namespace(namespace).upsert({
      id,
      vector,
      metadata: metadata as unknown as Record<string, unknown>,
    });
  }

  async findSimilarPRs(vector: number[], namespace: string, topK: number = 3): Promise<any[]> {
    const results = await this.index.namespace(namespace).query({
      vector,
      topK,
      includeMetadata: true,
      includeVectors: false,
    });
    return results;
  }

  async getMetadataById(id: string, namespace: string): Promise<PRMetadata | null> {
    const res = await this.index.namespace(namespace).fetch([id], { includeMetadata: true });
    const first = res?.[0];
    if (!first || !first.metadata) return null;
    return first.metadata as unknown as PRMetadata;
  }

  async fetchVectorById(id: string, namespace: string): Promise<number[] | null> {
    const res = await this.index.namespace(namespace).fetch([id], { includeVectors: true });
    return res?.[0]?.vector || null;
  }
}

export const upstashService = new UpstashService();
