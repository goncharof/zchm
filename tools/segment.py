"""Разбор параграфа Книги Жизни на сцену и ветки решений.

Книга смешивает в одном абзаце то, что герои видят, и исходы их решений («Если вы его освобождаете —
он дарит вам (6)…», «Даете — дарит (3)», списки «1 — …» для броска кубика). Для игры без ведущего
параграф делится на сегменты:

    scene  — то, что видно сразу;
    branch — ветка: label (условие) и скрытый исход, который раскрывается по выбору игроков.

Внутри сегмента текст хранится блоками: {'text': ...} или {'roll': [{'values': [1, 2], 'text': ...}, ...]}.
Эвристики (см. HEAD_*): предложение-ветка начинается с «Если/Иначе/А если», с глагола 2-го лица мн. ч.
(«Помогаете…», «Не даете…») и содержит тире, либо это «Ответ:» загадки.
"""
import re

OPEN_Q, CLOSE_Q = '“«„', '”»'
LIST_LINE = re.compile(r'^((?:\d+|б)(?:\s*,\s*(?:\d+|б))*)\s*[—–-]\s+(.*)$')
HEAD_IF = re.compile(r'^(?:А\s+)?Если\b')  # «Иначе …» продолжает текущий сегмент (исход проверки удачи)
HEAD_VERB = re.compile(r'^(?:Не\s+|А\s+)?[А-ЯЁ][а-яё]+(?:ете|ите|етесь|итесь)\b')
HEAD_ANSWER = re.compile(r'^Ответ\s*:\s*')
# глаголы на -ете/-ите, которые в книге встречаются в повествовании, а не как выбор
VERB_STOP = {'Видите', 'Слышите', 'Чувствуете', 'Замечаете', 'Оказываетесь', 'Попадаете', 'Находите', 'Обнаруживаете', 'Понимаете', 'Узнаете', 'Получаете'}
DASH = re.compile(r'\s[—–]\s')


def _closing_after(line):
    """Для каждой позиции: есть ли закрывающая кавычка правее (незакрытые кавычки OCR не учитываются)."""
    has = [False] * (len(line) + 1)
    seen = False
    for i in range(len(line) - 1, -1, -1):
        if line[i] in CLOSE_Q:
            seen = True
        has[i] = seen
    return has


def _is_boundary(line, k):
    n = len(line)
    while k < n and line[k] == ' ':
        k += 1
    return k, (k >= n or line[k].isupper() or line[k].isdigit() or line[k] in OPEN_Q + '"(—–')


def split_sentences(line):
    """Режет строку на предложения, не разрывая прямую речь в кавычках."""
    out, buf, depth, i = [], [], 0, 0
    n = len(line)
    closing = _closing_after(line)
    while i < n:
        ch = line[i]
        buf.append(ch)
        if ch in OPEN_Q:
            if closing[i]:
                depth += 1
        elif ch in CLOSE_Q:
            depth = max(0, depth - 1)
            # «…идти?” Если отказываетесь — …»: предложение кончается на закрывающей кавычке
            prev = line[i - 1] if i > 0 else ''
            if depth == 0 and prev in '.!?…':
                k, ok = _is_boundary(line, i + 1)
                if ok and k < n and line[k] not in '—–':
                    out.append(''.join(buf).strip())
                    buf = []
                    i = k
                    continue
        elif ch == '"':
            depth = 0 if depth else 1
        if ch in '.!?…' and depth == 0:
            # захватить хвост из закрывающих кавычек/скобок/многоточия
            j = i + 1
            while j < n and line[j] in '.!?…)”»':
                buf.append(line[j]); j += 1
            k, ok = _is_boundary(line, j)
            if ok:
                s = ''.join(buf).strip()
                if s:
                    out.append(s)
                buf = []
                i = k
                continue
            i = j
            continue
        i += 1
    s = ''.join(buf).strip()
    if s:
        out.append(s)
    return out


def is_head(s):
    if HEAD_IF.match(s) or HEAD_ANSWER.match(s):
        return True
    m = HEAD_VERB.match(s)
    if m:
        first = re.sub(r'^(?:Не|А)\s+', '', m.group(0))
        if first in VERB_STOP:
            return False
        return bool(DASH.search(s))
    return False


def _dash_split(s):
    """Делит предложение по первому тире вне кавычек."""
    depth = 0
    for i, ch in enumerate(s):
        if ch in OPEN_Q:
            depth += 1
        elif ch in CLOSE_Q:
            depth = max(0, depth - 1)
        elif ch in '—–' and depth == 0 and i > 0 and s[i - 1] == ' ' and i + 1 < len(s) and s[i + 1] == ' ':
            return s[:i].strip(), s[i + 1:].strip()
    return None


SUBORD = {'чтобы', 'что', 'который', 'которая', 'которое', 'которые', 'которых', 'которого', 'и', 'а', 'но', 'или',
          'как', 'когда', 'пока', 'если', 'где', 'куда', 'откуда', 'потому', 'так', 'хотя', 'либо', 'то', 'чем',
          'ни', 'не', 'да', 'даже', 'причем', 'причём', 'будто', 'словно'}
VERBISH = re.compile(r'(?<![а-яё])[а-яё]{2,}(?:ет|ют|ит|ят|ется|ются|ится|ятся|ете|ите|ал|ял|ил|ел|ла|ли|ло|ут|ют)(?![а-яё])')


def _comma_split(s):
    """«Если вы поймали кендера, тот извиняется…»: делит по первой запятой перед главным предложением."""
    depth = 0
    for i, ch in enumerate(s):
        if ch in OPEN_Q:
            depth += 1
        elif ch in CLOSE_Q:
            depth = max(0, depth - 1)
        elif ch == ',' and depth == 0 and 6 < i <= 160:
            rest = s[i + 1:].strip()
            first = re.match(r'[«“"(]?([А-Яа-яЁё-]+)', rest)
            if not first or first.group(1).lower() in SUBORD:
                continue
            if not VERBISH.search(rest.lower()):
                continue
            return s[:i].strip(), _cap(rest)
    return None


def _cap(s):
    return s[:1].upper() + s[1:] if s else s


def split_head(s):
    """(label, outcome) для предложения-ветки."""
    m = HEAD_ANSWER.match(s)
    if m:
        return 'Ответ на загадку', s[m.end():].strip()
    d = _dash_split(s)
    if d and len(d[0]) <= 160:
        label, rest = d
        label = re.sub(r',?\s*то$', '', label).strip()
        return label, _cap(rest)
    m = re.search(r',\s*то\s+', s)
    if m and m.start() <= 160:
        return s[:m.start()].strip(), _cap(s[m.end():].strip())
    c = _comma_split(s)
    if c:
        return c
    if s.endswith(':'):
        return s[:-1].strip(), ''
    return s.rstrip('.'), ''


def parse_values(v):
    return [6 if x.strip() == 'б' else int(x) for x in v.split(',')]


def units(text):
    """Последовательность единиц: ('sent', str) | ('opt', values, str) | ('line', str)."""
    out = []
    for line in text.split('\n'):
        line = line.strip()
        if not line:
            continue
        m = LIST_LINE.match(line)
        if m:
            out.append(('opt', parse_values(m.group(1)), m.group(2).strip()))
        elif re.match(r'^[А-ЯЁ]\s*[—–-]\s', line) or re.match(r'^([А-ЯЁ]\s+){3,}[А-ЯЁ]\s*$', line):
            out.append(('line', line))  # буквенные легенды и сетки — как есть
        else:
            out.extend(('sent', s) for s in split_sentences(line))
    return out


def _add_text(blocks, text, newline=False):
    if not text:
        return
    if blocks and 'text' in blocks[-1]:
        blocks[-1]['text'] += ('\n' if newline else ' ') + text
    else:
        blocks.append({'text': text})


def _add_opt(blocks, values, text):
    if blocks and 'roll' in blocks[-1]:
        blocks[-1]['roll'].append({'values': values, 'text': text})
    else:
        blocks.append({'roll': [{'values': values, 'text': text}]})


def segment(text, hints_for=None):
    """Возвращает список сегментов или None, если в параграфе нет ни веток, ни бросков."""
    segs = [{'kind': 'scene', 'blocks': []}]
    has_branch = has_roll = False
    for u in units(text):
        if u[0] == 'sent' and is_head(u[1]):
            label, outcome = split_head(u[1])
            seg = {'kind': 'branch', 'label': label, 'blocks': []}
            _add_text(seg['blocks'], outcome)
            segs.append(seg)
            has_branch = True
        elif u[0] == 'opt':
            _add_opt(segs[-1]['blocks'], u[1], u[2])
            has_roll = True
        elif u[0] == 'line':
            _add_text(segs[-1]['blocks'], u[1], newline=True)
        else:
            _add_text(segs[-1]['blocks'], u[1])
    if not has_branch and not has_roll:
        return None
    if not segs[0]['blocks']:
        segs.pop(0)
    if hints_for:
        for s in segs:
            parts = [s.get('label', '')]
            for b in s['blocks']:
                parts.append(b.get('text', '') or ' '.join(o['text'] for o in b.get('roll', [])))
            h = hints_for(' '.join(parts))
            if h:
                s['hints'] = h
            for b in s['blocks']:
                for o in b.get('roll', []):
                    oh = hints_for(o['text'])
                    if oh:
                        o['hints'] = oh
    return segs
