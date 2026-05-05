# 📊 Audit Logs Structure

Every time you run the audit script, a new directory is created in the `/logs` folder named after the repository and timestamp (e.g., `logs/facebook_react_2026-04-25_14-00-00`).

This directory contains 7 JSON files that track the entire pipeline from fetching to final AI reasoning.

## 📁 File Descriptions

### 1. `00_run_config.json`
Contains the configuration used for the run.
- `repo`: The repository being audited.
- `limit`: The max number of PRs to process.
- `mode`: `fresh` or `resume`.
- `thresholds`: Similarity thresholds used for the Vector Sieve.
- `logDir`: Absolute path to this log directory.

### 2. `01_fetched_prs.json`
Details about the PRs retrieved from GitHub.
- `summary`: Statistics on total fetched, filtered (bots, drafts), and duration.
- `prs`: List of PR objects containing number, title, author, url, and SHA.

### 3. `02_ingestion_log.json`
Tracks the processing and embedding of each PR.
- `summary`: Avg optimizer reduction percentage and phase duration.
- `entries`: Status for each PR (e.g., `sha_hit`, `embedded`, `skipped_large`, `error`).
- `reductionPct`: How much the context optimizer compressed the diff.

### 4. `03_sieve_results.json`
Results from the high-speed Vector similarity search.
- `summary`: Breakdown of scores and how many PRs were fast-tracked vs. queued.
- `fast_tracked`: List of unique PRs that didn't meet the similarity threshold.
- `queued`: List of PRs flagged for deep reasoning with their top matching candidates.

### 5. `04_reasoning_queue.json`
The deduplicated list of pairs sent to the LLM.
- `summary`: Size of the queue before and after pair deduplication (e.g., preventing A-B and B-A redundancy).
- `queue`: Detailed pairs including metadata for both the incoming PR and its top match.

### 6. `05_llm_results.json`
The raw output and reasoning from the AI models (Gemini/Groq).
- `summary`: Total analyzed, duplicates found, and model usage stats.
- `results`: For each pair:
    - `isDuplicate`: Boolean.
    - `type`: `SHADOW`, `SUPERSET`, `COMPETING`.
    - `confidence`: AI confidence score.
    - `reasoning`: The full explanation provided by the AI.
    - `modelUsed`: Which model performed the analysis.

### 7. `06_summary.json`
The final statistical summary of the entire run.
- `total_duration_human`: Total time taken in minutes.
- `prs_fetched`: Total number of PRs processed.
- `ingestion`: Breakdown of cache hits and skips.
- `reasoning`: Final breakdown of duplicate types found.
- `errors`: List of any non-fatal errors encountered during the run.

---
> [!TIP]
> Use these logs to debug why a PR was flagged or to inspect the raw AI reasoning for complex architectural overlaps.
