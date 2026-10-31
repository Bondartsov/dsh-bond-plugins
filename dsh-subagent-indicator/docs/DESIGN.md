# DESIGN — `@local/dsh-subagent-indicator`

Клиентская половина: контракт слота, стилевые селекторы, модель состояния,
инварианты и причины решений. Пользовательское описание — в
[README.md](../README.md). Host-половина (`index.js`) — пустой `apply()`, нужный
только для валидной строки Loader.

## 1. Форма плагина

```js
window.__ModuleLoader__.load({
  id: "@local/dsh-subagent-indicator",
  factory: (require) => ({ inject: ["slots", "locale"], apply, __test }),
});
```

`__test` — граница для локального harness: `CSS`, `STYLE_ID`, `CHIP`, `ACTIVITY`,
`MODES`, `INTENSITIES`, `COLORS`, `SETTINGS_KEY`, `DEFAULT_SETTINGS`,
`DICTIONARIES`, `catalogState`, `readSettings`, `SubagentIndicator`. Хостом не
используется и на поведение не влияет.

## 2. Что плагин не рисует и почему

Встроенный счётчик субагентов принадлежит пакету
`@deepseek-ai/dsh-client-ui-subagent`: кнопка
`button[aria-haspopup="tree"]` с CSS-модульными классами `<hash>_trigger`,
внутри — `<hash>_activitySlot` (точка, которая существует **только пока работает
хотя бы один ребёнок**), текст счётчика и шеврон. Мы не владеем этим пакетом и не
можем его скрыть; второй чип в шапке создал бы двойное управление. Поэтому
плагин **маркирует** существующий элемент.

Отсюда два независимых механизма:

| Механизм | Что делает | Как включается |
|---|---|---|
| стили | перекраска чипа + кольца | всегда (тег `<style>` в `apply`) |
| место в шапке | публикует состояние на `<html>` + рисует пилюлю в режимах `pill`/`both` | всегда занимает место; пилюля — по `mode` |

Важно: место в шапке занимается **в любом режиме**. В `glow` компонент
возвращает `null`, но его `useEffect` публикует `data-dsw-subind*` и переменные
интенсивности — без этого стили не знали бы состояние (класс точки в разметке
хоста ненадёжен).

## 3. Контракт слота

```js
ctx.slots.inject("conversation.session.header.actions", function* () {
  yield ctx.slots.register(
    { name: "conversation.session.header.actions", id: "subagent-indicator", order: 20, locale: "subagentIndicator" },
    SubagentIndicator,
  );
});
```

- `order: 20` — сразу после встроенного чипа (`order: 10`); пилюля стоит справа
  от счётчика, а не перед ним;
- пропсы места — стандартные для сессии (`sessionId`, `useSessions`,
  `useSessionStatus`) плюс `t` от локали;
- при размонтировании место обязано снять за собой атрибуты (проверяется тестом).

## 4. Модель состояния

```js
const entries    = useSessions((state) => state.projectionsBySession)?.[sessionId]?.values?.subagentCatalog;
const summaries  = useSessions((state) => state.byId);
const statuses   = useSessionStatus((value) => value); // Map<id, {running}>
```

```ts
function catalogState(entries, statuses, summaries): { total: number; running: number; state: "running" | "idle" }
```

Правило подсчёта одного субагента:

```
running(entry) = statuses.get(entry.id)?.running === true
              || summaries[entry.id]?.running === true
```

Почему два источника: живой статус (`useSessionStatus`) приходит от UI-слоя и
может отсутствовать в конкретной сборке; суммарии сессий (`state.byId`) есть
всегда, но обновляются реже. Любой из них, сказавший «работает», включает
индикацию — лучше кратковременно пересветить, чем промолчать. Отсутствие
`entries`/`statuses`/`summaries` — не ошибка: `total = 0`, `state = "idle"`.

## 5. Настройки

`localStorage["dsh.subagentIndicator"]`, читается `readSettings()`:

```ts
type Settings = { mode: "glow" | "pill" | "both"; intensity: "subtle" | "normal" | "strong"; color: "green" | "yellow" | "blue" };
const DEFAULT_SETTINGS = { mode: "glow", intensity: "normal", color: "green" };
```

Валидация — по спискам, а не по truthiness: `MODES.indexOf(parsed.mode)`,
`hasOwnProperty(INTENSITIES, …)`, `hasOwnProperty(COLORS, …)`. Битый JSON,
`null`, массив, числа → умолчание по каждому полю отдельно. Исключение наружу не
выбрасывается никогда.

Где читается:

1. `apply` → эффект `subagent-indicator: accent` — сразу выставляет
   `--dsw-subind-color` и `data-dsw-subind-color` (работает и в `glow`);
2. `SubagentIndicator` → `useRef` при первом рендере — режим пилюли и пресет
   интенсивности.

Следствие: **изменение настроек применяется при следующем монтировании**
(перезагрузка плагинов ⟳ или страницы). Перечитывать на каждом рендере намеренно
не стали: `localStorage` не событие, а опрос storage дороже пользы.

## 6. Стили

### Селекторы

```css
button[aria-haspopup="tree"][class*="_trigger"]:has([class*="_activitySlot"]) { color: var(--dsw-subind-color) }
button[aria-haspopup="tree"] [class*="_activitySlot"]::after { animation: dshSubIndPulse … }
html[data-dsw-subind="running"] button[aria-haspopup="tree"]::after { animation: dshSubIndRing … }
html[data-dsw-subind="idle"] … { color: var(--dsw-alias-label-secondary) }
```

Две стратегии намеренно сосуществуют:

- **красиво и точно** — `:has(_activitySlot)`: подсветка появляется ровно тогда,
  когда точка активности в разметке, без JS-опроса;
- **надёжно** — `html[data-dsw-subind="running"]`: не зависит от хешированных
  классов, рисует кольцо вокруг всего чипа, если `_activitySlot` в сборке
  отсутствует.

### Переменные и палитра

```css
:root {
  --dsw-subind-color: var(--dsw-alias-state-success-primary);
  --dsw-subind-pulse-duration: 2000ms;
  --dsw-subind-pulse-scale: 2.2;
  --dsw-subind-pulse-opacity: .55;
}
```

| `color` | Токен |
|---|---|
| `green` | `--dsw-alias-state-success-primary` |
| `yellow` | `--dsw-alias-state-warn-primary` |
| `blue` | `--dsw-alias-brand-primary` |

Почему свой `--dsw-subind-color`, а не прямое использование токена в правилах:
цвет должен работать и в `glow`, где ничего не рендерится, и в пилюле, и в двух
стратегиях колец — одна переменная на `<html>` переключает всё сразу.

Почему нет `--dsw-alias-state-business-*`: в этой сборке такого алиаса нет (есть
`state-success`, `state-warn`, `state-error`, `state-idle`). Тест «каждый алиас
опубликован» фиксирует список допустимых имён — использовать неопубликованный
алиас нельзя, он молча даст пустой цвет.

### Интенсивность

| `intensity` | duration | scale | opacity |
|---|---|---|---|
| `subtle` | 2800 ms | 1.8 | .45 |
| `normal` | 2000 ms | 2.2 | .55 |
| `strong` | 1300 ms | 2.9 | .70 |

Пресет пишется в inline-стили `document.documentElement` — так его видят и
`:root`-значения по умолчанию, и пилюля, и кольца.

### Reduced motion

```css
@media (prefers-reduced-motion: reduce) {
  …::after { animation: none; opacity: 0 }                       /* точка: без кольца */
  html[data-dsw-subind="running"] …::after { animation: none; opacity: .9 } /* чип: статичное кольцо */
  .dshSubInd_dot { animation: none }
}
```

Решение: состояние передаётся **цветом и статичным кольцом**, а не движением.
Убирать цвет под reduced motion нельзя — тогда индикатор перестал бы выполнять
свою единственную функцию.

## 7. Пилюля

Рисуется только в `pill`/`both` и только при `running > 0`.

```html
<span class="dshSubInd_pill dshSubInd_running" role="status" title="2 субагентов работают" aria-label="…">
  <span class="dshSubInd_dot" aria-hidden="true"></span>
  <span class="dshSubInd_count">2</span>
</span>
```

- `role="status"` — скринридер объявит изменение счётчика;
- `aria-hidden` на точке — декоративная;
- подпись — `pill.running.one` / `pill.running.other`, склонение по числу
  (`1 субагент работает` / `2 субагентов работают`), формат — как у владельца;
- мигание точки — `dshSubIndBlink` 1600 мс; под reduced motion выключено.

## 8. Инварианты

1. **Ни одного хардкод-цвета**: только `var(--dsw-alias-*)`, собственные
   `--dsw-subind-*` и `--dsw-radius-sm` (проверяется тестом по регулярке).
2. **Ровно один тег стилей** с `data-plugin-css="@local/dsh-subagent-indicator/subagent-indicator.css"`;
   повторный `apply` не добавляет второй.
3. **Место занимается всегда**, узел рендерится только в `pill`/`both` и только
   при `running > 0`.
4. **`glow` не меняет DOM** — ни отступов, ни порядка элементов шапки.
5. **Атрибуты на `<html>` снимаются при размонтировании** (иначе после
   перезагрузки плагина осталось бы «залипшее» состояние).
6. **Мусор в `localStorage` не роняет индикатор**: каждое поле валидируется
   отдельно.
7. **Цвет применяется во всех режимах** — включая `glow`, где нет ни одного
   узла плагина.

## 9. Хрупкие места

- Разметка встроенного чипа (`aria-haspopup="tree"`, подстроки `_trigger`,
  `_activitySlot`) не является публичным контрактом DSH. При её смене стилевая
  часть деградирует до атрибутного кольца; тесты поймают только после обновления
  ожидаемых строк.
- Порядок `order: 20` предполагает, что встроенный чип занимает `10`. Если DSH
  поставит туда что-то ещё, пилюля может оказаться не сразу за счётчиком.
- `useSessions`/`useSessionStatus` — Session-стандарт; при смене формы состояния
  `catalogState` вернёт `idle` (деградация, не падение).
- Настройки применяются на монтирование — это осознанный компромисс, записанный
  в ограничениях README.
