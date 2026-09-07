# completeAndParse

## Зачем это нужно

Обеспечивает устойчивость вызова LLM к невалидному JSON в ответе: повторяет запрос с обратной связью, пока парсинг не удастся или не кончатся попытки.

## Что делает

- При ошибке провайдера, не являющейся `INVALID_LLM_RESPONSE`, или при превышении лимита ретраев, выполняется запись отладки, затем ошибка пробрасывается.
- При ошибке парсинга, не являющейся `INVALID_LLM_RESPONSE`, или при превышении лимита ретраев, выполняется запись отладки, затем ошибка пробрасывается.
- Не модифицирует исходный `args.request` — создаёт новый объект с добавленными сообщениями при ретрае.
- Записывает отладочную информацию через `args.writeDebug` при ошибках, которые не являются `INVALID_LLM_RESPONSE` или при превышении лимита ретраев; собственные ошибки `writeDebug` не обрабатываются.

## На что можно положиться

- Количество итераций цикла не превышает `args.maxRetries + 1`.
- При ошибке провайдера, не являющейся `INVALID_LLM_RESPONSE`, или при превышении лимита ретраев функция завершается исключением.
- После каждого успешного вызова `args.provider.complete` (независимо от исхода парсинга) в `args.llmStages[args.stageName]` сохраняется пара запрос-ответ.

## От чего зависит

Зависит от локальных хелперов `isInvalidLlmResponse`, `errorForDebug`, `appendParseRetryFeedback`, и типов из `./provider.js` (`ChatCompletionInput`, `ChatCompletionProvider`, `ChatCompletionResult`, `ChatMessage`).

## Кто и как использует

Вызывается из [`verifyChunkFacts`](file-pipeline.codelore.md#verifychunkfacts) (`src/llm/file-pipeline.ts`):
1. Для двух этапов — верификации (`stageName: \`verification${stageSuffix}\``) и исправления нарушений (`stageName: \`factRepair${stageSuffix}\``).
2. В обоих вызовах передаётся единый `maxRetries` из аргументов [`verifyChunkFacts`](file-pipeline.codelore.md#verifychunkfacts), `debugSink.writeError` в качестве `writeDebug`, и соответствующая пара `requestErrorStage` / `parseErrorStage` (`verification_request` / `verification_parse` для верификации, `repair_request` / `repair_parse` для repair).

## Чего не делает

– Повторные попытки выполняются только при ошибке `INVALID_LLM_RESPONSE`; любая другая ошибка провайдера или парсинга приводит к немедленному вызову `writeDebug` и пробросу исключения, что зафиксировано в проверке `isInvalidLlmResponse(error)`.
– Не используется экспоненциальная задержка между ретраями — повторный запрос отправляется сразу, что определяется отсутствием `await delay(...)` в теле цикла.
– Если `args.writeDebug` выбрасывает исключение, оно не обрабатывается внутри `completeAndParse` и распространяется наружу, так как вызов `writeDebug` не обёрнут в `try/catch`.
– Количество ретраев фиксировано параметром `maxRetries`: цикл выполняется `maxRetries + 1` раз (условие `attempt <= args.maxRetries`).

## Как менять и что проверять

– Текущий код считает только ошибки с кодом `INVALID_LLM_RESPONSE` пригодными для ретрая; это условие зафиксировано в строке `if (attempt < args.maxRetries && isInvalidLlmResponse(error))`; соответствующий тест — `src/llm/complete-and-parse.test.ts` (если существует).
– После каждого успешного вызова `args.provider.complete` в `args.llmStages[args.stageName]` сохраняется объект, содержащий текущий запрос и ответ; это запись выполняется независимо от исхода парсинга, что зафиксировано в двух местах: после успешного парсинга (`args.llmStages[args.stageName] = stage; return parsed;`) и при ошибке парсинга до ретрая (`args.llmStages[args.stageName] = stage;`).
