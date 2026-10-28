#!/usr/bin/env python3
"""Generate a comparison only from complete, matched measurements. Never invent missing runs."""
import argparse
import json
import pathlib
import statistics

MODES = ('baseline', 'native', 'extension')


def compare(runs, scenario):
    selected = [run for run in runs if run['scenario'] == scenario]
    grouped = {mode: [run for run in selected if run['mode'] == mode] for mode in MODES}
    missing = [f'{mode}/{repeat}' for mode in MODES for repeat in (1, 2, 3)
               if sum(run['repeat'] == repeat for run in grouped[mode]) != 1]
    if missing:
        return [f'Неповний набір для `{scenario}`: потрібен рівно один запуск {", ".join(missing)}. Висновок не сформовано.']
    identity = ('experiment', 'browser_version', 'machine', 'macos', 'conditions', 'memory_method',
                'cpu_method', 'duration_seconds', 'interval_seconds')
    if any(len({str(run[key]) for run in selected}) != 1 for key in identity):
        return [f'Умови запусків `{scenario}` не збігаються. Висновок не сформовано.']
    stats = {mode: {
        key: statistics.median(run['summary'][key] for run in grouped[mode])
        for key in ('rss_mib_mean', 'cpu_percent_mean')
    } for mode in MODES}
    lines = ['| Конфігурація | RSS, MiB | CPU, % одного ядра |', '|---|---:|---:|']
    for mode in MODES:
        lines.append(f"| {mode} | {stats[mode]['rss_mib_mean']:.1f} | {stats[mode]['cpu_percent_mean']:.2f} |")
    native_rss = stats['native']['rss_mib_mean']
    if native_rss <= 0:
        return ['Некоректна пам’ять у вимірюваннях; висновок не сформовано.']
    savings = (1 - stats['extension']['rss_mib_mean'] / native_rss) * 100
    cpu_delta = stats['extension']['cpu_percent_mean'] - stats['native']['cpu_percent_mean']
    lines += ['', f'Різниця RSS проти Memory Saver: **{savings:.1f}%**. Різниця CPU: **{cpu_delta:+.2f} п.п.**']
    if scenario == 'twenty':
        passed = savings >= 15 and cpu_delta <= 5
        lines += [f'Числові критерії: **{"досягнуто" if passed else "не досягнуто"}**. Без перевірок збереження роботи це не є дозволом переходити до форку.']
    latencies = [value for run in selected for value in run.get('restore_latency_ms', [])]
    if not latencies:
        lines.append('Час повернення до вкладок не виміряно.')
    else:
        for mode in MODES:
            values = [v for run in grouped[mode] for v in run.get('restore_latency_ms', [])]
            lines.append(f'Повернення, {mode}: ' + (f'медіана {statistics.median(values):.0f} мс.' if values else 'не виміряно.'))
    lines += ['', 'Swap системний: див. початок/кінець кожного JSON; його не можна приписувати лише браузеру.']
    return lines


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory', nargs='?', default='artifacts/metrics')
    parser.add_argument('--experiment', required=True)
    parser.add_argument('--output', default='artifacts/benchmark-report.md')
    args = parser.parse_args()
    runs = []
    for path in pathlib.Path(args.directory).glob('*.json'):
        run = json.loads(path.read_text())
        if run.get('experiment') == args.experiment:
            if run.get('schema') != 1:
                raise ValueError(f'Unsupported metric schema: {path}')
            runs.append(run)
    lines = ['# Вимірювання Browser Lab', '', f'Експеримент: `{args.experiment}`.', '',
             'Метод: сума RSS дерева процесів. Спільні сторінки можуть рахуватися кілька разів; це порівняльний показник, не унікальна фізична пам’ять. CPU — оцінка `ps`, не точний енергетичний профіль.', '']
    for scenario in ('five', 'twenty'):
        lines += [f'## Сценарій {scenario}', '', *compare(runs, scenario), '']
    output = pathlib.Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text('\n'.join(lines))
    print(f'Wrote {output}')


if __name__ == '__main__':
    main()
