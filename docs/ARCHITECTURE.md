# Архитектура

## Слои
```
source/pdf ──(tools/*.py)──► src/data/*.json + public/img/**
                                     │
                                     ▼
                  src/engine (механика, чистый TS) ◄── src/game/session.ts (GameSession: все команды партии)
                                                          │                       │
                       одиночная игра: выполняется в браузере      сетевая: выполняется на сервере
                                                          │                       │
                       src/stores/game.ts (Pinia) ◄─ src/net/client.ts ◄─socket.io─► server/app.ts
                                     │                                                │
                       src/views + src/components (Vue 3)            server/gm (ИИ-ведущий, Claude API)
```

## Данные (`src/data`, схема в `src/types.ts`)
| Файл | Источник | Что внутри |
|---|---|---|
| bestiary.json | Бестиарий | 97 статей: уровень, атаки (6 чисел по к6), защита, храбрость, мана, жизни, очки (опыт за жизнь), доп. атаки, заклинания, описание, путь к рисунку |
| locations.json | Книга Жизни | 15 глав, 647 параграфов (`n`, `text`, `hints`: удача, монстры и их число, монеты, бутылки, артефакт, свитки; `segments`: сцена и ветки решений с блоками текста и бросков, см. `tools/segment.py`; `tree`: дерево этапов, размеченное вручную в `tools/book/<локация>.json` — у таких параграфов вместо `segments`; для остальных дерево строит `src/game/tree.ts` на лету). Нумерация как в книге, включая опечатки оригинала (Северный форт 36→38, Дорога 99→101) |
| world.json | Карта мира | 20 узлов (14 локаций + 6 перекрёстков), 23 ребра с числом клеток; дни пути = клетки + 1 |
| classes.json | Инструкция, стр. 6–14 | 5 классов, таблицы 13 уровней, правила по оружию |
| weapons / armor / items.json | стр. 20–23 | лавка |
| artifacts.json | стр. 23–25 | 18 артефактов по к18 |
| spells.json | стр. 26–40 | 91 заклинание; `effect` структурирован (damage, heal, buff, debuff, control, ward, weapon, summon, identify, cure, resurrect…), 18 остаются `manual`. Переопределения — `EFFECT_OVERRIDES` в `tools/build_rules.py` |
| lore.json | Книга Сумерек | 7 глав предыстории, проза и стихи |
| rules.json | разное | константы (дублируются типобезопасно в `src/engine/rules.ts`) |

`src/data/index.ts` собирает `GameData` и `DataIndex` (Map-индексы по id). Карта мира грузится лениво.

## Движок (`src/engine`)
- `dice.ts` — к6/к18, формулы «3к6+8», подменяемый генератор (`setRng`, `seededRng`).
- `model.ts` — сериализуемое состояние: `GameState`, `Hero`, `InventoryEntry`, `CombatState`, `MonsterInstance`, `LogEntry`.
- `character.ts` — создание героя, производные характеристики (защита/сила/ловкость/меткость/удача с учётом снаряжения, артефактов и баффов), опыт и уровни (`gainXp`), жизни с порогами 0/−10, отдых.
- `inventory.ts` — покупка/продажа, экипировка с ограничениями класса и рук (л/п/д), бутылки, свитки, яд, противоядия.
- `loot.ts` — трофеи: снаряжение монстров по Бестиарию, сбор после победы (`combat.loot`), вещи только на продажу.
- `combat.ts` — бой: `startCombat` (головы гидры отдельными противниками) → фаза дистанции → `closeToMelee`
  (инициатива, доп. действия воина 12 ур.) → ходы героев (`heroAttack` с расходом стрел и метанием,
  `heroFlee`, `heroSkip`; `markActed` / `advanceIfDone` двигают раунд, `endHeroesTurn` — запасной выход) →
  `monstersTurn` (`alliesTurn` с выходом из-под контроля `loseControl`, урон со временем с опытом `dotXp`,
  храбрость, `monsterCast` с учётом защит и отражения, `monsterAttack` с особыми атаками, отрастание голов
  `regrowHeads`) → новый раунд; `finishCombat` (подбор брошенного) и `cleanupAfterCombat`.
- `spells.ts` — `resolveCost`, `canCast`, `castSpell` (все типы `SpellEffect`: урон, контроль монстров, ауры-варды, магическое оружие, призывы в `CombatState.allies`, опознание, лечение, воскрешение; опыт по формулам), хелперы `needsMonsterTarget/needsHeroTarget/needsEntryTarget/needsParam` для интерфейса.
- `world.ts` — кратчайший путь (Дейкстра по дням), случайные встречи, список локаций с лавкой/трактиром.

Движок мутирует переданные объекты (герои, состояние боя) и возвращает записи журнала. Он не знает о Vue и localStorage.

## Хранилище (`src/stores/game.ts`)
Один стор `useGameStore`: `game: GameState | null` (партия, мир, бой, журнал, спутники `companions`, слоты сохранения `zchm.slot.N`) (автосохранение глубоким watch в `localStorage['zchm.save.v1']`), `world`, `notice`. Действия — тонкие обёртки над движком + журнал: партия, лавка, вещи, трактир, путешествия, действия по параграфу (удача, артефакт, свиток, ловушка), бой. Экспорт/импорт — JSON целиком.

## Экраны
| Маршрут | Экран | Что делает |
|---|---|---|
| `/` | HomeView | продолжить, новая партия, экспорт/импорт |
| `/party` | PartyView + HeroSheet | создание героев, листы персонажей, экипировка, книга заклинаний, выбор заклинаний при уровне, ручные правки |
| `/shop` | ShopView | покупка (оружие/доспехи/вещи), продажа за половину, трактир |
| `/map` | MapView | карта с узлами, маршрут и дни, вход в локацию, встречи в пути |
| `/location/:id` | LocationView | план, сетка параграфов, текст, кнопки действий из подсказок, произвольный бой |
| `/combat` | CombatView | раунды, цели, атаки оружием, заклинания, бегство, ход монстров, журнал |
| `/bestiary`, `/spells`, `/lore`, `/about` | справочники и предыстория | |

Компоненты: `SpellCaster` — форма применения заклинаний (в бою и вне боя); `HeroSheet` — лист персонажа; `BookStages` — параграф по этапам (открытые этапы, варианты, броски, последствия); `ParagraphActions` — кнопки действий по подсказкам этапа; `MonsterPicker`, `SpellPicker`, `LogPanel`.

## Поток игры
1. Партия → лавка (40 монет) → карта.
2. `travelTo(node)`: дни += маршрут, встречи «Дороги» в `pendingRoad`.
3. `enterLocation(id)` → LocationView: параграф → действия → при бое `startEncounter(specs, returnTo)` → CombatView → `endCombat()` → возврат к параграфу.
4. Опыт начисляется сразу (`gainXp`), уровни объявляются в журнале; кастеры получают `pendingSpellPicks`.

## Сервер (`server/`)
| Файл | Что делает |
|---|---|
| `index.ts` | точка входа: порт, каталоги, включение ИИ-ведущего по `ANTHROPIC_API_KEY` |
| `app.ts` | `createGameServer`: HTTP (статика `dist`, `/health`) + socket.io; события `room:create/join/setGm/loadState`, `hero:claim/release`, `cmd`, `chat`; рассылка `state`, `room`, `chat`, `gm:delta`, `gm:done`, `notice`; события для ведущего после пути, входа в локацию, отдыха и боя |
| `permissions.ts` | `authorize(gm, player, command, args)` по ролям `owner/party/gm/host` |
| `rooms.ts` | `Room` (состояние, игроки, чат, история ведущего), `RoomStore` (память + хранилище с отложенной записью) |
| `storage.ts` | `RoomStorage` — где лежат сохранённые комнаты: `FileStorage` (JSON-файлы в `DATA_DIR`) или `PgStorage` (таблица `zchm_rooms` в Postgres, `DATABASE_URL`) |
| `gm/types.ts` | общие типы ведущих: `GmContext`, `GmDriver`, `GmEvent`, `LlmProvider`, `ProviderError` |
| `gm/ai.ts` | `GmDirector` — очередь ходов по комнатам, перебор провайдеров с паузами после ошибок, передача хода сценарному ведущему, сводка пропущенного; `AnthropicProvider` — Claude API (кэш, резервная модель, откат) |
| `gm/openai.ts` | `OpenAiCompatProvider` — любые OpenAI-совместимые API (fetch + SSE, function calling, окно истории) |
| `gm/providers.ts` | цепочка провайдеров из переменных окружения (`GM_CHAIN`, ключи и модели) |
| `gm/script.ts` | `ScriptedGm` — сценарный ведущий без ИИ: сцена и кнопки-варианты по разметке книги |
| `gm/prompt.ts` | системный промпт (полный для Claude, ужатый для бесплатных моделей) и снимок состояния партии |
| `gm/tools.ts` | инструменты ведущего: схемы (Claude и OpenAI-формат) и исполнение через `GameSession` |

Протокол — `src/net/protocol.ts` (общие типы), клиент — `src/net/client.ts` (`NetClient`: вызов команд с
подтверждением, чат, автоматический возврат в комнату после обрыва; вход хранится в `localStorage`).

Экраны сетевой игры: панель «Игра по сети» на главной (`OnlinePanel`), «Стол» (`/table`: чат с ведущим
`GmChat`, партия, план), лист партии с «Взять героя», локация без текста книги при ИИ-ведущем (номер на
плане — реплика ведущему).
