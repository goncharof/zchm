# Заклятье Чёрного мага — браузерная версия

Воспроизведение в браузере настольной ролевой игры «Заклятье Чёрного мага» (ЗАО «Камелот», 1997,
автор-составитель Ж. Г. Багдасаров). Формат — «цифровой ведущий»: движок берёт на себя
механику (персонажи, кубики, бой, магия, лавка, опыт), а Книга Жизни подаётся как книга-игра
по локациям. Играть можно без ведущего и с ведущим (режим ведущего прячет текст параграфов).

## Где что лежит (читать в первую очередь)
- `docs/PROGRESS.md` — текущее состояние и следующие шаги. **Начинать сессию отсюда.**
- `docs/DECISIONS.md` — журнал решений (стек, хаусрулы, трактовки правил). Новые решения дописывать туда.
- `docs/ARCHITECTURE.md` — модули, поток данных, форма состояния.
- `docs/RULES.md` — конспект правил игры со ссылками на страницы Инструкции и список неоднозначностей.
- `docs/SOURCES.md` — происхождение материалов, разрешение автора, что можно и нельзя.

## Стек
Vue 3 + Vite + TypeScript + Pinia + vue-router (hash-режим). Бэкенда нет: статическая сборка,
сохранения в localStorage + экспорт/импорт JSON. Тесты движка — Vitest. Пакетный менеджер — pnpm.

## Команды
```bash
pnpm dev            # dev-сервер
pnpm test           # тесты движка (tests/**/*.test.ts)
pnpm typecheck      # vue-tsc --noEmit
pnpm build          # typecheck + vite build → dist/
tools/fetch_sources.sh   # скачать оцифрованную коробку (120 МБ) в source/pdf и создать tools/.venv
pnpm data:bestiary  # source/pdf → src/data/bestiary.json + public/img/bestiary/*.jpg
pnpm data:book      # → src/data/locations.json + public/img/locations/*.jpg
pnpm data:world     # → src/data/world.json + public/img/map/world.jpg
pnpm data:rules     # → src/data/{classes,weapons,armor,items,artifacts,spells,rules}.json
pnpm data:lore      # → src/data/lore.json (Книга Сумерек)
node tools/qa/screens.mjs [url] [outDir]  # при запущенном pnpm dev: проход по экранам в Chrome, скриншоты desktop/mobile в tools/qa/out, отчёт об ошибках и горизонтальной прокрутке
node tools/qa/offline.mjs [url]           # при pnpm build && pnpm preview --port 5178: проверка игры без сети
```

## Структура
```
source/pdf/      оцифрованные книги (не в git, см. tools/fetch_sources.sh); source/text/ — выгруженный текст (в git)
tools/           Python-скрипты извлечения данных (tools/.venv: pypdfium2, pillow)
src/types.ts     схема всех данных (JSON в src/data должен ей соответствовать)
src/data/        сгенерированные JSON — НЕ править руками, править скрипты в tools/
src/engine/      чистая логика без Vue: dice, character, combat, spells, inventory
src/stores/      Pinia: game (партия, сохранения), combat
src/views/       экраны (роутер), src/components/ — переиспользуемые куски
public/img/      картинки (иллюстрации бестиария, планы локаций, карта мира); при их изменении поднять CACHE в public/sw.js
public/sw.js     service worker (офлайн), public/manifest.webmanifest + public/icons — установка как приложение
tests/           Vitest: движок, стор, сквозной прогон приложения в jsdom
tools/qa/        визуальный прогон в Chrome (playwright-core)
docs/            документация проекта
```

## Правила работы
- Язык интерфейса, данных и документации — русский. Код, идентификаторы, коммиты — английский.
- Исходные тексты игры не переписывать «своими словами»: описания монстров, заклинаний, параграфы
  Книги Жизни цитируются как есть (исправляются только явные опечатки OCR).
- Правила реализуются по Инструкции; где текст неполон — выбирается вариант, помечается «ХАУСРУЛ»
  в `docs/RULES.md` и `docs/DECISIONS.md`, а в коде — комментарием `// ХАУСРУЛ:`.
- Движок (`src/engine`) не зависит от Vue и от `localStorage`; всё состояние сериализуемо.
- Случайность только через `src/engine/dice.ts` (подменяемый генератор, чтобы тесты были детерминированы).
- После заметных изменений обновлять `docs/PROGRESS.md` (что сделано, что дальше) и при необходимости `docs/DECISIONS.md`.
- Коммиты небольшие, сообщения на английском; заканчивать строкой `Co-Authored-By:` с текущей моделью Claude (например, `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`).

## Лицензия материалов
Тексты и иллюстрации © Багдасаров Ж. Г., ЗАО «Камелот», 1997. Оцифровка П. Немченко, 2020,
с разрешения автора на свободное распространение. Проект некоммерческий, с указанием авторов.
Подробности в `docs/SOURCES.md`.
