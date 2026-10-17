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
const gm = ref<GmMode>('ai')
const withParty = ref(true)
function readName(): string { try { return localStorage.getItem(NAME_KEY) ?? '' } catch { return '' } }
function rememberName() { try { localStorage.setItem(NAME_KEY, name.value.trim()) } catch { /* нет хранилища */ } }
const GM_LABEL: Record<GmMode, string> = { ai: 'ИИ-ведущий', book: 'без ведущего (читаем Книгу Жизни сами)', human: 'живой ведущий — хозяин комнаты' }
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
          <button class="primary" :disabled="store.connecting" @click="create">Создать комнату</button>
        </div>
        <div class="card tight">
          <h3>Войти по коду</h3>
          <input v-model="code" maxlength="8" placeholder="Код комнаты" style="text-transform:uppercase;width:100%;margin-bottom:.4rem" @keyup.enter="join" />
          <button :disabled="store.connecting" @click="join">Войти</button>
        </div>
      </div>
      <p class="small muted" style="margin-top:.4rem">ИИ-ведущий работает, если на сервере задан ключ Claude API.</p>
    </template>
    <template v-else>
      <div class="row between">
        <div><span class="muted small">Комната</span> <b style="font-size:1.6rem;letter-spacing:.15em;color:var(--accent)">{{ r.code }}</b></div>
        <div class="row"><button class="small" @click="copyLink">Ссылка</button><button class="small" @click="router.push('/table')">За стол</button><button class="small danger" @click="store.leaveRoom()">Выйти</button></div>
      </div>
      <p class="small">Ведущий: <b>{{ GM_LABEL[r.gm] }}</b><span v-if="r.gm === 'ai' && r.gmBusy" class="muted"> — пишет…</span></p>
      <div v-if="r.me.isHost" class="row small" style="margin-bottom:.4rem">
        <span class="muted">Сменить режим:</span>
        <button v-for="(_label, k) in GM_LABEL" :key="k" class="small" :disabled="k === r.gm || (k === 'ai' && !r.aiAvailable)" :title="k === 'ai' && !r.aiAvailable ? 'На сервере нет ключа Claude API' : ''" @click="store.setGmMode(k)">{{ k === 'ai' ? 'ИИ' : k === 'book' ? 'без ведущего' : 'живой' }}</button>
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
