<script setup lang="ts">
import { onMounted, ref } from 'vue'

interface Block { text?: string; verse?: string; sep?: boolean }
interface Chapter { id: string; title: string; page: number; blocks: Block[] }
const chapters = ref<Chapter[]>([])
const current = ref<Chapter | null>(null)
onMounted(async () => {
  const mod = await import('@/data/lore.json')
  chapters.value = (mod.default ?? mod) as unknown as Chapter[]
  current.value = chapters.value[0] ?? null
})
</script>

<template>
  <h1>Книга Сумерек <span class="badge">предыстория мира Тмамрак</span></h1>
  <p class="small muted">Художественный текст Олега Тарасова из коробки игры: хроники эпохи Сумерек и истории крепостей и городов, куда отправится партия.</p>
  <div class="grid wide" style="grid-template-columns: 260px 1fr">
    <div class="card tight">
      <div v-for="c in chapters" :key="c.id" style="margin:.15rem 0">
        <a href="#" :style="{ fontWeight: current?.id === c.id ? 700 : 400 }" @click.prevent="current = c">{{ c.title }}</a>
        <span class="small muted"> · стр. {{ c.page }}</span>
      </div>
    </div>
    <div class="card" v-if="current">
      <h2>{{ current.title }}</h2>
      <template v-for="(b, i) in current.blocks" :key="i">
        <p v-if="b.text">{{ b.text }}</p>
        <p v-else-if="b.verse" class="paragraph-text" style="font-style:italic;padding-left:1.5rem">{{ b.verse }}</p>
        <p v-else class="muted" style="text-align:center">* * *</p>
      </template>
    </div>
  </div>
</template>
