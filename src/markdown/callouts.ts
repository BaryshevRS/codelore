// Localized callout strings for rendered docs, assembled from the per-language
// locale bundles. English is the fallback for any language without an entry.
import { localeBundle } from "./locales.js";

/** Stale blocks sharing one drift reason and timestamp, collapsed into a single callout. */
export interface StaleGroup {
  reason?: string;
  since: string;
  headings: string[];
}

function fill(template: string, values: Record<string, string>): string {
  return template.replace(/{(\w+)}/g, (_, key) => values[key] ?? "");
}

/** One callout naming every stale block in the group; `{reason}` carries its own trailing ", " or is empty. */
export function staleCalloutText(language: string | undefined, group: StaleGroup): string {
  const bundle = localeBundle(language);
  const reasonPhrase = group.reason ? (bundle.reasons[group.reason] ?? group.reason) : undefined;
  const body = fill(bundle.callouts.stale, {
    reason: reasonPhrase ? `${reasonPhrase}, ` : "",
    since: group.since,
    headings: group.headings.join(", "),
  });
  return `> ${body}`;
}

export function translationPendingCalloutText(language: string | undefined): string {
  return `> ${localeBundle(language).callouts.translationPending}`;
}
