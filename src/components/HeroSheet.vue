<script setup lang="ts">
import { computed, ref } from 'vue'
import { idx } from '@/data'
import type { EquipSlot, Hero, InventoryEntry } from '@/engine/model'
import { heroAccuracy, heroDefense, heroDexterity, heroLuck, heroStrength, heroWeapons, levelRow } from '@/engine/character'
import { entryName, entryPrice } from '@/engine/inventory'
import { useGameStore } from '@/stores/game'
import { SLOT_NAMES, attacksStr, pct } from '@/ui/format'
import SpellPicker from './SpellPicker.vue'
import SpellCaster from './SpellCaster.vue'

const props = defineProps<{ hero: Hero; shop?: boolean }>()
const store = useGameStore()
const cls = computed(() => idx.cls(props.hero.classId))
const next = computed(() => (props.hero.level < 12 ? levelRow(cls.value, props.hero.level + 1).xp : null))
const showPicker = ref(false)
const transferTo = ref('')
const renaming = ref(false)
const newName = ref(props.hero.name)

const equipped = computed(() => (Object.entries(props.hero.equipment) as [EquipSlot, string][]).map(([slot, uid]) => {
  const e = props.hero.inventory.find((x) => x.uid === uid)
  return { slot, name: e ? entryName(e, idx) : '?', detail: e ? detail(e) : '' }
}))

function detail(e: InventoryEntry): string {
  if (e.kind === 'weapon') { const w = idx.weapon(e.ref); return w.attacks ? `атаки ${attacksStr(w.attacks)}` : '' }
  if (e.kind === 'armor') { const a = idx.armor(e.ref); return a.defense ? `защита ${a.defense}` : a.defenseBonus ? `защита +${a.defenseBonus}` : a.strengthBonus ? `сила +${a.strengthBonus}` : '' }
  if (e.kind === 'artifact') { const a = idx.artifact(parseInt(e.ref, 10)); return [a.attacks && `атаки ${attacksStr(a.attacks)}`, a.defense && `защита ${a.defense}`, a.defenseBonus && `защита +${a.defenseBonus}`, a.strengthBonus && `сила +${a.strengthBonus}`, a.luckBonus && `удача +${a.luckBonus}`, a.accuracyBonus && `меткость +${a.accuracyBonus}`].filter(Boolean).join(', ') }
  if (e.kind === 'scroll') { const s = idx.spell(e.ref); return `${s.level} ур.` }
  if (e.kind === 'item') return idx.item(e.ref).description
  return ''
}
function isEquipped(e: InventoryEntry) { return Object.values(props.hero.equipment).includes(e.uid) }
function canEquip(e: InventoryEntry) { return e.kind === 'weapon' ? idx.weapon(e.ref).group !== 'ammo' : e.kind === 'armor' || e.kind === 'artifact' }
const needsArrows = computed(() => heroWeapons(props.hero, idx).some((w) => w.needsAmmo && !w.ammoEntry))
function act(fn: () => void) { try { fn() } catch (e) { store.say((e as Error).message) } }
const statusText = computed(() => {
  const s = props.hero.status
  const out: string[] = []
  if (s.dead) out.push('мёртв'); else if (s.unconscious) out.push('без сознания')
  if (s.poison) out.push('отравлен'); if (s.paralysis) out.push(`паралич ${s.paralysis}`); if (s.freeze) out.push(`оледенение ${s.freeze}`); if (s.petrified) out.push('окаменел')
  return out.join(', ')
})
</script>

<template>
  <div class="card" :class="{ 'hero-down': hero.status.dead }">
    <div class="row between">
      <h2 v-if="!renaming">{{ hero.name }} <span class="badge accent">{{ cls.name }} {{ hero.level }} ур.</span> <span v-if="statusText" class="badge" style="border-color:var(--danger);color:var(--danger)">{{ statusText }}</span></h2>
      <div v-else class="row"><input v-model="newName" /><button class="small primary" @click="store.renameHero(hero.uid, newName); renaming = false">Ок</button></div>
      <div class="row">
        <button class="small" @click="renaming = !renaming">Имя</button>
        <button class="small danger" @click="store.removeHero(hero.uid)">Убрать</button>
      </div>
    </div>
    <div class="row" style="gap:1rem;margin:.4rem 0 .6rem">
      <div style="flex:1;min-width:160px"><div class="small">Жизни {{ hero.lives }}/{{ hero.maxLives }}</div><div class="bar" :class="{ danger: hero.lives * 3 <= hero.maxLives }"><i :style="{ width: pct(hero.lives, hero.maxLives) }" /></div></div>
      <div v-if="hero.maxMana" style="flex:1;min-width:160px"><div class="small">Мана {{ hero.mana }}/{{ hero.maxMana }}</div><div class="bar mana"><i :style="{ width: pct(hero.mana, hero.maxMana) }" /></div></div>
    </div>
    <div class="stat-table">
      <div><b>Опыт</b> {{ hero.xp }}<span v-if="next" class="muted"> / {{ next }}</span></div>
      <div><b>Сила</b> {{ heroStrength(hero, idx) }}</div>
      <div><b>Ловкость</b> {{ heroDexterity(hero) }}</div>
      <div><b>Меткость</b> {{ heroAccuracy(hero, idx) }}</div>
      <div><b>Удача</b> {{ heroLuck(hero, idx) }}</div>
      <div><b>Защита</b> {{ heroDefense(hero, idx) }}</div>
      <div><b>Монеты</b> {{ hero.money }}</div>
    </div>

    <div v-if="hero.buffs.length" class="row small" style="margin-top:.4rem"><span class="muted">Эффекты:</span><span v-for="(b, i) in hero.buffs" :key="i" class="badge accent">{{ b.source }}</span></div>
    <div v-if="hero.pendingSpellPicks > 0" class="row" style="margin-top:.6rem">
      <button class="primary" @click="showPicker = true">Выбрать новое заклинание ({{ hero.pendingSpellPicks }})</button>
    </div>
    <SpellPicker v-if="showPicker" :hero="hero" @close="showPicker = false" />

    <h3 style="margin-top:.9rem">Снаряжение</h3>
    <div v-if="!equipped.length" class="muted small">Ничего не надето: защита 9, атаки без оружия 1-1-1-2-2-2.</div>
    <table v-else class="list">
      <tbody>
        <tr v-for="e in equipped" :key="e.slot"><td class="muted">{{ SLOT_NAMES[e.slot] }}</td><td>{{ e.name }} <span class="small muted">{{ e.detail }}</span></td><td style="text-align:right"><button class="small" @click="store.unequipItem(hero.uid, e.slot)">Снять</button></td></tr>
      </tbody>
    </table>

    <p v-if="needsArrows" class="small" style="color:var(--danger);margin-top:.3rem">Лук без стрел: купите стрелы в лавке.</p>
    <h3 style="margin-top:.9rem">Инвентарь</h3>
    <div v-if="!hero.inventory.length" class="muted small">Пусто.</div>
    <table v-else class="list">
      <tbody>
        <tr v-for="e in hero.inventory" :key="e.uid">
          <td>{{ entryName(e, idx) }}<span v-if="e.qty > 1"> ×{{ e.qty }}</span><span v-if="e.poisoned" class="badge" style="margin-left:.3rem">яд</span><div class="small muted">{{ detail(e) }}</div></td>
          <td style="text-align:right;white-space:nowrap">
            <template v-if="canEquip(e) && !isEquipped(e)">
              <button class="small" @click="act(() => store.equipItem(hero.uid, e.uid))">Надеть</button>
              <button v-if="e.kind === 'weapon' && idx.weapon(e.ref).hand === 'any'" class="small" @click="act(() => store.equipItem(hero.uid, e.uid, 'leftHand'))">В левую</button>
              <button v-if="e.kind === 'weapon' && idx.weapon(e.ref).throwable" class="small" @click="act(() => store.equipItem(hero.uid, e.uid, 'ranged'))">Метать</button>
            </template>
            <button v-if="e.kind === 'bottle'" class="small" @click="act(() => store.drink(hero.uid, e.uid))">Выпить</button>
            <button v-if="e.kind === 'bottle' && !e.identified" class="small" @click="act(() => store.identifyBottle(hero.uid, e.uid))">Распознать</button>
            <button v-if="e.kind === 'scroll'" class="small" @click="act(() => store.copyScroll(hero.uid, e.uid))">В книгу</button>
            <button v-if="(e.kind === 'weapon' || e.kind === 'artifact') && !e.poisoned && hero.inventory.some(x => x.kind === 'item' && x.ref === 'yad')" class="small" @click="act(() => store.poisonWeapon(hero.uid, e.uid))">Смазать ядом</button>
            <button v-if="shop && entryPrice(e, idx) > 0" class="small" @click="act(() => store.sellItem(hero.uid, e.uid))">Продать за {{ Math.floor(entryPrice(e, idx) / 2) }}</button>
            <select v-if="store.heroes.length > 1" class="small" v-model="transferTo" @change="act(() => { if (transferTo) store.transferItem(hero.uid, transferTo, e.uid); transferTo = '' })">
              <option value="">Передать…</option>
              <option v-for="h in store.heroes.filter(x => x.uid !== hero.uid)" :key="h.uid" :value="h.uid">{{ h.name }}</option>
            </select>
            <button class="small" @click="store.dropItem(hero.uid, e.uid, e.qty)">✕</button>
          </td>
        </tr>
      </tbody>
    </table>

    <template v-if="cls.caster">
      <h3 style="margin-top:.9rem">Книга заклинаний</h3>
      <div v-if="!store.combat" style="margin-bottom:.5rem"><SpellCaster :hero="hero" :in-combat="false" /></div>
      <table class="list">
        <tbody>
          <tr v-for="id in hero.spellbook" :key="id">
            <td>{{ idx.spell(id).level }} ур.</td><td><b>{{ idx.spell(id).name }}</b> <span class="small muted">мана {{ idx.spell(id).cost ?? idx.spell(id).costFormula }}</span><div class="small muted">{{ idx.spell(id).description }}</div></td>
          </tr>
        </tbody>
      </table>
    </template>

    <details style="margin-top:.8rem"><summary class="muted small">Ручная правка (ведущий)</summary>
      <div class="row" style="margin-top:.4rem">
        <button class="small" @click="store.adjustLives(hero.uid, -1)">−1 жизнь</button><button class="small" @click="store.adjustLives(hero.uid, 1)">+1 жизнь</button>
        <button class="small" @click="store.adjustLives(hero.uid, hero.maxLives)">Все жизни</button>
        <button v-if="hero.maxMana" class="small" @click="store.adjustMana(hero.uid, hero.maxMana)">Вся мана</button>
        <button class="small" @click="store.adjustMoney(hero.uid, 10)">+10 монет</button><button class="small" @click="store.adjustMoney(hero.uid, -10)">−10 монет</button>
        <button class="small" @click="store.giveXp(hero.uid, 100)">+100 опыта</button>
        <button class="small" @click="store.giveItem(hero.uid, 'bottle', String(1 + Math.floor(Math.random() * 6)))">Случайная бутылка</button>
      </div>
    </details>
  </div>
</template>
