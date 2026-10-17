/** Инвентарь: покупка/продажа, экипировка, бутылки, свитки, вещи. */
import type { Artifact, Weapon } from '@/types'
import type { DataIndex } from './data'
import type { EquipSlot, Hero, InventoryEntry, InventoryKind } from './model'
import { uid } from './model'
import { artifactSlot, canUseWeapon, changeLives, entryByUid, heroLuck } from './character'
import { k18, rollFormula } from './dice'
import { BOTTLES, DEAD_AT } from './rules'
import { TROPHIES } from './loot'

const STACKABLE: InventoryKind[] = ['item', 'bottle', 'trophy']

export function addToInventory(hero: Hero, kind: InventoryKind, ref: string, qty = 1, extra: Partial<InventoryEntry> = {}): InventoryEntry {
  if (STACKABLE.includes(kind) || isAmmo(kind, ref)) {
    const same = hero.inventory.find((e) => e.kind === kind && e.ref === ref && !!e.identified === !!extra.identified)
    if (same) {
      same.qty += qty
      return same
    }
  }
  const entry: InventoryEntry = { uid: uid('inv'), kind, ref, qty, ...extra }
  hero.inventory.push(entry)
  return entry
}

function isAmmo(kind: InventoryKind, ref: string): boolean {
  return kind === 'weapon' && /strela|drotik/.test(ref)
}

export function removeFromInventory(hero: Hero, entryUid: string, qty = 1): void {
  const i = hero.inventory.findIndex((e) => e.uid === entryUid)
  if (i < 0) return
  const e = hero.inventory[i]
  e.qty -= qty
  if (e.qty <= 0) {
    hero.inventory.splice(i, 1)
    for (const slot of Object.keys(hero.equipment) as EquipSlot[]) {
      if (hero.equipment[slot] === entryUid) delete hero.equipment[slot]
    }
  }
}

export function entryName(e: InventoryEntry, idx: DataIndex): string {
  switch (e.kind) {
    case 'weapon': return idx.weapon(e.ref).name
    case 'armor': return idx.armor(e.ref).name
    case 'item': return idx.item(e.ref).name
    case 'artifact': return idx.artifact(parseInt(e.ref, 10)).name
    case 'scroll': return `Свиток: ${e.identified === false ? '?' : idx.spell(e.ref).name}`
    case 'bottle': return e.identified ? `Бутылка (${e.ref}): ${BOTTLES[parseInt(e.ref, 10) - 1]?.label}` : 'Бутылка без этикетки'
    case 'trophy': return TROPHIES[e.ref]?.name ?? e.ref
  }
}

export function entryPrice(e: InventoryEntry, idx: DataIndex): number {
  switch (e.kind) {
    case 'weapon': return idx.weapon(e.ref).price
    case 'armor': return idx.armor(e.ref).price
    case 'item': return idx.item(e.ref).price
    default: return 0
  }
}

export function buy(hero: Hero, kind: 'weapon' | 'armor' | 'item', ref: string, idx: DataIndex, qty = 1): InventoryEntry {
  const price = entryPrice({ uid: '', kind, ref, qty: 1 }, idx) * qty
  if (hero.money < price) throw new Error('Не хватает монет')
  hero.money -= price
  return addToInventory(hero, kind, ref, qty)
}

/** Цена продажи одной штуки. ХАУСРУЛ: половина цены лавки (в правилах цену трофеев назначает ведущий);
 *  у шкур и ятаганов цена из Бестиария */
export function salePrice(e: InventoryEntry, idx: DataIndex): number {
  if (e.kind === 'trophy') return TROPHIES[e.ref]?.price ?? 0
  return Math.floor(entryPrice(e, idx) / 2)
}

export function sell(hero: Hero, entryUid: string, idx: DataIndex, qty = 1): number {
  const e = entryByUid(hero, entryUid)
  if (!e) return 0
  const gain = salePrice(e, idx) * qty
  hero.money += gain
  removeFromInventory(hero, entryUid, qty)
  return gain
}

export function unequip(hero: Hero, slot: EquipSlot): void {
  delete hero.equipment[slot]
}

/** Надевает/берёт в руки предмет. Возвращает занятый слот. Бросает ошибку, если класс не может этим пользоваться. */
export function equip(hero: Hero, entryUid: string, idx: DataIndex, preferredSlot?: EquipSlot): EquipSlot {
  const e = entryByUid(hero, entryUid)
  if (!e) throw new Error('Предмета нет в инвентаре')
  const cls = idx.cls(hero.classId)
  const place = (slot: EquipSlot) => {
    for (const s of Object.keys(hero.equipment) as EquipSlot[]) if (hero.equipment[s] === entryUid) delete hero.equipment[s]
    hero.equipment[slot] = entryUid
    return slot
  }
  if (e.kind === 'weapon') {
    const w = idx.weapon(e.ref)
    if (!canUseWeapon(cls, w)) throw new Error(`${cls.name} не может пользоваться: ${w.name}`)
    if (w.group === 'ammo') throw new Error('Это боеприпас, его не берут в руки')
    if (w.ranged && !w.throwable) return place('ranged')
    if (w.throwable && preferredSlot === 'ranged') return place('ranged')
    return placeMelee(hero, entryUid, w.hand ?? 'any', !!cls.oneHandOnly, preferredSlot)
  }
  if (e.kind === 'armor') {
    const a = idx.armor(e.ref)
    if (a.slot === 'shield') checkShield(hero, idx)
    return place(a.slot)
  }
  if (e.kind === 'artifact') {
    const n = parseInt(e.ref, 10)
    const a = idx.artifact(n)
    const slot = artifactSlot(n)
    if (slot === 'melee' || slot === 'ranged') {
      const pseudo: Weapon = { id: a.id, name: a.name, group: artifactGroup(a), price: 0, hand: a.hand, ranged: slot === 'ranged' || undefined }
      if (!canUseWeapon(cls, pseudo)) throw new Error(`${cls.name} не может пользоваться: ${a.name}`)
    }
    if (slot === 'shield') checkShield(hero, idx)
    if (slot === 'melee') return placeMelee(hero, entryUid, a.hand ?? 'any', !!cls.oneHandOnly, preferredSlot)
    if (slot === 'ranged') return place('ranged')
    if (slot === 'accessory1') {
      if (preferredSlot === 'accessory2' || (hero.equipment.accessory1 && !hero.equipment.accessory2)) return place('accessory2')
      return place('accessory1')
    }
    return place(slot)
  }
  throw new Error('Этот предмет нельзя надеть')
}

/** Группа оружия артефакта по названию (для ограничений класса) */
export function artifactGroup(a: Artifact): Weapon['group'] {
  const n = a.name.toLowerCase()
  if (/лук/.test(n)) return 'bow'
  if (/палиц/.test(n)) return 'mace'
  if (/кинжал/.test(n)) return 'dagger'
  if (/топор/.test(n)) return 'axe'
  if (/меч|экскалибур/.test(n)) return 'sword'
  return 'other'
}

/** ХАУСРУЛ: щит доступен всем классам (книга ограничивает магов и жрецов только оружием), но не с двуручным оружием */
function checkShield(hero: Hero, idx: DataIndex): void {
  const r = hero.equipment.rightHand && entryByUid(hero, hero.equipment.rightHand)
  if (r && handOf(r, idx) === 'two') throw new Error('Щит нельзя держать вместе с двуручным оружием')
  if (hero.equipment.leftHand) delete hero.equipment.leftHand
}

function handOf(e: InventoryEntry, idx: DataIndex): string | undefined {
  if (e.kind === 'weapon') return idx.weapon(e.ref).hand
  if (e.kind === 'artifact') return idx.artifact(parseInt(e.ref, 10)).hand
  return undefined
}

function placeMelee(hero: Hero, entryUid: string, hand: 'any' | 'right' | 'two', oneHandOnly: boolean, preferred?: EquipSlot): EquipSlot {
  for (const s of Object.keys(hero.equipment) as EquipSlot[]) if (hero.equipment[s] === entryUid) delete hero.equipment[s]
  if (hand === 'two') {
    delete hero.equipment.leftHand
    delete hero.equipment.shield
    hero.equipment.rightHand = entryUid
    return 'rightHand'
  }
  if (hand === 'right' || oneHandOnly) {
    hero.equipment.rightHand = entryUid
    return 'rightHand'
  }
  // оружие "для любой руки"
  if (preferred === 'leftHand' || (hero.equipment.rightHand && !hero.equipment.leftHand && !hero.equipment.shield)) {
    hero.equipment.leftHand = entryUid
    return 'leftHand'
  }
  hero.equipment.rightHand = entryUid
  return 'rightHand'
}

export interface BottleResult {
  n: number
  text: string
  delta: number
  died: boolean
}

/** Выпить бутылку (стр. 16). Бросок удачи от бутылки смерти — 9. */
export function drinkBottle(hero: Hero, entryUid: string, idx: DataIndex): BottleResult {
  const e = entryByUid(hero, entryUid)
  if (!e || e.kind !== 'bottle') throw new Error('Это не бутылка')
  const n = parseInt(e.ref, 10)
  const rule = BOTTLES[n - 1]
  removeFromInventory(hero, entryUid, 1)
  if (rule.effect === 'death') {
    const r = k18()
    const luck = heroLuck(hero, idx)
    if (r + luck >= (rule.luck ?? 9)) {
      return { n, text: `Яд! Бросок удачи ${r}+${luck} ≥ ${rule.luck} — ${hero.name} выплёвывает отраву и остаётся жив.`, delta: 0, died: false }
    }
    hero.lives = DEAD_AT
    changeLives(hero, 0)
    return { n, text: `Смертельный яд. Бросок удачи ${r}+${luck} < ${rule.luck}. ${hero.name} погибает.`, delta: 0, died: true }
  }
  if (rule.effect === 'restore-all') {
    const delta = changeLives(hero, hero.maxLives - hero.lives)
    return { n, text: `Живая вода! Все жизни восстановлены (+${delta}).`, delta, died: false }
  }
  const f = rule.formula ?? '+1к3'
  const sign = f.startsWith('-') ? -1 : 1
  const res = rollFormula(f.replace(/^[+-]/, ''))
  const delta = changeLives(hero, sign * res.total)
  return { n, text: `${sign < 0 ? 'Отрава' : 'Целебный напиток'}: ${f} → ${delta >= 0 ? '+' : ''}${delta} жизней.`, delta, died: hero.status.dead === true }
}

/** Переписать свиток в книгу: уровень кастера должен быть выше уровня заклинания (стр. 21) */
export function copyScroll(hero: Hero, entryUid: string, idx: DataIndex): string {
  const e = entryByUid(hero, entryUid)
  if (!e || e.kind !== 'scroll') throw new Error('Это не свиток')
  const spell = idx.spell(e.ref)
  const cls = idx.cls(hero.classId)
  if (!cls.caster) throw new Error(`${cls.name} не владеет магией — для него это просто пергамент`)
  if (cls.caster !== spell.caster) throw new Error(`Это заклинание ${spell.caster === 'mage' ? 'мага' : 'жреца'}`)
  if (hero.level <= spell.level) throw new Error(`Нужен уровень выше ${spell.level}. Свиток можно прочесть один раз в бою.`)
  if (!hero.spellbook.includes(spell.id)) hero.spellbook.push(spell.id)
  removeFromInventory(hero, entryUid, 1)
  return `${spell.name} переписано в книгу, свиток исчезает в холодном белом огне.`
}

export function useAntidote(target: Hero, owner: Hero, idx: DataIndex): void {
  const e = owner.inventory.find((x) => x.kind === 'item' && idx.item(x.ref).id.startsWith('protivoyad'))
  if (!e) throw new Error('Нет противоядия')
  removeFromInventory(owner, e.uid, 1)
  delete target.status.poison
}

export function useParalysisPotion(target: Hero, owner: Hero, idx: DataIndex): void {
  if (target.uid === owner.uid) throw new Error('Парализованный не может применить зелье сам')
  const e = owner.inventory.find((x) => x.kind === 'item' && idx.item(x.ref).id.startsWith('zele'))
  if (!e) throw new Error('Нет зелья от паралича')
  removeFromInventory(owner, e.uid, 1)
  delete target.status.paralysis
}

/** Смазать оружие ядом (стр. 22): действует при первом попадании. Палицы мазать нельзя. */
export function poisonWeapon(hero: Hero, weaponUid: string, idx: DataIndex): void {
  const poison = hero.inventory.find((x) => x.kind === 'item' && idx.item(x.ref).id === 'yad')
  if (!poison) throw new Error('Нет яда')
  const w = entryByUid(hero, weaponUid)
  if (!w || (w.kind !== 'weapon' && w.kind !== 'artifact')) throw new Error('Это не оружие')
  if (w.kind === 'weapon' && idx.weapon(w.ref).group === 'mace') throw new Error('Палицы ядом не смазывают')
  removeFromInventory(hero, poison.uid, 1)
  w.poisoned = true
}
