<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { RollOption } from '@/types'
import type { EncounterSpec } from '@/engine/combat'
import { useGameStore } from '@/stores/game'
import ParagraphActions from './ParagraphActions.vue'
import { rollSides } from '@/game/book'

/** Список исходов «1 — …, 2 — …» с броском кубика */
/** place — где в книге список (для броска один раз и наград его исходов) */
const props = defineProps<{ options: RollOption[]; context?: string; heroUid?: string; place?: string; repeat?: boolean }>()
const emit = defineEmits<{ fight: [specs: EncounterSpec[]] }>()
const chosen = computed(() => (result.value === null ? null : props.options.find((o) => o.values.includes(result.value!)) ?? null))
const store = useGameStore()
const result = ref<number | null>(null)
const sides = computed(() => rollSides(props.options))
// бросок по списку — один раз: при повторном открытии показывается выпавшее (иначе перебрасывали бы до награды)
const rolled = computed(() => {
  const k = props.place && !props.repeat ? (store.game?.claimed ?? []).find((x) => x.startsWith(`${props.place}:roll=`)) : undefined
  return k ? Number(k.split('=')[1]) : null
})
watch([() => props.options, rolled], () => { result.value = rolled.value }, { immediate: true })
async function rollIt() {
  if (rolled.value !== null) { result.value = rolled.value; return }
  const r = await store.rollDie(sides.value, props.context)
  if (r === undefined) return
  // список «для каждого» (черепа, дома) бросают сколько угодно; обычный — один раз
  if (props.place && !props.repeat && !(await store.claim(`${props.place}:roll=${r}`))) return
  result.value = r
  const hit = props.options.find((o) => o.values.includes(r))
  if (hit) void store.note(`Выпало ${r}: ${hit.text}`, 'luck')
}
</script>

<template>
  <div class="card tight" style="margin:.4rem 0;background:var(--bg)">
    <div v-for="(o, i) in options" :key="i" class="small" :style="result !== null && o.values.includes(result) ? 'color:var(--accent);font-weight:700' : ''">
      <b>{{ o.values.join(', ') }}</b> — {{ o.text }}
    </div>
    <div class="row" style="margin-top:.35rem">
      <button class="small primary" :disabled="rolled !== null" @click="rollIt">{{ rolled !== null ? 'Брошено' : `Бросить к${sides}` }}</button>
      <span v-if="result !== null" class="small">Выпало <b>{{ result }}</b></span>
    </div>
    <ParagraphActions v-if="chosen?.hints && heroUid" :hints="chosen.hints" :hero-uid="heroUid" :place="place ? `${place}:r${options.indexOf(chosen)}` : undefined" @fight="(s) => emit('fight', s)" />
  </div>
</template>
