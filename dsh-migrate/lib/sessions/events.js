/**
 * V4 event synthesis for imported foreign sessions.
 *
 * A DSH session is an append-only log of strictly related events: a cold read
 * re-checks the turn/step lifecycle, the tool call lifecycle, the surface
 * operations and every message shape. An imported session is only continuable
 * when its synthesized log passes all of that, so this module builds the log
 * AND re-asserts the same invariants before anything is written.
 *
 * Shape of one synthesized log:
 *
 *   turn/start(turn=N)
 *   step/start(turn=N, step=1)
 *   system/message            first surface node only (the protected head)
 *   user/message              the imported prompt
 *   session/title             first turn only, source kind "user" pins the name
 *   assistant/message         one per assistant turn, `stream` reproduces the content
 *   tool/call                 one per advertised call
 *   tool/result               one per settled call, cites the call event
 *   step/end(turn=N, step=1)
 *   ... further steps of the same turn ...
 *   turn/end(turn=N, reason=completed)
 *
 * The leading `system/message` is not cosmetic: DSH appends its own rendered
 * system prompt over that head on the next turn, and the format refuses a
 * system message appended to a surface that has no protected head yet.
 */

/** Event types that own a node of the model-visible surface. */
const SURFACE_TYPES = new Set([
  'system/message',
  'developer/message',
  'user/message',
  'assistant/message',
  'tool/result',
]);

/** Content block types pi-ai can replay from foreign history. */
const REPLAYABLE_BLOCKS = new Set(['text', 'reasoning', 'tool-call']);

/** Title budget, matching the shipped session-title service. */
const MAX_TITLE_BYTES = 80;

/** Bytes read from the head and the tail of a transcript file for a listing row. */
export const LISTING_WINDOW_BYTES = 32 * 1024;

/** Coerce any value to a string. */
const textOf = (value) => (typeof value === 'string' ? value : '');

/** Coerce a foreign timestamp (ISO string, ms number, seconds number) to ms. */
export function timeOf(value, fallback) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    // Foreign stores mix seconds and milliseconds; anything below 1e11 is seconds.
    return Math.round(value < 1e11 ? value * 1000 : value);
  }
  if (typeof value === 'string' && value !== '') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

/** Truncate a title to the byte budget on a character boundary. */
export function truncateTitle(title, fallback = 'Imported session') {
  const normalized = textOf(title).replace(/\s+/gu, ' ').trim();
  if (normalized === '') return fallback;
  if (Buffer.byteLength(normalized, 'utf8') <= MAX_TITLE_BYTES) return normalized;
  let out = '';
  for (const character of normalized) {
    if (Buffer.byteLength(out + character, 'utf8') > MAX_TITLE_BYTES) break;
    out += character;
  }
  const trimmed = out.trim();
  return trimmed === '' ? fallback : trimmed;
}

/**
 * Serialize a foreign tool-call argument value to the raw JSON string DSH keeps
 * in a `tool-call` content block. The same string must appear verbatim on the
 * matching `tool/call` event, so it is computed once.
 */
export function argumentsOf(value) {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return '{}';
    try {
      JSON.parse(trimmed);
      return trimmed;
    } catch {
      return JSON.stringify({ input: value });
    }
  }
  if (value === undefined || value === null) return '{}';
  try {
    return JSON.stringify(value);
  } catch {
    return '{}';
  }
}

/** Compact stream records that reproduce one assistant content block. */
function streamOf(blocks, time0) {
  const stream = [];
  blocks.forEach((block, index) => {
    if (block.type === 'text') {
      stream.push({ type: 'text-chunks', time0, index, dt: [], texts: [block.text] });
      return;
    }
    if (block.type === 'reasoning') {
      stream.push({ type: 'reasoning-chunks', time0, index, dt: [], texts: [block.text] });
      return;
    }
    if (block.type === 'tool-call') {
      stream.push({
        type: 'tool-call-chunks',
        time0,
        index,
        dt: [],
        id: block.id,
        name: block.name,
        args: [block.arguments],
      });
    }
  });
  return stream;
}

/**
 * Rebuild the content blocks a compact stream encodes. Returns `undefined` for
 * a record kind this importer never writes, so the guard refuses it instead of
 * accepting an unverified stream.
 */
export function blocksFromStream(stream) {
  if (!Array.isArray(stream)) return undefined;
  const blocks = [];
  for (const record of stream) {
    if (record === null || typeof record !== 'object') return undefined;
    const index = record.index;
    if (!Number.isSafeInteger(index) || index < 0) return undefined;
    if (!Array.isArray(record.texts) && !Array.isArray(record.args)) return undefined;
    if (!Array.isArray(record.dt) || record.dt.length !== 0) return undefined;
    if (record.type === 'text-chunks') {
      if (!Array.isArray(record.texts) || record.texts.length !== 1) return undefined;
      blocks[index] = { type: 'text', text: textOf(record.texts[0]) };
      continue;
    }
    if (record.type === 'reasoning-chunks') {
      if (!Array.isArray(record.texts) || record.texts.length !== 1) return undefined;
      blocks[index] = { type: 'reasoning', text: textOf(record.texts[0]) };
      continue;
    }
    if (record.type === 'tool-call-chunks') {
      if (!Array.isArray(record.args) || record.args.length !== 1) return undefined;
      blocks[index] = {
        type: 'tool-call',
        id: textOf(record.id),
        name: textOf(record.name),
        arguments: textOf(record.args[0]),
      };
      continue;
    }
    return undefined;
  }
  for (let index = 0; index < blocks.length; index += 1) {
    if (blocks[index] === undefined) return undefined;
  }
  return blocks;
}

/** Concatenate the text of one message's text blocks. */
export function textOfContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    }
  }
  return parts.join('\n\n');
}

/**
 * Group normalized messages into DSH turns and steps.
 *
 * One human prompt opens a turn; every assistant message inside it is one step;
 * a tool result settles a call of the step that advertised it. Calls without a
 * result are dropped from the advertisement, because the lifecycle refuses a
 * step that ends with an unresolved call and fabricating a result would invent
 * history.
 *
 * @param transcript - `{source, foreignId, label, title, messages}`.
 * @returns `{turns, droppedCalls, droppedResults}`
 */
export function groupTurns(transcript) {
  const messages = Array.isArray(transcript?.messages) ? transcript.messages : [];
  const results = new Map();
  let droppedResults = 0;
  for (const message of messages) {
    if (message?.role !== 'tool') continue;
    const callId = textOf(message.callId);
    if (callId === '') {
      droppedResults += 1;
      continue;
    }
    if (results.has(callId)) continue;
    results.set(callId, {
      text: textOf(message.text),
      isError: message.isError === true,
      at: message.at,
    });
  }

  const turns = [];
  let current = null;
  let droppedCalls = 0;
  const consumed = new Set();

  for (const message of messages) {
    const role = message?.role;
    if (role === 'user') {
      current = { user: { text: textOf(message.text), at: message.at }, steps: [] };
      turns.push(current);
      continue;
    }
    if (role !== 'assistant') continue;
    if (current === null) {
      current = { user: null, steps: [] };
      turns.push(current);
    }
    const blocks = [];
    const calls = [];
    for (const block of Array.isArray(message.content) ? message.content : []) {
      if (block === null || typeof block !== 'object') continue;
      if (block.type === 'text') {
        const value = textOf(block.text);
        if (value !== '') blocks.push({ type: 'text', text: value });
        continue;
      }
      if (block.type === 'reasoning') {
        const value = textOf(block.text);
        if (value !== '') blocks.push({ type: 'reasoning', text: value });
        continue;
      }
      if (block.type === 'tool-call') {
        const id = textOf(block.id);
        const name = textOf(block.name);
        if (id === '' || name === '') {
          droppedCalls += 1;
          continue;
        }
        const result = results.get(id);
        if (result === undefined) {
          // No recorded result: do not advertise a call the lifecycle cannot close.
          droppedCalls += 1;
          continue;
        }
        const args = argumentsOf(block.arguments);
        blocks.push({ type: 'tool-call', id, name, arguments: args });
        calls.push({ id, name, arguments: args, result });
        consumed.add(id);
        continue;
      }
      if (block.type === 'image') {
        blocks.push({ type: 'text', text: '[image omitted]' });
        continue;
      }
      if (block.type === 'file') {
        const name = textOf(block.name) || textOf(block.filename);
        blocks.push({ type: 'text', text: name === '' ? '[file omitted]' : `[file omitted: ${name}]` });
      }
    }
    current.steps.push({ blocks, calls, at: message.at });
  }

  for (const callId of results.keys()) {
    if (!consumed.has(callId)) droppedResults += 1;
  }

  return { turns, droppedCalls, droppedResults };
}

/**
 * Build the complete V4 event log of an imported session.
 *
 * @param transcript - normalized transcript; see {@link groupTurns}.
 * @param header - `{id, createdAt, cwd}` of the session being written.
 * @param options - `{startTurn, emitSystemHead, emitTitle}`. An update appends a
 *   tail to an existing log: it starts after the last turn, adds no second
 *   protected system head and does not rewrite the pinned title.
 * @returns `{events, title, droppedCalls, droppedResults}`
 */
export function buildEvents(transcript, header, options = {}) {
  const label = textOf(transcript?.label) || textOf(transcript?.source) || 'another agent';
  const foreignId = textOf(transcript?.foreignId);
  const createdAt = Number.isSafeInteger(header?.createdAt) ? header.createdAt : Date.now();
  const { turns, droppedCalls, droppedResults } = groupTurns(transcript);

  const firstUserText = (() => {
    const candidates = turns.map((turn) => turn.user?.text ?? '').filter((text) => text.trim() !== '');
    // Origin agents inject instruction blocks such as `<user_instructions>` as the
    // opening user message; a name built from that reads as noise in the list.
    return candidates.find((text) => !text.trimStart().startsWith('<')) ?? candidates[0] ?? '';
  })();
  const title = truncateTitle(
    textOf(transcript?.title) || firstUserText || `Imported session (${label})`,
    `Imported session (${label})`,
  );
  const model = transcript?.model ?? {};
  const provider = textOf(model.provider) || textOf(transcript?.source) || 'imported';
  const modelName = textOf(model.model) || `imported/${textOf(transcript?.source) || 'agent'}`;
  const startTurn = Number.isSafeInteger(options.startTurn) && options.startTurn > 0 ? options.startTurn : 1;
  const emitSystemHead = options.emitSystemHead !== false;
  const emitTitle = options.emitTitle !== false;

  const events = [];
  let clock = createdAt;
  const timeFor = (value) => {
    const candidate = Number.isSafeInteger(value) && value > 0 ? value : clock;
    if (candidate > clock) clock = candidate;
    return clock;
  };
  const push = (type, time, data, extra) => {
    const event = { type, seq: events.length, time: timeFor(time), data };
    if (extra !== undefined) Object.assign(event, extra);
    events.push(event);
    return event.seq;
  };

  const systemText =
    `This session was imported from ${label}${foreignId === '' ? '' : ` (${foreignId})`}. ` +
    'The conversation below is the original transcript. Instructions given to the origin agent ' +
    'were not carried over, and DSH replaces this system prompt on the next turn.';
  const fallbackUserText =
    `[imported from ${label}: the origin recorded no opening user message for this turn]`;

  let surfaceStarted = false;
  let turnNumber = startTurn - 1;

  if (turns.length === 0) {
    turns.push({ user: { text: `[imported from ${label}: the origin recorded no messages]`, at: createdAt }, steps: [] });
  }

  for (const turn of turns) {
    turnNumber += 1;
    const turnTime = turn.user?.at ?? turn.steps[0]?.at ?? createdAt;
    push('turn/start', turnTime, { turn: turnNumber });
    push('step/start', turnTime, { turn: turnNumber, step: 1 });

    if (!surfaceStarted && emitSystemHead) {
      push(
        'system/message',
        turnTime,
        {
          turn: turnNumber,
          step: 1,
          message: {
            id: 'import-system',
            role: 'system',
            content: [{ type: 'text', text: systemText }],
            source: { kind: 'system-prompt' },
          },
        },
        { surfaceOp: 'append' },
      );
      surfaceStarted = true;
    }

    const userText = turn.user === null ? fallbackUserText : turn.user.text || '(empty prompt)';
    push(
      'user/message',
      turn.user?.at ?? turnTime,
      {
        id: `import-user-${turnNumber}`,
        role: 'user',
        content: [{ type: 'text', text: userText }],
        source: { kind: 'user' },
      },
      { surfaceOp: 'append' },
    );

    if (emitTitle && turnNumber === startTurn) {
      push('session/title', turnTime, { title, messageSeqs: [], source: { kind: 'user' } });
    }

    let stepNumber = 0;
    for (const step of turn.steps) {
      stepNumber += 1;
      const stepTime = step.at ?? turnTime;
      if (stepNumber > 1) push('step/start', stepTime, { turn: turnNumber, step: stepNumber });
      push(
        'assistant/message',
        stepTime,
        {
          turn: turnNumber,
          step: stepNumber,
          message: {
            id: `import-assistant-${turnNumber}-${stepNumber}`,
            role: 'assistant',
            content: step.blocks,
            source: { kind: 'model', provider, model: modelName },
          },
          stream: streamOf(step.blocks, timeFor(stepTime)),
        },
        { surfaceOp: 'append' },
      );
      for (const call of step.calls) {
        const callSeq = push('tool/call', stepTime, {
          turn: turnNumber,
          step: stepNumber,
          callId: call.id,
          name: call.name,
          arguments: call.arguments,
        });
        push(
          'tool/result',
          timeFor(call.result.at ?? stepTime),
          {
            turn: turnNumber,
            step: stepNumber,
            message: {
              id: `import-tool-${turnNumber}-${stepNumber}-${call.id}`,
              role: 'tool',
              toolCallId: call.id,
              source: { kind: 'tool', callId: call.id },
              content: [{ type: 'text', text: call.result.text === '' ? '(no output)' : call.result.text }],
              isError: call.result.isError === true,
            },
          },
          { surfaceOp: 'append', sourceEventSeqs: [callSeq] },
        );
      }
      push('step/end', stepTime, { turn: turnNumber, step: stepNumber });
    }
    if (stepNumber === 0) push('step/end', turnTime, { turn: turnNumber, step: 1 });
    push('turn/end', turnTime, { turn: turnNumber, reason: { kind: 'completed' } });
  }

  return { events, title, droppedCalls, droppedResults };
}

/**
 * Re-assert every V4 invariant this importer depends on. The cold read performs
 * the same checks; failing here keeps an unreadable artifact out of the store.
 *
 * @param events - the synthesized log.
 * @param options - `{startTurn, requireHead}`: a tail appended to an existing log
 *   starts after the last turn and must not open a second protected head.
 * @throws when any invariant is violated.
 */
export function assertEventStream(events, options = {}) {
  if (!Array.isArray(events) || events.length === 0) throw new Error('imported event stream is empty');
  const fail = (message) => {
    throw new Error(`invalid imported event stream: ${message}`);
  };

  const surface = [];
  let protectedHead;
  let nextTurn = Number.isSafeInteger(options.startTurn) && options.startTurn > 0 ? options.startTurn : 1;
  const requireHead = options.requireHead !== false;
  let openTurn = null;
  let openStep = null;
  let nextStep = 1;
  let previousTime = -1;
  const tools = new Map();

  events.forEach((event, index) => {
    if (event === null || typeof event !== 'object' || Array.isArray(event)) fail(`event ${index} is not an object`);
    if (event.seq !== index) fail(`event ${index} carries seq ${String(event.seq)}; seq must be dense from zero`);
    if (!Number.isSafeInteger(event.time) || event.time < 0) fail(`event ${index} has a non-safe time`);
    if (event.time < previousTime) fail(`event ${index} goes back in time`);
    previousTime = event.time;
    if (typeof event.type !== 'string' || event.type === '') fail(`event ${index} has no type`);
    const data = event.data;
    if (data === null || typeof data !== 'object' || Array.isArray(data)) fail(`event ${index} has no data object`);

    const surfaceType = SURFACE_TYPES.has(event.type);
    if (surfaceType) {
      if (event.surfaceOp !== 'append') fail(`${event.type} at ${index} must carry surfaceOp "append"`);
    } else if (event.surfaceOp !== undefined) {
      fail(`${event.type} at ${index} is not a surface event and must not carry surfaceOp`);
    }
    if (event.sourceEventSeqs !== undefined) {
      if (!surfaceType) fail(`${event.type} at ${index} must not carry sourceEventSeqs`);
      if (event.type === 'assistant/message') fail(`assistant/message at ${index} must not carry sourceEventSeqs`);
      if (!Array.isArray(event.sourceEventSeqs) || event.sourceEventSeqs.length === 0) {
        fail(`${event.type} at ${index} carries empty sourceEventSeqs`);
      }
      const seen = new Set();
      for (const seq of event.sourceEventSeqs) {
        if (!Number.isSafeInteger(seq) || seq < 0 || seq >= index) {
          fail(`${event.type} at ${index} cites a source event that does not precede it`);
        }
        if (seen.has(seq)) fail(`${event.type} at ${index} cites the same source event twice`);
        seen.add(seq);
      }
    }
    if (event.ignorable !== undefined) fail(`${event.type} at ${index} must not be ignorable`);

    switch (event.type) {
      case 'turn/start': {
        if (openTurn !== null) fail(`turn/start at ${index} opens turn ${String(data.turn)} while turn ${openTurn} is open`);
        if (data.turn !== nextTurn) fail(`turn/start at ${index} expects turn ${nextTurn}, got ${String(data.turn)}`);
        openTurn = nextTurn;
        openStep = null;
        nextStep = 1;
        break;
      }
      case 'step/start': {
        if (openTurn === null) fail(`step/start at ${index} is outside an open turn`);
        if (openStep !== null) fail(`step/start at ${index} opens a step while step ${openStep} is open`);
        if (data.turn !== openTurn) fail(`step/start at ${index} names turn ${String(data.turn)}, open turn is ${openTurn}`);
        if (data.step !== nextStep) fail(`step/start at ${index} expects step ${nextStep}, got ${String(data.step)}`);
        openStep = nextStep;
        break;
      }
      case 'step/end': {
        if (openTurn === null || openStep === null) fail(`step/end at ${index} has no open step`);
        if (data.turn !== openTurn || data.step !== openStep) fail(`step/end at ${index} does not close the open step`);
        if (tools.size > 0) fail(`step/end at ${index} leaves ${tools.size} tool call(s) unresolved`);
        openStep = null;
        nextStep += 1;
        break;
      }
      case 'turn/end': {
        if (openTurn === null) fail(`turn/end at ${index} has no open turn`);
        if (openStep !== null) fail(`turn/end at ${index} closes a turn with step ${openStep} still open`);
        if (data.turn !== openTurn) fail(`turn/end at ${index} does not close the open turn`);
        if (tools.size > 0) fail(`turn/end at ${index} leaves ${tools.size} tool call(s) unresolved`);
        if (typeof data.reason?.kind !== 'string' || data.reason.kind === '') {
          fail(`turn/end at ${index} carries no reason kind`);
        }
        openTurn = null;
        nextTurn += 1;
        break;
      }
      case 'system/message': {
        if (openTurn === null || openStep === null) fail(`system/message at ${index} is outside an open step`);
        if (data.turn !== openTurn || data.step !== openStep) fail(`system/message at ${index} does not match the open step`);
        if (!Number.isSafeInteger(data.turn) || data.turn <= 0) fail(`system/message at ${index} needs a positive turn`);
        if (!Number.isSafeInteger(data.step) || data.step <= 0) fail(`system/message at ${index} needs a positive step`);
        if (surface.length > 0 && protectedHead === undefined) {
          fail(`system/message at ${index} requires a protected first surface head`);
        }
        const message = data.message;
        if (message === null || typeof message !== 'object') fail(`system/message at ${index} carries no message`);
        if (typeof message.id !== 'string' || message.id === '') fail(`system/message at ${index} has no message id`);
        if (message.role !== 'system') fail(`system/message at ${index} is not a system role`);
        if (message.source?.kind !== 'system-prompt') fail(`system/message at ${index} is not a system-prompt source`);
        if (!Array.isArray(message.content)) fail(`system/message at ${index} has no content array`);
        for (const block of message.content) {
          if (block?.type !== 'text' || typeof block.text !== 'string') {
            fail(`system/message at ${index} carries a non-text block; a replayed system prompt must be text only`);
          }
        }
        break;
      }
      case 'user/message': {
        if (typeof data.id !== 'string' || data.id === '') fail(`user/message at ${index} has no message id`);
        if (data.role !== 'user') fail(`user/message at ${index} is not a user role`);
        if (typeof data.source?.kind !== 'string' || data.source.kind === '') fail(`user/message at ${index} has no source kind`);
        if (!Array.isArray(data.content)) fail(`user/message at ${index} has no content array`);
        for (const block of data.content) {
          if (block?.type !== 'text' || typeof block.text !== 'string') {
            fail(`user/message at ${index} carries a non-text block`);
          }
        }
        break;
      }
      case 'assistant/message': {
        if (openTurn === null || openStep === null) fail(`assistant/message at ${index} is outside an open step`);
        if (data.turn !== openTurn || data.step !== openStep) {
          fail(`assistant/message at ${index} does not match the open step`);
        }
        const message = data.message;
        if (message === null || typeof message !== 'object') fail(`assistant/message at ${index} carries no message`);
        if (typeof message.id !== 'string' || message.id === '') fail(`assistant/message at ${index} has no message id`);
        if (message.role !== 'assistant') fail(`assistant/message at ${index} is not an assistant role`);
        if (message.source?.kind !== 'model') fail(`assistant/message at ${index} is not a model source`);
        if (typeof message.source.provider !== 'string' || message.source.provider === '') {
          fail(`assistant/message at ${index} has no provider`);
        }
        if (typeof message.source.model !== 'string' || message.source.model === '') {
          fail(`assistant/message at ${index} has no model`);
        }
        if (!Array.isArray(message.content)) fail(`assistant/message at ${index} has no content array`);
        for (const block of message.content) {
          if (block === null || typeof block !== 'object') fail(`assistant/message at ${index} has a non-object block`);
          if (!REPLAYABLE_BLOCKS.has(block.type)) {
            fail(`assistant block type "${String(block.type)}" cannot be replayed from foreign history`);
          }
          if (block.type === 'text' || block.type === 'reasoning') {
            if (typeof block.text !== 'string' || block.text === '') {
              fail(`assistant/message at ${index} carries an empty ${block.type} block`);
            }
            continue;
          }
          if (typeof block.id !== 'string' || block.id === '') fail(`tool-call at ${index} has no id`);
          if (typeof block.name !== 'string' || block.name === '') fail(`tool-call at ${index} has no name`);
          if (typeof block.arguments !== 'string') fail(`tool-call at ${index} arguments must be the raw JSON string`);
          if (tools.has(block.id)) fail(`tool-call id "${block.id}" is advertised twice`);
          tools.set(block.id, { name: block.name, arguments: block.arguments, started: false });
        }
        if (!Array.isArray(data.stream)) fail(`assistant/message at ${index} carries no stream array`);
        const rebuilt = blocksFromStream(data.stream);
        if (rebuilt === undefined) fail(`assistant/message at ${index} carries a stream this importer does not write`);
        if (rebuilt.length !== message.content.length) {
          fail(`assistant/message at ${index} stream does not reproduce the content length`);
        }
        for (let position = 0; position < message.content.length; position += 1) {
          const left = message.content[position];
          const right = rebuilt[position];
          if (right === undefined) fail(`assistant/message at ${index} stream misses block ${position}`);
          if (left.type !== right.type) fail(`assistant/message at ${index} stream block ${position} has another type`);
          if (left.type === 'tool-call') {
            if (left.id !== right.id || left.name !== right.name || left.arguments !== right.arguments) {
              fail(`assistant/message at ${index} stream does not reproduce tool call ${position}`);
            }
          } else if (left.text !== right.text) {
            fail(`assistant/message at ${index} stream does not reproduce block ${position}`);
          }
        }
        break;
      }
      case 'tool/call': {
        if (openTurn === null || openStep === null) fail(`tool/call at ${index} is outside an open step`);
        if (data.turn !== openTurn || data.step !== openStep) fail(`tool/call at ${index} does not match the open step`);
        if (typeof data.callId !== 'string' || data.callId === '') fail(`tool/call at ${index} has no callId`);
        if (typeof data.name !== 'string' || data.name === '') fail(`tool/call at ${index} has no name`);
        if (typeof data.arguments !== 'string') fail(`tool/call at ${index} arguments must be the raw JSON string`);
        const pending = tools.get(data.callId);
        if (pending === undefined) {
          fail(`tool/call "${data.callId}" at ${index} was not advertised by the preceding assistant message`);
        }
        if (pending.started) fail(`tool/call "${data.callId}" at ${index} starts twice`);
        if (pending.name !== data.name) fail(`tool/call "${data.callId}" at ${index} changes the advertised name`);
        if (pending.arguments !== data.arguments) {
          fail(`tool/call "${data.callId}" at ${index} arguments differ from the advertised value`);
        }
        pending.started = true;
        break;
      }
      case 'tool/result': {
        if (openTurn === null || openStep === null) fail(`tool/result at ${index} is outside an open step`);
        if (data.turn !== openTurn || data.step !== openStep) fail(`tool/result at ${index} does not match the open step`);
        const message = data.message;
        if (message === null || typeof message !== 'object') fail(`tool/result at ${index} carries no message`);
        if (typeof message.id !== 'string' || message.id === '') fail(`tool/result at ${index} has no message id`);
        if (message.role !== 'tool') fail(`tool/result at ${index} is not a tool role`);
        if (message.source?.kind !== 'tool') fail(`tool/result at ${index} is not a tool source`);
        if (typeof message.source.callId !== 'string' || message.source.callId === '') {
          fail(`tool/result at ${index} has no source callId`);
        }
        if (message.toolCallId !== message.source.callId) {
          fail(`tool/result at ${index} toolCallId does not equal source.callId`);
        }
        if (typeof message.isError !== 'boolean') fail(`tool/result at ${index} has no boolean isError`);
        if (!Array.isArray(message.content)) fail(`tool/result at ${index} has no content array`);
        for (const block of message.content) {
          if (block?.type !== 'text' || typeof block.text !== 'string') {
            fail(`tool/result at ${index} carries a non-text block`);
          }
        }
        const pending = tools.get(message.source.callId);
        if (pending === undefined || pending.started !== true) {
          fail(`tool/result at ${index} does not settle a started call`);
        }
        tools.delete(message.source.callId);
        break;
      }
      case 'session/title': {
        if (typeof data.title !== 'string' || data.title === '') fail(`session/title at ${index} has no title`);
        if (!Array.isArray(data.messageSeqs)) fail(`session/title at ${index} has no messageSeqs array`);
        const kind = data.source?.kind;
        if (kind !== 'user' && kind !== 'fallback' && kind !== 'provider') {
          fail(`session/title at ${index} carries an unsupported source kind`);
        }
        if ((data.messageSeqs.length === 0) !== (kind === 'user')) {
          fail(`session/title at ${index} mixes a "${String(kind)}" source with ${data.messageSeqs.length} message reference(s)`);
        }
        break;
      }
      default:
        fail(`event ${index} carries the unsupported type "${event.type}"`);
    }

    if (surfaceType) {
      if (event.type === 'system/message' && surface.length === 0) protectedHead = index;
      surface.push(index);
    }
  });

  if (openTurn !== null) throw new Error(`invalid imported event stream: turn ${openTurn} is never closed`);
  if (surface.length === 0) throw new Error('invalid imported event stream: no surface event');
  if (requireHead) {
    if (protectedHead !== surface[0]) {
      throw new Error('invalid imported event stream: the first surface event must be the protected system head');
    }
    const firstSurface = events[surface[0]];
    if (firstSurface?.type !== 'system/message') {
      throw new Error('invalid imported event stream: the first surface event must be a system message');
    }
  }
  return events;
}
