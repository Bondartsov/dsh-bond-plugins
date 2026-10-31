# DESIGN — `@local/composer-cost`

Техническое описание клиентской половины: контракты слотов, структуры данных,
инварианты и причины решений. Пользовательское описание — в
[README.md](../README.md).

## 1. Разделение половин

| Половина | Файл | Содержимое |
|---|---|---|
| Host | `index.js` | `export function apply() {}` — пусто. Нужен только для валидной строки Loader |
| Client | `client.js` | `window.__ModuleLoader__.load({ id: "@local/composer-cost", factory })` → `{ inject: ["slots", "locale"], apply }` |

Причина пустого Host: обе ячейки считаются из данных, которые уже есть в
браузере (`tokenUsage`, `modelSelection`, Chat-состояние). Host-реестр
(`@local/composer-cost-day`) заведён отдельным пакетом и этой половиной не
используется — см. §8.

## 2. Контракт слотов

```js
ctx.slots.inject("conversation.composer.dock", function* () {
  yield ctx.slots.register({ name: "conversation.composer.dock", id: "cost",       order: 2, locale: "composerCost" }, CostPill);
  yield ctx.slots.register({ name: "conversation.composer.dock", id: "cost-total", order: 3, locale: "composerCost" }, TotalSpend);
});
```

| Слот | id | order | Компонент | DOM-маркер |
|---|---|---|---|---|
| `conversation.composer.dock` | `cost` | 2 | `CostPill` | `data-composer-stat="cost"` |
| `conversation.composer.dock` | `cost-total` | 3 | `TotalSpend` | `data-composer-stat="cost-total"` |

Свойства контракта, на которые опираются тесты и внешние проверки:

- **якорь** `span.dshCost_anchor` с `position: relative` — база для inline-панели;
- **пилюля** `span.dshCost_pill` повторяет геометрию родной полосы статистики
  (`font-size: calc(var(--dsh-content-font-size-secondary, 13px) - 1px)`,
  `line-height: calc(20px + var(--dsh-content-font-delta-secondary, 0px))`);
- панель имеет `role="tooltip"`; у панели сессии — `data-composer-stat-details="cost"`;
- компонент **возвращает `null`** (не пустой узел), когда показывать нечего.

Локаль: `ctx.locale.register("composerCost", { en, ru, zh })`.

## 3. Входные данные

| Источник | Как получен | Что берётся |
|---|---|---|
| `tokenUsage` (проекция сессии) | `useProjection("tokenUsage")` | `uncachedInputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `outputTokens` |
| `modelSelection` (проекция сессии) | `useProjection("modelSelection")` | `lastUsed`, `next` |
| Chat-окно | `useChat(snapshot => snapshot.legacy.nodes)` | `nodes[i].usage.routes[0]` у последнего шага с маршрутом |
| `sessionId` | проп стандартного места сессии | ключ записи в реестре страницы |

`tokenUsage` — **whole-log** объект: суммы всего лога, а не последнего ответа.
Из этого следует правило записи в реестр (§5): новое значение всегда больше или
равно прежнему, поэтому «другое значение» = «новые токены».

## 4. Выбор маршрута и тарифа

```
route = key(selection.lastUsed) ?? key(selection.next) ?? lastRoutableStep ?? DEFAULT_ROUTE
key(r) = `${r.provider}/${r.model}` (undefined, если provider/model не строки)
```

Порядок объясняется назначением:

1. `lastUsed` — модель последнего запроса, то есть то, чем реально считалась сессия;
2. `next` — ещё не отправленный переключатель модели (пользователь уже выбрал, запроса не было);
3. последний шаг с маршрутом — запасной путь, когда проекция `modelSelection` не отдана;
4. `DEFAULT_ROUTE` — модель профиля по умолчанию.

Тариф ищется **точным** совпадением строки в `TARIFFS`. Отсутствие ключа — штатное
состояние (новый маршрут), а не ошибка: оно рендерится как `— ₽ · <модель>`.

### Тарифы

```ts
type Tariff = { input: number; output: number; cacheRead: number } // ₽ за 1e6 токенов
```

`cacheWrite` отдельной ставки не имеет и считается по `input` — провайдер её не
публикует. Формула одного счётчика: `rub = tokens * rate / 1e6`.

## 5. Реестр страницы (итог за день/неделю)

Ключ `localStorage`: **`dshCost.ledger.v1`**.

```ts
type Ledger = {
  [day: "YYYY-MM-DD"]: {
    [sessionId: string]: {
      route: string;                                   // provider/model
      buckets: { uncached: number; cacheRead: number; cacheWrite: number; output: number };
    };
  };
};
```

Правила:

- **день** — локальная календарная дата машины (`localDayKey`), не UTC: «сегодня»
  обязано совпадать с часами пользователя;
- `TotalSpend` в `useEffect` записывает запись текущей сессии, если сумма её
  четырёх счётчиков `> 0`; запись перезаписывается только когда отличается
  (route + все четыре счётчика), иначе `localStorage` не трогается;
- `writePageLedger` удаляет дни старше `LEDGER_KEEP_DAYS = 30`;
- чтение/запись обёрнуты в `try/catch`: приватный режим, запрет storage или
  переполнение оставляют реестр пустым, а страницу — рабочей;
- окно «неделя» = `windowDays = 7`, порог
  `localDayKey(Date.now() - (7-1)*86400000)`; сравнение дней — лексикографическое
  по `YYYY-MM-DD`, что для этого формата эквивалентно хронологическому;
- агрегация: `foldDay` (день → маршрут → сумма счётчиков по всем сессиям) →
  `foldRange` (диапазон дней) → `pricedRoutes` (рубли, сортировка по убыванию,
  флаг `priced`).

Инвариант: **сумма в реестре не может уменьшиться** в пределах дня для одной
сессии, пока не изменился маршрут; при смене маршрута запись заменяется целиком
(старые токены переоцениваются по новому тарифу — это осознанное упрощение,
см. ограничения README).

## 6. Форматирование

| Функция | Правило |
|---|---|
| `formatAmount` | `0 < rub < 0.01` → `<0,01`; иначе `toFixed(2)`, тысячи разделены `\u2009` (узкий неразрывный пробел), дробная часть через запятую |
| `formatTokens` | целое с `\u2009` каждые три разряда |
| `formatDay` | `YYYY-MM-DD` → `ДД.ММ.ГГГГ`; нераспознанная строка возвращается как есть |
| `shortRoute` | последний сегмент `provider/model` (для узкого ярлыка) |

Даты в интерфейсе — только `ДД.ММ.ГГГГ`: значения из реестра приходят машинными и
конвертируются на границе отображения.

## 7. Панель наведения

`useHoverPanel`:

- `onPointerEnter` запоминает `getBoundingClientRect()` якоря и вычисляет
  `right/bottom` для `position: fixed`;
- `onPointerLeave` запускает **таймер 160 мс**, чтобы курсор успел перейти в
  панель; повторный вход таймер отменяет;
- если `react-dom` доступен, панель монтируется в `document.body` через
  `createPortal` и получает класс `dshCost_panelFloating`; иначе рисуется рядом с
  якорем (`dshCost_panelInline`, `bottom: calc(100% + 8px)`).

Причина портала: док композера — контейнер с прокруткой и собственным stacking
context; панель в потоке обрезалась бы, а `z-index: 1100` без портала не спасает.

## 8. Почему `localStorage`, а не Host

Десктопное окно отдаётся схемой `dsh-app://app`. Из этой страницы недоступны ни
`index.html` Host, ни loopback-маршрут `http://127.0.0.1:<порт>`; при этом порт
Web GUI меняется от запуска к запуску, а origin `dsh-app://app` стабилен. Значит,
единственный контейнер, который переживает перезапуск окна и не зависит от порта, —
`localStorage` этого origin.

Цена решения (зафиксирована в ограничениях README): итог видит только сессии,
открывавшиеся в этом окне, и живёт в одном профиле браузера.

`@local/composer-cost-day` закрывает именно эту дыру на стороне Host
(`llm/stream` → `daily.json` → `GET /composer-cost/today?token=…`), но текущая
`TotalSpend` его не читает: Origin страницы в десктопе не тот, что у маршрута.
Переключение — одна правка `TotalSpend` (запрос маршрута с
`window.__DSH_COST_TOKEN__` вместо чтения `localStorage`), когда/если страница
начнёт отдаваться с origin Host.

## 9. Инварианты

1. **Хост не участвует в расчёте.** `index.js` не содержит логики: вся цена
   считается в браузере из проекций. (Удалять сам файл нельзя — пакет перестанет
   быть валидной строкой Loader.)
2. **Нет тарифа — нет суммы, но есть модель.** Ярлык `— ₽` не скрывается:
   пользователь должен видеть, какой ключ добавить.
3. **Нулевой расход скрывает ячейку**, а не показывает `0,00 ₽`.
4. **Все четыре счётчика всегда в разбивке**, включая нулевые.
5. **Ни одного хардкод-цвета**: только токены `--dsw-*` (проверяется глазами при
   правке; своих тестов у пакета нет).
6. **Реестр не бросает исключений**: любая ошибка storage деградирует к пустому
   реестру.
7. **Русские подписи — в `DICTIONARIES.en`**, потому что в сборке нет `ru`.
   Переключение на английский — одна строка (`en: ENGLISH`).

## 10. Известные связи с хостом

- Геометрия пилюли скопирована из полосы статистики
  (`--dsh-content-font-size-secondary`, `--dsh-content-font-delta-secondary`).
  Если DSH сменит переменные, ячейка потеряет выравнивание, но останется рабочей.
- `useChat(snapshot => snapshot.legacy.nodes)` — путь к шагам ассистента. Это
  запасной источник маршрута; при смене формы snapshot маршрут начнёт браться из
  `modelSelection`, а при её отсутствии — из `DEFAULT_ROUTE`.
- `data-composer-stat` / `data-composer-stat-details` — маркеры для внешних
  проверок; менять их без причины нельзя.
