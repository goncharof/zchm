<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import type { GmMode } from '@/net/protocol'
import { useGameStore } from '@/stores/game'

const store = useGameStore()
const router = useRouter()
const NAME_KEY = 'zchm.net.name'
const name = ref(readName())
const code = ref('')
// по умолчанию — сценарный ведущий: он ведёт всю книгу без моделей, ИИ — надстройка (бесплатных квот на вечер мало)
const gm = ref<GmMode>('script')
const withParty = ref(true)
function readName(): string { try { return localStorage.getItem(NAME_KEY) ?? '' } catch { return '' } }
function rememberName() { try { localStorage.setItem(NAME_KEY, name.value.trim()) } catch { /* нет хранилища */ } }
const GM_LABEL: Record<GmMode, string> = {
  script: 'сценарный ведущий без ИИ (кнопки по книге, кости, заклинания, решение стола)',
  ai: 'ИИ-ведущий (бесплатные модели, иначе сценарный)',
  book: 'без ведущего (читаем Книгу Жизни сами)',
  human: 'живой ведущий — хозяин комнаты',
}
const SHORT: Record<GmMode, string> = { ai: 'ИИ', script: 'сценарный', book: 'без ведущего', human: 'живой' }
const r = computed(() => store.room)

async function create() {
  if (!name.value.trim()) { store.say('Введите своё имя'); return }
  rememberName()
  const j = await store.createRoom(name.value.trim(), gm.value, withParty.value && store.started)
  if (j) router.push('/table')
}
async function join() {
  if (!name.value.trim() || !code.value.trim()) { store.say('Введите имя и код комнаты'); return }
  rememberName()
  const j = await store.joinRoom(code.value, name.value.trim())
  if (j) router.push('/table')
}
function copyLink() {
  const url = `${location.origin}${location.pathname}#/?room=${r.value?.code}`
  void navigator.clipboard?.writeText(url).then(() => store.say('Ссылка скопирована'))
}
</script>

<template>
  <div class="card">
    <h2>Игра по сети</h2>
    <template v-if="!r">
      <p class="small muted">Соберитесь командой: каждый играет своим героем со своего устройства. Ведущим может быть ИИ, кто-то из вас или никто — тогда Книгу Жизни читают сами игроки.</p>
      <div class="row" style="margin-bottom:.5rem"><label>Ваше имя</label><input v-model="name" maxlength="30" placeholder="Например, Иван" /></div>
      <div class="cols c11">
        <div class="card tight">
          <h3>Новая комната</h3>
          <label class="small">Ведущий</label>
          <select v-model="gm" style="width:100%;margin:.2rem 0 .4rem">
            <option v-for="(label, k) in GM_LABEL" :key="k" :value="k">{{ label }}</option>
          </select>
          <label v-if="store.started" class="row small" style="gap:.3rem"><input type="checkbox" v-model="withParty" /> взять текущую партию</label>
          <button class="primary" :disabled="store.connecting" @click="create">{{ store.connecting ? 'Подключаемся…' : 'Создать комнату' }}</button>
        </div>
        <div class="card tight">
          <h3>Войти по коду</h3>
          <input v-model="code" maxlength="8" placeholder="Код комнаты" style="text-transform:uppercase;width:100%;margin-bottom:.4rem" @keyup.enter="join" />
          <button :disabled="store.connecting" @click="join">{{ store.connecting ? 'Подключаемся…' : 'Войти' }}</button>
        </div>
      </div>
      <p class="small muted" style="margin-top:.4rem">Сценарный ведущий ведёт Книгу Жизни сам: кнопки вариантов, бой, проверки удачи, кости, заклинания жреца и мага, а чего в книге нет — решает стол (удача, кубик, да или нет). ИИ-ведущий сверх того пишет рассказ, но зависит от бесплатных облачных моделей, настроенных на сервере (или Claude по ключу); если ни одна не отвечает, ход ведёт сценарный.</p>
      <details class="how-online small">
        <summary>Как это устроено</summary>
        <ol>
          <li><b>Хозяин</b> создаёт комнату и выбирает ведущего: сценарный (кнопки по книге), ИИ, живой — сам хозяин, или никого.</li>
          <li>Код комнаты из шести знаков или кнопку «Ссылка» отправьте друзьям: они вводят своё имя и код.</li>
          <li>Каждый берёт своего героя на экране «Партия» — кнопка «Взять героя». «Быстрый старт» хозяина создаёт четверых.</li>
          <li>За столом пишите, что делают ваши герои: номер помещения открывает его, реплика «сыграем», «деремся», «берём монеты» нажимает подходящую кнопку. С ИИ-ведущим ход идёт «когда все готовы»: ведущий отвечает, когда каждый написал или нажал «Готов».</li>
          <li>Бой — на экране «Бой»: каждый ходит своим героем, монстры ходят после героев.</li>
          <li>Обновили страницу или пропала связь — игра сама вернёт за стол. Хозяина нет больше двух минут — любой может «Стать хозяином».</li>
        </ol>
      </details>
    </template>
    <template v-else>
      <div class="row between">
        <div><span class="muted small">Комната</span> <b style="font-size:1.6rem;letter-spacing:.15em;color:var(--accent)">{{ r.code }}</b></div>
        <div class="row"><button class="small" @click="copyLink">Ссылка</button><button class="small" @click="router.push('/table')">За стол</button><button class="small danger" @click="store.leaveRoom()">Выйти</button></div>
      </div>
      <p class="small">Ведущий: <b>{{ GM_LABEL[r.gm] }}</b><span v-if="r.gmBusy" class="muted"> — пишет…</span></p>
      <p v-if="r.gm === 'ai'" class="small muted">Модели по порядку: {{ r.gmChain.length ? `${r.gmChain.join(' → ')} → сценарный` : 'не настроены на сервере — ведёт сценарный ведущий' }}.</p>
      <div v-if="r.hostAway && !r.me.isHost" class="row small" style="margin-bottom:.4rem">
        <span class="muted">Хозяина комнаты давно нет в сети — режим ведущего и новую партию сейчас некому менять.</span>
        <button class="small" @click="store.claimHost()">Стать хозяином</button>
      </div>
      <div v-if="r.me.isHost" class="row small" style="margin-bottom:.4rem">
        <span class="muted">Сменить режим:</span>
        <button v-for="(_label, k) in GM_LABEL" :key="k" class="small" :disabled="k === r.gm" @click="store.setGmMode(k)">{{ SHORT[k] }}</button>
      </div>
      <div v-if="r.gm === 'ai' || r.gm === 'script'" class="row small" style="margin-bottom:.4rem">
        <span class="muted">Ведущий отвечает:</span>
        <template v-if="r.me.isHost">
          <button class="small" :disabled="r.turnMode === 'instant'" @click="store.setTurnMode('instant')">сразу</button>
          <button class="small" :disabled="r.turnMode === 'ready'" title="Реплики копятся, пока все не готовы, — меньше запросов к моделям" @click="store.setTurnMode('ready')">когда все готовы</button>
        </template>
        <b v-else>{{ r.turnMode === 'ready' ? 'когда все готовы' : 'сразу на каждую реплику' }}</b>
      </div>
      <div v-if="r.gm === 'script' && r.gmChain.length" class="row small" style="margin-bottom:.4rem">
        <span class="muted">Рассказчик ИИ:</span>
        <template v-if="r.me.isHost">
          <button class="small" :disabled="r.narrator" title="Модель дописывает фразу-другую атмосферы к сценам; механику не трогает, тайн не знает" @click="store.setNarrator(true)">вкл</button>
          <button class="small" :disabled="!r.narrator" @click="store.setNarrator(false)">выкл</button>
        </template>
        <b v-else>{{ r.narrator ? 'включён' : 'выключен' }}</b>
      </div>
      <table class="list">
        <tbody>
          <tr v-for="p in r.players" :key="p.id">
            <td><span :style="{ color: p.online ? 'var(--ok)' : 'var(--muted)' }">●</span> <b>{{ p.name }}</b><span v-if="p.isHost" class="badge accent" style="margin-left:.3rem">хозяин</span><span v-if="p.id === r.me.id" class="badge" style="margin-left:.3rem">вы</span></td>
            <td class="small muted">{{ store.heroes.filter(h => p.heroUids.includes(h.uid)).map(h => h.name).join(', ') || 'без героя' }}</td>
          </tr>
        </tbody>
      </table>
    </template>
  </div>
</template>
