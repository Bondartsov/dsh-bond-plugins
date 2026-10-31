# Контракт движка импорта (`@local/dsh-agent-import`)

Документ описывает **только движок**: HTTP-роуты и инструмент `agent_import`.
Пользовательская точка входа одна — вкладка «Миграция» в `dsh-migrate`; панель этого плагина
из UI снята (осталась страница `main` как цель для deep-link). Внешний вид здесь не описан
намеренно.

## Общее для всех роутов

- База: `http://<host>:<port>/agent-import/*`, ответ — JSON, `content-type: application/json`.
- **Same-origin guard**: запрос обязан прийти из GUI DSH (`Sec-Fetch-Site`), иначе
  `403 NOT_OWNER`.
- Ошибка всегда в форме `{"error": "<КОД>: <сообщение>"}` с HTTP-кодом:
  `400 BAD_ARGUMENT`, `403 NOT_OWNER`, `405` (метод не тот), `409 CONFIRM_REQUIRED`,
  `500 IMPORT_FAILED`.

## GET

| Путь | Параметры запроса | Ответ (поля) |
| --- | --- | --- |
| `/agent-import/inventory` | — | `sources`, `projects`, `ledger`, `generatedAt` |
| `/agent-import/tree` | `query`, `sources` (csv), `perProject` (1–500), `perSourceLimit`, `includeChildren` (`0`/`1`), `fresh` (`0`/`1`) | `projects[]`, `totals`, `includeChildren`, `sources`, `generatedAt`, `cached` |
| `/agent-import/ui` | — | `packageName`, `registered`, `clientPath`, `bundleUrl`, `rev`, `entries`, `reason` |
| `/agent-import/ledger` | — | `total`, `bySource`, `imports`, `entries` |
| `/agent-import/assets` | — | `skills`, `plugins`, `mcp`, `configs`, `generatedAt` |

Элемент `projects[]`: `name`, `path`, `sessions[]`, `total`, `subagentCount`, `importedCount`,
`truncated`. Элемент `sessions[]`: `source`, `id`, `title`, `cwd`, `updatedAt`, `sizeBytes`,
`path`, `parentId`, `child`, `childKind`, `imported`, `importedSessionId`.

`totals`: `projects`, `sessions`, `subagents`, `imported`, `sources`.
Субагентные сессии в `sessions` и во всех счётчиках появляются **только** при
`includeChildren=1`; по умолчанию они скрыты, а их число отдаётся в `subagentCount`/`totals.subagents`.

## POST

| Путь | Тело | Ответ |
| --- | --- | --- |
| `/agent-import/import` | `{source, id, path?, includeSubagents?}` | отчёт импорта (ниже) |
| `/agent-import/import-batch` | `{items: [{source, id, path?}], includeSubagents?, force?}`, не более 50 | `{results[], summary}` |
| `/agent-import/update` | `{source, id, path?}` | см. «Формы `update`» |
| `/agent-import/reimport` | `{source, id, path?, includeSubagents?, confirm: true}` | `{status: "updated", sessionId, previousSessionId, archived, rebuilt: true, verified, eventCount, turnCount, warnings[]}` |
| `/agent-import/verify` | `{sessionId}` | `{sessionId, readable, listed, title, cwd, eventCount, turnCount, appendixCount, inheritedEventCount}` |
| `/agent-import/continue` | `{sessionId, prompt}` | `{sessionId, accepted, requestId, prompt, beforeEventCount, afterEventCount, appended, reply}` |
| `/agent-import/mcp-plan` | — | `{path, count, rows[]}` — файл-предложение, профиль не правится |
| `/agent-import/skills` | `{names: ["skill", ...]}` | `{copied[], skipped[], failed[]}` |

Отчёт импорта: `status` ∈ `imported` | `imported-unverified` | `already-imported`;
поля `sessionId`, `title`, `cwd`, `workspacePath`, `eventCount`, `turnCount`, `droppedCalls`,
`droppedResults`, `verified`, `verifyError?`, `warnings[]`.

`import-batch`: `results[]` — `{source, id, status, sessionId?, title?, verified?, error?}`;
`summary` — `{total, imported, already, failed}`.

## Формы `update` (важно для UI)

Признак «копия пересобрана» — **`rebuilt: true`**; при простом дописывании поля `rebuilt` нет.

| Ситуация | `status` | Поля |
| --- | --- | --- |
| В источник добавились сообщения | `updated` | `sessionId`, `addedMessages`, `addedTurns`, `verified`, `warnings[]` |
| Копию нельзя дополнить, но она не менялась (нет отметки объёма либо источник переписал историю) | `updated` | `sessionId` (**новый**), `previousSessionId`, `archived`, **`rebuilt: true`**, `verified`, `eventCount`, `turnCount`, `warnings[]` |
| Источник не вырос | `up-to-date` | `sessionId`, `addedMessages: 0`, `addedTurns: 0`, `verified: true`, `warnings: []` |
| В копии открыт ход (выполняется или прервана) | `busy` | `sessionId`, нули, `verified: false`, `warnings[1]` |
| Источник переписан, а в копии есть пользовательские ходы | `diverged` | те же нули + `warnings[1]` |
| Запись без отметки объёма, в копию добавляли ходы | `needs-reimport` | те же нули + `warnings[1]` |
| Пересборка не удалась | `failed` | `sessionId` (прежний), `rebuilt: false`, `warnings[]` |

Ничего не удаляется: пересборка создаёт новую копию под новым id, прежняя **архивируется**
(файл остаётся на диске, возвращается из интерфейса). При `failed` ledger продолжает указывать
на существующую копию.

## Инструмент `agent_import`

`{action: "scan" | "search" | "import" | "update" | "reimport" | "verify" | "continue" |
"ledger" | "assets" | "mcp_plan" | "copy_skills" | "ui", ...}` →
`{action, text, data}`: `text` — готовый человекочитаемый отчёт, `data` — тот же объект,
что вернул бы соответствующий роут.

## Инварианты, которые держит движок

1. Сессия пишется тем же слоем, что и остальные сессии DSH (холодный V4-артефакт), поэтому
   её можно открыть и продолжить штатным резюмом.
2. Каждый записанный лог проверяется на V4-инварианты **до** записи и перечитывается **после**.
3. Импорт идемпотентен: id сессии — детерминированная функция от `(source, foreignId)`,
   повторный импорт возвращает `already-imported` без записи.
4. Ledger хранит отметку объёма (`foreignMessageCount`) и отпечаток начала истории, поэтому
   «дописать хвост» и «историю переписали» различаются.
5. Ни один роут не пишет в чужие сторы и не читает секреты.
