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
pnpm dev          # next dev (Turbopack)
pnpm build        # production build
pnpm start        # serve the production build
pnpm lint         # eslint
npx tsc --noEmit  # type-check (no test runner is set up yet)
```

Requires `ANTHROPIC_API_KEY` in `.env.local`. Later phases add `OPENAI_API_KEY`, Supabase keys, and LangFuse keys.

## Stack pinning

This is **Next.js 16 + AI SDK v6 + React 19**. Several APIs have moved or changed from what training data usually shows:

- `useChat` lives in `@ai-sdk/react`, **not** `ai/react`.
- Client transports (e.g. `DefaultChatTransport`, `TextStreamChatTransport`) are imported from `ai` and passed to `useChat`.
- The server returns a UI Message Stream via `createUIMessageStream` + `createUIMessageStreamResponse` (or `streamText().toUIMessageStreamResponse()`). Messages arrive client-side as `parts: [{ type: 'text', text }, …]`, not a flat `content` string.
- Next.js 16: read `node_modules/next/dist/docs/01-app/` before writing routing, caching, or rendering code — see `AGENTS.md`.

When the user references "useChat from `ai/react`" or other pre-v6 APIs from the curriculum doc, translate to the v6 equivalents above without breaking the spirit of the task.

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

- The `lib/anthropic.ts` `MODEL` constant uses a specific Haiku snapshot string. Don't "upgrade" it to a newer alias unless asked — model choice is part of the user's experiment.
- The route re-reads articles on every request with no cache. Don't add caching in Phase 1 — feeling the cost is the point.
- No tests, no CI config, no `vercel.json`. Phase 1 deliberately ships flat.
