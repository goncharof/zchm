/** Где лежат сохранённые комнаты: файлы на диске (по умолчанию) или таблица Postgres (DATABASE_URL — хостинг без диска). */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'

export interface RoomStorage {
  /** есть ли сохранённая комната с таким кодом */
  has(code: string): Promise<boolean>
  /** JSON сохранённой комнаты; undefined — такой комнаты нет. Сбой хранилища — исключение, а не undefined:
   *  игроку нельзя отвечать «комната не найдена», пока она просто не прочиталась */
  read(code: string): Promise<string | undefined>
  write(code: string, json: string): Promise<void>
  close?(): Promise<void>
}

/** Комната — файл `<код>.json` в каталоге */
export class FileStorage implements RoomStorage {
  constructor(private dir: string) {}

  async has(code: string): Promise<boolean> {
    return existsSync(this.file(code))
  }

  async read(code: string): Promise<string | undefined> {
    if (!existsSync(this.file(code))) return undefined
    return readFile(this.file(code), 'utf8')
  }

  /** Запись через временный файл: обрыв посреди записи не портит сохранённую комнату */
  async write(code: string, json: string): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    const file = this.file(code)
    const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`
    await writeFile(tmp, json)
    await rename(tmp, file)
  }

  private file(code: string): string {
    return path.join(this.dir, `${code}.json`)
  }
}

/** Минимум от клиента Postgres: подходит pg.Pool, в тестах — PGlite */
export interface SqlClient {
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[] }>
  end?(): Promise<void>
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Комната — строка таблицы zchm_rooms. JSON хранится текстом, как в файле: jsonb не принимает `\u0000` в строках */
export class PgStorage implements RoomStorage {
  private ready: Promise<void> | null = null

  /** tries — попыток на запрос: база на бесплатном тарифе засыпает и рвёт простаивающие соединения */
  constructor(private db: SqlClient, private tries = 3, private retryMs = 400) {}

  /** Таблица создаётся при первом обращении; неудача не запоминается — следующий запрос попробует снова */
  private init(): Promise<void> {
    this.ready ??= this.db
      .query('create table if not exists zchm_rooms (code text primary key, data text not null, updated_at timestamptz not null default now())')
      .then(() => {}, (e) => { this.ready = null; throw e })
    return this.ready
  }

  private async run(text: string, params: unknown[]): Promise<unknown[]> {
    for (let i = 1; ; i++) {
      try {
        await this.init()
        return (await this.db.query(text, params)).rows
      } catch (e) {
        if (i >= this.tries) throw e
        await wait(this.retryMs * i)
      }
    }
  }

  async has(code: string): Promise<boolean> {
    return (await this.run('select 1 from zchm_rooms where code = $1', [code])).length > 0
  }

  async read(code: string): Promise<string | undefined> {
    const [row] = await this.run('select data from zchm_rooms where code = $1', [code]) as { data: string }[]
    return row?.data
  }

  async write(code: string, json: string): Promise<void> {
    await this.run(
      'insert into zchm_rooms (code, data) values ($1, $2) on conflict (code) do update set data = excluded.data, updated_at = now()',
      [code, json],
    )
  }

  async close(): Promise<void> {
    await this.db.end?.()
  }
}

/** Хранилище в Postgres по строке подключения (Neon, Supabase, свой сервер) */
export async function pgStorage(url: string): Promise<PgStorage> {
  // pg подключается, только когда задан DATABASE_URL: игре на файлах он не нужен
  const { default: pg } = await import('pg')
  const pool = new pg.Pool({ connectionString: url, max: 3, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 10_000 })
  // соединение, оборванное базой в простое, не должно ронять сервер: следующий запрос откроет новое
  pool.on('error', (e) => console.error('[комнаты] соединение с базой:', e.message))
  return new PgStorage(pool)
}
