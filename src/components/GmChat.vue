<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useGameStore } from '@/stores/game'

/** Стол: рассказ ведущего, реплики игроков, сообщения игры */
const props = withDefaults(defineProps<{ height?: string }>(), { height: '60vh' })
const store = useGameStore()
const text = ref('')
const toGm = ref(true)
const box = ref<HTMLElement | null>(null)
const ai = computed(() => store.room?.gm === 'ai')
const live = computed(() => Object.entries(store.streaming).filter(([, t]) => t))
const items = computed(() => store.chat.slice(-120))

watch(() => [store.chat.length, JSON.stringify(store.streaming).length], async () => {
  await nextTick()
  if (box.value) box.value.scrollTop = box.value.scrollHeight
}, { immediate: true })

async function send() {
  const t = text.value.trim()
  if (!t) return
  text.value = ''
  await store.sendChat(t, ai.value && toGm.value)
}
</script>

<template>
  <div class="gm-chat">
    <div ref="box" class="gm-chat-log" :style="{ height: props.height }">
      <div v-if="!items.length && !live.length" class="muted small">Здесь будет рассказ ведущего и реплики игроков.</div>
      <div v-for="m in items" :key="m.id" class="gm-msg" :class="m.from">
        <div class="gm-author">{{ m.author }}<span v-if="m.from === 'player' && ai && !m.toGm" class="muted"> · игрокам</span></div>
        <div class="gm-text">{{ m.text }}</div>
      </div>
      <div v-for="[id, t] in live" :key="id" class="gm-msg gm">
        <div class="gm-author">Ведущий <span class="muted">пишет…</span></div>
        <div class="gm-text">{{ t }}</div>
      </div>
      <div v-if="ai && store.room?.gmBusy && !live.length" class="muted small">Ведущий обдумывает ход…</div>
    </div>
    <div class="row" style="margin-top:.5rem;flex-wrap:nowrap">
      <textarea v-model="text" rows="2" style="flex:1;resize:vertical" :placeholder="ai && toGm ? 'Что делают ваши герои? (Enter — отправить ведущему)' : 'Сообщение игрокам'" @keydown.enter.exact.prevent="send" />
      <button class="primary" @click="send">Отправить</button>
    </div>
    <label v-if="ai" class="row small" style="gap:.3rem;margin-top:.3rem"><input type="checkbox" v-model="toGm" /> ведущему (иначе — только игрокам, ведущий не услышит)</label>
  </div>
</template>
