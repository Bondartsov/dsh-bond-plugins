/**
 * Раздел CHANGELOG.md для конкретной версии.
 *
 * Заголовки в репозитории пишут тремя способами (`## [2.1.0] — дата`, `## 1.0.0 — дата`,
 * `## [1.0.0] — Первый публичный релиз`), к тому же первым может стоять `## Не выпущено`.
 * Поэтому ищем среди заголовков второго уровня тот, у которого версия совпадает точно,
 * и рвём раздел на следующем заголовке того же уровня.
 */

/** Версия в теге и в заголовке: `1.0.0` или `1.0.0-rc.1`. */
const VERSION = '\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?';

const HEADING = new RegExp('^##\\s+\\[?(' + VERSION + ')\\]?(?:\\s|—|$)', 'u');

/**
 * Вырезать раздел версии из текста журнала.
 * @param text - содержимое CHANGELOG.md.
 * @param version - версия без префикса `v`.
 * @returns текст раздела без самого заголовка; пустая строка, если раздела нет.
 */
export function sectionForVersion(text, version) {
  if (typeof text !== 'string' || text === '') return '';
  const lines = text.split(/\r?\n/u);
  const wanted = String(version ?? '').trim();
  let start = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const match = HEADING.exec(lines[index]);
    if (match !== null && match[1] === wanted) { start = index; break; }
  }
  if (start < 0) return '';
  const out = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^##\s+/u.test(lines[index])) break;
    out.push(lines[index]);
  }
  return out.join('\n').trim();
}

/** Есть ли в журнале раздел этой версии. */
export function hasVersionSection(text, version) {
  return sectionForVersion(text, version) !== '';
}
