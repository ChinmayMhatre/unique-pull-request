<div align="center">
  <h1>🛡️ Kanteishi Audit</h1>
  <p><strong>AI-powered duplicate Pull Request detection for high-traffic repositories.</strong></p>
  
  ![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-blue)
  ![TypeScript](https://img.shields.io/badge/TypeScript-5.8-blue)
  ![License](https://img.shields.io/badge/License-ISC-green)
</div>

<br />

The **Kanteishi Audit** is a high-performance CLI tool designed to scan a repository's pull request history for redundancies and architectural duplicates. It identifies when multiple contributors are solving the *same functional problem*, even across different files.

---

## 🚀 Getting Started

### 1. Installation

Clone the repository and install dependencies:

```sh
git clone https://github.com/chinmay/kanteishi.git
cd kanteishi
npm install
```

### 2. Configuration

Create a `.env` file in the root directory:

```sh
cp .env.example .env
```

Ensure the following environment variables are set:

| Variable | Description |
| :--- | :--- |
| `GITHUB_TOKEN` | [Fine-grained PAT](https://github.com/settings/tokens?type=beta) with Read access to PRs. |
| `GEMINI_API_KEY` | Google AI Studio Key (Primary reasoning & embeddings). |
| `GROQ_API_KEY` | Groq Console Key (Failover reasoning). |
| `UPSTASH_VECTOR_REST_URL` | Upstash Vector Database REST URL. |
| `UPSTASH_VECTOR_REST_TOKEN` | Upstash Vector Database REST Token. |

### 3. Build

Compile the TypeScript code:

```sh
npm run build
```

---

## 💻 Usage

Run the audit script against any public or accessible private repository.

```sh
npm run audit <owner>/<repo> [options]
```

### Available Options

| Option | Description | Default |
| :--- | :--- | :--- |
| `<owner>/<repo>` | **(Required)** The target GitHub repository (e.g., `facebook/react`). | - |
| `--limit <N>` | Maximum number of PRs to fetch and process. | `500` |
| `--resume` | Skips the ingestion phase and uses existing embeddings in Upstash. Essential for faster re-scans. | `false` |

### Examples

```sh
# Perform a fresh audit of the react repository (top 100 PRs)
npm run audit facebook/react --limit 100

# Re-run a previous audit using cached vector embeddings
npm run audit facebook/react --resume
```

---

## ⚙️ How it Works

The Audit tool uses a high-efficiency pipeline to minimize costs and maximize speed:

1.  **Ingestion**: PR diffs are fetched and minified (stripping junk/comments).
2.  **Vector Memory**: Diffs are converted to embeddings and stored in Upstash.
3.  **Vector Sieve**: A high-speed similarity search flags potential duplicates.
4.  **Deep Reasoning**: Flagged pairs are sent to LLMs (Gemini/Groq) for semantic classification.

### Classification Categories
- `SHADOW`: An exact or near-exact functional duplicate.
- `SUPERSET`: One PR contains all changes of another, plus more.
- `COMPETING`: Different architectural approaches to the same problem.

---

## 📊 Output & Logs

After the run, a summary table is displayed in the terminal. Comprehensive logs are generated in the `/logs` directory:

```text
📁 Full logs → /logs/facebook_react_2026-04-25_14-00-00
```

For a detailed breakdown of the log file contents, see [LOGS_STRUCTURE.md](LOGS_STRUCTURE.md).

---

## 🤝 Contributing
Suggestions and bug reports are welcome via Issues!

For more, check out the [Contributing Guide](CONTRIBUTING.md).
