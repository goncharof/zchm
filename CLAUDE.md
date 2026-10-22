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
- `docs/BOOK_STRUCTURE.md` — как устроена Книга Жизни и как её размечать для ИИ- и сценарного ведущего; `docs/book-review/` — найденные ошибки разметки по главам.
- `docs/DEPLOY.md` — как вывести игру в сеть: туннель на вечер, VPS с Docker, Fly.io; переменные окружения.

## Стек
Фронтенд: Vue 3 + Vite + TypeScript + Pinia + vue-router (hash-режим); одиночная игра работает без сервера
(localStorage, экспорт/импорт JSON, PWA). Сетевая игра: сервер Node.js + socket.io в `server/`, игровая
логика общая (`src/game/session.ts`), ведущий — цепочка моделей (бесплатные через OpenAI-совместимый API,
Claude через `@anthropic-ai/sdk`) с запасным сценарным ведущим без ИИ. Тесты — Vitest.
Пакетный менеджер — pnpm.

## Команды
```bash
pnpm dev            # dev-сервер
pnpm test           # тесты движка (tests/**/*.test.ts)
pnpm typecheck      # vue-tsc --noEmit
pnpm build          # typecheck + vite build → dist/
pnpm server         # сервер сетевой игры (tsx watch, порт 8787); вместе с pnpm dev — Vite проксирует /socket.io
pnpm build:server && pnpm start   # продакшен: node server-dist/index.js раздаёт dist и сокеты на одном порту
# окружение сервера: PORT, HOST, DATA_DIR (data/rooms), STATIC_DIR (dist); модели ведущего — server/gm/providers.ts
#   (GEMINI_API_KEY, CEREBRAS_API_KEY, OPENROUTER_API_KEY, GROQ_API_KEY, LLM_BASE_URL+LLM_MODEL, ANTHROPIC_API_KEY, GM_CHAIN);
#   без ключей ходы ведёт сценарный ведущий; ключи можно положить в .env.local (KEY=value, не в git и не в Docker)
pnpm exec tsx tools/qa/fake-gm-server.ts   # сервер с демо-ведущим без Claude API (для проверки интерфейса)
node tools/qa/online.mjs                    # при pnpm dev + демо-сервере: два игрока в комнате, скриншоты
tools/fetch_sources.sh   # скачать оцифрованную коробку (120 МБ) в source/pdf и создать tools/.venv
pnpm data:bestiary  # source/pdf → src/data/bestiary.json + public/img/bestiary/*.jpg
pnpm data:book      # → src/data/locations.json + public/img/locations/*.jpg
pnpm data:world     # → src/data/world.json + public/img/map/world.jpg
pnpm data:rules     # → src/data/{classes,weapons,armor,items,artifacts,spells,rules}.json
pnpm data:lore      # → src/data/lore.json (Книга Сумерек)
node tools/qa/screens.mjs [url] [outDir]  # при запущенном pnpm dev: проход по экранам в Chrome, скриншоты desktop/mobile в tools/qa/out, отчёт об ошибках и горизонтальной прокрутке
node tools/qa/offline.mjs [url]           # при pnpm build && pnpm preview --port 5178: проверка игры без сети
pnpm qa:book        # обход Книги Жизни ботом: все пути кнопок + сценарный ведущий → tools/qa/out/book-walk.md (после правки разметки)
```

## Структура
```
source/pdf/      оцифрованные книги (не в git, см. tools/fetch_sources.sh); source/text/ — выгруженный текст (в git)
tools/           Python-скрипты извлечения данных (tools/.venv: pypdfium2, pillow)
src/types.ts     схема всех данных (JSON в src/data должен ей соответствовать)
src/data/        сгенерированные JSON — НЕ править руками, править скрипты в tools/; разметка книги: деревья этапов — tools/book/<локация>.json
                 (docs/BOOK_STRUCTURE.md, раздел 7), точечные правки старой разметки — tools/book_overrides.json
src/engine/      чистая логика без Vue: dice, character, combat, spells, inventory
src/game/        GameSession — все команды партии (общие для браузера и сервера), таблица прав COMMANDS
src/net/         протокол и клиент сетевой игры (socket.io)
server/          сервер сетевой игры и ИИ-ведущий (server/gm)
src/stores/      Pinia: game (партия, сохранения), combat
src/views/       экраны (роутер), src/components/ — переиспользуемые куски
public/img/      картинки (иллюстрации бестиария, планы локаций, карта мира); при их изменении поднять CACHE в public/sw.js
public/sw.js     service worker (офлайн), public/manifest.webmanifest + public/icons — установка как приложение
tests/           Vitest: движок, стор, сквозной прогон приложения в jsdom
tools/qa/        визуальный прогон в Chrome (playwright-core), обход Книги Жизни ботом (book-walk.ts)
docs/            документация проекта
```

## Правила работы
- Язык интерфейса, данных и документации — русский. Код, идентификаторы, коммиты — английский.
- Исходные тексты игры не переписывать «своими словами»: описания монстров, заклинаний, параграфы
  Книги Жизни цитируются как есть (исправляются только явные опечатки OCR).
- Правила реализуются по Инструкции; где текст неполон — выбирается вариант, помечается «ХАУСРУЛ»
  в `docs/RULES.md` и `docs/DECISIONS.md`, а в коде — комментарием `// ХАУСРУЛ:`.
- Движок (`src/engine`) и сессия (`src/game`) не зависят от Vue и от `localStorage`; всё состояние сериализуемо.
- Новая команда партии: метод в `GameSession` + строка в `COMMANDS` (роль) + обёртка в сторе; UI не меняет
  состояние напрямую — только через команды (иначе в сетевой игре изменение увидит один игрок).
- ИИ-ведущий: системный промпт и набор инструментов не менять «на лету» (сломается кэш); история только
  дописывается (исключение — перезапуск длинного разговора с кратким содержанием, `GM_HISTORY_CHARS`);
  механика — только через инструменты.
- Оформление: токены и компоненты — в `src/style.css` (палитра коробки: `--blood`, `--stone`, `--parchment`); заголовки —
  Monomakh, текст Книги — класс `paragraph-text`/`book-text` (Old Standard TT), интерфейс — Inter. Новые экраны
  собирать из существующих классов (`card`, `row`, `cols`, `tabs`, `badge`, кнопки `primary`/`danger`/`small`);
  проверять на 390 и 1280 px и на телефоне в альбомной ориентации (`node tools/qa/screens.mjs`). Подсветку при наведении
  писать внутри `@media (hover: hover)` (на тач-экране она залипает). Картинки бренда — `public/img/brand`.
- Случайность только через `src/engine/dice.ts` (подменяемый генератор, чтобы тесты были детерминированы).
- После заметных изменений обновлять `docs/PROGRESS.md` (что сделано, что дальше) и при необходимости `docs/DECISIONS.md`.
- Коммиты — по скиллу `.claude/skills/commit`: Conventional Commits `type(scope): описание строчными` на английском,
  одно логическое изменение на коммит, **без `Co-Authored-By`**; вариант сообщения 1 («что сделано») без ожидания выбора.

## Лицензия материалов
Тексты и иллюстрации © Багдасаров Ж. Г., ЗАО «Камелот», 1997. Оцифровка П. Немченко, 2020,
с разрешения автора на свободное распространение. Проект некоммерческий, с указанием авторов.
Подробности в `docs/SOURCES.md`.
