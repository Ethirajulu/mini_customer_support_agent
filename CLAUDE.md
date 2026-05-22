@AGENTS.md

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

A learning project, not a product. It's the four-weekend "AI Engineering Curriculum" described in `docs/ai_engineering_curriculum_requirements.md` — building one AI customer support agent for a fictional e-commerce company called **OrderFlow**, evolving it through four phases:

1. **Plain LLM** (current) — all help articles stuffed into the system prompt.
2. **RAG** — articles embedded into Supabase pgvector, retrieved by similarity.
3. **Agents & tools** — Claude tool-calling for order lookups, escalation, etc.
4. **Eval & LLMOps** — golden set, LLM-as-judge, LangFuse observability.

When working in this repo, check the curriculum doc to understand which phase the user is in — the architecture is intentionally minimal for the current phase and expected to grow.

The curriculum's "swap rules" matter: if a stack choice blocks the user for >2 hours, suggest swapping it. The goal is shipping each phase, not polishing it.

## Commands

```bash
pnpm dev                  # next dev (Turbopack)
pnpm build                # production build
pnpm start                # serve the production build
pnpm lint                 # eslint
npx tsc --noEmit          # type-check (no test runner is set up yet)

# Phase 2+ (local stack)
docker compose up -d      # start Postgres + pgvector (port 5432)
docker compose down       # stop it (data persists in the pgdata volume)
docker compose down -v    # stop AND wipe the DB
docker exec -it orderflow-pg psql -U postgres -d orderflow   # psql shell
ollama serve              # Ollama listens on :11434 (usually already running)
```

### Env vars (`.env.local`)

```
DATABASE_URL=postgres://postgres:postgres@localhost:5432/orderflow
OLLAMA_BASE_URL=http://localhost:11434
CHAT_PROVIDER=ollama          # or "anthropic" — defaults to "ollama" if unset
ANTHROPIC_API_KEY=...         # only required when CHAT_PROVIDER=anthropic
```

The stack is local by default — no cloud API keys are required to run the app. The Anthropic provider is kept available as a fallback / model-comparison option: set `CHAT_PROVIDER=anthropic` (with a valid `ANTHROPIC_API_KEY`) to flip back, useful for debugging "is this a model issue or a code issue?" and for Phase 4 model comparison.

## Stack pinning

This is **Next.js 16 + AI SDK v6 + React 19**. Several APIs have moved or changed from what training data usually shows:

- `useChat` lives in `@ai-sdk/react`, **not** `ai/react`.
- Client transports (e.g. `DefaultChatTransport`, `TextStreamChatTransport`) are imported from `ai` and passed to `useChat`.
- The server returns a UI Message Stream via `createUIMessageStream` + `createUIMessageStreamResponse` (or `streamText().toUIMessageStreamResponse()`). Messages arrive client-side as `parts: [{ type: 'text', text }, …]`, not a flat `content` string.
- Next.js 16: read `node_modules/next/dist/docs/01-app/` before writing routing, caching, or rendering code — see `AGENTS.md`.

When the user references "useChat from `ai/react`" or other pre-v6 APIs from the curriculum doc, translate to the v6 equivalents above without breaking the spirit of the task.

### Local-first stack (deviation from the curriculum doc)

The curriculum doc names Supabase + OpenAI embeddings + Claude. The user is running fully local instead:

| Curriculum | What this repo actually uses |
|---|---|
| Supabase pgvector | **Local Postgres 16 + pgvector** via `docker-compose.yml` |
| OpenAI `text-embedding-3-small` (1536 dims) | **Ollama `nomic-embed-text`** (768 dims) |
| Anthropic Claude (chat) | **Ollama `llama3.1:8b`** (chat) |

Treat the curriculum as a spec for *what to learn*, not *which vendor to use*. The concepts (embeddings, similarity search, RAG, tool use, eval) are identical. If a local model blocks Phase 3+ for >2 hours, the swap rule applies — fall back to a cloud model for that phase only.

**Critical:** the embedding dimension is `768` (nomic), not `1536` (OpenAI). The `articles.embedding` column must match (`vector(768)`).

### Models in use

Both run through the local Ollama daemon at `http://localhost:11434`. Verify with `ollama list`.

| Role | Model | Size on disk | Output | Notes |
|---|---|---|---|---|
| Embeddings | `nomic-embed-text` | ~274 MB | 768-dim vector | Embedding-only model. Used by `scripts/embed-articles.ts` and by the chat route to embed the user's question at query time. |
| Chat | `llama3.1:8b` | ~4.7 GB | streamed text | Replaces Claude as the agent's brain in Phase 2. Default 8K context; we keep prompts well under that. |

**When changing models:**
- The model strings are referenced in `lib/embeddings.ts` (or `lib/ollama.ts`) and the chat route. Keep them centralized — don't hard-code model names inside route handlers.
- Changing the *embedding* model usually means re-running `pnpm embed` AND altering the SQL column dimension. A `768`-dim vector cannot be compared to a `1024`-dim vector — Postgres will error.
- Changing the *chat* model is safe at any time; no DB impact.

## Architecture (Phase 1 — current)

```
app/
  api/chat/route.ts   POST handler — see below
  page.tsx            client chat UI using useChat
  layout.tsx          root layout (Geist font, full-height flex)
lib/
  anthropic.ts        shared Anthropic client + MODEL constant
content/
  help-articles/      ~19 .md files with YAML frontmatter — the knowledge base
docs/
  ai_engineering_curriculum_requirements.md   the master spec for all 4 phases
```

**Request flow:**

1. `page.tsx` renders `useChat({ transport: new DefaultChatTransport({ api: '/api/chat' }) })`. The UI streams text deltas into message bubbles and shows a stop button while `status` is `submitted` or `streaming`.
2. `POST /api/chat` receives `{ messages: UIMessage[] }`.
3. The handler reads **every** `.md` in `content/help-articles/` from disk on each request (intentional — keeps Phase 1 dumb; Phase 2 replaces this with retrieval) and builds a single system prompt wrapping each article in `<article filename="…">` tags.
4. The handler converts UIMessages → Anthropic message format (concatenating text parts), calls `anthropic.messages.stream()`, and pipes `text_delta` events into a `createUIMessageStream` writer as `text-start` / `text-delta` / `text-end` chunks.
5. `createUIMessageStreamResponse({ stream })` returns the UI Message Stream that `useChat` consumes.

**System prompt rules baked in:** answer only from the articles, escalate to a human when out of scope, no invented policies or timelines. Keep these rules when modifying — they're what makes Phase 1 evaluable.

## Help articles

Each `.md` in `content/help-articles/` has YAML frontmatter (`title`, `category`, `tags`) and prose. They're written in a calm, jargon-free voice — preserve that voice when adding or editing articles. Cross-links between articles use bare relative `.md` paths.

In Phase 2 these will be chunked and embedded; keep them paragraph-friendly (don't write 2000-word monoliths).

## Things that look wrong but aren't

- The `lib/llm-anthropic.ts` `ANTHROPIC_CHAT_MODEL` constant uses a specific Haiku snapshot string. Don't "upgrade" it to a newer alias unless asked.
- `lib/llm.ts` exists alongside `lib/llm-ollama.ts` and `lib/llm-anthropic.ts` on purpose — the router pattern lets us flip providers via `CHAT_PROVIDER`. Don't collapse it into one file or hard-code one provider.
- The route still re-reads articles on every request (Phase 1 behavior). Phase 2 will replace this with DB-backed retrieval — leave the disk-read in place until then.
- No tests, no CI config, no `vercel.json`.
- `docker-compose.yml` only defines Postgres — Ollama runs on the host, not in Docker, because the user already has models pulled locally and re-pulling inside a container would waste GB of bandwidth.
