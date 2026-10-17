<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { idx } from '@/data'
import type { Hero } from '@/engine/model'
import { attacksLabel, heroDefense, heroWeapons, isActive } from '@/engine/character'
import { toHit } from '@/engine/combat'
import { fleeTarget } from '@/engine/rules'
import { wardName } from '@/engine/spells'
import { useGameStore } from '@/stores/game'
import { pct } from '@/ui/format'
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
const targetMonster = computed(() => alive.value.find((m) => m.uid === target.value) ?? null)

function canAct(h: Hero) {
  return !!c.value && c.value.turn === 'heroes' && !c.value.finished && !c.value.acted.includes(h.uid) && !c.value.escaped.includes(h.uid) && isActive(h)
}
function heroState(h: Hero) {
  if (!c.value) return ''
  if (h.status.dead) return 'мёртв'
  if (c.value.escaped.includes(h.uid)) return 'сбежал'
  if (h.status.unconscious) return 'без сознания'
  if (h.status.petrified) return 'окаменел'
  if (h.status.paralysis) return `паралич (${h.status.paralysis})`
  if (h.status.freeze) return `обездвижен (${h.status.freeze})`
  if (c.value.acted.includes(h.uid)) return 'сходил'
  return ''
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
  if (m.disabled) out.push(`${m.disabledKind === 'sleep' ? 'спит' : m.disabledKind === 'paralysis' ? 'парализован' : 'вмёрз'} (${m.disabled})`)
  if (m.held) out.push('удержан'); if (m.choke) out.push(`задыхается (${m.choke})`); if (m.poison) out.push(`отравлен (${m.poison})`)
  if (m.attackMod) out.push(`атаки ${m.attackMod > 0 ? '+' : ''}${m.attackMod}`); if (m.attackMultiplier !== 1) out.push(`атаки ×${m.attackMultiplier}`)
  return out.join(', ')
}
</script>

<template>
  <div v-if="!c" class="card">
    <p>Бой не идёт.</p>
    <button @click="picker = true">Начать произвольный бой</button>
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
        <button v-if="!c.finished && c.turn === 'monsters'" class="primary" @click="store.monstersAct()">Ход монстров</button>
        <button v-if="!c.finished" class="small" @click="picker = true">Добавить монстров</button>
        <button v-if="c.finished" class="primary" @click="finish">Завершить бой</button>
        <button v-else class="small danger" @click="store.abortCombat()">Прервать</button>
      </div>
    </div>
    <MonsterPicker v-if="picker" @close="picker = false" @start="(s) => { picker = false; store.addMonstersToCombat(s) }" />

    <div class="cols c11">
      <div>
        <h3>Противники <span class="small muted">— щёлкните, чтобы выбрать цель</span></h3>
        <div v-for="m in c.monsters" :key="m.uid" class="card tight" :class="{ 'hero-down': m.dead || m.fled }"
          :style="m.uid === target ? 'outline: 2px solid var(--accent)' : 'cursor:pointer'" @click="!m.dead && !m.fled && (target = m.uid)">
          <div class="monster-card">
            <img :src="base + idx.monster(m.monsterId).image" :alt="m.name" loading="lazy" />
            <div>
              <div class="row between"><b>{{ m.name }}<span v-if="m.uid === target" class="badge accent" style="margin-left:.4rem">цель</span></b><span class="small muted">ур. {{ m.level }} · защита {{ m.defense + m.defenseMod }}</span></div>
              <div class="bar" style="margin:.3rem 0" :class="{ danger: m.lives * 2 <= m.maxLives }"><i :style="{ width: pct(m.lives, m.maxLives) }" /></div>
              <div class="small muted">жизни {{ Math.max(0, m.lives) }}/{{ m.maxLives }} · атаки {{ Array.isArray(m.attacks) ? m.attacks.join('-') : m.attacks === 'death' ? 'смерть' : m.attacks === 'magic' ? 'магия' : 'нет' }}<template v-if="m.courage !== null"> · храбрость {{ m.courage }}</template><template v-if="m.mana !== undefined"> · мана {{ m.mana }}</template>
                <template v-if="m.extraAttacks?.length"> · {{ m.extraAttacks.map(e => EXTRA[e.kind] + ' ' + e.threshold).join(', ') }}</template>
                <template v-if="m.spells?.length"> · заклинания: {{ m.spells.join(', ') }}</template>
              </div>
              <div v-if="monsterState(m)" class="small" style="color:#d7c56a">{{ monsterState(m) }}</div>
            </div>
          </div>
        </div>
        <template v-if="c.allies.length">
          <h3>Союзники</h3>
          <div v-for="a in c.allies" :key="a.uid" class="card tight" :class="{ 'hero-down': a.dead }">
            <div class="row between"><b>{{ a.name }}</b><span class="small muted">защита {{ a.defense }} · атаки {{ a.attacks === 'none' ? 'нет' : a.attacks }}<template v-if="a.rounds > 0"> · {{ a.rounds }} раунд(ов)</template><template v-if="a.dead"> · исчез</template></span></div>
            <div class="bar" style="margin:.3rem 0"><i :style="{ width: pct(a.lives, a.maxLives) }" /></div>
            <div class="small muted">жизни {{ Math.max(0, a.lives) }}/{{ a.maxLives }} · хозяин: {{ store.heroes.find(h => h.uid === a.ownerUid)?.name }}</div>
          </div>
        </template>
      </div>
      <div>
        <h3>Герои</h3>
        <div v-for="h in store.heroes" :key="h.uid" class="card tight" :class="{ 'hero-down': !isActive(h) || c.escaped.includes(h.uid) }" :style="canAct(h) ? 'border-color: var(--accent)' : ''">
          <div class="row between"><b>{{ h.name }}</b><span class="small muted">{{ idx.cls(h.classId).name }} {{ h.level }} · защита {{ heroDefense(h, idx) }} <span v-if="heroState(h)">· {{ heroState(h) }}</span><span v-if="(c.extraActions[h.uid] ?? 0) > 0"> · +{{ c.extraActions[h.uid] }} действие</span></span></div>
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
          <div v-if="canAct(h) && h.spellbook.length" style="margin-top:.35rem"><SpellCaster :hero="h" :in-combat="true" :target-uid="target" /></div>
          <div v-if="!canAct(h) && isActive(h) && !c.escaped.includes(h.uid) && c.turn === 'heroes' && !c.finished" class="small muted">ждёт следующего раунда</div>
        </div>
        <p class="small muted">Попадание: к18 + ловкость (меткость для метательного) ≥ защита цели. Урон: таблица атак по к6 + сила.</p>
      </div>
    </div>
    <h3>Журнал</h3>
    <LogPanel :entries="store.game?.log ?? []" :limit="60" />
  </template>
</template>
