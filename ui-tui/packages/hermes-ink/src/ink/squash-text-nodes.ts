import type { DOMElement } from './dom.js'
import type { Styles, TextStyles } from './styles.js'

/**
 * A segment of text with its associated styles.
 * Used for structured rendering without ANSI string transforms.
 *
 * `copySourceFragment` is propagated from the deepest enclosing
 * `<ink-virtual-text>` (or `<ink-text>`) that carries one; this lets
 * the renderer attach per-segment source-byte ranges to the ink-text's
 * cached layout for the copy hit-test to use.
 */
export type StyledSegment = {
  text: string
  styles: TextStyles
  hyperlink?: string
  copySourceFragment?: Styles['copySourceFragment']
}

/**
 * Squash text nodes into styled segments, propagating styles (and the
 * per-segment `copySourceFragment` tag) down through the tree. Allows
 * structured styling without ANSI string transforms.
 *
 * Fragment inheritance: a child's fragment OVERRIDES its parent's. This
 * matches MdInline's behavior — nested formatting (e.g. bold containing
 * inline math) emits a single outer fragment for the bold-source span
 * AND inner fragments for the math-source span; the inner ones are what
 * the user sees and clicks, so they win.
 */
export function squashTextNodesToSegments(
  node: DOMElement,
  inheritedStyles: TextStyles = {},
  inheritedHyperlink?: string,
  inheritedFragment?: Styles['copySourceFragment'],
  out: StyledSegment[] = []
): StyledSegment[] {
  const mergedStyles = node.textStyles ? { ...inheritedStyles, ...node.textStyles } : inheritedStyles
  const ownFragment = (node.style as { copySourceFragment?: Styles['copySourceFragment'] }).copySourceFragment
  const effectiveFragment = ownFragment ?? inheritedFragment

  for (const childNode of node.childNodes) {
    if (childNode === undefined) {
      continue
    }

    if (childNode.nodeName === '#text') {
      if (childNode.nodeValue.length > 0) {
        out.push({
          text: childNode.nodeValue,
          styles: mergedStyles,
          hyperlink: inheritedHyperlink,
          ...(effectiveFragment && { copySourceFragment: effectiveFragment })
        })
      }
    } else if (childNode.nodeName === 'ink-text' || childNode.nodeName === 'ink-virtual-text') {
      squashTextNodesToSegments(childNode, mergedStyles, inheritedHyperlink, effectiveFragment, out)
    } else if (childNode.nodeName === 'ink-link') {
      const href = childNode.attributes['href'] as string | undefined
      squashTextNodesToSegments(childNode, mergedStyles, href || inheritedHyperlink, effectiveFragment, out)
    }
  }

  return out
}

/**
 * Squash text nodes into a plain string (without styles).
 * Used for text measurement in layout calculations.
 */
function squashTextNodes(node: DOMElement): string {
  let text = ''

  for (const childNode of node.childNodes) {
    if (childNode === undefined) {
      continue
    }

    if (childNode.nodeName === '#text') {
      text += childNode.nodeValue
    } else if (childNode.nodeName === 'ink-text' || childNode.nodeName === 'ink-virtual-text') {
      text += squashTextNodes(childNode)
    } else if (childNode.nodeName === 'ink-link') {
      text += squashTextNodes(childNode)
    }
  }

  return text
}

export default squashTextNodes
