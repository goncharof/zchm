/** Загрузка справочных данных из JSON и построение индекса. */
import type { Armor, Artifact, CharacterClass, Item, Location, Monster, Spell, Weapon, WorldMap } from '@/types'
import { DataIndex, type GameData } from '@/engine/data'
import classes from './classes.json'
import weapons from './weapons.json'
import armor from './armor.json'
import items from './items.json'
import artifacts from './artifacts.json'
import spells from './spells.json'
import bestiary from './bestiary.json'
import locations from './locations.json'

export const gameData: GameData = {
  classes: classes as unknown as CharacterClass[],
  weapons: weapons as unknown as Weapon[],
  armor: armor as unknown as Armor[],
  items: items as unknown as Item[],
  artifacts: artifacts as unknown as Artifact[],
  spells: spells as unknown as Spell[],
  bestiary: bestiary as unknown as Monster[],
  locations: locations as unknown as Location[],
  world: null,
}

/** Карта мира подгружается отдельно (генерируется tools/build_world.py) */
export async function loadWorld(): Promise<WorldMap | null> {
  try {
    const mod = await import('./world.json')
    return (mod.default ?? mod) as unknown as WorldMap
  } catch {
    return null
  }
}

export const idx = new DataIndex(gameData)
