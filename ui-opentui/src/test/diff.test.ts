/**
 * Unit tests for the pure diff helpers (Epic 2.3 — logic/diff.ts): `+N −M`
 * counting (file headers excluded, trailing newline optional), cwd-relative
 * paths (exact prefix strip only — no `~`), and per-file splitting of
 * multi-file unified diffs (the native DiffRenderable parses only the first
 * file, so the renderer feeds it one section at a time).
 */
import { describe, expect, test } from 'vitest'

import { diffStats, relativizePath, splitUnifiedDiff } from '../logic/diff.ts'

const ONE_FILE = ['--- a/src/main.ts', '+++ b/src/main.ts', '@@ -1,3 +1,4 @@', ' ctx', '-old', '+new', '+more'].join(
  '\n'
)

describe('diffStats', () => {
  test('counts added/removed lines, excluding the +++/--- file headers', () => {
    expect(diffStats(ONE_FILE + '\n')).toEqual({ added: 2, removed: 1 })
  })

  test('handles a diff without a trailing newline', () => {
    expect(diffStats(ONE_FILE)).toEqual({ added: 2, removed: 1 })
  })

  test('a multi-file diff counts headers of every file out', () => {
    const diff = `${ONE_FILE}\n--- a/b.py\n+++ b/b.py\n@@ -1 +1 @@\n-x\n+y\n`
    expect(diffStats(diff)).toEqual({ added: 3, removed: 2 })
  })

  test('empty diff → zero stats', () => {
    expect(diffStats('')).toEqual({ added: 0, removed: 0 })
  })
})

describe('relativizePath', () => {
  test.each([
    // inside cwd → relative
    ['/home/u/proj/src/main.ts', '/home/u/proj', 'src/main.ts'],
    // outside cwd → unchanged
    ['/etc/hosts', '/home/u/proj', '/etc/hosts'],
    // exactly the cwd → '.'
    ['/home/u/proj', '/home/u/proj', '.'],
    // trailing slash on cwd tolerated
    ['/home/u/proj/a.txt', '/home/u/proj/', 'a.txt'],
    // sibling dir sharing the prefix string is NOT inside cwd
    ['/home/u/proj2/a.txt', '/home/u/proj', '/home/u/proj2/a.txt'],
    // no cwd → unchanged (and already-relative paths pass through)
    ['src/main.ts', undefined, 'src/main.ts']
  ])('%s relative to %s → %s', (path, cwd, expected) => {
    expect(relativizePath(path, cwd)).toBe(expected)
  })
})

describe('splitUnifiedDiff', () => {
  test('single-file diff → one section with the b/ path stripped', () => {
    const sections = splitUnifiedDiff(ONE_FILE + '\n')
    expect(sections).toHaveLength(1)
    expect(sections[0]?.path).toBe('src/main.ts')
    expect(sections[0]?.diff).toBe(ONE_FILE)
  })

  test('multi-file diff splits at the next ---/+++ header pair', () => {
    const second = ['--- a/b.py', '+++ b/b.py', '@@ -1 +1 @@', '-x', '+y'].join('\n')
    const sections = splitUnifiedDiff(`${ONE_FILE}\n${second}\n`)
    expect(sections.map(s => s.path)).toEqual(['src/main.ts', 'b.py'])
    expect(sections[1]?.diff).toBe(second)
  })

  test('a removed line starting with --- does not split the file', () => {
    const tricky = ['--- a/x.md', '+++ b/x.md', '@@ -1,2 +1,1 @@', '--- a heading rule', ' kept'].join('\n')
    const sections = splitUnifiedDiff(tricky)
    expect(sections).toHaveLength(1)
  })

  test('new-file diff (--- /dev/null) takes the +++ path', () => {
    const created = ['--- /dev/null', '+++ b/new.txt', '@@ -0,0 +1 @@', '+hello'].join('\n')
    expect(splitUnifiedDiff(created)[0]?.path).toBe('new.txt')
  })
})
