# Peer Bus — контракт v2 (заморожен)

Одна схема для Host-половины (`index.js`), браузерной половины (`client.js`) и тестов.
Все три стороны пишутся против этого документа; менять его может только Lead.

## 1. Доска: `GET /peer-bus/board`

Same-origin, `cache-control: no-store`. Ответ — JSON:

```json
{
  "version": 2,
  "updatedAt": 1793190000000,
  "projects": [{ "root": "D:\\proj", "master": "session-id|null" }],
  "claims": [
    { "project": "d:\\proj", "projectName": "proj", "resource": "merge:main",
      "holder": "session-id", "holderName": "main",
      "since": 1793189000000, "expiresAt": 1793192600000, "note": "мержу PR #42" }
  ],
  "threads": [
    { "id": "th-1", "subject": "кто мержит первым", "status": "open|answered|closed",
      "from": "session-id", "to": "session-id|null", "createdAt": 0, "lastAt": 0, "messages": 3 }
  ],
  "nodes": [
    {
      "id": "session-...", "short": "24b76a", "name": "main",
      "status": "running|idle|closed", "role": "master|worker",
      "master": true, "subagent": false, "dnd": false,
      "intent": "гоню гейты", "last": "последний ответ или запрос",
      "parent": "session-id|null", "cwd": "D:\\proj", "project": "D:\\proj",
      "claims": ["merge:main"],
      "openThreads": 1,
      "state": "running|idle|needs_you|done|error|closed",
      "pendingQuestions": 0,
      "lastActivity": 1793190000000,
      "cost": { "total": 12.5, "currency": "RUB" } 
    }
  ]
}
```

Правила:
- `state` — единственный источник цвета точки: `running` (работает, пульсирует), `idle` (простой),
  `needs_you` (вопрос адресован этой сессии — зелёная с пульсацией), `done` (последний ход завершён
  успешно), `error` (последний ход упал), `closed`.
- `parent` заполнен и для субагентов (durable `session.header.parentSession`), поэтому UI строит
  вложенное дерево, а не плоский список.
- `cost` может быть `null`, если сервис стоимости недоступен — UI обязан это терпеть.
- `claims`, `openThreads`, `dnd`, `role`, `version` — новые поля; старые поля не удаляются
  (`master`, `project`, `nodes`, `updatedAt` остаются на месте).
- Порядок `nodes` не гарантирован, `id` уникален.
- UI не разбирает имена ресурсов, тредов и статусов — только отображает.

## 2. Действия из UI

`POST /peer-bus/master` с телом `{ "sessionId": "<id>" }` — назначить эту сессию мастером её
проекта (Host сам снимает роль с предыдущего мастера и возвращает новую доску целиком).
Ответ — доска v2. Ошибки: `400` — нет `sessionId`, `404` — сессия неизвестна, `403` — чужой
источник запроса.

**Защита обоих маршрутов:** запрос принимается, только если `sec-fetch-site` отсутствует или
равен `same-origin`; иначе `403`. Дополнительно `POST` требует `content-type: application/json`.

## 3. Инструменты (Host)

Ошибки инструментов — всегда `Error` с текстом `"<CODE>: <человеческая подсказка>"`.
Коды: `PEER_NOT_FOUND`, `NO_MASTER`, `CLAIM_HELD`, `CLAIM_NOT_HELD`, `RATE_LIMITED`,
`DUPLICATE_MESSAGE`, `BAD_ARGUMENT`, `UNAVAILABLE`, `SPAWN_BUDGET`, `NOT_OWNER`.

### `peer_sessions({ include_cold?, scope? })`
`scope`: `project` (по умолчанию) | `all`. Возвращает доску текущего проекта (или всех).

### `peer_send({ to, message, mode?, kind?, ref?, expects_reply?, priority? })`
- `mode`: `queue` (по умолчанию) | `steer` | `silent` (в инбокс без пробуждения).
- `kind`: `chat` (по умолчанию) | `question` | `answer` | `claim` | `report` | `handoff`.
- `ref`: id треда; без `ref` сообщение с `kind=question` создаёт новый тред.
- `expects_reply`: по умолчанию `true` для `question`, иначе `false`.
- `priority`: `normal` (по умолчанию) | `urgent`.
- Ответ: `{ delivery, to, thread, kind, text }`.
- Лимиты: не более 5 сообщений одному пиру за 60 с (`RATE_LIMITED`), одинаковый текст тому же
  пиру в течение 30 с — `DUPLICATE_MESSAGE`.
- Если у получателя `dnd: true`, режим принудительно понижается до `silent`.

### `peer_ack({ thread })`
Закрыть тред (`status: closed`). Ответ `{ thread, status, text }`.

### `peer_claim({ resource, ttl_seconds?, note? })` / `peer_release({ resource })`
Захват/освобождение ресурса проекта (`merge:main`, `deploy:staging`, что угодно — строка ≤64).
`ttl_seconds` по умолчанию 900, максимум 86400. Занятый ресурс → `CLAIM_HELD` с держателем.
Ресурс протухает сам.

### `peer_inbox({ peer?, thread?, limit? })`
История с типами, тредом и статусом доставки.

### `peer_wait({ peer?, until?, ref?, resource?, timeout_seconds? })`
`until`: `idle` (по умолчанию) | `message` | `reply` (ждёт статус треда `answered|closed`) |
`free` (ждёт освобождения `resource`). Возвращает `{ outcome, waited_seconds, text }`,
`outcome` ∈ `idle | message | reply | free | timeout`.

### `peer_intent({ text?, label?, master?, dnd? })`
Новый параметр `dnd: true|false` — не будить меня сообщениями (они придут тихо).
Заявка мастера по-прежнему пинит сессию.

### `peer_new_session({ task, title?, cwd?, agent_preset?, wait?, ttl_hours? })`
`ttl_hours`: если задан — простаивающего ребёнка архивирует свип, мастеру уходит `report`.
Возвращает `{ session, short, status, project, text }`.

### `peer_archive_session({ session, stop_activity?, restore? })`
Без изменений по смыслу.

## 4. Файл состояния (Host, `~/.dsh/.peer-bus-state.json`)

```json
{ "version": 2,
  "master": { "id": "session-id", "at": 0 },
  "parents": { "child": "parent" },
  "labels": { "session-id": "main" },
  "intents": { "session-id": { "text": "гоню гейты", "at": 0 } },
  "dnd": ["session-id"],
  "claims": [{ "resource": "merge:main", "holder": "session-id", "since": 0, "expiresAt": 0, "note": "" }],
  "threads": [{ "id": "th-1", "subject": "", "status": "open", "from": "", "to": null,
                "createdAt": 0, "lastAt": 0, "messages": 0 }],
  "spawned": [{ "id": "child", "ttlHours": 24 }]
}
```
Пишется без таймеров и динамических импортов; читается при старте; неизвестные поля
игнорируются. Отсутствие файла — норма.

## 5. Требования к UI (client.js)

- Рендер **только** по полям §1; ничего не вычисляет из транскриптов.
- Клик по узлу графа открывает эту сессию (client-сервис `uiWorkspace.openSession`).
- В меню «…» строки сессии — пункт «Сделать мастером» → `POST /peer-bus/master`.
- Маркер мастера виден и у работающей строки (не только у `idle`).
- Всё, что недоступно (нет `cost`, нет тредов) — тихо скрывается, без падений.
- Ошибки сети не ломают страницу: показывается последнее чтение.
- Только токены `--dsw-alias-*`; тексты — через `ctx.locale` (ru + en).

## 6. Тесты (test/)

- `npm test` из каталога пакета (`node --test "test/*.test.mjs"` — на Node 22.15 каталог
  как аргумент не принимается), без сети и без реального Host.
- Мок-контекст: `test/support/mock-ctx.mjs` — tools/systemPrompt/agents/webServer/fs.
- Сторожа (guard): claims не переходят к двум держателям, тред не закрывается сам, `dnd`
  понижает режим, rate limit срабатывает, доска v2 валидна по схеме, lossless-JSON у всех
  инструментов.
- Мутационное тестирование: скрипт `test/mutation.mjs` с ≥8 мутантами и откатом.
