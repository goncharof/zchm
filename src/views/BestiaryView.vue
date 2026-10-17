<script setup lang="ts">
import { computed, ref } from 'vue'
import { gameData } from '@/data'
import type { Monster } from '@/types'
import { attacksStr } from '@/ui/format'

const q = ref('')
const level = ref<'all' | 'npc' | '1-2' | '3-5' | '6-9' | '10-12'>('all')
const sort = ref<'name' | 'level'>('name')
const RANGES: Record<string, [number, number]> = { '1-2': [1, 2], '3-5': [3, 5], '6-9': [6, 9], '10-12': [10, 12] }
const open = ref<Monster | null>(null)
const base = import.meta.env.BASE_URL
const list = computed(() => {
  const s = q.value.trim().toLowerCase()
  const out = gameData.bestiary.filter((m) => {
    if (s && !m.name.toLowerCase().includes(s) && !m.description.toLowerCase().includes(s)) return false
    if (level.value === 'npc') return !!m.special
    if (level.value !== 'all') {
      const [a, b] = RANGES[level.value]
      return !m.special && (m.level ?? 0) >= a && (m.level ?? 0) <= b
    }
    return true
  })
  if (sort.value === 'level') out.sort((a, b) => (a.level ?? 99) - (b.level ?? 99) || a.name.localeCompare(b.name, 'ru'))
  return out
})
const EXTRA: Record<string, string> = { petrify: 'окаменение', freeze: 'оледенение', paralysis: 'паралич', poison: 'яд' }
</script>

<template>
  <div class="row between" style="margin-bottom:.6rem">
    <h1>Бестиарий <span class="badge">{{ list.length }} из {{ gameData.bestiary.length }}</span></h1>
    <div class="row">
      <input v-model="q" placeholder="Поиск…" />
      <select v-model="level"><option value="all">все уровни</option><option value="1-2">1–2</option><option value="3-5">3–5</option><option value="6-9">6–9</option><option value="10-12">10–12</option><option value="npc">персонажи</option></select>
      <select v-model="sort"><option value="name">по имени</option><option value="level">по уровню</option></select>
    </div>
  </div>
  <div class="grid" style="grid-template-columns: repeat(auto-fill, minmax(150px, 1fr))">
    <div v-for="m in list" :key="m.id" class="card tight" style="cursor:pointer" @click="open = m">
      <img class="thumb" :src="base + m.image" :alt="m.name" loading="lazy" />
      <div style="margin-top:.4rem"><b>{{ m.name }}</b></div>
      <div class="small muted" v-if="m.level !== undefined">ур. {{ m.level }} · защита {{ m.defense ?? '—' }} · жизни {{ m.lives ?? '—' }}</div>
      <div class="small muted" v-else>персонаж</div>
    </div>
  </div>
  <div v-if="open" class="modal-back" @click.self="open = null">
    <div class="modal">
      <div class="row between"><h2>{{ open.name }}</h2><button class="small" @click="open = null">Закрыть</button></div>
      <div class="monster-card" style="grid-template-columns: 260px 1fr">
        <img :src="base + open.image" :alt="open.name" style="width:260px;height:auto;object-fit:contain" />
        <div>
          <div class="stat-table" v-if="open.level !== undefined">
            <div><b>Уровень</b> {{ open.level }}</div><div><b>Атаки</b> {{ attacksStr(open.attacks) }}</div><div><b>Защита</b> {{ open.defense ?? 'нет' }}</div>
            <div><b>Храбрость</b> {{ open.courage ?? 'нет' }}</div><div v-if="open.mana"><b>Мана</b> {{ open.mana }}</div><div><b>Жизни</b> {{ open.lives ?? 'нет' }}<span v-if="open.heads" class="muted"> ({{ open.heads }} {{ open.heads > 4 ? 'голов' : 'головы' }} × {{ open.livesPerHead }})</span></div><div><b>Очки</b> {{ open.points ?? '—' }} за жизнь</div>
          </div>
          <p v-if="open.extraAttacks?.length" class="small"><b>Дополнительная атака:</b> {{ open.extraAttacks.map(e => `${EXTRA[e.kind]} — ${e.threshold}`).join(', ') }}</p>
          <p v-if="open.spells?.length" class="small"><b>Заклинания:</b> {{ open.spells.join(', ') }}</p>
          <p v-if="open.luckSave" class="small"><b>Удача от {{ open.luckSave.against }}:</b> {{ open.luckSave.threshold }}</p>
          <p style="margin-top:.5rem">{{ open.description }}</p>
          <p class="small muted">Бестиарий, стр. {{ open.page }}</p>
        </div>
      </div>
    </div>
  </div>
</template>
