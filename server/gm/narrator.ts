/**
 * Рассказчик поверх сценарного ведущего: модель дописывает одну-две фразы атмосферы к сцене, которую ведущий уже
 * показал. Механику не трогает, историю не ведёт, инструментов нет — запрос крошечный, отказ модели ничем не вредит
 * (остаётся запасная строка из FLAVOR). Модели перебираются по той же цепочке и с теми же паузами, что у ИИ-ведущего.
 */
import { ProviderError, type LlmProvider } from './types'

export const NARRATOR_SYSTEM = `Ты рассказчик настольной ролевой игры «Заклятье Чёрного мага» (1997). Игроки уже прочли сцену из Книги Жизни, механику ведёт движок. Допиши одну-две короткие фразы атмосферы по-русски: звуки, запахи, свет, холод, тишина, что чувствуют герои. Нельзя: добавлять существ, предметы, двери, события и числа, раскрывать тайны, описывать исход боя или следующие действия, давать советы, обращаться к игрокам. Только текст без заголовков, списков и кавычек, не больше 40 слов.`

export interface NarrateRequest {
  /** «Золотой город, помещение 7» */
  place: string
  event: 'enter' | 'victory' | 'fled' | 'defeat' | 'travel'
  /** видимый игрокам текст сцены (без пометок ведущего) */
  scene: string
  /** прошлая фраза рассказчика: модель повторяет одни и те же образы («тусклый свет», «тяжёлое предчувствие») */
  previous?: string
}

const EVENT: Record<NarrateRequest['event'], string> = {
  enter: 'герои только что вошли сюда',
  victory: 'бой только что выигран, противники повержены',
  fled: 'герои только что бежали из боя',
  defeat: 'герои только что проиграли бой',
  travel: 'партия в пути',
}

/** Ответ модели → одна-две чистые фразы; мусор (списки, скобки, латиница, обрывок) — null */
export function cleanNarration(raw: string): string | null {
  let t = raw.replace(/\s+/g, ' ').replace(/["«»“”]/g, '').trim()
  if (!t || /[[\]{}<>*#]|^[-•]/.test(t) || /[a-z]{3,}/i.test(t)) return null
  const sentences = t.match(/[^.!?…]+[.!?…]+/g) ?? [t]
  t = sentences.slice(0, 2).map((x) => x.trim()).join(' ')
  if (t.length > 320 || t.split(/\s+/).length < 3) return null
  return t
}

export class Narrator {
  constructor(private providers: LlmProvider[], private cooling: Map<string, number>, private scale = 1) {}

  available(): boolean {
    return this.providers.some((p) => !!p.complete)
  }

  async narrate(req: NarrateRequest): Promise<string | null> {
    const user = `Место: ${req.place}. Событие: ${EVENT[req.event]}. Сцена: «${req.scene.slice(0, 1200)}»${req.previous ? `\nПрошлая твоя фраза была: «${req.previous}» — не повторяй её образы и слова.` : ''}`
    for (const p of this.providers) {
      if (!p.complete || (this.cooling.get(p.id) ?? 0) > Date.now()) continue
      try {
        // пустой или мусорный ответ — не повод ставить модель на паузу, но и гонять цепочку ради атмосферы не стоит
        // рассуждающие модели съедают короткий лимит на размышления и отдают пустой ответ — лимит с запасом
        const raw = await p.complete(NARRATOR_SYSTEM, user, 400)
        const text = cleanNarration(raw)
        if (text) return text
        console.log(`[рассказчик ${p.label}] ответ отброшен: ${raw.replace(/\s+/g, ' ').slice(0, 120) || '(пусто)'}`)
      } catch (e) {
        const err = e instanceof ProviderError ? e : new ProviderError(String((e as Error)?.message ?? e), 30_000)
        this.cooling.set(p.id, Date.now() + err.cooldownMs * this.scale)
        console.warn('[рассказчик]', err.message)
      }
    }
    return null
  }
}
