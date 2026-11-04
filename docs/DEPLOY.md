# Как вывести игру в сеть

Одиночная игра — статические файлы (`pnpm build` → `dist/`), её можно выложить куда угодно. Сетевой игре нужен
сервер: он хранит комнаты, раздаёт фронтенд и держит сокеты. Ниже три способа, от простого к постоянному.

Общее для всех:
- Нужны Node.js 24 и pnpm (`corepack enable`).
- Ключи моделей ведущего — в `.env.local` в корне проекта (строки `GEMINI_API_KEY=...`) или в переменных окружения.
  Без ключей ходы ведёт сценарный ведущий. Ключи остаются на сервере, игроки их не видят.
- Комнаты сохраняются в `data/rooms/` (или `DATA_DIR`). Эту папку стоит копировать для резервной копии.
- Проверка, что сервер жив: `curl http://адрес/health` → `ok`.

## 1. Вечер игры через туннель (ничего не арендуем)

Сервер работает на вашем компьютере, а туннель даёт временную публичную ссылку `https://…`. Подходит, чтобы
сыграть с друзьями сегодня.

```bash
cd ~/projects/zchm
pnpm install
pnpm build && pnpm build:server
HOST=127.0.0.1 pnpm start           # сервер на http://localhost:8787, только для этого компьютера (наружу — через туннель)

# во втором терминале — временная ссылка (Cloudflare, без регистрации)
brew install cloudflared
cloudflared tunnel --url http://localhost:8787
# в выводе будет адрес вида https://что-то-случайное.trycloudflare.com — его и отправьте друзьям
```

- Сокеты через туннель работают, PWA и копирование ссылки — тоже (адрес по HTTPS).
- Компьютер не должен засыпать: `caffeinate -dimsu` в третьем терминале на время игры.
- Ссылка меняется при каждом запуске туннеля. Закройте туннель (Ctrl+C) — игра снова доступна только вам.
- Войти может любой, у кого есть ссылка и код комнаты. Код (6 знаков) знают только те, кому вы его дали; подбор кода
  перебором сервер останавливает, а права хозяина по одному имени не отдаёт.
- Аналоги: `ngrok http 8787`, Tailscale Funnel.

## 2. Постоянный сервер на VPS (Docker)

Небольшой VPS (1 ядро, 1 ГБ памяти) с Docker и доменом.

```bash
git clone <ваш репозиторий> zchm && cd zchm
docker build -t zchm .
docker run -d --name zchm --restart unless-stopped -p 127.0.0.1:8787:8787 \
  -v zchm-data:/data -e TRUST_PROXY=1 \
  -e GEMINI_API_KEY=... -e GROQ_API_KEY=... -e OPENROUTER_API_KEY=... \
  zchm
```

HTTPS и сокеты — через обратный прокси, проще всего Caddy (сертификат получит сам):

```
# /etc/caddy/Caddyfile
игра.example.ru {
  reverse_proxy 127.0.0.1:8787
}
```

Обновление: `git pull && docker build -t zchm . && docker rm -f zchm && docker run …` (комнаты живут в томе
`zchm-data` и переживают обновление; ход ведущего, шедший в момент перезапуска, повторится сам).

> Образ проверен 2026-10-18: собирается, работает от пользователя `node`, комнаты сохраняются в томе `/data`,
> сетевая игра двух игроков проходит (`node tools/qa/online.mjs http://localhost:8787/`). Размер — около 320 МБ.

## 3. Fly.io или Render

Оба принимают Dockerfile. Нужны постоянный диск для `/data` и переменные с ключами:

```bash
fly launch --no-deploy            # создаст fly.toml по Dockerfile
fly volumes create zchm_data --size 1
# в fly.toml: [mounts] source = "zchm_data", destination = "/data"; internal_port = 8787
# в fly.toml: [env] TRUST_PROXY = "1"
fly secrets set GEMINI_API_KEY=... GROQ_API_KEY=...
fly deploy
```

Сервер — один процесс, комнаты в памяти и на диске: запускайте **одну** машину (без горизонтального
масштабирования), иначе игроки одной комнаты окажутся на разных серверах.

## Переменные окружения сервера

| Переменная | По умолчанию | Что задаёт |
|---|---|---|
| `PORT`, `HOST` | `8787`, `0.0.0.0` | адрес сервера |
| `DATA_DIR` | `data/rooms` | где хранятся комнаты |
| `TRUST_PROXY` | — | `1`: соединения идут через свой прокси не с этой машины (Docker, Fly.io) — адрес игрока брать из X-Forwarded-For. Без прокси не включать: адрес подделает любой |
| `STATIC_DIR` | `dist` | собранный фронтенд |
| `GEMINI_API_KEY`, `GEMINI_MODEL` | `gemini-3.5-flash` | Google AI Studio; моделей можно несколько через запятую |
| `GROQ_API_KEY`, `GROQ_MODEL` | `openai/gpt-oss-120b` | Groq |
| `MISTRAL_API_KEY`, `MISTRAL_MODEL` | `mistral-small-latest` | Mistral, тариф Experiment (не проверено) |
| `OPENROUTER_API_KEY`, `OPENROUTER_MODEL` | `nvidia/nemotron-3-super-120b-a12b:free` | OpenRouter |
| `CEREBRAS_API_KEY`, `CEREBRAS_MODEL` | `gpt-oss-120b` | Cerebras (не проверено) |
| `LLM_BASE_URL`, `LLM_MODEL`, `LLM_API_KEY` | — | любая OpenAI-совместимая модель, например Ollama |
| `ANTHROPIC_API_KEY`, `GM_MODEL`, `GM_EFFORT` | `claude-opus-5-5`, `medium` | Claude (платно) |
| `GM_CHAIN` | `gemini,cerebras,openrouter,groq,custom,claude` | порядок моделей |
| `GM_HISTORY_CHARS` | `300000` | когда начинать разговор Claude заново с кратким содержанием |
