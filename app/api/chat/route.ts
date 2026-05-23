import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  type UIMessage,
} from "ai";
import { runAgent, type AgentMessage } from "@/lib/agent";
import { AGENT_SYSTEM_PROMPT } from "@/lib/prompts";
import { TOOLS } from "@/lib/tools";

export const maxDuration = 60;

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

  // Convert UI messages to plain {role, content} for the agent.
  // Multi-turn tool-call history (assistant tool_use blocks + user tool_result
  // blocks) is reconstructed each turn from scratch — we don't persist tool
  // history across requests in Phase 3. The visible user/assistant text is
  // enough for the model to remember the conversation thread.
  const agentMessages: AgentMessage[] = messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({
      role: m.role as "user" | "assistant",
      content: uiMessageToText(m),
    }))
    .filter((m) => typeof m.content === "string" && m.content.length > 0);

  const lastUser = [...agentMessages].reverse().find((m) => m.role === "user");
  if (!lastUser) {
    return new Response("No user message in conversation", { status: 400 });
  }

  console.log(`[chat] query: ${JSON.stringify(uiMessageToText(messages[messages.length - 1]))}`);

  const stream = createUIMessageStream({
    execute: async ({ writer }) => {
      // We use a fresh text-block ID for each "text segment" between tool
      // calls — assistant turns can interleave "let me check…" text with a
      // tool_use, then more text after the tool result. Multiple text blocks
      // keeps the UI rendering clean.
      let currentTextId: string | null = null;

      const startText = () => {
        if (currentTextId) return;
        currentTextId = crypto.randomUUID();
        writer.write({ type: "text-start", id: currentTextId });
      };

      const endText = () => {
        if (currentTextId) {
          writer.write({ type: "text-end", id: currentTextId });
          currentTextId = null;
        }
      };

      try {
        for await (const event of runAgent({
          system: AGENT_SYSTEM_PROMPT,
          messages: agentMessages,
          tools: TOOLS,
          maxIterations: 6,
        })) {
          if (event.type === "text") {
            if (!currentTextId) startText();
            writer.write({
              type: "text-delta",
              id: currentTextId!,
              delta: event.delta,
            });
          } else if (event.type === "tool_call") {
            endText();
            console.log(
              `[agent] tool_call: ${event.name}(${JSON.stringify(event.input)})`,
            );
            writer.write({
              type: "data-tool-call",
              id: event.tool_use_id,
              data: {
                name: event.name,
                input: event.input,
              },
            });
          } else if (event.type === "tool_result") {
            console.log(
              `[agent] tool_result: ${event.result.ok ? "ok" : "ERR " + event.result.error}`,
            );
            writer.write({
              type: "data-tool-result",
              id: event.tool_use_id,
              data: {
                ok: event.result.ok,
                ...(event.result.ok
                  ? { result: event.result.data }
                  : { error: event.result.error }),
              },
            });
          } else if (event.type === "done") {
            endText();
            console.log(
              `[agent] done after ${event.iterations} iteration(s) (reason: ${event.reason})`,
            );
          }
        }
      } catch (err) {
        console.error("[chat] agent error", err);
        endText();
        const id = crypto.randomUUID();
        writer.write({ type: "text-start", id });
        writer.write({
          type: "text-delta",
          id,
          delta:
            "Sorry — something went wrong on our end. Please try again or email support@example.com.",
        });
        writer.write({ type: "text-end", id });
      }
    },
    onError: (error) => {
      console.error("[chat] stream error", error);
      return error instanceof Error ? error.message : "Unknown error";
    },
  });

  return createUIMessageStreamResponse({ stream });
}
