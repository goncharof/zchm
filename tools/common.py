"""Shared helpers for the data-extraction scripts."""
import re

_TR = {
    'а':'a','б':'b','в':'v','г':'g','д':'d','е':'e','ё':'yo','ж':'zh','з':'z','и':'i','й':'y','к':'k','л':'l','м':'m',
    'н':'n','о':'o','п':'p','р':'r','с':'s','т':'t','у':'u','ф':'f','х':'h','ц':'ts','ч':'ch','ш':'sh','щ':'sch',
    'ъ':'','ы':'y','ь':'','э':'e','ю':'yu','я':'ya',
}

def slug(s: str) -> str:
    s = s.strip().lower().replace('ё', 'е')
    out = ''.join(_TR.get(ch, ch) for ch in s)
    out = re.sub(r'[^a-z0-9]+', '-', out).strip('-')
    return out

def clean_text(s: str) -> str:
    """Remove soft-hyphen artefacts of the OCR layer and normalise whitespace/dashes."""
    s = s.replace('￾', '').replace('­', '').replace('�', '')
    s = s.replace('ˮ', '”').replace('″', '”')
    s = re.sub(r'[ \t]+', ' ', s)
    return s.strip()

def join_lines(lines) -> str:
    """Join wrapped lines of one paragraph into a single string."""
    text = ' '.join(l.strip() for l in lines if l.strip())
    text = re.sub(r'\s+([,.;:!?»”)])', r'\1', text)
    text = re.sub(r'\s{2,}', ' ', text)
    return text.strip()
