/** Кто какие команды вправе выполнять в комнате. */
import { COMMANDS, type CommandName } from '@/game/session'
import type { GmMode } from '@/net/protocol'

export interface PlayerRights {
  isHost: boolean
  heroUids: string[]
}

export function isCommand(name: string): name is CommandName {
  return Object.prototype.hasOwnProperty.call(COMMANDS, name)
}

/** null — можно; строка — причина отказа */
export function authorize(gm: GmMode, player: PlayerRights, name: string, args: unknown[], heroOwned: (heroUid: string) => boolean): string | null {
  if (!isCommand(name)) return 'Неизвестная команда'
  const role = COMMANDS[name]
  switch (role) {
    case 'host':
      return player.isHost ? null : 'Это может только хозяин комнаты'
    case 'party':
      return null
    case 'gm':
      if (gm === 'ai') return 'Это решает ведущий'
      if (gm === 'human') return player.isHost ? null : 'Это решает ведущий'
      return null
    case 'owner': {
      const heroUid = args[0]
      if (typeof heroUid !== 'string') return 'Не указан герой'
      if (player.heroUids.includes(heroUid)) return null
      // хозяин может действовать за любого героя, кроме игры с ИИ-ведущим
      if (player.isHost && gm !== 'ai') return null
      // ничей герой — может любой игрок (например, после ухода владельца)
      if (!heroOwned(heroUid)) return null
      return 'Это не ваш герой'
    }
  }
}
