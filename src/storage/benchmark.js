import fs from 'node:fs/promises';
import path from 'node:path';
import { loadConfig } from '../config.js';

export async function appendBenchmark(record, { config = loadConfig() } = {}) {
  try {
    await fs.mkdir(path.dirname(config.benchmarkLog), { recursive: true });
    await fs.appendFile(config.benchmarkLog, `${JSON.stringify(record)}\n`);
  } catch (error) {
    console.error(`benchmark log write failed: ${error.message}`);
  }
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

export async function benchmarkSummary(limit = 100, { config = loadConfig() } = {}) {
  const text = await fs.readFile(config.benchmarkLog, 'utf8');
  const rows = text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const recent = rows.slice(-limit);
  const byKind = {};
  for (const row of recent) {
    (byKind[row.kind] ??= []).push(row.elapsedMs || 0);
  }
  const summary = Object.fromEntries(Object.entries(byKind).map(([kind, values]) => [kind, {
    count: values.length,
    avgMs: Math.round(values.reduce((a, b) => a + b, 0) / values.length),
    p50Ms: percentile(values, 50),
    p90Ms: percentile(values, 90),
    maxMs: Math.max(...values),
  }]));
  return { benchmarkLog: config.benchmarkLog, totalRows: rows.length, summarizedRows: recent.length, summary, recent };
}
