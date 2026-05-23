import Anthropic from "@anthropic-ai/sdk";
import { TOOLS_BY_NAME, type Tool, type ToolResult } from "./tools";
import { ANTHROPIC_CHAT_MODEL } from "./llm-anthropic";

const anthropic = new Anthropic();

// Provider-agnostic message shape that the route hands to the agent.
// We keep it Anthropic-compatible because the loop uses Anthropic's API
// directly. A future Ollama implementation would re-shape these.
export type AgentMessage = Anthropic.MessageParam;

export type AgentEvent =
  | { type: "text"; delta: string }
  | {
      type: "tool_call";
      tool_use_id: string;
      name: string;
      input: Record<string, unknown>;
    }
  | { type: "tool_result"; tool_use_id: string; result: ToolResult }
  | {
      type: "done";
      reason: string; // "end_turn" | "stop_sequence" | "max_tokens" | "pause_turn" | "refusal" | "max_iterations"
      iterations: number;
    };

export type AgentOpts = {
  system: string;
  messages: AgentMessage[];
  tools: Tool[];
  maxIterations?: number;
};

const DEFAULT_MAX_ITERATIONS = 6;

// Run the agent until the model produces a final answer (no more tool calls)
// or we hit the iteration cap. Yields events as they happen — text deltas
// stream immediately, tool calls are announced before execution, results
// emitted after.
export async function* runAgent(
  opts: AgentOpts,
): AsyncIterable<AgentEvent> {
  const maxIter = opts.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const conversation: AgentMessage[] = [...opts.messages];

  // Convert our generic tool definitions to Anthropic's format
  const anthropicTools: Anthropic.Tool[] = opts.tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema as Anthropic.Tool["input_schema"],
  }));

  let iter = 0;
  while (iter < maxIter) {
    iter++;

    const stream = anthropic.messages.stream({
      model: ANTHROPIC_CHAT_MODEL,
      max_tokens: 1024,
      system: opts.system,
      tools: anthropicTools,
      messages: conversation,
    });

    // Stream text deltas as they arrive
    for await (const event of stream) {
      if (
        event.type === "content_block_delta" &&
        event.delta.type === "text_delta"
      ) {
        yield { type: "text", delta: event.delta.text };
      }
    }

    // Final message contains the full assembled response with all content
    // blocks (text + any tool_use). We need it to know stop_reason and to
    // append the assistant turn to conversation history.
    const finalMessage = await stream.finalMessage();
    conversation.push({
      role: "assistant",
      content: finalMessage.content,
    });

    // If the model didn't request tools, we're done
    if (finalMessage.stop_reason !== "tool_use") {
      yield {
        type: "done",
        reason: finalMessage.stop_reason ?? "end_turn",
        iterations: iter,
      };
      return;
    }

    // Execute each tool the model called, in order, and collect results
    const toolUseBlocks = finalMessage.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );

    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const block of toolUseBlocks) {
      const input = (block.input ?? {}) as Record<string, unknown>;

      yield {
        type: "tool_call",
        tool_use_id: block.id,
        name: block.name,
        input,
      };

      const tool = TOOLS_BY_NAME[block.name];
      let result: ToolResult;

      if (!tool) {
        result = {
          ok: false,
          error: `Unknown tool: ${block.name}. Available tools: ${Object.keys(
            TOOLS_BY_NAME,
          ).join(", ")}`,
        };
      } else {
        try {
          result = await tool.execute(input);
        } catch (err) {
          result = {
            ok: false,
            error: `Tool '${block.name}' threw: ${
              err instanceof Error ? err.message : String(err)
            }`,
          };
        }
      }

      yield { type: "tool_result", tool_use_id: block.id, result };

      toolResults.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: JSON.stringify(result),
        is_error: !result.ok,
      });
    }

    // Feed the tool results back as a user message; loop continues so the
    // model can read them and decide what to do next.
    conversation.push({ role: "user", content: toolResults });
  }

  // We exited the loop without an end_turn — too many tool calls in a row.
  yield {
    type: "done",
    reason: "max_iterations",
    iterations: iter,
  };
}
