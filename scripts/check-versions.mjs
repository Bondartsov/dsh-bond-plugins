#!/usr/bin/env node
/**
 * Сверка манифеста состава с самими плагинами.
 *
 * `plugins.json` — единственный машинный список репозитория, но настоящая версия плагина
 * живёт в его `package.json`. Расхождение означает, что человек и релизный workflow видят
 * разное, поэтому CI падает до сборки.
 *
 * Наличие раздела текущей версии в `<плагин>/CHANGELOG.md` проверяется МЯГКО: это
 * предупреждение (`::warning::`), а не падение. Иначе новая версия блокировала бы CI до тех
 * пор, пока кто-то не допишет журнал, — а журнал и версия приходят разными правками.
 *
 * Запуск: `node scripts/check-versions.mjs` из корня репозитория. Код возврата 1 — есть
 * расхождения в версиях или отсутствует файл; код 0 с `::warning::` — журнал отстаёт.
 */
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { hasVersionSection } from './changelog-section.mjs';

// fileURLToPath, а не pathname: путь с пробелом (%20) иначе ломает резолв корня.
const ROOT = fileURLToPath(new URL('..', import.meta.url));

const problems = [];
const warnings = [];
const rows = [];

/** Прочитать файл или вернуть undefined. */
async function readText(path) {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

const manifestText = await readText(join(ROOT, 'plugins.json'));
if (manifestText === undefined) {
  console.error('::error::plugins.json не найден');
  process.exit(1);
}

let manifest;
try {
  manifest = JSON.parse(manifestText);
} catch (error) {
  console.error('::error::plugins.json — невалидный JSON: ' + error.message);
  process.exit(1);
}

const plugins = Array.isArray(manifest.plugins) ? manifest.plugins : [];
if (plugins.length === 0) {
  console.error('::error::plugins.json не содержит списка плагинов');
  process.exit(1);
}

const seenDirs = new Set();
const seenNames = new Set();

for (const plugin of plugins) {
  const dir = String(plugin.dir ?? '');
  const name = String(plugin.name ?? '');
  const version = String(plugin.version ?? '');

  if (dir === '') { problems.push(`${name || '(без имени)'}: не указан каталог`); continue; }
  if (seenDirs.has(dir)) problems.push(`${dir}: каталог указан в plugins.json дважды`);
  seenDirs.add(dir);
  if (seenNames.has(name)) problems.push(`${name}: имя указано в plugins.json дважды`);
  seenNames.add(name);

  if (!(await exists(join(ROOT, dir)))) { problems.push(`${dir}: каталога нет в репозитории`); continue; }

  const packageText = await readText(join(ROOT, dir, 'package.json'));
  if (packageText === undefined) { problems.push(`${dir}: нет package.json`); continue; }

  let packageJson;
  try {
    packageJson = JSON.parse(packageText);
  } catch (error) {
    problems.push(`${dir}: package.json — невалидный JSON (${error.message})`);
    continue;
  }

  if (packageJson.name !== name) {
    problems.push(`${dir}: plugins.json name=${name}, package.json name=${packageJson.name}`);
  }
  if (packageJson.version !== version) {
    problems.push(`${dir}: plugins.json version=${version}, package.json version=${packageJson.version}`);
  }

  const changelogPath = String(plugin.changelog ?? '');
  const changelogText = changelogPath === '' ? undefined : await readText(join(ROOT, changelogPath));
  // Мягкая проверка: журнал может отставать от версии, и это не повод блокировать CI —
  // новая версия не должна ждать правки журнала. Но релиз по тегу без раздела не соберётся,
  // поэтому предупреждаем явно и называем тег, который в этом случае упадёт.
  if (changelogText === undefined) {
    warnings.push(`${dir}: журнал ${changelogPath || '(не указан)'} не найден — релиз по тегу ${dir}-v${version} не соберётся`);
  } else if (!hasVersionSection(changelogText, version)) {
    warnings.push(`${dir}: в ${changelogPath} нет раздела версии ${version} — допишите его до тега ${dir}-v${version}`);
  }

  rows.push(`${dir.padEnd(24)} ${version.padEnd(8)} ${name}`);
}

for (const row of rows) console.log('  ' + row);

for (const warning of warnings) console.log('::warning::' + warning);

if (problems.length > 0) {
  console.error('');
  console.error(`Расхождений: ${problems.length}`);
  for (const problem of problems) console.error('::error::' + problem);
  process.exit(1);
}

console.log('');
console.log(`Согласовано: ${plugins.length} плагинов — plugins.json и package.json совпадают` + (warnings.length === 0 ? ', разделы журналов на месте.' : `, предупреждений по журналам: ${warnings.length}.`));
