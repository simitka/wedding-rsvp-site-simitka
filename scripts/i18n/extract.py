#!/usr/bin/env python3
"""Собирает из index.html все куски текста с кириллицей: текстовые узлы разметки,
значения атрибутов и строковые литералы инлайн-скриптов.

Каждый кусок получает стабильный ключ (sha1 от вида и содержимого) — по нему
build_en.py подставляет английский перевод из translations.json. Ключ зависит
только от содержимого, поэтому правка русского текста ломает сборку явно
(«missing translation»), а не тихо оставляет русский на английской версии.
"""
import hashlib
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CYR = re.compile(r'[А-Яа-яЁё]')


def key(kind: str, text: str) -> str:
    return kind + ':' + hashlib.sha1(text.encode('utf-8')).hexdigest()[:12]


def find_regions(src: str):
    """[(start, end, kind)] содержимого <script>/<style>."""
    out = []
    for m in re.finditer(r'<(script|style)\b[^>]*>(.*?)</\1>', src, re.S | re.I):
        out.append((m.start(2), m.end(2), m.group(1).lower()))
    return out


def scan_markup(src: str, start: int, end: int):
    """Текстовые узлы и значения атрибутов с кириллицей в куске разметки."""
    hits = []
    i = start
    while i < end:
        lt = src.find('<', i)
        if lt < 0 or lt >= end:
            lt = end
        if lt > i:
            hits += split_text(src, i, lt)
        if lt >= end:
            break
        if src.startswith('<!--', lt):
            close = src.find('-->', lt)
            i = end if close < 0 else close + 3
            continue
        gt = tag_end(src, lt)
        hits += scan_attrs(src, lt, gt)
        i = gt
    return hits


def tag_end(src: str, lt: int) -> int:
    """Конец тега с учётом кавычек в значениях атрибутов."""
    i = lt + 1
    q = ''
    while i < len(src):
        c = src[i]
        if q:
            if c == q:
                q = ''
        elif c in '"\'':
            q = c
        elif c == '>':
            return i + 1
        i += 1
    return len(src)


def split_text(src: str, a: int, b: int):
    """Текстовый узел режем по строкам: перевод не должен склеивать вёрстку."""
    out = []
    for m in re.finditer(r'[^\n]+', src[a:b]):
        chunk = m.group(0)
        if not CYR.search(chunk):
            continue
        lead = len(chunk) - len(chunk.lstrip())
        trail = len(chunk) - len(chunk.rstrip())
        s = a + m.start() + lead
        e = a + m.end() - trail
        out.append(('text', s, e, src[s:e]))
    return out


ATTR_RE = re.compile(r'''([:@a-zA-Z_][-.\w:]*)\s*=\s*("([^"]*)"|'([^']*)')''')


def scan_attrs(src: str, lt: int, gt: int):
    out = []
    for m in ATTR_RE.finditer(src, lt, gt):
        val = m.group(3) if m.group(3) is not None else m.group(4)
        if not CYR.search(val):
            continue
        vs = m.start(3) if m.group(3) is not None else m.start(4)
        ve = m.end(3) if m.group(3) is not None else m.end(4)
        out.append(('attr:' + m.group(1), vs, ve, val))
    return out


def scan_js(src: str, start: int, end: int):
    """Строковые литералы с кириллицей; комментарии и regex пропускаем."""
    hits = []
    i = start
    prev = ''  # последний значимый символ (для эвристики regex vs деление)
    while i < end:
        c = src[i]
        two = src[i:i + 2]
        if two == '//':
            nl = src.find('\n', i)
            i = end if nl < 0 else nl
            continue
        if two == '/*':
            close = src.find('*/', i)
            i = end if close < 0 else close + 2
            continue
        if c in '"\'`':
            j = i + 1
            while j < end:
                if src[j] == '\\':
                    j += 2
                    continue
                if src[j] == c:
                    break
                j += 1
            body = src[i + 1:j]
            if CYR.search(body):
                hits.append(('js', i + 1, j, body))
            prev = c
            i = j + 1
            continue
        if c == '/' and (prev == '' or prev in '(,=:[!&|?{};+-*%~^<>'):
            j = i + 1
            cls = False
            while j < end:
                if src[j] == '\\':
                    j += 2
                    continue
                if src[j] == '[':
                    cls = True
                elif src[j] == ']':
                    cls = False
                elif src[j] == '/' and not cls:
                    break
                elif src[j] == '\n':
                    break
                j += 1
            i = j + 1
            prev = '/'
            continue
        if not c.isspace():
            prev = c
        i += 1
    return hits


def scan_css(src: str, start: int, end: int):
    """В CSS переводить нечего кроме строк (content: '...'): комментарии — код."""
    hits = []
    i = start
    while i < end:
        if src.startswith('/*', i):
            close = src.find('*/', i)
            i = end if close < 0 else close + 2
            continue
        c = src[i]
        if c in '"\'':
            j = src.find(c, i + 1)
            if j < 0 or j > end:
                break
            body = src[i + 1:j]
            if CYR.search(body):
                hits.append(('css', i + 1, j, body))
            i = j + 1
            continue
        i += 1
    return hits


def collect(src: str):
    regions = find_regions(src)
    hits = []
    pos = 0
    for a, b, kind in regions:
        hits += scan_markup(src, pos, a)
        if kind == 'script':
            hits += scan_js(src, a, b)
        else:
            hits += scan_css(src, a, b)
        pos = b
    hits += scan_markup(src, pos, len(src))
    hits.sort(key=lambda h: h[1])
    return hits


def main():
    src = (ROOT / 'index.html').read_text(encoding='utf-8')
    hits = collect(src)
    seen = {}
    items = []
    for kind, s, e, text in hits:
        k = key(kind.split(':')[0], text)
        line = src.count('\n', 0, s) + 1
        if k in seen:
            seen[k]['count'] += 1
            seen[k]['lines'].append(line)
            continue
        entry = {'key': k, 'kind': kind, 'lines': [line], 'count': 1, 'ru': text}
        seen[k] = entry
        items.append(entry)
    out = ROOT / 'scripts' / 'i18n' / 'strings.json'
    out.write_text(json.dumps(items, ensure_ascii=False, indent=1), encoding='utf-8')
    total = sum(i['count'] for i in items)
    chars = sum(len(i['ru']) for i in items)
    print(f'{len(items)} unique / {total} occurrences / {chars} chars -> {out}')


if __name__ == '__main__':
    sys.exit(main())
