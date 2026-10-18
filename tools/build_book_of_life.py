"""Parse the GM book («Книга Жизни») into src/data/locations.json and crop each location plan
into public/img/locations/<id>.jpg.

Usage: tools/.venv/bin/python -I tools/build_book_of_life.py

Known quirks of the original book handled here:
- the printed numbering skips 37 in «Северный форт» and 100 in «Дорога»; numbering is kept as printed
  because the location plans refer to the printed room numbers;
- OCR reads the dice result «6 —» as «б —» in a few lists; fixed on the fly;
- dice-result lists («1 — …», «1, 2, 3 — …»), letter legends («С — нападает скелет») and the 6×6 crypt
  grid of «Крепость последней надежды» are kept as separate lines inside the paragraph text.
"""
import json, os, re, sys, statistics
import pypdfium2 as pdfium
from PIL import Image, ImageOps

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import slug, clean_text
from segment import segment, branch_when, _cap

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PDF = os.path.join(ROOT, 'source', 'pdf', 'ZChM Kniga Zhizni.pdf')
BESTIARY = os.path.join(ROOT, 'src', 'data', 'bestiary.json')
OUT_JSON = os.path.join(ROOT, 'src', 'data', 'locations.json')
OUT_IMG = os.path.join(ROOT, 'public', 'img', 'locations')
os.makedirs(os.path.dirname(OUT_JSON), exist_ok=True)
os.makedirs(OUT_IMG, exist_ok=True)

# (name, first page, last page) — 1-based PDF pages; first page of a castle chapter is the plan.
CHAPTERS = [
    ('Золотой город', 5, 10),
    ('Крепость рыцарей', 11, 16),
    ('Замок Черного мага', 17, 19),
    ('Замок жрецов', 20, 24),
    ('Мертвый город', 25, 29),
    ('Крепость короля назгулов', 30, 35),
    ('Крепость последней надежды', 36, 41),
    ('Черные пещеры', 42, 46),
    ('Рунное море', 47, 49),
    ('Лихолесье', 50, 54),
    ('Древние развалины', 55, 60),
    ('Брошенный город', 61, 65),
    ('Северный форт', 66, 70),
    ('Упокоище', 71, 75),
    ('Дорога', 76, 88),
]

# lines that must stay on their own line inside a paragraph («б» = OCR error for 6)
LIST_LINE = re.compile(r'^((\d+|б)(\s*,\s*(\d+|б))*|[А-ЯЁ])\s*[—–-]\s')
GRID_LINE = re.compile(r'^([А-ЯЁ]\s+){3,}[А-ЯЁ]\s*$')
CAPITAL_START = re.compile(r'^[А-ЯЁ]')


def page_lines(tp):
    """Return [(text, x_left, y_top)] for every non-empty line of the page text layer."""
    text = tp.get_text_range()
    pieces, start = [], 0
    for m in re.finditer(r'\r\n|\n', text):
        pieces.append((text[start:m.start()], start)); start = m.end()
    pieces.append((text[start:], start))
    out = []
    for raw, off in pieces:
        if not raw.strip():
            continue
        i = off + (len(raw) - len(raw.lstrip()))
        l, b, r, t = tp.get_charbox(i)
        out.append((raw.rstrip(), l, t))
    return out


def crop_plan(page, img_path, scale=2.0):
    bitmap = page.render(scale=scale).to_pil().convert('RGB')
    gray = ImageOps.autocontrast(bitmap.convert('L'))
    mask = gray.point(lambda v: 255 if v < 225 else 0)
    bbox = mask.getbbox()
    if bbox:
        pad = 16
        bitmap = bitmap.crop((max(0, bbox[0] - pad), max(0, bbox[1] - pad),
                              min(bitmap.width, bbox[2] + pad), min(bitmap.height, bbox[3] + pad)))
    if bitmap.width > 1600:
        bitmap = bitmap.resize((1600, int(bitmap.height * 1600 / bitmap.width)), Image.LANCZOS)
    bitmap.save(img_path, 'JPEG', quality=85, optimize=True)
    return bitmap.size


def parse_chapter(doc, name, first, last, has_plan, issues):
    paragraphs = []   # [{'n': int, 'lines': [str]}]
    expected = 1
    text_pages = range(first + (1 if has_plan else 0), last + 1)
    for pno in text_pages:
        page = doc[pno - 1]
        tp = page.get_textpage()
        lines = page_lines(tp)
        if not lines:
            continue
        # body left margin = most common x among lines that do not start with a digit
        xs = [round(x) for (txt, x, y) in lines if not re.match(r'^\s*\d', txt)]
        body_x = statistics.mode(xs) if xs else 100
        for txt, x, y in lines:
            s = clean_text(txt)
            if not s:
                continue
            # page number (centred bare integer) and repeated chapter heading
            if re.fullmatch(r'\d+', s) and x > 200:
                continue
            if s.lower() == name.lower() and x > body_x + 40:
                continue
            m = re.match(r'^(\d+)\s*(.*)$', s)
            # a paragraph number sits left of the body margin; the original skips a number twice,
            # so accept expected or expected+1 and keep the printed number
            if m and int(m.group(1)) in (expected, expected + 1) and x < body_x - 3:
                n = int(m.group(1))
                if n != expected:
                    issues.append(f'{name} p{pno}: в оригинале пропущен номер {expected} '
                                  f'(после {expected - 1} идёт {n}); нумерация сохранена как в книге')
                paragraphs.append({'n': n, 'lines': []})
                expected = n + 1
                rest = m.group(2).strip()
                if rest:
                    paragraphs[-1]['lines'].append(rest)
                continue
            if m and x < body_x - 3 and int(m.group(1)) != expected:
                issues.append(f'{name} p{pno}: номер {m.group(1)} у левого поля, ожидался {expected}: {s[:60]!r}')
            if not paragraphs:
                issues.append(f'{name} p{pno}: текст до первого параграфа: {s[:60]!r}')
                continue
            paragraphs[-1]['lines'].append(s)

    result = []
    for p in paragraphs:
        text, prev_block = '', False
        for ln in p['lines']:
            ln = re.sub(r'^б(\s*[—–-]\s)', r'6\1', ln)
            block = bool(LIST_LINE.match(ln) or GRID_LINE.match(ln))
            if not text:
                text = ln
            elif block:
                text = text.rstrip() + '\n' + ln
            elif prev_block and CAPITAL_START.match(ln):
                # a sentence starting with a capital right after a list item = new line of prose
                text = text.rstrip() + '\n' + ln
                block = False
            else:
                text = text + ' ' + ln
            prev_block = block or (prev_block and not CAPITAL_START.match(ln))
        text = re.sub(r'[ \t]{2,}', ' ', text)
        text = re.sub(r'\s+([,.;:!?”)])', r'\1', text)
        result.append({'n': p['n'], 'text': text.strip()})
    return result


# ---------------------------------------------------------------- hints
VOWELS = set('аеёиоуыэюяьй')
ADJ_END = ('ый', 'ий', 'ой', 'ая', 'яя', 'ое', 'ее', 'ые', 'ие')
# short names that would produce false positives in lower case: require a capitalised mention
CAPITAL_ONLY = {'Гор', 'Рот', 'Дух', 'Меч', 'Тень', 'Смерть', 'Маги', 'Человек', 'Кром', 'Эльф'}
STEM_OVERRIDE = {'сгусток': 'сгуст', 'лишайник-пожиратель': 'лишайник'}


SHORT_END = r'(?:а|я|у|ю|ом|ем|ой|ей|е|ы|и|ов|ев|ам|ям|ами|ями|ах|ях)?(?![а-яё])'
# короткие основы прилагательных («бел-ый», «черн-ого»): окончания прилагательных, иначе «белый дракон» не узнаётся
ADJ_SHORT_END = r'(?:ый|ий|ой|ая|яя|ое|ее|ые|ие|ого|его|ому|ему|ым|им|ую|юю|ых|их|ыми|ими)(?![а-яё])'


def stem(word):
    w = word.lower().replace('ё', 'е')
    if w in STEM_OVERRIDE:
        return STEM_OVERRIDE[w]
    if len(w) <= 4:
        return w
    if w.endswith(ADJ_END):
        return w[:-2]
    if w[-1] in VOWELS:
        return w[:-1]
    return w


def build_monster_patterns():
    with open(BESTIARY, encoding='utf-8') as f:
        monsters = json.load(f)
    pats = []
    for m in monsters:
        name = m['name'].strip()
        if name in CAPITAL_ONLY:
            base = name[:-1] if name == 'Маги' else name
            pat = re.compile(r'(?<![\w-])' + re.escape(base) + r'\w*')
        elif name.lower() in STEM_OVERRIDE:
            pat = re.compile(r'(?<![\w-])' + re.escape(STEM_OVERRIDE[name.lower()]) + r'\w*', re.IGNORECASE)
        else:
            words = [w for w in re.split(r'[\s-]+', name) if w]
            # короткие основы («огр», «орк», «энт») — только с падежными окончаниями, иначе «огромный» = огр
            def part(w):
                st = stem(w)
                if len(st) > 4:
                    return re.escape(st) + r'\w*'
                return re.escape(st) + (ADJ_SHORT_END if w.lower().endswith(ADJ_END) else SHORT_END)
            parts = [part(w) for w in words]
            pat = re.compile(r'(?<![\w-])' + r'[\s-]+'.join(parts), re.IGNORECASE)
        pats.append((m['id'], pat))
    return pats


OVERRIDES = os.path.join(os.path.dirname(__file__), 'book_overrides.json')


def apply_overrides(locations, issues):
    """Ручные правки разметки (tools/book_overrides.json) поверх эвристик."""
    with open(OVERRIDES, encoding='utf-8') as f:
        data = json.load(f)
    by_id = {l['id']: l for l in locations}
    for key, ov in data.items():
        if key.startswith('_'):
            continue
        loc_id, _, n = key.partition(':')
        p = next((x for x in by_id.get(loc_id, {}).get('paragraphs', []) if x['n'] == int(n or 0)), None)
        if not p:
            issues.append(f'правка {key}: нет такого параграфа')
            continue
        segs = p.get('segments') or []

        def target(name):
            if name == 'paragraph':
                return p
            if name == 'scene':
                return next((g for g in segs if g['kind'] == 'scene'), None)
            # одинаковые условия веток различаются номером: «Если пьете#2» — вторая такая ветка
            m = re.fullmatch(r'(.*)#(\d+)', name)
            label, nth = (m.group(1), int(m.group(2))) if m else (name, 1)
            same = [g for g in segs if g['kind'] == 'branch' and g.get('label') == label]
            return same[nth - 1] if 0 < nth <= len(same) else None

        # разрезать ветку, в которую разметка слила два исхода: куски берутся из её текста дословно
        # (меняются только заглавная буква и точка в конце), подсказки и исход считаются заново
        for name, pieces in ov.get('split', {}).items():
            g = target(name)
            if g is None or g is p or g['kind'] != 'branch' or any('text' not in b for b in g['blocks']):
                issues.append(f'правка {key}: ветку «{name}» не разрезать')
                continue
            norm = lambda x: ' '.join(x.lower().split())
            src = norm(g['label'] + ' — ' + ' '.join(b['text'] for b in g['blocks']))
            missing = [x for piece in pieces for x in (piece['label'], piece['text']) if norm(x) not in src]
            if missing:
                issues.append(f'правка {key}: в ветке «{name}» нет текста «{missing[0]}»')
                continue
            # куски покрывают всю ветку: ни одна фраза книги не пропадает (остаются только знаки и тире между ними)
            rest = src
            for piece in pieces:
                for x in (piece['label'], piece['text']):
                    rest = rest.replace(norm(x), ' ', 1)
            if re.search(r'[^\W\d_]', rest):
                issues.append(f'правка {key}: куски ветки «{name}» теряют текст: «{" ".join(rest.split())[:80]}»')
                continue
            new = []
            for piece in pieces:
                text = _cap(piece['text'].strip())
                if not re.search(r'[.!?…»”:]$', text):
                    text += '.'
                seg = {'kind': 'branch', 'label': _cap(piece['label'].strip()), 'blocks': [{'text': text}]}
                w = branch_when(seg['label'])
                if w:
                    seg['when'] = w
                h = hints_for(seg['label'] + ' — ' + text)
                if h:
                    seg['hints'] = h
                new.append(seg)
            i = segs.index(g)
            segs[i:i + 1] = new
        for name, fields in ov.get('hints', {}).items():
            t = target(name)
            if t is None:
                issues.append(f'правка {key}: не найдено «{name}»')
                continue
            h = t.setdefault('hints', {})
            for k, v in fields.items():
                if v in (None, []):
                    h.pop(k, None)
                else:
                    h[k] = v
            if 'monsterCounts' in h:
                h['monsterCounts'] = {m: c for m, c in h['monsterCounts'].items() if m in h.get('monsters', [])}
                if not h['monsterCounts']:
                    del h['monsterCounts']
            if not h:
                del t['hints']
        # монстры сцены и веток поправлены — общий список параграфа (полный текст, подсказки ИИ-ведущему) собирается
        # из них, если правка не задаёт его сама
        hints_ov = ov.get('hints', {})
        if segs and 'monsters' not in hints_ov.get('paragraph', {}) and any(name != 'paragraph' and 'monsters' in f for name, f in hints_ov.items()):
            union = []
            for g in segs:
                for mon in (g.get('hints') or {}).get('monsters', []):
                    if mon not in union:
                        union.append(mon)
            ph = p.setdefault('hints', {})
            old = ph.get('monsters', [])
            mons = [x for x in old if x in union] + [x for x in union if x not in old]
            if mons:
                ph['monsters'] = mons
            else:
                ph.pop('monsters', None)
            # число монстров — из параграфа, а если там его нет — наибольшее по сегментам («тигры ×2» знает только ветка)
            counts = {x: c for x, c in ph.get('monsterCounts', {}).items() if x in mons}
            for g in segs:
                for x, c in ((g.get('hints') or {}).get('monsterCounts') or {}).items():
                    if x in mons and x not in ph.get('monsterCounts', {}):
                        counts[x] = max(counts.get(x, 0), c)
            if counts:
                ph['monsterCounts'] = counts
            else:
                ph.pop('monsterCounts', None)
            if not ph:
                del p['hints']
        for name, when in ov.get('when', {}).items():
            t = target(name)
            if t is None or t is p:
                issues.append(f'правка {key}: нет ветки «{name}»')
                continue
            if when is None:
                t.pop('when', None)
            else:
                t['when'] = when


MONSTER_PATTERNS = None
# слова перед суммой, означающие плату, а не находку: «за 15 монет», «просит 10 монет», «по 5 монет»
PAY_WORDS = {'за', 'по', 'просит', 'требует', 'мне', 'щель', 'брось', 'бросьте', 'заплатить', 'заплатите', 'плата',
             'одолжить', 'одолжите', 'отдать', 'отдайте', 'дайте', 'дай', 'потребует', 'берет', 'взимает', 'пошлину'}
PAY_PAIRS = ('с вас', 'с каждого', 'на 1', 'играть на', 'сыграть на', 'ставку')
NUM_WORDS = {'два': 2, 'две': 2, 'двое': 2, 'пара': 2, 'пару': 2, 'три': 3, 'трое': 3, 'четыре': 4, 'четверо': 4,
             'пять': 5, 'пятеро': 5, 'шесть': 6, 'шестеро': 6, 'семь': 7, 'семеро': 7, 'восемь': 8, 'девять': 9,
             'десять': 10, 'дюжина': 12}
COUNT_BEFORE = re.compile(r'(?:\(|\b)(\d{1,3}|' + '|'.join(NUM_WORDS) + r')\s+(?:[а-яё-]+\s+){0,2}$', re.IGNORECASE)


def count_before(text, start):
    """Число непосредственно перед упоминанием монстра: «5 пьяных орков», «(19 урук-хайев)», «два гнолла»."""
    m = COUNT_BEFORE.search(text[max(0, start - 40):start])
    if not m:
        return None
    v = m.group(1).lower()
    n = int(v) if v.isdigit() else NUM_WORDS.get(v)
    return n if n and 1 < n <= 40 else None



def hints_for(text):
    global MONSTER_PATTERNS
    if MONSTER_PATTERNS is None:
        MONSTER_PATTERNS = build_monster_patterns()
    h = {}
    luck = []
    for v in re.findall(r'[Уу]дач[аиу]\s*(?:от\s+\S+\s*)?(?:[—–-]\s*)?(\d+)', text):
        if int(v) not in luck:
            luck.append(int(v))
    if luck:
        h['luck'] = luck
    bottles = [int(v) for v in re.findall(r'\((\d)\)', text) if 1 <= int(v) <= 6]
    if bottles:
        h['bottles'] = bottles
    coins, prices = [], []
    for mm in re.finditer(r'(\d+)\s*монет', text):
        words = [w.lower().strip('(,.“”«»:') for w in re.findall(r'\S+', text[max(0, mm.start() - 40):mm.start()])]
        last = words[-1] if words else ''
        pair = ' '.join(words[-2:])
        after = text[mm.end():mm.end() + 12].lower()
        is_price = last in PAY_WORDS or any(p in pair for p in PAY_PAIRS) or 'в долг' in after
        (prices if is_price else coins).append(int(mm.group(1)))
    if coins:
        h['coins'] = coins
    if prices:
        h['prices'] = prices
    # monsters: collect spans, drop matches nested inside a longer match (назгул in «король назгулов»)
    spans = []
    for mid, pat in MONSTER_PATTERNS:
        for mm in pat.finditer(text):
            spans.append((mm.start(), mm.end(), mid))
    spans.sort(key=lambda s: (s[0], -(s[1] - s[0])))
    found, taken, counts = [], [], {}
    for s, e, mid in spans:
        if any(ts <= s and e <= te and (ts, te) != (s, e) for ts, te, _ in taken):
            continue
        taken.append((s, e, mid))
        if mid not in found:
            found.append(mid)
        n = count_before(text, s)
        if n and n > counts.get(mid, 1):
            counts[mid] = n
    if found:
        h['monsters'] = found
    if counts:
        h['monsterCounts'] = counts
    if re.search(r'артефакт', text, re.IGNORECASE):
        h['artifact'] = True
    if re.search(r'\b(таверн|трактир)', text, re.IGNORECASE):
        h['tavern'] = True
    if re.search(r'\b(лавк|торгов(ец|ца|цу|цем)|оружейн\w* лавк)', text, re.IGNORECASE):
        h['shop'] = True
    scrolls = []
    for mm in re.finditer(r'свит\w*(?:\s+с\s+заклинани\w+)?(?:\s+(мага|жреца))?(?:\s+(\d+)\s*уровня)?',
                          text, re.IGNORECASE):
        sc = {}
        if mm.group(1):
            sc['caster'] = 'mage' if mm.group(1).lower().startswith('маг') else 'priest'
        if mm.group(2):
            sc['level'] = int(mm.group(2))
        scrolls.append(sc)
    if scrolls:
        h['scrolls'] = scrolls
    return h or None


def main():
    doc = pdfium.PdfDocument(PDF)
    locations, issues = [], []
    for order, (name, first, last) in enumerate(CHAPTERS, start=1):
        has_plan = name != 'Дорога'
        loc = {'id': slug(name), 'name': name, 'order': order}
        size = None
        if has_plan:
            img = f'{loc["id"]}.jpg'
            size = crop_plan(doc[first - 1], os.path.join(OUT_IMG, img))
            loc['plan'] = f'img/locations/{img}'
        loc['pages'] = [first, last]
        paras = parse_chapter(doc, name, first, last, has_plan, issues)
        for p in paras:
            h = hints_for(p['text'])
            if h:
                p['hints'] = h
            segs = segment(p['text'], hints_for)
            if segs:
                p['segments'] = segs
                # полный текст размеченного параграфа собирается из сегментов (src/game/book.ts) — не храним дважды
                del p['text']
        loc['paragraphs'] = paras
        locations.append(loc)
        ns = [p['n'] for p in paras]
        ok = bool(ns) and ns[0] == 1 and all(b > a for a, b in zip(ns, ns[1:]))
        print(f'{order:2d}. {name:28s} стр. {first:2d}-{last:2d}  параграфов: {len(paras):3d}  '
              f'нумерация {"ok" if ok else "BROKEN"}  план: {size}')
    apply_overrides(locations, issues)
    with open(OUT_JSON, 'w', encoding='utf-8') as w:
        json.dump(locations, w, ensure_ascii=False, indent=1)
    allp = [p for l in locations for p in l['paragraphs']]
    print(f"\nсегменты: {sum(1 for p in allp if p.get('segments'))} параграфов с ветками/бросками из {len(allp)}, "
          f"веток {sum(1 for p in allp for g in p.get('segments', []) if g['kind'] == 'branch')}")
    print(f'\n-> {OUT_JSON}')
    if issues:
        print('\nЗамечания:')
        for i in issues:
            print('  -', i)


if __name__ == '__main__':
    main()
