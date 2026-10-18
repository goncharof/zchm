/**
 * Трофеи после боя (Инструкция, «Трофеи»: «после боя вы можете обобрать трупы убитых врагов и пополнить запас
 * своих вещей трофейными оружием и доспехами»). Что у кого есть — по описаниям в Бестиарии.
 */
import type { CombatState, InventoryKind, MonsterInstance } from './model'
import { uid } from './model'

/** Вещи, которых нет в таблицах лавки; цена — сколько дают при продаже (из Бестиария) */
export const TROPHIES: Record<string, { name: string; price: number }> = {
  // «продать орочий ятаган можно только за 5 монет»
  'orochiy-yatagan': { name: 'орочий ятаган', price: 5 },
  // «прочную шкуру, за которую вам в любой лавке отвалят 20 монет»
  'shkura-gargulisa': { name: 'шкура гаргулиса', price: 20 },
  // «Шкура саблезубого тигра стоит 50 монет»
  'shkura-sablezubogo-tigra': { name: 'шкура саблезубого тигра', price: 50 },
}

export type LootKind = Extract<InventoryKind, 'weapon' | 'armor' | 'trophy'>

export interface LootItem {
  uid: string
  kind: LootKind
  ref: string
  /** с кого снято (имя монстра) */
  from: string
}

const W = (ref: string) => ({ kind: 'weapon' as const, ref })
const A = (ref: string) => ({ kind: 'armor' as const, ref })
const T = (ref: string) => ({ kind: 'trophy' as const, ref })

/** id монстра → снаряжение по описанию. ХАУСРУЛ: великанские дубины героям не по руке и не берутся */
export const MONSTER_LOOT: Record<string, { kind: LootKind; ref: string }[]> = {
  amazonka: [W('mech-korotkiy')], // «Вооружены короткими мечами»
  berserker: [W('mech-korotkiy'), W('mech-korotkiy')], // «два коротких меча»
  gnoll: [W('kinzhal-serebryanyy')], // «Любимое оружие — серебряный кинжал»
  gurr: [W('kinzhal')], // «Пользуются простыми кинжалами»
  dvarf: [W('boevoy-topor-dvuruchnyy')], // «тяжелый боевой топор» — двуручный (так он назван в запрете для воров, Инструкция)
  kentavr: [W('korotkiy-luk')], // «Вооружен коротким луком»
  kobold: [W('mech-korotkiy')], // «Оружием кобольдов являются короткие мечи»
  lyudoed: [W('palitsa')], // «Обычно оружием людоедов является палица»
  ork: [T('orochiy-yatagan')], // «вооруженные ятаганами»
  'uruk-hay': [T('orochiy-yatagan')], // ятаган; урук-хаи «считают себя именно орками» — цена как у орочьего
  razboynik: [W('kinzhal')], // «Вооружены кинжалами»
  rytsar: [W('mech-shirokiy')], // «Вооружен широким мечом»
  'rytsar-smerti': [W('mech-dlinnyy')], // «Вооружены длинными мечами»
  strazhnik: [W('mech-korotkiy'), A('schit')], // «Вооружен коротким мечом и щитом»
  hazg: [W('dlinnyy-luk')], // «Используют длинные луки»
  nazgul: [W('mech-dlinnyy')], // «В бою используют длинные мечи»
  gargulis: [T('shkura-gargulisa')],
  'sablezubyy-tigr': [T('shkura-sablezubogo-tigra')],
}

/** Трофеи с убитых монстров (сбежавшие и окаменевшие ничего не оставляют) */
export function collectLoot(monsters: MonsterInstance[]): LootItem[] {
  return monsters
    .filter((m) => m.dead && !m.petrified && !m.summoned)
    .flatMap((m) => (MONSTER_LOOT[m.monsterId] ?? []).map((it) => ({ uid: uid('loot'), ...it, from: m.name })))
}

/** Снять трофей с поля боя (после победы) */
export function takeLootItem(state: CombatState, lootUid: string): LootItem {
  if (state.finished !== 'victory') throw new Error('Трофеи собирают после победы')
  const i = (state.loot ?? []).findIndex((x) => x.uid === lootUid)
  if (i < 0) throw new Error('Этот трофей уже забрали')
  return state.loot!.splice(i, 1)[0]
}
