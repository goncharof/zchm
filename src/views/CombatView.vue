<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { idx } from '@/data'
import type { Hero } from '@/engine/model'
import { heroDefense, heroWeapons, isActive } from '@/engine/character'
import { canCast, resolveCost } from '@/engine/spells'
import { fleeTarget } from '@/engine/rules'
import { useGameStore } from '@/stores/game'
import { pct } from '@/ui/format'
import LogPanel from '@/components/LogPanel.vue'
import MonsterPicker from '@/components/MonsterPicker.vue'

const store = useGameStore()
const router = useRouter()
const c = computed(() => store.combat)
const alive = computed(() => c.value?.monsters.filter((m) => !m.dead && !m.fled) ?? [])
const target = ref<string>('')
const picker = ref(false)
const base = import.meta.env.BASE_URL
const spellForm = reactive<Record<string, { spellId: string; targetHeroUid: string; param: number }>>({})

function form(h: Hero) {
  return (spellForm[h.uid] ??= { spellId: '', targetHeroUid: h.uid, param: 1 })
}
function tgt(): string {
  if (!alive.value.find((m) => m.uid === target.value)) target.value = alive.value[0]?.uid ?? ''
  return target.value
}
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
  if (h.status.freeze) return `оледенение (${h.status.freeze})`
  if (c.value.acted.includes(h.uid)) return 'сходил'
  return ''
}
function spells(h: Hero) {
  return c.value?.finished ? [] : h.spellbook.map((id) => idx.spell(id))
}
function spellNeedsMonster(id: string) {
  const e = idx.spell(id).effect
  return (e.type === 'damage' && e.targets === 'one') || (e.type === 'debuff' && e.scope === 'one')
}
function spellNeedsHero(id: string) {
  const e = idx.spell(id).effect
  return e.type === 'heal' || e.type === 'restore-all' || (e.type === 'buff' && e.scope === 'ally')
}
function spellNeedsParam(id: string) {
  const s = idx.spell(id)
  return s.effect.type === 'heal' || /стрел|3 ман/.test(s.costFormula ?? '')
}
function cast(h: Hero) {
  const f = form(h)
  if (!f.spellId) return
  const why = canCast(h, idx.spell(f.spellId), idx, f.param)
  if (why) { store.say(why); return }
  store.cast(h.uid, f.spellId, { targetUid: spellNeedsMonster(f.spellId) ? tgt() : undefined, targetHeroUid: spellNeedsHero(f.spellId) ? f.targetHeroUid : undefined, param: f.param })
}
function finish() {
  const back = c.value?.returnTo
  store.endCombat()
  router.push(back ?? '/map')
}
function fleeNeed() {
  return fleeTarget(Math.max(1, ...alive.value.map((m) => m.level)))
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

    <div class="grid wide" style="grid-template-columns: 1fr 1fr">
      <div>
        <h3>Противники</h3>
        <div v-for="m in c.monsters" :key="m.uid" class="card tight" :class="{ 'hero-down': m.dead || m.fled }">
          <div class="monster-card">
            <img :src="base + idx.monster(m.monsterId).image" :alt="m.name" loading="lazy" />
            <div>
              <div class="row between"><b>{{ m.name }}</b><span class="small muted">ур. {{ m.level }} · защита {{ m.defense + m.defenseMod }}<template v-if="m.dead"> · убит</template><template v-else-if="m.fled"> · сбежал</template></span></div>
              <div class="bar" style="margin:.3rem 0" :class="{ danger: m.lives * 2 <= m.maxLives }"><i :style="{ width: pct(m.lives, m.maxLives) }" /></div>
              <div class="small muted">жизни {{ Math.max(0, m.lives) }}/{{ m.maxLives }} · атаки {{ Array.isArray(m.attacks) ? m.attacks.join('-') : m.attacks }}<template v-if="m.courage !== null"> · храбрость {{ m.courage }}</template>
                <template v-if="m.extraAttacks?.length"> · {{ m.extraAttacks.map(e => ({ petrify: 'окаменение', freeze: 'оледенение', paralysis: 'паралич', poison: 'яд' })[e.kind] + ' ' + e.threshold).join(', ') }}</template>
                <template v-if="m.spells?.length"> · заклинания: {{ m.spells.join(', ') }}</template>
                <template v-if="m.poison"> · отравлен ({{ m.poison }})</template><template v-if="m.disabled"> · обездвижен ({{ m.disabled }})</template>
              </div>
              <label v-if="!m.dead && !m.fled" class="row small" style="gap:.3rem;margin-top:.3rem"><input type="radio" name="target" :value="m.uid" v-model="target" /> цель</label>
            </div>
          </div>
        </div>
      </div>
      <div>
        <h3>Герои</h3>
        <div v-for="h in store.heroes" :key="h.uid" class="card tight" :class="{ 'hero-down': !isActive(h) || c.escaped.includes(h.uid) }">
          <div class="row between"><b>{{ h.name }}</b><span class="small muted">{{ idx.cls(h.classId).name }} {{ h.level }} · защита {{ heroDefense(h, idx) }} <span v-if="heroState(h)">· {{ heroState(h) }}</span></span></div>
          <div class="row" style="gap:1rem;margin:.3rem 0">
            <div style="flex:1;min-width:120px"><div class="bar" :class="{ danger: h.lives * 3 <= h.maxLives }"><i :style="{ width: pct(h.lives, h.maxLives) }" /></div><div class="small muted">♥ {{ h.lives }}/{{ h.maxLives }}</div></div>
            <div v-if="h.maxMana" style="flex:1;min-width:120px"><div class="bar mana"><i :style="{ width: pct(h.mana, h.maxMana) }" /></div><div class="small muted">✦ {{ h.mana }}/{{ h.maxMana }}</div></div>
          </div>
          <div v-if="canAct(h)" class="row">
            <button v-for="w in heroWeapons(h, idx)" :key="w.slot" class="small primary" :disabled="!alive.length" @click="store.attack(h.uid, w.slot, tgt())">{{ w.ranged ? '🏹' : '⚔' }} {{ w.name }} ({{ w.attacks.join('-') }})</button>
            <button v-if="!heroWeapons(h, idx).some(w => !w.ranged)" class="small" :disabled="!alive.length || c.phase === 'ranged'" @click="store.attack(h.uid, 'unarmed', tgt())">Голыми руками</button>
            <button class="small" @click="store.flee(h.uid)" :title="`Нужно выкинуть ${fleeNeed()}+`">Бежать ({{ fleeNeed() }}+)</button>
            <button class="small" @click="store.skip(h.uid)">Пропустить</button>
          </div>
          <div v-if="canAct(h) && h.spellbook.length" class="row" style="margin-top:.35rem">
            <select v-model="form(h).spellId" class="small">
              <option value="">Заклинание…</option>
              <option v-for="s in spells(h)" :key="s.id" :value="s.id">{{ s.name }} ({{ resolveCost(s, h, form(h).param) }} маны)</option>
            </select>
            <select v-if="form(h).spellId && spellNeedsHero(form(h).spellId)" v-model="form(h).targetHeroUid" class="small">
              <option v-for="x in store.heroes" :key="x.uid" :value="x.uid">{{ x.name }}</option>
            </select>
            <input v-if="form(h).spellId && spellNeedsParam(form(h).spellId)" type="number" min="1" :max="h.mana" v-model.number="form(h).param" class="small" style="width:4rem" title="маны / стрел" />
            <button class="small" :disabled="!form(h).spellId" @click="cast(h)">Применить</button>
          </div>
          <div v-if="!canAct(h) && isActive(h) && !c.escaped.includes(h.uid) && c.turn === 'heroes' && !c.finished" class="small muted">ждёт следующего раунда</div>
        </div>
        <p class="small muted">Выбранная цель отмечена переключателем у монстра. Попадание: к18 + ловкость (меткость для метательного) ≥ защита цели.</p>
      </div>
    </div>
    <h3>Журнал</h3>
    <LogPanel :entries="store.game?.log ?? []" :limit="60" />
  </template>
</template>
