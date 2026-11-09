/**
 * Durable storage for the canvas.
 *
 * One active document per profile, in `<profile>/canvas/<id>.json`, plus `<id>.history.json` with
 * the last 20 operations and `<profile>/canvas/index.json` naming the active document. Every write
 * is atomic — a temporary file in the same directory, then `rename` — so a crash leaves either the
 * old file or the new one, never half of each.
 *
 * Ordinary typing is debounced by 400 ms; a commit flushes immediately and synchronously, because
 * "the document did not change at all" must also hold for the file on disk when the request returns.
 *
 * No personal path is hardcoded: the root comes from `DSH_PROFILE_DIR`, and only when that variable
 * is absent (a bare test process) from `%USERPROFILE%\.dsh\profiles\desktop`.
 */

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { emptyDocument, isoNow, LIMITS, normalizeDocument } from './model.js'

/**
 * The profile directory this process belongs to.
 * @returns {string} an absolute directory.
 */
export function profileDirectory() {
  const explicit = process.env.DSH_PROFILE_DIR
  if (typeof explicit === 'string' && explicit.trim() !== '') return explicit
  const home = process.env.USERPROFILE ?? process.env.HOME ?? homedir()
  return join(home, '.dsh', 'profiles', 'desktop')
}

/**
 * Write one text file atomically inside its own directory.
 * @param {string} path - the destination.
 * @param {string} text - the exact bytes to write (UTF-8, no BOM).
 */
export function writeAtomic(path, text) {
  mkdirSync(join(path, '..'), { recursive: true })
  const temporary = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  const descriptor = openSync(temporary, 'w')
  try {
    writeSync(descriptor, text, null, 'utf8')
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
  try {
    renameSync(temporary, path)
  } catch (error) {
    try {
      unlinkSync(temporary)
    } catch {
      // The rename failed; the temporary file may already be gone.
    }
    throw error
  }
}

/** Deep copy through JSON, so callers can never alias stored state. */
const copy = (value) => JSON.parse(JSON.stringify(value))

/**
 * The canvas file store.
 */
export class CanvasStore {
  /**
   * @param {{root?: string, debounceMs?: number, now?: () => Date}} [options] - overrides for tests.
   */
  constructor(options = {}) {
    this.root = options.root ?? join(profileDirectory(), 'canvas')
    this.debounceMs = options.debounceMs ?? 400
    this.now = options.now ?? (() => new Date())
    /** @type {ReturnType<typeof setTimeout> | null} */
    this.pending = null
    /** @type {object|null} the document waiting to be written. */
    this.dirty = null
    /** Whether the active document was written by a newer DSH and must not be touched. */
    this.readOnly = false
    /** Whether the read-only state comes from a higher `schema` value. */
    this.newerSchema = false
  }

  /** Create the canvas directory before the first write. */
  ensureRoot() {
    mkdirSync(this.root, { recursive: true })
  }

  /**
   * Paths belonging to one document.
   * @param {string} id - the document id.
   * @returns {{document: string, history: string}} absolute paths.
   */
  paths(id) {
    return {
      document: join(this.root, `${id}.json`),
      history: join(this.root, `${id}.history.json`),
    }
  }

  /** Path of the active-document pointer. */
  get indexPath() {
    return join(this.root, 'index.json')
  }

  /**
   * Read the pointer, creating it when the profile has no canvas yet.
   * @returns {{schema: number, activeId: string, nextDocSeq: number}} the pointer.
   */
  readIndex() {
    try {
      const raw = JSON.parse(readFileSync(this.indexPath, 'utf8'))
      if (typeof raw?.activeId === 'string' && raw.activeId !== '') {
        return {
          schema: 1,
          activeId: raw.activeId,
          nextDocSeq: Number.isInteger(raw.nextDocSeq) && raw.nextDocSeq > 0 ? raw.nextDocSeq : 2,
        }
      }
    } catch {
      // A missing or unreadable pointer is rebuilt below; the documents themselves are untouched.
    }
    return { schema: 1, activeId: 'doc-1', nextDocSeq: 2 }
  }

  /**
   * Persist the pointer atomically.
   * @param {{schema: number, activeId: string, nextDocSeq: number}} index - the pointer.
   */
  writeIndex(index) {
    this.ensureRoot()
    writeAtomic(this.indexPath, `${JSON.stringify(index, null, 2)}\n`)
  }

  /**
   * Load the active document, creating an empty one on first use.
   * @returns {{document: object, readOnly: boolean, newerSchema: boolean}} the document and its mode.
   */
  loadActive() {
    this.ensureRoot()
    const index = this.readIndex()
    const { document: path } = this.paths(index.activeId)
    let raw = null
    try {
      raw = JSON.parse(readFileSync(path, 'utf8'))
    } catch {
      raw = null
    }
    if (raw === null) {
      const document = emptyDocument(index.activeId)
      this.writeIndex(index)
      this.saveNow(document)
      this.readOnly = false
      this.newerSchema = false
      return { document, readOnly: false, newerSchema: false }
    }
    const document = normalizeDocument(raw)
    this.readOnly = Number.isInteger(raw.schema) && raw.schema > 1
    this.newerSchema = this.readOnly
    return { document, readOnly: this.readOnly, newerSchema: this.readOnly }
  }

  /**
   * Write the document now: one atomic file replacement.
   * @param {object} document - the document to persist.
   */
  saveNow(document) {
    if (this.readOnly) return
    this.cancelPending()
    const { document: path } = this.paths(document.id)
    writeAtomic(path, `${JSON.stringify(document, null, 2)}\n`)
  }

  /**
   * Schedule the 400 ms debounced write that follows an ordinary edit.
   * @param {object} document - the document to persist.
   */
  save(document) {
    if (this.readOnly) return
    this.dirty = copy(document)
    if (this.pending !== null) return
    this.pending = setTimeout(() => {
      this.pending = null
      const pendingDocument = this.dirty
      this.dirty = null
      if (pendingDocument !== null) {
        const { document: path } = this.paths(pendingDocument.id)
        writeAtomic(path, `${JSON.stringify(pendingDocument, null, 2)}\n`)
      }
    }, this.debounceMs)
    // A pending write must never keep the Host process alive on its own.
    if (typeof this.pending.unref === 'function') this.pending.unref()
  }

  /** Write a debounced change immediately, e.g. before answering a request. */
  flush() {
    if (this.pending === null || this.dirty === null) return
    const pendingDocument = this.dirty
    this.cancelPending()
    const { document: path } = this.paths(pendingDocument.id)
    writeAtomic(path, `${JSON.stringify(pendingDocument, null, 2)}\n`)
  }

  /** Drop the pending write, keeping the file as it is. */
  cancelPending() {
    if (this.pending !== null) clearTimeout(this.pending)
    this.pending = null
    this.dirty = null
  }

  /** Flush the pending write and drop the timer when the plugin unloads. */
  dispose() {
    try {
      this.flush()
    } finally {
      this.cancelPending()
    }
  }

  /**
   * Archive the active document: its file stays on disk, the profile points at a fresh one.
   * @returns {object} the new empty document.
   */
  archiveActive() {
    this.flush()
    const index = this.readIndex()
    const nextId = `doc-${index.nextDocSeq}`
    const nextIndex = { schema: 1, activeId: nextId, nextDocSeq: index.nextDocSeq + 1 }
    const document = emptyDocument(nextId)
    this.writeIndex(nextIndex)
    this.saveNow(document)
    return document
  }

  /**
   * Read one document's history.
   * @param {string} id - the document id.
   * @returns {{schema: number, entries: object[]}} the history, oldest first.
   */
  readHistory(id) {
    try {
      const raw = JSON.parse(readFileSync(this.paths(id).history, 'utf8'))
      return { schema: 1, entries: Array.isArray(raw?.entries) ? raw.entries : [] }
    } catch {
      return { schema: 1, entries: [] }
    }
  }

  /**
   * Append one operation to a document's history, keeping the last {@link LIMITS.history}.
   * @param {string} id - the document id.
   * @param {{op: string, summary: string, version?: number}} entry - the operation.
   * @returns {object[]} the stored entries, oldest first.
   */
  appendHistory(id, entry) {
    const history = this.readHistory(id)
    history.entries.push({
      at: isoNow(this.now()),
      op: entry.op,
      summary: entry.summary,
      version: entry.version ?? null,
    })
    while (history.entries.length > LIMITS.history) history.entries.shift()
    this.ensureRoot()
    writeAtomic(this.paths(id).history, `${JSON.stringify(history, null, 2)}\n`)
    return history.entries
  }

  /**
   * Every document file this profile holds, including archived ones.
   * @returns {string[]} document ids, ascending by file name.
   */
  listIds() {
    try {
      return readdirSync(this.root)
        .filter((name) => /^doc-\d+\.json$/u.test(name))
        .map((name) => name.slice(0, -'.json'.length))
        .sort()
    } catch {
      return []
    }
  }

  /**
   * Whether a document file exists.
   * @param {string} id - the document id.
   * @returns {boolean} true when it is on disk.
   */
  exists(id) {
    return existsSync(this.paths(id).document)
  }
}
