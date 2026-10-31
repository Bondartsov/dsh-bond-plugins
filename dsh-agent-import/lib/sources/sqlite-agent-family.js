/**
 * Reader for one SQLite-backed foreign store: ZCode CLI, KiloCode and OpenCode.
 *
 * All three keep the same shape — a `session` table, a `message` table whose
 * `data` column is a JSON object, and a `part` table whose `data` column is a
 * JSON object with a `type` discriminator. Column names drift between the
 * versions, so every column this module depends on is resolved by introspection
 * instead of being assumed.
 */
import { existsSync } from 'node:fs';

import { querySqlite, tableColumns, tableExists } from '../sqlite.js';
import { timeOf } from '../events.js';

/** Task types ZCode and Kilo use for sessions spawned inside another session. */
const CHILD_TASK_TYPES = new Set(['subagent_child', 'workflow_child', 'selection_side_chat']);

/** Pick the first column present in the table, or `undefined`. */
function pick(columns, names) {
  for (const name of names) if (columns.includes(name)) return name;
  return undefined;
}

/** Parse one JSON column value, tolerating text, buffers and null. */
function parseJsonColumn(value) {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'object') return value;
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

/** Coerce a value to text, keeping JSON objects as their serialized form when asked. */
const textOf = (value) => (typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '');

/**
 * Build one source adapter over a SQLite store.
 *
 * @param spec - `{id, label, dbPath, unavailableHint}`; `dbPath` is a function so
 *   the environment is read lazily.
 * @returns the adapter: `{id, label, status, listSessions, readSession}`.
 */
export function createSqliteFamilySource(spec) {
  /** Resolved schema, cached per database that exists. */
  const schemaCache = new Map();

  /** Resolve the columns this store actually has. */
  async function schema(dbPath) {
    const cached = schemaCache.get(dbPath);
    if (cached !== undefined) return cached;
    const missing = [];
    const hasSession = await tableExists(dbPath, 'session');
    if (!hasSession) throw new Error(`no session table in ${dbPath}`);
    const sessionColumns = await tableColumns(dbPath, 'session');
    const messageColumns = (await tableExists(dbPath, 'message')) ? await tableColumns(dbPath, 'message') : [];
    const partColumns = (await tableExists(dbPath, 'part')) ? await tableColumns(dbPath, 'part') : [];
    const resolved = {
      session: {
        id: pick(sessionColumns, ['id']),
        title: pick(sessionColumns, ['title']),
        directory: pick(sessionColumns, ['directory', 'path', 'workspace']),
        updated: pick(sessionColumns, ['time_updated', 'timeUpdated', 'updated_at', 'time_created', 'timeCreated']),
        created: pick(sessionColumns, ['time_created', 'timeCreated', 'created_at']),
        deleted: pick(sessionColumns, ['time_deleted', 'timeDeleted']),
        parent: pick(sessionColumns, ['parent_id', 'parentId']),
        taskType: pick(sessionColumns, ['task_type', 'taskType']),
      },
      message: {
        id: pick(messageColumns, ['id']),
        session: pick(messageColumns, ['session_id', 'sessionId']),
        data: pick(messageColumns, ['data']),
        sequence: pick(messageColumns, ['sequence', 'time_created', 'timeCreated']),
      },
      part: {
        message: pick(partColumns, ['message_id', 'messageId']),
        session: pick(partColumns, ['session_id', 'sessionId']),
        data: pick(partColumns, ['data']),
        sequence: pick(partColumns, ['sequence', 'time_created', 'timeCreated']),
      },
    };
    if (resolved.session.id === undefined) missing.push('session.id');
    if (resolved.message.data === undefined) missing.push('message.data');
    if (missing.length > 0) throw new Error(`unsupported schema (${missing.join(', ')})`);
    schemaCache.set(dbPath, resolved);
    return resolved;
  }

  /** Availability: the database file must exist and expose a session table. */
  async function status() {
    const dbPath = spec.dbPath();
    if (!existsSync(dbPath)) {
      return { available: false, reason: `not found at ${dbPath}`, hint: spec.unavailableHint };
    }
    try {
      await schema(dbPath);
      return { available: true, detail: dbPath };
    } catch (error) {
      return { available: false, reason: error?.message ?? String(error), hint: spec.unavailableHint };
    }
  }

  /** One listing page, newest first, optionally filtered by title or project path. */
  async function listSessions(options = {}) {
    const dbPath = spec.dbPath();
    const columns = await schema(dbPath);
    const limit = Number.isSafeInteger(options.limit) ? options.limit : 50;
    const offset = Number.isSafeInteger(options.offset) ? options.offset : 0;
    const query = textOf(options.query).trim();

    const select = [`${columns.session.id} AS id`];
    if (columns.session.title !== undefined) select.push(`${columns.session.title} AS title`);
    if (columns.session.directory !== undefined) select.push(`${columns.session.directory} AS directory`);
    if (columns.session.updated !== undefined) select.push(`${columns.session.updated} AS updated`);
    if (columns.session.parent !== undefined) select.push(`${columns.session.parent} AS parentId`);
    if (columns.session.taskType !== undefined) select.push(`${columns.session.taskType} AS taskType`);
    const orderBy = columns.session.updated !== undefined ? ` ORDER BY ${columns.session.updated} DESC` : '';
    const where = [];
    const params = [];
    if (columns.session.deleted !== undefined) where.push(`${columns.session.deleted} IS NULL`);
    if (query !== '') {
      const filters = [];
      if (columns.session.title !== undefined) {
        filters.push(`${columns.session.title} LIKE ? ESCAPE '\\'`);
        params.push(`%${query.replace(/[\\%_]/gu, (character) => `\\${character}`)}%`);
      }
      if (columns.session.directory !== undefined) {
        filters.push(`${columns.session.directory} LIKE ? ESCAPE '\\'`);
        params.push(`%${query.replace(/[\\%_]/gu, (character) => `\\${character}`)}%`);
      }
      if (filters.length > 0) where.push(`(${filters.join(' OR ')})`);
    }
    const sql =
      `SELECT ${select.join(', ')} FROM session` +
      (where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '') +
      orderBy +
      ` LIMIT ${limit} OFFSET ${offset}`;
    const rows = await querySqlite(dbPath, sql, params);

    const sessions = rows.map((row) => {
      const parentId = textOf(row.parentId);
      const taskType = textOf(row.taskType);
      // ZCode marks spawned sessions with a task type; Kilo and OpenCode only
      // record the parent. A user-made fork keeps `fork` and stays top-level.
      const child = columns.session.taskType !== undefined ? CHILD_TASK_TYPES.has(taskType) : parentId !== '';
      return {
        source: spec.id,
        id: textOf(row.id),
        title: textOf(row.title),
        cwd: textOf(row.directory),
        updatedAt: timeOf(row.updated, 0) || undefined,
        path: dbPath,
        parentId: child ? parentId : '',
        child,
        childKind: child ? (taskType === '' ? 'subagent' : taskType) : '',
      };
    });

    let total;
    try {
      const counted = await querySqlite(
        dbPath,
        `SELECT COUNT(*) AS total FROM session${where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''}`,
        params,
      );
      total = Number(counted[0]?.total ?? 0);
    } catch {
      total = undefined;
    }
    return { sessions, total, truncated: total !== undefined ? total > offset + sessions.length : sessions.length >= limit };
  }

  /** Full transcript of one session: user and assistant messages with tool calls. */
  async function readSession(ref) {
    const dbPath = existsSync(textOf(ref?.path)) ? textOf(ref.path) : spec.dbPath();
    const columns = await schema(dbPath);
    const sessionId = textOf(ref?.id);
    if (sessionId === '') throw new Error('readSession needs a session id');

    const sessionRows = await querySqlite(
      dbPath,
      `SELECT ${columns.session.id} AS id${columns.session.title !== undefined ? `, ${columns.session.title} AS title` : ''}${columns.session.directory !== undefined ? `, ${columns.session.directory} AS directory` : ''} FROM session WHERE ${columns.session.id} = ?`,
      [sessionId],
    );
    const sessionRow = sessionRows[0];
    if (sessionRow === undefined) throw new Error(`session "${sessionId}" is not in ${dbPath}`);

    const messageSelect = [
      `${columns.message.id} AS id`,
      `${columns.message.data} AS data`,
      columns.message.sequence !== undefined ? `${columns.message.sequence} AS sequence` : '0 AS sequence',
    ];
    const messageOrder = columns.message.sequence !== undefined ? ` ORDER BY ${columns.message.sequence}` : '';
    const messageRows = await querySqlite(
      dbPath,
      `SELECT ${messageSelect.join(', ')} FROM message WHERE ${columns.message.session} = ?${messageOrder}`,
      [sessionId],
    );

    const partsByMessage = new Map();
    if (columns.part.message !== undefined && columns.part.data !== undefined) {
      const partSelect = [
        `${columns.part.message} AS messageId`,
        `${columns.part.data} AS data`,
        columns.part.sequence !== undefined ? `${columns.part.sequence} AS sequence` : '0 AS sequence',
      ];
      const partOrder = columns.part.sequence !== undefined ? ` ORDER BY ${columns.part.sequence}` : '';
      const partWhere = columns.part.session !== undefined ? `${columns.part.session} = ?` : `${columns.part.message} IN (SELECT ${columns.message.id} FROM message WHERE ${columns.message.session} = ?)`;
      const partRows = await querySqlite(
        dbPath,
        `SELECT ${partSelect.join(', ')} FROM part WHERE ${partWhere}${partOrder}`,
        [sessionId],
      );
      for (const row of partRows) {
        const key = textOf(row.messageId);
        const list = partsByMessage.get(key) ?? [];
        list.push(parseJsonColumn(row.data));
        partsByMessage.set(key, list);
      }
    }

    const messages = [];
    let provider = '';
    let model = '';
    let createdAt;
    const results = [];

    for (const row of messageRows) {
      const data = parseJsonColumn(row.data);
      if (data === null || typeof data !== 'object') continue;
      const role = textOf(data.role);
      if (createdAt === undefined) createdAt = timeOf(data.time?.created ?? data.timeCreated ?? row.sequence, undefined);
      // ZCode CLI stores providerId/modelId on the message, Kilo and OpenCode
      // store a nested model object with providerID/modelID.
      for (const candidate of [data.providerId, data.providerID, data.model?.providerID, data.model?.providerId, data.model?.provider]) {
        if (textOf(candidate) !== '') {
          provider = textOf(candidate);
          break;
        }
      }
      for (const candidate of [data.modelId, data.modelID, data.model?.modelID, data.model?.modelId, data.model?.id, data.model?.name]) {
        if (textOf(candidate) !== '') {
          model = textOf(candidate);
          break;
        }
      }

      const parts = partsByMessage.get(textOf(row.id)) ?? [];
      const textParts = [];
      const reasoningParts = [];
      const calls = [];
      for (const part of parts) {
        if (part === null || typeof part !== 'object') continue;
        const type = textOf(part.type);
        if (type === 'text') {
          const value = textOf(part.text);
          if (value !== '') textParts.push(value);
          continue;
        }
        if (type === 'reasoning') {
          const value = textOf(part.text);
          if (value !== '') reasoningParts.push(value);
          continue;
        }
        if (type === 'tool') {
          const state = part.state !== null && typeof part.state === 'object' ? part.state : {};
          const callId = textOf(part.callID) || textOf(part.callId) || textOf(state.callId);
          const name = textOf(part.tool) || textOf(state.name) || 'tool';
          if (callId === '') continue;
          calls.push({ callId, name, input: state.input, output: state.output, status: textOf(state.status) });
          continue;
        }
        /* step-start, step-finish, timeline and unknown parts carry no model-visible content */
      }

      if (role === 'user') {
        const text = textParts.join('\n\n');
        if (text !== '') messages.push({ role: 'user', text, at: timeOf(data.time?.created ?? row.sequence, undefined) });
        for (const call of calls) {
          results.push({ role: 'tool', callId: call.callId, text: typeof call.output === 'string' ? call.output : JSON.stringify(call.output ?? ''), isError: call.status === 'error', at: timeOf(data.time?.created ?? row.sequence, undefined) });
        }
        continue;
      }
      if (role !== 'assistant') continue;
      const content = [];
      for (const value of reasoningParts) content.push({ type: 'reasoning', text: value });
      for (const call of calls) {
        content.push({ type: 'tool-call', id: call.callId, name: call.name, arguments: call.input });
      }
      for (const value of textParts) content.push({ type: 'text', text: value });
      messages.push({ role: 'assistant', content, at: timeOf(data.time?.created ?? row.sequence, undefined) });
      for (const call of calls) {
        results.push({ role: 'tool', callId: call.callId, text: typeof call.output === 'string' ? call.output : JSON.stringify(call.output ?? ''), isError: call.status === 'error', at: timeOf(data.time?.created ?? row.sequence, undefined) });
      }
    }

    // Tool results belong right after the message that produced them; the grouping
    // step only needs them reachable by call id, so order inside the tail is fine.
    messages.push(...results);

    return {
      source: spec.id,
      label: spec.label,
      foreignId: sessionId,
      title: textOf(sessionRow.title),
      cwd: textOf(sessionRow.directory),
      createdAt: createdAt ?? Date.now(),
      model: { provider, model },
      messages,
    };
  }

  /**
   * Sessions spawned inside one session, in chronological order.
   *
   * A subagent transcript is not a session of its own for the user: it is the
   * detail behind a tool call of its parent, so it is offered as import context
   * rather than as a separate row.
   *
   * @param ref - the parent session reference.
   * @returns child references, oldest first.
   */
  async function childSessions(ref) {
    const dbPath = existsSync(textOf(ref?.path)) ? textOf(ref.path) : spec.dbPath();
    const columns = await schema(dbPath);
    const parentId = textOf(ref?.id);
    if (parentId === '' || columns.session.parent === undefined) return [];
    const select = [`${columns.session.id} AS id`];
    if (columns.session.title !== undefined) select.push(`${columns.session.title} AS title`);
    if (columns.session.directory !== undefined) select.push(`${columns.session.directory} AS directory`);
    const where = [`${columns.session.parent} = ?`];
    if (columns.session.deleted !== undefined) where.push(`${columns.session.deleted} IS NULL`);
    if (columns.session.taskType !== undefined) {
      where.push(`${columns.session.taskType} IN ('subagent_child', 'workflow_child', 'selection_side_chat')`);
    }
    const order = columns.session.created !== undefined ? `${columns.session.created} ASC` : 'rowid ASC';
    const rows = await querySqlite(
      dbPath,
      `SELECT ${select.join(', ')} FROM session WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT 40`,
      [parentId],
    );
    return rows.map((row) => ({
      source: spec.id,
      id: textOf(row.id),
      title: textOf(row.title),
      cwd: textOf(row.directory),
      path: dbPath,
      parentId,
      child: true,
    }));
  }

  /**
   * Transcripts to fold into the parent when subagent context is requested.
   * @param ref - the parent session reference.
   * @returns one context per spawned session, oldest first.
   */
  async function readContext(ref) {
    const contexts = [];
    for (const child of await childSessions(ref)) {
      let transcript;
      try {
        transcript = await readSession(child);
      } catch {
        continue;
      }
      if (!Array.isArray(transcript?.messages) || transcript.messages.length === 0) continue;
      contexts.push({
        title: textOf(child.title) || 'subagent',
        foreignId: child.id,
        childKind: textOf(child.childKind) || 'subagent',
        messages: transcript.messages,
      });
    }
    return contexts;
  }

  return { id: spec.id, label: spec.label, status, listSessions, readSession, childSessions, readContext };
}
