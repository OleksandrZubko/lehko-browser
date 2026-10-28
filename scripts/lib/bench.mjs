// Shared measurement helpers for one isolated Chrome process tree on macOS.
import { execFileSync, spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { connectCDP } from './raw-cdp.mjs';

export const sleep = s => new Promise(r => setTimeout(r, s * 1000));

export function role(command) {
  const type = command.match(/--type=([\w-]+)/)?.[1];
  if (!type) return 'browser';
  if (type === 'renderer') return command.includes('--extension-process') ? 'extension' : 'renderer';
  if (type === 'utility') return `utility:${command.match(/--utility-sub-type=[\w.]*?(\w+)\.mojom/)?.[1] ?? 'other'}`;
  return type;
}

export function processes(root) {
  const rows = execFileSync('ps', ['-axo', 'pid=,ppid=,time=,command='], { encoding: 'utf8' }).split('\n').map(line => {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(?:(\d+)-)?(?:(\d+):)?(\d+):([\d.]+)\s+(.*)$/);
    return m && { pid: Number(m[1]), ppid: Number(m[2]), command: m[7],
      cpu: Number(m[3] ?? 0) * 86400 + Number(m[4] ?? 0) * 3600 + Number(m[5]) * 60 + Number(m[6]) };
  }).filter(Boolean);
  const ids = new Set([root]);
  for (let grew = true; grew;) {
    grew = false;
    for (const row of rows) if (ids.has(row.ppid) && !ids.has(row.pid)) { ids.add(row.pid); grew = true; }
  }
  return rows.filter(row => ids.has(row.pid)).map(row => ({ ...row, role: role(row.command) }));
}

// CPU seconds by role between two snapshots; processes gone by `after` lose their last slice.
export function cpuBetween(before, after, seconds) {
  const start = new Map(before.map(p => [p.pid, p.cpu]));
  const byRole = {};
  let total = 0;
  for (const p of after) {
    const used = p.cpu - (start.get(p.pid) ?? 0);
    byRole[p.role] = (byRole[p.role] ?? 0) + used;
    total += used;
  }
  return { seconds, cpuSeconds: total, cpuPercent: total / seconds * 100, byRole,
    exited: before.filter(p => !after.some(q => q.pid === p.pid)).length };
}

export async function footprint(root, path) {
  const list = processes(root);
  for (let attempt = 1; ; attempt++) {
    try {
      execFileSync('/usr/bin/footprint', ['--noCategories', '-j', path, ...list.flatMap(p => ['-p', String(p.pid)])],
        { stdio: ['ignore', 'ignore', 'pipe'], timeout: 60000 });
      break;
    } catch (error) { if (attempt === 3) throw error; }
  }
  const data = JSON.parse(await readFile(path, 'utf8')), roles = new Map(list.map(p => [p.pid, p.role])), byRole = {};
  for (const p of data.processes) if (typeof p.footprint === 'number') {
    const r = roles.get(p.pid) ?? 'unknown';
    byRole[r] = (byRole[r] ?? 0) + p.footprint / 1048576;
  }
  return { totalMiB: data['total footprint'] / 1048576, byRole, processes: list.length,
    renderers: list.filter(p => p.role === 'renderer').length };
}

export function swapMiB() {
  return Number(execFileSync('/usr/sbin/sysctl', ['-n', 'vm.swapusage'], { encoding: 'utf8' }).match(/used = ([\d.]+)M/)?.[1]);
}

export async function launchChrome(profile, flags) {
  const chrome = spawn(process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
    `--user-data-dir=${profile}`, '--remote-debugging-port=0', '--enable-unsafe-extension-debugging',
    '--no-first-run', '--no-default-browser-check', '--window-size=1280,860', ...flags, 'about:blank'
  ], { stdio: 'ignore' });
  let port;
  for (let i = 0; i < 150 && !port; i++) { await sleep(0.2); try { port = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; } catch {} }
  if (!port) throw new Error('Chrome did not open a DevTools port');
  const connect = async () => connectCDP((await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl);
  return { chrome, connect };
}

export function waitExit(chrome) {
  return new Promise(ok => {
    if (chrome.exitCode !== null) return ok();
    chrome.once('exit', ok);
    setTimeout(() => { chrome.kill('SIGKILL'); ok(); }, 10000);
  });
}
