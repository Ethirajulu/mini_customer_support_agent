import Anthropic from "@anthropic-ai/sdk";
import { TOOLS_BY_NAME, type ToolResult } from "./tools";
import { ANTHROPIC_CHAT_MODEL } from "./llm-anthropic";
import {
  DEFAULT_MAX_ITERATIONS,
  type AgentEvent,
  type AgentOpts,
} from "./agent";

const anthropic = new Anthropic();

export async function* runAgentAnthropic(
  opts: AgentOpts,
): AsyncIterable<AgentEvent> {
  const maxIter = opts.maxIterations ?? DEFAULT_MAX_ITERATIONS;

  // Anthropic-internal conversation: uses MessageParam with content blocks
  // (tool_use, tool_result) for multi-turn tool history.
  const conversation: Anthropic.MessageParam[] = opts.messages.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  // Translate generic tool definitions to Anthropic's format.
  const anthropicTools: Anthropic.Tool[] = opts.tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema as Anthropic.Tool["input_schema"],
  }));

  let iter = 0;
  while (iter < maxIter) {
    iter++;

    const generation = opts.trace?.generation({
      name: `iter-${iter}`,
      model: ANTHROPIC_CHAT_MODEL,
      input: conversation,
    });

    const stream = anthropic.messages.stream({
      model: ANTHROPIC_CHAT_MODEL,
      max_tokens: 1024,
      system: opts.system,
      tools: anthropicTools,
      messages: conversation,
    });

    for await (const event of stream) {
      if (
        event.type === "content_block_delta" &&
        event.delta.type === "text_delta"
      ) {
        yield { type: "text", delta: event.delta.text };
      }
    }

    const finalMessage = await stream.finalMessage();

    generation?.end({
      output: finalMessage.content,
      usage: {
        input: finalMessage.usage?.input_tokens,
        output: finalMessage.usage?.output_tokens,
      },
    });

    conversation.push({
      role: "assistant",
      content: finalMessage.content,
    });

    if (finalMessage.stop_reason !== "tool_use") {
      yield {
        type: "done",
        reason: finalMessage.stop_reason ?? "end_turn",
        iterations: iter,
      };
      return;
    }

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

      const span = opts.trace?.span({
        name: `tool:${block.name}`,
        input,
      });

      const tool = TOOLS_BY_NAME[block.name];
      let result: ToolResult;
      if (!tool) {
        result = {
          ok: false,
          error: `Unknown tool: ${block.name}. Available tools: ${Object.keys(TOOLS_BY_NAME).join(", ")}`,
        };
      } else {
        try {
          result = await tool.execute(input);
        } catch (err) {
          result = {
            ok: false,
            error: `Tool '${block.name}' threw: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      }

      span?.end({ output: result });

      yield { type: "tool_result", tool_use_id: block.id, result };

      toolResults.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: JSON.stringify(result),
        is_error: !result.ok,
      });
    }

    conversation.push({ role: "user", content: toolResults });
  }

  yield { type: "done", reason: "max_iterations", iterations: iter };
}
