import Anthropic from "@anthropic-ai/sdk";
import type { ChatStreamOpts } from "./llm";

const anthropic = new Anthropic();

export const ANTHROPIC_CHAT_MODEL =
  process.env.ANTHROPIC_CHAT_MODEL ?? "claude-haiku-4-5-20251001";

export async function* streamChatAnthropic(
  opts: ChatStreamOpts,
): AsyncIterable<string> {
  const stream = anthropic.messages.stream({
    model: ANTHROPIC_CHAT_MODEL,
    max_tokens: opts.maxTokens ?? 1024,
    system: opts.system,
    messages: opts.messages,
  });

  for await (const event of stream) {
    if (
      event.type === "content_block_delta" &&
      event.delta.type === "text_delta"
    ) {
      yield event.delta.text;
    }
  }
}
