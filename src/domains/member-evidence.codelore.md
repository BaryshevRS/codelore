# member-evidence.ts

## Зачем это нужно

The file exists to compute a stable fingerprint of a domain member's evidence, so that the doc's dependency facet and skeleton can be updated only when the member's membership or cross-domain edges change, avoiding unnecessary re-renders.

## На что можно положиться

The exported functions are pure and deterministic: [`collectDomainMemberEvidence`](#collectdomainmemberevidence) returns a new string without mutating the index or the section, and [`domainMemberFingerprint`](#domainmemberfingerprint) produces a stable hash string for identical evidence inputs. The fingerprint is computed over the string returned by [`collectDomainMemberEvidence`](#collectdomainmemberevidence), so equal evidence yields equal fingerprints.

## От чего зависит

The file defines [`collectDomainMemberEvidence`](#collectdomainmemberevidence) and [`domainMemberFingerprint`](#domainmemberfingerprint) as local helpers; the caller `src/markdown/block-ids.ts` imports [`domainMemberFingerprint`](#domainmemberfingerprint) to compute fingerprints for domain members.

# collectDomainMemberEvidence

```ts
collectDomainMemberEvidence(entity: CodeEntity, index: ProjectIndex): string
```

## Зачем это нужно

It exists to gather the evidence needed to compute a fingerprint for a domain member, so that the doc's dependency facet and skeleton can be updated only when the member's membership or cross-domain edges change.

## На что можно положиться

The function returns a string of concatenated dependency information. It does not mutate the index or the section.

## Кто и как использует

The function gathers evidence before computing the fingerprint.

## Как менять и что проверять

- The function enforces that only evidence present in the index is included, via the check `if (slug === undefined) { continue; }`.
- The function enforces that the purpose block is considered filled only when its body is non-empty, via the check `block.body.trim() !== ""`.

# domainMemberFingerprint

```ts
domainMemberFingerprint(evidence: string): string
```

## Зачем это нужно

It exists to produce a stable fingerprint of the evidence, so that the doc's dependency facet and skeleton can be updated only when the member's membership or cross-domain edges change.

## Что делает

Hashes the serialized evidence to produce a fingerprint. The fingerprint is stable for identical evidence inputs, and it does not mutate the evidence.

## На что можно положиться

The function returns a stable hash string for identical evidence inputs, and it does not mutate the evidence.

## Кто и как использует

The function is called by `src/markdown/block-ids.ts` to compute fingerprints for domain members.
