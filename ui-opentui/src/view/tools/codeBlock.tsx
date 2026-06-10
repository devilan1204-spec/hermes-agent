/**
 * CodeBlock — shared Tree-sitter-highlighted source block for tool bodies
 * (item 7): read_file output (filetype from the path extension), execute_code's
 * `code` argument (always Python), and write_file content when shown without a
 * diff. Uses the NATIVE `<code>` renderable (CodeRenderable) with the shared
 * theme-derived `syntaxStyleFor` — the same style instance as markdown text and
 * the file-tool `<diff>`, so highlighting is consistent across the transcript.
 *
 * Unknown filetype → `filetype` stays undefined and the renderable draws plain
 * text (`drawUnstyledText` keeps content visible even before/without a
 * grammar). `conceal` is OFF: tool bodies show SOURCE verbatim (concealment is
 * for prose markdown, not for a file the user asked to see). No height — like
 * the file-tool diff it sizes to content so it never scrolls internally
 * against the transcript's outer scrollbox. Headless caveat: highlighting
 * settles async; tests pin wiring/logic, visuals belong to the live smoke.
 */
import { useTheme } from '../theme.tsx'
import { syntaxStyleFor } from '../markdown.tsx'

export function CodeBlock(props: { content: string; filetype?: string | undefined }) {
  const theme = useTheme()
  return (
    <code
      content={props.content}
      // exactOptionalPropertyTypes: CodeOptions.filetype is `string`, so an
      // unknown filetype OMITS the prop entirely (plain-text fallback).
      {...(props.filetype !== undefined && { filetype: props.filetype })}
      syntaxStyle={syntaxStyleFor(theme())}
      conceal={false}
      drawUnstyledText
      wrapMode="word"
      width="100%"
      fg={theme().color.text}
      selectable
      selectionBg={theme().color.selectionBg}
    />
  )
}
