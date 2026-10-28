// Summarizes artifacts/long/run-*.json: per config means at each checkpoint, deltas against `ext`.
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const dir = resolve('artifacts/long');
const runs = [];
for (const file of (await readdir(dir)).filter(f => /^run-\d+-.+\.json$/.test(f))) runs.push(JSON.parse(await readFile(join(dir, file), 'utf8')));
const configs = [...new Set(runs.map(r => r.config))].sort((a, b) => (a === 'ext' ? -1 : b === 'ext' ? 1 : a.localeCompare(b)));
const mean = values => { const v = values.filter(x => typeof x === 'number'); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : undefined; };
const range = values => { const v = values.filter(x => typeof x === 'number'); return v.length ? `${Math.min(...v).toFixed(0)}–${Math.max(...v).toFixed(0)}` : ''; };
const last = r => r.checkpoints.at(-1);
const metrics = {
  'Footprint наприкінці, MiB': r => last(r)?.memory.totalMiB,
  'з них renderer, MiB': r => last(r)?.memory.byRole.renderer,
  'з них GPU, MiB': r => last(r)?.memory.byRole['gpu-process'],
  'Renderer-процесів': r => last(r)?.memory.renderers,
  'CPU фону (2–12 хв), % ядра': r => mean(r.checkpoints.slice(1).map(c => c.cpu.cpuPercent)),
  'CPU renderer\'ів (2–12 хв), % ядра': r => mean(r.checkpoints.slice(1).map(c => (c.cpu.byRole.renderer ?? 0) / c.cpu.seconds * 100)),
  'CPU на завантаження, с': r => r.load?.cpuSeconds,
  'Повернення p50, мс': r => r.resumeSummary?.p50,
  'Повернення p95, мс': r => r.resumeSummary?.p95,
  'Вивантажено при поверненні': r => r.resumeSummary?.discarded
};
const summary = {};
for (const config of configs) {
  const set = runs.filter(r => r.config === config && !r.error);
  summary[config] = { runs: set.length, failed: runs.filter(r => r.config === config && r.error).length, flags: set[0]?.flags };
  for (const [name, pick] of Object.entries(metrics)) summary[config][name] = { mean: mean(set.map(pick)), range: range(set.map(pick)) };
}
await writeFile(join(dir, 'summary.json'), JSON.stringify(summary, null, 1));
console.log(`| Показник | ${configs.join(' | ')} |\n|---|${configs.map(() => '---:').join('|')}|`);
for (const name of Object.keys(metrics)) {
  const base = summary.ext?.[name]?.mean;
  console.log(`| ${name} | ${configs.map(c => {
    const { mean: m, range: r } = summary[c][name];
    if (m === undefined) return '—';
    const d = c !== 'ext' && base ? ` ${m >= base ? '+' : ''}${((m / base - 1) * 100).toFixed(0)}%` : '';
    return `${m.toFixed(m < 20 ? 1 : 0)} (${r})${d}`;
  }).join(' | ')} |`);
}
console.log(`| Прогонів (невдалих) | ${configs.map(c => `${summary[c].runs} (${summary[c].failed})`).join(' | ')} |`);
