# generateDomainDoc

```ts
generateDomainDoc(args: {
  input: BuildDomainWriteRequestInput;
  /** Concatenated member-doc prose — the ground truth the blocks are checked against. */
  memberEvidence: string;
  provider: ChatCompletionProvider;
  verifyProvider: ChatCompletionProvider;
}): Promise<DomainGenerationResult>
```

## Зачем это нужно

Generates a domain documentation for a single tier by writing blocks with retries, verifying them against member docs, and repairing contradicted blocks, returning the surviving blocks and the dropped ones.

## Что делает

Writes the domain blocks via `writeWithRetries` with a retry cap of `DOMAIN_WRITE_MAX_RETRIES`. Verifies the written blocks against member docs via `verifyBlocks`, which returns a list of contradicted claims (each with blockId, statement, evidence). Repairs the contradicted blocks via `repairContradictedBlocks`, which returns a partial blocks object; when contradicted blocks exist, the function merges the repaired blocks back into the original blocks object. Returns the final blocks object (with repaired blocks) and the list of dropped block IDs.

## От чего зависит

Depends on local helpers `writeWithRetries`, `verifyBlocks`, `repairContradictedBlocks`, `blockEntries`, `blockSubset`, and `currentBlocksForPrompt` from the same file.

## Кто и как использует

Called by `CodeloreService.generateDomainDocs` for each tier entity.

## Чего не делает

The function does not handle providers that emit trailing junk after the JSON response.

## Как менять и что проверять

- The retry cap is enforced by the constant `DOMAIN_WRITE_MAX_RETRIES` passed to `writeWithRetries`.
- The repair loop is bounded by the constant `MAX_REPAIR_ROUNDS` in `repairContradictedBlocks`.
