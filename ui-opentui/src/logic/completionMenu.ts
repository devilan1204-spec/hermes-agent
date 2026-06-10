/**
 * Completion-menu key routing (Epic 8) — the pure decision table for the
 * composer's completions dropdown, kept out of the view so the precedence
 * rules are unit-testable.
 *
 * Precedence (the hard part):
 *   - Tab accepts the highlighted item and Esc dismisses whenever ANY menu is
 *     open (slash-command OR path/@-mention) — the pre-Epic-8 semantics.
 *   - Up/Down move the highlight (wrapping) and Enter accepts it ONLY for the
 *     SLASH menu (the composer's first token starts with `/`). On a path menu
 *     — or with a Ctrl/Alt-modified key — they `pass`, keeping their existing
 *     meanings (prompt history, cursor moves, textarea submit).
 *   - A closed menu (`count === 0`) always passes.
 *
 * The caller owns the side effects: `move` updates the selection signal,
 * `accept` splices the item into the composer (then arg-completion continues
 * as before), `dismiss` clears the candidates, `pass` falls through to the
 * history/cursor handling.
 */

/** Max dropdown rows shown (the view slices candidates to this). */
export const MENU_MAX = 8

export interface MenuKeyContext {
  /** Number of VISIBLE candidates (already capped at MENU_MAX). */
  count: number
  /** The currently highlighted row. */
  selected: number
  /** Whether this is the slash-command menu (composer text starts with `/`). */
  slashMenu: boolean
}

export type MenuKeyAction =
  | { kind: 'move'; selected: number }
  | { kind: 'accept'; index: number }
  | { kind: 'dismiss' }
  | { kind: 'pass' }

const PASS: MenuKeyAction = { kind: 'pass' }

/** Clamp the selection into the visible range (a shrunken list can strand it). */
function clampSelected(ctx: MenuKeyContext): number {
  return Math.min(Math.max(0, ctx.selected), ctx.count - 1)
}

/**
 * Route one key press against the open menu. `modified` is Ctrl/Alt/Option —
 * modified arrows/Enter never belong to the menu (Tab/Esc keep their
 * pre-existing modifier-blind accept/dismiss semantics).
 */
export function routeMenuKey(name: string, modified: boolean, ctx: MenuKeyContext): MenuKeyAction {
  if (ctx.count <= 0) return PASS
  if (name === 'tab') return { index: clampSelected(ctx), kind: 'accept' }
  if (name === 'escape') return { kind: 'dismiss' }
  if (modified || !ctx.slashMenu) return PASS
  const sel = clampSelected(ctx)
  if (name === 'up') return { kind: 'move', selected: (sel - 1 + ctx.count) % ctx.count }
  if (name === 'down') return { kind: 'move', selected: (sel + 1) % ctx.count }
  if (name === 'return') return { index: sel, kind: 'accept' }
  return PASS
}
