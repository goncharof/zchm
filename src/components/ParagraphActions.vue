<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { idx } from '@/data'
import type { Caster, ParagraphHints } from '@/types'
import type { EncounterSpec } from '@/engine/combat'
import { useGameStore } from '@/stores/game'
import { casterName } from '@/ui/format'

/** Кнопки действий по подсказкам из текста: удача, бой, монеты, бутылки, артефакт, свитки */
const props = defineProps<{ hints?: ParagraphHints; heroUid: string }>()
const emit = defineEmits<{ fight: [specs: EncounterSpec[]] }>()
const store = useGameStore()
const counts = ref<Record<string, number>>({})
const lastLuck = ref('')
const taken = ref<Set<string>>(new Set())

const fightable = computed(() => (props.hints?.monsters ?? []).filter((m) => !idx.monsterById.get(m)?.special))
const npcs = computed(() => (props.hints?.monsters ?? []).filter((m) => idx.monsterById.get(m)?.special))
watch(() => props.hints, () => {
  counts.value = {}
  for (const m of fightable.value) counts.value[m] = props.hints?.monsterCounts?.[m] ?? 1
  lastLuck.value = ''
  taken.value = new Set()
}, { immediate: true })

function need(): string | null {
  if (!props.heroUid) { store.say('Выберите героя'); return null }
  return props.heroUid
}
function once(key: string, fn: (h: string) => void) {
  const h = need(); if (!h) return
  fn(h)
  taken.value = new Set([...taken.value, key])
}
function luck(target: number) {
  const h = need(); if (!h) return
  const r = store.luckCheck(h, target)
  lastLuck.value = `${store.hero(h).name}: к18 = ${r.roll}${r.luck ? ` + ${r.luck}` : ''} против ${target} — ${r.ok ? 'удача!' : 'неудача'}`
}
function fight(ids: string[]) {
  const specs = ids.map((monsterId) => ({ monsterId, count: counts.value[monsterId] ?? 1 })).filter((s) => s.count > 0)
  if (specs.length) emit('fight', specs)
}
const has = computed(() => !!props.hints && Object.keys(props.hints).length > 0)
</script>

<template>
  <div v-if="has" class="row" style="margin-top:.45rem">
    <template v-for="t in hints?.luck ?? []" :key="'l' + t"><button class="small" @click="luck(t)">Бросок удачи {{ t }}</button></template>
    <template v-for="m in fightable" :key="m">
      <span class="row" style="gap:.2rem"><input type="number" min="0" max="30" v-model.number="counts[m]" style="width:3.4rem" class="small" /><button class="small danger" @click="fight([m])">⚔ {{ idx.monsterById.get(m)?.name }}</button></span>
    </template>
    <button v-if="fightable.length > 1" class="small danger" @click="fight(fightable)">⚔ Все вместе</button>
    <template v-for="(c, i) in hints?.coins ?? []" :key="'c' + i"><button class="small" :disabled="taken.has('c' + i)" @click="once('c' + i, (h) => store.adjustMoney(h, c))">+{{ c }} монет</button></template>
    <template v-for="(b, i) in hints?.bottles ?? []" :key="'b' + i"><button class="small" :disabled="taken.has('b' + i)" @click="once('b' + i, (h) => store.giveItem(h, 'bottle', String(b), 1, false))">Взять бутылку ({{ b }})</button></template>
    <button v-if="hints?.artifact" class="small" :disabled="taken.has('art')" @click="once('art', (h) => store.findArtifact(h))">Найти артефакт (к18)</button>
    <template v-for="(s, i) in hints?.scrolls ?? []" :key="'s' + i"><button class="small" :disabled="taken.has('s' + i)" @click="once('s' + i, (h) => store.giveScroll(h, s.caster as Caster | undefined, s.level))">Свиток{{ s.caster ? ` ${casterName(s.caster)}а` : '' }}{{ s.level ? ` ${s.level} ур.` : '' }}</button></template>
    <span v-for="m in npcs" :key="'npc' + m" class="badge" :title="idx.monsterById.get(m)?.description">{{ idx.monsterById.get(m)?.name }}</span>
  </div>
  <p v-if="lastLuck" class="small" style="color:#d7c56a;margin:.3rem 0 0">{{ lastLuck }}</p>
</template>
