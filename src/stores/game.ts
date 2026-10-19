/**
 * Главное хранилище интерфейса. Игровая логика — в src/game/session.ts (GameSession):
 * в одиночной игре команды выполняются здесь же над локальным состоянием,
 * в сетевой — отправляются на сервер (src/net/client.ts), а состояние приходит оттуда.
 */
import { defineStore } from 'pinia'
import { computed, ref, shallowRef, watch } from 'vue'
import type { Caster, WorldMap } from '@/types'
import { idx, loadWorld } from '@/data'
import type { CombatState, EquipSlot, GameState, Hero, InventoryKind, LogEntry } from '@/engine/model'
import type { EncounterSpec } from '@/engine/combat'
import type { CastResult } from '@/engine/spells'
import { GameSession, blankGame, migrate, parseSave, runCommand, type CommandArgs, type CommandName, type CommandResult } from '@/game/session'
import { NetClient, savedSession } from '@/net/client'
import type { ChatMessage, GmMode, RoomView, TurnMode } from '@/net/protocol'
import type { NetStatus } from '@/net/client'

const SAVE_KEY = 'zchm.save.v1'

function readSave(): GameState | null {
  try {
    const raw = localStorage.getItem(SAVE_KEY)
    return raw ? parseSave(raw) : null
  } catch {
    return null
  }
}

export const useGameStore = defineStore('game', () => {
  const game = ref<GameState | null>(readSave())
  const world = ref<WorldMap | null>(null)
  const notice = ref<string>('')
  /** сетевая игра: клиент и сведения о комнате (null — одиночная игра) */
  const net = shallowRef<NetClient | null>(null)
  const room = ref<RoomView | null>(null)
  const chat = ref<ChatMessage[]>([])
  /** реплики ведущего, которые сейчас пишутся (id → текст) */
  const streaming = ref<Record<string, string>>({})
  /** связь с сервером сетевой игры */
  const netStatus = ref<NetStatus>('connecting')
  /** возврат за стол после обновления страницы: joining — входим, waiting — сервер недоступен, ждём связи */
  const rejoinState = ref<'idle' | 'joining' | 'waiting'>('idle')

  // непрочитанное в чате: время последнего просмотренного сообщения, отдельно для каждой комнаты (переживает обновление)
  const chatSeenT = ref(0)
  const seenKey = (code: string) => `zchm.chat.seen.${code}`
  const isMine = (m: ChatMessage) => m.from === 'player' && !!room.value && m.playerId === room.value.me.id
  const unread = computed(() => chat.value.filter((m) => m.t > chatSeenT.value && m.from !== 'system' && !isMine(m)).length)
  function markChatSeen(): void {
    const last = chat.value.reduce((t, m) => Math.max(t, m.t), 0)
    if (last <= chatSeenT.value) return
    chatSeenT.value = last
    try { if (room.value) localStorage.setItem(seenKey(room.value.code), String(last)) } catch { /* нет хранилища */ }
  }
  const connecting = ref(false)
  loadWorld().then((w) => { world.value = w })

  const online = computed(() => !!net.value && !!room.value)
  const heroes = computed<Hero[]>(() => game.value?.heroes ?? [])
  const combat = computed<CombatState | null>(() => game.value?.combat ?? null)
  const location = computed(() => (game.value?.locationId ? idx.locationById.get(game.value.locationId) ?? null : null))
  const worldNode = computed(() => world.value?.nodes.find((n) => n.id === game.value?.worldNodeId) ?? null)
  const started = computed(() => !!game.value && game.value.heroes.length > 0)
  /** ведущий-машина (ИИ или сценарный): текст Книги Жизни игрокам не показывается */
  const aiGm = computed(() => online.value && (room.value?.gm === 'ai' || room.value?.gm === 'script'))
  /** этот зритель — ведущий (живой ведущий в сетевой игре) или игра без ведущего */
  const isGm = computed(() => !online.value || (room.value?.gm === 'human' && room.value.me.isHost) || room.value?.gm === 'book')
  /** герои, которыми управляет этот игрок (в одиночной игре — все) */
  /** Герои, которыми можно управлять (как в server/permissions.ts): свои; хозяин без автоведущего — любые; ничьи — любой игрок */
  const myHeroUids = computed<string[]>(() => {
    if (!online.value || !room.value) return heroes.value.map((h) => h.uid)
    const r = room.value
    if (r.me.isHost && r.gm !== 'ai' && r.gm !== 'script') return heroes.value.map((h) => h.uid)
    const owned = new Set(r.players.flatMap((p) => p.heroUids))
    return heroes.value.filter((h) => r.me.heroUids.includes(h.uid) || !owned.has(h.uid)).map((h) => h.uid)
  })
  const canControl = (heroUid: string) => myHeroUids.value.includes(heroUid)
  /** Герой закреплён за мной (сетевая игра) */
  const isMineHero = (heroUid: string) => !!room.value?.me.heroUids.includes(heroUid)

  // автосохранение — только для одиночной игры (сетевую хранит сервер). Время сохранения пишется в копию: правка
  // самого состояния внутри глубокого наблюдателя перезапускала его снова и снова, пока Vue не обрывал цикл
  watch(game, (g) => {
    if (net.value) return
    if (!g) { localStorage.removeItem(SAVE_KEY); return }
    try { localStorage.setItem(SAVE_KEY, JSON.stringify({ ...g, updatedAt: Date.now() })) } catch { /* переполнение хранилища — игнорируем */ }
  }, { deep: true })

  function say(text: string): void {
    notice.value = text
    setTimeout(() => { if (notice.value === text) notice.value = '' }, 4000)
  }
  function hero(heroUid: string): Hero {
    const h = heroes.value.find((x) => x.uid === heroUid)
    if (!h) throw new Error('Герой не найден')
    return h
  }

  /** Выполнить команду: локально (синхронно, до первого await) или на сервере */
  async function cmd<K extends CommandName>(name: K, ...args: CommandArgs<K>): Promise<CommandResult<K> | undefined> {
    try {
      if (net.value && room.value) return (await net.value.call(name, args)) as CommandResult<K>
      if (!game.value) game.value = blankGame()
      return runCommand(new GameSession(game.value, world.value), name, args)
    } catch (e) {
      say((e as Error).message || 'Ошибка')
      if (!(e instanceof Error) || e.name !== 'GameError') console.error(e)
      return undefined
    }
  }

  // ---------- сеть ----------
  function attachNet(client: NetClient): void {
    net.value = client
    client.onState((state) => { game.value = migrate(state) })
    client.onRoom((r) => { room.value = r })
    client.onNotice((text) => say(text))
    client.onStatus((st) => { netStatus.value = st })
    client.onLost((why) => { say(`Не удалось вернуться за стол: ${why}`); detachNet() })
    // история приходит при входе: недописанный текст ведущего сервер пришлёт заново целиком
    client.onChatHistory((ms) => { chat.value = ms; streaming.value = {} })
    client.onRoom((r) => {
      netStatus.value = 'online'
      rejoinState.value = 'idle'
      // впервые в этой комнате — история считается прочитанной; после возвращения — непрочитанным остаётся пропущенное
      let seen: number | null = null
      try { const v = localStorage.getItem(seenKey(r.code)); seen = v ? Number(v) : null } catch { /* нет хранилища */ }
      if (seen === null) { chatSeenT.value = 0; markChatSeen() } else chatSeenT.value = Math.max(chatSeenT.value, seen)
    })
    client.onChat((m) => {
      chat.value.push(m)
      if (chat.value.length > 300) chat.value.splice(0, chat.value.length - 300)
      if (streaming.value[m.id] !== undefined) { const s = { ...streaming.value }; delete s[m.id]; streaming.value = s }
    })
    client.onGmDelta(({ id, text }) => { streaming.value = { ...streaming.value, [id]: (streaming.value[id] ?? '') + text } })
    // ход закончен: недописанный текст (модель упала и ход передан дальше) убирается
    client.onGmDone(({ id }) => { if (streaming.value[id] !== undefined) { const s = { ...streaming.value }; delete s[id]; streaming.value = s } })
    client.onChatUpdate((m) => { const i = chat.value.findIndex((x) => x.id === m.id); if (i >= 0) chat.value.splice(i, 1, m) })
  }
  function detachNet(): void {
    net.value?.close()
    net.value = null
    room.value = null
    chat.value = []
    streaming.value = {}
    // экран возврата за стол закрывается, а прочитанное в этой комнате не переносится на следующую
    rejoinState.value = 'idle'
    chatSeenT.value = 0
    game.value = readSave()
  }
  function ensureNet(url?: string): NetClient {
    if (!net.value) attachNet(new NetClient(url))
    return net.value!
  }
  async function netAction<T>(fn: (c: NetClient) => Promise<T>, url?: string): Promise<T | undefined> {
    connecting.value = true
    try {
      return await fn(ensureNet(url))
    } catch (e) {
      say((e as Error).message || 'Нет связи с сервером')
      if (!room.value) detachNet()
      return undefined
    } finally {
      connecting.value = false
    }
  }
  /** Создать комнату; withParty — взять с собой текущую одиночную партию */
  const createRoom = (name: string, gm: GmMode, withParty: boolean) => netAction((c) => c.create(name, gm, withParty && game.value ? JSON.parse(JSON.stringify(game.value)) : undefined))
  const joinRoom = (code: string, name: string) => netAction((c) => c.join(code, name))
  /** Вернуться в комнату после перезагрузки страницы. Сервер недоступен — ждать связи, а не забывать вход */
  async function rejoin(): Promise<void> {
    const s = savedSession()
    if (!s || net.value) return
    const c = ensureNet(s.url)
    rejoinState.value = 'joining'
    connecting.value = true
    try {
      await c.join(s.code, s.name, s.token)
    } catch (e) {
      const msg = (e as Error).message
      if (/не найдена/.test(msg)) { say(`Комнаты ${s.code} больше нет`); rejoinState.value = 'idle'; detachNet() }
      else if (net.value) { rejoinState.value = 'waiting'; c.waitRejoin(s) }
    } finally {
      connecting.value = false
    }
  }
  /** Не ждать сервер: играть без сети (вход в комнату забывается) */
  function abandonRejoin(): void {
    net.value?.forget()
    rejoinState.value = 'idle'
    detachNet()
  }
  function leaveRoom(): void {
    const c = net.value
    if (c) void c.leave().catch(() => {})
    rejoinState.value = 'idle'
    detachNet()
  }
  const sendChat = (text: string, toGm: boolean, asGm = false) => netAction((c) => c.chat(text, toGm, asGm))
  const choose = (messageId: string, choiceId: string) => netAction((c) => c.choose(messageId, choiceId))
  const claimHero = (heroUid: string) => netAction((c) => c.claimHero(heroUid))
  const releaseHero = (heroUid: string) => netAction((c) => c.releaseHero(heroUid))
  const setGmMode = (gm: GmMode) => netAction((c) => c.setGm(gm))
  const setTurnMode = (mode: TurnMode) => netAction((c) => c.setTurnMode(mode))
  const claimHost = () => netAction((c) => c.claimHost())
  const setReady = (ready: boolean) => netAction((c) => c.setReady(ready))
  const turnGo = () => netAction((c) => c.turnGo())
  function ownerOf(heroUid: string): string | null {
    return room.value?.players.find((p) => p.heroUids.includes(heroUid))?.name ?? null
  }

  // ---------- партия и сохранения (локальное) ----------
  function resetGame(): void {
    if (online.value) { detachNet(); return }
    game.value = null
  }
  function exportSave(): string {
    return JSON.stringify(game.value, null, 1)
  }
  /** Загрузить сохранение; в сетевой игре — на сервер (может только хозяин), успех — после ответа сервера */
  async function importSave(text: string): Promise<boolean> {
    const g = parseSave(text)
    if (online.value) return (await netAction(async (c) => { await c.loadState(g); return true })) ?? false
    game.value = g
    return true
  }
  const SLOT_KEY = (n: number) => `zchm.slot.${n}`
  function slotInfo(n: number): { day: number; heroes: string; savedAt: number } | null {
    try {
      const raw = localStorage.getItem(SLOT_KEY(n))
      if (!raw) return null
      const g = JSON.parse(raw) as GameState
      return { day: g.day, heroes: g.heroes.map((h) => h.name).join(', '), savedAt: g.updatedAt }
    } catch {
      return null
    }
  }
  function saveSlot(n: number): void {
    if (!game.value) return
    localStorage.setItem(SLOT_KEY(n), JSON.stringify({ ...game.value, updatedAt: Date.now() }))
    say(`Сохранено в слот ${n}`)
  }
  function loadSlot(n: number): void {
    const raw = localStorage.getItem(SLOT_KEY(n))
    if (!raw) { say('Слот пуст'); return }
    void importSave(raw).then((ok) => { if (ok) say(`Загружен слот ${n}`) })
  }
  function clearSlot(n: number): void {
    localStorage.removeItem(SLOT_KEY(n))
  }

  // ---------- команды (тонкие обёртки над GameSession) ----------
  const c = {
    note: (text: string, kind: LogEntry['kind'] = 'info') => cmd('note', text, kind),
    newGame: (startNodeId?: string) => cmd('newGame', startNodeId),
    quickStart: () => cmd('quickStart'),
    addHero: (name: string, classId: string) => cmd('addHero', name, classId),
    removeHero: (heroUid: string) => cmd('removeHero', heroUid),
    renameHero: (heroUid: string, name: string) => cmd('renameHero', heroUid, name),
    setStart: (nodeId: string) => cmd('setStart', nodeId),
    toggleGm: () => cmd('toggleGm'),
    buyItem: (heroUid: string, kind: 'weapon' | 'armor' | 'item', ref: string, qty = 1) => cmd('buyItem', heroUid, kind, ref, qty),
    sellItem: (heroUid: string, entryUid: string, qty = 1) => cmd('sellItem', heroUid, entryUid, qty),
    equipItem: (heroUid: string, entryUid: string, slot?: EquipSlot) => cmd('equipItem', heroUid, entryUid, slot),
    unequipItem: (heroUid: string, slot: EquipSlot) => cmd('unequipItem', heroUid, slot),
    giveItem: (heroUid: string, kind: InventoryKind, ref: string, qty = 1, identified?: boolean) => cmd('giveItem', heroUid, kind, ref, qty, identified),
    dropItem: (heroUid: string, entryUid: string, qty = 1) => cmd('dropItem', heroUid, entryUid, qty),
    transferItem: (fromUid: string, toUid: string, entryUid: string) => cmd('transferItem', fromUid, toUid, entryUid),
    drink: (heroUid: string, entryUid: string) => cmd('drink', heroUid, entryUid),
    identifyBottle: (heroUid: string, entryUid: string) => cmd('identifyBottle', heroUid, entryUid),
    copyScroll: (heroUid: string, entryUid: string) => cmd('copyScroll', heroUid, entryUid),
    learnSpell: (heroUid: string, spellId: string) => cmd('learnSpell', heroUid, spellId),
    useAntidote: (ownerUid: string, targetUid: string) => cmd('useAntidote', ownerUid, targetUid),
    useParalysisPotion: (ownerUid: string, targetUid: string) => cmd('useParalysisPotion', ownerUid, targetUid),
    poisonWeapon: (heroUid: string, weaponUid: string) => cmd('poisonWeapon', heroUid, weaponUid),
    adjustLives: (heroUid: string, delta: number) => cmd('adjustLives', heroUid, delta),
    adjustMana: (heroUid: string, delta: number) => cmd('adjustMana', heroUid, delta),
    adjustMoney: (heroUid: string, delta: number) => cmd('adjustMoney', heroUid, delta),
    giveXp: (heroUid: string, amount: number) => cmd('giveXp', heroUid, amount),
    restAll: (days: number) => cmd('restAll', days),
    travelTo: (nodeId: string) => cmd('travelTo', nodeId),
    enterLocation: (locationId: string) => cmd('enterLocation', locationId),
    leaveLocation: () => cmd('leaveLocation'),
    markVisited: (locationId: string, n: number) => cmd('markVisited', locationId, n),
    dismissRoad: (n: number) => cmd('dismissRoad', n),
    rollDie: (sides: number, context?: string) => cmd('rollDie', sides, context),
    rollDice: (formula: string) => cmd('rollDice', formula),
    luckCheck: (heroUid: string, target: number) => cmd('luckCheck', heroUid, target),
    findArtifact: (heroUid: string) => cmd('findArtifact', heroUid),
    giveScroll: (heroUid: string, caster?: Caster, level?: number) => cmd('giveScroll', heroUid, caster, level),
    trapFound: (heroUid: string) => cmd('trapFound', heroUid),
    claim: (key: string) => cmd('claim', key),
    finalDuelAttack: (heroUid: string) => cmd('finalDuelAttack', heroUid),
    drinkFountain: () => cmd('drinkFountain'),
    addCompanion: (monsterId: string, battles = 3) => cmd('addCompanion', monsterId, battles),
    dismissCompanion: (companionUid: string) => cmd('dismissCompanion', companionUid),
    startEncounter: (specs: EncounterSpec[], returnTo?: string) => cmd('startEncounter', specs, returnTo),
    attack: (heroUid: string, slot: EquipSlot | 'unarmed' | 'spell', targetUid: string) => cmd('attack', heroUid, slot, targetUid),
    cast: (heroUid: string, spellId: string, opts: { targetUid?: string; targetHeroUid?: string; targetEntryUid?: string; param?: number; scrollUid?: string } = {}): Promise<CastResult | undefined> => cmd('cast', heroUid, spellId, opts),
    flee: (heroUid: string) => cmd('flee', heroUid),
    skip: (heroUid: string) => cmd('skip', heroUid),
    toMelee: () => cmd('toMelee'),
    monstersAct: () => cmd('monstersAct'),
    endCombat: () => cmd('endCombat'),
    setAllowDuplicateClasses: (on: boolean) => cmd('setAllowDuplicateClasses', on),
    takeLoot: (heroUid: string, lootUid: string) => cmd('takeLoot', heroUid, lootUid),
    abortCombat: () => cmd('abortCombat'),
    endHeroesTurn: () => cmd('endHeroesTurn'),
    addMonstersToCombat: (specs: EncounterSpec[]) => cmd('addMonstersToCombat', specs),
  }

  return {
    game, world, notice, net, room, online, aiGm, isGm, myHeroUids, canControl, isMine: isMineHero, chat, netStatus, rejoinState, abandonRejoin, unread, markChatSeen, isMineMsg: isMine, streaming, connecting,
    createRoom, joinRoom, rejoin, leaveRoom, sendChat, choose, claimHero, releaseHero, setGmMode, setTurnMode, claimHost, setReady, turnGo, ownerOf,
    heroes, combat, location, worldNode, started,
    say, hero, cmd, attachNet, detachNet,
    resetGame, exportSave, importSave, slotInfo, saveSlot, loadSlot, clearSlot,
    ...c,
  }
})
