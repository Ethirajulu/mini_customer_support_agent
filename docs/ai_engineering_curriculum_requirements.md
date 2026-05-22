# AI Engineering Curriculum & Requirements

A 4-phase, hands-on project to learn LLMs, RAG, agents, and LLMOps by building one product across 4 weekends.

---

## Goal

Build an AI agent that answers customer support questions using a help center, escalates when it can't, and is **measurably** good (or measurably bad).

By the end you'll have:

- A deployed, working AI support agent
- 4 technical blog posts walking through each phase
- A demo you can show in interviews
- Working knowledge of LLM APIs, RAG, tool calling, and eval

## Non-goals

- Not training models from scratch
- Not building a polished SaaS
- Not learning Python first (TypeScript end-to-end)
- Not perfect — shipping each phase matters more than polishing it

---

## Stack decisions

| Layer         | Choice                          | Why                                     |
| ------------- | ------------------------------- | --------------------------------------- |
| Language      | TypeScript                      | You're productive in days, not weeks    |
| Framework     | Next.js 14+ (App Router)        | One process for UI + API, Vercel-native |
| LLM           | Claude (Anthropic SDK)          | Strong tool use, generous free tier     |
| Embeddings    | OpenAI `text-embedding-3-small` | Cheap, high quality, well-documented    |
| Vector DB     | Supabase pgvector               | Free tier, you already know SQL         |
| Hosting       | Vercel                          | You already use it for Handshake        |
| Observability | LangFuse                        | Free tier, easy SDK                     |
| Eval          | JSON test file + LLM-as-judge   | No framework needed initially           |

**Swap rules:** if any of the above blocks you for >2 hours, swap it out and keep moving. The stack is a tool, not the goal.

---

## Repository layout

Name: `mini_customer_support_agent`. Public GitHub repo. Each phase is a PR (or at least a tagged commit).

```
mini_customer_support_agent/
├── app/
│   ├── api/
│   │   └── chat/
│   │       └── route.ts
│   └── page.tsx
├── lib/
│   ├── anthropic.ts
│   ├── retrieval.ts        (phase 2+)
│   ├── tools.ts            (phase 3+)
│   └── eval.ts             (phase 4)
├── content/
│   └── help-articles/      (~20 .md files)
├── scripts/
│   ├── embed-articles.ts   (phase 2)
│   └── run-eval.ts         (phase 4)
├── evals/
│   └── golden-set.json     (phase 4)
└── README.md
```

---

## Phase 1 — Plain LLM (Weekend 1)

### What you'll build

A chat UI for a fake company — let's call it **"OrderFlow"**, a fictional e-commerce platform. The assistant has access to 15–20 help articles stuffed into the system prompt. No retrieval, no tools, no eval. Just: question in, streamed answer out.

### Why this first

You'll feel the rawness of LLMs — what changes when you tweak the system prompt, how streaming changes UX, why context length becomes a real constraint as articles grow.

### Tasks

1. `npx create-next-app@latest mini-customer-support-agent --typescript --tailwind --app`
2. `npm install @anthropic-ai/sdk ai`
3. Sign up at console.anthropic.com, get an API key, add to `.env.local` as `ANTHROPIC_API_KEY`
4. Generate 15–20 help articles as `.md` files in `content/help-articles/` (ask Claude to write them — topics like "How to refund an order", "Tracking your shipment", "Cancelling a subscription", etc.)
5. Build `/api/chat/route.ts`:
   - Accept POST with `messages` array
   - Read all help articles from disk
   - Prepend them as system context
   - Stream Claude's response back
6. Build chat UI at `/`:
   - Input box at bottom
   - Message history above
   - Streaming text rendering (use `useChat` from `ai/react` for the easy path)
7. Push to GitHub. Deploy to Vercel. Set `ANTHROPIC_API_KEY` in Vercel env vars.

### Acceptance criteria

- ✅ Ask "how do I refund an order?" → get a useful streaming response based on the articles
- ✅ Deployed at a public URL
- ✅ Committed to GitHub with a README explaining how to run it
- ✅ Total time spent < 12 hours

### Learning goals

- API authentication and key management
- System vs user messages
- Streaming responses end-to-end (server → client)
- Why "just stuff everything in the prompt" stops scaling around 50+ articles

### Common pitfalls

- **Trying to make the UI pretty.** Don't. ChatGPT-clone aesthetic is fine.
- **Forgetting to handle streaming on the client.** Use the Vercel `ai` package — `useChat` does it for you.
- **Hardcoding the API key.** Use env vars from day 1.
- **Over-engineering the article loader.** A simple `fs.readdirSync` on cold start is fine.

### Blog post angle

"Building a customer support chatbot in a weekend — what I learned about prompts, streaming, and where naive approaches break."

---

## Phase 2 — RAG (Weekend 2)

### What you'll build

Replace "stuff all articles in prompt" with proper retrieval. Articles are embedded, stored in a vector DB, retrieved by similarity at query time.

### Why this matters

RAG is the most-asked-about AI skill in 2026 interviews. It's also the foundation for everything that follows: agents, knowledge bases, internal copilots, customer support bots.

### Tasks

1. Sign up at supabase.com, create a new project, enable the `vector` extension
2. Create a table:
   ```sql
   create table articles (
     id bigserial primary key,
     slug text,
     title text,
     content text,
     embedding vector(1536)
   );
   create index on articles using ivfflat (embedding vector_cosine_ops);
   ```
3. `npm install openai @supabase/supabase-js`
4. Write `scripts/embed-articles.ts`:
   - Read each markdown file from `content/help-articles/`
   - Chunk by paragraph if the article is > 800 tokens (start simple)
   - Embed each chunk via OpenAI's `text-embedding-3-small`
   - Insert into Supabase
   - Make this idempotent (delete + reinsert per slug)
5. Add `npm run embed` script
6. Update `/api/chat/route.ts`:
   - Take the latest user message
   - Embed it
   - SQL query: `SELECT content FROM articles ORDER BY embedding <=> :query_embedding LIMIT 3`
   - Pass only those 3 chunks to Claude instead of all articles
7. Add a "Sources" UI: each response shows the article titles that were retrieved

### Acceptance criteria

- ✅ Chat works as well or better than Phase 1
- ✅ You can scale to 100s of articles without the prompt growing
- ✅ Each response shows which articles were used
- ✅ You can point to at least 2 cases where retrieval picked the wrong article — and you understand why
- ✅ `npm run embed` can rebuild the vector DB from scratch in < 1 minute

### Learning goals

- What embeddings are (semantic similarity, vector space)
- Chunking strategies (paragraph vs fixed-size vs semantic)
- Why retrieval quality matters more than model quality at this layer
- The "lost in the middle" problem (models attend more to start/end of context)

### Common pitfalls

- **Chunking too small** → loses context, retrieval finds irrelevant snippets
- **Chunking too big** → dilutes relevance, hits context limits
- **Paragraph chunking is a fine default.** Don't over-think it for Phase 2.
- **Forgetting to re-embed** when articles change. Add a content hash check.
- **Mixing embedding models** between indexing and querying — same model, always.

### Blog post angle

"From prompt-stuffing to RAG: when and why retrieval beats context."

---

## Phase 3 — Agent (Weekend 3)

### What you'll build

Give the model tools. Now it doesn't just answer — it can search, look up an order, create a ticket, or escalate. The model decides which tool to call. You handle the execution and feed results back.

### Why this matters

This is where Fin lives. Their AI Agent is exactly this pattern — LLM + tools + memory + escalation logic. Understanding this loop deeply is the highest-leverage AI skill in 2026.

### Tasks

1. Define your tools in `lib/tools.ts`:

   | Tool                  | Args                             | Returns          | Behavior                            |
   | --------------------- | -------------------------------- | ---------------- | ----------------------------------- |
   | `search_articles`     | `query: string`                  | Article snippets | Calls Phase 2 retrieval             |
   | `lookup_order_status` | `order_id: string`               | Mock order JSON  | Reads from `data/orders.json`       |
   | `create_ticket`       | `subject, description, priority` | Ticket ID        | Appends to `data/tickets.json`      |
   | `escalate_to_human`   | `reason: string`                 | Status object    | Returns `{escalated: true, reason}` |

2. Switch `/api/chat/route.ts` to Claude's tool-use API (the SDK supports it natively via the `tools` param on `messages.create`)
3. Implement the agent loop:
   ```typescript
   while (iterations < MAX_ITER) {
     const response = await anthropic.messages.create({ messages, tools });
     if (response.stop_reason === "tool_use") {
       const toolBlock = response.content.find((b) => b.type === "tool_use");
       const result = await executeTool(toolBlock.name, toolBlock.input);
       messages.push({ role: "assistant", content: response.content });
       messages.push({
         role: "user",
         content: [
           { type: "tool_result", tool_use_id: toolBlock.id, content: result },
         ],
       });
       iterations++;
     } else {
       return response;
     }
   }
   ```
4. Add a max-iteration cap (5–7) to prevent runaway loops
5. UI: render tool calls inline ("Looking up your order…" badges, then "Order found: #1234" results)

### Acceptance criteria

- ✅ "Where's my order #123?" → calls `lookup_order_status`
- ✅ "I want a refund for order #123" → looks up the order, then creates a ticket
- ✅ "I want to speak to a human" → escalates
- ✅ "How do I cancel my subscription?" → calls `search_articles`, answers from results
- ✅ You can demo a multi-step flow (lookup + ticket) on a 60-second Loom video
- ✅ Max iteration cap prevents infinite loops

### Learning goals

- Tool / function calling syntax (Anthropic's specifically — others differ)
- The ReAct loop (Reason → Act → Observe → repeat)
- Why agents fail: bad tool descriptions, ambiguous tool names, no escape hatch, too many tools
- When **not** to use an agent (most simple Q&A doesn't need one)

### Common pitfalls

- **Vague tool descriptions** → model can't pick well. Be explicit: "Use this when the user asks about the status of a specific order they have placed."
- **No max iteration cap** → infinite loops on edge cases
- **One mega-tool instead of focused ones** — keep tools single-purpose
- **Not handling tool errors gracefully** — wrap in try/catch, return error info to the model so it can recover
- **Too many tools** — 4–6 is the sweet spot for first agent

### Blog post angle

"What I learned building my first AI agent (and the 3 ways it broke)."

---

## Phase 4 — Eval & Observability (Weekend 4)

### What you'll build

A test suite for your agent. 20 representative customer questions, expected behaviors, automated scoring. Plus tracing so you can debug failed runs.

### Why this matters

This is the hardest part of AI engineering and the most under-taught. In interviews — especially at companies like Fin — **"how do you know if your model is good?"** is _the_ question. Most engineers handwave it. You won't.

### Tasks

1. Create `evals/golden-set.json` with 20 entries. Aim for a mix:
   - 5 easy retrieval Qs ("how do I track my order?")
   - 5 multi-tool flows ("refund my order #123")
   - 3 out-of-scope ("what's the weather in Chennai?") — should escalate or politely decline
   - 4 ambiguous ("it's broken, help") — should ask clarifying questions
   - 3 edge cases (empty input, very long input, prompt injection attempt)

   Schema per entry:

   ```json
   {
     "id": "refund-flow-001",
     "input": "I want to return order #12345",
     "expected_tools": ["lookup_order_status", "create_ticket"],
     "expected_behavior": "Looks up order then creates return ticket",
     "must_contain": ["return", "ticket"],
     "must_not_contain": ["cannot help", "I don't know"]
   }
   ```

2. Write `scripts/run-eval.ts`:
   - Loop through golden set
   - Run each through your agent
   - Capture: final response, tools called (in order), total latency, total tokens
   - Score each with an LLM judge (a separate Claude call: "given this user input and this response, rate 1–5 on correctness, helpfulness, tool selection")
   - Output a markdown report to `evals/results/<timestamp>.md`

3. Sign up at langfuse.com, get keys, add tracing to `/api/chat/route.ts`:
   - One trace per chat turn
   - Spans for: retrieval, each tool call, final completion
   - Tag traces with eval IDs when running from the eval script

4. Run the eval. Find the 3–4 worst-scoring cases. Open their LangFuse traces. Identify root cause. Fix one.

5. Re-run the eval. Show before/after numbers in the report.

### Acceptance criteria

- ✅ `npm run eval` produces a scored markdown report
- ✅ You can point to a specific case: "this used to fail because X, I fixed it by Y, now it passes"
- ✅ LangFuse shows traces for every chat (including manual UI ones, not just eval runs)
- ✅ You have an **interview demo**: "here's my agent, here's how I measure it, here's a regression I caught and fixed"
- ✅ The README explains how to run the eval and interpret results

### Learning goals

- LLM-as-judge (powerful but biased — judges tend to be lenient)
- Why eval sets need to be hand-curated, not auto-generated
- The eval → fix → re-eval loop
- Cost and latency as first-class metrics, not afterthoughts
- The gap between "looks good in chat" and "passes the eval"

### Common pitfalls

- **Auto-generating eval cases with Claude** — they end up biased toward what Claude can answer
- **LLM judges that are too lenient** — use specific rubrics ("did it call `lookup_order_status`? yes/no" beats "is it good? 1–5")
- **Treating scores as gospel** — always read 5+ traces manually per run
- **Only testing happy paths** — half your test set should be adversarial

### Blog post angle

"You can't improve what you don't measure: how I built an eval suite for my AI agent."

---

## Today's kickoff checklist

**Goal:** get to "first Claude API response in my own app" before bed.

- [ ] Create GitHub repo `mini_customer_support_agent` (public)
- [ ] `npx create-next-app@latest mini_customer_support_agent --typescript --tailwind --app`
- [ ] Sign up at console.anthropic.com, get an API key
- [ ] Add $5 of credits (free tier covers most of Phase 1)
- [ ] `npm install @anthropic-ai/sdk ai`
- [ ] Write `app/api/chat/route.ts` calling Claude with a hardcoded "you are a helpful assistant" system prompt
- [ ] Hit it with curl. See a streamed response in the terminal.
- [ ] Commit. Push to GitHub.
- [ ] Deploy to Vercel. Set `ANTHROPIC_API_KEY` in Vercel env.

**Stop here for tonight.** Tomorrow: build the chat UI and add help articles.

---

## Pacing

- Each phase: one weekend, ~10–15 hours
- Blog post after each phase: ~90 minutes on top of your existing pipeline
- Total: 4 weeks elapsed, ~60 hours of work, one deployed product, 4 blog posts

This is roughly enough to walk into Fin's interview and not be bluffing.

---

## Resources to bookmark

- Anthropic API docs — https://docs.claude.com
- Vercel AI SDK — https://sdk.vercel.ai
- Supabase pgvector guide — https://supabase.com/docs/guides/ai
- LangFuse docs — https://langfuse.com/docs
- Anthropic's "Building Effective Agents" essay (search the Anthropic blog)
- Hamel Husain's blog — best practitioner content on evals
- Eugene Yan's "Patterns for Building LLM-based Systems" essay

---

## What this curriculum deliberately skips

- **Python** — add later when you genuinely need notebooks/evals beyond what TS handles
- **Fine-tuning** — irrelevant for Product Engineer roles in 2026
- **ML theory** (backprop, attention math) — Fin's ML Scientists handle that
- **Multiple model providers** — pick one (Claude), learn its quirks deeply
- **Multi-agent frameworks** (CrewAI, AutoGen, LangGraph) — overkill until you've built a single agent well
- **Production hardening** (auth, rate limiting, multi-tenancy) — out of scope for a learning project

You can come back to any of these later. Right now: ship the agent.

---

## When you're done

You'll have credible answers for these interview questions:

| Question                                      | Your answer                                           |
| --------------------------------------------- | ----------------------------------------------------- |
| "Have you built with LLMs in production?"     | Yes, deployed at [url]                                |
| "What's your experience with RAG?"            | Built one, here's where it broke and why              |
| "How do you evaluate AI systems?"             | Here's my eval suite, here's a regression I caught    |
| "When would you use an agent vs a plain LLM?" | Here's the heuristic, here's where mine failed        |
| "What's the hardest part of AI engineering?"  | Evals — and here's why most teams underinvest in them |

That's the bar for "credible AI builder" in 2026.

That's what gets you past the first Fin screen — and into the technical loop where your 5 years of Freshdesk domain knowledge becomes the real differentiator.

---

_Last updated: May 22, 2026_
_Author: Curriculum drafted with Claude_
