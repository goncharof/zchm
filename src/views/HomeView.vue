<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { useGameStore } from '@/stores/game'

const store = useGameStore()
const router = useRouter()
const fileInput = ref<HTMLInputElement | null>(null)

function continueGame() {
  if (store.combat) router.push('/combat')
  else if (store.location) router.push(`/location/${store.location.id}`)
  else if (store.heroes.length) router.push('/map')
  else router.push('/party')
}
function exportSave() {
  const blob = new Blob([store.exportSave()], { type: 'application/json' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `zchm-save-day${store.game?.day ?? 0}.json`
  a.click()
  URL.revokeObjectURL(a.href)
}
async function importSave(ev: Event) {
  const f = (ev.target as HTMLInputElement).files?.[0]
  if (!f) return
  try { store.importSave(await f.text()); store.say('Сохранение загружено'); continueGame() } catch (e) { store.say((e as Error).message) }
}
function newGame() {
  if (store.started && !confirm('Текущая партия будет удалена. Начать заново?')) return
  store.resetGame()
  store.newGame()
  router.push('/party')
}
</script>

<template>
  <div class="grid wide">
    <div class="card">
      <h1>Заклятье Чёрного мага</h1>
      <p class="muted">Браузерная версия настольной ролевой игры 1997 года. Движок ведёт механику: персонажей, кубики, бой, магию, лавку и опыт. Книга Жизни читается как книга-игра по локациям.</p>
      <p>Группа искателей приключений отправляется в далёкий путь. Их задача — добраться до цитадели Чёрного мага и расправиться с ним, спасти мир от вторжения сил Хаоса, которые хлынут через открытые Ворота Инкардагот.</p>
      <div class="row" style="margin-top:1rem">
        <button v-if="store.started" class="primary" @click="continueGame">Продолжить (день {{ store.game?.day }})</button>
        <button :class="{ primary: !store.started }" @click="newGame">Новая партия</button>
        <button v-if="store.started" @click="exportSave">Экспорт сохранения</button>
        <button @click="fileInput?.click()">Импорт сохранения</button>
        <input ref="fileInput" type="file" accept="application/json" style="display:none" @change="importSave" />
      </div>
    </div>
    <div class="card">
      <h2>Как играть</h2>
      <ol class="small" style="padding-left:1.2rem">
        <li>Соберите партию из 2–6 героев пяти классов, на 40 монет купите снаряжение в лавке.</li>
        <li>На карте мира выберите, куда идти. Переходы занимают дни; в пути возможны встречи из главы «Дорога».</li>
        <li>В локации выбирайте номера параграфов на плане, читайте текст и действуйте: проверки удачи, бои, находки.</li>
        <li>Бой пошаговый: первый раунд — дистанция, затем инициатива и ближний бой. Опыт начисляется за каждую отнятую жизнь.</li>
        <li>Отдыхайте в трактирах, копите опыт и артефакты, и лишь потом идите к Замку Чёрного мага.</li>
      </ol>
      <p class="small muted">Режим ведущего (в разделе «Партия») прячет текст параграфов, чтобы их читал живой ведущий.</p>
    </div>
  </div>
</template>
