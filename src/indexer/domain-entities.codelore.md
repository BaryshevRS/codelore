# domain-entities.ts

## Зачем это нужно

Файл предоставляет набор функций и констант для работы с доменными сущностями индексатора, используемых другими модулями пакета.

## Что делает

Модуль содержит реализации функций isDomainTierEntity, isSourceCodeEntity, domainIdFor, buildDomainEntities, а также вспомогательные константы, такие как DOMAIN_ID_PREFIX и PROJECT_ID.

## На что можно положиться

Функции модуля не имеют побочных эффектов и гарантируют корректное формирование идентификаторов и проверку типов сущностей.

## От чего зависит

Функция использует fileToDomainSlug из domain-map.ts для перевода путей файлов в домены, buildDomainDag из domain-dag.ts для построения DAG зависимостей, sha256 из hash.ts для генерации идентификаторов, а также собственные неэкспортируемые помощники fileIdFor, synthFacets и synthMetadata для формирования идентификаторов и синтетических метаданных.

## Чего не делает

Файлы, не сопоставленные ни с одним доменом, не включаются ни в одну синтетическую сущность домена или проекта — функция просто пропускает их при группировке.

# isDomainTierEntity

```ts
isDomainTierEntity(entity: Pick<CodeEntity, "type">): boolean
```

## Зачем это нужно

Функция isDomainTierEntity принимает объект и возвращает true, если его свойство type равно 'domain' или 'project', и false в противном случае.

## Что делает

Функция isDomainTierEntity принимает объект и возвращает true, если его свойство type равно 'domain' или 'project', и false в противном случае.

## На что можно положиться

Функция isDomainTierEntity принимает объект и возвращает true, если его свойство type равно 'domain' или 'project', и false в противном случае.

## Кто и как использует

isDomainTierEntity возвращает true для сущностей с типом 'domain'.

# isSourceCodeEntity

```ts
isSourceCodeEntity(entity: Pick<CodeEntity, "type">): boolean
```

## Зачем это нужно

Функция isSourceCodeEntity принимает объект и возвращает true, если isDomainTierEntity(entity) возвращает false, то есть если тип сущности не 'domain' и не 'project'.

## Что делает

Функция isSourceCodeEntity принимает объект и возвращает true, если isDomainTierEntity(entity) возвращает false, то есть если тип сущности не 'domain' и не 'project'.

## На что можно положиться

Функция isSourceCodeEntity принимает объект и возвращает true, если isDomainTierEntity(entity) возвращает false, то есть если тип сущности не 'domain' и не 'project'.

## Кто и как использует

isSourceCodeEntity проверяет, является ли сущность исходным кодом.

# domainIdFor

```ts
domainIdFor(slug: string): string
```

## Зачем это нужно

Функция domainIdFor принимает строку slug и возвращает строку вида 'domain:' + slug, используя константу DOMAIN_ID_PREFIX.

## Что делает

Функция domainIdFor принимает строку slug и возвращает строку вида 'domain:' + slug, используя константу DOMAIN_ID_PREFIX.

## На что можно положиться

Функция domainIdFor принимает строку slug и возвращает строку вида 'domain:' + slug, используя константу DOMAIN_ID_PREFIX.

## От чего зависит

Функция возвращает строку вида `${DOMAIN_ID_PREFIX}${slug}`.

## Кто и как использует

buildDomainEntities вызывает domainIdFor для каждого домена, чтобы получить стабильный идентификатор для синтетической сущности.

# buildDomainEntities

```ts
buildDomainEntities(code: CodeIndex, map: DomainMap): Record<string, CodeEntity>
```

## Зачем это нужно

Функция buildDomainEntities принимает CodeIndex и DomainMap и возвращает объект, отображающий идентификаторы сущностей на объекты CodeEntity. Она создаёт синтетические сущности для каждого домена и проекта на основе данных индекса.

## Что делает

Функция buildDomainEntities принимает CodeIndex и DomainMap и возвращает объект, отображающий идентификаторы сущностей на объекты CodeEntity. Она создаёт синтетические сущности для каждого домена и проекта на основе данных индекса.

## На что можно положиться

Функция buildDomainEntities принимает CodeIndex и DomainMap и возвращает объект, отображающий идентификаторы сущностей на объекты CodeEntity. Она создаёт синтетические сущности для каждого домена и проекта на основе данных индекса.

## От чего зависит

Функция использует fileToDomainSlug из domain-map.ts для перевода путей файлов в домены, buildDomainDag из domain-dag.ts для построения DAG зависимостей, sha256 из hash.ts для генерации идентификаторов, а также собственные неэкспортируемые помощники fileIdFor, synthFacets и synthMetadata для формирования идентификаторов и синтетических метаданных.

## Кто и как использует

IndexManager.rebuild вызывает buildDomainEntities после построения кодового индекса и загрузки карты доменов, затем присваивает результат в code.entities, чтобы добавить синтетические сущности доменов и проектов в общий индекс.

## Чего не делает

Файлы, не сопоставленные ни с одним доменом, не включаются ни в одну синтетическую сущность домена или проекта — функция просто пропускает их при группировке.

## Как менять и что проверять

- Функция полагается на то, что buildDomainDag строит DAG на основе тех же доменов, что и buildDomainEntities; изменение набора доменов в одном месте потребует согласования с другим.
- IndexManager.rebuild вызывает buildDomainEntities и присваивает результат в code.entities; изменение возвращаемой структуры потребует обновления этого присваивания.
