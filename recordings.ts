/**
 * Local rehearsal recording — manual "takes" per instance, backed by
 * Playwright's built-in per-page video capture and a SQLite metadata table.
 *
 * Off by default: recording adds overhead and isn't wanted during the real
 * live-Railway run, only while rehearsing locally to build a fallback clip
 * library in case the live environment misbehaves on stage. Can start
 * enabled via RECORD=1, or be toggled at runtime from the panel — but
 * Playwright only accepts recordVideo at browser-context creation, so
 * toggling on mid-session only takes effect for instances opened (or
 * reset) after the toggle; it can't retroactively record an already-open
 * instance.
 *
 * Video bytes stay as .webm files on disk under recordings/<session>/ —
 * SQLite only stores metadata (instance, take number, path, timestamps) so
 * takes can be listed and linked without loading large blobs through the DB.
 * file_path is stored relative to ROOT_DIR so it doubles as the URL path
 * once ROOT_DIR is served statically at /recordings.
 */

import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import type { Video } from 'playwright'
import type { InstanceId } from './steps.ts'

let recordingEnabled = process.env.RECORD === '1'

const SESSION_ID = new Date().toISOString().replace(/[:.]/g, '-')
export const RECORDINGS_ROOT = fileURLToPath(new URL('./recordings', import.meta.url))
export const RECORDINGS_DIR = path.join(RECORDINGS_ROOT, SESSION_ID)
const DB_PATH = fileURLToPath(new URL('./recordings.db', import.meta.url))

let db: DatabaseSync | null = null

function ensureDb(): void {
  if (db) return
  mkdirSync(RECORDINGS_DIR, { recursive: true })
  db = new DatabaseSync(DB_PATH)
  db.exec(`
    CREATE TABLE IF NOT EXISTS takes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      instance TEXT NOT NULL,
      take_number INTEGER NOT NULL,
      label TEXT,
      file_path TEXT,
      started_at TEXT NOT NULL,
      finalized_at TEXT
    )
  `)
}

if (recordingEnabled) ensureDb()

export function isRecordingEnabled(): boolean {
  return recordingEnabled
}

/** Flips the toggle. Turning on lazily creates the DB/dir on first use; already-open instances are unaffected. */
export function setRecordingEnabled(enabled: boolean): void {
  recordingEnabled = enabled
  if (enabled) ensureDb()
}

export interface TakeRow {
  id: number
  session_id: string
  instance: InstanceId
  take_number: number
  label: string | null
  file_path: string | null
  started_at: string
  finalized_at: string | null
}

export interface OpenTake {
  id: number
  takeNumber: number
  video: Video | null
}

/** Records the start of a new take. The row's file_path fills in once the take is finalized. */
export function startTake(instance: InstanceId, takeNumber: number, label: string | null): number {
  if (!db) throw new Error('Recording not enabled')
  const result = db
    .prepare('INSERT INTO takes (session_id, instance, take_number, label, started_at) VALUES (?, ?, ?, ?, ?)')
    .run(SESSION_ID, instance, takeNumber, label, new Date().toISOString())
  return Number(result.lastInsertRowid)
}

/**
 * Closes out a take: awaits the finalized video path (only resolves once the
 * page/context that recorded it has actually closed) and records it relative
 * to RECORDINGS_ROOT so it can be served directly as a URL path.
 */
export async function finalizeTake(id: number, video: Video | null): Promise<void> {
  if (!db || !video) return
  try {
    const absPath = await video.path()
    const relPath = path.relative(RECORDINGS_ROOT, absPath).split(path.sep).join('/')
    db.prepare('UPDATE takes SET file_path = ?, finalized_at = ? WHERE id = ?').run(relPath, new Date().toISOString(), id)
  } catch {
    // page closed without ever recording a frame (e.g. instant crash) — leave file_path null
  }
}

export function listTakes(): TakeRow[] {
  if (!db) return []
  return db.prepare('SELECT * FROM takes ORDER BY instance, take_number').all() as unknown as TakeRow[]
}
