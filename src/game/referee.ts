/** Напоминания-рефери: что по правилам назрело у героев и спутников. Общие для сценарного ведущего (сетевая комната)
 *  и экрана локации одиночной игры */
import type { GameState } from '@/engine/model'

export function reminders(s: GameState): string[] {
  const out: string[] = []
  for (const h of s.heroes) {
    if (h.status.dead) { out.push(`${h.name} погиб: заменить героя можно на экране «Партия».`); continue }
    if (h.status.unconscious) out.push(`${h.name} без сознания: нужны лечение, бутылка или отдых.`)
    else if (h.lives <= Math.max(3, Math.floor(h.maxLives / 4))) out.push(`${h.name} при смерти (${h.lives} из ${h.maxLives}): лечение, бутылка или трактир.`)
    if (h.status.poison) out.push(`${h.name} отравлен: противоядие или «Исцеление».`)
    if (h.pendingSpellPicks > 0) out.push(`${h.name}: не выбрано заклинание за новый уровень (${h.pendingSpellPicks}) — экран героя.`)
  }
  for (const c of s.companions) if (c.battlesLeft === 1) out.push(`${c.name} остаётся с партией на один бой.`)
  return out
}
