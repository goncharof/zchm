// Обход Книги Жизни ботом (tools/qa/book-walk.ts): каждый этап открывается хотя бы в одной игре, сценарный ведущий
// проходит параграфы кнопками без сбоев; сам бот находит испорченную разметку.
import { describe, expect, it } from 'vitest'
import type { BookNode } from '@/types'
import { allNodes } from '@/game/tree'
import { GameSession, blankGame } from '@/game/session'
import { seededRng, setRng } from '@/engine/dice'
import { explore, integrity, scriptRuns, walkBook, type Finding } from '../tools/qa/book-walk'
import { Room } from '../server/rooms'
import { executeGmTool } from '../server/gm/tools'
import { ScriptedGm } from '../server/gm/script'

const P = 'zolotoy-gorod:1'
const unreachable = (tree: BookNode) => {
  const e = explore(tree, P, [])
  return allNodes(tree).filter((n) => !e.opened.has(n.id)).map((n) => n.id)
}
const problems = (tree: BookNode) => {
  const out: Omit<Finding, 'loc' | 'n' | 'hand'>[] = []
  integrity(tree, 'zolotoy-gorod', (f) => out.push(f))
  return out.map((f) => `${f.id}: ${f.what}`)
}

describe('обход Книги Жизни', () => {
  it('в книге нет этапов, которые не открываются, и сломанной разметки', () => {
    const bad = walkBook().filter((f) => f.level !== 'check')
    expect(bad.map((f) => `${f.loc} § ${f.n} ${f.id ?? ''}: ${f.what}`)).toEqual([])
  })

  it('сценарный ведущий проходит все параграфы кнопками без сбоев', () => {
    const r = scriptRuns(undefined, 4)
    expect(r.findings.map((f) => `${f.loc} § ${f.n}: ${f.what}`)).toEqual([])
    // бот действительно играет: за 4 игры на параграф ставится больше половины отметок модели (полный прогон — 97%)
    expect(r.covered / r.total).toBeGreaterThan(0.6)
  })

  it('бот находит исход победы без боя, исход удачи без проверки и вариант за чужим выбором из exclusive', () => {
    expect(unreachable({ id: 'a', on: 'enter', text: [], then: [{ id: 'w', on: 'win', text: [{ t: 'награда' }] }] })).toEqual(['w'])
    expect(unreachable({ id: 'a', on: 'enter', text: [], hints: { monsters: ['ork'] }, then: [{ id: 'w', on: 'win', text: [] }] })).toEqual([])
    expect(unreachable({ id: 'a', on: 'enter', text: [], hints: { luck: [10] }, then: [{ id: 'f', on: 'fail', text: [] }, { id: 'o', on: 'ok', text: [] }] })).toEqual([])
    expect(unreachable({ id: 'a', on: 'enter', text: [], then: [{ id: 'o', on: 'ok', text: [] }] })).toEqual(['o'])
    // нужна отметка соседнего варианта, а выбрать можно только один
    const tree: BookNode = { id: 'a', on: 'enter', text: [], exclusive: true, then: [
      { id: 'b', on: 'choice', label: 'Налево', text: [] },
      { id: 'c', on: 'choice', label: 'Направо', text: [], then: [{ id: 'd', on: { mark: [`${P}:b:open`] }, text: [] }] },
    ] }
    expect(unreachable(tree)).toEqual(['d'])
    expect(unreachable({ ...tree, exclusive: undefined })).toEqual([])
  })

  it('бот находит вариант без подписи, исход вне кубика и переход в несуществующее помещение', () => {
    expect(problems({ id: 'a', on: 'enter', text: [], dice: { sides: 6 }, goto: 999, then: [
      { id: 'b', on: 'choice', text: [] },
      { id: 'r', on: { roll: [5, 7] }, text: [] },
    ] })).toEqual([
      'a: переход в помещение 999, которого нет в «Золотой город»',
      'b: вариант выбора без подписи (кнопка будет пустой)',
      'r: исход броска 5, 7 не выпадает на к6',
    ])
  })

  it('бой книги с 60 орками начинается и с кнопки, и у ИИ-ведущего (Крепость рыцарей, § 41)', () => {
    setRng(seededRng(4))
    const s = new GameSession(blankGame(), null)
    s.quickStart()
    s.startEncounter([{ monsterId: 'ork', count: 60 }], undefined, 'krepost-rytsarey:41:a')
    expect(s.state.combat!.monsters).toHaveLength(60)
    expect(() => new GameSession(blankGame(), null).startEncounter([{ monsterId: 'ork', count: 61 }])).toThrow('Неверное число монстров')
    const room = new Room('T', 'ai', blankGame(), null)
    room.session().quickStart()
    executeGmTool(room, 'start_combat', { monsters: [{ id: 'skelet', count: 40 }] })
    expect(room.state.combat!.monsters).toHaveLength(40)
  })

  it('сценарный ведущий действует героем игрока, который в сознании: дуэль с Чёрным магом не упирается в лежащего', () => {
    setRng(seededRng(9))
    const room = new Room('T', 'script', blankGame(), null)
    room.session().quickStart()
    const p = room.addPlayer('Игрок', true)
    p.heroUids = room.state.heroes.map((h) => h.uid)
    room.state.locationId = 'zamok-chernogo-maga'
    room.state.heroes[0].status.unconscious = true
    const gm = new ScriptedGm({ stateChanged() {}, roomChanged() {}, chat: (r, m) => r.addChat(m), updateChat() {}, delta() {}, done() {}, notice() {}, persist() {} })
    gm.presentParagraph(room, 'zamok-chernogo-maga', 13, p.id)
    const msg = room.chat.at(-1)!
    const duel = msg.choices!.find((c) => c.label.startsWith('⚔ Атаковать'))!
    gm.choose(room, p.id, msg.id, duel.id)
    expect(room.chat.at(-1)!.text).not.toContain('не может сражаться')
    expect(room.chat.at(-1)!.text).toContain(room.state.heroes[1].name)
  })
})
