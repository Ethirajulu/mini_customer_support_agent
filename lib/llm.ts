import { streamChatAnthropic } from "./llm-anthropic";
import { streamChatOllama } from "./llm-ollama";

export type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

export type ChatStreamOpts = {
  system: string;
  messages: ChatMessage[];
  maxTokens?: number;
};

export type ChatProvider = "ollama" | "anthropic";

export function currentProvider(): ChatProvider {
  const p = process.env.CHAT_PROVIDER ?? "ollama";
  if (p !== "ollama" && p !== "anthropic") {
    throw new Error(
      `Unknown CHAT_PROVIDER "${p}" — must be "ollama" or "anthropic"`,
    );
  }
  return p;
}

// Yields text deltas as they arrive from whichever provider is configured.
export async function* streamChat(
  opts: ChatStreamOpts,
): AsyncIterable<string> {
  const provider = currentProvider();
  if (provider === "ollama") {
    yield* streamChatOllama(opts);
  } else {
    yield* streamChatAnthropic(opts);
  }
}
