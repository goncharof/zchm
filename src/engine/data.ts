/** Контейнер справочных данных. Движок получает его параметром и не импортирует JSON сам. */
import type { Armor, Artifact, CharacterClass, Item, Monster, Spell, Weapon, Location, LocationPlan, WorldMap } from '@/types'

export interface GameData {
  classes: CharacterClass[]
  weapons: Weapon[]
  armor: Armor[]
  items: Item[]
  artifacts: Artifact[]
  spells: Spell[]
  bestiary: Monster[]
  locations: Location[]
  /** планы локаций как графы помещений (src/data/plans.json); у локации без плана ходят по номерам, как раньше */
  plans?: LocationPlan[]
  world: WorldMap | null
}

export class DataIndex {
  readonly classById = new Map<string, CharacterClass>()
  readonly weaponById = new Map<string, Weapon>()
  readonly armorById = new Map<string, Armor>()
  readonly itemById = new Map<string, Item>()
  readonly artifactByN = new Map<number, Artifact>()
  readonly spellById = new Map<string, Spell>()
  readonly monsterById = new Map<string, Monster>()
  readonly locationById = new Map<string, Location>()
  readonly planById = new Map<string, LocationPlan>()

  constructor(readonly data: GameData) {
    for (const c of data.classes) this.classById.set(c.id, c)
    for (const w of data.weapons) this.weaponById.set(w.id, w)
    for (const a of data.armor) this.armorById.set(a.id, a)
    for (const i of data.items) this.itemById.set(i.id, i)
    for (const a of data.artifacts) this.artifactByN.set(a.n, a)
    for (const s of data.spells) this.spellById.set(s.id, s)
    for (const m of data.bestiary) this.monsterById.set(m.id, m)
    for (const l of data.locations) this.locationById.set(l.id, l)
    for (const p of data.plans ?? []) this.planById.set(p.id, p)
  }

  cls(id: string): CharacterClass {
    const c = this.classById.get(id)
    if (!c) throw new Error(`Неизвестный класс: ${id}`)
    return c
  }
  weapon(id: string): Weapon {
    const w = this.weaponById.get(id)
    if (!w) throw new Error(`Неизвестное оружие: ${id}`)
    return w
  }
  armor(id: string): Armor {
    const a = this.armorById.get(id)
    if (!a) throw new Error(`Неизвестный доспех: ${id}`)
    return a
  }
  item(id: string): Item {
    const i = this.itemById.get(id)
    if (!i) throw new Error(`Неизвестная вещь: ${id}`)
    return i
  }
  artifact(n: number): Artifact {
    const a = this.artifactByN.get(n)
    if (!a) throw new Error(`Неизвестный артефакт: ${n}`)
    return a
  }
  spell(id: string): Spell {
    const s = this.spellById.get(id)
    if (!s) throw new Error(`Неизвестное заклинание: ${id}`)
    return s
  }
  monster(id: string): Monster {
    const m = this.monsterById.get(id)
    if (!m) throw new Error(`Неизвестный монстр: ${id}`)
    return m
  }
}
