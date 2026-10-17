<script setup lang="ts">
import { computed, ref } from 'vue'
import { gameData } from '@/data'

const caster = ref<'priest' | 'mage'>('priest')
const levels = computed(() => {
  const out: { level: number; spells: typeof gameData.spells }[] = []
  for (let l = 0; l <= 12; l++) {
    const spells = gameData.spells.filter((s) => s.caster === caster.value && s.level === l)
    if (spells.length) out.push({ level: l, spells })
  }
  return out
})
</script>

<template>
  <h1>Магия и заклинания</h1>
  <div class="tabs">
    <button :class="{ active: caster === 'priest' }" @click="caster = 'priest'">Заклинания жреца</button>
    <button :class="{ active: caster === 'mage' }" @click="caster = 'mage'">Заклинания мага</button>
  </div>
  <p class="small muted">Пользоваться можно только заклинаниями, записанными в книгу: заклинание 0 уровня известно с начала, новые — при переходе на уровень или со свитков. Опыт начисляется за удачно применённое заклинание.</p>
  <div v-for="g in levels" :key="g.level" class="card">
    <h2>{{ g.level }} уровень</h2>
    <table class="list stack">
      <thead><tr><th>Заклинание</th><th>Мана</th><th>Место действия</th><th>Удача</th><th>Опыт</th><th>Описание</th></tr></thead>
      <tbody>
        <tr v-for="s in g.spells" :key="s.id">
          <td data-label="Заклинание"><b>{{ s.name }}</b><div v-if="s.duration" class="small muted">{{ s.duration }}</div></td>
          <td data-label="Мана">{{ s.cost ?? s.costFormula }}</td><td data-label="Место действия" class="small">{{ s.target ?? '—' }}</td><td data-label="Удача">{{ s.luck ?? '—' }}</td><td data-label="Опыт" class="small">{{ s.xp ?? s.xpFormula }}</td>
          <td data-label="Описание" class="small">{{ s.description }}</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
