<script setup lang="ts">
import { computed, ref } from 'vue'
import { gameData } from '@/data'
import type { EncounterSpec } from '@/engine/combat'

const emit = defineEmits<{ start: [specs: EncounterSpec[]]; close: [] }>()
const q = ref('')
const picked = ref<Record<string, number>>({})
const list = computed(() => {
  const s = q.value.trim().toLowerCase()
  return gameData.bestiary.filter((m) => !m.special && (!s || m.name.toLowerCase().includes(s)))
})
const specs = computed<EncounterSpec[]>(() => Object.entries(picked.value).filter(([, n]) => n > 0).map(([monsterId, count]) => ({ monsterId, count })))
function add(id: string, d: number) {
  picked.value[id] = Math.max(0, (picked.value[id] ?? 0) + d)
}
</script>

<template>
  <div class="modal-back" @click.self="emit('close')">
    <div class="modal">
      <div class="row between">
        <h3>Выбор противников</h3>
        <button class="small" @click="emit('close')">Закрыть</button>
      </div>
      <input v-model="q" placeholder="Поиск по бестиарию…" style="width: 100%; margin: .5rem 0" />
      <div class="row" style="margin-bottom:.5rem" v-if="specs.length">
        <span v-for="s in specs" :key="s.monsterId" class="badge accent">{{ gameData.bestiary.find(m => m.id === s.monsterId)?.name }} ×{{ s.count }}</span>
        <button class="primary" @click="emit('start', specs)">Начать бой</button>
      </div>
      <table class="list">
        <thead><tr><th>Монстр</th><th>Ур.</th><th>Защита</th><th>Жизни</th><th>Атаки</th><th></th></tr></thead>
        <tbody>
          <tr v-for="m in list" :key="m.id">
            <td>{{ m.name }}</td><td>{{ m.level }}</td><td>{{ m.defense ?? '—' }}</td><td>{{ m.lives ?? '—' }}</td>
            <td class="small">{{ Array.isArray(m.attacks) ? m.attacks.join('-') : m.attacks }}</td>
            <td class="row" style="flex-wrap:nowrap">
              <button class="small" @click="add(m.id, -1)">−</button>
              <span style="min-width:1.2rem;text-align:center">{{ picked[m.id] ?? 0 }}</span>
              <button class="small" @click="add(m.id, 1)">+</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
