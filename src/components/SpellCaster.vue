<script setup lang="ts">
import { computed, reactive } from 'vue'
import { idx } from '@/data'
import type { Hero } from '@/engine/model'
import { canCast, needsEntryTarget, needsHeroTarget, needsMonsterTarget, needsParam, resolveCost, scrollProblem, usableOutOfCombat } from '@/engine/spells'
import { entryName } from '@/engine/inventory'
import { useGameStore } from '@/stores/game'

const props = defineProps<{ hero: Hero; inCombat: boolean; targetUid?: string }>()
const store = useGameStore()
const form = reactive({ spellId: '', targetHeroUid: props.hero.uid, targetEntryUid: '', param: 1 })
const spells = computed(() => props.hero.spellbook.map((id) => idx.spell(id)).filter((s) => props.inCombat || usableOutOfCombat(s)))
/** свитки своего класса: прочесть один раз без постоянной цены в мане (стр. 21) */
const scrolls = computed(() => props.hero.inventory
  .filter((e) => e.kind === 'scroll' && e.identified !== false)
  .map((e) => ({ uid: e.uid, spell: idx.spell(e.ref) }))
  .filter((x) => !scrollProblem(props.hero, x.spell, idx) && (props.inCombat || usableOutOfCombat(x.spell))))
const scrollUid = computed(() => (form.spellId.startsWith('scroll:') ? form.spellId.slice(7) : ''))
const spell = computed(() => (scrollUid.value ? scrolls.value.find((x) => x.uid === scrollUid.value)?.spell ?? null : form.spellId ? idx.spell(form.spellId) : null))
const entries = computed(() => {
  const dup = spell.value?.effect.type === 'duplicate-bottle'
  return store.heroes.flatMap((h) => h.inventory
    .filter((e) => (dup ? e.kind === 'bottle' : (e.kind === 'bottle' && !e.identified) || e.kind === 'scroll' || e.kind === 'artifact'))
    .map((e) => ({ uid: e.uid, label: `${h.name}: ${entryName(e, idx)}` })))
})
const problem = computed(() => (spell.value ? (scrollUid.value ? scrollProblem(props.hero, spell.value, idx) : canCast(props.hero, spell.value, idx, form.param)) : null))

function cast() {
  if (!spell.value) return
  if (problem.value) { store.say(problem.value); return }
  if (needsMonsterTarget(spell.value) && !props.targetUid) { store.say('Выберите цель среди монстров'); return }
  store.cast(props.hero.uid, spell.value.id, {
    targetUid: needsMonsterTarget(spell.value) ? props.targetUid : undefined,
    targetHeroUid: needsHeroTarget(spell.value) ? form.targetHeroUid : undefined,
    targetEntryUid: needsEntryTarget(spell.value) ? form.targetEntryUid : undefined,
    param: form.param,
    ...(scrollUid.value ? { scrollUid: scrollUid.value } : {}),
  })
  if (scrollUid.value) form.spellId = ''
}
</script>

<template>
  <div class="row spell-row" v-if="spells.length || scrolls.length">
    <select v-model="form.spellId" class="small">
      <option value="">Заклинание…</option>
      <option v-for="s in spells" :key="s.id" :value="s.id">{{ s.level }} ур. {{ s.name }} ({{ resolveCost(s, hero, form.param) }} маны)</option>
      <option v-for="x in scrolls" :key="x.uid" :value="`scroll:${x.uid}`">📜 {{ x.spell.level }} ур. {{ x.spell.name }} (свиток, один раз)</option>
    </select>
    <select v-if="spell && needsHeroTarget(spell)" v-model="form.targetHeroUid" class="small">
      <option v-for="x in store.heroes" :key="x.uid" :value="x.uid">{{ x.name }}</option>
    </select>
    <select v-if="spell && needsEntryTarget(spell)" v-model="form.targetEntryUid" class="small">
      <option value="">Предмет…</option>
      <option v-for="e in entries" :key="e.uid" :value="e.uid">{{ e.label }}</option>
    </select>
    <input v-if="spell && needsParam(spell)" type="number" min="1" :max="Math.max(1, hero.mana)" v-model.number="form.param" class="small" style="width:4.2rem" :title="/стрел/.test(spell.costFormula ?? '') ? 'число стрел' : 'маны потратить'" />
    <button class="small primary" :disabled="!spell" @click="cast">Применить</button>
    <span v-if="spell" class="small muted" style="flex-basis:100%">{{ spell.target ? `Место действия: ${spell.target}. ` : '' }}{{ spell.description }}</span>
  </div>
</template>
