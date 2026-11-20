/**
 * Командные решения за столом (кнопки сценарного ведущего, в том числе выходы из помещений). ХАУСРУЛ владельца
 * (2026-11-20): «решения должны быть командными: небольшой таймер с „согласен / против“, если никто не нажал —
 * по умолчанию согласен». Первое нажатие — предложение и начало отсчёта; остальные могут поддержать его, выбрать
 * другой вариант или нажать «Против». Молчание — согласие: когда время вышло (или ответили все активные игроки),
 * срабатывает вариант с большинством поданных голосов. Ничья — решает голос хозяина, иначе тот, кто был раньше.
 * Большинство «против» — предложение снимается. Один игрок за столом решает сразу.
 */
import { GameError } from '@/game/session'
import type { ChatMessage } from '@/net/protocol'
import type { Room } from './rooms'

/** Сколько ждут возражений по умолчанию; 0 — без голосования: срабатывает первое нажатие */
export const VOTE_MS = 12_000
/** Голос «против»: ни один из вариантов */
export const REJECT = 'reject'

/** Решение нужно согласовывать, только если за столом больше одного активного игрока */
export function votingOn(room: Room, voteMs = VOTE_MS): boolean {
  return voteMs > 0 && room.activePlayers().length > 1
}

/** Отдать (или перенести) голос; первый голос запускает отсчёт. Возвращает сообщение с обновлённой сводкой голосов */
export function castVote(room: Room, playerId: string, messageId: string, choiceId: string, voteMs = VOTE_MS): ChatMessage {
  const msg = room.chatById(messageId)
  if (!msg) throw new GameError('Этот вариант уже недоступен')
  const open = Object.keys(room.votes[messageId] ?? {}).length > 0
  if (choiceId === REJECT) {
    if (!open) throw new GameError('Возражать пока не на что: никто ничего не предложил')
  } else {
    if (!msg.choices?.some((c) => c.id === choiceId)) throw new GameError('Этот вариант уже недоступен')
    if (msg.used?.includes(choiceId)) throw new GameError('Этот вариант уже выбран')
  }
  const ballot = (room.votes[messageId] ??= {})
  delete ballot[playerId] // перенос голоса — в конец очереди
  ballot[playerId] = choiceId
  if (!open || !msg.voteUntil) msg.voteUntil = Date.now() + voteMs
  refreshVotes(room, msg)
  return msg
}

/** Сводка голосов в сообщении: вариант → имена проголосовавших; сколько осталось до решения */
export function refreshVotes(room: Room, msg: ChatMessage): void {
  const ballot = room.votes[msg.id] ?? {}
  const view: Record<string, { id: string; name: string }[]> = {}
  for (const [pid, cid] of Object.entries(ballot)) (view[cid] ??= []).push({ id: pid, name: room.players.get(pid)?.name ?? 'игрок' })
  if (Object.keys(view).length) {
    msg.votes = view
    // часы клиента могут отличаться от серверных: клиенту уходит, сколько осталось, а не момент
    if (msg.voteUntil) msg.voteLeft = Math.max(0, msg.voteUntil - Date.now())
  } else {
    delete msg.votes
    delete msg.voteUntil
    delete msg.voteLeft
  }
}

/** Решение можно принять сразу: ответили все активные игроки */
export function voteComplete(room: Room, messageId: string): boolean {
  const ballot = room.votes[messageId] ?? {}
  const active = room.activePlayers()
  // никого за столом — не решаем за ушедших
  return active.length > 0 && active.every((p) => ballot[p.id])
}

/** Победивший вариант (или REJECT) и игрок, от чьего имени он выполняется (его герой действует) */
export function tally(room: Room, messageId: string): { choiceId: string; playerId: string } | null {
  const ballot = Object.entries(room.votes[messageId] ?? {})
  if (!ballot.length) return null
  const count = new Map<string, number>()
  for (const [, cid] of ballot) count.set(cid, (count.get(cid) ?? 0) + 1)
  const top = Math.max(...count.values())
  const leaders = [...count.entries()].filter(([, n]) => n === top).map(([cid]) => cid)
  const host = [...room.players.values()].find((p) => p.isHost)
  const hostVote = host ? room.votes[messageId]?.[host.id] : undefined
  const choiceId = hostVote && leaders.includes(hostVote) ? hostVote : ballot.find(([, cid]) => leaders.includes(cid))![1]
  const voter = (hostVote === choiceId && host ? host.id : undefined) ?? ballot.find(([, cid]) => cid === choiceId)![0]
  return { choiceId, playerId: voter }
}

/** Подвести итог (время вышло, ответили все или хозяин торопит): победивший вариант нажимается от имени своего
 *  игрока; победило «против» — вызывается rejected. Вариант мог стать недоступным (выбран без голосования,
 *  сообщение вытеснено) — это не повод ронять сервер */
export function resolveVote(
  room: Room,
  messageId: string,
  ctx: { updateChat(room: Room, m: ChatMessage): void },
  choose: (playerId: string, messageId: string, choiceId: string) => void,
  rejected?: (label: string, by: string[]) => void,
): void {
  const win = tally(room, messageId)
  const view = room.chatById(messageId)?.votes ?? {}
  clearVotes(room, messageId)
  const msg = room.chatById(messageId)
  if (msg) ctx.updateChat(room, msg)
  if (!win) return
  if (win.choiceId === REJECT) {
    // что отклонили: вариант, за который голосов было больше всего
    const proposed = Object.entries(view).filter(([cid]) => cid !== REJECT).sort((a, b) => b[1].length - a[1].length)[0]?.[0]
    rejected?.(msg?.choices?.find((c) => c.id === proposed)?.label ?? '', (view[REJECT] ?? []).map((v) => v.name))
    return
  }
  try { choose(win.playerId, messageId, win.choiceId) } catch (e) {
    if (!(e instanceof Error && e.name === 'GameError')) console.error('[голосование]', e)
  }
}

/** Убрать голосование по сообщению */
export function clearVotes(room: Room, messageId: string): void {
  delete room.votes[messageId]
  const msg = room.chatById(messageId)
  if (msg) {
    delete msg.votes
    delete msg.voteUntil
    delete msg.voteLeft
  }
}
