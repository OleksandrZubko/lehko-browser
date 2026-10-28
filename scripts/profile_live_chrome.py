#!/usr/bin/env python3
"""Read-only Chrome process census; never persists command lines or page URLs."""
import datetime
import json
import pathlib
import re
import statistics
import subprocess
import time

ROOT = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

def cpu_seconds(value):
    days, _, rest = value.rpartition('-')
    parts = [float(x) for x in rest.split(':')]
    return (int(days) * 86400 if days else 0) + sum(v * 60 ** i for i, v in enumerate(reversed(parts)))

def sample():
    output = subprocess.check_output(['ps', '-axo', 'pid=,ppid=,rss=,time=,command='], text=True)
    all_rows = {}
    for line in output.splitlines():
        fields = line.strip().split(None, 4)
        if len(fields) == 5:
            pid, ppid, rss, cpu, command = fields
            all_rows[int(pid)] = (int(ppid), int(rss), cpu_seconds(cpu), command)
    roots = [pid for pid, row in all_rows.items() if row[3] == ROOT]
    if len(roots) != 1:
        raise RuntimeError('Expected exactly one installed Chrome root')
    ids = set(roots)
    while True:
        expanded = ids | {pid for pid, row in all_rows.items() if row[0] in ids}
        if expanded == ids:
            break
        ids = expanded
    result = {}
    for pid in ids:
        ppid, rss, cpu, command = all_rows[pid]
        role = 'browser' if pid in roots else 'other'
        kind = re.search(r'--type=([^\s]+)', command)
        if kind:
            role = kind[1]
        if role == 'renderer' and '--extension-process' in command:
            role = 'extension-renderer'
        if role == 'utility':
            subtype = re.search(r'--utility-sub-type=([^\s]+)', command)
            role = 'utility:' + (subtype[1] if subtype else 'unknown')
        result[pid] = {'pid': pid, 'role': role, 'rss_mib': rss / 1024, 'cpu_seconds': cpu}
    return roots[0], result

started = time.monotonic()
observations = []
for index in range(13):
    root, rows = sample()
    observations.append({'elapsed_seconds': time.monotonic() - started, 'processes': rows})
    if index < 12:
        time.sleep(5)
elapsed = observations[-1]['elapsed_seconds'] - observations[0]['elapsed_seconds']
processes = []
for pid in {pid for sample_row in observations for pid in sample_row['processes']}:
    seen = [s['processes'][pid] for s in observations if pid in s['processes']]
    delta = 0
    for previous, current in zip(observations, observations[1:]):
        if pid in previous['processes'] and pid in current['processes']:
            delta += max(0, current['processes'][pid]['cpu_seconds'] - previous['processes'][pid]['cpu_seconds'])
    processes.append({'pid': pid, 'role': seen[-1]['role'], 'samples_present': len(seen),
                      'rss_mib_mean_when_present': statistics.mean(s['rss_mib'] for s in seen),
                      'rss_mib_last': seen[-1]['rss_mib'], 'cpu_seconds_observed': delta,
                      'cpu_percent_one_core': delta / elapsed * 100})
groups = {}
for role in {p['role'] for p in processes}:
    members = [p for p in processes if p['role'] == role]
    groups[role] = {'processes_seen': len(members),
                    'rss_mib_mean': statistics.mean(sum(p['rss_mib'] for p in s['processes'].values() if p['role'] == role) for s in observations),
                    'cpu_percent_one_core': sum(p['cpu_percent_one_core'] for p in members)}
result = {'observed_at_utc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
          'root_pid': root, 'duration_seconds': elapsed, 'groups': groups,
          'processes': sorted(processes, key=lambda p: p['cpu_seconds_observed'], reverse=True),
          'samples': observations,
          'limitations': ['RSS sums may double-count shared pages and omit compressed memory.',
                         'CPU deltas omit work before first/after last observation of short-lived processes.',
                         'Live workload is observational, not a controlled benchmark.']}
path = pathlib.Path('artifacts/chrome-resource-census-' + datetime.datetime.now().strftime('%Y%m%dT%H%M%S') + '.json')
path.parent.mkdir(parents=True, exist_ok=True)
path.write_text(json.dumps(result, indent=2))
print(json.dumps({'output': str(path), 'duration_seconds': elapsed, 'groups': groups,
                  'top_cpu': result['processes'][:8],
                  'top_rss': sorted(processes, key=lambda p: p['rss_mib_last'], reverse=True)[:8]}, indent=2))
