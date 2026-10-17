"""Build src/data/world.json (WorldMap: nodes + road edges) and public/img/map/world.jpg
from the digitized world map «ZChM Karta mira.jpg».

Usage: tools/.venv/bin/python -I tools/build_world.py

Node coordinates are fractions (0..1) of the image width/height, read off the scan by eye
(±0.01). Roads are the black lines; the red crosses on them are the cells the party moves
through (1 cell per day, 2 on horseback). For every edge `cells` = number of red crosses
strictly BETWEEN the two end nodes, so travel time in days = cells + 1. A cross standing
right next to a location icon counts as that location's own cell, not as an intermediate one.
Junction nodes (id starts with `j-`) have no locationId; they are road forks and are also
cells (a cross is painted at each of them). Counts are visual estimates from the scan and may
be off by one on the long coastal road.
"""
import json, os, sys
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import slug

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'source', 'pdf', 'ZChM Karta mira.jpg')
OUT_IMG_DIR = os.path.join(ROOT, 'public', 'img', 'map')
OUT_IMG = os.path.join(OUT_IMG_DIR, 'world.jpg')
OUT_JSON = os.path.join(ROOT, 'src', 'data', 'world.json')
LOCATIONS = os.path.join(ROOT, 'src', 'data', 'locations.json')
os.makedirs(OUT_IMG_DIR, exist_ok=True)

# (map label, chapter name in «Книга Жизни» or None for junctions, x, y)
NODES = [
    ('Замок Чёрного мага',          'Замок Черного мага',          0.105, 0.845),
    ('Чёрные Пещеры',               'Черные пещеры',               0.210, 0.635),
    ('Мёртвый Город',               'Мертвый город',               0.200, 0.370),
    ('Город Жрецов',                'Замок жрецов',                0.255, 0.200),
    ('Крепость Рыцарей',            'Крепость рыцарей',            0.385, 0.285),
    ('Северный Форт',               'Северный форт',               0.355, 0.550),
    ('Золотой Город',               'Золотой город',               0.470, 0.705),
    ('Брошенный Город',             'Брошенный город',             0.520, 0.405),
    ('Замок Короля назгулов',       'Крепость короля назгулов',    0.610, 0.265),
    ('Лихолесье',                   'Лихолесье',                   0.745, 0.335),
    ('Упокоище',                    'Упокоище',                    0.605, 0.545),
    ('Крепость Последней Надежды',  'Крепость последней надежды',  0.810, 0.680),
    ('Рунное Море',                 'Рунное море',                 0.745, 0.810),
    ('Древние Развалины',           'Древние развалины',           0.940, 0.105),
    # road forks (no location)
    ('j-west',  None, 0.265, 0.605),   # развилка Пещеры / Форт / дорога на север
    ('j-dead',  None, 0.252, 0.410),   # поворот на Мёртвый Город
    ('j-gold',  None, 0.620, 0.740),   # развилка к востоку от Золотого Города
    ('j-grave', None, 0.680, 0.660),   # развилка южнее Упокоища
    ('j-hope',  None, 0.745, 0.635),   # развилка у Крепости Последней Надежды
    ('j-coast', None, 0.885, 0.175),   # развилка на побережье напротив о. Танградор
]

# (from, to, red crosses strictly between the two nodes)
EDGES = [
    ('Замок Чёрного мага', 'Чёрные Пещеры', 3),
    ('Чёрные Пещеры', 'j-west', 0),
    ('j-west', 'Северный Форт', 1),
    ('j-west', 'j-dead', 2),
    ('j-dead', 'Мёртвый Город', 0),
    ('j-dead', 'Город Жрецов', 2),
    ('Город Жрецов', 'Крепость Рыцарей', 2),
    ('Крепость Рыцарей', 'Северный Форт', 4),
    ('Крепость Рыцарей', 'Брошенный Город', 3),
    ('Северный Форт', 'Золотой Город', 2),
    ('Золотой Город', 'j-gold', 2),
    ('j-gold', 'j-grave', 1),
    ('j-gold', 'Рунное Море', 1),
    ('j-grave', 'Упокоище', 1),
    ('Упокоище', 'Брошенный Город', 2),
    ('j-grave', 'j-hope', 1),
    ('j-hope', 'Крепость Последней Надежды', 0),
    ('Крепость Последней Надежды', 'Рунное Море', 1),
    ('j-hope', 'Лихолесье', 2),
    ('Лихолесье', 'Замок Короля назгулов', 1),
    ('Лихолесье', 'j-coast', 3),
    ('j-coast', 'Древние Развалины', 0),
    ('j-coast', 'j-hope', 5),  # длинная прибрежная дорога, оценка
]


def main():
    with open(LOCATIONS, encoding='utf-8') as f:
        loc_ids = {l['name']: l['id'] for l in json.load(f)}

    Image.MAX_IMAGE_PIXELS = None
    im = Image.open(SRC).convert('RGB')
    w = 2400
    im = im.resize((w, round(im.height * w / im.width)), Image.LANCZOS)
    im.save(OUT_IMG, 'JPEG', quality=80, optimize=True)

    nodes, by_name = [], {}
    for label, chapter, x, y in NODES:
        node = {'id': label if label.startswith('j-') else slug(label), 'name': label, 'x': x, 'y': y}
        if label.startswith('j-'):
            node['name'] = 'Перекрёсток'
        if chapter:
            assert chapter in loc_ids, f'нет главы {chapter!r} в locations.json'
            node['locationId'] = loc_ids[chapter]
        nodes.append(node); by_name[label] = node['id']
    edges = [{'from': by_name[a], 'to': by_name[b], 'cells': c} for a, b, c in EDGES]
    world = {'image': 'img/map/world.jpg', 'width': im.width, 'height': im.height,
             'nodes': nodes, 'edges': edges}
    with open(OUT_JSON, 'w', encoding='utf-8') as f:
        json.dump(world, f, ensure_ascii=False, indent=1)
    print(f'map {im.width}x{im.height} -> {OUT_IMG}')
    print(f'{len(nodes)} nodes, {len(edges)} edges -> {OUT_JSON}')
    for n in nodes:
        print(f"  {n['id']:28s} ({n['x']:.3f}, {n['y']:.3f})  {n.get('locationId', '')}")
    for e in edges:
        print(f"  {e['from']:28s} — {e['to']:28s} cells={e['cells']}")


if __name__ == '__main__':
    main()
