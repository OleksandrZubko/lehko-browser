#!/usr/bin/env python3
"""Report controlled page-preloading experiments; exclude incompatible pilots."""
import collections
import json
import math
import pathlib
import statistics

root = pathlib.Path('artifacts/preloading')
rows, excluded = [], []

def stats(values):
    values = sorted(values)
    return {'n': len(values), 'mean': statistics.mean(values), 'median': statistics.median(values),
            'min': values[0], 'max': values[-1], 'p95_nearest_rank': values[math.ceil(.95 * len(values))-1]}

for path in sorted(root.glob('result-*.json'), key=lambda p: int(p.stem.split('-')[-1])):
    result = json.loads(path.read_text())
    if result.get('measurementProtocol') != 'headless-tab-cdp-v6':
        excluded.append({'run': result['run'], 'reason': 'Pilot protocol with different instrumentation/background conditions'})
        continue
    memory = {p['name']: p for p in result['memory']}
    renderer_memory = {}
    for name, sample in memory.items():
        ids = {p['id'] for p in sample['processInfo'] if p['type']=='renderer'}
        footprint = json.loads(pathlib.Path(sample['attempts'][-1]['path']).read_text())
        renderer_memory[name] = sum(p['footprint']/1048576 for p in footprint['processes'] if p['pid'] in ids)
    cpu = {p['name']: p for p in result['cpu']}
    per_role = {}
    for name in ['preparation', 'follow-through']:
        window = cpu[name]
        initial = {p['id']: p['cpuTime'] for p in window['initial']}
        latest = {p['id']: p for p in window['initial']}
        for sample in window['samples']:
            latest.update({p['id']: p for p in sample['processInfo']})
        latest.update({p['id']: p for p in window['final']})
        roles = collections.defaultdict(float)
        for pid, process in latest.items():
            roles[process['type']] += max(0, process['cpuTime']-initial.get(pid, 0))
        per_role[name] = dict(roles)
    before = result['beforeClick']
    statuses = [e for e in result['events'] if e['name'].endswith('StatusUpdated')]
    rows.append({'run': result['run'], 'action': result['action'], 'mode': result['mode'],
                 'source_footprint_mib': memory['source']['footprintMiB'],
                 'prepared_footprint_mib': memory['prepared-not-opened']['footprintMiB'],
                 'prepared_delta_mib': memory['prepared-not-opened']['footprintMiB']-memory['source']['footprintMiB'],
                 'prepared_renderer_delta_mib': renderer_memory['prepared-not-opened']-renderer_memory['source'],
                 'opened_footprint_mib': memory['destination-opened']['footprintMiB'],
                 'preparation_cpu_seconds': cpu['preparation']['cpuSeconds'],
                 'preparation_mean_percent_one_core': cpu['preparation']['meanPercentOneCore'],
                 'follow_cpu_seconds': cpu['follow-through']['cpuSeconds'],
                 'combined_cpu_seconds': cpu['preparation']['cpuSeconds']+cpu['follow-through']['cpuSeconds'],
                 'cpu_by_role': per_role,
                 'click_to_app_ready_ms': result['clickToAppReadyMs'],
                 'prerender_activated': result['arrival']['activationStart'] > 0,
                 'source_visibility': before['source']['visibility'],
                 'speculative_target_requests': [r for r in before['requests'] if r['path']=='/target'],
                 'bootstrap_requests_before_click': sum(r['path']=='/bootstrap.js' for r in before['requests']),
                 'fixture_body_bytes_before_click': sum(r['bytes'] for r in before['requests'] if r['path'] not in ['/source', '/favicon.ico']),
                 'preload_statuses': statuses})

groups, comparisons, pairs = {}, {}, {}
metrics = ['prepared_footprint_mib','prepared_delta_mib','prepared_renderer_delta_mib','opened_footprint_mib',
           'preparation_cpu_seconds','preparation_mean_percent_one_core','follow_cpu_seconds',
           'combined_cpu_seconds','click_to_app_ready_ms','fixture_body_bytes_before_click']
for action in ['prefetch','prerender']:
    for mode in ['on','off']:
        members = [r for r in rows if r['action']==action and r['mode']==mode]
        if not members:
            continue
        group = {'runs': len(members), **{metric: stats([r[metric] for r in members]) for metric in metrics},
                 'activated_runs': sum(r['prerender_activated'] for r in members),
                 'sources_visible': sum(r['source_visibility']=='visible' for r in members),
                 'speculative_request_runs': sum(bool(r['speculative_target_requests']) for r in members),
                 'bootstrap_before_click_runs': sum(bool(r['bootstrap_requests_before_click']) for r in members),
                 'renderer_preparation_cpu_seconds': stats([r['cpu_by_role']['preparation'].get('renderer',0) for r in members]),
                 'unzip_preparation_cpu_seconds': stats([r['cpu_by_role']['preparation'].get('unzip.mojom.Unzipper',0) for r in members])}
        groups[action+'-'+mode] = group
    on, off = groups.get(action+'-on'), groups.get(action+'-off')
    if on and off:
        on_rows = [r for r in rows if r['action']==action and r['mode']=='on']
        off_rows = [r for r in rows if r['action']==action and r['mode']=='off']
        pairs[action] = [{'on_run': a['run'], 'off_run': b['run'],
                          'prepared_delta_reduction_when_off_mib': a['prepared_delta_mib']-b['prepared_delta_mib'],
                          'preparation_cpu_reduction_when_off_seconds': a['preparation_cpu_seconds']-b['preparation_cpu_seconds'],
                          'combined_cpu_reduction_when_off_seconds': a['combined_cpu_seconds']-b['combined_cpu_seconds']}
                         for a,b in zip(on_rows,off_rows)]
        comparisons[action] = {
            'memory_prepared_reduction_when_off_mib': on['prepared_footprint_mib']['mean']-off['prepared_footprint_mib']['mean'],
            'memory_delta_reduction_when_off_mib': on['prepared_delta_mib']['mean']-off['prepared_delta_mib']['mean'],
            'renderer_memory_delta_reduction_when_off_mib': on['prepared_renderer_delta_mib']['mean']-off['prepared_renderer_delta_mib']['mean'],
            'cpu_preparation_reduction_when_off_seconds': on['preparation_cpu_seconds']['mean']-off['preparation_cpu_seconds']['mean'],
            'renderer_cpu_preparation_reduction_when_off_seconds': on['renderer_preparation_cpu_seconds']['mean']-off['renderer_preparation_cpu_seconds']['mean'],
            'cpu_combined_reduction_when_off_seconds': on['combined_cpu_seconds']['mean']-off['combined_cpu_seconds']['mean'],
            'click_latency_increase_when_off_ms': off['click_to_app_ready_ms']['median']-on['click_to_app_ready_ms']['median'],
        }
summary = {'groups': groups, 'comparisons': comparisons, 'paired_changes': pairs, 'runs': rows, 'excluded_pilots': excluded,
           'limitations': ['Synthetic single-candidate workload; no extrapolation to every site/tab',
                          'Preparation is measured before a later click, not a separate never-clicked run',
                          'OS CPU samples may miss tail work of short-lived processes; background tasks remain visible',
                          'Application-ready excludes final paint; footprint includes compressed/swapped memory']}
(root/'summary.json').write_text(json.dumps(summary, indent=2))
print(json.dumps({'groups': groups, 'comparisons': comparisons, 'excluded': excluded}, indent=2))
