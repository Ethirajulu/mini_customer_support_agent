import type { Tool, ToolResult } from "./tools";
import type { Trace } from "./tracing";
import { currentProvider } from "./llm";
import { runAgentAnthropic } from "./agent-anthropic";
import { runAgentOllama } from "./agent-ollama";

// ───── Public types — shared by both provider implementations ─────

// Simple, provider-neutral message shape that callers pass in.
// Provider adapters build their own internal conversation history
// (with tool_use / tool_result blocks for Anthropic, role: "tool"
// messages for Ollama) starting from these.
export type AgentMessage = {
  role: "user" | "assistant";
  content: string;
};

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
      reason: string;
      iterations: number;
    };

export type AgentOpts = {
  system: string;
  messages: AgentMessage[];
  tools: Tool[];
  maxIterations?: number;
  trace?: Trace;
};

export const DEFAULT_MAX_ITERATIONS = 6;

// ───── Dispatcher ─────

// Routes to the right provider based on CHAT_PROVIDER. Same interface for
// both — yields text deltas, tool_call, tool_result, done events.
export async function* runAgent(
  opts: AgentOpts,
): AsyncIterable<AgentEvent> {
  const provider = currentProvider();
  if (provider === "ollama") {
    yield* runAgentOllama(opts);
  } else {
    yield* runAgentAnthropic(opts);
  }
}
