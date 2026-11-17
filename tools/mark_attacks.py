"""Пометить в ручных деревьях (tools/book/*.json) этапы, где монстры нападают сами: hints.attack = true по глаголам
текста этапа (ATTACK в build_book_of_life.py). Явные true/false не трогаются. Старая разметка получает ту же пометку
при сборке (hints_for). Запуск: tools/.venv/bin/python -I tools/mark_attacks.py, затем pnpm data:book."""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from build_book_of_life import attacks_outright  # noqa: E402

ROOT = os.path.dirname(HERE)
special = {m['id'] for m in json.load(open(os.path.join(ROOT, 'src', 'data', 'bestiary.json'), encoding='utf-8')) if m.get('special')}
total = 0
for f in sorted(os.listdir(os.path.join(HERE, 'book'))):
    if not f.endswith('.json'):
        continue
    path = os.path.join(HERE, 'book', f)
    raw = open(path, encoding='utf-8').read()
    data = json.loads(raw)
    changed = 0
    for key, tree in data.items():
        if key.startswith('_'):
            continue
        stack = [tree]
        while stack:
            n = stack.pop()
            h = n.get('hints') or {}
            if 'attack' not in h and any(m not in special for m in h.get('monsters', [])):
                own = ' '.join([n.get('label') or ''] + [t['t'] for t in n.get('text', [])])
                if attacks_outright(own):
                    h['attack'] = True
                    n['hints'] = h
                    changed += 1
            stack += n.get('then', [])
    if changed:
        open(path, 'w', encoding='utf-8').write(json.dumps(data, ensure_ascii=False, indent=1) + ('\n' if raw.endswith('\n') else ''))
    total += changed
    print(f'{f}: {changed}')
print(f'помечено этапов: {total}')
