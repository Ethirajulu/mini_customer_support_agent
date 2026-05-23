import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic();

// Use a stronger model for the judge than for the agent. Same-model bias
// (Haiku judging Haiku) is real — Sonnet gives us a more honest evaluation.
// ~$0.13 per 20-case eval run, vs ~$0.03 for Haiku.
const JUDGE_MODEL = "claude-sonnet-4-6";

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

export async function judge(input: JudgeInput): Promise<JudgeVerdict> {
  const response = await anthropic.messages.create({
    model: JUDGE_MODEL,
    max_tokens: 512,
    messages: [{ role: "user", content: buildJudgePrompt(input) }],
  });

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");

  // Extract the JSON object — be defensive in case the model adds a preamble
  // despite our "no preamble" instruction.
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) {
    throw new Error(
      `Judge did not return JSON. First 200 chars: ${text.slice(0, 200)}`,
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

  return {
    scores,
    reasoning:
      typeof parsed.reasoning === "string" ? parsed.reasoning : "(no reasoning provided)",
    pass: Object.values(scores).every(Boolean),
  };
}
