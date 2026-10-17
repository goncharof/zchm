<script setup lang="ts">
import { ref } from 'vue'
import { useGameStore } from '@/stores/game'

/** Лоток кубиков для свободных бросков (ведущему и игрокам) */
const emit = defineEmits<{ close: [] }>()
const store = useGameStore()
const formula = ref('3к6')
const history = ref<string[]>([])
async function rollIt(f: string) {
  const r = await store.rollDice(f)
  if (!r) return
  const text = `${f} = ${r.total}${r.rolls.length > 1 || /[+-]/.test(f) ? ` (${r.rolls.join(' + ')}${f.match(/[+-]\d+$/)?.[0] ?? ''})` : ''}`
  history.value = [text, ...history.value].slice(0, 8)
}
</script>

<template>
  <div class="modal-back" @click.self="emit('close')">
    <div class="modal" style="max-width:420px">
      <div class="row between"><h3>Кубики</h3><button class="small" @click="emit('close')">Закрыть</button></div>
      <div class="row" style="margin:.5rem 0">
        <button class="primary" @click="rollIt('1к6')">к6</button>
        <button class="primary" @click="rollIt('1к18')">к18</button>
        <button @click="rollIt('2к6')">2к6</button>
        <button @click="rollIt('1к3')">к3</button>
      </div>
      <div class="row"><input v-model="formula" style="width:8rem" placeholder="3к6+8" @keyup.enter="rollIt(formula)" /><button @click="rollIt(formula)">Бросить</button></div>
      <div v-if="history.length" style="margin-top:.6rem">
        <div v-for="(h, i) in history" :key="i" :style="i === 0 ? 'font-size:1.3rem;color:var(--accent)' : 'color:var(--muted)'">{{ h }}</div>
      </div>
    </div>
  </div>
</template>
