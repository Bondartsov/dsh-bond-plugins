/**
 * Runtime-side SQLite reader.
 *
 * Executed by the DSH-bundled Node when the Host process has no `node:sqlite`.
 * Reads one JSON payload from stdin (`{db, sql, params}`), opens the database
 * strictly read-only, and writes the rows back as one JSON array on stdout.
 */
import { DatabaseSync } from 'node:sqlite';

/** Read all of stdin as text. */
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

/** Run the query described on stdin and print the rows. */
async function main() {
  const payload = JSON.parse(await readStdin());
  if (payload === null || typeof payload !== 'object' || typeof payload.db !== 'string' || typeof payload.sql !== 'string') {
    throw new Error('payload must be {db: string, sql: string, params?: unknown[]}');
  }
  const database = new DatabaseSync(payload.db, { readOnly: true });
  try {
    const statement = database.prepare(payload.sql);
    const rows = statement.all(...(Array.isArray(payload.params) ? payload.params : []));
    process.stdout.write(
      JSON.stringify(
        rows.map((row) => {
          const plain = {};
          for (const [key, value] of Object.entries(row)) {
            // node:sqlite may hand back a Buffer for a blob column; the panel only
            // needs scalars, so a blob becomes its byte length.
            plain[key] = Buffer.isBuffer(value) ? `blob:${value.length}` : value;
          }
          return plain;
        }),
      ),
    );
  } finally {
    database.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error?.stack ?? String(error)}\n`);
  process.exitCode = 1;
});
