#!/usr/bin/env node
// Runs every Prometheus and Loki query in dashboards/*/*.json against the live stack and
// reports, per panel: ok (returns data), empty (valid query, no data yet) or error.
//   PROM=http://localhost:19090 LOKI=http://localhost:13100 node tests/check-dashboards.mjs
// Exits 1 if any query is rejected as invalid.
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', 'dashboards');
const PROM = process.env.PROM ?? 'http://localhost:19090';
const LOKI = process.env.LOKI ?? 'http://localhost:13100';

// Template variables become match-anything values.
function expand(expr) {
  return expr
    .replace(/\$__rate_interval|\$__auto|\$__interval/g, '5m')
    .replace(/\$__range/g, '1h')
    .replace(/\$\{?(namespace|job|route|cluster|testid|service|app)(:[a-z]+)?\}?/g, '.+')
    .replace(/\$\{?level\}?/g, '.*')
    .replace(/\$\{?search\}?/g, '');
}

async function prom(expr) {
  const r = await fetch(`${PROM}/api/v1/query?${new URLSearchParams({ query: expr })}`);
  const j = await r.json();
  if (j.status !== 'success') return { state: 'error', detail: j.error };
  return { state: j.data.result.length ? 'ok' : 'empty' };
}
async function loki(expr) {
  const end = Date.now() * 1e6;
  const start = end - 3600 * 1e9;
  const r = await fetch(`${LOKI}/loki/api/v1/query_range?${new URLSearchParams({ query: expr, start, end, limit: '5' })}`);
  const text = await r.text();
  if (!r.ok) return { state: 'error', detail: text.trim() };
  const j = JSON.parse(text);
  return { state: j.data.result.length ? 'ok' : 'empty' };
}

let errors = 0;
const totals = { ok: 0, empty: 0, error: 0 };
for (const folder of readdirSync(ROOT, { withFileTypes: true }).filter((d) => d.isDirectory())) {
  for (const file of readdirSync(join(ROOT, folder.name)).filter((f) => f.endsWith('.json'))) {
    const d = JSON.parse(readFileSync(join(ROOT, folder.name, file), 'utf8'));
    console.log(`\n# ${d.title}`);
    for (const p of d.panels) {
      for (const t of p.targets ?? []) {
        const ds = t.datasource?.uid;
        if (!t.expr || (ds !== 'prometheus' && ds !== 'loki')) continue;
        const res = await (ds === 'prometheus' ? prom(expand(t.expr)) : loki(expand(t.expr)));
        totals[res.state]++;
        if (res.state === 'error') errors++;
        const label = `${p.title}${t.legendFormat ? ` [${t.legendFormat}]` : ''}`;
        console.log(`  ${res.state.padEnd(5)} ${ds.padEnd(10)} ${label}${res.detail ? `: ${res.detail}` : ''}`);
      }
    }
  }
}
console.log(`\n${totals.ok} ok, ${totals.empty} empty (valid, no data yet), ${totals.error} errors`);
process.exit(errors ? 1 : 0);
