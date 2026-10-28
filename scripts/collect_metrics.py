#!/usr/bin/env python3
"""Sample one isolated Chrome process tree on macOS. RSS is a proxy, not unique physical memory."""
import argparse
import datetime as dt
import json
import pathlib
import platform
import plistlib
import re
import statistics
import subprocess
import time


def process_table():
    output = subprocess.check_output(['ps', '-axo', 'pid=,ppid=,rss=,%cpu=,command='], text=True)
    result = {}
    for line in output.splitlines():
        fields = line.strip().split(None, 4)
        if len(fields) == 5:
            result[int(fields[0])] = {'ppid': int(fields[1]), 'rss_kib': int(fields[2]),
                                       'cpu_percent': float(fields[3]), 'command': fields[4]}
    return result


def tree_ids(table, root_pid):
    ids = {root_pid}
    while True:
        children = {pid for pid, row in table.items() if row['ppid'] in ids}
        if children.issubset(ids):
            return ids
        ids.update(children)


def swap_used_mib():
    output = subprocess.check_output(['sysctl', '-n', 'vm.swapusage'], text=True)
    match = re.search(r'used\s*=\s*([\d.]+)([KMG])', output)
    if not match:
        raise RuntimeError('Cannot parse vm.swapusage')
    return float(match[1]) * {'K': 1 / 1024, 'M': 1, 'G': 1024}[match[2]]


def browser_version(app):
    with open(pathlib.Path(app) / 'Contents/Info.plist', 'rb') as file:
        return plistlib.load(file)['CFBundleShortVersionString']


def matches_profile(command, profile):
    # macOS /var is an alias of /private/var; accept either exact spelling, never a prefix match.
    paths = {str(pathlib.Path(profile).absolute()), str(pathlib.Path(profile).resolve())}
    return any(re.search(re.escape(f'--user-data-dir={path}') + r'(?=\s|$)', command) for path in paths)


def summarize(samples):
    return {
        'rss_mib_mean': statistics.mean(s['rss_mib'] for s in samples),
        'cpu_percent_mean': statistics.mean(s['cpu_percent'] for s in samples),
        'swap_mib_start': samples[0]['swap_mib'], 'swap_mib_end': samples[-1]['swap_mib'],
        'process_count_max': max(s['process_count'] for s in samples),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--pid', required=True, type=int, help='Root browser PID, not a renderer PID')
    parser.add_argument('--profile', required=True, help='Absolute path to dedicated --user-data-dir')
    parser.add_argument('--mode', choices=['baseline', 'native', 'extension', 'lean'], required=True)
    parser.add_argument('--scenario', choices=['five', 'twenty'], required=True)
    parser.add_argument('--repeat', type=int, choices=[1, 2, 3], required=True)
    parser.add_argument('--experiment', required=True, help='Same ID for all comparable runs')
    parser.add_argument('--conditions', required=True, help='Power, site suite revision, extensions/versions, settings')
    parser.add_argument('--duration', type=float, default=60)
    parser.add_argument('--interval', type=float, default=5)
    parser.add_argument('--restore-latency-ms', type=float, action='append', default=[])
    parser.add_argument('--app', default='/Applications/Google Chrome.app')
    parser.add_argument('--output', help='JSON output path (must not exist)')
    args = parser.parse_args()
    if platform.system() != 'Darwin':
        parser.error('This collector measures macOS only.')
    if args.duration < args.interval or args.interval < 1:
        parser.error('duration >= interval >= 1 required')
    if any(value < 0 for value in args.restore_latency_ms):
        parser.error('Restore latency must be nonnegative.')
    table = process_table()
    root = table.get(args.pid)
    if not root or not matches_profile(root['command'], args.profile) or '--type=' in root['command']:
        parser.error('PID must be a browser root launched with the exact dedicated --user-data-dir.')
    # No personal profile paths, tab URLs, or command lines are written to the results.
    samples = []
    started = dt.datetime.now(dt.timezone.utc).isoformat()
    deadline = time.monotonic() + args.duration
    while True:
        table = process_table()
        if args.pid not in table or table[args.pid]['command'] != root['command']:
            raise RuntimeError('Browser exited or PID was reused; incomplete run is not written.')
        ids = tree_ids(table, args.pid)
        samples.append({
            'time': dt.datetime.now(dt.timezone.utc).isoformat(),
            'rss_mib': sum(table[pid]['rss_kib'] for pid in ids) / 1024,
            'cpu_percent': sum(table[pid]['cpu_percent'] for pid in ids),
            'swap_mib': swap_used_mib(), 'process_count': len(ids),
        })
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        time.sleep(min(args.interval, remaining))
    result = {
        'schema': 1, 'experiment': args.experiment, 'mode': args.mode, 'scenario': args.scenario,
        'repeat': args.repeat, 'browser_version': browser_version(args.app),
        'machine': platform.machine(), 'macos': platform.mac_ver()[0], 'conditions': args.conditions,
        'started_at': started, 'duration_seconds': args.duration, 'interval_seconds': args.interval,
        'memory_method': 'sum_process_tree_rss_mib', 'cpu_method': 'sum_ps_percent_cpu',
        'restore_latency_ms': args.restore_latency_ms, 'samples': samples, 'summary': summarize(samples),
    }
    stamp = dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    output = pathlib.Path(args.output or f'artifacts/metrics/{args.scenario}-{args.mode}-{args.repeat}-{stamp}.json')
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open('x') as file:
        json.dump(result, file, indent=2)
    print(f'Saved {len(samples)} samples → {output}')


if __name__ == '__main__':
    main()
