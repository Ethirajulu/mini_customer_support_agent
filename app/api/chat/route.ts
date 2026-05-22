import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  type UIMessage,
} from "ai";
import { anthropic, MODEL } from "@/lib/anthropic";

export const maxDuration = 30;

const HELP_ARTICLES_DIR = join(process.cwd(), "content", "help-articles");

async function loadHelpArticles(): Promise<string> {
  const files = await readdir(HELP_ARTICLES_DIR);
  const markdown = files.filter((f) => f.endsWith(".md")).sort();

  const articles = await Promise.all(
    markdown.map(async (file) => {
      const body = await readFile(join(HELP_ARTICLES_DIR, file), "utf-8");
      return `<article filename="${file}">\n${body.trim()}\n</article>`;
    }),
  );

  return articles.join("\n\n");
}

function uiMessageToText(message: UIMessage): string {
  return message.parts
    .filter((p): p is Extract<UIMessage["parts"][number], { type: "text" }> =>
      p.type === "text",
    )
    .map((p) => p.text)
    .join("");
}

export async function POST(req: Request) {
  const { messages }: { messages: UIMessage[] } = await req.json();

  const articles = await loadHelpArticles();

  const system = `You are a friendly, accurate customer support agent for OrderFlow, a fictional e-commerce platform.

Answer the customer's question using ONLY the help center articles provided below. Rules:

- If the answer is in the articles, respond concisely and link to the relevant article filename when helpful.
- If the answer is NOT in the articles, say so honestly and offer to connect the customer with a human agent. Do not invent policies, prices, or timelines.
- Match the tone of the articles: clear, calm, no jargon, no marketing fluff.
- Use short paragraphs and bullet lists where they help.

# Help Center Articles

${articles}`;

  const anthropicMessages = messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({
      role: m.role as "user" | "assistant",
      content: uiMessageToText(m),
    }))
    .filter((m) => m.content.length > 0);

  const stream = createUIMessageStream({
    execute: async ({ writer }) => {
      const textId = crypto.randomUUID();
      writer.write({ type: "text-start", id: textId });

      const response = anthropic.messages.stream({
        model: MODEL,
        max_tokens: 1024,
        system,
        messages: anthropicMessages,
      });

      for await (const event of response) {
        if (
          event.type === "content_block_delta" &&
          event.delta.type === "text_delta"
        ) {
          writer.write({
            type: "text-delta",
            id: textId,
            delta: event.delta.text,
          });
        }
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
