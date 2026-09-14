# domain-map.ts

## Зачем это нужно

This file exists to translate file paths into domain identifiers and to determine which domains are covered by a set of files, so that downstream indexing can group entities by domain.

## Что делает

The file provides two pure functions.

## На что можно положиться

The file defines two pure functions that operate on domain metadata.

## Чего не делает

The file exposes no state, no side effects, and no error handling beyond what the functions themselves define.

# fileToDomainSlug

```ts
fileToDomainSlug(map: DomainMap): Map<string, string>
```

## Зачем это нужно

This function exists to map files to domain slugs, enabling grouping of files by their top-level directory.

## Что делает

The function takes a DomainMap and returns a Map<string, string> mapping files to domain slugs.

## На что можно положиться

The function maps files to domain slugs based on the domain entries.

# domainCoverage

```ts
domainCoverage(map: DomainMap, documentedFiles: Iterable<string>): DomainCoverage
```

## Зачем это нужно

This function exists to check file coverage within domains.

## Что делает

The function takes a DomainMap and an iterable of documented file paths, and returns a DomainCoverage object with properties uncovered, doubleAssigned, danglingFiles.

## На что можно положиться

The function returns a DomainCoverage object with three arrays: uncovered, doubleAssigned, danglingFiles.

## Кто и как использует

The indexer calls `domainCoverage` with the map of all files and the list of documented file leads; the returned `uncovered` array is then mapped to warning diagnostics with code `uncovered_file`.

## Чего не делает

The function only considers files that are explicitly passed in; it does not scan the filesystem, so any file not present in the `files` argument is ignored.

## Как менять и что проверять

- The function returns an object with an `uncovered` array of file paths that are not covered by any domain; the array is built by filtering the input `files` against the set of covered paths.
