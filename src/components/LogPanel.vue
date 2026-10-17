<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import type { LogEntry } from '@/engine/model'

const props = withDefaults(defineProps<{ entries: LogEntry[]; limit?: number }>(), { limit: 40 })
const box = ref<HTMLElement | null>(null)
const shown = computed(() => props.entries.slice(-props.limit))
watch(() => props.entries.length, async () => {
  await nextTick()
  if (box.value) box.value.scrollTop = box.value.scrollHeight
}, { immediate: true })
</script>

<template>
  <div class="log" ref="box">
    <div v-if="!shown.length" class="muted">Журнал пуст.</div>
    <div v-for="(e, i) in shown" :key="i" class="e" :class="e.kind">{{ e.text }}</div>
  </div>
</template>
