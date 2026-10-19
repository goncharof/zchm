"""Parse the Bestiary PDF into src/data/bestiary.json and crop each creature's illustration
into public/img/bestiary/<id>.jpg.

Usage: tools/.venv/bin/python -I tools/build_bestiary.py
"""
import json, os, re, sys
import pypdfium2 as pdfium
from PIL import Image, ImageOps, ImageChops

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import slug, clean_text, join_lines

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PDF = os.path.join(ROOT, 'source', 'pdf', 'ZChM Bestiari.pdf')
OUT_JSON = os.path.join(ROOT, 'src', 'data', 'bestiary.json')
OUT_IMG = os.path.join(ROOT, 'public', 'img', 'bestiary')
os.makedirs(os.path.dirname(OUT_JSON), exist_ok=True)
os.makedirs(OUT_IMG, exist_ok=True)

STAT_RE = re.compile(r'^(уровень|атаки|защита|храбрость|мана|жизни|очки)\s*[–—-]\s*(.+)$')
# регистр не важен: у Умертвия «Паралич — 11, окаменение — 16»
EXTRA_RE = re.compile(r'(Окаменение|Оледенение|Паралич|Яд)\s*[–—-]\s*(\d+)', re.IGNORECASE)
# «Атакует дважды», «Атакуют трижды», «дважды за раунд»
MULTI_RE = re.compile(r'Атаку(?:ет|ют)\s+(дважды|трижды)', re.IGNORECASE)
EXTRA_KIND = {'Окаменение': 'petrify', 'Оледенение': 'freeze', 'Паралич': 'paralysis', 'Яд': 'poison'}
SPELLS_RE = re.compile(r'Владе\w+\s+заклинани\w+:\s*([^.]+)\.')
LUCK_RE = re.compile(r'Удача от ([^—–-]+?)\s*[–—-]\s*(\d+)')
SCALE = 1.6
HEAD_WORDS = {'двухголов': 2, 'двуглав': 2, 'трехголов': 3, 'трёхголов': 3, 'треглав': 3, 'семиглав': 7, 'девятиглав': 9}

def parse_value(key, raw):
    raw = raw.strip().rstrip('.')
    if raw in ('нет', '—', '-') and key != 'атаки':
        return None
    if key == 'атаки':
        if raw == 'смерть':
            return 'death'
        if raw == 'магия':
            return 'magic'   # бьёт только заклинаниями
        if raw == 'нет':
            return 'none'
        nums = [int(x) for x in re.findall(r'\d+', raw)]
        if len(nums) == 3:
            # в книге «1-2-3»: трактуем как 1-1-2-2-3-3 (ХАУСРУЛ)
            return [nums[0], nums[0], nums[1], nums[1], nums[2], nums[2]]
        return nums if len(nums) == 6 else raw
    m = re.match(r'^\d+$', raw)
    return int(raw) if m else raw

def crop_illustration(page, textpage, img_path):
    W, H = page.get_size()
    rects = [textpage.get_rect(i) for i in range(textpage.count_rects())]
    # header block = text in the upper third, description = text in the lower half
    header = [r for r in rects if r[1] > H * 0.62]
    desc = [r for r in rects if r[3] < H * 0.55 and (r[2] - r[0]) > 40]
    top_pdf = min(r[1] for r in header) - 6 if header else H - 120
    bottom_pdf = max(r[3] for r in desc) + 6 if desc else 100
    bitmap = page.render(scale=SCALE).to_pil().convert('RGB')
    y0 = int((H - top_pdf) * SCALE); y1 = int((H - bottom_pdf) * SCALE)
    region = bitmap.crop((0, max(0, y0), bitmap.width, min(bitmap.height, y1)))
    # trim white margins
    gray = ImageOps.autocontrast(region.convert('L'))
    mask = gray.point(lambda v: 255 if v < 225 else 0)
    bbox = mask.getbbox()
    if bbox:
        pad = 12
        region = region.crop((max(0, bbox[0] - pad), max(0, bbox[1] - pad),
                              min(region.width, bbox[2] + pad), min(region.height, bbox[3] + pad)))
    if region.width > 900:
        region = region.resize((900, int(region.height * 900 / region.width)), Image.LANCZOS)
    region.save(img_path, 'JPEG', quality=82, optimize=True)
    return region.size

doc = pdfium.PdfDocument(PDF)
monsters = []
for i in range(2, len(doc) - 1):  # skip cover (p1), credits (p2) and back page (p100)
    page = doc[i]
    tp = page.get_textpage()
    raw = clean_text(tp.get_text_range())
    lines = [l.strip() for l in raw.splitlines() if l.strip()]
    if not lines:
        continue
    name = lines[0].strip()
    if re.fullmatch(r'\d+', lines[-1]):
        lines = lines[:-1]  # trailing page number
    stats, desc_lines = {}, []
    for l in lines[1:]:
        m = STAT_RE.match(l)
        if m and not desc_lines:
            stats[m.group(1)] = parse_value(m.group(1), m.group(2))
        else:
            desc_lines.append(l)
    description = join_lines(desc_lines)
    entry = {
        'id': slug(name),
        'name': name,
        'page': i + 1,
    }
    if 'уровень' in stats: entry['level'] = stats['уровень']
    if 'атаки' in stats and stats['атаки'] is not None: entry['attacks'] = stats['атаки']
    for k, key in (('защита', 'defense'), ('храбрость', 'courage'), ('мана', 'mana'), ('жизни', 'lives'), ('очки', 'points')):
        if k in stats and stats[k] is not None:
            entry[key] = stats[k]
    extras = [{'kind': EXTRA_KIND[k.capitalize()], 'threshold': int(v)} for k, v in EXTRA_RE.findall(description)]
    if extras: entry['extraAttacks'] = extras
    m = MULTI_RE.search(description)
    if m: entry['attacksPerRound'] = 2 if m.group(1).lower() == 'дважды' else 3
    m = SPELLS_RE.search(description)
    if m:
        entry['spells'] = [s.strip() for s in re.split(r',\s*', m.group(1)) if s.strip()]
    m = LUCK_RE.search(description)
    if m:
        entry['luckSave'] = {'against': m.group(1).strip(), 'threshold': int(m.group(2))}
    # многоголовые: «жизни – 8 у головы», число голов — из описания («Двухголовый», «Девятиглавое»)
    if isinstance(entry.get('lives'), str):
        m = re.match(r'(\d+)', entry['lives'])
        heads = None
        for word, n in HEAD_WORDS.items():
            if re.search(word, description, re.IGNORECASE):
                heads = n
                break
        if m and heads:
            entry['livesPerHead'] = int(m.group(1))
            entry['heads'] = heads
            entry['lives'] = int(m.group(1)) * heads
            if re.search(r'вырастает новая голова', description):
                entry['regrows'] = True  # отрубленные головы отрастают (Гидра)
    if 'level' not in entry:
        entry['special'] = True
    entry['description'] = description
    img_name = f"{entry['id']}.jpg"
    size = crop_illustration(page, tp, os.path.join(OUT_IMG, img_name))
    entry['image'] = f'img/bestiary/{img_name}'
    monsters.append(entry)
    print(f"p{i+1:03d} {name:28s} lvl={entry.get('level','-'):>3} img={size}")

with open(OUT_JSON, 'w', encoding='utf-8') as w:
    json.dump(monsters, w, ensure_ascii=False, indent=1)
print(f"\n{len(monsters)} entries -> {OUT_JSON}")
