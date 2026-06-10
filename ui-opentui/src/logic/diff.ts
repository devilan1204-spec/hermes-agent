/**
 * Pure unified-diff helpers for the file-tool renderer (Epic 2.3). No
 * OpenTUI/Solid imports — just string work, trivially unit-testable (like
 * `toolOutput.ts`). The gateway ships the FULL raw unified diff on file-edit
 * `tool.complete` (`diff_unified`); these helpers turn it into the collapsed
 * `+N −M` summary and per-file sections for the native `<diff>` renderable
 * (which parses only the FIRST file of a multi-file diff — so we split).
 */

/** Added/removed line counts for the collapsed header summary (`+N −M`). */
export interface DiffStats {
  added: number
  removed: number
}

/** Count changed lines in a unified diff, excluding the `+++`/`---` file headers. */
export function diffStats(diff: string): DiffStats {
  let added = 0
  let removed = 0
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue
    if (line.startsWith('+')) added++
    else if (line.startsWith('-')) removed++
  }
  return { added, removed }
}

/**
 * Path relative to the session cwd: exact prefix strip only (no `~` for home —
 * deliberately simple). Paths outside cwd come back unchanged; the cwd itself
 * becomes `.`. A trailing slash on cwd is tolerated.
 */
export function relativizePath(path: string, cwd?: string): string {
  if (!path || !cwd) return path
  const base = cwd.endsWith('/') && cwd !== '/' ? cwd.slice(0, -1) : cwd
  if (path === base) return '.'
  const prefix = base === '/' ? '/' : base + '/'
  if (path.startsWith(prefix)) return path.slice(prefix.length) || '.'
  return path
}

/** One file's section of a (possibly multi-file) unified diff. */
export interface DiffFileSection {
  /** Target path from the `+++ b/…` header (or `--- a/…` for deletions); '' if unknown. */
  path: string
  /** The section's unified diff text, parseable on its own. */
  diff: string
}

/** Extract the path from a `--- a/x` / `+++ b/x` header line ('' for /dev/null). */
function headerPath(line: string): string {
  let p = line.slice(4).trim()
  const tab = p.indexOf('\t') // difflib may append a date after a tab
  if (tab !== -1) p = p.slice(0, tab)
  if (!p || p === '/dev/null') return ''
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2)
  return p
}

function sectionPath(lines: string[]): string {
  const to = lines.find(l => l.startsWith('+++ '))
  const from = lines.find(l => l.startsWith('--- '))
  return (to ? headerPath(to) : '') || (from ? headerPath(from) : '')
}

/**
 * Split a unified diff into per-file sections (the gateway concatenates one
 * difflib diff per edited file; `patch`-mode diffs can also be multi-file). A
 * new section starts at a `--- ` header — required to be FOLLOWED by `+++ `
 * and to come after the current section's hunks, so removed lines that merely
 * start with `--` can't split a file in half.
 */
export function splitUnifiedDiff(diff: string): DiffFileSection[] {
  const lines = diff.replace(/\n$/, '').split('\n')
  const sections: string[][] = []
  let current: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (current.some(l => l.startsWith('@@')) && line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      sections.push(current)
      current = []
    }
    current.push(line)
  }
  if (current.length > 0) sections.push(current)
  return sections.filter(s => s.some(l => l.startsWith('@@'))).map(s => ({ diff: s.join('\n'), path: sectionPath(s) }))
}
