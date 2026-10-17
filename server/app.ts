/** Сервер сетевой игры: HTTP (статика сборки) + socket.io (комнаты, команды, чат, ИИ-ведущий). */
import { createServer, type Server as HttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { existsSync } from 'node:fs'
import sirv from 'sirv'
import { Server } from 'socket.io'
import type { WorldMap } from '@/types'
import type { GameState } from '@/engine/model'
import { GameError, parseSave, runCommand, type CommandArgs, type CommandName } from '@/game/session'
import { stateForClients, type Ack, type ClientToServer, type GmMode, type Joined, type ServerToClient } from '@/net/protocol'
import { authorize, isCommand } from './permissions'
import { Schemas, limit, makeLimiters, parse, type Limits } from './guard'
import { Room, RoomStore, type Player } from './rooms'

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
function gmEventFor(name: CommandName, room: Room, before: GameState): GmEvent | null {
  const s = room.state
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
    delta(room, id, text) { io.to(room.code).emit('gm:delta', { id, text }) },
    done(room, id) { io.to(room.code).emit('gm:done', { id }) },
    notice(room, text) { io.to(room.code).emit('notice', text) },
    persist(room) { store.touch(room) },
  }
  const gm: GmDriver = opts.gm ? opts.gm(ctx) : new GmDirector(ctx, { providers: [] })
  void socketsOf
  const autoGm = (r: Room) => r.gm === 'ai' || r.gm === 'script'
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

  io.on('connection', (socket) => {
    let room: Room | null = null
    let player: Player | null = null

    async function enter(r: Room, p: Player, ack: (a: Ack) => void) {
      if (room && player && room !== r) { player.sockets.delete(socket.id); void socket.leave(room.code); ctx.roomChanged(room) }
      room = r
      player = p
      p.sockets.add(socket.id)
      await socket.join(r.code)
      const joined: Joined = { code: r.code, playerId: p.id, token: p.token }
      ack({ ok: true, result: joined })
      socket.emit('state', stateForClients(r.state))
      socket.emit('chat:history', r.chat.slice(-150))
      ctx.roomChanged(r)
    }

    socket.on('room:create', async (raw, rawAck) => {
      const ack = safeAck(rawAck)
      try {
        limit(limiters.room.take(socket.id), 'Слишком часто: подождите немного')
        const req = parse(Schemas.create, raw)
        const mode: GmMode = req.gm
        const state = req.state ? parseSave(JSON.stringify(req.state)) : undefined
        const r = await store.create(mode, state)
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
        const r = await store.get(req.code)
        if (!r) throw new GameError('Комната не найдена')
        let p = req.token ? r.playerByToken(req.token) : undefined
        if (!p) {
          if (r.players.size >= 8) throw new GameError('В комнате уже 8 игроков')
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
        ctx.chat(room, { from: 'system', author: 'Игра', text: `Режим ведущего: ${GM_TITLE[mode]}.` })
        ctx.roomChanged(room)
        store.touch(room)
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
        ack({ ok: true })
      } catch (e) { fail(ack, e) }
    })

    socket.on('hero:release', (raw, rawAck) => {
      const ack = safeAck(rawAck)
      try {
        const heroUid = parse(Schemas.heroUid, raw)
        if (!room || !player) throw new GameError('Вы не в комнате')
        player.heroUids = player.heroUids.filter((u) => u !== heroUid)
        ctx.roomChanged(room)
        store.touch(room)
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
          const ev = gmEventFor(name, r, before)
          if (ev) gm.enqueue(r, { kind: 'event', event: ev })
        }
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
        if (req.toGm && autoGm(room)) limit(limiters.toGm.take(`${room.code}:${player.id}`), 'Ведущий не успевает: не больше 4 реплик ведущему в минуту от игрока')
        const heroes = room.state.heroes.filter((h) => player!.heroUids.includes(h.uid)).map((h) => h.name)
        const author = heroes.length ? `${player.name} (${heroes.join(', ')})` : player.name
        const toGm = !!req.toGm && autoGm(room)
        const msg = ctx.chat(room, { from: 'player', author, text, toGm })
        if (toGm) gm.enqueue(room, { kind: 'player', author, text, playerId: player.id, chatId: msg.id })
        ack({ ok: true })
      } catch (e) { fail(ack, e) }
    })

    socket.on('gm:choose', (raw, rawAck) => {
      const ack = safeAck(rawAck)
      try {
        const req = parse(Schemas.choose, raw)
        if (!room || !player) throw new GameError('Вы не в комнате')
        limit(limiters.choose.take(socket.id), 'Слишком часто')
        gm.choose(room, player.id, req.messageId, req.choiceId)
        ack({ ok: true })
      } catch (e) { fail(ack, e) }
    })

    socket.on('disconnect', () => {
      if (room && player) {
        player.sockets.delete(socket.id)
        ctx.roomChanged(room)
      }
    })
  })

  await new Promise<void>((resolve) => http.listen(opts.port ?? 0, opts.host ?? '0.0.0.0', resolve))
  const port = (http.address() as AddressInfo).port
  return {
    url: `http://localhost:${port}`, port, http, io, store, gm,
    async close() {
      await gm.idle()
      await store.flush()
      await new Promise<void>((resolve) => { io.close(() => resolve()) })
    },
  }
}
