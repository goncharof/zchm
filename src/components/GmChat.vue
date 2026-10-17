<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { SendHorizontal, Volume2, VolumeX } from 'lucide-vue-next'
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

/** мой голос за вариант */
function myVote(m: { votes?: Record<string, { id: string }[]> }, choiceId: string): boolean {
  const me = store.room?.me.id
  return !!me && !!m.votes?.[choiceId]?.some((v) => v.id === me)
}

/** поле ввода растёт по мере набора (до четырёх строк) */
const input = ref<HTMLTextAreaElement | null>(null)
function autosize() {
  const el = input.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = `${Math.min(el.scrollHeight, 140)}px`
}
watch(text, () => void nextTick(autosize))
function flipSpeech() {
  speechPrefs.value.on = !speechPrefs.value.on
  toggleSpeech()
}

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
      <div v-for="m in items" :key="m.id" class="gm-msg" :class="[m.from, { mine: m.from === 'player' && !!store.room && m.author.startsWith(store.room.me.name) }]">
        <div class="gm-author">{{ m.author }}<span v-if="m.from === 'player' && ai && !m.toGm" class="muted"> · игрокам</span></div>
        <div class="gm-text">{{ m.text }}</div>
        <div v-if="m.choices?.length" class="row" style="margin-top:.35rem">
          <button v-for="c in m.choices" :key="c.id" class="small" :class="{ primary: !m.used?.includes(c.id) && c.label.startsWith('▸'), voted: myVote(m, c.id) }" :disabled="m.used?.includes(c.id)" :title="m.votes?.[c.id]?.length ? `Голоса: ${m.votes[c.id].map((v) => v.name).join(', ')}` : ''" @click="store.choose(m.id, c.id)">{{ c.label }}<span v-if="m.votes?.[c.id]?.length" class="vote-count"> · {{ m.votes[c.id].length }}</span></button>
        </div>
        <div v-if="m.votes && Object.keys(m.votes).length" class="small muted" style="margin-top:.2rem">Голосование: вариант сработает, когда проголосуют все{{ store.room?.me.isHost ? ' (или нажмите «Ход ведущего»)' : '' }}.</div>
      </div>
      <div v-for="[id, t] in live" :key="id" class="gm-msg gm">
        <div class="gm-author">Ведущий <span class="muted">пишет…</span></div>
        <div class="gm-text">{{ t }}</div>
      </div>
      <div v-if="ai && store.room?.gmBusy && !live.length" class="muted small">Ведущий обдумывает ход…</div>
      <div v-if="readyMode && store.room && !store.room.gmBusy && (store.room.held || store.room.ready.length)" class="muted small">Ведущий ждёт готовности всех. Реплик в очереди: {{ store.room.held }}.</div>
      <div v-if="store.room?.gm === 'script'" class="muted small">Сценарный ведущий понимает номера помещений и кнопки вариантов.</div>
    </div>
    <div v-if="readyMode" class="ready-bar">
      <span class="muted small">Ход по готовности</span>
      <span v-for="w in waiting" :key="w.name" class="chip" :class="{ ok: w.ready }">{{ w.ready ? '✓' : '…' }} {{ w.name }}</span>
      <span class="grow" />
      <button class="small" :class="{ primary: !iAmReady }" @click="store.setReady(!iAmReady)">{{ iAmReady ? 'Я ещё не готов' : 'Готов' }}</button>
      <button v-if="store.room?.me.isHost" class="small" title="Не ждать остальных" @click="store.turnGo()">Ход ведущего</button>
    </div>
    <form class="composer" @submit.prevent="send">
      <div v-if="ai" class="seg" role="group" aria-label="Кому">
        <button type="button" :class="{ active: toGm }" :aria-pressed="toGm" @click="toGm = true">Ведущему</button>
        <button type="button" :class="{ active: !toGm }" :aria-pressed="!toGm" title="Ведущий не услышит" @click="toGm = false">Игрокам</button>
      </div>
      <div class="composer-row">
        <textarea ref="input" v-model="text" rows="1" :placeholder="ai && toGm ? (readyMode ? 'Что делает ваш герой?' : 'Что делают ваши герои?') : 'Сообщение игрокам'" enterkeyhint="send" @keydown.enter.exact.prevent="send" />
        <button type="submit" class="primary send" aria-label="Отправить" title="Отправить (Enter)"><SendHorizontal :size="18" /><span class="send-lbl">Отправить</span></button>
        <button v-if="canSpeak" type="button" class="icon ghost speech" :class="{ on: speechPrefs.on }" :aria-pressed="speechPrefs.on" aria-label="озвучивать ведущего" :title="speechPrefs.on ? 'Озвучка ведущего включена' : 'Озвучивать ведущего'" @click="flipSpeech"><Volume2 v-if="speechPrefs.on" :size="19" /><VolumeX v-else :size="19" /></button>
      </div>
      <div v-if="ai && toGm && readyMode" class="small muted">Ведущий ответит, когда напишут или нажмут «Готов» все.</div>
      <div v-if="canSpeak && speechPrefs.on" class="row small speech-opts">
        <select v-if="voices.length > 1" v-model="speechPrefs.voice" class="small" title="Голос" @change="saveSpeechPrefs">
          <option :value="undefined">голос по умолчанию</option>
          <option v-for="v in voices" :key="v.name" :value="v.name">{{ v.name }}</option>
        </select>
        <select v-model.number="speechPrefs.rate" class="small" title="Скорость" @change="saveSpeechPrefs">
          <option :value="0.85">медленно</option><option :value="1">обычно</option><option :value="1.2">быстрее</option><option :value="1.4">быстро</option>
        </select>
        <button v-if="speaking" type="button" class="small" @click="stopSpeaking">Стоп</button>
        <span v-if="!voices.length" class="muted">русский голос в системе не найден</span>
      </div>
    </form>
  </div>
</template>
