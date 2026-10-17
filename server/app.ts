/** Сервер сетевой игры: HTTP (статика сборки) + socket.io (комнаты, команды, чат, ИИ-ведущий). */
import { createServer, type Server as HttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { existsSync } from 'node:fs'
import sirv from 'sirv'
import { Server } from 'socket.io'
import type { WorldMap } from '@/types'
import type { GameState } from '@/engine/model'
import { GameError, parseSave, runCommand, type CommandArgs, type CommandName } from '@/game/session'
import { stateForClients, type Ack, type ChatMessage, type ClientToServer, type GmMode, type Joined, type ServerToClient } from '@/net/protocol'
import { authorize, isCommand } from './permissions'
import { Room, RoomStore, type Player } from './rooms'

/** Вход для ИИ-ведущего: реплика игрока или событие игры */
export type GmInput = { kind: 'player'; author: string; text: string } | { kind: 'event'; text: string }

/** Что сервер даёт ведущему: доступ к комнате и способы сообщить клиентам об изменениях */
export interface GmContext {
  stateChanged(room: Room): void
  roomChanged(room: Room): void
  chat(room: Room, m: Omit<ChatMessage, 'id' | 't'> & { id?: string }): ChatMessage
  delta(room: Room, id: string, text: string): void
  done(room: Room, id: string): void
  notice(room: Room, text: string): void
  persist(room: Room): void
}

export interface GmDriver {
  enqueue(room: Room, input: GmInput): void
  /** дождаться окончания всех ходов ведущего (для тестов и остановки сервера) */
  idle(): Promise<void>
}

export type GmFactory = (ctx: GmContext) => GmDriver

export interface ServerOptions {
  port?: number
  host?: string
  /** каталог собранного фронтенда (dist); null — не раздавать статику */
  staticDir?: string | null
  /** каталог для сохранения комнат; null — только в памяти */
  dataDir?: string | null
  world: WorldMap | null
  /** ИИ-ведущий; если не задан, режим «ИИ» недоступен */
  gm?: GmFactory
}

export interface GameServer {
  url: string
  port: number
  http: HttpServer
  io: Server<ClientToServer, ServerToClient>
  store: RoomStore
  gm: GmDriver | null
  close(): Promise<void>
}

/** Команды, после которых ИИ-ведущему стоит описать происходящее */
function gmEventFor(name: CommandName, room: Room, before: GameState): string | null {
  const s = room.state
  if (name === 'travelTo' && s.worldNodeId !== before.worldNodeId) {
    const node = room.world?.nodes.find((n) => n.id === s.worldNodeId)
    const enc = s.pendingRoad.slice(before.pendingRoad.length)
    return `Партия прибыла: ${node?.name ?? s.worldNodeId}, день ${s.day}.${enc.length ? ` В пути случились встречи из главы «Дорога»: ${enc.map((n) => `§ ${n}`).join(', ')} — разыграй их по очереди, затем опиши прибытие.` : ' В пути ничего не случилось.'}`
  }
  if (name === 'enterLocation' && s.locationId && s.locationId !== before.locationId) {
    return `Партия входит в локацию «${s.locationId}». Опиши вход и спроси, куда герои направятся (номера помещений видны игрокам на плане).`
  }
  if (name === 'endCombat') {
    const last = [...s.log].reverse().find((e) => /Победа!|Команда отступила|Поражение/.test(e.text))
    return `Бой окончен. ${last?.text ?? ''} Опиши исход и продолжи сцену.`
  }
  if (name === 'restAll') return `Партия отдыхает в трактире. День ${s.day}.`
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
      for (const p of room.players.values()) for (const sid of p.sockets) io.to(sid).emit('room', room.view(p, !!gm))
    },
    chat(room, m) { const msg = room.addChat(m); io.to(room.code).emit('chat', msg); store.touch(room); return msg },
    delta(room, id, text) { io.to(room.code).emit('gm:delta', { id, text }) },
    done(room, id) { io.to(room.code).emit('gm:done', { id }) },
    notice(room, text) { io.to(room.code).emit('notice', text) },
    persist(room) { store.touch(room) },
  }
  const gm = opts.gm ? opts.gm(ctx) : null
  void socketsOf

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

    socket.on('room:create', async (req, ack) => {
      try {
        const mode: GmMode = req.gm === 'ai' || req.gm === 'human' ? req.gm : 'book'
        if (mode === 'ai' && !gm) throw new GameError('ИИ-ведущий не настроен на сервере (нужен ключ Claude API)')
        const state = req.state ? parseSave(JSON.stringify(req.state)) : undefined
        const r = await store.create(mode, state)
        const p = r.addPlayer(req.name, true)
        // герои из загруженного сохранения поначалу принадлежат хозяину
        p.heroUids = r.state.heroes.map((h) => h.uid)
        ctx.chat(r, { from: 'system', author: 'Игра', text: `Комната ${r.code} создана. Ведущий: ${mode === 'ai' ? 'ИИ' : mode === 'human' ? 'хозяин комнаты' : 'нет, читаем Книгу Жизни сами'}.` })
        await enter(r, p, ack)
      } catch (e) { fail(ack, e) }
    })

    socket.on('room:join', async (req, ack) => {
      try {
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

    socket.on('room:setGm', (mode, ack) => {
      try {
        if (!room || !player) throw new GameError('Вы не в комнате')
        if (!player.isHost) throw new GameError('Это может только хозяин комнаты')
        if (mode === 'ai' && !gm) throw new GameError('ИИ-ведущий не настроен на сервере')
        room.gm = mode
        ctx.chat(room, { from: 'system', author: 'Игра', text: `Режим ведущего: ${mode === 'ai' ? 'ИИ' : mode === 'human' ? 'хозяин комнаты' : 'без ведущего'}.` })
        ctx.roomChanged(room)
        store.touch(room)
        ack({ ok: true })
      } catch (e) { fail(ack, e) }
    })

    socket.on('room:loadState', (state, ack) => {
      try {
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

    socket.on('hero:claim', (heroUid, ack) => {
      try {
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

    socket.on('hero:release', (heroUid, ack) => {
      try {
        if (!room || !player) throw new GameError('Вы не в комнате')
        player.heroUids = player.heroUids.filter((u) => u !== heroUid)
        ctx.roomChanged(room)
        store.touch(room)
        ack({ ok: true })
      } catch (e) { fail(ack, e) }
    })

    socket.on('cmd', (req, ack) => {
      try {
        if (!room || !player) throw new GameError('Вы не в комнате')
        const r = room
        const p = player
        const args = Array.isArray(req.args) ? req.args : []
        const why = authorize(r.gm, p, req.name, args, (u) => r.heroOwned(u))
        if (why) throw new GameError(why)
        if (!isCommand(req.name)) throw new GameError('Неизвестная команда')
        const name = req.name
        const before = JSON.parse(JSON.stringify({ worldNodeId: r.state.worldNodeId, locationId: r.state.locationId, pendingRoad: r.state.pendingRoad })) as GameState
        const result = runCommand(r.session(), name, args as CommandArgs<typeof name>)
        // новый герой принадлежит тому, кто его создал
        if (name === 'addHero' && result && typeof result === 'object' && 'uid' in result) p.heroUids.push((result as { uid: string }).uid)
        if (name === 'quickStart' || name === 'newGame') {
          for (const x of r.players.values()) x.heroUids = []
          if (name === 'quickStart') p.heroUids = r.state.heroes.map((h) => h.uid)
        }
        if (name === 'removeHero' || name === 'quickStart' || name === 'newGame') r.pruneHeroes()
        ctx.stateChanged(r)
        if (['addHero', 'removeHero', 'quickStart', 'newGame'].includes(name)) ctx.roomChanged(r)
        ack({ ok: true, result: JSON.parse(JSON.stringify(result ?? null)) })
        if (r.gm === 'ai' && gm) {
          const ev = gmEventFor(name, r, before)
          if (ev) gm.enqueue(r, { kind: 'event', text: ev })
        }
      } catch (e) { fail(ack, e) }
    })

    socket.on('chat', (req, ack) => {
      try {
        if (!room || !player) throw new GameError('Вы не в комнате')
        const text = String(req.text ?? '').trim().slice(0, 1500)
        if (!text) throw new GameError('Пустое сообщение')
        const heroes = room.state.heroes.filter((h) => player!.heroUids.includes(h.uid)).map((h) => h.name)
        const author = heroes.length ? `${player.name} (${heroes.join(', ')})` : player.name
        const toGm = !!req.toGm && room.gm === 'ai'
        ctx.chat(room, { from: 'player', author, text, toGm })
        if (toGm && gm) gm.enqueue(room, { kind: 'player', author, text })
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
      await gm?.idle()
      await store.flush()
      await new Promise<void>((resolve) => { io.close(() => resolve()) })
    },
  }
}
