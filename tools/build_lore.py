"""Книга Сумерек → src/data/lore.json: главы с текстом (проза склеена, стихи построчно).

Usage: tools/.venv/bin/python -I tools/build_lore.py
"""
import json, os, re, sys
import pypdfium2 as pdfium

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import clean_text, slug

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PDF = os.path.join(ROOT, 'source', 'pdf', 'ZChM Kniga Sumerek.pdf')
OUT = os.path.join(ROOT, 'src', 'data', 'lore.json')

doc = pdfium.PdfDocument(PDF)
# оглавление на стр. 4: строки "Название .... N"
toc_text = clean_text(doc[3].get_textpage().get_text_range())
titles = []
for line in toc_text.splitlines():
    m = re.match(r'^(.+?)\s*\.{3,}\s*(\d+)\s*$', line.strip())
    if m:
        titles.append(m.group(1).strip())
if not titles:
    titles = ['Хроники эпохи Сумерек', 'Крепость рыцарей', 'Город жрецов', 'Крепость короля назгулов',
              'Крепость последней надежды', 'Мертвый город', 'Брошеный город', 'Черные пещеры']

def norm(s):
    return re.sub(r'\s+', ' ', s.strip().lower().replace('ё', 'е'))

title_set = {norm(t): t for t in titles}
chapters = []
current = None
VERSE_MAX = 58

def flush_buffer(buf, out):
    if buf:
        out.append(' '.join(buf))
        buf.clear()

for i in range(5, len(doc) - 1):  # с 6-й страницы, без рекламы на последней
    raw = clean_text(doc[i].get_textpage().get_text_range())
    lines = [l.rstrip() for l in raw.splitlines()]
    lines = [l for l in lines if l.strip()]
    if lines and re.fullmatch(r'\d+', lines[0].strip()):
        lines = lines[1:]  # номер страницы
    if not lines:
        continue
    if norm(lines[0]) in title_set:
        current = {'id': slug(title_set[norm(lines[0])]), 'title': title_set[norm(lines[0])], 'page': i + 1, 'blocks': []}
        chapters.append(current)
        lines = lines[1:]
    if current is None:
        continue
    blocks = current['blocks']
    buf = []
    for n, line in enumerate(lines):
        st = line.strip()
        nxt = lines[n + 1].strip() if n + 1 < len(lines) else ''
        prv = lines[n - 1].strip() if n > 0 else ''
        is_sep = st == '* * *'
        short = len(st) <= VERSE_MAX
        verse = short and (len(nxt) <= VERSE_MAX and nxt != '' or len(prv) <= VERSE_MAX and prv != '') and not st.endswith(('.', '!', '?', '»', '”')) or (short and (nxt and len(nxt) <= VERSE_MAX) and st[:1].isupper() and prv and len(prv) <= VERSE_MAX)
        if is_sep:
            flush_buffer(buf, blocks)
            blocks.append('* * *')
            continue
        if verse:
            flush_buffer(buf, blocks)
            blocks.append('¶' + st)  # маркер стихотворной строки
        else:
            buf.append(st)
            if st.endswith(('.', '!', '?', '»', '”', ':')) and (not nxt or nxt[:1].isupper() or nxt[:1] in '—«“'):
                flush_buffer(buf, blocks)
    flush_buffer(buf, blocks)

# склеить подряд идущие стихотворные строки в один блок с переводами строк
for ch in chapters:
    merged, verse = [], []
    for b in ch['blocks']:
        if b.startswith('¶'):
            verse.append(b[1:])
        else:
            if verse:
                merged.append({'verse': '\n'.join(verse)}); verse = []
            merged.append({'text': b} if b != '* * *' else {'sep': True})
    if verse:
        merged.append({'verse': '\n'.join(verse)})
    ch['blocks'] = merged

with open(OUT, 'w', encoding='utf-8') as w:
    json.dump(chapters, w, ensure_ascii=False, indent=1)
for ch in chapters:
    print(f"{ch['title']:30s} стр. {ch['page']:2d} блоков={len(ch['blocks'])} стихов={sum(1 for b in ch['blocks'] if 'verse' in b)}")
print('->', OUT)
