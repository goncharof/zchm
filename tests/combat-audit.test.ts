// Регрессии по аудиту боя: несколько атак за раунд, исход отступления, яд при потере сознания, Гидра, сбежавшие.
import { afterEach, describe, expect, it } from 'vitest'
import { idx } from '@/data'
import { changeLives, createHero, gainXp } from '@/engine/character'
import { checkEnd, heroAttack, monsterAttack, monsterCast, monstersTurn, regrowHeads, startCombat } from '@/engine/combat'
import { seededRng, setRng } from '@/engine/dice'
import { GameSession, blankGame } from '@/game/session'

afterEach(() => setRng(seededRng(1)))
const tough = () => { const w = createHero('Воин', 'warrior', idx); w.lives = w.maxLives = 500; return w }

describe('аудит боя', () => {
  it('«Атакует дважды»: берсеркер бьёт два раза за ход монстров; у Умертвия есть окаменение 16', () => {
    expect(idx.monster('berserker').attacksPerRound).toBe(2)
    expect(idx.monster('umertvie').extraAttacks).toContainEqual({ kind: 'petrify', threshold: 16 })
    const { state } = startCombat([{ monsterId: 'berserker', count: 1 }], idx)
    state.phase = 'melee'; state.turn = 'monsters'
    setRng(seededRng(4))
    const log = monstersTurn(state, [tough()], idx).filter((e) => e.text.startsWith('Берсеркер атакует'))
    expect(log).toHaveLength(2)
  })

  it('живые ушли, а в партии есть погибший — это отступление, а не поражение', () => {
    const { state } = startCombat([{ monsterId: 'ork', count: 1 }], idx)
    const w = createHero('Воин', 'warrior', idx)
    const dead = createHero('Вор', 'thief', idx)
    dead.lives = -10; dead.status.dead = true; dead.status.unconscious = true
    state.escaped.push(w.uid)
    checkEnd(state, [w, dead])
    expect(state.finished).toBe('fled')
  })

  it('яд монстра прекращается, когда герой теряет сознание', () => {
    const w = createHero('Воин', 'warrior', idx)
    w.status.poison = -1
    changeLives(w, -w.lives)
    expect(w.status.poison).toBeUndefined()
  })

  it('отросшая голова Гидры — без яда отрубленной; храбрость проверяется, когда отрублена половина голов', () => {
    const { state } = startCombat([{ monsterId: 'gidra', count: 1 }], idx)
    const heads = state.monsters
    heads[0].dead = true; heads[0].lives = 0; heads[0].poison = 3; heads[0].attackMultiplier = 0.5
    regrowHeads(state)
    expect(heads[0].dead).toBe(false)
    expect(heads[0].poison).toBeUndefined()
    expect(heads[0].attackMultiplier).toBe(1)
    for (const h of heads.slice(0, 5)) { h.dead = true; h.lives = 0 }
    state.phase = 'melee'; state.turn = 'monsters'
    setRng(() => 0.99) // к18 = 18 ≥ 11 — бежит
    const log = monstersTurn(state, [tough()], idx).map((e) => e.text).join(' ')
    expect(log).toContain('проверяет храбрость')
    expect(heads.filter((h) => !h.dead).every((h) => h.fled)).toBe(true)
  })

  it('сбежавший герой не теряет жизни от яда, пока остальные дерутся', () => {
    const { state } = startCombat([{ monsterId: 'ork', count: 1 }], idx)
    state.phase = 'melee'; state.turn = 'monsters'
    const gone = createHero('Вор', 'thief', idx)
    gone.status.poison = -1
    state.escaped.push(gone.uid)
    const lives = gone.lives
    monstersTurn(state, [tough(), gone], idx)
    expect(gone.lives).toBe(lives)
  })

  it('воин 12 уровня получает второе действие уже в раунде дистанции', () => {
    const s = new GameSession(blankGame(), null)
    const w = s.addHero('Воин', 'warrior')
    gainXp(w, 1_000_000, idx)
    expect(w.level).toBe(12)
    s.startEncounter([{ monsterId: 'ork', count: 1 }])
    expect(s.state.combat!.extraActions[w.uid]).toBe(1)
  })
})

describe('аудит боя: Металок и заклинания монстров из Бестиария', () => {
  it('Металок при 15+ разъедает немагическое оружие в руках вместо удара', () => {
    expect(idx.monster('metalok').destroysWeapon).toBe(15)
    const s = new GameSession(blankGame(), null)
    const w = s.addHero('Воин', 'warrior')
    w.money = 100
    s.buyItem(w.uid, 'weapon', 'mech-korotkiy')
    s.equipItem(w.uid, w.inventory[0].uid)
    const { state } = startCombat([{ monsterId: 'metalok', count: 1 }], idx)
    setRng(() => 0.99) // попадание, к18 = 18 ≥ 15
    const log = monsterAttack(state.monsters[0], w, idx).map((e) => e.text).join(' ')
    expect(log).toContain('рассыпается ржавчиной')
    expect(w.inventory.some((e) => e.ref === 'mech-korotkiy')).toBe(false)
    expect(w.lives).toBe(w.maxLives)
  })

  it('Чёрный жрец ставит «магический барьер» (Хрустальный щит): герой до 2 уровня натыкается на стену', () => {
    const { state } = startCombat([{ monsterId: 'chernyy-zhrets', count: 1 }], idx)
    const priest = state.monsters[0]
    priest.spells = ['магический барьер']
    setRng(() => 0) // к6 = 1 — колдует
    const log = monsterCast(state, priest, [tough()], idx)!.map((e) => e.text).join(' ')
    expect(log).toContain('Хрустальный щит')
    expect(priest.wards?.some((w) => w.kind === 'crystal')).toBe(true)
    const novice = createHero('Воин', 'warrior', idx)
    state.phase = 'melee'; state.turn = 'heroes'
    const out = heroAttack(state, novice, [novice], 'unarmed', priest.uid, idx)
    expect(out.log[0].text).toContain('незримый барьер')
    expect(priest.lives).toBe(priest.maxLives)
  })
})
