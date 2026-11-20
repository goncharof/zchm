<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useGameStore } from '@/stores/game'
import { savedTime } from '@/ui/format'

/** Сохранения: как сохраняется партия (одиночная — браузер, сетевая — сервер), слоты, файл, отложить игру */
// roomActions: кнопки «Отложить игру» и ссылка — на главной они уже есть в панели «Игра по сети»
const props = withDefaults(defineProps<{ roomActions?: boolean }>(), { roomActions: true })
const emit = defineEmits<{ done: [] }>()
const store = useGameStore()
const router = useRouter()
const fileInput = ref<HTMLInputElement | null>(null)
const r = computed(() => store.room)
/** загружать сохранения в сетевой игре может только хозяин комнаты */
const canLoad = computed(() => !store.online || !!r.value?.me.isHost)
const myName = computed(() => r.value?.players.find((p) => p.id === r.value?.me.id)?.name ?? '')
const when = computed(() => (store.savedAt ? savedTime(store.savedAt) : ''))
const lost = computed(() => store.online && store.netStatus === 'reconnecting')

const slotsVersion = ref(0)
const slots = computed(() => { void slotsVersion.value; return [1, 2, 3].map((n) => store.slotInfo(n)) })
const replaceWarn = computed(() => store.online ? 'Партия комнаты заменится у всех игроков. Продолжить?' : 'Текущая партия будет заменена сохранением. Продолжить?')

function continueGame() {
  emit('done')
  if (store.combat) router.push('/combat')
  else if (store.location) router.push(`/location/${store.location.id}`)
  else if (store.heroes.length) router.push('/map')
  else router.push('/party')
}
function save(n: number) {
  if (slots.value[n - 1] && !confirm(`Перезаписать слот ${n}?`)) return
  store.saveSlot(n); slotsVersion.value++
}
async function load(n: number) {
  if (store.started && !confirm(replaceWarn.value)) return
  store.loadSlot(n); slotsVersion.value++
  continueGame()
}
function clear(n: number) {
  if (!confirm(`Удалить слот ${n}?`)) return
  store.clearSlot(n); slotsVersion.value++
}
function download() {
  const blob = new Blob([store.exportSave()], { type: 'application/json' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  const tag = store.online && r.value ? `-${r.value.code}` : ''
  a.download = `zchm-save${tag}-day${store.game?.day ?? 0}.json`
  a.click()
  URL.revokeObjectURL(a.href)
  store.say('Файл сохранения скачан')
}
function pickFile() {
  if (store.started && !confirm(replaceWarn.value)) return
  fileInput.value?.click()
}
async function upload(ev: Event) {
  const input = ev.target as HTMLInputElement
  const f = input.files?.[0]
  input.value = ''
  if (!f) return
  try { if (await store.importSave(await f.text())) { store.say('Сохранение загружено'); continueGame() } } catch (e) { store.say((e as Error).message) }
}
function copyLink() {
  const url = `${location.origin}${location.pathname}#/?room=${r.value?.code}`
  void navigator.clipboard?.writeText(url).then(() => store.say('Ссылка скопирована'))
}
function suspend() {
  emit('done')
  store.suspendRoom()
  router.push('/')
}
</script>

<template>
  <div class="saves">
    <!-- как сохраняется партия -->
    <template v-if="store.online && r">
      <p class="save-status" :class="{ off: lost }">
        <template v-if="lost">Нет связи с сервером — ходы не сохраняются, пока она не вернётся.</template>
        <template v-else>✓ Партия комнаты <b>{{ r.code }}</b> хранится на сервере и сохраняется после каждого действия<span v-if="when"> (последний раз {{ when }})</span>.</template>
      </p>
      <ul class="save-how small">
        <li><b>Закончить вечер:</b> нажмите «Отложить игру» или просто закройте вкладку — ваши герои останутся за вами<span v-if="r.me.isHost">, а вы — хозяином комнаты</span>.</li>
        <li><b>Вернуться:</b> на этом устройстве — «Недавние комнаты» на главной; с другого — код <b>{{ r.code }}</b> и то же имя<span v-if="myName"> «{{ myName }}»</span>.<span v-if="r.me.isHost"> С другого устройства хозяин войдёт обычным игроком.</span></li>
      </ul>
      <div v-if="props.roomActions" class="row">
        <button class="primary small" @click="suspend">Отложить игру</button>
        <button class="small" @click="copyLink">Скопировать ссылку на комнату</button>
      </div>
    </template>
    <template v-else>
      <p v-if="store.started" class="save-status">✓ Игра сохраняется сама в этом браузере<span v-if="when"> (последний раз {{ when }})</span>.</p>
      <p v-else class="save-status muted">Партии пока нет. Начатая игра будет сохраняться сама в этом браузере.</p>
      <ul class="save-how small">
        <li><b>Закончить:</b> просто закройте вкладку. В следующий раз нажмите «Продолжить» на главной.</li>
        <li><b>Другое устройство или браузер:</b> скачайте файл сохранения и загрузите его там. Файл выручит и после очистки браузера.</li>
      </ul>
    </template>

    <!-- слоты -->
    <h3 class="save-h">Запасные копии в этом браузере</h3>
    <p class="small muted">Например, перед опасным боем.<template v-if="store.online"> Загрузить копию может только хозяин комнаты — партия заменится у всех.</template></p>
    <div v-for="n in [1, 2, 3]" :key="n" class="slot">
      <div class="slot-info">
        <b>Слот {{ n }}</b>
        <span v-if="slots[n - 1]" class="small">День {{ slots[n - 1]!.day }} · {{ slots[n - 1]!.heroes || 'без героев' }} · <span class="muted">{{ savedTime(slots[n - 1]!.savedAt) }}</span></span>
        <span v-else class="small muted">пусто</span>
      </div>
      <div class="slot-actions">
        <button class="small" :disabled="!store.started" :aria-label="`Сохранить в слот ${n}`" @click="save(n)">Сохранить</button>
        <button v-if="canLoad" class="small" :disabled="!slots[n - 1]" :aria-label="`Загрузить слот ${n}`" @click="load(n)">Загрузить</button>
        <button class="small ghost" :disabled="!slots[n - 1]" title="Удалить слот" :aria-label="`Удалить слот ${n}`" @click="clear(n)">✕</button>
      </div>
    </div>

    <!-- файл -->
    <h3 class="save-h">Файл сохранения</h3>
    <div class="row">
      <button class="small" :disabled="!store.started" @click="download">Скачать файл</button>
      <button v-if="canLoad" class="small" @click="pickFile">Загрузить из файла</button>
      <span v-else class="small muted">Загрузить файл в комнату может хозяин.</span>
      <input ref="fileInput" type="file" accept="application/json,.json" style="display:none" @change="upload" />
    </div>
  </div>
</template>
