#!/usr/bin/env python3
"""Собирает index.en.html — английскую версию сайта (URL /en и /en/rsvp).

index.en.html = index.html + перевод текстов из translations.json + структурные
патчи (пути к ассетам, роутинг /en/rsvp, ключи localStorage). Файл генерируемый:
правишь русскую версию или перевод — прогоняешь `python3 scripts/i18n/build_en.py`.

Ключ перевода — сам русский текст (как его вернул extract.py). Значение — строка
либо список строк по числу вхождений (когда один и тот же русский кусок в разных
местах переводится по-разному: буква «и» из имени «НиКита» и союз «и»).
"""
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from extract import CYR, collect  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / 'index.html'
OUT = ROOT / 'index.en.html'
TRANS = Path(__file__).resolve().parent / 'translations.json'

# Структурные патчи. Каждый обязан сработать ровно `count` раз — иначе сборка
# падает: значит русская версия уехала и патч больше не находит своё место.
PATCHES = [
    ('<html lang="ru">', '<html lang="en">', 1),
    # /en/rsvp живёт на два уровня глубины — относительные пути к ассетам там бы
    # ломались, поэтому на английской версии они абсолютные
    ('href="favicon.ico"', 'href="/favicon.ico"', 1),
    # роутинг анкеты: /rsvp → /en/rsvp, возврат на главную → /en
    ("=== '/rsvp'", "=== '/en/rsvp'", 2),
    ("history.pushState({ nuRsvp: 1 }, '', '/rsvp')", "history.pushState({ nuRsvp: 1 }, '', '/en/rsvp')", 1),
    ("history.replaceState({}, '', '/')", "history.replaceState({}, '', '/en')", 1),
    ('href="/rsvp"', 'href="/en/rsvp"', 2),
    # своё состояние: русская и английская версии не пересекаются нигде, включая
    # localStorage (иначе ответы/выбор музыки протекали бы между версиями)
    ("var RS_KEY = 'nu-rsvp-v1';", "var RS_KEY = 'nu-rsvp-en-v1';", 1),
    ("localStorage.setItem('nu-music'", "localStorage.setItem('nu-music-en'", 1),
    # гостевой просмотр: на английской версии пускает и khinkali, и хинкали
    ("var RS_GUEST_WORD = 'khinkali';",
     "var RS_GUEST_WORD = 'khinkali';\n  var RS_GUEST_WORDS = ['khinkali', 'хинкали'];", 1),
    ('function rsvpGuestMode() { return R.word === RS_GUEST_WORD; }',
     'function rsvpGuestMode() { return RS_GUEST_WORDS.indexOf(R.word) >= 0; }', 1),
    ('if (norm === RS_GUEST_WORD) {', 'if (RS_GUEST_WORDS.indexOf(norm) >= 0) {', 1),
]

ASSET_RE = re.compile(r'''(["'(])assets/''')


def escape(kind: str, text: str, src: str, start: int) -> str:
    """Перевод пишем «как читается» — экранирование под кавычку-делимитер тут."""
    if '\\' in text:
        raise SystemExit(f'backslash in translation is not supported: {text!r}')
    quote = src[start - 1]
    if kind == 'js':
        return text.replace(quote, '\\' + quote)
    if kind.startswith('attr'):
        if '&' in text or '<' in text or '>' in text:
            raise SystemExit(f'unsafe attribute translation: {text!r}')
        return text.replace(quote, '&quot;' if quote == '"' else '&#39;')
    return text


def check_markup_text(text: str, ru: str):
    """В текстовых узлах разрешаем только уже знакомые нам сущности."""
    bad = re.sub(r'&(nbsp|amp|lt|gt|quot|#\d+);', '', text)
    if '<' in bad or '>' in bad or '&' in bad:
        raise SystemExit(f'unsafe markup in translation of {ru!r}: {text!r}')


def main():
    src = SRC.read_text(encoding='utf-8')
    trans = json.loads(TRANS.read_text(encoding='utf-8'))
    hits = collect(src)

    missing, used, seen = [], set(), {}
    plan = []
    for kind, s, e, text in hits:
        if text not in trans:
            missing.append(text)
            continue
        used.add(text)
        val = trans[text]
        idx = seen.get(text, 0)
        seen[text] = idx + 1
        if isinstance(val, list):
            if idx >= len(val):
                raise SystemExit(f'not enough variants for {text!r}: {len(val)} < {idx + 1}')
            en = val[idx]
        else:
            en = val
        if kind == 'text':
            check_markup_text(en, text)
        plan.append((s, e, escape(kind, en, src, s)))

    if missing:
        print('MISSING TRANSLATIONS (%d):' % len(missing), file=sys.stderr)
        for t in dict.fromkeys(missing):
            print('  ' + json.dumps(t, ensure_ascii=False), file=sys.stderr)
        return 1
    extra = [t for t in trans if t not in used]
    if extra:
        print('STALE KEYS (%d):' % len(extra), file=sys.stderr)
        for t in extra:
            print('  ' + json.dumps(t, ensure_ascii=False), file=sys.stderr)
        return 1

    out = src
    for s, e, en in sorted(plan, key=lambda p: -p[0]):
        out = out[:s] + en + out[e:]

    for old, new, count in PATCHES:
        got = out.count(old)
        if got != count:
            raise SystemExit(f'patch {old!r}: expected {count} occurrence(s), found {got}')
        out = out.replace(old, new)
    n_assets = len(ASSET_RE.findall(out))
    out = ASSET_RE.sub(lambda m: m.group(1) + '/assets/', out)

    # страховка: кириллица могла остаться только в комментариях (они и на английской
    # версии остаются русскими — это исходники, а не контент)
    leftovers = [t for _, _, _, t in collect(out) if CYR.search(t)]
    # 'хинкали' — второе слово гостевого просмотра, 'е' — нормализация ё→е в rsvpNorm
    leftovers = [t for t in leftovers if t not in ('хинкали', 'е')]
    if leftovers:
        print('CYRILLIC LEFT IN OUTPUT (%d):' % len(leftovers), file=sys.stderr)
        for t in dict.fromkeys(leftovers):
            print('  ' + json.dumps(t, ensure_ascii=False), file=sys.stderr)
        return 1

    OUT.write_text(out, encoding='utf-8')
    print(f'{OUT.name}: {len(plan)} strings translated, {n_assets} asset paths absolutized')
    return 0


if __name__ == '__main__':
    sys.exit(main())
