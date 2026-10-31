# DESIGN — `@local/dsh-reload`

Контракты двух половин, план перезапуска, инварианты и причины решений.
Пользовательское описание — в [README.md](../README.md).

## 1. Форма плагина

```js
export const name = "dsh-reload";
export const inject = ["webServer"];
export function apply(ctx) { … }
```

`inject = ["webServer"]` — не украшение. На холодном старте строки плагинов
загружаются раньше публикации службы: с одним `ctx.get("webServer")` маршруты не
регистрируются, страница получает `404` от живого Host, и «кнопка не работает» до
перезапуска. Объявленная зависимость заставляет Loader подождать службу.

## 2. Контракт HTTP

Все маршруты — `kind: "exact"`, один и тот же origin в Web GUI и в десктопе
(`dsh-app://` пересылает неизвестные пути слушателю Host).

### `POST /dsh-reload/reload`

| Вход | Значение |
|---|---|
| Заголовок `x-dsh-reload` | строго `"1"`, иначе `403 {ok:false, error:"missing x-dsh-reload: 1 header"}` |
| Метод | `POST`, иначе `405` + `Allow: POST` |
| Тело | не требуется |

Ответы (все `200`, кроме метода):

| Случай | Тело |
|---|---|
| Успех | `{ok: true, pending: string[], warnings: string[], restartReason: string\|null}` |
| Нет службы HMR | `{ok: false, reason: "no-hmr", error: "the Host has no hot-reload service, so only the page can be reloaded"}` |
| Исключение reconcile | `{ok: false, error: "<сообщение>"}` + `console.error` |

`pending[]` — модули, которые загрузятся только новым процессом; `restartReason` —
причина уровня профиля. `unmanaged-plugin` в `pending` — норма (общие библиотеки:
zod, schemastery и т. п.), клиент их отфильтровывает.

### `POST /dsh-reload/restart`

| Поле тела | Тип | Смысл |
|---|---|---|
| `force` | `boolean` | снять блок «идёт ход агента» |
| `dryRun` | `boolean` | вернуть план, ничего не делая |

| Код | Когда | Тело |
|---|---|---|
| `405` | не `POST` | `{ok:false, error:"POST only"}` + `Allow: POST` |
| `403` | нет заголовка | `{ok:false, error:"missing x-dsh-reload: 1 header"}` |
| `409` | есть `running`-агенты и нет `force` и не `dryRun` | `{ok:false, reason:"agents-running", running: string[], hint: "…"}` |
| `503` | план не построен (нет родителя; родитель — не приложение) | `{ok:false, error}` |
| `200` | `dryRun` | `{ok:true, dryRun:true, mode, scriptPath, script, launchers, running, wouldFlush}` |
| `202` | перезапуск принят | `{ok:true, restarting:true, mode, pid, delayMs, cancelled, flushed, flushFailed}` |

Порядок побочных эффектов при `202`: отмена ходов → `flush` каждой сессии →
ответ → таймер 600 мс → запуск helper'а → (только `mode: "cli"`) `process.exit(0)`
через 400 мс. Ответ уходит **раньше** убийства процесса, иначе страница не успела
бы нарисовать «Перезапускаюсь…».

`dryRun` разрешён и при работающих агентах: он только описывает план, а описание
как раз и говорит, что понадобится `force`.

### `GET /dsh-reload/status`

`405` для остальных методов; `200 {ok: true, process: ProcessFacts}`.

```ts
type ProcessFacts = {
  pid: number;
  ppid: number;
  execPath: string;          // путь к исполняемому файлу процесса
  argv: string[];            // process.argv.slice(1)
  cwd: string;
  electron: string | null;   // process.versions.electron
  electronRunAsNode: string | null;
  electronModule: string;    // "not-probed" | "object(...)" | "error:<...>"
  profile: string | null;    // DSH_PROFILE
  startedAt: string;         // ISO — машинный формат; в UI конвертируется
};
```

`electronModule` — диагностическое поле: попытка `require("electron")` из
Host-процесса. В десктопе она ожидаемо падает (`error:Cannot find module
'electron'`), и это доказательство, что `app.relaunch()` недоступен.

## 3. План перезапуска

`planRestart(facts)` — чистая функция, возвращающая `{ok, mode, scriptPath, script}`
или `{ok:false, error}`; ничего не выполняет.

### Desktop (`facts.electron` — непустая строка)

1. `appPid = facts.ppid`; не положительное целое → отказ «у Host нет родителя».
2. `basename(facts.execPath).toLowerCase()` должен совпасть с образом родителя
   (`processImage(ppid)` → `tasklist /FI "PID eq <pid>" /FO CSV /NH`). Не совпал →
   отказ «родитель — не приложение, убивать не буду». Это защита от `taskkill`
   чужого процесса при нестандартном окружении.
3. Скрипт (`.cmd`, CRLF):
   `ping -n 3 127.0.0.1` (пауза; `timeout` не работает без консоли, helper
   запускается с `stdio: "ignore"`) → `taskkill /F /T /PID <appPid>` → ожидание
   исчезновения до 20 итераций → если жив, `exit /b 1` (второй экземпляр не
   запускается — иначе конфликт порта) → `taskkill /F /PID <hostPid>` → ожидание
   до 10 итераций → `cd /d "%USERPROFILE%"` → `start "" "<execPath>"`.
4. Логирование каждого шага в `%TEMP%\dsh-reload-restart.log`.

### CLI (`facts.electron` пуст/отсутствует)

Скрипт ждёт исчезновения `<hostPid>` (до 30 итераций) и запускает
`start "" "<execPath>" <argv…>` — тот же процесс с теми же аргументами. Ничего не
убивается: Host выходит сам (см. `process.exit(0)` выше).

`argv` экранируется (`"` → `""`), потому что путь к `index.js` внутри `app.asar`
содержит пробелы.

## 4. Запуск helper'а вне дерева процессов

`launchHelper(plan)` пишет `.cmd` в `%TEMP%` и пробует по порядку:

| # | Launcher | Родитель helper'а | Переживает `taskkill /F /T` дерева |
|---|---|---|---|
| 1 | `wmic process call create "cmd.exe /c call <script>"` | `wmiprvse.exe` | да (проверяется `ReturnValue = 0`) |
| 2 | `schtasks /create /tn dsh-reload-restart-<pid> /tr … /sc once /st 00:00 /f` + `/run` | служба планировщика | да |
| 3 | `explorer.exe <script>` | `explorer.exe` | да |
| 4 | `spawn("cmd.exe", ["/c", script], {detached:true})` | сам Host | **нет** |

Почему не `spawn(detached)`: helper остаётся ребёнком Host, а Host — ребёнком
оболочки; `taskkill /F /T` убивает и его. Замер: helper успевал записать
`killing app tree`, приложение закрывалось, а `start` не выполнялся. Четвёртый
вариант оставлен как последний шанс и явно пишет в лог, что приложение не вернётся.

## 5. Клиентская половина

`PANEL_ID = "dsh-reload"` — **один** идентификатор для трёх мест: строка списка
панелей (`id`), страница (`key`) и ключ, который выбирает оболочка. Если они
разойдутся, клик по строке откроет пустую главную колонку.

```js
ctx.slots.inject("main", () => ctx.slots.register({ name: "main", key: "dsh-reload", locale: NS }, ReloadPanel));
ctx.slots.inject("sidebar.panellist", () => ctx.slots.register(
  { name: "sidebar.panellist", id: "dsh-reload", order: 30, locale: NS, label: () => "Reload DSH" }, ReloadMark));
```

`ReloadMark` — SVG-иконка (круговая стрелка), а не эмодзи: размер задаётся
пропом `size` (в полосе 16, в кнопках 14).

Состояние страницы (локальное, без Host):

| Поле | Тип | Назначение |
|---|---|---|
| `process` | `ProcessFacts \| null` | строка состояния |
| `processError` | `string \| null` | причина недоступности статуса |
| `busy` | `"reload" \| "restart" \| null` | блокировка кнопок и подписи «…ю» |
| `message` | `{tone, title, body?, lines?, actions[]}` | inline-результат |

### Матрица результатов клиента

| Ответ Host | Что делает клиент |
|---|---|
| `reload` → `ok:false` | красный блок, текст `error` |
| `reload` → `ok:true`, `pending` без `unmanaged-plugin` пуст и `restartReason == null` | `window.location.reload()` |
| `reload` → `ok:true`, есть `pending`/`restartReason`/`warnings` | жёлтый блок «Нужен полный перезапуск» + строки причин + кнопки «Скрыть»/«Перезагрузить страницу» |
| `restart` → `409`, `force !== true` | жёлтый блок «Сейчас идёт работа агента», кнопки «Отмена»/«Всё равно перезапустить» → повтор с `force: true` |
| `restart` → `202` | блок «Перезапускаюсь…», кнопки скрыты, `busy = "restart"` |
| `restart` → иное | красный блок, `error`/`hint`/`HTTP <код>` |
| сеть/исключение | красный блок с текстом исключения |

Перед `restart` клиент всегда показывает подтверждение («Незавершённые ходы
агентов будут прерваны. Логи сессий сливаются на диск перед выходом») — кроме
случая, когда пользователь уже нажал «Всё равно перезапустить».

## 6. Инварианты

1. **Гард-заголовок обязателен** для обоих `POST`: чужой веб-странице такой запрос
   требует CORS-preflight, который эти маршруты не обслуживают.
2. **Ответ раньше побочного эффекта**: `202` уходит до таймера, иначе клиент не
   увидит сообщение.
3. **Порядок «отмена → flush → ответ → helper»** не переставляется: логи должны
   быть на диске до `taskkill`.
4. **`dryRun` без побочных эффектов**: ни flush, ни отмены, ни запуска.
5. **Второй экземпляр не запускается**, если предыдущий процесс пережил убийство
   (проверка `tasklist` в скрипте, `exit /b 1`).
6. **План строится до ответа**: ошибка плана (`503`) не оставляет клиент в
   состоянии «перезапускаюсь».
7. **Никакого состояния на диске, кроме лога helper'а**: страница после
   перезагрузки всегда читает свежий `pid` из процесса.
8. **`PANEL_ID` совпадает** в `main.key` и `sidebar.panellist.id`.

## 7. Совместимость и хрупкие места

- `hmr.runExclusive` и `hmr.reconcileProfile` — публичный контракт HMR. Если в
  новой сборке DSH исчезнет `runExclusive`, маршрут вернёт `ok:false` с текстом
  ошибки, а не «тихо ничего не сделает».
- `agents.list()` / `sessions.list()` / `sessions.flush(session)` — мягкие
  зависимости: их отсутствие даёт `[]`/`{flushed:0, failed:[...]}`, перезапуск
  продолжается.
- `tasklist`/`taskkill` — Windows-only; на Linux/macOS ⟳ работает, полный
  перезапуск — нет.
- `wmic` удалён в свежих Windows 11: первый launcher падает в `ENOENT`, дальше
  используется `schtasks`.
- Разметка страницы не зависит от хешированных классов хоста — только слоты,
  токены темы и собственные `dshReload_*` классы.
