/**
 * Озвучка реплик ведущего встроенным синтезом речи браузера (Web Speech API).
 * Бесплатно и без сервера; включает каждый зритель у себя, настройка хранится в браузере.
 */
import { ref } from 'vue'

const KEY = 'zchm.speech'
interface SpeechPrefs { on: boolean; rate: number; voice?: string }

function readPrefs(): SpeechPrefs {
  try { return { on: false, rate: 1, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') } } catch { return { on: false, rate: 1 } }
}

export const speechPrefs = ref<SpeechPrefs>(readPrefs())
export const speaking = ref(false)

export function saveSpeechPrefs(): void {
  try { localStorage.setItem(KEY, JSON.stringify(speechPrefs.value)) } catch { /* нет хранилища */ }
}

export function speechSupported(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window && typeof SpeechSynthesisUtterance !== 'undefined'
}

/** Русские голоса системы (список приходит асинхронно — см. onVoicesChanged) */
export function russianVoices(): SpeechSynthesisVoice[] {
  if (!speechSupported()) return []
  return window.speechSynthesis.getVoices().filter((v) => v.lang.toLowerCase().startsWith('ru'))
}

export function onVoicesChanged(fn: () => void): () => void {
  if (!speechSupported()) return () => {}
  window.speechSynthesis.addEventListener('voiceschanged', fn)
  return () => window.speechSynthesis.removeEventListener('voiceschanged', fn)
}

/** Текст для чтения вслух: без эмодзи и служебных пометок, разбит на куски — длинные фразы Chrome обрывает */
export function speechChunks(text: string, max = 220): string[] {
  const clean = text
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '')
    .replace(/§\s*/g, 'параграф ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!clean) return []
  const sentences = clean.match(/[^.!?…]+[.!?…]*["»”]?\s*/g) ?? [clean]
  const out: string[] = []
  let cur = ''
  for (const s of sentences) {
    if ((cur + s).length > max && cur) { out.push(cur.trim()); cur = '' }
    if (s.length > max) {
      // очень длинное предложение — режем по запятым и пробелам
      for (const part of s.match(new RegExp(`.{1,${max}}(\\s|$)`, 'g')) ?? [s]) out.push(part.trim())
      continue
    }
    cur += s
  }
  if (cur.trim()) out.push(cur.trim())
  return out.filter(Boolean)
}

let pending = 0

/** Прочитать вслух (в очередь за уже звучащим) */
export function speak(text: string): void {
  if (!speechSupported()) return
  const voices = russianVoices()
  const voice = voices.find((v) => v.name === speechPrefs.value.voice) ?? voices.find((v) => v.localService) ?? voices[0]
  for (const chunk of speechChunks(text)) {
    const u = new SpeechSynthesisUtterance(chunk)
    u.lang = 'ru-RU'
    try { if (voice) u.voice = voice } catch { /* голос недоступен — браузер выберет сам по языку */ }
    u.rate = speechPrefs.value.rate
    pending++
    speaking.value = true
    u.onend = u.onerror = () => { pending = Math.max(0, pending - 1); if (!pending) speaking.value = false }
    window.speechSynthesis.speak(u)
  }
}

export function stopSpeaking(): void {
  if (!speechSupported()) return
  window.speechSynthesis.cancel()
  pending = 0
  speaking.value = false
}

/** Уже прочитанные (или бывшие в чате до включения) сообщения — общие для всех экземпляров чата */
export const spokenIds = new Set<string>()
