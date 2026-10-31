# dsh-migrate — техническое описание (DESIGN)

Документ объясняет **как устроен** плагин `@local/dsh-migrate` 1.0.0 и **почему** приняты
такие решения. Пользовательский мануал — [../README.md](../README.md), история —
[../CHANGELOG.md](../CHANGELOG.md), исходное ТЗ — [../TZ.md](../TZ.md), контракт прежнего
движка (историческая справка) — [ENGINE-CONTRACT.md](ENGINE-CONTRACT.md).

Все утверждения сверены с кодом: `index.js`, `lib/sessions/*`, `lib/assets/*`, `client.js`,
`package.json`, `test/*`.

---

## 1. Задача и границы

Плагин решает две разные задачи, которые исторически жили в двух плагинах и здесь объединены
одной панелью:

| Слой | Задача | Где живёт |
|---|---|---|
| **Сессии** | найти сессии чужих агентов и превратить их в **нативные сессии DSH**, которые можно продолжить; уметь дописывать новое и не создавать дубликатов | `lib/sessions/*`, маршруты `/dsh-migrate/sessions/*` |
| **Ассеты** | перенести скилы, MCP-серверы, секреты и (для просмотра) инструкции, с идемпотентностью и без утечки значений | `lib/assets/*`, маршруты `/dsh-migrate/assets/*` |

Границы: плагин **читает** чужие хранилища и **пишет** только в DSH-принадлежащие места
(`<DSH_HOME>`, артефакты сессий через `sessionPersistence`, патч профиля после бэкапа,
переменные окружения пользователя). Он не перезапускает DSH, не вызывает
`/dsh-reload/reload`, не правит чужие конфиги, не переносит рантаймы плагинов.

Слои независимы: оба используют **одну реализацию** через два входа — маршруты (для панели) и
модельные инструменты (`dsh_migrate_sessions`, `dsh_migrate_assets`). Это гарантирует, что
панель и агент видят одинаковое поведение.

---

## 2. Части

### 2.1 Host (`index.js`)

- `export const inject = ['tools', 'webServer']`. `webServer` объявлен, чтобы регистрация
  маршрутов шла при уже опубликованном HTTP-носителе; `ctx.inject(['webServer'], …)` оставлен
  запасным путём для композиции, публикующей носитель позже.
- **14 маршрутов** `kind: 'exact'` под общим префиксом `/dsh-migrate/` (§3.1).
- **2 инструмента**: `dsh_migrate_sessions` (11 действий), `dsh_migrate_assets` (5 действий).
- `runImportBatch` / `runReimports` + `lib/sessions/runs.js` — реестр прогонов **в памяти
  Host** (25 последних) с весами этапов и текстом подсказки после импорта.
- Сервисы, которые читает Host: `sessionPersistence` (`create`/`open`/`append`/`flush`/`close`),
  `sessionQuery` (`readSession`), `sessions` (`get` — проверка живости), `sessionController`
  (`rename`), `sessionProjectionCache` (`coldSnapshot`), `workspaceRegistry`
  (`resolveByPath`/`create`/`attachSession`/`archiveSession`/`unarchiveSession`),
  `workingDirectory`, `webServer`.

### 2.2 Клиентская половина (`client.js`)

`window.__ModuleLoader__.load({ id: '@local/dsh-migrate', factory })`, React — из хоста.
`inject = ['slots', 'locale']`; дополнительно `sidebarRight`/`sidebarRightTabs`.

| Слот | id / key | order | Что рисует |
|---|---|---|---|
| `main` | key `assets-import` | — | полная страница «Миграция» (шапка + переключатель + тело активной вкладки) |
| `sidebar.panellist` | id `assets-import` | 20 | значок «Миграция» в левой полосе |
| `conversation.session.header.utilities` | id `dsh-migrate-open` | 45 | кнопка «Импорт агентов» в шапке сессии |
| `sidebar.right.pane.tab` | key `assets-import` | — | вкладка правого дока (тот же переключатель вкладок) |

Тип вкладки: `sidebarRightTabs.register({ id: 'assets-import', kind: 'assets-import', title })`.
Пространства локализации: `migrateUI` (оболочка: «Миграция»), `migrateSessionsUI` (вкладка
сессий), `migrateAssetsUI` (вкладка ассетов). Активная вкладка — `localStorage`
`dsh-migrate.tab` (`'sessions' | 'assets'`, неизвестное значение → `sessions`).

Клиент **не** читает Host-сервисы и не вычисляет данные из транскриптов: только маршруты
`/dsh-migrate/*`. Панель поллит прогон с задержкой из ответа Host (`pollMs`, по умолчанию
400 мс, ограничение 100…5000 мс).

---

## 3. Контракты

### 3.1 HTTP-маршруты

Все — same-origin (`sec-fetch-site` отсутствует или `same-origin`, иначе `403 NOT_OWNER`),
метод проверяется явно (`405`), ответ — `cache-control: no-store`, ошибка —
`{ "error": "<КОД>: <подсказка>" }` с HTTP-кодом.

| Метод | Маршрут | Вход | Выход |
|---|---|---|---|
| GET | `/dsh-migrate/sessions/tree` | `query`, `source` (повторяемый), `perProject` (60/500), `perSourceLimit` (500/2000), `includeChildren=1`, `fresh=1` | `{projects[], totals, includeChildren, sources[], generatedAt, cached}` |
| POST | `/dsh-migrate/sessions/run` | `{items:[{source,id,path?}], includeSubagents?}`, ≤ 50; `?wait=1` | `{runId, run, statusRoute, pollMs}` |
| GET | `/dsh-migrate/sessions/run-status` | `?run=<id>` (пусто — последний) | `{run, pollMs}`; `404 RUN_NOT_FOUND` |
| POST | `/dsh-migrate/sessions/import` | `{source,id,path?,force?,includeSubagents?}` | тот же формат прогона |
| POST | `/dsh-migrate/sessions/update` | `{source,id,path?}` | отчёт `update` (см. §4.4) |
| POST | `/dsh-migrate/sessions/reimport` | `{source,id,path?,mode?,confirm?,includeSubagents?}` | формат прогона переимпорта; `400 CONFIRMATION_REQUIRED` для `mode=replace` без `confirm:true` |
| POST | `/dsh-migrate/sessions/repair-watermark` | `{sessionIds?}`, `{entryIds?}`, `{refs?}`; пусто — все строки без отметки; ≤ 200 id | `{items[], summary{requested,repaired,diverged,failed}}` |
| POST | `/dsh-migrate/sessions/attach` | `{sessionIds:[…]}` 1…200 | `{items[], summary{attached,already,failed}}` |
| GET | `/dsh-migrate/sessions/status` | — | `{ledger, ui, latestRun, generatedAt, generatedAtText}` |
| GET | `/dsh-migrate/assets/tree` | `overwriteSecrets=1` | дерево источник → тип → элемент |
| POST | `/dsh-migrate/assets/preview` | `{items:[{type,source,name}], overwriteSecrets?}` | `{items[], writeback, summary}` — **ничего не пишет** |
| POST | `/dsh-migrate/assets/run` | `{items[], dryRun?, overwriteSecrets?}` | `{summary, items[], writeback, environment, ledger}` |
| GET | `/dsh-migrate/assets/status` | — | ledger, патч профиля, цели |
| GET | `/dsh-migrate/assets/instruction` | `?id=<документ>` | документ с маскированием секретов |

Тело запроса читается с ограничением **256 КБ** (у `repair-watermark` — **64 КБ**).

### 3.2 Инструменты модели

`dsh_migrate_sessions({action, …})` → `{action, text, data}`, где `text` — готовый
человекочитаемый отчёт, `data` — тот же объект, что вернул бы маршрут. Действия: `scan`,
`search`, `import`, `update`, `reimport`, `attach`, `repair_watermark`, `verify`, `continue`,
`ledger`, `ui`.

`dsh_migrate_assets({action, …})` → то же; действия: `tree`, `preview`, `run`, `status`,
`read_instruction`.

Инвариант инструментов: **`import` нужен `source` и `id`** (иначе ошибка с подсказкой, где их
взять), `verify`/`continue` — `sessionId`, `continue` — ещё и `prompt`. `continue` тратит
запрос модели.

### 3.3 Формат ledger (журнала идемпотентности)

Оба слоя — один формат на файл:

```json
{ "version": 1,
  "imports": {
    "<source>:<foreignId>": {
      "source": "claude-code", "foreignId": "<id>", "sessionId": "session-…",
      "title": "", "cwd": "", "originalCwd": "",
      "importedAt": 0, "eventCount": 0, "turnCount": 0,
      "droppedCalls": 0, "droppedResults": 0,
      "foreignMessageCount": 0, "foreignPrefixHash": "",
      "verified": true, "warnings": []
    } } }
```

Ключ — `"<источник>:<чужой-id>"`; `entryIds` в `repair-watermark` — это ровно такой ключ.
`foreignMessageCount` + `foreignPrefixHash` — **отметка объёма** (watermark); без них update
невозможен (см. §6.2).

### 3.4 Идентичность элемента ассетов

Клиент присылает **не пути**, а `{type, source, name}` (для инструкций `name` — базовое имя
файла). Host **повторно сканирует источники** и резолвит имя в свежем инвентаре
(`indexInventory`), поэтому подделанный запрос не заставит плагин читать или писать вне
обнаруженных путей. Идентификатор строки в дереве — `"<type>:<source>:<name>"`.

---

## 4. Структура данных

### 4.1 Артефакт импортированной сессии (V4)

Заголовок: `{version: 4, id, createdAt, cwd, isSeeded: false, delegationDepth: 0}`.

Синтезированный лог одного хода:

```
turn/start(turn=N)
step/start(turn=N, step=1)
system/message            ← только первая поверхность (защищённая шапка)
user/message              ← импортированный промпт
session/title             ← только первый ход, source kind "user" (закрепляет имя)
assistant/message         ← по одному на шаг ответа, с полем stream
tool/call                 ← по одному на объявленный вызов
tool/result               ← по одному на завершённый вызов, ссылается на call
step/end(turn=N, step=1)
… следующие шаги того же хода …
turn/end(turn=N, reason=completed)
```

Типы, владеющие узлом видимой поверхности: `system/message`, `developer/message`,
`user/message`, `assistant/message`, `tool/result` — только они несут `surfaceOp: 'append'`.

### 4.2 Снимок прогона (`runs.js`)

`{id, kind: 'import'|'reimport', status: 'running'|'done'|'failed', items[], total, done,
percent, summary{imported, reimported, already, skipped, failed}, projects[], hint, updatedAt}`.

Элемент: `{source, id, title, sessionId, status, stage, messages, turns, events, writeDone,
writeTotal, verified, warnings[], error, mode, previousSessionId, archived, archiveReason}`.
Веса этапов: `queued 0`, `reading 0.08`, `building 0.18`, `creating 0.3`, `writing 0.62`
(интерполируется по `writeDone/writeTotal` между `creating` и `verifying`), `verifying 0.88`,
`done/already/skipped/failed 1`; `deleting 0.35`, `reimporting 0.4`. Пока прогон идёт,
процент ограничен 99 — полоска не «доходит» до конца раньше времени.

### 4.3 Строка дерева проектов

Проект: `{path, name, sources[], sessionCount, importedCount, subagentCount, updatedAt,
truncated, hiddenCount, sessions[]}` (сессии — новые первыми, до `perProject`).
Сессия: `{source, id, title, cwd, updatedAt, sizeBytes, path, importedSessionId, parentId,
child, childKind}` + вычисляемые `inWorkspace`/`workspaceTitle` (для Ungrouped-предупреждения).

### 4.4 Отчёт `update` (важно для UI)

| Ситуация | `status` | Ключевые поля |
|---|---|---|
| в источнике появились сообщения | `updated` | `addedMessages`, `addedTurns`, `verified`, `warnings[]` |
| источник не вырос | `up-to-date` | нули, `verified: true`, возможен `renamedTitle` |
| в сессии открыт ход / её нельзя открыть на запись | `busy` | нули, `verified: false`, предупреждение |
| нет отметки объёма, копия **нетронута** | `updated` + `rebuilt: true` | новый `sessionId`, `previousSessionId`, `archived` |
| нет отметки объёма, в копии есть ваши ходы | `needs-reimport` | `action: 'reimport'`, `reason: 'no-watermark'`, `message` |
| источник переписал начало, копия **нетронута** | `updated` + `rebuilt: true` | как выше |
| источник переписал начало, в копии есть ваши ходы | `diverged` | `action: 'reimport'`, `reason: 'diverged'` |
| источник переписан, копия не читается и т. п. | `failed` | предупреждения |

---

## 5. Инварианты

1. **Идемпотентность через детерминированный id.** `sessionId = "session-" + uuid(sha256(
   "<source>\u0000<foreignId>")[0:32])`. Второй импорт целиком попадает в тот же id, и
   хранилище само отказывает (`SessionAlreadyExists` → `already-imported`), поэтому дубликат
   физически не создаётся. Исключение — осознанный переимпорт копией: там id
   детерминированно **другой** (`…@dsh-migrate-copy:<прежний-id>:<метка>`).
2. **V4-инварианты проверяются до и после записи.** `assertEventStream` до `create`, затем
   перечитывание артефакта через `sessionPersistence.open(…,'read').read(0)` — это тот же
   холодный разбор, что делает DSH при резюме.
3. **`seq` плотный от нуля, время не идёт назад.** В хвосте `seq` **продолжает** нумерацию
   существующего лога (см. §6.4); `assertEventStream` падает, если `seq !== index` или время
   уменьшилось.
4. **Один защищённый `system/message` на лог.** Хвост пишется с `emitSystemHead: false` и
   `requireHead: false`: второго заголовка быть не может.
5. **Ни одна операция не пишет в чужие хранилища.** Чужое читается; пишется только DSH-домен.
6. **Значения секретов не покидают модуль.** Наружу — имя, источник, длина. Ни логов, ни
   отчётов, ни argv, ни браузера.
7. **Патч профиля меняется только после успешного бэкапа.** Нет бэкапа — нет записи.
8. **Запись атомарна**: патч профиля — `.tmp` + `rename`; ledger — `.tmp` + `rename` с
   сериализацией (`saveChain`).
9. **Копия по умолчанию не удаляется.** Переимпорт `copy` создаёт новую копию и **архивирует**
   прежнюю; удаление — только `mode: replace` + `confirm: true` + закрытая сессия.
10. **Отметка объёма — доказательство, а не догадка.** `foreignMessageCount` пишется только
    после совпадения нормализованных префиксов; иначе `diverged` и **ничего** не пишется.
11. **Привязка к проекту идемпотентна**: уже привязанная сессия отвечает `already`.
12. **Имена из запроса резолвятся повторным сканированием** (§3.4).
13. **Прогресс не влияет на результат.** Сбой колбэка прогресса — потеря наблюдаемости, не
    данных; прогресс-ошибка не валит импорт.

---

## 6. Ключевые алгоритмы

### 6.1 Нормализация истории

Чужой транскрипт приводится к общему виду `{turn.user, turn.steps[{blocks, calls}]}`:

- **пользовательские сообщения** — тексты;
- **текст ассистента** — из блоков `text` (плюс `reasoning` и `tool-call` по списку
  `REPLAYABLE_BLOCKS`);
- **вызовы инструментов** сопоставляются с результатами по `callId`; вызов без результата и
  результат без вызова **отбрасываются** (`droppedCalls` / `droppedResults` в отчёте), потому
  что лог DSH строго парный;
- **несколько ходов ассистента** внутри одного пользовательского хода становятся
  `step/start … step/end`;
- **заголовок** имени: `transcript.title` → первое пользовательское сообщение (пропуская
  служебные блоки, начинающиеся с `<`, — это вставки вида `<user_instructions>`) →
  `Imported session (<источник>)`, обрезка до 80 байт;
- **субагентные транскрипты** (если включён «Контекст субагентных») дописываются **в конец**
  отдельными ходами с маркером в первом сообщении, `callId` перемаркируются префиксом
  `sa<N>-`, потому что два порождённых прогона могут переиспользовать провайдерский id.
  Границы: до 50 транскриптов, до 400 сообщений на ребёнка, до 5000 суммарно.

Почему: у разных агентов нет взаимно-однозначного соответствия tool/reasoning-событий, но
**текст пользователя и ассистента** сопоставим — на нём и держится и перенос, и доказательство
отметки.

### 6.2 Watermark и безопасное восстановление отметки

Задача: `update` дописывает только хвост, для чего нужны два поля ledger — сколько сообщений
источника держит копия и хеш начала источника. У записи, созданной прежней установкой, их нет.

Доказательство (`lib/sessions/watermark.js`):

1. Обе стороны приводятся к одной последовательности `{role, text}`:
   - источник: `user` → текст, `assistant` → склеенный текст блоков; tool-сообщения
     пропускаются; параллельно строится `rawEnds[i]` — **сырой** индекс источника, до которого
     покрывает запись `i`;
   - копия: события `user/message` (кроме служебных вставок импортёра
     `[imported from …: the origin recorded …]`) и `assistant/message`; системная шапка, имя,
     маркеры ходов и tool-события отбрасываются; **приложенные субагентные ходы не
     отбрасываются**, они просто идут после префикса источника и потому не мешают.
2. `commonPrefixLength(copy, source)` — длина наибольшего общего префикса.
3. Условие успеха: **вся копия** совпала (`matched === copy.length`) **или** источник
   закончился раньше копии (`matched === source.length` — тогда после префикса идут только
   приложенные транскрипты).
4. Пишется `foreignMessageCount` = `source.rawEnds[matched-1]` (или вся длина, если источник
   покрыт) и `foreignPrefixHash` = хеш первых 5 сообщений источника.
5. Иначе — `diverged`, и **ничего не пишется**.

Почему именно так: `foreignMessageCount` — индекс в **сыром** массиве (updater режет именно
его), поэтому одного «числа совпавших» недостаточно; а хеш начала — единственное, что отличает
«источник вырос» от «источник переписан».

Отпечаток (`signatureOf`): sha256 по первым `SIGNATURE_PREFIX = 5` сообщениям, 16 hex. Он
**не меняется** при добавлении в конец и **меняется** при компакции/правке начала. Для очень
коротких сессий (`< 5` сообщений) сравнение по префиксу не делается — остаётся сравнение по
записанной длине.

### 6.3 Безопасный переимпорт

```
reimportSession(ref, {mode}):
  entry = findImport(source, foreignId)
  mode = replace ? 'replace' : 'copy'

  copy (по умолчанию, не разрушает):
    previousId = entry?.sessionId ?? ''
    newId = previousId === '' ? sessionIdFor(...) : copySessionIdFor(...)
    importForeign({force: true, sessionId: newId})
    если previousId ≠ newId → archiveSession(previousId)
    вернуть {status, mode: 'copy', sessionId: newId, previousSessionId,
             deleted: false, archived, archiveReason, warnings}

  replace (явно, разрушает):
    если сессия жива → ошибка «открыта в DSH, используйте mode=copy»
    archiveSession + rm -rf каталога сессии + forgetImport
    importForeign({force: true})   // тот же детерминированный id
    unarchive
```

Почему `copy` — дефолт: панель не должна заставлять владельца закрывать сессию, а история —
исчезать. Открытая сессия не мешает копии, потому что ничего не удаляется. Если архивация
старой копии не удалась (например, она выполняется), отчёт честно говорит «старая копия
осталась в списке», но новая копия уже создана.

Поиск каталога сессии (`sessionDirectory`) сканирует **первый уровень** каталога сессий и
проверяет, что кандидат лежит внутри корня; если сессия нашлась в нескольких папках проектов —
удаление запрещается (ошибка). Это защита от `rm -rf` по неверному пути.

### 6.4 Seq-континуация при дописывании

`update` не пересобирает лог, а дописывает хвост:

```
known       = entry.foreignMessageCount                       // сколько источника уже в копии
current     = sessionQuery.readSession(sessionId)
если hasOpenTurn(current.events) → busy                        // не рвём выполняющийся ход
delta       = fresh.messages.slice(known)                      // только новые сообщения
startTurn   = (число turn/start в current) + 1
built       = buildEvents(delta, header, {startTurn, emitSystemHead: false, emitTitle: false})
lastSeq     = max(seq в current)
tail[i].seq = (lastSeq + 1) + i                                // плотное продолжение, НЕ с нуля
open(sessionId,'write') → read(0) → append(tail) → flush → close
повторное open(…,'read').read(0) → verified
ledger: foreignMessageCount = freshSignature.count, foreignPrefixHash = freshSignature.prefixHash
```

Почему `seq` берётся из максимума, а не из длины: writer отвергает кусок, чей первый `seq` не
является следующим, а лог, чья нумерация не начинается с 0, дал бы по длине неверное значение.

Почему `hasOpenTurn` смотрит на маркеры, а не на последнюю строку: DSH дописывает служебные
события (имя, выбор модели, политика sandbox, квитанция команды) **после** `turn/end`, поэтому
хвост сканируется на `turn/start`/`turn/end`/`step/start`/`step/end`.

Синхронизация имени: если имя копии совпадает с тем, что записал импортёр (то есть владелец его
не менял), оно догоняется за источником; переименованную владельцем копию источник **не
перезаписывает**. Сбой переименования не валит update.

### 6.5 Прогон импорта и прогресс

`runImportBatch` идёт по элементам, сообщая в реестр `onItemStart` / `onStage` / `onItemDone`.
Этапы приходят из импортёра (`reading`, `building`, `creating`, `writing` с `written/total`,
`verifying`). Панель опрашивает `run-status`; `?wait=1` возвращает итог в одном ответе (для
тестов и скриптов). Реестр живёт **в памяти** и ограничен 25 прогонами: перезапуск посреди
импорта теряет отчёт — сам импорт либо уже лёг в хранилище, либо нет.

Подсказка «Сессии появятся в списке после перезагрузки плагинов (⟳) или перезапуска DSH»
выставляется, если прогон что-то затронул (`imported + reimported + already > 0`), и
сопровождается попыткой обновить список сессий клиентом (`refreshAttempted`).

### 6.6 Адаптеры источников

Один интерфейс: `id`, `label`, `status()`, `listSessions({limit, offset, query})`,
`readSession(ref)`, при наличии — `readContext(ref)` (субагентные транскрипты).

| Источник | Формат | Особенность |
|---|---|---|
| `claude-code` | `~/.claude/projects/<закодированный-cwd>/<uuid>.jsonl` | субагентные — `<uuid>/subagents/*.jsonl` |
| `codex` | `~/.codex/sessions/<ГГГГ>/<ММ>/<ДД>/rollout-*.jsonl` | резерв: `state_5.sqlite`, `session_index.jsonl`; id из имени rollout |
| `zcode-cli` | SQLite `~/.zcode/cli/db/db.sqlite` | общий семейный адаптер (сессии/сообщения/части) |
| `zcode-v2` | `~/.zcode/v2/sessions/<sha256(cwd)[0:12]>/<id>.json` | один JSON-документ на сессию |
| `kilo` | `<KILO_HOME>/kilo.db` | учитывает `KILO_HOME` (хранилище переезжает вместе с XDG) |
| `opencode` | `~/.local/share/opencode/opencode.db` | тот же семейный адаптер |

`status()` различает «источника нет», «не читается» и «доступен» с подсказкой, где он обычно
лежит. Список листингуется по **окну байт** (голова/хвост файла, `LISTING_WINDOW_BYTES`), чтобы
не читать гигабайтные транскрипты ради строки в дереве.

### 6.7 Слои ассетов

**Скилы.** Источники: `~/.claude/skills`, `~/.codex/skills`, `~/.zcode/skills`,
`~/.agents/skills`. Цель — `<DSH_HOME>/skills` (корень `user-dsh`, ранг 400 у
`@deepseek-ai/dsh-skill-filesystem`, ниже = важнее). `~/.agents/skills` DSH уже читает
(ранг 500), поэтому такой скил помечается `available` («уже читается»), а не `new` — копия
только затенила бы рабочую версию. При обновлении существующая копия сохраняется как
`<каталог>.bak-<ДД.ММ.ГГГГ-ЧЧММСС>` и только потом заменяется. Сравнение «новее» — по mtime с
допуском 2 с.

**MCP.** Источники — конфиги агентов (`settings.json`, `config.toml`, `opencode.json` и
кэш-каталоги плагинов). Запись — **один** `- insert:`-блок, добавляемый в конец
`<профиль>/cordis.patch.yml`:

1. существующие имена и id собираются из патча (`parseConfiguredServers`), дубли и повторы в
   одном запросе пропускаются;
2. `buildFragment` строит YAML только для новых серверов, с предупреждением в шапке, что новые
   записи добавляются **только** через `- insert:` (патч с `id` переопределяет запись);
3. **бэкап обязателен**: `scripts/backup-profile.ps1` (переопределяется
   `DSH_ASSETS_BACKUP_SCRIPT`) должен сохранить копию и вернуть путь; иначе запись
   отменяется;
4. запись атомарна (`.tmp` + `rename`), затем патч перечитывается и наличие строк проверяется.

**Секреты.** Кандидаты собираются из `env`-блоков конфигов и из `env`/`headers` MCP-серверов
(тот же парсер, что у MCP-инвентаря, чтобы два взгляда не расходились). Строка содержит имя,
источник и **длину**, но не значение. Запись в User-scope:

```
приватный временный каталог → icacls /inheritance:r /grant:r <пользователь>:F
payload.json (0600) со значениями
powershell set-user-env.ps1 <только путь к payload>   → [Environment]::SetEnvironmentVariable(name, value, 'User')
каталог удаляется в любом случае
проверка: повторное чтение СПИСКА имён User-scope
```

`setx` не используется: он режет длинные значения и берёт значение в argv. Значения
существуют только внутри одного вызова и никогда не форматируются в текст ошибки.

**Инструкции.** Список известных документов фиксирован (`INSTRUCTION_FILES`): `CLAUDE.md`,
`AGENTS.md` (Claude/Codex/ZCode/общие/OpenCode), `settings.json`, `config.toml`,
`cli/config.json`, `opencode.json`. Документы-инструкции копируются в
`<DSH_HOME>/dsh-migrate/instructions` **маскированными** (`redactText`), конфиги — только
просмотр (`status: view`): их настройки принадлежат чужому агенту, а половина — секреты.

**Плагины.** Информационная группа: рантайм не переносится, показывается происхождение
соседних строк `skills`/`mcp`.

### 6.8 Привязка к проекту

`attachSessions` берёт `cwd` сессии, находит воркспейс (`resolveByPath`) или создаёт его
(`create(cwd, basename(cwd))`), затем `attachSession`. Один и тот же механизм используется
импортом (`attachToWorkspace`) и ремонтной кнопкой — «одна реализация, два вызова».
`listWorkspaces` читает реестр; если сервиса нет, поле `inWorkspace` **не выставляется**
(«неизвестно»), а не превращается в ложное «не привязана».

---

## 7. Почему приняты такие решения

| Решение | Альтернатива | Причина |
|---|---|---|
| id сессии = хеш `(source, foreignId)` | случайный uuid | детерминированный id делает повторный импорт физически невозможным |
| Переимпорт копией по умолчанию | удалять и собирать заново | владелец не должен закрывать сессию и терять историю; архив обратим |
| Отметка объёма — доказанный префикс | «примерно столько сообщений» | иначе задвоение истории при переписанном источнике |
| Хеш **начала** истории | хеш всего файла | начало стабильно при добавлении в конец и чувствительно к правке/компакции |
| Нормализация `{role,text}` | сравнивать сырые события | у разных агентов нет соответствия tool/reasoning-событий |
| Патч профиля — только `- insert:` | править существующие записи | патч с `id` переопределяет запись; добавление безопаснее переопределения |
| Бэкап как условие записи | «сделаем бэкап, если получится» | без копии откат невозможен; лучше отказаться от записи |
| Секреты — в User-scope через файл | `setx` / argv | argv виден в списке процессов, `setx` режет значения |
| Скилы только в `<DSH_HOME>/skills` | копировать в `~/.agents/skills` | DSH уже читает этот корень; копия создала бы тень рабочей версии |
| Инструкции — маскированная копия | писать `~/.dsh/AGENTS.md` | чужие инструкции не должны молча менять поведение DSH |
| Прогресс в памяти Host | писать его на диск | отчёт наблюдаемости не должен переживать процесс и спорить с реальностью |
| Имена элементов вместо путей | передавать путь с клиента | путь резолвится в свежем инвентаре — подделанный запрос бессилен |
| `copyUntouched` перед пересборкой | всегда спрашивать владельца | если в копии нет пользовательских ходов, пересборка безопасна и экономит шаг |

---

## 8. Точки совместимости (что сверять при обновлении DSH)

1. **Формат V4** (`sessionPersistence.create/append/flush`, поля заголовка, плотный `seq`,
   защищённый `system/message`, `surfaceOp`, `sourceEventSeqs`) — если формат изменится,
   `assertEventStream` даст точную ошибку, и импорт остановится **до** записи.
2. **Сервисы**: `sessionPersistence`, `sessionQuery.readSession`, `sessions.get`,
   `sessionController.rename`, `sessionProjectionCache.coldSnapshot`, `workspaceRegistry`,
   `workingDirectory`.
3. **Корни скилов**: ранг `user-dsh` (`<DSH_HOME>/skills`) против `user-agents`
   (`<AGENTS_HOME>/skills`) в `@deepseek-ai/dsh-skill-filesystem` — от него зависит статус
   «уже читается».
4. **Поле `files` в `package.json`**: `lib/**/*.js`, `lib/**/*.mjs`, `lib/**/*.ps1` включены,
   а `scripts/` — нет. При установке ссылкой (`link:`) это неважно; при упаковке в тарбол
   скрипт бэкапа в пакет не попадёт, и MCP-запись будет отменяться (нужен
   `DSH_ASSETS_BACKUP_SCRIPT`).
5. **Слоты клиента** (§2.2) и `sidebarRightTabs.register` — пропавший слот означает пропавший
   элемент UI, а не сбой плагина.

---

## 9. Тесты и их роль

- `node --test "test/*.test.mjs"` — **178 тестов**, без сети и без реального Host.
- Покрытие по слоям: `events` (V4-лог и инварианты), `sources` (адаптеры, включая SQLite и
  субагентные файлы), `import`/`update`/`reimport`/`attach`/`watermark`/`runs`,
  `mcp`/`skills`/`secrets`/`redact`/`assets-plugin`, `routes` (все маршруты и guard),
  `client` (рендер панели, вкладки, каскад, стрелки, Refresh, прогресс, кнопки).
- **Сторожа**: идемпотентность; «секреты не утекают» (значения отсутствуют в любом ответе и
  логе); доказательство префикса (идеальный → `repaired`, переписанное начало → `diverged`,
  ничего не записано); переимпорт копией без удаления, в том числе при открытой сессии;
  разрушающий `replace` только с подтверждением; континуация `seq` при дописывании;
  формулировки — только «перезагрузка плагинов (⟳) или перезапуск DSH» (`wording.test.mjs`);
  ни одна поверхность не обещает удаление копии при переимпорте.
- Клиентские тесты используют реальный `__ModuleLoader__` и мини-React, поэтому ловят и
  синтаксис бандла, и логику рендера.
