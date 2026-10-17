<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { RollOption } from '@/types'
import type { EncounterSpec } from '@/engine/combat'
import { useGameStore } from '@/stores/game'
import ParagraphActions from './ParagraphActions.vue'

/** Список исходов «1 — …, 2 — …» с броском кубика */
const props = defineProps<{ options: RollOption[]; context?: string; heroUid?: string }>()
const emit = defineEmits<{ fight: [specs: EncounterSpec[]] }>()
const chosen = computed(() => (result.value === null ? null : props.options.find((o) => o.values.includes(result.value!)) ?? null))
const store = useGameStore()
const result = ref<number | null>(null)
const sides = computed(() => (Math.max(...props.options.flatMap((o) => o.values)) > 6 ? 18 : 6))
watch(() => props.options, () => { result.value = null })
function rollIt() {
  result.value = store.rollDie(sides.value, props.context)
  const hit = props.options.find((o) => o.values.includes(result.value!))
  if (hit) store.log(`Выпало ${result.value}: ${hit.text}`, 'luck')
}
</script>

<template>
  <div class="card tight" style="margin:.4rem 0;background:var(--bg)">
    <div v-for="(o, i) in options" :key="i" class="small" :style="result !== null && o.values.includes(result) ? 'color:var(--accent);font-weight:700' : ''">
      <b>{{ o.values.join(', ') }}</b> — {{ o.text }}
    </div>
    <div class="row" style="margin-top:.35rem">
      <button class="small primary" @click="rollIt">Бросить к{{ sides }}</button>
      <span v-if="result !== null" class="small">Выпало <b>{{ result }}</b></span>
    </div>
    <ParagraphActions v-if="chosen?.hints && heroUid" :hints="chosen.hints" :hero-uid="heroUid" @fight="(s) => emit('fight', s)" />
  </div>
</template>
