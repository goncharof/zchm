<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import { CircleQuestionMark } from 'lucide-vue-next'

/** Подсказка под знаком вопроса: пояснение нужно один раз, поэтому на экране его нет, пока не спросят.
 *  На компьютере — всплывает под кнопкой, на телефоне — плашкой над нижней панелью. */
withDefaults(defineProps<{ label?: string; align?: 'left' | 'right' }>(), { label: 'Подсказка', align: 'left' })
const open = ref(false)
const root = ref<HTMLElement | null>(null)
function onDoc(e: Event) { if (root.value && !root.value.contains(e.target as Node)) open.value = false }
function onKey(e: KeyboardEvent) { if (e.key === 'Escape') open.value = false }
function unbind() { document.removeEventListener('click', onDoc); document.removeEventListener('keydown', onKey) }
watch(open, (v) => {
  unbind()
  if (v) { document.addEventListener('click', onDoc); document.addEventListener('keydown', onKey) }
})
onBeforeUnmount(unbind)
</script>

<template>
  <span ref="root" class="hint-tip" :class="[align, { open }]">
    <button type="button" class="hint-btn" :aria-expanded="open" :aria-label="label" :title="label" @click="open = !open"><CircleQuestionMark :size="16" aria-hidden="true" /></button>
    <span v-if="open" class="hint-pop" role="note"><slot /></span>
  </span>
</template>
