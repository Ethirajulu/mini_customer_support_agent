import type { ChatStreamOpts } from "./llm";

const OLLAMA_BASE_URL =
  process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";

export const OLLAMA_CHAT_MODEL = "llama3.1:8b";

export async function* streamChatOllama(
  opts: ChatStreamOpts,
): AsyncIterable<string> {
  const res = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: OLLAMA_CHAT_MODEL,
      stream: true,
      messages: [
        { role: "system", content: opts.system },
        ...opts.messages,
      ],
      options: {
        num_predict: opts.maxTokens ?? 1024,
      },
    }),
  });

  if (!res.ok || !res.body) {
    throw new Error(
      `Ollama /api/chat failed: ${res.status} ${await res.text()}`,
    );
  }

  // Ollama streams NDJSON — one JSON object per line. Network chunks can
  // split a line in half, so we buffer until we see a newline.
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? ""; // hold incomplete trailing line until next read

    for (const line of lines) {
      if (!line.trim()) continue;
      let obj: { message?: { content?: string }; done?: boolean };
      try {
        obj = JSON.parse(line);
      } catch {
        continue; // skip malformed lines
      }
      const delta = obj.message?.content;
      if (delta) yield delta;
      if (obj.done) return;
    }
  }
}
