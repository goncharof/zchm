/**
 * Черновик ручной разметки Книги Жизни: текст параграфа и дерево этапов, которое сейчас строится из старой разметки
 * (src/game/tree.ts). С него начинают дерево в tools/book/<локация>.json (docs/BOOK_STRUCTURE.md, раздел 7).
 *
 * Запуск: npx tsx tools/book_draft.ts <локация> [номер ...]   (без номеров — все параграфы главы)
 */
import { idx } from '@/data'
import { paragraphText } from '@/game/book'
import { paragraphTree } from '@/game/tree'

const [locId, ...nums] = process.argv.slice(2)
const loc = idx.locationById.get(locId ?? '')
if (!loc) {
  console.error(`Нет локации «${locId}». Локации: ${[...idx.locationById.keys()].join(', ')}`)
  process.exit(1)
}
const want = new Set(nums.map(Number))
for (const p of loc.paragraphs) {
  if (want.size && !want.has(p.n)) continue
  console.log(`\n=== ${loc.id} § ${p.n}${p.tree ? ' (размечен вручную)' : ''}`)
  console.log(paragraphText(p))
  console.log(JSON.stringify(paragraphTree(p)))
}
