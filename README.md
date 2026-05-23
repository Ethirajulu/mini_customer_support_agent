# OrderFlow Support Agent

A customer-support AI agent for a fictional e-commerce company, built across a four-weekend AI engineering curriculum. Each phase deliberately starts with the dumbest possible version of a real production technique, then iterates until the pattern's strengths and failure modes are clear.

> This is a **learning project**, not a product. The whole point is to feel why each pattern exists by living with its limits before reaching for the next one.

**Read the full series →** [kumizhi-ai.com/blog](https://www.kumizhi-ai.com/blog) — each phase has a deeper writeup covering failures, fixes, and what I'd do differently.

## What it does

- Chats with customers about orders, refunds, returns, shipping, subscriptions, and account questions
- Answers from a help-center knowledge base (~19 articles in `content/help-articles/`)
- Looks up real (mock) order data, opens support tickets, escalates to humans
- Refuses out-of-scope questions (weather, math, jokes) without inventing answers
- Is **measurably evaluated** against a hand-curated golden set with deterministic + LLM-as-judge scoring

## The four phases

| Phase | What was built | The lesson |
| --- | --- | --- |
| **1 — Plain LLM** | Chat UI + Anthropic streaming + every help article pasted into the system prompt | Feel why "stuff everything in the prompt" doesn't scale past ~50 articles |
| **2 — RAG** | pgvector + Ollama embeddings + retrieval-as-safety-gate + sources in the UI | Embeddings are addresses to meaning; the index optimization is for scale, not correctness |
| **3 — Agents & tools** | ReAct loop + tool calling (`search_articles`, `lookup_order_status`, `create_ticket`, `escalate_to_human`) + tool-call UI badges | Tool descriptions are the new prompts; "keep the rule where the rule fires" |
| **4 — Eval & observability** | Golden set (20 cases) + deterministic scoring + LLM-as-judge (Sonnet) + self-hosted LangFuse + markdown report | Iterate the test as much as the agent — it's an artifact you wrote and can get wrong |

The full curriculum and acceptance criteria live in [`docs/ai_engineering_curriculum_requirements.md`](docs/ai_engineering_curriculum_requirements.md).

## Architecture

```
app/api/chat/route.ts        Next.js route, streams agent events to the UI
app/page.tsx                 Chat UI with inline tool-call badges
lib/
  agent.ts                   Provider-agnostic dispatcher
  agent-anthropic.ts         Anthropic implementation
  agent-ollama.ts            Ollama implementation
  llm-anthropic.ts           Streaming chat helper (Anthropic SDK)
  llm-ollama.ts              Streaming chat helper (Ollama /api/chat)
  tools.ts                   The 4 tools — generic schema, provider adapters translate
  retrieval.ts               Vector search via pgvector
  embeddings.ts              Ollama nomic-embed-text wrapper
  judge.ts                   LLM-as-judge with strict rubrics (Anthropic or Ollama)
  tracing.ts                 LangFuse SDK wrapper, no-ops if not configured
  prompts.ts                 Centralized system prompts
content/help-articles/       19 markdown articles with YAML frontmatter
data/
  orders.json                Mock order data
  tickets.json               Created by the agent at runtime (gitignored)
evals/
  golden-set.json            20 hand-written test cases across 5 categories
  results/                   Markdown reports per eval run
scripts/
  embed-articles.ts          Re-index articles into pgvector (idempotent)
  run-eval.ts                Run the golden set, score it, write a report
docker-compose.yml           Local Postgres + pgvector
docker-compose.langfuse.yml  Self-hosted LangFuse stack (postgres, clickhouse, redis, minio, web, worker)
```

## Stack

- **Next.js 16** (App Router) + **AI SDK v6** + **React 19**
- **Anthropic SDK** (Claude Haiku 4.5 for agent, Sonnet 4.6 for judge)
- **Ollama** (`llama3.1:8b` agent, `nomic-embed-text` embeddings, optional `qwen2.5:14b` judge)
- **Postgres 16 + pgvector** via Docker
- **LangFuse v3** self-hosted via Docker for trace-level observability

Provider switches via `CHAT_PROVIDER` (`anthropic` | `ollama`) and `JUDGE_PROVIDER` env vars — see [`.env.example`](.env.example).

## Quick start

Requires Node 24, pnpm, Docker, and Ollama installed locally.

```bash
# 1. Install deps
pnpm install

# 2. Configure env (use defaults for fully-local stack)
cp .env.example .env.local
# Edit .env.local — add ANTHROPIC_API_KEY if using CHAT_PROVIDER=anthropic or running evals

# 3. Pull Ollama models
ollama pull nomic-embed-text
ollama pull llama3.1:8b

# 4. Start local Postgres + pgvector
docker compose up -d

# 5. Initialize the schema
docker exec -i orderflow-pg psql -U postgres -d orderflow < db/schema.sql

# 6. Embed the help articles into the vector DB
pnpm embed

# 7. Run the dev server
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000).

## Run the eval

```bash
pnpm eval
```

Outputs a per-case PASS/FAIL summary to the console and writes a full markdown report to `evals/results/<timestamp>.md`. Requires `ANTHROPIC_API_KEY` (the LLM-as-judge always uses Anthropic by default).

## Optional — self-hosted LangFuse

```bash
docker compose -f docker-compose.langfuse.yml up -d
# Open http://localhost:3001
# Login: dev@example.com / changeme123
# Settings → API Keys → Create, add the public + secret keys to .env.local
```

After that, every chat request and every eval case writes a full trace to LangFuse — agent generations, tool spans, judge generation, and per-rubric Boolean scores.

## What I'd do differently next time

Captured at the end of each blog post in the project, but the highlights:

- Run each eval case **3× and report worst-case** — single-run pass rates are noisy by ~±10%.
- **Pass the system prompt to the judge** — several "hallucination" flags were the agent following system-prompt rules the judge couldn't see.
- **Track per-case token cost in the report** — cost variance is itself a signal worth surfacing.
- **Always instrument every LLM call**, including the judge — almost forgot, and it's the one most worth seeing.

## What's next

The follow-up project — applying these patterns to an internal-developer-tooling problem — lives at [**agentic-debugger**](https://github.com/Ethirajulu/agentic-debugger). Same author, same patterns (RAG, agents, eval, observability), but built around the [Model Context Protocol](https://modelcontextprotocol.io) for orchestrating across logs, code, and customer data.

## Reference

- Blog series (one post per phase): [kumizhi-ai.com/blog](https://www.kumizhi-ai.com/blog)
- Curriculum doc: [`docs/ai_engineering_curriculum_requirements.md`](docs/ai_engineering_curriculum_requirements.md)
- Repo-level instructions for AI assistants (Claude Code, etc.): [`CLAUDE.md`](CLAUDE.md)
