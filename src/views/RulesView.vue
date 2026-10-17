<script setup lang="ts">
import { ref } from 'vue'
import { gameData } from '@/data'
import { BOTTLES, EXTRA_ATTACKS } from '@/engine/rules'
import { HAND_NAMES, attacksStr } from '@/ui/format'

const STAT: Record<string, string> = { strength: 'сила', dexterity: 'ловкость', accuracy: 'меткость', luck: 'удача', defense: 'защита' }
const cls = ref(gameData.classes[0].id)
const FLEE = [['1–2', 10], ['3–4', 11], ['5–6', 12], ['7–8', 13], ['9–10', 14], ['11–12', 15]]
function bonus(b?: Record<string, number>) {
  return b ? Object.entries(b).map(([k, v]) => `${STAT[k]} +${v}`).join(', ') : ''
}
</script>

<template>
  <h1>Правила</h1>
  <p class="muted small">Краткая справка по Инструкции «Заклятья Чёрного мага» (1997). Где правила неполны, используются трактовки, описанные в разделе «Об игре».</p>
  <div class="cols c11">
    <div>
      <div class="card">
        <h2>Кубики и проверки</h2>
        <p>В игре два кубика: <b>к6</b> и <b>к18</b>. Запись «3к6» — бросить к6 три раза и сложить.</p>
        <p><b>Бросок удачи N</b> (ловушки, двери, сундуки): к18 + удача героя ≥ N.</p>
        <p><b>Жизни</b>: при 0 герой без сознания (его можно вылечить), при −10 — мёртв (спасут только живая вода или заклинание «Оживление персонажа»).</p>
      </div>
      <div class="card">
        <h2>Бой</h2>
        <ol style="padding-left:1.2rem">
          <li>Первый раунд — <b>дистанция</b>: можно стрелять из луков и арбалетов, метать дротики и копья, колдовать.</li>
          <li>Затем противники сходятся, бросается <b>инициатива</b> (к18 за каждую сторону, больше — ходит первой).</li>
          <li>За раунд герой делает <b>одно действие</b>: удар одним оружием, выстрел, заклинание, бегство.</li>
          <li><b>Попадание</b>: к18 + ловкость (для метательного — меткость) ≥ защита цели.</li>
          <li><b>Урон</b>: бросок к6 по таблице атак оружия + сила (сила не прибавляется к метательному).</li>
          <li><b>Опыт</b>: «очки» монстра за каждую отнятую у него жизнь.</li>
        </ol>
        <p><b>Храбрость монстра</b>: потеряв половину жизней, монстр один раз бросает к18; выкинул не меньше своей храбрости — убегает.</p>
        <h3>Бегство</h3>
        <table class="list"><thead><tr><th>Уровень монстров</th><th>Нужно на к18</th></tr></thead>
          <tbody><tr v-for="r in FLEE" :key="r[0]"><td>{{ r[0] }}</td><td>{{ r[1] }}+</td></tr></tbody></table>
        <h3 style="margin-top:.8rem">Дополнительные атаки монстров</h3>
        <p class="small muted">Пробив защиту, монстр бросает к18; выпало не меньше его порога — вместо обычного удара применяет особую атаку. Герой может избежать её броском удачи.</p>
        <table class="list stack"><thead><tr><th>Атака</th><th>Удача</th><th>Действие</th></tr></thead>
          <tbody><tr v-for="e in Object.values(EXTRA_ATTACKS)" :key="e.kind"><td data-label="Атака"><b>{{ e.name }}</b></td><td data-label="Удача">{{ e.luck }}</td><td data-label="Действие" class="small">{{ e.description }}</td></tr></tbody></table>
      </div>
      <div class="card">
        <h2>Бутылки, трактиры, свитки</h2>
        <table class="list"><thead><tr><th>Бутылка</th><th>Действие</th></tr></thead>
          <tbody><tr v-for="b in BOTTLES" :key="b.n"><td>({{ b.n }})</td><td>{{ b.label }}</td></tr></tbody></table>
        <p class="small" style="margin-top:.5rem">Содержимое найденной бутылки неизвестно, пока её не выпьют или не проверят распознавателем напитков (ошибается в 1 случае из 6).</p>
        <p class="small"><b>Трактир</b>: сутки отдыха стоят 2 монеты с героя и восстанавливают 5 жизней и 5 маны.</p>
        <p class="small"><b>Свиток</b> читают только маги и жрецы. Если уровень героя выше уровня заклинания, его переписывают в книгу; иначе свиток можно прочесть один раз.</p>
        <p class="small"><b>Артефакт</b> определяется броском к18 (18 предметов), за находку все получают 500 очков опыта. Вор получает 400 очков за найденную ловушку или потайную дверь.</p>
      </div>
    </div>
    <div>
      <div class="card">
        <h2>Классы и уровни</h2>
        <div class="tabs"><button v-for="c in gameData.classes" :key="c.id" :class="{ active: cls === c.id }" @click="cls = c.id">{{ c.name }}</button></div>
        <template v-for="c in gameData.classes.filter(x => x.id === cls)" :key="c.id">
          <p class="small">{{ c.description }}</p>
          <p class="small"><b>Оружие:</b> {{ c.weaponRule }}. <b>Метательное:</b> {{ c.rangedRule }}.</p>
          <table class="list">
            <thead><tr><th>Ур.</th><th>Опыт</th><th>Жизни</th><th>{{ c.caster ? 'Мана' : 'Прибавка' }}</th></tr></thead>
            <tbody><tr v-for="l in c.levels" :key="l.level"><td>{{ l.level }}</td><td>{{ l.xp }}</td><td>{{ l.lives }}</td><td class="small">{{ c.caster ? l.mana : [bonus(l.bonus), l.special].filter(Boolean).join('; ') }}</td></tr></tbody>
          </table>
        </template>
        <p class="small muted" style="margin-top:.5rem">Начинающий герой: 40 монет, сила, ловкость, меткость и удача равны нулю, защита без доспеха 9.</p>
      </div>
      <div class="card">
        <h2>Оружие и доспехи</h2>
        <p class="small muted">Руки: любая — можно взять два таких; правая — во второй руке щит или оружие «для любой руки»; двуручное — без щита и второго оружия.</p>
        <table class="list small"><thead><tr><th>Оружие</th><th>Атаки (к6)</th><th>Рука</th><th>Цена</th></tr></thead>
          <tbody><tr v-for="w in gameData.weapons.filter(x => x.attacks)" :key="w.id"><td data-label="Оружие">{{ w.name }}</td><td data-label="Атаки">{{ attacksStr(w.attacks) }}</td><td data-label="Рука" class="small">{{ w.ranged ? 'метательное' : w.hand ? HAND_NAMES[w.hand] : '' }}</td><td data-label="Цена">{{ w.price }}</td></tr></tbody></table>
        <table class="list small" style="margin-top:.6rem"><thead><tr><th>Доспех</th><th>Защита</th><th>Цена</th></tr></thead>
          <tbody><tr v-for="a in gameData.armor" :key="a.id"><td data-label="Доспех">{{ a.name }}</td><td data-label="Защита">{{ a.defense ?? (a.defenseBonus ? `+${a.defenseBonus}` : a.strengthBonus ? `сила +${a.strengthBonus}` : '') }}</td><td data-label="Цена">{{ a.price }}</td></tr></tbody></table>
      </div>
    </div>
  </div>
</template>
