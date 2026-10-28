#!/usr/bin/env python3
"""Summarize per-phase Chrome GPU memory traces; don't sum overlapping allocators."""
import json
import pathlib
import statistics

root = pathlib.Path('artifacts/graphics-memory')
rows = []
for path in sorted(root.glob('result-*.json')):
    result = json.loads(path.read_text())
    if not result.get('traceMethod'):
        continue  # Pilot traces used a different tracing configuration.
    phases = {}
    for phase in result['phases']:
        trace = json.loads((root / ('trace-' + result['run'] + '-' + phase['name'] + '.json')).read_text())
        allocators = {}
        dump_count = 0
        for event in trace['traceEvents']:
            if event.get('pid') != phase['gpuPid']:
                continue
            found = event.get('args', {}).get('dumps', {}).get('allocators', {})
            if found:
                dump_count += 1
                allocators.update(found)
        if not dump_count or 'gpu/shared_images' not in allocators:
            raise RuntimeError('Missing GPU allocators: ' + str(path) + ':' + phase['name'])

        def size(name, attribute='size'):
            value = allocators.get(name, {}).get('attrs', {}).get(attribute, {}).get('value', '0')
            return int(value, 16) / 1048576

        # Prefer the highest ancestor carrying a purgeable_size to avoid duplicates.
        purgeable_names = sorted(name for name, row in allocators.items()
                                 if name.startswith('skia/gpu_resources')
                                 and 'purgeable_size' in row.get('attrs', {}))
        selected = []
        for name in purgeable_names:
            if not any(name.startswith(parent + '/') for parent in selected):
                selected.append(name)
        phases[phase['name']] = {
            'gpu_footprint_mib': phase['gpuFootprintBytes'] / 1048576,
            'browser_tree_footprint_mib': phase['totalFootprintBytes'] / 1048576,
            'skia_gpu_size_mib': size('skia/gpu_resources'),
            'skia_gpu_purgeable_mib': sum(size(name, 'purgeable_size') for name in selected),
            'shared_images_size_mib': size('gpu/shared_images'),
            'shared_images_purgeable_mib': size('gpu/shared_images', 'purgeable_size'),
            'angle_size_mib': size('gpu/angle'), 'dawn_size_mib': size('gpu/dawn'),
            'gpu_dump_events': dump_count,
        }
    before = phases['hidden-control']['gpu_footprint_mib']
    after = phases['critical']['gpu_footprint_mib']
    rows.append({'run': result['run'], 'mode': result['mode'], 'phases': phases,
                 'natural_gpu_reduction_mib': phases['visible']['gpu_footprint_mib'] - before,
                 'additional_gpu_reduction_mib': before - after,
                 'restore_two_frames_ms': result['restoreTwoFramesMs'],
                 'state_checks_passed': result['mainNavigations'] == 1 and result['after']['contextLosses'] == 0})

groups = {}
for mode in ['pressure', 'control']:
    members = [r for r in rows if r['mode'] == mode]
    if not members:
        continue
    values = [r['additional_gpu_reduction_mib'] for r in members]
    groups[mode] = {'runs': len(members), 'additional_gpu_reduction_mean_mib': statistics.mean(values),
                    'additional_gpu_reduction_range_mib': [min(values), max(values)],
                    'natural_gpu_reduction_mean_mib': statistics.mean(r['natural_gpu_reduction_mib'] for r in members),
                    'all_state_checks_passed': all(r['state_checks_passed'] for r in members)}
summary = {'groups': groups, 'runs': rows,
           'limitations': ['Synthetic fixture, not a measurement of reclaimable memory in personal tabs.',
                          'Pressure notification affects the entire isolated browser, not only GPU.',
                          'Allocator categories overlap; they must not be added to footprint.',
                          'No claim of CPU or user-perceived latency improvement.']}
if set(groups) == {'pressure', 'control'}:
    summary['control_adjusted_extra_gpu_reduction_mean_mib'] = (
        groups['pressure']['additional_gpu_reduction_mean_mib'] -
        groups['control']['additional_gpu_reduction_mean_mib'])
(root / 'summary.json').write_text(json.dumps(summary, indent=2))
print(json.dumps({'groups': groups, 'runs': [{'run': r['run'], 'mode': r['mode'],
      'natural_gpu_reduction_mib': r['natural_gpu_reduction_mib'],
      'additional_gpu_reduction_mib': r['additional_gpu_reduction_mib']} for r in rows]}, indent=2))
