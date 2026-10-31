/**
 * Wording guards for the re-import flow.
 *
 * Guard: the engine never deletes an imported copy — it creates a new one and archives the old one,
 * and reports that as `rebuilt: true`. The panel must not tell the owner otherwise: a confirmation
 * that promises deletion, or an "appended N messages" line after a rebuild, is a false statement
 * about what happened to their session.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const client = readFileSync(join(root, 'client.js'), 'utf8')
const ru = JSON.parse(readFileSync(join(root, 'locale', 'ru.json'), 'utf8'))
const en = JSON.parse(readFileSync(join(root, 'locale', 'en.json'), 'utf8'))

test('no surface promises that re-import deletes the copy', () => {
  const forbidden = [/удалит копию/iu, /будет удалена/iu, /удаление старой копии/iu, /deletes the imported copy/iu, /deletes the copy/iu]
  for (const pattern of forbidden) {
    assert.equal(pattern.test(client), false, `client.js still says ${pattern}`)
    assert.equal(pattern.test(JSON.stringify(ru)), false, `locale/ru.json still says ${pattern}`)
    assert.equal(pattern.test(JSON.stringify(en)), false, `locale/en.json still says ${pattern}`)
  }
})

test('the confirmation says a new copy is created and the old one is archived', () => {
  for (const [name, dict] of [['ru', ru], ['en', en]]) {
    const text = String(dict['reimport.confirmTitle'] ?? '')
    assert.match(text, /новую копию|new copy/iu, `${name} confirmTitle explains what is created`)
    assert.match(String(dict['reimport.confirmText'] ?? ''), /архив|archive/iu, `${name} confirmText mentions the archive`)
    assert.match(String(dict['update.needsReimport'] ?? ''), /архив|archive/iu, `${name} needsReimport mentions the archive`)
  }
})

test('a rebuilt update is reported as a rebuild, not as appended messages', () => {
  const rebuiltKey = String(ru['update.rebuilt'] ?? '')
  assert.ok(rebuiltKey !== '', 'ru wording for a rebuild exists')
  assert.match(rebuiltKey, /Пересобрано/iu)
  assert.match(String(en['update.rebuilt'] ?? ''), /Rebuilt/iu)
  assert.ok(String(ru['update.rebuiltKept'] ?? '').includes('осталась в списке'), 'the failed-archive case is worded separately')
  // The branch must read the flag the engine actually sends.
  assert.match(client, /report\.rebuilt === true/, 'the panel branches on report.rebuilt')
  assert.match(client, /update\.rebuilt(Kept)?'/, 'the branch uses the rebuild wording')
  // And a rebuild must not be overwritten by the "repaired, appended N" line.
  assert.match(client, /report\.rebuilt !== true && \(report\.status === 'updated'/, 'the repair notice yields to a rebuild')
})
