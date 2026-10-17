/**
 * Голосование за варианты сценарного ведущего в режиме «когда все готовы»: нажатие кнопки — голос,
 * вариант срабатывает, когда проголосовали все активные игроки. Ничья — решает голос хозяина,
 * иначе вариант, за который проголосовали раньше.
 */
import { GameError } from '@/game/session'
import type { ChatMessage } from '@/net/protocol'
import type { Room } from './rooms'

/** Голосование нужно, только если за столом больше одного активного игрока */
export function votingOn(room: Room): boolean {
  return room.turnMode === 'ready' && room.activePlayers().length > 1
}

/** Отдать (или перенести) голос; возвращает сообщение с обновлённой сводкой голосов */
export function castVote(room: Room, playerId: string, messageId: string, choiceId: string): ChatMessage {
  const msg = room.chatById(messageId)
  if (!msg?.choices?.some((c) => c.id === choiceId)) throw new GameError('Этот вариант уже недоступен')
  if (msg.used?.includes(choiceId)) throw new GameError('Этот вариант уже выбран')
  const ballot = (room.votes[messageId] ??= {})
  delete ballot[playerId] // перенос голоса — в конец очереди
  ballot[playerId] = choiceId
  refreshVotes(room, msg)
  return msg
}

/** Сводка голосов в сообщении: вариант → имена проголосовавших */
export function refreshVotes(room: Room, msg: ChatMessage): void {
  const ballot = room.votes[msg.id] ?? {}
  const view: Record<string, { id: string; name: string }[]> = {}
  for (const [pid, cid] of Object.entries(ballot)) (view[cid] ??= []).push({ id: pid, name: room.players.get(pid)?.name ?? 'игрок' })
  if (Object.keys(view).length) msg.votes = view
  else delete msg.votes
}

/** Голосование по сообщению завершено: проголосовали все активные игроки */
export function voteComplete(room: Room, messageId: string): boolean {
  const ballot = room.votes[messageId] ?? {}
  const active = room.activePlayers()
  // никого за столом — не решаем за ушедших
  return active.length > 0 && active.every((p) => ballot[p.id])
}

/** Победивший вариант и игрок, от чьего имени он выполняется (его герой действует) */
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

/** Убрать голосование по сообщению */
export function clearVotes(room: Room, messageId: string): void {
  delete room.votes[messageId]
  const msg = room.chatById(messageId)
  if (msg) delete msg.votes
}
