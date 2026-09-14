# assign.ts

## Зачем это нужно

Модуль существует, чтобы изолировать два направления контракта API назначения: построение исходящего запроса и разбор входящего ответа. Он предоставляет две чистые функции, которые вместе покрывают весь жизненный цикл обмена данными с сервером назначений — от формирования полезной нагрузки до фильтрации полученных элементов. Благодаря этому вызывающий код не работает с сырыми форматами провода напрямую, а опирается на стабильные сигнатуры.

## Что делает

Модуль выполняет два раздельных действия: 1) сериализует данные назначения в объект запроса с фиксированными ключами `responseSchema` и `messages`; 2) десериализует ответ, возвращая `Map<string,string>`. Обе функции делегируют всю работу своим телам и не имеют побочных эффектов.

## На что можно положиться

Both exported functions are pure and deterministic: they never mutate their inputs and always return a fresh object or array. [`buildAssignRequest`](#buildassignrequest) returns a plain object with exactly the keys `responseSchema` and `messages`; it does not include any other properties. [`parseAssignResponse`](#parseassignresponse) returns a new `Map<string,string>`; it never modifies the input and never returns a reference to it.

## От чего зависит

The module constructs the request object from the provided `AssignInput` fields and a static system prompt.

# buildAssignRequest

```ts
buildAssignRequest(input: AssignInput): ChatCompletionInput
```

## Зачем это нужно

Функция существует, чтобы преобразовать данные назначения в точный формат, ожидаемый сервером. Она принимает объект `AssignInput` и возвращает объект, который можно напрямую отправить как тело запроса.

## Что делает

Единственный эффект функции — создание объекта полезной нагрузки запроса с ключами `responseSchema` и `messages`. Она не выполняет никаких других действий: не валидирует входные данные, не обращается к внешним ресурсам и не изменяет состояние.

## На что можно положиться

Функция всегда возвращает новый объект с ключами `responseSchema` и `messages`. Она не изменяет переданные аргументы и не добавляет никаких других свойств. Порядок ключей в объекте не гарантируется, но это не влияет на контракт, так как доступ осуществляется по именам.

## От чего зависит

The function constructs the request object solely from the `AssignInput` parameter and the static `SYSTEM_PROMPT`.

## Кто и как использует

The caller invokes this function to obtain a request object, which it then uses to perform the actual network call.

# parseAssignResponse

```ts
parseAssignResponse(content: string, knownFiles: ReadonlySet<string>, knownSlugs: ReadonlySet<string>): Map<string, string>
```

## Зачем это нужно

Функция существует, чтобы преобразовать ответ сервера в удобную структуру. Она принимает строку JSON и два набора, и возвращает `Map<string,string>`, скрывая от вызывающего кода детали разбора.

## Что делает

Единственный эффект функции — разбор JSON и валидация пар файл-слаг. Она не выполняет никаких других действий: не изменяет элементы, не сортирует и не обращается к внешним ресурсам.

## На что можно положиться

Функция возвращает новый `Map<string,string>`, содержащий только те пары, которые прошли валидацию. Она никогда не изменяет входные данные и не возвращает ссылку на них. Если входные данные пусты, возвращается пустой `Map`.

## От чего зависит

The function relies on the caller to supply the response object; it does not perform the network request.

## Кто и как использует

The caller calls this function with the response object and uses the returned `data` for further processing.

## Как менять и что проверять

The function enforces that the response object must contain an `assignments` array; if it is absent or invalid, it throws an error.
