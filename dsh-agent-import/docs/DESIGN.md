# DESIGN — `@local/dsh-agent-import`

Внутреннее устройство движка: слои, контракты адаптеров, формат транскрипта,
синтез V4-лога, ledger, семантика `update`/`reimport`, клиентская половина,
инварианты. Внешний контракт маршрутов и инструмента — в
[ENGINE-CONTRACT.md](ENGINE-CONTRACT.md); пользовательское описание — в
[README.md](../README.md).

## 1. Форма плагина

```js
export const name = "agent-import";
export const inject = ["tools", "webServer"];
export function apply(ctx) { … }
```

`index.js` — тонкая обёртка: создаёт `createOperations(ctx)` и регистрирует

1. 13 exact-маршрутов через `ctx.webServer.register` (внутри `ctx.effect`, с
   отпиской при выгрузке);
2. инструмент `ctx.tools.register({name: "agent_import", …})` с описанием,
   схемой параметров, схемой вывода и `render`.

Если `ctx.get("webServer")` уже доступен — маршруты ставятся сразу; иначе
`ctx.inject(["webServer"], installRoutes)` как запасной путь для композиции,
публикующей службу позже.

## 2. Слои

| Слой | Файл | Ответственность | Знает про DSH |
|---|---|---|---|
| маршруты + инструмент | `index.js` | HTTP-форма, гард, ошибки, человекочитаемый рендер | да (сервисы) |
| операции | `lib/api.js` | одна реализация на оба потребителя | да |
| сканирование | `lib/scan.js` | инвентарь, поиск, дерево, кэш | нет |
| адаптеры | `lib/sources/*` | чтение чужого стора | нет |
| синтез лога | `lib/events.js` | V4-события из транскрипта | нет (чистые функции) |
| запись | `lib/import.js` | create/append/flush/close, проверка, id, update/reimport | да |
| ledger | `lib/ledger.js` | провенанс импортов | нет |
| ассеты | `lib/assets.js` | скилы, плагины, MCP, конфиги | нет (только файлы) |
| пути | `lib/paths.js` | `DSH_HOME`, home, head/tail, JSON-lines | частично |

Правило: **чистые слои не импортируют сервисы DSH**; сервисы приходят через
`ctx.get(...)` в `import.js`/`api.js`. Поэтому синтезатор и адаптеры тестируются
без Host.

## 3. Контракт адаптера источника

```ts
interface Source {
  id: string;                                    // claude-code | codex | zcode-cli | zcode-v2 | kilo | opencode
  label: string;
  status(): Promise<{ available: boolean; reason?: string; hint?: string; path?: string }>;
  listSessions(options): Promise<SessionRow[]>;
  readSession(ref): Promise<Transcript>;          // ref = {source, id, path?}
  childSessions?(…): Promise<SessionRow[]>;       // порождённые сессии, если стор их различает
  readContext?(…): Promise<Transcript>;           // контекст ребёнка для appendix
}
```

`SOURCES` — массив в порядке отображения (`lib/sources/index.js`). Добавление
агента = один модуль и одна строка в реестре; `index.js`, `api.js`, `scan.js` не
меняются.

## 4. Транскрипт и синтез V4

Промежуточная форма (нормализованный транскрипт):

```ts
type Transcript = {
  source: string;
  foreignId: string;
  title: string;
  cwd: string;
  createdAt: number;
  messages: Array<
    | { role: "user"; text: string; … }
    | { role: "assistant"; text: string; reasoning?: string; … }
    | { role: "tool"; call: {id, name, arguments}; result: {content, isError} }
  >;
  warnings: string[];          // потери: картинки, инструменты, переписанные вызовы
};
```

Синтезатор (`lib/events.js`) выдаёт строго упорядоченный лог:

```
turn/start → step/start → system/message (защищённый) → user/message
           → session/title → assistant/message → tool/call → tool/result
           → step/end → turn/end
```

Почему именно так: это форма, которую DSH создаёт сам, и единственная, которую
принимает холодное чтение и последующий резюм. `seq` плотный и сквозной;
`turn`/`step` нумеруются заново в каждом ходе; системный заголовок ровно один на
сессию; `tool/result` без парного `tool/call` недопустим.

## 5. Импорт

```js
const sessionId = sessionIdFor(source, foreignId)   // "session-" + sha256(source\0foreignId)[0..32] в форме UUID
```

Детерминированный id даёт три свойства: повторный импорт — `already-imported`,
`update`/`reimport` находят ту же копию, а `verify` может проверить конкретную
запись без поиска.

Порядок `importForeign`:

1. `sourceById(ref.source)` → неизвестный источник — ошибка со списком допустимых;
2. `adapter.readSession(ref)` → транскрипт (+ отпечаток **исходных** сообщений до
   склейки appendix);
3. `findImport(source, foreignId)` → есть запись и нет `force` → `already-imported`;
4. `resolveImportCwd` — проект сессии; если каталога нет на машине, используется
   рабочий каталог DSH по умолчанию и пишется предупреждение;
5. `events` из транскрипта (+ appendix субагентных, если просили);
6. `sessionPersistence.create` → `append` → `flush` → `close`;
7. **холодное перечитывание** тем же сервисом → проверка V4-инвариантов;
8. `sessionProjectionCache.coldSnapshot` — чтобы холодная строка списка сразу
   показывала имя;
9. `workspaceRegistry` — прикрепление к workspace проекта;
10. запись в ledger (`sessionId`, `title`, `cwd`, `importedAt`,
    `foreignMessageCount`, `foreignPrefixHash`).

Отчёт: `status ∈ imported | imported-unverified | already-imported`, счётчики
событий и ходов, `droppedCalls`/`droppedResults`, `verified`, `verifyError?`,
`warnings[]`.

## 6. Ledger

Файл `~/.dsh/agent-import/ledger.json` (`DSH_HOME` учитывается):

```ts
type Ledger = {
  version: 1;
  imports: {
    [`${source}:${foreignId}`]: {
      source: string;
      foreignId: string;
      sessionId: string;
      title: string;
      cwd: string;
      importedAt: number;
      foreignMessageCount: number;   // отметка объёма на момент импорта
      foreignPrefixHash: string;     // отпечаток начала истории
    };
  };
};
```

- читается один раз на процесс, пишется сериализованной цепочкой (`saveChain`),
  чтобы два параллельных импорта не перемешались;
- ledger — не кэш, а **провенанс**: только идентичность и счётчики, без тел
  сообщений и секретов;
- `listImports()` сортирует по `importedAt` убыв.; `ledgerSummary()` даёт
  `total`/`bySource`; маршрут `/ledger` отдаёт до 200 записей, инструмент — сводку.

`foreignMessageCount` + `foreignPrefixHash` — это то, что позволяет отличить
«источник дописал хвост» от «источник переписал историю».

## 7. `update` и `reimport`

### `update` — дописать хвост

Условия и исходы (полная таблица — в `ENGINE-CONTRACT.md`):

| Проверка | Исход |
|---|---|
| в копии открыт ход (`hasOpenTurn`) | `busy` |
| отпечаток начала истории не совпал | `diverged` |
| нет отметки объёма | `needs-reimport` |
| источник не вырос | `up-to-date` |
| вырос | `updated` + `addedMessages`/`addedTurns` |

Дозапись строится от последнего завершённого хода: `startTurn = число turn/start + 1`,
новый системный заголовок не создаётся, имя не переписывается. Session id, имя и
ходы, добавленные пользователем в DSH, сохраняются.

Если дополнить нельзя, но копия не менялась, выполняется **пересборка**:
создаётся новая копия под новым id, прежняя архивируется
(`workspaceRegistry.archiveSession`), в ответе `rebuilt: true` и
`previousSessionId`.

### `reimport` — пересборка по запросу

Маршрут требует `{"confirm": true}`: операция создаёт вторую копию и архивирует
первую, поэтому не выполняется неявно. Живая (открытая) сессия → `busy`.
Неудачная пересборка → `failed`, ledger продолжает указывать на существующую
копию, ничего не удаляется.

## 8. Субагентные сессии

Порождённая сессия — не отдельный разговор пользователя, а детализация внутри
родительской. Признак берётся из данных источника, не из имени:

| Источник | Признак |
|---|---|
| ZCode CLI/sqlite | `task_type ∈ subagent_child, workflow_child, selection_side_chat` |
| KiloCode, OpenCode | заполнен `parent_id` |
| ZCode v2, Codex | признака нет — все сессии верхнего уровня |
| Claude Code | побочные ветки отдельными файлами `<session>/subagents/**/*.jsonl` |

Пользовательский fork (`task_type = fork`) остаётся сессией верхнего уровня.
Дети скрыты по умолчанию, считаются отдельно (`subagentCount`, `totals.subagents`)
и попадают в `sessions` только при `includeChildren=1`.

`includeSubagents` при импорте добавляет содержимое детей в конец родительской
копии как явно размеченные ходы-приложения: свой диалог родителя не меняется, а
модель при продолжении видит работу субагентов. `tool-call id` каждого ребёнка
получает свой префикс, поэтому вызовы разных детей не сталкиваются; размер
appendix ограничен, чтобы один огромный родитель не раздул лог.

## 9. Ассеты

- **скилы** — инвентарь по корням `~/.claude/skills`, `~/.codex/skills`,
  `~/.zcode/skills`, `~/.agents/skills`; копирование `cp(..., {recursive, dereference})`
  в `~/.dsh/skills/<имя>`; существующее имя → `skipped`, не найдено → `failed`;
- **плагины** — только перечисление (`~/.claude/plugins`, `~/.codex/plugins`,
  `~/.zcode/plugin-workspace`); рантайм не переносится;
- **MCP** — серверы из конфигов агентов; предложение — `- insert:`-фрагмент с
  `id: mcp-<slug>`, `transport` (`streamable-http`/`stdio`) и `url`/`command`.
  Пишется в `~/.dsh/agent-import/mcp-proposal.yml`. Профиль не правится — это
  работа менеджера плагинов, а секреты должны остаться ссылками;
- **конфиги** — только `present`/`sizeBytes`/`path`; содержимое не читается.

## 10. Клиентская половина

`client.js` после снятия панели регистрирует **только** страницу:

```js
ctx.slots.inject("main", () =>
  ctx.slots.register({ name: "main", key: "agent-import", locale: "agentImportUI" }, ImportPage));
```

Строка в `sidebar.panellist`, кнопка в шапке беседы и вкладка в правом доке
удалены — вход в миграцию один, через `dsh-migrate`, чтобы владелец не видел двух
импортёров. Компонент `HeaderButton` в файле остался, но **не регистрируется**:
это мёртвый код, оставленный как точка возврата.

Почему страница осталась: deep-link по ключу `agent-import` (другой плагин или
переход по ссылке может открыть её) и возможность отладки движка без панели.
Данные страница берёт теми же same-origin маршрутами и ничего не хранит у себя;
`runtime.openSession`/`runtime.selectPanel` берутся из сервисов `uiWorkspace` и
`layout`, их отсутствие только пишет `console.warn`.

`package.json` всё ещё объявляет `dsh.client.inject` на
`@deepseek-ai/dsh-client-ui-conversation`, `-workspace`, `-sidebar-right` — это
требования к композиции бандла, а не регистрации мест; лишние зависимости
безвредны, но при чистке их можно сузить до `-conversation` (страница `main`).

## 11. Инварианты

1. **Чужой стор — только чтение.** Ни один маршрут не пишет вне `DSH_HOME` и не
   читает секреты.
2. **Каждый лог проверяется до записи и перечитывается после.** `imported` без
   `verified` не бывает: при провале чтения статус `imported-unverified`.
3. **Импорт идемпотентен.** id — чистая функция `(source, foreignId)`; повторный
   импорт без `force` не пишет ничего.
4. **Ничего не удаляется.** Пересборка создаёт новую копию и архивирует прежнюю;
   файл прежней остаётся на диске.
5. **Одна реализация на два потребителя.** Маршрут и действие инструмента
   вызывают один и тот же метод `createOperations`.
6. **Ошибка одного элемента не валит партию.** `import-batch` ловит исключение
   на каждом элементе и возвращает `status: "failed"` с текстом.
7. **same-origin гард** на всех маршрутах: `Sec-Fetch-Site` не `same-origin` →
   `403 NOT_OWNER`; отсутствие заголовка считается своим (не-браузерные клиенты).
8. **Тело запроса ограничено** (16 КиБ / 256 КиБ) и парсится терпимо: битый JSON
   → `undefined` → `400 BAD_ARGUMENT`.

## 12. Известные расхождения (не исправлялись — вне задачи документации)

| Что | Где | Последствие |
|---|---|---|
| `includeSubagents` читается из `args`, но не объявлен в `parameters` | `index.js`, `execute` | через инструмент модели поле недоступно; через маршрут `/import`, `/import-batch`, `/reimport` — доступно |
| `reimport` через инструмент не передаёт `confirm` | `index.js` | маршрут требует `confirm: true`, инструмент вызывает `operations.reimport` напрямую и работает без него — поведение потребителей расходится |
| `verify` всегда возвращает `readable: true` | `lib/api.js` | поле `readable` в контракте фактически константа; реальный признак — отсутствие исключения |
| `dsh.client.inject` шире, чем нужно после снятия панели | `package.json` | безвредно; три зависимости вместо одной |

## 13. Хрупкие места

- Формат V4 и `sessionPersistence` — контракт DSH; при его смене ломается запись,
  и это видно как `imported-unverified`/`failed`, а не как тихая порча.
- SQLite читается встроенным ридером (`lib/sqlite.js`, `lib/sqlite-reader.mjs`) —
  чужие схемы могут меняться между версиями агентов; адаптеры терпимы к
  отсутствующим колонкам, но новая схема потребует правки адаптера.
- Ledger хранится в памяти процесса после первого чтения: ручная правка файла
  при работающем Host не подхватится до перезапуска.
- `sessionProjectionCache` и `workingDirectory` — необязательные: без них импорт
  проходит, но холодная строка списка может не показать имя (об этом пишется
  предупреждение), а сессия без проекта прикрепляется к каталогу по умолчанию.
- `workspaceRegistry` обязателен для `reimport` (`requireService`): без него
  пересборка падает с «the Host does not publish "workspaceRegistry"», а импорт
  без архивации прежней копии невозможен.
