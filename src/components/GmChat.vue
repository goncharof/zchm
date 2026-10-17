<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useGameStore } from '@/stores/game'
import { onVoicesChanged, russianVoices, saveSpeechPrefs, speak, speaking, speechPrefs, speechSupported, stopSpeaking } from '@/ui/speech'

/** Стол: рассказ ведущего, реплики игроков, сообщения игры */
const props = withDefaults(defineProps<{ height?: string }>(), { height: '60vh' })
const store = useGameStore()
const text = ref('')
const toGm = ref(true)
const box = ref<HTMLElement | null>(null)
const ai = computed(() => store.room?.gm === 'ai' || store.room?.gm === 'script')
const live = computed(() => Object.entries(store.streaming).filter(([, t]) => t))
const items = computed(() => store.chat.slice(-120))

watch(() => [store.chat.length, JSON.stringify(store.streaming).length], async () => {
  await nextTick()
  if (box.value) box.value.scrollTop = box.value.scrollHeight
}, { immediate: true })

// озвучка: голоса приходят асинхронно
const canSpeak = speechSupported()
const voices = ref(russianVoices())
const offVoices = onVoicesChanged(() => { voices.value = russianVoices() })
onBeforeUnmount(offVoices)
function toggleSpeech() {
  saveSpeechPrefs()
  if (speechPrefs.value.on) speak('Озвучка ведущего включена.') // первый звук по нажатию — иначе iOS не разрешит
  else stopSpeaking()
}

// ход по готовности
const readyMode = computed(() => ai.value && store.room?.turnMode === 'ready')
const iAmReady = computed(() => !!store.room && store.room.ready.includes(store.room.me.id))
const waiting = computed(() => {
  const r = store.room
  if (!r) return []
  return r.players.filter((p) => r.active.includes(p.id)).map((p) => ({ name: p.name, ready: r.ready.includes(p.id) }))
})

async function send() {
  const t = text.value.trim()
  if (!t) return
  text.value = ''
  const ok = await store.sendChat(t, ai.value && toGm.value)
  // отказ сервера (слишком часто и т.п.) — вернуть текст в поле ввода
  if (!ok && !text.value) text.value = t
}
</script>

<template>
  <div class="gm-chat">
    <div ref="box" class="gm-chat-log" :style="{ height: props.height }">
      <div v-if="!items.length && !live.length" class="muted small">Здесь будет рассказ ведущего и реплики игроков.</div>
      <div v-for="m in items" :key="m.id" class="gm-msg" :class="m.from">
        <div class="gm-author">{{ m.author }}<span v-if="m.from === 'player' && ai && !m.toGm" class="muted"> · игрокам</span></div>
        <div class="gm-text">{{ m.text }}</div>
        <div v-if="m.choices?.length" class="row" style="margin-top:.35rem">
          <button v-for="c in m.choices" :key="c.id" class="small" :class="{ primary: !m.used?.includes(c.id) && c.label.startsWith('▸') }" :disabled="m.used?.includes(c.id)" @click="store.choose(m.id, c.id)">{{ c.label }}</button>
        </div>
      </div>
      <div v-for="[id, t] in live" :key="id" class="gm-msg gm">
        <div class="gm-author">Ведущий <span class="muted">пишет…</span></div>
        <div class="gm-text">{{ t }}</div>
      </div>
      <div v-if="ai && store.room?.gmBusy && !live.length" class="muted small">Ведущий обдумывает ход…</div>
      <div v-if="readyMode && store.room && !store.room.gmBusy && (store.room.held || store.room.ready.length)" class="muted small">Ведущий ждёт готовности всех. Реплик в очереди: {{ store.room.held }}.</div>
      <div v-if="store.room?.gm === 'script'" class="muted small">Сценарный ведущий понимает номера помещений и кнопки вариантов.</div>
    </div>
    <div class="row" style="margin-top:.5rem;flex-wrap:nowrap">
      <textarea v-model="text" rows="2" style="flex:1;resize:vertical" :placeholder="ai && toGm ? (readyMode ? 'Что делает ваш герой? Ведущий ответит, когда напишут или нажмут «Готов» все' : 'Что делают ваши герои? (Enter — отправить ведущему)') : 'Сообщение игрокам'" @keydown.enter.exact.prevent="send" />
      <button class="primary" @click="send">Отправить</button>
    </div>
    <div v-if="readyMode" class="row small ready-bar" style="gap:.4rem;margin-top:.3rem">
      <span class="muted">Ход по готовности:</span>
      <span v-for="w in waiting" :key="w.name" class="chip" :style="{ borderColor: w.ready ? 'var(--ok)' : undefined, color: w.ready ? 'var(--ok)' : undefined }">{{ w.ready ? '✓' : '…' }} {{ w.name }}</span>
      <button class="small" :class="{ primary: !iAmReady }" @click="store.setReady(!iAmReady)">{{ iAmReady ? 'Я ещё не готов' : 'Готов' }}</button>
      <button v-if="store.room?.me.isHost" class="small" title="Не ждать остальных" @click="store.turnGo()">Ход ведущего</button>
    </div>
    <label v-if="ai" class="row small" style="gap:.3rem;margin-top:.3rem"><input type="checkbox" v-model="toGm" /> ведущему (иначе — только игрокам, ведущий не услышит)</label>
    <div v-if="canSpeak" class="row small" style="gap:.5rem;margin-top:.3rem">
      <label class="row" style="gap:.3rem"><input type="checkbox" v-model="speechPrefs.on" @change="toggleSpeech" /> озвучивать ведущего</label>
      <template v-if="speechPrefs.on">
        <select v-if="voices.length > 1" v-model="speechPrefs.voice" class="small" title="Голос" @change="saveSpeechPrefs">
          <option :value="undefined">голос по умолчанию</option>
          <option v-for="v in voices" :key="v.name" :value="v.name">{{ v.name }}</option>
        </select>
        <select v-model.number="speechPrefs.rate" class="small" title="Скорость" @change="saveSpeechPrefs">
          <option :value="0.85">медленно</option><option :value="1">обычно</option><option :value="1.2">быстрее</option><option :value="1.4">быстро</option>
        </select>
        <button v-if="speaking" class="small" @click="stopSpeaking">Стоп</button>
        <span v-if="!voices.length" class="muted">в системе не найден русский голос, браузер прочтёт как сможет</span>
      </template>
    </div>
  </div>
</template>
