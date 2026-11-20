// Помощник разметки планов локаций: начало текста каждого параграфа (что это за место, какие двери упомянуты).
//   pnpm exec tsx tools/plan_text.ts <id локации> [знаков на параграф]
import { idx } from '../src/data'
import { paragraphText } from '../src/game/book'

const id = process.argv[2]
const limit = Number(process.argv[3] ?? 260)
const loc = idx.locationById.get(id)
if (!loc) {
  console.error(`Нет локации «${id}». Есть: ${idx.data.locations.map((l) => l.id).join(', ')}`)
  process.exit(1)
}
console.log(`${loc.name}: ${loc.paragraphs.length} помещений, план ${loc.plan ?? 'нет'}`)
for (const p of loc.paragraphs) {
  const text = paragraphText(p).replace(/\s+/g, ' ').trim()
  console.log(`§ ${p.n}: ${text.slice(0, limit)}${text.length > limit ? '…' : ''}`)
}
