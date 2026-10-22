<script setup lang="ts">
import { computed, ref } from 'vue'
import { Pencil, Trash2 } from 'lucide-vue-next'
import { idx } from '@/data'
import type { EquipSlot, Hero, InventoryEntry } from '@/engine/model'
import { BOW_GROUPS, artifactSlot, heroAccuracy, heroDefense, heroDexterity, heroLuck, heroStrength, heroWeapons, levelRow } from '@/engine/character'
import { artifactGroup, entryName, salePrice } from '@/engine/inventory'
import { useGameStore } from '@/stores/game'
import { SLOT_NAMES, attacksStr, classArt, pct } from '@/ui/format'
import SpellPicker from './SpellPicker.vue'
import SpellCaster from './SpellCaster.vue'

const props = defineProps<{ hero: Hero; shop?: boolean }>()
const store = useGameStore()
const cls = computed(() => idx.cls(props.hero.classId))
const next = computed(() => (props.hero.level < 12 ? levelRow(cls.value, props.hero.level + 1).xp : null))
const prevXp = computed(() => levelRow(cls.value, props.hero.level).xp)
const showPicker = ref(false)
/** чужой герой в сетевой игре — только просмотр */
const ro = computed(() => !store.canControl(props.hero.uid))
const owner = computed(() => store.ownerOf(props.hero.uid))
/** ручная правка — для ведущего (в игре без ведущего — для всех) */
const gmTools = computed(() => store.isGm && !store.aiGm)
const transferTo = ref('')
/** распознаватель напитков есть у кого-то в партии (иначе кнопка «Распознать» только ругалась бы) */
const hasRecognizer = computed(() => store.heroes.some((x) => x.inventory.some((i) => i.kind === 'item' && i.ref === 'raspoznavatel-napitkov')))
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
  if (e.kind === 'trophy') return 'трофей, только на продажу'
  return ''
}
/** Ядом смазывают оружие, кроме палиц (и палицы-артефакта) */
function canPoison(e: InventoryEntry): boolean {
  if (e.poisoned) return false
  // палицы не смазывают; лук и арбалет тоже — смазывают стрелы (10 за порцию)
  if (e.kind === 'weapon') return idx.weapon(e.ref).group !== 'mace' && !BOW_GROUPS.includes(idx.weapon(e.ref).group)
  if (e.kind !== 'artifact') return false
  const a = idx.artifact(parseInt(e.ref, 10))
  const slot = artifactSlot(a.n)
  return slot === 'melee' && artifactGroup(a) !== 'mace'
}
function isEquipped(e: InventoryEntry) { return Object.values(props.hero.equipment).includes(e.uid) }
function canEquip(e: InventoryEntry) { return e.kind === 'weapon' ? idx.weapon(e.ref).group !== 'ammo' : e.kind === 'armor' || e.kind === 'artifact' }
const needsArrows = computed(() => heroWeapons(props.hero, idx).some((w) => w.needsAmmo && !w.ammoEntry))
/** убрать героя — только после подтверждения: на телефоне кнопку легко задеть */
function remove() { if (confirm(`Убрать героя «${props.hero.name}» из партии?`)) store.removeHero(props.hero.uid) }
function rename() { store.renameHero(props.hero.uid, newName.value); renaming.value = false }
function act(fn: () => void) { try { fn() } catch (e) { store.say((e as Error).message) } }
const statusText = computed(() => {
  const s = props.hero.status
  const out: string[] = []
  if (s.dead) out.push('мёртв'); else if (s.unconscious) out.push('без сознания')
  if (s.poison) out.push('отравлен'); if (s.paralysis) out.push(`паралич ${s.paralysis}`); if (s.freeze) out.push(`оледенение ${s.freeze}`); if (s.petrified) out.push('окаменел')
  if (s.choke) out.push(`удушье ${s.choke}`); if (s.charmed) out.push('очарован'); if (s.cursed) out.push('проклят')
  return out.join(', ')
})
</script>

<template>
  <div class="card" :class="{ 'hero-down': hero.status.dead }">
    <div class="sheet-head">
      <img :src="classArt(hero.classId)" alt="" class="portrait" />
      <div class="sheet-title">
        <h2 v-if="!renaming">{{ hero.name }}</h2>
        <form v-else class="row" style="flex-wrap:nowrap" @submit.prevent="rename"><input v-model="newName" aria-label="Имя героя" style="min-width:0;flex:1" /><button type="submit" class="small primary">Ок</button></form>
        <div class="row" style="gap:.3rem">
          <span class="badge accent">{{ cls.name }} · {{ hero.level }} ур.</span>
          <span v-if="statusText" class="badge danger">{{ statusText }}</span>
          <span v-if="store.online" class="badge" :class="{ ok: store.isMine(hero.uid) }">{{ owner ? (store.isMine(hero.uid) ? 'ваш герой' : `игрок: ${owner}`) : 'ничей' }}</span>
        </div>
      </div>
      <div class="sheet-tools">
        <button v-if="store.online && !owner" class="small primary" @click="store.claimHero(hero.uid)">Взять героя</button>
        <button v-if="store.online && store.isMine(hero.uid)" class="small" @click="store.releaseHero(hero.uid)">Отпустить</button>
        <template v-if="!ro">
          <button class="small ghost" title="Переименовать" aria-label="Переименовать" :aria-pressed="renaming" @click="renaming = !renaming"><Pencil :size="15" aria-hidden="true" /><span class="hide-phone">Имя</span></button>
          <button class="small ghost danger" title="Убрать из партии" aria-label="Убрать из партии" @click="remove"><Trash2 :size="15" aria-hidden="true" /><span class="hide-phone">Убрать</span></button>
        </template>
      </div>
    </div>
    <div class="vitals">
      <div class="vital" title="Жизни"><span><i class="ic-life">♥</i> {{ hero.lives }}/{{ hero.maxLives }}</span><div class="bar" :class="{ danger: hero.lives * 3 <= hero.maxLives }"><i :style="{ width: pct(Math.max(0, hero.lives), hero.maxLives) }" /></div></div>
      <div v-if="hero.maxMana" class="vital" title="Мана"><span><i class="ic-mana">✦</i> {{ hero.mana }}/{{ hero.maxMana }}</span><div class="bar mana"><i :style="{ width: pct(hero.mana, hero.maxMana) }" /></div></div>
      <div v-if="next" class="vital" :title="`Опыт: до ${hero.level + 1} уровня ${next - hero.xp} очков`"><span><i class="ic-xp">★</i> {{ hero.xp }}/{{ next }}</span><div class="bar xp"><i :style="{ width: pct(hero.xp - prevXp, next - prevXp) }" /></div></div>
    </div>
    <div class="stat-grid">
      <div><span>Сила</span><b>{{ heroStrength(hero, idx) }}</b></div>
      <div><span>Ловкость</span><b>{{ heroDexterity(hero) }}</b></div>
      <div><span>Меткость</span><b>{{ heroAccuracy(hero, idx) }}</b></div>
      <div><span>Удача</span><b>{{ heroLuck(hero, idx) }}</b></div>
      <div><span>Защита</span><b>{{ heroDefense(hero, idx) }}</b></div>
      <div><span>Монеты</span><b>{{ hero.money }}</b></div>
      <div v-if="!next"><span>Опыт</span><b>{{ hero.xp }}</b></div>
    </div>

    <div v-if="hero.buffs.length" class="row small" style="margin-top:.4rem"><span class="muted">Эффекты:</span><span v-for="(b, i) in hero.buffs" :key="i" class="badge accent">{{ b.source }}</span></div>
    <div v-if="hero.pendingSpellPicks > 0 && !ro" class="row" style="margin-top:.6rem">
      <button class="primary" @click="showPicker = true">Выбрать новое заклинание ({{ hero.pendingSpellPicks }})</button>
    </div>
    <SpellPicker v-if="showPicker" :hero="hero" @close="showPicker = false" />

    <h3 style="margin-top:.9rem">Снаряжение</h3>
    <div v-if="!equipped.length" class="muted small">Ничего не надето: защита {{ heroDefense(hero, idx) }}, атаки без оружия 1-1-1-2-2-2.</div>
    <table v-else class="list">
      <tbody>
        <tr v-for="e in equipped" :key="e.slot"><td class="muted">{{ SLOT_NAMES[e.slot] }}</td><td>{{ e.name }} <span class="small muted">{{ e.detail }}</span></td><td style="text-align:right"><button v-if="!ro" class="small" @click="store.unequipItem(hero.uid, e.slot)">Снять</button></td></tr>
      </tbody>
    </table>

    <p v-if="needsArrows" class="small" style="color:var(--danger);margin-top:.3rem">Лук без стрел: купите стрелы в лавке.</p>
    <h3 style="margin-top:.9rem">Инвентарь</h3>
    <div v-if="!hero.inventory.length" class="muted small">Пусто.</div>
    <table v-else class="list">
      <tbody>
        <tr v-for="e in hero.inventory" :key="e.uid" class="inv-row">
          <td>{{ entryName(e, idx) }}<span v-if="e.qty > 1"> ×{{ e.qty }}</span><span v-if="e.poisoned" class="badge" style="margin-left:.3rem">яд</span><span v-if="isEquipped(e)" class="badge" style="margin-left:.3rem">надето</span><div class="small muted inv-detail" :title="detail(e)">{{ detail(e) }}</div></td>
          <td v-if="!ro" class="inv-actions">
            <template v-if="canEquip(e) && !isEquipped(e)">
              <button class="small" @click="act(() => store.equipItem(hero.uid, e.uid))">Надеть</button>
              <button v-if="e.kind === 'weapon' && idx.weapon(e.ref).hand === 'any'" class="small" @click="act(() => store.equipItem(hero.uid, e.uid, 'leftHand'))">В левую</button>
              <button v-if="e.kind === 'weapon' && idx.weapon(e.ref).throwable" class="small" @click="act(() => store.equipItem(hero.uid, e.uid, 'ranged'))">Метать</button>
            </template>
            <button v-if="e.kind === 'bottle'" class="small" @click="act(() => store.drink(hero.uid, e.uid))">Выпить</button>
            <button v-if="e.kind === 'bottle' && !e.identified && !e.verdict && hasRecognizer" class="small" @click="act(() => store.identifyBottle(hero.uid, e.uid))">Распознать</button>
            <button v-if="e.kind === 'scroll'" class="small" @click="act(() => store.copyScroll(hero.uid, e.uid))">В книгу</button>
            <button v-if="canPoison(e) && hero.inventory.some(x => x.kind === 'item' && x.ref === 'yad')" class="small" @click="act(() => store.poisonWeapon(hero.uid, e.uid))">Смазать ядом</button>
            <button v-if="shop && salePrice(e, idx) > 0" class="small" @click="act(() => store.sellItem(hero.uid, e.uid))">Продать за {{ salePrice(e, idx) }}</button>
            <select v-if="store.heroes.length > 1" class="small" v-model="transferTo" @change="act(() => { if (transferTo) store.transferItem(hero.uid, transferTo, e.uid); transferTo = '' })">
              <option value="">Передать…</option>
              <option v-for="h in store.heroes.filter(x => x.uid !== hero.uid)" :key="h.uid" :value="h.uid">{{ h.name }}</option>
            </select>
            <button v-if="e.kind !== 'artifact'" class="small" title="Выбросить" @click="store.dropItem(hero.uid, e.uid, e.qty)">✕</button>
          </td>
        </tr>
      </tbody>
    </table>

    <template v-if="cls.caster">
      <h3 style="margin-top:.9rem">Книга заклинаний</h3>
      <div v-if="!store.combat && !ro" style="margin-bottom:.5rem"><SpellCaster :hero="hero" :in-combat="false" /></div>
      <table class="list">
        <tbody>
          <tr v-for="id in hero.spellbook" :key="id">
            <td style="white-space:nowrap">{{ idx.spell(id).level }} ур.</td><td><b>{{ idx.spell(id).name }}</b> <span class="small muted">{{ idx.spell(id).cost !== undefined && idx.spell(id).cost !== null ? `${idx.spell(id).cost} маны` : idx.spell(id).costFormula }}</span><div class="small muted">{{ idx.spell(id).description }}</div></td>
          </tr>
        </tbody>
      </table>
    </template>

    <details v-if="gmTools" style="margin-top:.8rem"><summary class="muted small">Ручная правка (ведущий)</summary>
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
