import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  type UIMessage,
} from "ai";
import { streamChat, type ChatMessage } from "@/lib/llm";
import { buildSupportSystemPrompt, SUPPORT_REFUSAL } from "@/lib/prompts";
import { findRelevantChunks, type RetrievedChunk } from "@/lib/retrieval";

export const maxDuration = 30;

// Cosine-distance threshold above which we treat the query as out-of-scope
// and refuse before invoking the LLM. Tune empirically; 0.5 is a reasonable
// starting point given how our chunks cluster (see scripts/embed-articles.ts).
const DISTANCE_THRESHOLD = 0.5;

// How many chunks to include in the LLM context.
const TOP_K = 3;

function uiMessageToText(message: UIMessage): string {
  return message.parts
    .filter((p): p is Extract<UIMessage["parts"][number], { type: "text" }> =>
      p.type === "text",
    )
    .map((p) => p.text)
    .join("");
}

function buildArticlesBlock(chunks: RetrievedChunk[]): string {
  return chunks
    .map(
      (c) =>
        `<article filename="${c.slug}.md" distance="${c.distance.toFixed(3)}">\n${c.content}\n</article>`,
    )
    .join("\n\n");
}

// Stream a fixed string back through the UI message stream protocol so the
// client renders it identically to a real LLM response.
function streamFixedResponse(text: string) {
  const stream = createUIMessageStream({
    execute: ({ writer }) => {
      const id = crypto.randomUUID();
      writer.write({ type: "text-start", id });
      writer.write({ type: "text-delta", id, delta: text });
      writer.write({ type: "text-end", id });
    },
  });
  return createUIMessageStreamResponse({ stream });
}

export async function POST(req: Request) {
  const { messages }: { messages: UIMessage[] } = await req.json();

  const chatMessages: ChatMessage[] = messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({
      role: m.role as "user" | "assistant",
      content: uiMessageToText(m),
    }))
    .filter((m) => m.content.length > 0);

  const lastUser = [...chatMessages].reverse().find((m) => m.role === "user");
  if (!lastUser) {
    return new Response("No user message in conversation", { status: 400 });
  }

  // Retrieval step — embed the query, find nearest chunks
  const chunks = await findRelevantChunks(lastUser.content, TOP_K);
  const bestDistance = chunks[0]?.distance ?? Infinity;

  console.log(`[chat] query: ${JSON.stringify(lastUser.content)}`);
  console.log(
    `[chat] retrieved:`,
    chunks.map((c) => `${c.slug} (${c.distance.toFixed(3)})`).join(", "),
  );

  // Distance gate — if even the best match is too far, this is out-of-scope.
  // Skip the LLM entirely. Architecture beats prompting for refusal compliance.
  if (bestDistance > DISTANCE_THRESHOLD) {
    console.log(
      `[chat] out-of-scope (best=${bestDistance.toFixed(3)} > ${DISTANCE_THRESHOLD}) — refusing without LLM`,
    );
    return streamFixedResponse(SUPPORT_REFUSAL);
  }

  // In-scope — build a tight context from just the retrieved chunks
  const articlesBlock = buildArticlesBlock(chunks);
  const system = buildSupportSystemPrompt(articlesBlock);

  const sources = chunks.map((c) => ({
    slug: c.slug,
    title: c.title,
    distance: Number(c.distance.toFixed(3)),
  }));

  const stream = createUIMessageStream({
    execute: async ({ writer }) => {
      // Send sources immediately — the client can render them while the
      // LLM is still streaming text. Order in `parts[]` doesn't dictate
      // visual order; the client decides where to render data parts.
      writer.write({
        type: "data-sources",
        data: { items: sources },
      });

      const textId = crypto.randomUUID();
      writer.write({ type: "text-start", id: textId });

      for await (const delta of streamChat({
        system,
        messages: chatMessages,
      })) {
        writer.write({ type: "text-delta", id: textId, delta });
      }

      writer.write({ type: "text-end", id: textId });
    },
    onError: (error) => {
      console.error("[chat] stream error", error);
      return error instanceof Error ? error.message : "Unknown error";
    },
  });

  return createUIMessageStreamResponse({ stream });
}
