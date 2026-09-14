# generateFileGroup

```ts
generateFileGroup(input: FileGenerationInput): Promise<FileGenerationOutcome>
```

## Зачем это нужно

Точка входа для LLM-генерации документации группы файлов: загружает контекст, разбивает на чанки, выполняет запросы с валидацией и ремонтом, собирает результат.

## Что делает

- Загружает контекст каждой секции (документацию, контекст сервиса, исходный код файлов) и документацию зависимостей группы, если фаза не `propagating`.
- Разбивает секции на чанки через [`planWriterChunks`](file-chunks.codelore.md#planwriterchunks), учитывая бюджет провайдера и накладные расходы, и обрабатывает каждый чанк параллельно через `generateChunk`.
- Объединяет результаты чанков: последующие чанки перезаписывают одноимённые блоки (через `mergeRepairedBlocks`).
- Собирает итоговый `FileGenerationOutcome` (список перезаписей, записанных секций, сохранённых блоков и секций для ревью) и записывает отладочную информацию; не сохраняет результат на диск.

## На что можно положиться

- Возвращает пустой `FileGenerationOutcome` (через `emptyOutcome`), если после фильтрации по фазе не осталось ни одной секции с целевыми блоками.
- Результаты параллельной обработки чанков объединяются последовательно: для каждой секции блоки, сгенерированные в более позднем чанке, полностью заменяют одноимённые блоки из более ранних (через `mergeRepairedBlocks`).
- Отсутствующие в результате генерации блоки не заменяют существующие непустые блоки документации — они попадают в `keptBlocks` без изменений; секции, где все целевые блоки отсутствуют и существующие пусты, получают статус ревью (`reviewSections`).
- Функция никогда не выполняет запись документации на диск — возвращает только описание необходимых изменений (`FileGenerationOutcome`).

## От чего зависит

generateFileGroup использует resolveTerms для выбора терминов по языку, writeRequestOverheadChars для расчёта накладных расходов, planWriterChunks для разбиения секций на чанки и collectDependencyDocs для сбора документации зависимостей. Внешние зависимости: p-limit для ограничения конкуренции и readFile (node:fs/promises) для чтения исходных файлов. Генерация каждого чанка делегирована локальной функции generateChunk, которая выполняет запросы к LLM, валидацию и верификацию.

## Кто и как использует

Вызывается из [`CodeloreService.runPipelineForSections`](../service/codelore-service.codelore.md#runpipelineforsections) после того, как сервис собрал секции для группы файлов. Функция загружает исходный код файлов через `readFile`, получает контекст каждой секции через `service.getSectionContext`, фильтрует целевые блоки по фазе (`input.phase`), собирает документацию зависимостей (кроме фазы `propagating`), термины и контекст проекта. Затем разбивает секции на чанки вызовом [`planWriterChunks`](file-chunks.codelore.md#planwriterchunks) с учётом бюджета провайдера и обрабатывает каждый чанк параллельно через `generateChunk`, ограничивая конкурентность значением `service.config.llm.concurrency` через `pLimit`. Результаты чанков объединяются, формируется `FileGenerationOutcome`, и записывается отладочная информация через `debugSink`.

## Чего не делает

Если задан `input.phase`, генерируются только блоки указанной фазы (`propagating` или `terminal`); секции, у которых после фильтрации не остаётся целевых блоков, пропускаются. Это ограничение введено условием `const phaseBlocks = blockSetForPhase(input.phase);` и последующей фильтрацией `const targets = phaseBlocks ? context.targets.filter((block) => phaseBlocks.has(block)) : context.targets;`. Функция не может за один вызов сгенерировать блоки обеих фаз.

## Как менять и что проверять

- Сбор документации зависимостей выполняется только когда `input.phase !== 'propagating'` — условие `input.phase === 'propagating' ? [] : collectDependencyDocs(index, files)`.
- Параллельная обработка чанков ограничена конкурентностью: `pLimit(service.config.llm.concurrency)`.

# dependencyDocsFingerprint

```ts
dependencyDocsFingerprint(dependencyDocs: DependencyDoc[]): string
```

## Зачем это нужно

Вычисляет детерминированный SHA-256-хеш массива документации зависимостей для обнаружения изменений в контексте генерации.

## Что делает

- Принимает массив `DependencyDoc` и возвращает детерминированный SHA-256 хеш.
- Делегирует хеширование внешней функции [`sha256`](../utils/hash.codelore.md#sha256).
- Не выполняет I/O и не имеет побочных эффектов.
- Не валидирует входные данные — вызывающий гарантирует корректность.

## На что можно положиться

1. Функция чистая: не имеет побочных эффектов и не выполняет I/O.
2. Является синхронной (не async) — результат доступен сразу, без ожидания.
3. Для пустого массива возвращает SHA-256 от литерала `[]`.

## От чего зависит

Вычисляется как SHA-256 от всех документаций зависимостей.

## Кто и как использует

Используется для идентификации документации зависимостей группы, вероятно, для кэширования или проверки.

## Чего не делает

Результат зависит от порядка полей в `DependencyDoc` при `JSON.stringify` — изменение порядка (например, добавление нового поля) изменит хеш без изменения семантики. Каноническая сериализация не применяется, что может вызвать ложные срабатывания staleness.

# collectDependencyDocs

## Зачем это нужно

Собирает структурированную документацию прямых файловых зависимостей группы, ограниченную по размеру, для передачи в контекст LLM-генерации.

## Что делает

- Строит граф прямых зависимостей через [`buildFileDag`](../graph/file-dag.codelore.md#buildfiledag) и отбирает файлы, от которых зависят переданные `files`, исключая сами файлы группы.
- Для каждого файла-зависимости извлекает документацию только блоков `purpose`, `responsibility`, `invariants` (`PROPAGATING_BLOCKS`).
- Ограничивает общий размер: не более `DEP_DOCS_TOTAL_CAP` символов, на один файл не более `DEP_DOC_FILE_CAP`.
- Сортирует файлы по алфавиту для детерминизма.
- Не загружает исходный код — работает только с `index.docs.sections` и `index.code.entities`.

## На что можно положиться

1. Не включает файлы, уже входящие в группу `files` (самозависимости группы исключены).
2. Для каждого файла-зависимости извлекаются только блоки `purpose`, `responsibility`, `invariants` (`PROPAGATING_BLOCKS`).
3. Ограничивает общий размер возвращаемой документации: не более `DEP_DOCS_TOTAL_CAP` (15000) символов, на один файл не более `DEP_DOC_FILE_CAP` (2500) символов.

## От чего зависит

Основная внешняя зависимость — buildFileDag ([src/graph/file-dag.ts](../graph/file-dag.codelore.md#file-dagts)) для построения графа прямых зависимостей. Также использует константу PROPAGATING_BLOCKS и функцию dependencyDocForFile из этого же файла.

## Кто и как использует

Вызывается из generateFileGroup (при фазе не propagating) для обеспечения контекста генерации, а также из verifyBlocksAgainstDeps для верификации готовых блоков. Внутри: buildFileDag строит DAG, затем для каждого файла группы отбираются файлы-зависимости, исключая саму группу, и для них через dependencyDocForFile извлекаются блоки purpose, responsibility, invariants с ограничением размера DEP_DOC_FILE_CAP и DEP_DOCS_TOTAL_CAP.

## Чего не делает

Учитываются только прямые (не транзитивные) зависимости, так как DAG строится на одном уровне. Включаются только блоки purpose, responsibility, invariants (PROPAGATING_BLOCKS), остальные блоки не передаются LLM. Капы DEP_DOC_FILE_CAP (2500) и DEP_DOCS_TOTAL_CAP (15000) могут отсечь документацию глубоких или многочисленных зависимостей. Детерминизм обеспечивается лексикографической сортировкой файлов, но при достижении лимита DEP_DOCS_TOTAL_CAP часть файлов отбрасывается без учёта размера их документации.

## Как менять и что проверять

Два инварианта: 1. Размер документации одного файла-зависимости ограничен DEP_DOC_FILE_CAP (2500) — при превышении лишние блоки отбрасываются в цикле с проверкой used + block.body.length > DEP_DOC_FILE_CAP. 2. Общий размер документации зависимостей ограничен DEP_DOCS_TOTAL_CAP (15000) — при превышении цикл прерывается: if (totalChars + size > DEP_DOCS_TOTAL_CAP) break;. Тесты: не видны.

# compactChunkCallers

```ts
compactChunkCallers(sections: FileWriteSection[]): FileWriteSection[]
```

## Зачем это нужно

Уменьшает дублирование тел вызывающих функций между секциями одного чанка, отдавая приоритет вызывающим с runtimeEvidence.

## Что делает

- Не изменяет порядок секций — возвращает массив той же длины.
- Не удаляет вызывающих полностью — только их тела (поле body).
- Делегирует сортировку вызывающих: сначала с runtimeEvidence, затем без.
- Не проверяет корректность тел — только их длину.

## На что можно положиться

1. Не изменяет количество вызывающих в каждой секции — массив `callers` остаётся той же длины, меняется только наличие поля `body`.
2. Если вызывающий уже был отправлен с телом в предыдущей секции, его тело не дублируется в последующих (глобальный дедуплицирующий набор).
3. Приоритет при распределении бюджета `SECTION_CALLER_BODIES_CAP` имеют вызывающие с `runtimeEvidence` (сортируются первыми).

## Чего не делает

Бюджет `SECTION_CALLER_BODIES_CAP` (8000 символов) распределяется последовательно между вызывающими, отсортированными так, что вызывающие с `runtimeEvidence` получают приоритет: `const prioritized = [...section.callers].sort((left, right) => Number(right.runtimeEvidence !== undefined) - Number(left.runtimeEvidence !== undefined));`. Если бюджет исчерпан, тела оставшихся вызывающих (в первую очередь без `runtimeEvidence`) опускаются. Это может привести к потере тела важного статического вызывающего, если его длина превышает оставшийся бюджет.

# verifyChunkFacts

```ts
verifyChunkFacts(args: {
  sections: FileWriteSection[];
  result: FileWriteResult;
  sources: Array<{ path: string; source: string }>;
  code: CodeIndex;
  rootDir: string;
  /** Include imported type declarations in the verification context. */
  verifyTypeContext: boolean;
  dependencyDocs: DependencyDoc[];
  groupFiles: string[];
  provider: ChatCompletionProvider;
  /** Fact-check provider for verification/factRecheck; factRepair stays on `provider`. */
  verifyProvider?: ChatCompletionProvider;
  maxRetries: number;
  stageSuffix: string;
  llmStages: GenerationDebugLlmPipelineInput;
  debugSink: { writeError: (extra: { error?: GenerationDebugError }) => Promise<Record<string, string>> };
}): Promise<{ result: FileWriteResult; factViolations: DocViolation[]; remaining: DocViolation[] }>
```

## Зачем это нужно

Проверяет фактыческое содержание сгенерированных блоков документации: отправляет LLM исходный код и блоки, находит противоречия, запускает ремонт и повторную проверку, возвращает очищенный результат.

## Что делает

- Строит список секци для верификации вызовом [`buildVerifySections`](#buildverifysections): пропускает секции без сгенерированных блоков.
- Делегирует фактчек LLM (через `verifyCall`), парсит ответ и преобразует противоречия в нарушения.
- При наличии нарушени запускает ремонт через отдельный LLM-вызов (`factRepair`) с помощю [`buildRepairRequest`](#buildrepairrequest) и [`completeAndParse`](complete-and-parse.codelore.md#completeandparse), затем вливает исправленые блоки через `mergeRepairedBlocks`.
- Выполняет повторную верификацию (`factRecheck`) только для исправленных секций; окончательно удаляет блоки с оставшимися противоречиями через `dropViolatingBlocks`.

## На что можно положиться

- Если [`buildVerifySections`](#buildverifysections) не отбрал ни одной секции (все сгенерированние блоки пусты), функция сразу возвращает исходный `result` без изменений.
- Если LLM-верификация не находит ни одного противоречия, исходный результат также возвращается без изменений.
- Не исправленый ремонтом блок (отсутствующй в ответе модели) удаляется из результата до повторной проверки.
- Любой блок, на который повторная верификация выдала противоречия, полностью удаляется из итогового результата.
- Ремонт вседа использует `args.provider`, даже если для верификации задан отдельный `verifyProvider`.

## От чего зависит

Внешние зависимости: completeAndParse ([src/llm/complete-and-parse.ts](complete-and-parse.codelore.md)); buildVerifyRequest и parseVerifyResponse ([src/llm/doc-verifier.ts](doc-verifier.codelore.md)); parseFileWriteResponse ([src/llm/file-writer.ts](file-writer.codelore.md)); collectTypeContext ([src/llm/type-context.ts](type-context.codelore.md)).

## Чего не делает

Исходный код для верификации обрезается константами `VERIFY_SOURCE_CAP`, `VERIFY_HELPER_CONTEXT_CAP` и глубиной `VERIFY_HELPER_CONTEXT_DEPTH` (2). Это означает, что контекст вспомогательных функций ограничен двумя уровнями вызовов, а общий объём исходного кода и хелперов не превышает заданных лимитов. Детали реализации за пределами этих границ не попадают в промпт верификатору, что может скрыть релевантный код.

## Как менять и что проверять

- Если [`buildVerifySections`](#buildverifysections) не отобрала ни одной секции, функция сразу возвращает исходный результат: `if (verifySections.length === 0) return { result: args.result, factViolations: [], remaining: [] };`.
- Если верификация не нашла противоречий, результат возвращается без изменений: `if (claims.length === 0) return { result: args.result, factViolations: [], remaining: [] };`.

# buildVerifySections

```ts
buildVerifySections(sections: FileWriteSection[], result: FileWriteResult, sources: Array<{ path: string; source: string }>, code: CodeIndex): VerifySectionInput[]
```

## Зачем это нужно

Формирует массив секций для верификации, извлекая для каждой entity-специфичный исходный код с помощью `verificationSource`, который включает срез сущности, релевантные импорты и достижимые приватные хелперы в пределах одного файла.

## Что делает

- Не загружает файлы — использует переданные `sources` и `code.entities`.
- Делегирует сборку исходного кода `verificationSource`: извлекает срез сущности по `entity.range`, добавляет однофайловый контекст (импорты, приватные хелперы) с ограничением по `VERIFY_SOURCE_CAP` и глубине `VERIFY_HELPER_CONTEXT_DEPTH`.
- Пропускает секции, у которых нет сущности в `code.entities` или исходного файла в `sources`.
- Фильтрует блоки из `result`, оставляя только те, что имеют не-undefined значение.

## На что можно положиться

- Возвращает пустой массив, если ни одна секция не имеет блоков в `result`.
- Каждый элемент содержит `sectionId`, `entityId`, `source` (строка, сформированная `verificationSource`) и `blocks` (массив объектов с `blockId` и `text`).
- Поле `source` всегда включает срез тела сущности (без комментариев), а также может включать однофайловый контекст (импорты и приватные хелперы), если позволяет бюджет `VERIFY_SOURCE_CAP`.
- Порядок элементов соответствует порядку `sections` на входе.

## От чего зависит

Зависит от локального помощника `verificationSource`, который собирает исходный код для проверки из среза документации сущности и всегда включаемого файлового обзора.

## Кто и как использует

Вызывается конвейером проверки для подготовки секций к сверке фактов с документацией зависимостей; каждая секция получает свой исходный код для проверки.

## Чего не делает

Обрабатывает только те секции, для которых в карте кода существует сущность; секции без сущности пропускаются.

## Как менять и что проверять

- The verification source is composed from the documented entity slice plus an always-included file outline, enforced by the `composeVerifySource` helper.
- The verification source is composed from the documented entity slice plus an always-included file outline, enforced by the `composeVerifySource` helper.

# buildRepairRequest

```ts
buildRepairRequest(args: {
  sections: FileWriteSection[];
  result: FileWriteResult;
  violations: DocViolation[];
  refContext: { dependencyDocPaths: ReadonlySet<string>; groupFiles: string[] };
}): ChatCompletionInput
```

## Зачем это нужно

Формирует компактный запрос к LLM для исправления блоков документации, нарушивших детерминированную валидацию (недопустимые ссылки, превышение длины).

## Что делает

- Группирует нарушения по паре (sectionId, blockId) и включает в запрос текущее содержимое блока и массив нарушени.
- Вычисляет список разрешённых ссылок для секции через [`allowedRefsForSection`](doc-validator.codelore.md#allowedrefsforsection) и передаёт его как часть контекста запроса.
- Возвращает объект запроса с фиксированными инструкциями: модель должна тольку удалить или перефразировать утверждения из нарушени, не добавляя новых фактов.

## На что можно положиться

- Каждый блок в запросе снабжён полем `violations` — списком строковых описаний нарушени.
- Поле `allowedRefsBySection` держит отсортированые списки разрешённых ссылок для каждой секции, ключ — sectionId.
- Если секция или блок отсутствуют в `result`, они пропускаются (никакой пустой блок не отправляется).
- Ответная схема (`responseSchema`) строится тольку из тех пар (sectionId, blockId), которые попади в запрос.
- Возвращаемый `ChatCompletionInput` содержит ровно два сообщения: системное с запретом на добавление фактов и пользовательское с данными.

## От чего зависит

Использует [`allowedRefsForSection`](doc-validator.codelore.md#allowedrefsforsection) из `src/llm/doc-validator.ts` для вычисления разрешённых ссылок и `repairResponseSchema` из [`src/llm/file-writer.ts`](file-writer.codelore.md) для построения схемы ответа. Типы: `DocViolation` (из `src/llm/doc-validator.ts`), `FileWriteSection`, `FileWriteResult` (из `src/llm/file-writer.ts`), `ChatCompletionInput` (из [`src/llm/provider.ts`](provider.codelore.md)).

## Кто и как использует

Вызывается из [`verifyChunkFacts`](#verifychunkfacts) при обнаружении факт-противоречий. Функция группирует нарушения по паре `(sectionId, blockId)`, для каждой уникальной пары вычисляет разрешённые ссылки через [`allowedRefsForSection`](doc-validator.codelore.md#allowedrefsforsection) и формирует объект `ChatCompletionInput`. Системное сообщение запрещает добавление новых фактов: `"Do not add new facts: only remove or minimally rephrase the statements named in the violations, fix or drop offending refs, and shorten over-long text."`. Пользовательское сообщение содержит JSON с текущим содержимым блоков, списком нарушений и разрешёнными ссылками. Ответная схема строится только для затронутых пар `(sectionId, blockId)`.

## Чего не делает

Системное сообщение содержит инструкцию `"Do not add new facts: only remove or minimally rephrase the statements named in the violations, fix or drop offending refs, and shorten over-long text."`, что запрещает LLM добавлять новые утверждения. Это делает невозможным исправление блока, если корректное действие — заменить неверное утверждение на верное, а не удалить или перефразировать. Кроме того, условие `if (!section || !block) { continue; }` пропускает секции и блоки, отсутствующие в `result`, не позволяя их исправить.

## Как менять и что проверять

- Системное сообщение содержит фразу `"Do not add new facts: only remove or minimally rephrase the statements named in the violations, fix or drop offending refs, and shorten over-long text."` — изменение этого сообщения может разрешить добавление фактов, но рискует внести необоснованные утверждения.
- Условие `if (!section || !block) { continue; }` пропускает отсутствующие секции/блоки; удаление этого условия приведёт к отправке блоков с неопределёнными значениями.

# verifyBlocksAgainstDeps

## Зачем это нужно

Проверяет, что существующие тексты блоков не противоречат документации файловых зависимостей, и возвращает идентификаторы секций, прошедших проверку.

## Что делает

- Не изменяет блоки, не генерирует новые — только верифицирует уже существующие тексты на соответствие документации зависимостей.
- Для каждого файла с целевыми секциями загружает его исходный код с диска, собирает документацию файловых зависимостей через [`collectDependencyDocs`](#collectdependencydocs) и формирует `VerifySectionInput` с исходным кодом каждой сущности (через `verificationSource`, включающий helper-контекст).
- Передаёт LLM запрос через `provider.complete` с помощью [`buildVerifyRequest`](doc-verifier.codelore.md#buildverifyrequest) и извлекает противоречия через [`parseVerifyResponse`](doc-verifier.codelore.md#parseverifyresponse).
- Возвращает `Set<string>` идентификаторов секций, для которых не найдено противоречий; не указывает, какие блоки нарушены.

## На что можно положиться

- Для файла без зависимостей (пустой результат [`collectDependencyDocs`](#collectdependencydocs)) функция не выполняет LLM-запрос и не включает секции этого файла в возвращаемое множество.
- Порядок обработки файлов детерминирован: итерация по записям `Map`, сформированному из входного массива `targets`.
- Всегда возвращает `Set<string>` (не `null`, не `undefined`), даже если все секции отвергнуты.
- Загружает исходный код с диска при каждом вызове; ошибка чтения файла пробрасывается вызывающему.

## От чего зависит

Использует [`buildVerifyRequest`](doc-verifier.codelore.md#buildverifyrequest) и [`parseVerifyResponse`](doc-verifier.codelore.md#parseverifyresponse) из `src/llm/doc-verifier.ts`, [`collectDependencyDocs`](#collectdependencydocs), `verificationSource`, `sourceFileFromText`, `sameFileHelperContext`, `fileOutline`, `composeVerifySource` (все из этого файла), и [`CodeloreService`](../service/codelore-service.codelore.md#codeloreservice) из `src/service/codelore-service.ts`.

## Кто и как использует

Вызывается из `CodeloreService.gateDepDocsCascade` ([`src/service/codelore-service.ts`](../service/codelore-service.codelore.md)) с целями — секциями и их блоками, подлежащими верификации. Функция группирует цели по файлу их владельца, для каждого файла собирает документацию прямых зависимостей через [`collectDependencyDocs`](#collectdependencydocs). Если зависимости есть, загружает исходный код файла с диска (`readFile`), для каждой целевой секции формирует `VerifySectionInput` с исходным кодом сущности (через `verificationSource`, включающий helper-контекст) и передаёт запрос в LLM через [`buildVerifyRequest`](doc-verifier.codelore.md#buildverifyrequest) плюс `provider.complete`. Извлекает противоречия через [`parseVerifyResponse`](doc-verifier.codelore.md#parseverifyresponse). Возвращает множество идентификаторов секций, для которых не найдено противоречий.

## Чего не делает

Условие `if (dependencyDocs.length === 0) { continue; }` пропускает файлы без зависимостей, не выполняя для них LLM-верификацию, т.е. такая секция гарантированно не попадает в возвращаемое множество. Отсутствие ретраев: при ошибке LLM-запроса (`provider.complete`) ошибка пробрасывается без повторных попыток. Загрузка исходного кода с диска при каждом вызове через `const fileSource = await readFile(join(service.config.rootDir, file), "utf8")`; ошибка чтения файла пробрасывается вызывающему. Результат — только множество идентификаторов секций, а не конкретных блоков: функция не указывает, какие блоки какой секции нарушены.

## Как менять и что проверять

Два инварианта:
1. Условие `if (dependencyDocs.length === 0) { continue; }` — при его удалении функция будет вызывать LLM с пустым массивом зависимостей, что приведёт к лишним запросам, подтверждающим все блоки.
2. Вызов `readFile` с `join(service.config.rootDir, file)` пробрасывает ошибки чтения; при добавлении `try-catch` или замене на другой метод загрузки (например, кэширующий) изменится поведение при отсутствии файла.

Тесты: не видны.

# privateHelperDepIds

## Зачем это нужно

Создаёт синтетические идентификаторы для приватных хелперов, чтобы они проходили валидацию рефов, генерируя строки вида `symbol:путь#имя` для каждого хелпера, достижимого из данной сущности.

## Что делает

Делегирует поиск достижимых приватных хелперов в `reachablePrivateHelpers` и преобразует каждый результат в строку `symbol:${entity.path}#${helper.name}`.
Возвращает пустой массив, если у сущности нет приватных хелперов.

## На что можно положиться

Возвращаемый массив пуст, если у сущности нет достижимых приватных хелперов.
Каждый идентификатор уникален и имеет формат `symbol:${entity.path}#${helper.name}`.
Порядок элементов соответствует порядку обхода `reachablePrivateHelpers`.

## От чего зависит

Зависит от внутренних функций reachablePrivateHelpers и sourceFileFromText, определённых в этом же файле, для поиска приватных хелперов и создания SourceFile.

## Чего не делает

Возвращает пустой массив, если у сущности нет достижимых приватных хелперов; идентификаторы генерируются только для хелперов, достижимых через reachablePrivateHelpers с ограничением глубины VERIFY_HELPER_CONTEXT_DEPTH, что может не включить все приватные хелперы файла.
