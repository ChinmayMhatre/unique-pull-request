import 'dotenv/config';
import { Index } from "@upstash/vector";

export interface PRMetadata {
  pr_number: number;
  pr_url: string;
  author: string;
  base_branch: string;
  title: string;
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

  async upsertPREmbedding(id: string, vector: number[], metadata: PRMetadata) {
    await this.index.upsert({
      id,
      vector,
      metadata: metadata as unknown as Record<string, unknown>,
    });
  }

  async findSimilarPRs(vector: number[], topK: number = 3): Promise<any[]> {
    const results = await this.index.query({
      vector,
      topK,
      includeMetadata: true,
      includeVectors: false,
    });
    return results;
  }

  async fetchVectorById(id: string): Promise<number[] | null> {
    const res = await this.index.fetch([id], { includeVectors: true });
    return res[0]?.vector || null;
  }
}

export const upstashService = new UpstashService();
