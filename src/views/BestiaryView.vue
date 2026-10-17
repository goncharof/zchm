<script setup lang="ts">
import { computed, ref } from 'vue'
import { gameData } from '@/data'
import type { Monster } from '@/types'
import { attacksStr } from '@/ui/format'

const q = ref('')
const open = ref<Monster | null>(null)
const base = import.meta.env.BASE_URL
const list = computed(() => {
  const s = q.value.trim().toLowerCase()
  return gameData.bestiary.filter((m) => !s || m.name.toLowerCase().includes(s) || m.description.toLowerCase().includes(s))
})
const EXTRA: Record<string, string> = { petrify: 'окаменение', freeze: 'оледенение', paralysis: 'паралич', poison: 'яд' }
</script>

<template>
  <div class="row between" style="margin-bottom:.6rem">
    <h1>Бестиарий <span class="badge">{{ gameData.bestiary.length }} статей</span></h1>
    <input v-model="q" placeholder="Поиск…" />
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
