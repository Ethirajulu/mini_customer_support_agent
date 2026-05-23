import { TOOLS_BY_NAME, type ToolResult } from "./tools";
import { OLLAMA_CHAT_MODEL } from "./llm-ollama";
import {
  DEFAULT_MAX_ITERATIONS,
  type AgentEvent,
  type AgentOpts,
} from "./agent";

const OLLAMA_BASE_URL =
  process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";

// Ollama's tool/message types — different from Anthropic's content-block model.
type OllamaToolCall = {
  id?: string;
  function: {
    name: string;
    arguments: Record<string, unknown> | string;
  };
};

type OllamaMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | {
      role: "assistant";
      content: string;
      tool_calls?: OllamaToolCall[];
    }
  | { role: "tool"; content: string };

type OllamaChunk = {
  message?: {
    role?: string;
    content?: string;
    tool_calls?: OllamaToolCall[];
  };
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
};

export async function* runAgentOllama(
  opts: AgentOpts,
): AsyncIterable<AgentEvent> {
  const maxIter = opts.maxIterations ?? DEFAULT_MAX_ITERATIONS;

  // Ollama-native conversation: system at the top, then user/assistant/tool.
  const conversation: OllamaMessage[] = [
    { role: "system", content: opts.system },
    ...opts.messages.map((m) => ({
      role: m.role,
      content: m.content,
    })),
  ];

  // OpenAI-flavored tool format that Ollama accepts.
  const ollamaTools = opts.tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    },
  }));

  let iter = 0;
  while (iter < maxIter) {
    iter++;

    const generation = opts.trace?.generation({
      name: `iter-${iter}`,
      model: OLLAMA_CHAT_MODEL,
      input: conversation,
    });

    const res = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: OLLAMA_CHAT_MODEL,
        messages: conversation,
        tools: ollamaTools,
        stream: true,
        options: { num_predict: 1024 },
      }),
    });

    if (!res.ok || !res.body) {
      const errText = await res.text();
      generation?.end({ output: { error: errText } });
      throw new Error(
        `Ollama /api/chat failed: ${res.status} ${errText}`,
      );
    }

    // Parse NDJSON stream. Accumulate text deltas and tool_calls (which
    // typically arrive in the final chunk with done=true).
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let assistantText = "";
    let toolCalls: OllamaToolCall[] = [];
    let doneReason = "end_turn";
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) continue;
        let chunk: OllamaChunk;
        try {
          chunk = JSON.parse(line);
        } catch {
          continue;
        }

        const delta = chunk.message?.content;
        if (delta) {
          assistantText += delta;
          yield { type: "text", delta };
        }
        if (chunk.message?.tool_calls && chunk.message.tool_calls.length > 0) {
          toolCalls = chunk.message.tool_calls;
        }
        if (chunk.done) {
          doneReason = chunk.done_reason ?? "end_turn";
          inputTokens = chunk.prompt_eval_count;
          outputTokens = chunk.eval_count;
        }
      }
    }

    generation?.end({
      output: { content: assistantText, tool_calls: toolCalls },
      usage: { input: inputTokens, output: outputTokens },
    });

    // Add the assistant turn (including any tool_calls) to history.
    conversation.push({
      role: "assistant",
      content: assistantText,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    });

    // No tools requested → we're done.
    if (toolCalls.length === 0) {
      yield { type: "done", reason: doneReason, iterations: iter };
      return;
    }

    // Execute each requested tool. Ollama doesn't always provide a stable id
    // per tool_call — synthesize one so we can pair calls with results in the
    // event stream.
    for (let i = 0; i < toolCalls.length; i++) {
      const tc = toolCalls[i];
      const name = tc.function.name;
      // Ollama may return arguments as either a JSON string or a parsed object
      const input: Record<string, unknown> =
        typeof tc.function.arguments === "string"
          ? safeJsonParse(tc.function.arguments)
          : (tc.function.arguments ?? {});

      const toolUseId =
        tc.id ?? `ollama-${iter}-${i}-${Math.random().toString(36).slice(2, 8)}`;

      yield { type: "tool_call", tool_use_id: toolUseId, name, input };

      const span = opts.trace?.span({ name: `tool:${name}`, input });

      const tool = TOOLS_BY_NAME[name];
      let result: ToolResult;
      if (!tool) {
        result = {
          ok: false,
          error: `Unknown tool: ${name}. Available tools: ${Object.keys(TOOLS_BY_NAME).join(", ")}`,
        };
      } else {
        try {
          result = await tool.execute(input);
        } catch (err) {
          result = {
            ok: false,
            error: `Tool '${name}' threw: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      }

      span?.end({ output: result });

      yield { type: "tool_result", tool_use_id: toolUseId, result };

      // Ollama's tool-result format: a separate message with role: "tool"
      conversation.push({
        role: "tool",
        content: JSON.stringify(result),
      });
    }
  }

  yield { type: "done", reason: "max_iterations", iterations: iter };
}

function safeJsonParse(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s);
    return typeof v === "object" && v !== null ? v : {};
  } catch {
    return {};
  }
}
