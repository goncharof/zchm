<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { idx } from '@/data'
import type { Hero } from '@/engine/model'
import { attacksLabel, heroDefense, heroWeapons, isActive } from '@/engine/character'
import { toHit } from '@/engine/combat'
import { entryName, salePrice } from '@/engine/inventory'
import type { LootItem } from '@/engine/loot'
import { fleeTarget } from '@/engine/rules'
import { wardName } from '@/engine/spells'
import { useGameStore } from '@/stores/game'
import { classArt, pct } from '@/ui/format'
import LogPanel from '@/components/LogPanel.vue'
import MonsterPicker from '@/components/MonsterPicker.vue'
import SpellCaster from '@/components/SpellCaster.vue'

const store = useGameStore()
const router = useRouter()
const base = import.meta.env.BASE_URL
const c = computed(() => store.combat)
const alive = computed(() => c.value?.monsters.filter((m) => !m.dead && !m.fled) ?? [])
const target = ref<string>('')
const picker = ref(false)
const EXTRA: Record<string, string> = { petrify: 'окаменение', freeze: 'оледенение', paralysis: 'паралич', poison: 'яд' }

watch(alive, (list) => { if (!list.find((m) => m.uid === target.value)) target.value = list[0]?.uid ?? '' }, { immediate: true })

// монстры ходят сами (настройка зрителя, хранится в браузере)
const AUTO_KEY = 'zchm.autoMonsters'
const autoMonsters = ref(readAuto())
function readAuto(): boolean { try { return localStorage.getItem(AUTO_KEY) === '1' } catch { return false } }
watch(autoMonsters, (v) => { try { localStorage.setItem(AUTO_KEY, v ? '1' : '0') } catch { /* нет хранилища */ } })
let autoTimer: ReturnType<typeof setTimeout> | null = null
watch(() => [c.value?.turn, c.value?.round, c.value?.finished, autoMonsters.value] as const, ([turn, , finished, auto]) => {
  if (autoTimer) { clearTimeout(autoTimer); autoTimer = null }
  if (auto && turn === 'monsters' && !finished) autoTimer = setTimeout(() => { if (store.combat?.turn === 'monsters' && !store.combat.finished) store.monstersAct() }, 600)
}, { immediate: true })
onBeforeUnmount(() => { if (autoTimer) clearTimeout(autoTimer) })
const targetMonster = computed(() => alive.value.find((m) => m.uid === target.value) ?? null)

// трофеи после победы: забирает выбранный свой живой герой
const takers = computed(() => store.heroes.filter((h) => !h.status.dead && store.canControl(h.uid)).sort((a, b) => Number(store.isMine(b.uid)) - Number(store.isMine(a.uid))))
const taker = ref('')
watch(takers, (list) => { if (!list.some((h) => h.uid === taker.value)) taker.value = list[0]?.uid ?? '' }, { immediate: true })
const lootEntry = (it: LootItem) => ({ uid: it.uid, kind: it.kind, ref: it.ref, qty: 1 })

function canAct(h: Hero) {
  return !!c.value && store.canControl(h.uid) && c.value.turn === 'heroes' && !c.value.finished && !c.value.acted.includes(h.uid) && !c.value.escaped.includes(h.uid) && isActive(h)
}
function heroState(h: Hero) {
  if (!c.value) return ''
  if (h.status.dead) return 'мёртв'
  if (c.value.escaped.includes(h.uid)) return 'сбежал'
  if (h.status.unconscious) return 'без сознания'
  if (h.status.petrified) return 'окаменел'
  if (h.status.paralysis) return `паралич (${h.status.paralysis})`
  if (h.status.freeze) return `обездвижен (${h.status.freeze})`
  if (h.status.charmed) return 'очарован'
  const marks = [h.status.choke ? `задыхается (${h.status.choke})` : '', h.status.cursed ? 'проклят' : ''].filter(Boolean)
  if (c.value.acted.includes(h.uid)) marks.unshift('сходил')
  return marks.join(', ')
}
function needRoll(h: Hero, slot: string) {
  if (!targetMonster.value) return ''
  const w = slot === 'unarmed' ? null : heroWeapons(h, idx).find((x) => x.slot === slot) ?? null
  const n = toHit(h, w, targetMonster.value, idx)
  return n <= 1 ? 'попадает всегда' : `нужно ${n}+`
}
function weaponReady(w: ReturnType<typeof heroWeapons>[number]) {
  if (!c.value) return false
  if (w.needsAmmo && !w.ammoEntry) return false
  if (c.value.phase === 'ranged') return w.ranged
  if (w.ranged) return !!w.thrown
  return true
}
function weaponWhy(w: ReturnType<typeof heroWeapons>[number]) {
  if (w.needsAmmo && !w.ammoEntry) return 'Нет стрел — купите их в лавке'
  return c.value?.phase === 'ranged' && !w.ranged ? 'Сначала сойдитесь вплотную' : 'Противник вплотную — из лука не выстрелить'
}
function ammoText(w: ReturnType<typeof heroWeapons>[number]) {
  if (w.needsAmmo) return ` · стрел ${w.ammoLeft ?? 0}${w.ammoEntry?.ref === 'elfiyskaya-strela' ? ' (эльф.)' : ''}`
  if (w.thrown && (w.ammoLeft ?? 0) > 1) return ` · ${w.ammoLeft} шт.`
  return ''
}
function finish() {
  const back = c.value?.returnTo
  store.endCombat()
  router.push(back ?? '/map')
}
function fleeNeed() {
  return fleeTarget(Math.max(1, ...alive.value.map((m) => m.level)))
}
function monsterState(m: NonNullable<typeof c.value>['monsters'][number]) {
  const out: string[] = []
  if (m.dead) out.push('убит'); else if (m.fled) out.push('выбыл')
  if (m.petrified) out.push('окаменел')
  if (m.disabled) out.push(`${m.disabledKind === 'sleep' ? 'спит' : m.disabledKind === 'paralysis' ? 'парализован' : m.disabledKind === 'charm' ? 'заворожён' : 'вмёрз'} (${m.disabled})`)
  if (m.cursed) out.push('проклят')
  if (m.held) out.push('удержан'); if (m.choke) out.push(`задыхается (${m.choke})`); if (m.poison) out.push(`отравлен (${m.poison})`)
  if (m.quake) out.push(`землетрясение (${m.quake})`)
  if (m.attackMod) out.push(`атаки ${m.attackMod > 0 ? '+' : ''}${m.attackMod}`); if (m.attackMultiplier !== 1) out.push(`атаки ×${m.attackMultiplier}`)
  if (m.hitMod) out.push(`попадание +${m.hitMod}`); if (m.prayer) out.push('молитва')
  for (const w of m.wards ?? []) out.push(w.kind === 'antimagic' ? `огненный щит${w.rounds > 0 ? ` (${w.rounds})` : ''}` : 'отражение магии')
  if (m.summoned) out.push('призван')
  return out.join(', ')
}
</script>

<template>
  <div v-if="!c" class="card">
    <p>Бой не идёт.</p>
    <button v-if="store.isGm && !store.aiGm" @click="picker = true">Начать произвольный бой</button>
    <MonsterPicker v-if="picker" @close="picker = false" @start="(s) => { picker = false; store.startEncounter(s) }" />
  </div>
  <template v-else>
    <div class="card tight row between">
      <div class="row">
        <b>Раунд {{ c.round }}</b>
        <span class="badge">{{ c.phase === 'ranged' ? 'дистанция' : 'ближний бой' }}</span>
        <span class="badge accent" v-if="!c.finished">ход: {{ c.turn === 'heroes' ? 'герои' : 'монстры' }}</span>
        <span class="badge" v-if="c.initiative">инициатива {{ c.initiative.heroes }}:{{ c.initiative.monsters }}</span>
        <span class="badge" v-if="c.finished" style="border-color:var(--accent);color:var(--accent)">{{ c.finished === 'victory' ? 'Победа' : c.finished === 'fled' ? 'Отступление' : 'Поражение' }}</span>
      </div>
      <div class="row">
        <button v-if="!c.finished && c.phase === 'ranged'" @click="store.toMelee()">Сойтись вплотную</button>
        <label class="row small" style="gap:.3rem" title="Ход монстров выполняется автоматически"><input type="checkbox" v-model="autoMonsters" /> монстры ходят сами</label>
        <button v-if="!c.finished && c.turn === 'monsters'" class="primary" @click="store.monstersAct()">Ход монстров</button>
        <button v-if="!c.finished && c.turn === 'heroes'" class="small" title="Оставшиеся герои пропускают ход" @click="store.endHeroesTurn()">Закончить ход героев</button>
        <button v-if="!c.finished && store.isGm && !store.aiGm" class="small" @click="picker = true">Добавить монстров</button>
        <button v-if="c.finished" class="primary" @click="finish">Завершить бой</button>
        <button v-else-if="store.isGm && !store.aiGm" class="small danger" @click="store.abortCombat()">Прервать</button>
      </div>
    </div>
    <MonsterPicker v-if="picker && !c.finished" @close="picker = false" @start="(s) => { picker = false; store.addMonstersToCombat(s) }" />

    <div v-if="c.finished === 'victory' && c.loot?.length" class="card tight">
      <h3>Трофеи</h3>
      <p class="small muted">После боя можно обобрать убитых врагов. Что не заберёте до завершения боя, останется на поле.</p>
      <div v-if="takers.length > 1" class="row" style="margin-bottom:.4rem">
        <label>Забирает</label>
        <select v-model="taker"><option v-for="h in takers" :key="h.uid" :value="h.uid">{{ h.name }}</option></select>
      </div>
      <div v-for="it in c.loot" :key="it.uid" class="row between" style="padding:.2rem 0;flex-wrap:nowrap">
        <span style="flex:1;min-width:0">{{ entryName(lootEntry(it), idx) }} <span class="small muted">— {{ it.from }}, в лавке дадут {{ salePrice(lootEntry(it), idx) }}</span></span>
        <button class="small" :disabled="!taker" @click="store.takeLoot(taker, it.uid)">Взять</button>
      </div>
    </div>

    <div class="cols c11">
      <div>
        <h3>Противники <span class="small muted">— нажмите, чтобы выбрать цель</span></h3>
        <div class="foes">
        <div v-for="m in c.monsters" :key="m.uid" class="card tight foe" :class="{ 'hero-down': m.dead || m.fled }"
          :style="m.uid === target ? 'outline: 2px solid var(--accent)' : 'cursor:pointer'" @click="!m.dead && !m.fled && (target = m.uid)">
          <div class="monster-card">
            <img v-if="idx.monsterById.get(m.monsterId)?.image" :src="base + idx.monsterById.get(m.monsterId)!.image" :alt="m.name" loading="lazy" />
            <div v-else class="foe-ph" :title="m.name" aria-hidden="true">✦</div>
            <div>
              <div class="row between"><b>{{ m.name }}<span v-if="m.uid === target" class="badge accent" style="margin-left:.4rem">цель</span></b><span class="small muted">ур. {{ m.level }} · защита {{ m.defense + m.defenseMod }}</span></div>
              <div class="bar" style="margin:.3rem 0" :class="{ danger: m.lives * 2 <= m.maxLives }"><i :style="{ width: pct(m.lives, m.maxLives) }" /></div>
              <div class="small muted foe-hp">♥ {{ Math.max(0, m.lives) }}/{{ m.maxLives }} · защ. {{ m.defense + m.defenseMod }}</div>
              <div class="small muted foe-stats">жизни {{ Math.max(0, m.lives) }}/{{ m.maxLives }} · атаки {{ Array.isArray(m.attacks) ? m.attacks.join('-') : m.attacks === 'death' ? 'смерть' : m.attacks === 'magic' ? 'магия' : 'нет' }}<template v-if="m.courage !== null"> · храбрость {{ m.courage }}</template><template v-if="m.mana !== undefined"> · мана {{ m.mana }}</template>
                <template v-if="m.extraAttacks?.length"> · {{ m.extraAttacks.map(e => EXTRA[e.kind] + ' ' + e.threshold).join(', ') }}</template>
                <template v-if="m.spells?.length"> · заклинания: {{ m.spells.join(', ') }}</template>
              </div>
              <div v-if="monsterState(m)" class="small" style="color:#d7c56a">{{ monsterState(m) }}</div>
            </div>
          </div>
        </div>
        </div>
        <template v-if="c.allies.length">
          <h3>Союзники</h3>
          <div v-for="a in c.allies" :key="a.uid" class="card tight" :class="{ 'hero-down': a.dead }">
            <div class="row between"><b>{{ a.name }}</b><span class="small muted">защита {{ a.defense }} · атаки {{ a.attacks === 'none' ? 'нет' : a.attacks }}<template v-if="a.rounds > 0"> · {{ a.rounds }} раунд(ов)</template><template v-if="a.dead"> · исчез</template></span></div>
            <div class="bar" style="margin:.3rem 0"><i :style="{ width: pct(a.lives, a.maxLives) }" /></div>
            <div class="small muted">жизни {{ Math.max(0, a.lives) }}/{{ a.maxLives }} · {{ a.companionUid ? `спутник партии, осталось боёв: ${store.game?.companions.find(c => c.uid === a.companionUid)?.battlesLeft ?? '—'}` : `призвал: ${store.heroes.find(h => h.uid === a.ownerUid)?.name ?? '—'}` }}</div>
          </div>
        </template>
      </div>
      <div>
        <h3>Герои</h3>
        <div v-for="h in store.heroes" :key="h.uid" class="card tight" :class="{ 'hero-down': !isActive(h) || c.escaped.includes(h.uid) }" :style="canAct(h) ? 'border-color: var(--accent)' : ''">
          <div class="row between"><b class="row" style="gap:.45rem"><img :src="classArt(h.classId)" alt="" class="portrait small-portrait" />{{ h.name }}</b><span class="small muted">{{ idx.cls(h.classId).name }} {{ h.level }} · защита {{ heroDefense(h, idx) }} <span v-if="heroState(h)">· {{ heroState(h) }}</span><span v-if="(c.extraActions[h.uid] ?? 0) > 0"> · +{{ c.extraActions[h.uid] }} действие</span></span></div>
          <div class="row" style="gap:1rem;margin:.3rem 0">
            <div style="flex:1;min-width:120px"><div class="bar" :class="{ danger: h.lives * 3 <= h.maxLives }"><i :style="{ width: pct(h.lives, h.maxLives) }" /></div><div class="small muted">♥ {{ h.lives }}/{{ h.maxLives }}</div></div>
            <div v-if="h.maxMana" style="flex:1;min-width:120px"><div class="bar mana"><i :style="{ width: pct(h.mana, h.maxMana) }" /></div><div class="small muted">✦ {{ h.mana }}/{{ h.maxMana }}</div></div>
          </div>
          <div v-if="h.buffs.length" class="row small" style="margin-bottom:.3rem"><span v-for="(b, i) in h.buffs" :key="i" class="badge accent" :title="b.stat === 'ward' && b.ward ? wardName(b.ward) : ''">{{ b.source }}<template v-if="b.rounds > 0"> ({{ b.rounds }})</template></span></div>
          <div v-if="canAct(h)" class="row">
            <button v-for="w in heroWeapons(h, idx)" :key="w.slot + w.name" class="small primary" :disabled="!targetMonster || !weaponReady(w)" :title="weaponReady(w) ? needRoll(h, w.slot) : weaponWhy(w)" @click="store.attack(h.uid, w.slot, target)">{{ w.ranged ? '🏹' : '⚔' }} {{ w.name }} ({{ attacksLabel(w) }}){{ ammoText(w) }} <span class="muted">{{ weaponReady(w) ? needRoll(h, w.slot) : '' }}</span></button>
            <button v-if="!heroWeapons(h, idx).some(w => !w.ranged)" class="small" :disabled="!targetMonster || c.phase === 'ranged'" :title="needRoll(h, 'unarmed')" @click="store.attack(h.uid, 'unarmed', target)">Голыми руками <span class="muted">{{ needRoll(h, 'unarmed') }}</span></button>
            <button class="small" @click="store.flee(h.uid)" :title="`Нужно выкинуть ${fleeNeed()}+`">Бежать ({{ fleeNeed() }}+)</button>
            <button class="small" @click="store.skip(h.uid)">Пропустить</button>
          </div>
          <div v-if="canAct(h) && (h.spellbook.length || h.inventory.some((e) => e.kind === 'scroll'))" style="margin-top:.35rem"><SpellCaster :hero="h" :in-combat="true" :target-uid="target" /></div>
          <div v-if="!canAct(h) && isActive(h) && !c.escaped.includes(h.uid) && c.turn === 'heroes' && !c.finished" class="small muted">{{ store.canControl(h.uid) ? 'ждёт следующего раунда' : `ходит ${store.ownerOf(h.uid) ?? 'другой игрок'}` }}</div>
        </div>
        <p class="small muted">Попадание: к18 + ловкость (меткость для метательного) ≥ защита цели. Урон: таблица атак по к6 + сила.</p>
      </div>
    </div>
    <h3>Журнал</h3>
    <LogPanel :entries="store.game?.log ?? []" :limit="60" />
  </template>
</template>
