#!/usr/bin/env python3
"""Observational measurement of the explicitly authorized, already-running Chrome tree."""
import argparse
import datetime as dt
import json
import pathlib
import statistics
import time
from collect_metrics import browser_version, process_table, swap_used_mib, tree_ids

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--pid', required=True, type=int)
parser.add_argument('--phase', required=True, choices=['paused', 'enabled', 'removed'])
parser.add_argument('--duration', type=float, default=60)
parser.add_argument('--warmup', type=float, default=10)
args = parser.parse_args()
if args.duration < 10 or args.warmup < 0:
    parser.error('duration >= 10 and warmup >= 0 required')
expected = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
table = process_table()
if table.get(args.pid, {}).get('command') != expected:
    raise RuntimeError('PID does not match the expected installed Chrome root.')
time.sleep(args.warmup)
samples = []
started = time.monotonic()
while True:
    table = process_table()
    if table.get(args.pid, {}).get('command') != expected:
        raise RuntimeError('Chrome root exited or changed; measurement aborted.')
    ids = tree_ids(table, args.pid)
    samples.append({
        'elapsed_seconds': round(time.monotonic() - started, 2),
        'rss_mib': sum(table[pid]['rss_kib'] for pid in ids) / 1024,
        'cpu_percent': sum(table[pid]['cpu_percent'] for pid in ids),
        'process_count': len(ids), 'swap_mib': swap_used_mib(),
    })
    remaining = args.duration - (time.monotonic() - started)
    if remaining <= 0:
        break
    time.sleep(min(5, remaining))
summary = {
    'rss_mib_mean': statistics.mean(s['rss_mib'] for s in samples),
    'rss_mib_min': min(s['rss_mib'] for s in samples),
    'rss_mib_max': max(s['rss_mib'] for s in samples),
    'cpu_percent_mean': statistics.mean(s['cpu_percent'] for s in samples),
    'process_count_max': max(s['process_count'] for s in samples),
    'swap_mib_start': samples[0]['swap_mib'], 'swap_mib_end': samples[-1]['swap_mib'],
}
result = {
    'kind': 'one_paired_observational_trial_not_controlled_benchmark', 'phase': args.phase,
    'browser_version': browser_version('/Applications/Google Chrome.app'),
    'observed_at_utc': dt.datetime.now(dt.timezone.utc).isoformat(),
    'duration_seconds': args.duration, 'warmup_seconds': args.warmup,
    'cohort': '36 existing web tabs; previous synthetic demo window closed; audit and extension manager tabs also open',
    'scope': 'entire installed Chrome process tree, all extension and shared GPU/utility processes',
    'memory_method': 'sum_process_tree_rss_mib; shared pages may count repeatedly',
    'cpu_method': 'sum ps %cpu; smoothed OS estimate; video remains playing',
    'samples': samples, 'summary': summary,
}
output = pathlib.Path(f'artifacts/real-tabs-{args.phase}.json')
output.parent.mkdir(parents=True, exist_ok=True)
with output.open('x') as file:
    json.dump(result, file, ensure_ascii=False, indent=2)
print(json.dumps({'output': str(output), 'summary': summary}))
