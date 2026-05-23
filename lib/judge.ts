import Anthropic from "@anthropic-ai/sdk";
import type { Trace } from "./tracing";

const anthropic = new Anthropic();

// ───── Judge provider config ─────
// Default: Anthropic (stronger, less biased when judging Haiku/Llama agents).
// Set JUDGE_PROVIDER=ollama to use a local model — slower, less reliable,
// but $0 and offline. For honest cross-provider eval comparisons, keep the
// judge constant across runs.
type JudgeProvider = "anthropic" | "ollama";

function currentJudgeProvider(): JudgeProvider {
  const p = process.env.JUDGE_PROVIDER ?? "anthropic";
  if (p !== "anthropic" && p !== "ollama") {
    throw new Error(
      `Unknown JUDGE_PROVIDER "${p}" — must be "anthropic" or "ollama"`,
    );
  }
  return p;
}

const ANTHROPIC_JUDGE_MODEL =
  process.env.ANTHROPIC_JUDGE_MODEL ?? "claude-sonnet-4-6";
const OLLAMA_JUDGE_MODEL =
  process.env.OLLAMA_JUDGE_MODEL ?? "qwen2.5:14b";
const OLLAMA_BASE_URL =
  process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";

function judgeModelName(provider: JudgeProvider): string {
  return provider === "ollama" ? OLLAMA_JUDGE_MODEL : ANTHROPIC_JUDGE_MODEL;
}

export type ToolTrace = {
  name: string;
  input: Record<string, unknown>;
  result: { ok: true; data: unknown } | { ok: false; error: string };
};

export type JudgeInput = {
  user_input: string;
  expected_behavior: string;
  tools_called: string[];
  tool_traces: ToolTrace[];
  final_response: string;
};

export type JudgeScores = {
  correctness: boolean;
  no_hallucination: boolean;
  appropriate_action: boolean;
  helpful_tone: boolean;
};

export type JudgeVerdict = {
  scores: JudgeScores;
  reasoning: string;
  pass: boolean;
};

// Same model judging same model has known bias — strict rubric is the mitigation.
// We pass `expected_behavior` so the judge measures alignment to intent, not
// vague "quality." This makes false-positives much rarer.
function formatToolTraces(traces: ToolTrace[]): string {
  if (traces.length === 0) return "(no tools were called)";
  return traces
    .map((t, i) => {
      const result = t.result.ok
        ? `OK: ${JSON.stringify(t.result.data)}`
        : `ERROR: ${t.result.error}`;
      return `${i + 1}. ${t.name}(${JSON.stringify(t.input)})\n   → ${result}`;
    })
    .join("\n\n");
}

function buildJudgePrompt(input: JudgeInput): string {
  return `You are evaluating a customer support AI agent's response. Score it strictly using a yes/no rubric. Be honest — false positives ("yes" when it's actually no) ruin the eval more than false negatives.

# User message
${JSON.stringify(input.user_input)}

# Tools the agent called (with the actual data they returned)
${formatToolTraces(input.tool_traces)}

# Agent's final response to the user
"""
${input.final_response}
"""

# What was expected for this case (the rubric's "correct" behavior)
${input.expected_behavior}

# Rubric — answer each yes/no carefully

1. **correctness** — Does the agent's response correctly follow the **expected behavior** described above? IMPORTANT: For cases where the expected behavior is to refuse, decline, or redirect (e.g. out-of-scope queries), a polite refusal IS the correct response — do NOT mark correctness as false just because the agent didn't literally answer the user's question. Correctness measures "did the agent do what was expected for this scenario."

2. **no_hallucination** — Did the response avoid inventing facts that aren't either (a) present in the tool results shown above OR (b) reasonable common-knowledge customer-service info? IMPORTANT: If a fact in the response can be traced to a tool result (e.g. an order's total, a refund date, an article excerpt), it is NOT a hallucination — it's grounded. Only mark as hallucinated if you can see specific claims that don't appear in any tool result and aren't basic common knowledge.

3. **appropriate_action** — Did the agent take the right TYPE of action for this input? (Refuse if out-of-scope. Look up an order if asked about one. Create a ticket if it needed human follow-up. Ask for clarification if ambiguous.) This is about whether the agent picked the right strategy, not whether it phrased the answer perfectly.

4. **helpful_tone** — Was the response calm, clear, free of marketing fluff and excess apology?

# Output format

Return ONLY a JSON object, no markdown fence, no preamble. Exact format:
{
  "correctness": true_or_false,
  "no_hallucination": true_or_false,
  "appropriate_action": true_or_false,
  "helpful_tone": true_or_false,
  "reasoning": "<one or two sentences explaining the call, especially if any score is false>"
}`;
}

type JudgeCallResult = {
  text: string;
  usage: { input?: number; output?: number };
};

async function callJudgeAnthropic(prompt: string): Promise<JudgeCallResult> {
  const response = await anthropic.messages.create({
    model: ANTHROPIC_JUDGE_MODEL,
    max_tokens: 512,
    temperature: 0, // deterministic scoring
    messages: [{ role: "user", content: prompt }],
  });
  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
  return {
    text,
    usage: {
      input: response.usage?.input_tokens,
      output: response.usage?.output_tokens,
    },
  };
}

async function callJudgeOllama(prompt: string): Promise<JudgeCallResult> {
  const res = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: OLLAMA_JUDGE_MODEL,
      messages: [{ role: "user", content: prompt }],
      stream: false,
      // Ollama's `format: "json"` constrains output to valid JSON — huge
      // help for the strict parsing we do below.
      format: "json",
      options: { temperature: 0, num_predict: 512 },
    }),
  });
  if (!res.ok) {
    throw new Error(
      `Ollama /api/chat failed for judge: ${res.status} ${await res.text()}`,
    );
  }
  const data = (await res.json()) as {
    message?: { content?: string };
    prompt_eval_count?: number;
    eval_count?: number;
  };
  return {
    text: data.message?.content ?? "",
    usage: {
      input: data.prompt_eval_count,
      output: data.eval_count,
    },
  };
}

export async function judge(
  input: JudgeInput,
  trace?: Trace,
): Promise<JudgeVerdict> {
  const provider = currentJudgeProvider();
  const model = judgeModelName(provider);

  // Nest the judge as a generation under whatever trace the caller provided
  // (the eval-case trace, typically). Same input/output/usage shape as the
  // agent's generations, so the LangFuse UI shows them uniformly.
  const generation = trace?.generation({
    name: "judge",
    model,
    input: {
      user_input: input.user_input,
      expected_behavior: input.expected_behavior,
      tools_called: input.tools_called,
      agent_response: input.final_response,
    },
  });

  const prompt = buildJudgePrompt(input);
  const { text, usage } =
    provider === "ollama"
      ? await callJudgeOllama(prompt)
      : await callJudgeAnthropic(prompt);

  // Extract the JSON object — be defensive even with format=json since some
  // models still wrap responses in fences or add stray characters.
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) {
    generation?.end({
      output: { error: "Judge did not return JSON", raw: text.slice(0, 200) },
    });
    throw new Error(
      `Judge (${model}) did not return JSON. First 200 chars: ${text.slice(0, 200)}`,
    );
  }

  const parsed = JSON.parse(match[0]) as Partial<JudgeScores> & {
    reasoning?: unknown;
  };

  const scores: JudgeScores = {
    correctness: !!parsed.correctness,
    no_hallucination: !!parsed.no_hallucination,
    appropriate_action: !!parsed.appropriate_action,
    helpful_tone: !!parsed.helpful_tone,
  };

  const verdict: JudgeVerdict = {
    scores,
    reasoning:
      typeof parsed.reasoning === "string"
        ? parsed.reasoning
        : "(no reasoning provided)",
    pass: Object.values(scores).every(Boolean),
  };

  generation?.end({ output: verdict, usage });

  // Push the verdict as proper LangFuse Score entities on the parent trace.
  // Each rubric dimension becomes a filterable, chartable Boolean score
  // (0/1). The overall pass also gets a score, with the judge's reasoning
  // attached as a comment so you can read it from the trace's Scores tab.
  if (trace) {
    trace.score({
      name: "correctness",
      value: scores.correctness ? 1 : 0,
      dataType: "BOOLEAN",
    });
    trace.score({
      name: "no_hallucination",
      value: scores.no_hallucination ? 1 : 0,
      dataType: "BOOLEAN",
    });
    trace.score({
      name: "appropriate_action",
      value: scores.appropriate_action ? 1 : 0,
      dataType: "BOOLEAN",
    });
    trace.score({
      name: "helpful_tone",
      value: scores.helpful_tone ? 1 : 0,
      dataType: "BOOLEAN",
    });
    trace.score({
      name: "judge_pass",
      value: verdict.pass ? 1 : 0,
      dataType: "BOOLEAN",
      comment: verdict.reasoning,
    });
  }

  return verdict;
}
