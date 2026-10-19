/**
 * Текст параграфов Книги Жизни. У размеченных параграфов (сцена и ветки) полного текста в данных нет —
 * он собирается из сегментов, чтобы не хранить книгу дважды.
 */
import type { Paragraph, ParagraphSegment, SegmentBlock } from '@/types'

/** Текст блока: обычный абзац или список вариантов броска */
export function blockText(b: SegmentBlock): string {
  return 'text' in b ? b.text : b.roll.map((o) => `${o.values.join(', ')} — ${o.text}`).join('\n')
}

/** Сегменты параграфа; неразмеченный параграф — одна сцена */
export function paragraphSegments(p: Paragraph): ParagraphSegment[] {
  return p.segments ?? [{ kind: 'scene', blocks: [{ text: p.text ?? '' }], hints: p.hints }]
}

/** То, что герои видят сразу (без исходов веток) */
export function sceneText(p: Paragraph): string {
  return paragraphSegments(p).filter((g) => g.kind === 'scene').flatMap((g) => g.blocks.map(blockText)).join('\n')
}

/** Полный текст: сцена и ветки в виде «условие — исход» */
export function paragraphText(p: Paragraph): string {
  if (p.text !== undefined) return p.text
  return paragraphSegments(p).map((g) => {
    const body = g.blocks.map(blockText).join(' ')
    return g.kind === 'branch' ? `${g.label}${body ? ` — ${body}` : ''}` : body
  }).join(' ')
}

/** Кубик для списка исходов «1 — …, 2 — …»: к18, если есть числа больше 6; к3, если список — ровно 1, 2, 3 (выбор одной
 *  из трёх, иначе на 4–6 ничего не выпадает); иначе к6 */
export function rollSides(options: { values: number[] }[]): number {
  const all = options.flatMap((o) => o.values)
  if (Math.max(...all) > 6) return 18
  const set = new Set(all)
  return set.size === 3 && [1, 2, 3].every((v) => set.has(v)) ? 3 : 6
}
