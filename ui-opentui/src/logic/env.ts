/**
 * env — shared boolean env-flag parsing (one source for the TRUE/FALSE regexes).
 *
 * Recognized truthy values: 1/true/yes/on; falsy: 0/false/no/off (case-insensitive,
 * surrounding whitespace trimmed). Anything else (incl. unset) is "unrecognized".
 */
export const TRUE_RE = /^(?:1|true|yes|on)$/i
export const FALSE_RE = /^(?:0|false|no|off)$/i

/** Parse a boolean env var; returns `fallback` when unset/unrecognized. */
export function envFlag(value: string | undefined, fallback: boolean): boolean {
  const v = value?.trim() ?? ''
  if (TRUE_RE.test(v)) return true
  if (FALSE_RE.test(v)) return false
  return fallback
}

/**
 * Parse `HERMES_TUI_TOOL_OUTPUT_LINES` (a TUI-only env var — deliberately NOT
 * a config.yaml knob): how many output lines an expanded tool body shows.
 * UNSET → Infinity (UNLIMITED — expanded tool output is uncapped by default;
 * setting the var is how you RESTORE a cap, e.g. `=200`). A positive integer
 * → that cap. `0` → Infinity too (back-compat: it was the old opt-in
 * "unlimited" value). Garbage → Infinity (unrecognized ≙ no cap asked for —
 * the semantic is "cap only when the user asked for one").
 */
export function envOutputLines(value: string | undefined): number {
  const v = value?.trim() ?? ''
  if (!/^\d+$/.test(v)) return Number.POSITIVE_INFINITY
  const n = Number.parseInt(v, 10)
  return n === 0 ? Number.POSITIVE_INFINITY : n
}

/**
 * Whether NO line cap applies (unset / `0` / unparseable). When unlimited,
 * the store prefers the always-full raw `result` over a gateway tail-capped
 * `result_text` — an "unlimited" view of a tail would still be missing its
 * head — see store.ts tool.complete. With an explicit finite cap the gateway
 * tail (+ honest omitted note) is kept: the user asked for a bounded view.
 */
export function envOutputUnlimited(value: string | undefined): boolean {
  return envOutputLines(value) === Number.POSITIVE_INFINITY
}
