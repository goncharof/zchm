/** Сервер сетевой игры: HTTP (статика сборки) + socket.io (комнаты, команды, чат, ИИ-ведущий). */
import { createServer, type Server as HttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import sirv from 'sirv'
import { Server } from 'socket.io'
import type { WorldMap } from '@/types'
import type { GameState } from '@/engine/model'
import { GameError, parseSave, runCommand, type CommandArgs, type CommandName } from '@/game/session'
import { idx } from '@/data'
import { stateForClients, type Ack, type ClientToServer, type GmMode, type Joined, type ServerToClient } from '@/net/protocol'
import { authorize, isCommand } from './permissions'
import { Schemas, limit, makeLimiters, parse, type Limits } from './guard'
import { HOST_AWAY_MS, Room, RoomStore, type Player } from './rooms'
import { castVote, clearVotes, tally, voteComplete, votingOn } from './votes'

import { GmDirector } from './gm/ai'
import type { GmContext, GmDriver, GmEvent, GmFactory, GmInput } from './gm/types'
export type { GmContext, GmDriver, GmEvent, GmFactory, GmInput }

export interface ServerOptions {
  port?: number
  host?: string
  /** каталог собранного фронтенда (dist); null — не раздавать статику */
  staticDir?: string | null
  /** каталог для сохранения комнат; null — только в памяти */
  dataDir?: string | null
  world: WorldMap | null
  /** ведущий; по умолчанию — без моделей ИИ (ходы ведёт сценарный ведущий) */
  gm?: GmFactory
  /** ограничения частоты запросов (по умолчанию — DEFAULT_LIMITS) */
  limits?: Partial<Limits>
}

export interface GameServer {
  url: string
  port: number
  http: HttpServer
  io: Server<ClientToServer, ServerToClient>
  store: RoomStore
  gm: GmDriver
  close(): Promise<void>
}

/** Команды, после которых ведущему стоит описать происходящее */
function gmEventFor(name: CommandName, room: Room, before: GameState, args: unknown[], result: unknown): GmEvent | null {
  const s = room.state
  // заклинание, которое движок не отыгрывает («Озарение», «Чувство зла», «Чтение эмоций»…): исход решает ведущий
  if (name === 'cast' && (result as { ok?: boolean } | null)?.ok) {
    const [heroUid, spellId, opts] = args as CommandArgs<'cast'>
    const spell = idx.spell(spellId)
    // вне боя ведущему важны и «Невидимость» с «Отворотом мертвецов»: ими обходят встречу, решает это ведущий
    const sneaking = spell.effect.type === 'ward' && (spell.effect.kind === 'invisible' || spell.effect.kind === 'undead') && (!s.combat || !!s.combat.finished)
    if (spell.effect.type !== 'manual' && !sneaking) return null
    const hero = s.heroes.find((h) => h.uid === heroUid)
    const target = s.heroes.find((h) => h.uid === opts?.targetHeroUid)?.name ?? s.combat?.monsters.find((m) => m.uid === opts?.targetUid)?.name
    return {
      type: 'spell',
      spell: { id: spell.id, name: spell.name, hero: hero?.name ?? '' },
      text: `${hero?.name ?? 'Герой'} произносит «${spell.name}»${target ? ` (цель: ${target})` : ''}. По Книге заклинаний: «${spell.description}»`,
    }
  }
  if (name === 'travelTo' && s.worldNodeId !== before.worldNodeId) {
    const node = room.world?.nodes.find((n) => n.id === s.worldNodeId)
    const encounters = s.pendingRoad.slice(before.pendingRoad.length)
    return { type: 'travel', encounters, text: `Партия прибыла: ${node?.name ?? s.worldNodeId}, день ${s.day}.${encounters.length ? ` В пути случились встречи из главы «Дорога»: ${encounters.map((n) => `§ ${n}`).join(', ')}.` : ' В пути ничего не случилось.'}` }
  }
  if (name === 'enterLocation' && s.locationId && s.locationId !== before.locationId) {
    return { type: 'enter', text: `Партия входит в локацию «${s.locationId}».` }
  }
  if (name === 'endCombat') {
    const log = [...s.log].reverse()
    const last = log.find((e) => /Победа!|Команда отступила|Поражение/.test(e.text))
    const start = log.findIndex((e) => e.text.startsWith('Бой начинается'))
    const loot = log.slice(0, start < 0 ? 30 : start).filter((e) => /забирает трофей|подбирает:/.test(e.text)).reverse()
    const outcome = last?.text.startsWith('Победа!') ? 'victory' : last?.text.startsWith('Команда отступила') ? 'fled' : 'defeat'
    return { type: 'combatEnd', outcome, text: [`Бой окончен. ${last?.text ?? ''}`.trim(), ...loot.map((e) => e.text)].join(' ') }
  }
  if (name === 'restAll') return { type: 'rest', text: `Партия отдыхает в трактире. День ${s.day}.` }
  return null
}

export async function createGameServer(opts: ServerOptions): Promise<GameServer> {
  const store = new RoomStore(opts.dataDir ?? null, opts.world)
  const serveStatic = opts.staticDir && existsSync(opts.staticDir) ? sirv(opts.staticDir, { etag: true, gzip: true }) : null
  const http = createServer((req, res) => {
    if (req.url === '/health') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok'); return }
    if (serveStatic) { serveStatic(req, res, () => { res.statusCode = 404; res.end('not found') }); return }
    res.statusCode = 404
    res.end('not found')
  })
  const io = new Server<ClientToServer, ServerToClient>(http, { cors: { origin: true }, maxHttpBufferSize: 5e6 })

  const socketsOf = (room: Room) => [...room.players.values()].flatMap((p) => [...p.sockets])
  const ctx: GmContext = {
    stateChanged(room) { io.to(room.code).emit('state', stateForClients(room.state)); store.touch(room) },
    roomChanged(room) {
      const chain = gm.chain()
      for (const p of room.players.values()) for (const sid of p.sockets) io.to(sid).emit('room', room.view(p, chain))
    },
    chat(room, m) { const msg = room.addChat(m); io.to(room.code).emit('chat', msg); store.touch(room); return msg },
    updateChat(room, m) { io.to(room.code).emit('chat:update', m); store.touch(room) },
    delta(room, id, text) { room.live[id] = (room.live[id] ?? '') + text; io.to(room.code).emit('gm:delta', { id, text }) },
    done(room, id) { delete room.live[id]; io.to(room.code).emit('gm:done', { id }) },
    notice(room, text) { io.to(room.code).emit('notice', text) },
    persist(room) { store.touch(room) },
  }
  const gm: GmDriver = opts.gm ? opts.gm(ctx) : new GmDirector(ctx, { providers: [] })
  void socketsOf
  const autoGm = (r: Room) => r.gm === 'ai' || r.gm === 'script'

  // хозяин не в сети: когда выйдет срок, комната обновится сама и остальные увидят «Стать хозяином»
  // (после перезапуска сервера отсчёт идёт от загрузки комнаты — таймер ставит первый вошедший)
  const hostTimers = new WeakMap<Room, ReturnType<typeof setTimeout>>()
  function watchHost(r: Room): void {
    const host = [...r.players.values()].find((p) => p.isHost)
    if (!host || host.sockets.size > 0 || r.hostAway()) return
    clearTimeout(hostTimers.get(r))
    const t = setTimeout(() => { hostTimers.delete(r); ctx.roomChanged(r) }, Math.max(0, (host.awaySince ?? 0) + HOST_AWAY_MS - Date.now()) + 500)
    t.unref()
    hostTimers.set(r, t)
  }
  const limiters = makeLimiters(opts.limits)
  const GM_TITLE: Record<GmMode, string> = { ai: 'ИИ (если модели недоступны — сценарный)', script: 'сценарный, без ИИ', human: 'хозяин комнаты', book: 'нет, читаем Книгу Жизни сами' }

  /** клиент может не передать функцию подтверждения — тогда ответ просто не отправляется */
  function safeAck(ack: unknown): (a: Ack) => void {
    return typeof ack === 'function' ? (ack as (a: Ack) => void) : () => {}
  }

  function fail(ack: (a: Ack) => void, e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    if (!(e instanceof GameError) && !(e instanceof Error && e.name === 'GameError')) console.error('[cmd]', e)
    ack({ ok: false, error: msg || 'Ошибка' })
  }

  /** Отложенные реплики (и событие, если есть) уходят ведущему одним ходом; отметки «готов» сбрасываются */
  function flushTurn(r: Room, event?: GmEvent, pass = false): void {
    const inputs: GmInput[] = r.held.map((h) => ({ kind: 'player', ...h }))
    if (event) inputs.push({ kind: 'event', event })
    else if (pass && !inputs.length) inputs.push({ kind: 'event', event: { type: 'pass', text: 'Все игроки готовы.' } })
    r.held = []
    r.ready.clear()
    ctx.roomChanged(r)
    store.touch(r)
    if (inputs.length) gm.enqueue(r, inputs)
  }
  /** Ход по готовности: все активные игроки готовы — ход ведущего */
  function checkReady(r: Room): void {
    if (r.turnMode === 'ready' && autoGm(r) && r.ready.size && r.allReady()) flushTurn(r, undefined, true)
  }
  /** Подвести итог голосования по сообщению (все проголосовали или хозяин торопит) */
  function resolveVote(r: Room, messageId: string): void {
    const win = tally(r, messageId)
    clearVotes(r, messageId)
    const msg = r.chatById(messageId)
    if (msg) ctx.updateChat(r, msg)
    if (!win) return
    // вариант мог стать недоступным (выбран без голосования, сообщение вытеснено) — это не повод ронять сервер
    try { gm.choose(r, win.playerId, messageId, win.choiceId) } catch (e) {
      if (!(e instanceof Error && e.name === 'GameError')) console.error('[голосование]', e)
    }
  }
  /** Голосования, где уже проголосовали все активные игроки (например, после ухода игрока) */
  function checkVotes(r: Room): void {
    for (const id of Object.keys(r.votes)) if (voteComplete(r, id)) resolveVote(r, id)
  }
  /** Состав активных игроков изменился (герой взят или отпущен, игрок ушёл, герой погиб) — пересчитать готовность и голоса */
  function recheck(r: Room): void {
    checkReady(r)
    if (votingOn(r)) checkVotes(r)
    else for (const id of Object.keys(r.votes)) resolveVote(r, id)
  }

  io.on('connection', (socket) => {
    let room: Room | null = null
    let player: Player | null = null
    // адрес клиента: за туннелем (cloudflared) все соединения приходят с localhost — настоящий адрес в заголовке
    const h = socket.handshake.headers
    const addr = String(h['cf-connecting-ip'] ?? h['x-forwarded-for'] ?? socket.handshake.address ?? '').split(',')[0].trim() || socket.id
    // сообщения крупнее 20 КБ нужны только для создания комнаты и загрузки сохранения (в них состояние партии)
    socket.use(([event, ...args], next) => {
      if (event !== 'room:create' && event !== 'room:loadState' && JSON.stringify(args).length > 20_000) return next(new Error('Слишком большое сообщение'))
      next()
    })

    async function enter(r: Room, p: Player, ack: (a: Ack) => void) {
      // соединение переходит к другому игроку (или в другую комнату) — прежний больше не числится в сети через него
      if (room && player && (room !== r || player !== p)) {
        player.sockets.delete(socket.id)
        if (room !== r) void socket.leave(room.code)
        if (player.sockets.size === 0) { player.awaySince = Date.now(); watchHost(room) }
        ctx.roomChanged(room)
      }
      room = r
      player = p
      p.sockets.add(socket.id)
      await socket.join(r.code)
      const joined: Joined = { code: r.code, playerId: p.id, token: p.token }
      ack({ ok: true, result: joined })
      socket.emit('state', stateForClients(r.state))
      socket.emit('chat:history', r.chat.slice(-150))
      // недописанный рассказ ведущего — сразу целиком (страницу обновили посреди ответа)
      for (const [id, text] of Object.entries(r.live)) socket.emit('gm:delta', { id, text })
      ctx.roomChanged(r)
      recheck(r)
      watchHost(r)
      // очередь ведущего, оставшаяся с прошлого запуска сервера
      gm.resume?.(r)
    }

    socket.on('room:create', async (raw, rawAck) => {
      const ack = safeAck(rawAck)
      try {
        limit(limiters.room.take(socket.id), 'Слишком часто: подождите немного')
        // новые комнаты — не чаще, чем нужно компании: с одного адреса пять сразу, дальше одна в две минуты
        limit(limiters.roomCreate.take(addr), 'Слишком много новых комнат — подождите несколько минут')
        const req = parse(Schemas.create, raw)
        const mode: GmMode = req.gm
        const state = req.state ? parseSave(JSON.stringify(req.state)) : undefined
        const r = await store.create(mode, state)
        // ИИ-ведущий отвечает, когда готовы все: при одном игроке — сразу, при нескольких — одним ходом на всех
        // (бесплатные квоты моделей — десятки запросов в день)
        if (mode === 'ai') r.turnMode = 'ready'
        const p = r.addPlayer(req.name, true)
        // герои из загруженного сохранения поначалу принадлежат хозяину
        p.heroUids = r.state.heroes.map((h) => h.uid)
        ctx.chat(r, { from: 'system', author: 'Игра', text: `Комната ${r.code} создана. Ведущий: ${GM_TITLE[mode]}.` })
        await enter(r, p, ack)
      } catch (e) { fail(ack, e) }
    })

    socket.on('room:join', async (raw, rawAck) => {
      const ack = safeAck(rawAck)
      try {
        limit(limiters.room.take(socket.id), 'Слишком часто: подождите немного')
        const req = parse(Schemas.join, raw)
        // подбор кода комнаты: неудачные входы считаются по адресу, а не по соединению (переподключение не сбрасывает)
        limit(limiters.badJoin.can(addr), 'Слишком много неудачных попыток входа — подождите')
        const r = await store.get(req.code)
        // клиент мог отключиться, пока комната читалась с диска: иначе мёртвый сокет навсегда числится «в сети»
        if (!socket.connected) return
        if (!r) { limiters.badJoin.take(addr); throw new GameError('Комната не найдена') }
        let p = req.token ? r.playerByToken(req.token) : undefined
        // вход с другого устройства (или после очистки браузера): игрок не в сети с тем же именем — это он, герои при нём.
        // Хозяина так не занять (его права — только по токену; пропавшего хозяина сменяет «Стать хозяином»), а прежний
        // токен перестаёт действовать: вошедший получает новый
        if (!p) {
          p = [...r.players.values()].find((x) => x.sockets.size === 0 && !x.isHost && x.name.trim().toLowerCase() === req.name.trim().toLowerCase())
          if (p) { p.token = randomUUID(); store.touch(r) }
        }
        if (!p) {
          if ([...r.players.values()].filter((x) => x.sockets.size > 0).length >= 8) throw new GameError('В комнате уже 8 игроков')
          p = r.addPlayer(req.name, false)
          ctx.chat(r, { from: 'system', author: 'Игра', text: `${p.name} присоединяется к игре.` })
          store.touch(r)
        }
        await enter(r, p, ack)
      } catch (e) { fail(ack, e) }
    })

    socket.on('room:setGm', (raw, rawAck) => {
      const ack = safeAck(rawAck)
      try {
        const mode = parse(Schemas.gm, raw)
        if (!room || !player) throw new GameError('Вы не в комнате')
        if (!player.isHost) throw new GameError('Это может только хозяин комнаты')
        room.gm = mode
        // ведущий больше не отвечает сам — отложенные реплики и отметки «готов» не нужны
        if (!autoGm(room)) { room.held = []; room.ready.clear(); room.gmQueue = []; for (const id of Object.keys(room.votes)) clearVotes(room, id) }
        ctx.chat(room, { from: 'system', author: 'Игра', text: `Режим ведущего: ${GM_TITLE[mode]}.` })
        ctx.roomChanged(room)
        store.touch(room)
        ack({ ok: true })
      } catch (e) { fail(ack, e) }
    })

    socket.on('room:turnMode', (raw, rawAck) => {
      const ack = safeAck(rawAck)
      try {
        const mode = parse(Schemas.turnMode, raw)
        if (!room || !player) throw new GameError('Вы не в комнате')
        if (!player.isHost) throw new GameError('Это может только хозяин комнаты')
        limit(limiters.choose.take(socket.id), 'Слишком часто')
        room.turnMode = mode
        if (mode === 'instant') for (const id of Object.keys(room.votes)) resolveVote(room, id)
        ctx.chat(room, { from: 'system', author: 'Игра', text: mode === 'ready' ? 'Ведущий отвечает, когда все игроки готовы: каждый пишет, что делает его герой, или жмёт «Готов».' : 'Ведущий отвечает сразу на каждую реплику.' })
        if (mode === 'instant') flushTurn(room)
        else { ctx.roomChanged(room); store.touch(room) }
        ack({ ok: true })
      } catch (e) { fail(ack, e) }
    })

    socket.on('turn:ready', (raw, rawAck) => {
      const ack = safeAck(rawAck)
      try {
        const ready = parse(Schemas.ready, raw)
        if (!room || !player) throw new GameError('Вы не в комнате')
        limit(limiters.choose.take(socket.id), 'Слишком часто')
        if (room.turnMode !== 'ready') throw new GameError('Ведущий и так отвечает сразу')
        if (ready) room.ready.add(player.id)
        else room.ready.delete(player.id)
        ctx.roomChanged(room)
        checkReady(room)
        ack({ ok: true })
      } catch (e) { fail(ack, e) }
    })

    socket.on('turn:go', (rawAck) => {
      const ack = safeAck(rawAck)
      try {
        if (!room || !player) throw new GameError('Вы не в комнате')
        if (!player.isHost) throw new GameError('Начать ход без готовности всех может только хозяин комнаты')
        limit(limiters.choose.take(socket.id), 'Слишком часто')
        if (!autoGm(room)) throw new GameError('В этом режиме ведущий не отвечает сам')
        if (room.turnMode !== 'ready') throw new GameError('Ведущий и так отвечает сразу')
        // каждый ход ИИ-ведущего тратит квоту модели — как реплика ведущему
        limit(limiters.toGm.take(`${room.code}:${player.id}`), 'Ведущий не успевает: не больше 4 ходов в минуту')
        // хозяин торопит: открытые голосования решаются по текущим голосам
        const pending = Object.keys(room.votes)
        for (const id of pending) resolveVote(room, id)
        flushTurn(room, undefined, !pending.length)
        ack({ ok: true })
      } catch (e) { fail(ack, e) }
    })

    socket.on('room:loadState', (raw, rawAck) => {
      const ack = safeAck(rawAck)
      try {
        const state = parse(Schemas.state, raw)
        if (!room || !player) throw new GameError('Вы не в комнате')
        if (!player.isHost) throw new GameError('Загружать сохранение может только хозяин комнаты')
        const g = parseSave(JSON.stringify(state))
        for (const k of Object.keys(room.state)) delete (room.state as unknown as Record<string, unknown>)[k]
        Object.assign(room.state, g)
        room.pruneHeroes()
        ctx.stateChanged(room)
        ctx.roomChanged(room)
        ack({ ok: true })
      } catch (e) { fail(ack, e) }
    })

    socket.on('hero:claim', (raw, rawAck) => {
      const ack = safeAck(rawAck)
      try {
        const heroUid = parse(Schemas.heroUid, raw)
        limit(limiters.cmd.take(socket.id), 'Слишком часто')
        if (!room || !player) throw new GameError('Вы не в комнате')
        if (!room.state.heroes.some((h) => h.uid === heroUid)) throw new GameError('Нет такого героя')
        const owner = room.ownerName(heroUid)
        if (owner && !player.heroUids.includes(heroUid) && !player.isHost) throw new GameError(`Этим героем управляет ${owner}`)
        for (const p of room.players.values()) p.heroUids = p.heroUids.filter((u) => u !== heroUid)
        player.heroUids.push(heroUid)
        ctx.roomChanged(room)
        store.touch(room)
        recheck(room)
        ack({ ok: true })
      } catch (e) { fail(ack, e) }
    })

    socket.on('hero:release', (raw, rawAck) => {
      const ack = safeAck(rawAck)
      try {
        const heroUid = parse(Schemas.heroUid, raw)
        if (!room || !player) throw new GameError('Вы не в комнате')
        limit(limiters.cmd.take(socket.id), 'Слишком много действий подряд')
        player.heroUids = player.heroUids.filter((u) => u !== heroUid)
        ctx.roomChanged(room)
        store.touch(room)
        recheck(room)
        ack({ ok: true })
      } catch (e) { fail(ack, e) }
    })

    socket.on('cmd', (raw, rawAck) => {
      const ack = safeAck(rawAck)
      try {
        limit(limiters.cmd.take(socket.id), 'Слишком много действий подряд')
        const req = parse(Schemas.cmd, raw)
        if (!room || !player) throw new GameError('Вы не в комнате')
        const r = room
        const p = player
        const args = req.args
        const why = authorize(r.gm, p, req.name, args, (u) => r.heroOwned(u))
        if (why) throw new GameError(why)
        if (!isCommand(req.name)) throw new GameError('Неизвестная команда')
        const name = req.name
        const before = JSON.parse(JSON.stringify({ worldNodeId: r.state.worldNodeId, locationId: r.state.locationId, pendingRoad: r.state.pendingRoad })) as GameState
        const result = runCommand(r.session(), name, args as CommandArgs<typeof name>)
        // новый герой принадлежит тому, кто его создал
        if (name === 'addHero' && result && typeof result === 'object' && 'uid' in result) p.heroUids.push((result as { uid: string }).uid)
        // новая партия: герои ничьи, каждый игрок берёт своего («Взять героя»)
        if (name === 'quickStart' || name === 'newGame') for (const x of r.players.values()) x.heroUids = []
        if (name === 'removeHero' || name === 'quickStart' || name === 'newGame') r.pruneHeroes()
        ctx.stateChanged(r)
        if (['addHero', 'removeHero', 'quickStart', 'newGame'].includes(name)) ctx.roomChanged(r)
        ack({ ok: true, result: JSON.parse(JSON.stringify(result ?? null)) })
        if (autoGm(r)) {
          const ev = gmEventFor(name, r, before, args as unknown[], result)
          // события, на которые отвечает модель, — не чаще предела комнаты (клиент, отдыхающий в цикле, тратил бы квоты и
          // деньги); сверх предела событие пропускается — состояние игры уже изменено
          const paid = r.gm === 'ai' && gm.chain().length > 0
          if (ev && paid && !limiters.gmEvents.take(r.code)) console.warn(`[ведущий] ${r.code}: событие «${ev.type}» пропущено — слишком часто`)
          // событие игры не ждёт готовности: отложенные реплики уходят вместе с ним
          else if (ev) { if (r.turnMode === 'ready') flushTurn(r, ev); else gm.enqueue(r, { kind: 'event', event: ev }) }
        }
        // гибель героя, новая партия, удалённый герой меняют состав активных игроков
        if (r.turnMode === 'ready') recheck(r)
      } catch (e) { fail(ack, e) }
    })

    socket.on('chat', (raw, rawAck) => {
      const ack = safeAck(rawAck)
      try {
        const req = parse(Schemas.chat, raw)
        if (!room || !player) throw new GameError('Вы не в комнате')
        const text = req.text.trim()
        if (!text) throw new GameError('Пустое сообщение')
        limit(limiters.chat.take(socket.id), 'Не так быстро: одна реплика в пару секунд')
        // реплики ведущему расходуют квоты моделей; сценарному ведущему (номера помещений подряд) предел не нужен
        if (req.toGm && room.gm === 'ai' && gm.chain().length) limit(limiters.toGm.take(`${room.code}:${player.id}`), 'Ведущий не успевает: не больше 4 реплик ведущему в минуту от игрока')
        // живой ведущий рассказывает от имени ведущего
        if (req.asGm) {
          if (room.gm !== 'human' || !player.isHost) throw new GameError('Говорить за ведущего может только живой ведущий')
          ctx.chat(room, { from: 'gm', author: `Ведущий · ${player.name}`, text })
          ack({ ok: true })
          return
        }
        const heroes = room.state.heroes.filter((h) => player!.heroUids.includes(h.uid)).map((h) => h.name)
        const author = heroes.length ? `${player.name} (${heroes.join(', ')})` : player.name
        const toGm = !!req.toGm && autoGm(room)
        const msg = ctx.chat(room, { from: 'player', author, text, toGm, playerId: player.id })
        if (toGm && room.turnMode === 'ready') {
          // реплика = заявка героя: игрок готов; ход — когда готовы все
          room.held.push({ author, text, playerId: player.id, chatId: msg.id })
          room.ready.add(player.id)
          ctx.roomChanged(room)
          store.touch(room)
          checkReady(room)
        } else if (toGm) gm.enqueue(room, { kind: 'player', author, text, playerId: player.id, chatId: msg.id })
        ack({ ok: true })
      } catch (e) { fail(ack, e) }
    })

    socket.on('gm:choose', (raw, rawAck) => {
      const ack = safeAck(rawAck)
      try {
        const req = parse(Schemas.choose, raw)
        if (!room || !player) throw new GameError('Вы не в комнате')
        limit(limiters.choose.take(socket.id), 'Слишком часто')
        // старые кнопки сценарного ведущего не действуют, когда ведёт живой ведущий или никто
        if (!autoGm(room)) throw new GameError('Сейчас ведёт не сценарный ведущий')
        if (votingOn(room)) {
          // режим «когда все готовы»: нажатие — голос, вариант срабатывает, когда проголосуют все
          ctx.updateChat(room, castVote(room, player.id, req.messageId, req.choiceId))
          if (voteComplete(room, req.messageId)) resolveVote(room, req.messageId)
        } else {
          gm.choose(room, player.id, req.messageId, req.choiceId)
          // голоса, оставшиеся с режима голосования, по этому сообщению больше не нужны
          if (room.votes[req.messageId]) { clearVotes(room, req.messageId); const m = room.chatById(req.messageId); if (m) ctx.updateChat(room, m) }
        }
        ack({ ok: true })
      } catch (e) { fail(ack, e) }
    })

    socket.on('disconnect', () => {
      if (!room || !player) return
      try {
        player.sockets.delete(socket.id)
        if (player.sockets.size === 0) {
          player.awaySince = Date.now()
          watchHost(room)
        }
        ctx.roomChanged(room)
        // ушёл тот, кого ждали, — остальные могут быть уже готовы
        recheck(room)
      } catch (e) { console.error('[отключение]', e) }
    })

    // хозяин давно не в сети: любой игрок за столом может взять его права (режим ведущего, новая партия, загрузка)
    socket.on('room:claimHost', (rawAck) => {
      const ack = safeAck(rawAck)
      try {
        if (!room || !player) throw new GameError('Вы не в комнате')
        limit(limiters.room.take(socket.id), 'Слишком часто: подождите немного')
        if (player.isHost) { ack({ ok: true }); return }
        if (!room.hostAway()) throw new GameError('Хозяин комнаты в сети или отошёл совсем недавно')
        const old = room.transferHost(player)
        ctx.chat(room, { from: 'system', author: 'Игра', text: `${player.name} теперь хозяин комнаты${old ? ` (${old.name} давно не в сети)` : ''}.${room.gm === 'human' ? ' Ведущий — тоже он.' : ''}` })
        ctx.roomChanged(room)
        store.touch(room)
        ack({ ok: true })
      } catch (e) { fail(ack, e) }
    })

    // явный выход («Выйти»): герои освобождаются, игрок (кроме хозяина) удаляется — иначе остаётся «призрак» с героями
    socket.on('room:leave', (rawAck) => {
      const ack = safeAck(rawAck)
      try {
        if (!room || !player) { ack({ ok: true }); return }
        const r = room, p = player
        p.sockets.delete(socket.id)
        void socket.leave(r.code)
        if (p.sockets.size === 0) {
          p.heroUids = []
          // хозяин ушёл сам — права переходят к игроку в сети (если в сети никого — к любому оставшемуся)
          const next = p.isHost ? [...r.players.values()].filter((x) => x !== p).sort((a, b) => Number(b.sockets.size > 0) - Number(a.sockets.size > 0))[0] : undefined
          if (next) r.transferHost(next)
          if (!p.isHost) r.players.delete(p.id)
          ctx.chat(r, { from: 'system', author: 'Игра', text: `${p.name} выходит из игры.${next ? ` Хозяин комнаты теперь ${next.name}.` : ''}` })
        }
        room = null; player = null
        ctx.roomChanged(r)
        store.touch(r)
        recheck(r)
        ack({ ok: true })
      } catch (e) { fail(ack, e) }
    })
  })

  // комнаты без игроков выгружаются из памяти через полчаса простоя (они на диске)
  const evictTimer = setInterval(() => { void store.evictIdle(30 * 60_000).catch((e) => console.error('[комнаты]', e)) }, 5 * 60_000)
  evictTimer.unref()

  await new Promise<void>((resolve) => http.listen(opts.port ?? 0, opts.host ?? '0.0.0.0', resolve))
  const port = (http.address() as AddressInfo).port
  return {
    url: `http://localhost:${port}`, port, http, io, store, gm,
    async close() {
      clearInterval(evictTimer)
      // очередь ведущего сохранена в комнатах: сначала записать на диск, ходы моделей ждать недолго
      await store.flush()
      await Promise.race([gm.idle(), new Promise((r) => setTimeout(r, 3000))])
      await store.flush()
      await new Promise<void>((resolve) => { io.close(() => resolve()) })
    },
  }
}
