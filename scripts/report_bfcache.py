#!/usr/bin/env python3
"""Report BFCache hits, warm history latency and observed process memory deltas."""
import collections
import json
import math
import pathlib
import statistics

root = pathlib.Path('artifacts/bfcache')
rows = []
excluded = []
settled_probes = []
for path in sorted(root.glob('result-*.json'), key=lambda p: int(p.stem.split('-')[-1])):
    data = json.loads(path.read_text())
    incomplete = [{'phase': p['name'], 'errors': p['errors']} for p in data['memory'] if p['errors']]
    if incomplete:
        excluded.append({'run': data['run'], 'mode': data['mode'], 'incomplete': incomplete})
        continue
    phases = {p['name']: p for p in data['memory']}
    if data.get('fixture', {}).get('extraSettleMs', 0):
        settled_probes.append({'run': data['run'], 'mode': data['mode'],
                              'extra_settle_ms': data['fixture']['extraSettleMs'], 'phases': phases,
                              'navigations': data['navigations']})
        continue
    rows.append({'run': data['run'], 'mode': data['mode'], 'phases': phases,
                 'history_increment_mib': phases['history-seven']['footprintMiB'] - phases['one-document']['footprintMiB'],
                 'history_renderer_increment_mib': phases['history-seven']['rendererFootprintMiB'] - phases['one-document']['rendererFootprintMiB'],
                 'after_use_increment_mib': phases['after-history-use']['footprintMiB'] - phases['one-document']['footprintMiB'],
                 'navigations': data['navigations'],
                 'server_requests': len(data['requests']),
                 'footprint_errors': [error for p in data['memory'] for error in p['errors']]})

def stats(values):
    values = sorted(values)
    return {'n': len(values), 'mean': statistics.mean(values), 'median': statistics.median(values),
            'min': values[0], 'max': values[-1], 'p95_nearest_rank': values[math.ceil(.95 * len(values)) - 1]}

groups = {}
for mode in ['default', 'four', 'two', 'off']:
    members = [r for r in rows if r['mode'] == mode]
    if not members:
        continue
    navigations = [n for row in members for n in row['navigations']]
    reasons = collections.Counter(reason['reason'] for n in navigations for group in n['protocolReasons'] for reason in group)
    latency = {}
    for pattern in ['near', 'deep', 'walk-back', 'jump-four-back']:
        matching = [n for n in navigations if (n['pattern'] == pattern or
                    (pattern == 'jump-four-back' and n['pattern'] == 'deep' and n['index'] == 2))]
        latency[pattern] = {'ms': stats([n['commandToPageShowMs'] for n in matching]),
                            'hits': sum(n['persisted'] for n in matching), 'total': len(matching),
                            'same_token': sum(n['sameToken'] for n in matching),
                            'logical_draft_preserved': sum(n['logicalDraftPreserved'] for n in matching),
                            'html_draft_preserved': sum(n['htmlDraftPreserved'] for n in matching),
                            'requests': sum(n['requests'] for n in matching)}
    groups[mode] = {'runs': len(members),
                    'history_footprint_mib': stats([r['phases']['history-seven']['footprintMiB'] for r in members]),
                    'after_use_footprint_mib': stats([r['phases']['after-history-use']['footprintMiB'] for r in members]),
                    'history_increment_mib': stats([r['history_increment_mib'] for r in members]),
                    'history_renderer_increment_mib': stats([r['history_renderer_increment_mib'] for r in members]),
                    'after_use_increment_mib': stats([r['after_use_increment_mib'] for r in members]),
                    'latency': latency, 'not_restored_reasons': dict(reasons),
                    'visibility': dict(collections.Counter(n['visibility'] for n in navigations))}
comparisons = {}
if 'default' in groups:
    for mode in ['four', 'two', 'off']:
        if mode not in groups:
            continue
        comparisons[mode] = {name: groups['default'][name]['mean'] - groups[mode][name]['mean'] for name in [
            'history_footprint_mib', 'after_use_footprint_mib', 'history_increment_mib',
            'history_renderer_increment_mib', 'after_use_increment_mib']}
summary = {'groups': groups, 'settled_probes': settled_probes, 'excluded_incomplete_runs': excluded, 'comparisons_positive_means_reduction_vs_default_mib': comparisons,
           'runs': rows, 'limitations': ['Synthetic warm local history workload',
           'Footprint is not resident RAM and memory deltas are not a direct BFCache allocator counter',
           'PageShow timing excludes subsequent paint; repeated navigations within one run are not independent runs']}
(root / 'summary.json').write_text(json.dumps(summary, indent=2))
print(json.dumps({'groups': groups, 'comparisons': comparisons}, indent=2))
