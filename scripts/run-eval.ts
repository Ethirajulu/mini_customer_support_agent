import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { runAgent } from "@/lib/agent";
import { TOOLS } from "@/lib/tools";
import { AGENT_SYSTEM_PROMPT } from "@/lib/prompts";
import { judge, type JudgeVerdict, type ToolTrace } from "@/lib/judge";
import { ANTHROPIC_CHAT_MODEL } from "@/lib/llm-anthropic";
import { trace, flush, type Trace } from "@/lib/tracing";

// ───── Types ─────

export type GoldenCase = {
  id: string;
  category: string;
  input: string;
  expected_tools: string[];
  expected_behavior: string;
  must_contain: string[];
  must_not_contain: string[];
};

export type CaseRun = {
  case: GoldenCase;
  finalText: string;
  toolsCalled: string[];
  toolTraces: ToolTrace[];
  iterations: number;
  doneReason: string;
  latencyMs: number;
  error?: string;
};

// ───── Deterministic scoring ─────

export type DeterministicScore = {
  toolsMatch: boolean;
  toolsExpected: string[];
  toolsActual: string[];
  mustContain: { phrase: string; found: boolean }[];
  mustNotContain: { phrase: string; absent: boolean }[];
  pass: boolean;
};

export function scoreCase(c: GoldenCase, run: CaseRun): DeterministicScore {
  // Tools: exact ordered match. Order matters because chains do.
  const toolsMatch =
    c.expected_tools.length === run.toolsCalled.length &&
    c.expected_tools.every((t, i) => t === run.toolsCalled[i]);

  // Text checks: case-insensitive substring match. Lowercase both sides once.
  const text = run.finalText.toLowerCase();
  const mustContain = c.must_contain.map((phrase) => ({
    phrase,
    found: text.includes(phrase.toLowerCase()),
  }));
  const mustNotContain = c.must_not_contain.map((phrase) => ({
    phrase,
    absent: !text.includes(phrase.toLowerCase()),
  }));

  const pass =
    toolsMatch &&
    mustContain.every((p) => p.found) &&
    mustNotContain.every((p) => p.absent);

  return {
    toolsMatch,
    toolsExpected: c.expected_tools,
    toolsActual: run.toolsCalled,
    mustContain,
    mustNotContain,
    pass,
  };
}

function formatFailReasons(score: DeterministicScore): string[] {
  const reasons: string[] = [];
  if (!score.toolsMatch) {
    reasons.push(
      `tools expected [${score.toolsExpected.join(",") || "(none)"}], got [${score.toolsActual.join(",") || "(none)"}]`,
    );
  }
  const missing = score.mustContain.filter((c) => !c.found);
  if (missing.length > 0) {
    reasons.push(
      `must_contain missing: ${missing.map((m) => JSON.stringify(m.phrase)).join(", ")}`,
    );
  }
  const present = score.mustNotContain.filter((c) => !c.absent);
  if (present.length > 0) {
    reasons.push(
      `must_not_contain found: ${present.map((m) => JSON.stringify(m.phrase)).join(", ")}`,
    );
  }
  return reasons;
}

// ───── Single-case runner ─────

async function runCase(c: GoldenCase, caseTrace: Trace): Promise<CaseRun> {
  const t0 = Date.now();
  const toolsCalled: string[] = [];
  const toolTraces: ToolTrace[] = [];
  // Buffer pending tool_call events until their matching tool_result arrives,
  // so we can build a full {name, input, result} trace per call.
  const pendingByid = new Map<string, { name: string; input: Record<string, unknown> }>();
  let finalText = "";
  let iterations = 0;
  let doneReason = "unknown";

  try {
    for await (const event of runAgent({
      system: AGENT_SYSTEM_PROMPT,
      messages: [{ role: "user", content: c.input }],
      tools: TOOLS,
      maxIterations: 6,
      trace: caseTrace,
    })) {
      if (event.type === "text") {
        finalText += event.delta;
      } else if (event.type === "tool_call") {
        toolsCalled.push(event.name);
        pendingByid.set(event.tool_use_id, {
          name: event.name,
          input: event.input,
        });
      } else if (event.type === "tool_result") {
        const pending = pendingByid.get(event.tool_use_id);
        if (pending) {
          toolTraces.push({ ...pending, result: event.result });
          pendingByid.delete(event.tool_use_id);
        }
      } else if (event.type === "done") {
        iterations = event.iterations;
        doneReason = event.reason;
      }
    }
  } catch (err) {
    caseTrace?.update({
      output: finalText || `ERROR: ${err instanceof Error ? err.message : String(err)}`,
    });
    return {
      case: c,
      finalText,
      toolsCalled,
      toolTraces,
      iterations,
      doneReason: "error",
      latencyMs: Date.now() - t0,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  caseTrace?.update({ output: finalText });

  return {
    case: c,
    finalText,
    toolsCalled,
    toolTraces,
    iterations,
    doneReason,
    latencyMs: Date.now() - t0,
  };
}

// ───── Orchestrator ─────

type CaseResult = {
  run: CaseRun;
  score: DeterministicScore;
  judge: JudgeVerdict | { error: string } | null;
};

function isJudgeError(
  j: CaseResult["judge"],
): j is { error: string } {
  return !!j && "error" in j;
}

async function main() {
  const goldenPath = join(process.cwd(), "evals", "golden-set.json");
  const raw = await readFile(goldenPath, "utf-8");
  const cases = JSON.parse(raw) as GoldenCase[];

  console.log(`Loaded ${cases.length} cases from ${goldenPath}\n`);

  const results: CaseResult[] = [];

  for (const c of cases) {
    process.stdout.write(`  ${c.id.padEnd(34)} `);

    // One LangFuse trace per case — shared by agent generations AND the judge
    const caseTrace = trace({
      name: "eval-case",
      input: c.input,
      metadata: { case_id: c.id, category: c.category },
      tags: ["eval", c.category],
    });

    const run = await runCase(c, caseTrace);

    if (run.error) {
      console.log(`ERROR · ${run.latencyMs}ms · ${run.error}`);
      results.push({
        run,
        score: {
          toolsMatch: false,
          toolsExpected: c.expected_tools,
          toolsActual: [],
          mustContain: [],
          mustNotContain: [],
          pass: false,
        },
        judge: null,
      });
      continue;
    }

    const score = scoreCase(c, run);

    // Run the LLM judge — wrap in try so one bad judge call doesn't kill the run
    let verdict: CaseResult["judge"] = null;
    try {
      verdict = await judge(
        {
          user_input: c.input,
          expected_behavior: c.expected_behavior,
          tools_called: run.toolsCalled,
          tool_traces: run.toolTraces,
          final_response: run.finalText,
        },
        caseTrace,
      );
    } catch (err) {
      verdict = { error: err instanceof Error ? err.message : String(err) };
    }

    results.push({ run, score, judge: verdict });

    const tools =
      run.toolsCalled.length === 0 ? "(no tools)" : run.toolsCalled.join(" → ");
    const detMark = score.pass ? "✓" : "✗";
    const judgeMark = isJudgeError(verdict)
      ? "?"
      : verdict?.pass
        ? "✓"
        : "✗";
    const overallPass = score.pass && !isJudgeError(verdict) && verdict?.pass;
    const overallMark = overallPass ? "✓ PASS" : "✗ FAIL";

    console.log(
      `${overallMark} · det ${detMark} judge ${judgeMark} · ${String(run.iterations)} iter · ${String(run.latencyMs).padStart(5)}ms · ${tools}`,
    );

    if (!overallPass) {
      for (const reason of formatFailReasons(score)) {
        console.log(`     ├─ det: ${reason}`);
      }
      if (isJudgeError(verdict)) {
        console.log(`     └─ judge: error — ${verdict.error}`);
      } else if (verdict && !verdict.pass) {
        const failed = Object.entries(verdict.scores)
          .filter(([, v]) => !v)
          .map(([k]) => k)
          .join(", ");
        console.log(`     └─ judge: failed [${failed}] — ${verdict.reasoning}`);
      }
    }
  }

  // ───── Aggregate stats ─────

  const total = results.length;
  const detPassed = results.filter((r) => r.score.pass).length;
  const judgePassed = results.filter(
    (r) => !isJudgeError(r.judge) && r.judge?.pass,
  ).length;
  const bothPassed = results.filter(
    (r) =>
      r.score.pass && !isJudgeError(r.judge) && r.judge?.pass,
  ).length;

  const byCategory = new Map<
    string,
    { det: number; judge: number; both: number; total: number }
  >();
  for (const r of results) {
    const bucket = byCategory.get(r.run.case.category) ?? {
      det: 0,
      judge: 0,
      both: 0,
      total: 0,
    };
    bucket.total++;
    if (r.score.pass) bucket.det++;
    if (!isJudgeError(r.judge) && r.judge?.pass) bucket.judge++;
    if (r.score.pass && !isJudgeError(r.judge) && r.judge?.pass)
      bucket.both++;
    byCategory.set(r.run.case.category, bucket);
  }

  const totalMs = results.reduce((s, r) => s + r.run.latencyMs, 0);
  const avgMs = Math.round(totalMs / total);
  const totalIter = results.reduce((s, r) => s + r.run.iterations, 0);
  const avgIter = (totalIter / total).toFixed(2);

  console.log(`\n─── Pass rate by category ───`);
  console.log(`  ${"".padEnd(20)} ${"Det".padStart(8)}  ${"Judge".padStart(8)}  ${"Both".padStart(8)}`);
  for (const [cat, b] of byCategory) {
    const det = `${b.det}/${b.total}`;
    const j = `${b.judge}/${b.total}`;
    const both = `${b.both}/${b.total}`;
    console.log(
      `  ${cat.padEnd(20)} ${det.padStart(8)}  ${j.padStart(8)}  ${both.padStart(8)}`,
    );
  }

  console.log(`\n─── Overall ───`);
  console.log(
    `Det only:    ${detPassed}/${total} (${Math.round((detPassed / total) * 100)}%)`,
  );
  console.log(
    `Judge only:  ${judgePassed}/${total} (${Math.round((judgePassed / total) * 100)}%)`,
  );
  console.log(
    `Both:        ${bothPassed}/${total} (${Math.round((bothPassed / total) * 100)}%)`,
  );
  console.log(`Time:        ${(totalMs / 1000).toFixed(1)}s total · avg ${avgMs}ms/case`);
  console.log(`Iter:        avg ${avgIter}/case`);

  const reportPath = await writeReport(
    results,
    join(process.cwd(), "evals", "results"),
  );
  console.log(`\nReport written to ${reportPath}`);

  // Flush LangFuse events to the server before the script exits, otherwise
  // queued traces are lost.
  await flush();
  console.log(`LangFuse traces flushed.`);
}

// ───── Report writer ─────

function isOverallPass(r: CaseResult): boolean {
  return r.score.pass && !isJudgeError(r.judge) && (r.judge?.pass ?? false);
}

function blockquote(text: string): string {
  return text
    .trim()
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

function renderFailureDetail(r: CaseResult): string {
  const c = r.run.case;
  const tools =
    r.run.toolsCalled.length === 0 ? "(none)" : r.run.toolsCalled.join(" → ");

  let md = `### ❌ ${c.id} (${c.category})\n\n`;
  md += `**Input:** ${JSON.stringify(c.input)}\n\n`;
  md += `**Expected behavior:** ${c.expected_behavior}\n\n`;
  md += `**Expected tools:** \`${c.expected_tools.length === 0 ? "(none)" : c.expected_tools.join(" → ")}\`\n\n`;
  md += `**Tools called:** \`${tools}\` · ${r.run.iterations} iter · ${r.run.latencyMs}ms\n\n`;

  if (r.run.error) {
    md += `**ERROR:** ${r.run.error}\n\n`;
  } else {
    md += `**Response:**\n\n${blockquote(r.run.finalText)}\n\n`;
  }

  const failReasons = formatFailReasons(r.score);
  if (failReasons.length > 0) {
    md += `**Deterministic failures:**\n`;
    for (const reason of failReasons) md += `- ${reason}\n`;
    md += `\n`;
  } else {
    md += `**Deterministic:** ✓\n\n`;
  }

  if (isJudgeError(r.judge)) {
    md += `**Judge:** error — ${r.judge.error}\n\n`;
  } else if (r.judge) {
    if (r.judge.pass) {
      md += `**Judge:** ✓\n\n`;
    } else {
      const failed = Object.entries(r.judge.scores)
        .filter(([, v]) => !v)
        .map(([k]) => k);
      md += `**Judge:** failed [${failed.join(", ")}]\n\n`;
      md += `${blockquote(r.judge.reasoning)}\n\n`;
    }
  }

  md += `---\n\n`;
  return md;
}

function renderPassSummary(r: CaseResult): string {
  const tools =
    r.run.toolsCalled.length === 0 ? "(none)" : r.run.toolsCalled.join(" → ");
  return `- ✓ **${r.run.case.id}** — \`${tools}\` · ${r.run.latencyMs}ms\n`;
}

function buildReport(results: CaseResult[]): string {
  const total = results.length;
  const detPassed = results.filter((r) => r.score.pass).length;
  const judgePassed = results.filter(
    (r) => !isJudgeError(r.judge) && r.judge?.pass,
  ).length;
  const bothPassed = results.filter(isOverallPass).length;

  const totalMs = results.reduce((s, r) => s + r.run.latencyMs, 0);
  const totalIter = results.reduce((s, r) => s + r.run.iterations, 0);

  const byCategory = new Map<
    string,
    { det: number; judge: number; both: number; total: number }
  >();
  for (const r of results) {
    const b = byCategory.get(r.run.case.category) ?? {
      det: 0,
      judge: 0,
      both: 0,
      total: 0,
    };
    b.total++;
    if (r.score.pass) b.det++;
    if (!isJudgeError(r.judge) && r.judge?.pass) b.judge++;
    if (isOverallPass(r)) b.both++;
    byCategory.set(r.run.case.category, b);
  }

  let md = "";
  md += `# Eval Run — ${new Date().toISOString()}\n\n`;
  md += `| Setting | Value |\n|---|---|\n`;
  md += `| Agent | \`${ANTHROPIC_CHAT_MODEL}\` |\n`;
  md += `| Judge | \`claude-sonnet-4-6\` |\n`;
  md += `| Cases | ${total} |\n`;
  md += `| Total time | ${(totalMs / 1000).toFixed(1)}s |\n`;
  md += `| Avg latency | ${Math.round(totalMs / total)}ms |\n`;
  md += `| Avg iterations | ${(totalIter / total).toFixed(2)} |\n\n`;

  md += `## Summary\n\n`;
  md += `| Category | Det | Judge | Both |\n|---|---|---|---|\n`;
  for (const [cat, b] of byCategory) {
    md += `| ${cat} | ${b.det}/${b.total} | ${b.judge}/${b.total} | ${b.both}/${b.total} |\n`;
  }
  md += `| **Overall** | **${detPassed}/${total} (${Math.round((detPassed / total) * 100)}%)** | **${judgePassed}/${total} (${Math.round((judgePassed / total) * 100)}%)** | **${bothPassed}/${total} (${Math.round((bothPassed / total) * 100)}%)** |\n\n`;

  const failures = results.filter((r) => !isOverallPass(r));
  md += `## Failures (${failures.length})\n\n`;
  if (failures.length === 0) {
    md += `_None — every case passed both deterministic and judge checks._\n\n`;
  } else {
    for (const r of failures) md += renderFailureDetail(r);
  }

  const passes = results.filter(isOverallPass);
  md += `## Passes (${passes.length})\n\n`;
  for (const r of passes) md += renderPassSummary(r);

  return md;
}

async function writeReport(
  results: CaseResult[],
  outputDir: string,
): Promise<string> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filepath = join(outputDir, `${stamp}.md`);
  await mkdir(outputDir, { recursive: true });
  await writeFile(filepath, buildReport(results), "utf-8");
  return filepath;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
