// Summarizes artifacts/ab/run-*.json into artifacts/ab/summary.json and a markdown table on stdout.
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const dir = resolve('artifacts/ab');
const runs = [];
for (const file of (await readdir(dir)).filter(f => /^run-\d+-.+\.json$/.test(f))) runs.push(JSON.parse(await readFile(join(dir, file), 'utf8')));
const CONFIGS = ['stock', 'stock-ext', 'lean', 'lean-ext'];
const metrics = {
  idleFootprintMiB: r => r.idleFootprint?.totalMiB,
  idleRendererMiB: r => r.idleFootprint?.byRole.renderer,
  idleGpuMiB: r => r.idleFootprint?.byRole['gpu-process'],
  idleRenderers: r => r.idleFootprint?.renderers,
  idleCpuPercent: r => r.idle?.cpuPercent,
  loadCpuSeconds: r => r.loadPhase?.cpuSeconds,
  videoFootprintMiB: r => r.videoFootprint?.totalMiB,
  videoCpuPercent: r => r.video?.cpuPercent,
  videoDroppedPercent: r => r.videoState?.frames ? r.videoState.dropped / r.videoState.frames * 100 : undefined,
  videoHeight: r => r.videoState?.height
};
const stats = values => {
  const v = values.filter(x => typeof x === 'number');
  if (!v.length) return null;
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  return { mean, min: Math.min(...v), max: Math.max(...v), n: v.length, values: v };
};
const summary = {};
for (const config of CONFIGS) {
  const set = runs.filter(r => r.config === config && !r.error);
  summary[config] = { runs: set.length, failed: runs.filter(r => r.config === config && r.error).map(r => r.run),
    codecs: [...new Set(set.flatMap(r => (r.videoState?.codecs ?? []).filter(c => c.startsWith('video')).map(c => c.match(/codecs="(\w+)/)?.[1])))] };
  for (const [name, pick] of Object.entries(metrics)) summary[config][name] = stats(set.map(pick));
}
await writeFile(join(dir, 'summary.json'), JSON.stringify(summary, null, 1));

const fmt = (s, digits = 0) => s ? `${s.mean.toFixed(digits)} (${s.min.toFixed(digits)}–${s.max.toFixed(digits)})` : '—';
const delta = (config, name) => {
  const base = summary.stock[name]?.mean, value = summary[config][name]?.mean;
  return base && value !== undefined && config !== 'stock' ? ` ${value >= base ? '+' : ''}${((value / base - 1) * 100).toFixed(0)}%` : '';
};
const rows = [
  ['Footprint у фоні, MiB', 'idleFootprintMiB', 0], ['  з них renderer, MiB', 'idleRendererMiB', 0], ['  з них GPU, MiB', 'idleGpuMiB', 0],
  ['Renderer-процесів', 'idleRenderers', 0], ['CPU у фоні, % ядра', 'idleCpuPercent', 1], ['CPU на завантаження 10 сайтів, с', 'loadCpuSeconds', 1],
  ['Footprint з відео, MiB', 'videoFootprintMiB', 0], ['CPU з відео, % ядра', 'videoCpuPercent', 1], ['Пропущені кадри, %', 'videoDroppedPercent', 1],
  ['Висота відео, px', 'videoHeight', 0]
];
console.log(`| Показник | ${CONFIGS.join(' | ')} |\n|---|${CONFIGS.map(() => '---:').join('|')}|`);
for (const [label, name, digits] of rows) console.log(`| ${label} | ${CONFIGS.map(c => fmt(summary[c][name], digits) + delta(c, name)).join(' | ')} |`);
console.log(`| Кодек YouTube | ${CONFIGS.map(c => summary[c].codecs.join(', ') || '—').join(' | ')} |`);
console.log(`| Прогонів (невдалих) | ${CONFIGS.map(c => `${summary[c].runs} (${summary[c].failed.length})`).join(' | ')} |`);
