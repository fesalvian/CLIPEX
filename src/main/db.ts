// Banco local (SQLite embutido no Node do Electron: node:sqlite). Cada entidade fica
// guardada como JSON numa coluna `data`, com colunas extras só pro que precisa de índice.

import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { safeStorage } from 'electron'
import type { Clip, Post, PostMetric, Project } from '@shared/types'
import { userDataDir } from './paths'

const MIGRATIONS: string[] = [
  `
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE projects (id TEXT PRIMARY KEY, source_path TEXT NOT NULL, created_at TEXT NOT NULL, data TEXT NOT NULL);
  CREATE TABLE clips (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, data TEXT NOT NULL);
  CREATE INDEX clips_project ON clips(project_id);
  CREATE TABLE posts (
    id TEXT PRIMARY KEY, clip_id TEXT NOT NULL, project_id TEXT NOT NULL, network TEXT NOT NULL,
    status TEXT NOT NULL, scheduled_at TEXT, data TEXT NOT NULL
  );
  CREATE INDEX posts_status ON posts(status, scheduled_at);
  CREATE TABLE metrics (
    post_id TEXT NOT NULL, fetched_at TEXT NOT NULL, views INTEGER NOT NULL, likes INTEGER NOT NULL,
    comments INTEGER NOT NULL, PRIMARY KEY (post_id, fetched_at)
  );
  CREATE TABLE secrets (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `
]

let conn: DatabaseSync | null = null

function db(): DatabaseSync {
  if (conn) return conn
  conn = new DatabaseSync(join(userDataDir(), 'clipador.db'))
  conn.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;')
  conn.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  const row = conn.prepare("SELECT value FROM meta WHERE key = 'schema'").get() as { value: string } | undefined
  let version = row ? Number(row.value) : 0
  while (version < MIGRATIONS.length) {
    conn.exec('BEGIN')
    try {
      conn.exec(MIGRATIONS[version]!)
      version++
      conn.prepare("INSERT INTO meta (key, value) VALUES ('schema', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(version))
      conn.exec('COMMIT')
    } catch (e) {
      conn.exec('ROLLBACK')
      throw e
    }
  }
  return conn
}

function parse<T>(row: unknown): T | null {
  if (!row) return null
  return JSON.parse((row as { data: string }).data) as T
}

function parseAll<T>(rows: unknown[]): T[] {
  return rows.map((r) => JSON.parse((r as { data: string }).data) as T)
}

export const settingsRepo = {
  get<T>(key: string): T | null {
    const row = db().prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
    return row ? (JSON.parse(row.value) as T) : null
  },
  set(key: string, value: unknown): void {
    db()
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, JSON.stringify(value))
  }
}

export const projectsRepo = {
  get(id: string): Project | null {
    return parse<Project>(db().prepare('SELECT data FROM projects WHERE id = ?').get(id))
  },
  all(): Project[] {
    return parseAll<Project>(db().prepare('SELECT data FROM projects ORDER BY created_at DESC').all())
  },
  bySource(path: string): Project | null {
    return parse<Project>(db().prepare('SELECT data FROM projects WHERE lower(source_path) = lower(?)').get(path))
  },
  save(p: Project): void {
    db()
      .prepare(
        'INSERT INTO projects (id, source_path, created_at, data) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET source_path = excluded.source_path, data = excluded.data'
      )
      .run(p.id, p.sourcePath, p.createdAt, JSON.stringify(p))
  },
  delete(id: string): void {
    db().prepare('DELETE FROM projects WHERE id = ?').run(id)
    db().prepare('DELETE FROM clips WHERE project_id = ?').run(id)
  }
}

/** Cortes salvos por versões anteriores ganham os campos novos com valores equivalentes. */
export function upgradeClip(c: Clip): Clip {
  const x = c as Clip & Partial<Clip>
  x.hookOff ??= false
  x.captionStyle ??= null
  x.hookStyle ??= null
  if (x.wordsFrom === undefined) x.wordsFrom = x.words ? x.winStart : null
  if (x.wordsTo === undefined) x.wordsTo = x.words ? x.winEnd : null
  if (x.previewEnd === undefined) x.previewEnd = x.previewPath ? x.winEnd + 2 : null
  // marca d'água própria do corte salva antes do modo "acima da legenda": continua livre
  if (x.watermark && x.watermark.anchor === undefined) x.watermark = { ...x.watermark, anchor: 'free', gap: 36, offsetX: 0 }
  return x
}

export const clipsRepo = {
  get(id: string): Clip | null {
    const c = parse<Clip>(db().prepare('SELECT data FROM clips WHERE id = ?').get(id))
    return c ? upgradeClip(c) : null
  },
  byProject(projectId: string): Clip[] {
    return parseAll<Clip>(db().prepare('SELECT data FROM clips WHERE project_id = ?').all(projectId))
      .map(upgradeClip)
      .sort((a, b) => a.number - b.number)
  },
  save(c: Clip): void {
    db()
      .prepare('INSERT INTO clips (id, project_id, data) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data')
      .run(c.id, c.projectId, JSON.stringify(c))
  },
  saveMany(list: Clip[]): void {
    const d = db()
    d.exec('BEGIN')
    try {
      for (const c of list) clipsRepo.save(c)
      d.exec('COMMIT')
    } catch (e) {
      d.exec('ROLLBACK')
      throw e
    }
  },
  delete(id: string): void {
    db().prepare('DELETE FROM clips WHERE id = ?').run(id)
  }
}

export const postsRepo = {
  get(id: string): Post | null {
    return parse<Post>(db().prepare('SELECT data FROM posts WHERE id = ?').get(id))
  },
  all(projectId: string | null): Post[] {
    const rows = projectId
      ? db().prepare('SELECT data FROM posts WHERE project_id = ? ORDER BY scheduled_at').all(projectId)
      : db().prepare('SELECT data FROM posts ORDER BY scheduled_at').all()
    return parseAll<Post>(rows)
  },
  byClip(clipId: string): Post[] {
    return parseAll<Post>(db().prepare('SELECT data FROM posts WHERE clip_id = ?').all(clipId))
  },
  /** Posts agendados cuja hora já chegou. */
  due(nowIso: string): Post[] {
    return parseAll<Post>(
      db()
        .prepare("SELECT data FROM posts WHERE status = 'scheduled' AND (scheduled_at IS NULL OR scheduled_at <= ?) ORDER BY scheduled_at")
        .all(nowIso)
    )
  },
  save(p: Post): void {
    db()
      .prepare(
        `INSERT INTO posts (id, clip_id, project_id, network, status, scheduled_at, data) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET status = excluded.status, scheduled_at = excluded.scheduled_at, data = excluded.data`
      )
      .run(p.id, p.clipId, p.projectId, p.network, p.status, p.scheduledAt, JSON.stringify(p))
  }
}

export const metricsRepo = {
  add(m: PostMetric): void {
    db()
      .prepare('INSERT OR REPLACE INTO metrics (post_id, fetched_at, views, likes, comments) VALUES (?, ?, ?, ?, ?)')
      .run(m.postId, m.fetchedAt, m.views, m.likes, m.comments)
  },
  /** Última leitura de cada post. */
  latest(): PostMetric[] {
    const rows = db()
      .prepare(
        `SELECT m.post_id AS postId, m.fetched_at AS fetchedAt, m.views, m.likes, m.comments FROM metrics m
         JOIN (SELECT post_id, MAX(fetched_at) AS f FROM metrics GROUP BY post_id) x ON x.post_id = m.post_id AND x.f = m.fetched_at`
      )
      .all() as unknown as PostMetric[]
    return rows
  }
}

/** Tokens das redes, criptografados com o cofre do sistema (DPAPI no Windows). */
export const secretsRepo = {
  get<T>(key: string): T | null {
    const row = db().prepare('SELECT value FROM secrets WHERE key = ?').get(key) as { value: string } | undefined
    if (!row) return null
    try {
      const raw = safeStorage.isEncryptionAvailable()
        ? safeStorage.decryptString(Buffer.from(row.value, 'base64'))
        : Buffer.from(row.value, 'base64').toString('utf8')
      return JSON.parse(raw) as T
    } catch {
      return null
    }
  },
  set(key: string, value: unknown): void {
    const raw = JSON.stringify(value)
    const enc = safeStorage.isEncryptionAvailable()
      ? safeStorage.encryptString(raw).toString('base64')
      : Buffer.from(raw, 'utf8').toString('base64')
    db().prepare('INSERT INTO secrets (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, enc)
  },
  delete(key: string): void {
    db().prepare('DELETE FROM secrets WHERE key = ?').run(key)
  }
}

export function closeDb(): void {
  conn?.close()
  conn = null
}
