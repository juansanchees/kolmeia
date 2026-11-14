// J3 baseline: compares a Caçador run's CSV with the gold lists. Local only; the report stays OUTSIDE this (public)
// repo. Run: npm run baseline (env: BASELINE_FOUND, BASELINE_GOLD_DIR, BASELINE_SCHEDULE, BASELINE_AGENT,
// BASELINE_RUN_DATE, BASELINE_ALREADY_KNOWN, BASELINE_OUT). Prints only the two scores.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { SCHEDULES, type Schedule } from "@/lib/agents/types";
import { baselineReport, reportMarkdown, rowsFromCsv } from "@/lib/leads/baseline";

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

test("baseline report", () => {
  const found = path.resolve(need("BASELINE_FOUND"));
  const goldDir = path.resolve(need("BASELINE_GOLD_DIR"));
  const out = path.resolve(need("BASELINE_OUT"));
  const repo = path.resolve(import.meta.dirname, "..", "..");
  if (out === repo || out.startsWith(repo + path.sep)) throw new Error("BASELINE_OUT must be outside kolmeia/ (public repo)");
  const schedule = (process.env.BASELINE_SCHEDULE ?? "weekly") as Schedule;
  if (!SCHEDULES.includes(schedule)) throw new Error("BASELINE_SCHEDULE must be once, weekly or daily");
  const todos = path.join(goldDir, "todos.csv");
  if (!existsSync(todos)) throw new Error("BASELINE_GOLD_DIR needs todos.csv");
  const hotFiles = readdirSync(goldDir).filter((f) => /^quentes-.*\.csv$/.test(f)).sort();
  const report = baselineReport({
    found: rowsFromCsv(readFileSync(found, "utf8")),
    all: rowsFromCsv(readFileSync(todos, "utf8")),
    hot: hotFiles.flatMap((f) => rowsFromCsv(readFileSync(path.join(goldDir, f), "utf8"))),
    schedule,
  });
  writeFileSync(
    out,
    reportMarkdown(report, {
      agentName: process.env.BASELINE_AGENT ?? "?",
      runDate: process.env.BASELINE_RUN_DATE ?? "?",
      alreadyKnown: Number(process.env.BASELINE_ALREADY_KNOWN ?? 0) || 0,
    }),
  );
  console.log(`Todos: precisao ${report.all.precision}, cobertura ${report.all.coverage} | Quentes: precisao ${report.hot.precision}, cobertura ${report.hot.coverage}`);
  expect(report.found).toBeGreaterThanOrEqual(0);
});
