import { Box, Text, useStdout } from '@hermes/ink'
import { useStore } from '@nanostores/react'
import { type ReactNode } from 'react'

import { $uiTheme } from '../app/uiStore.js'

export type OverlayZone =
  | 'bottom'
  | 'bottom-left'
  | 'bottom-right'
  | 'center'
  | 'left'
  | 'right'
  | 'top'
  | 'top-left'
  | 'top-right'

interface OverlayProps {
  /** Render a decorated character-fill scrim behind the content. */
  backdrop?: boolean
  /** Character used to paint the scrim. Defaults to `░` (light shade). */
  backdropChar?: string
  /** Foreground color of the scrim characters. */
  backdropColor?: string
  children: ReactNode
  /** Nine CSS-grid-style zones. Defaults to `center`. */
  zone?: OverlayZone
}

/**
 * Viewport-level overlay primitive. Positions its child in one of nine zones
 * and optionally paints a faux scrim behind it. Ink's `backgroundColor` only
 * paints cells with content, so the backdrop is rendered as an explicit
 * character grid (`░` by default) — like classic TUI dialogs. Uses stdout
 * dims so placement is deterministic regardless of tree depth.
 */
export function Overlay({
  backdrop = false,
  backdropChar = '░',
  backdropColor,
  children,
  zone = 'center'
}: OverlayProps) {
  const { stdout } = useStdout()
  const theme = useStore($uiTheme)
  const cols = stdout?.columns ?? 80
  const rows = stdout?.rows ?? 24
  const [justify, align] = zoneFlex(zone)
  const scrimColor = backdropColor ?? theme.color.border
  const scrimLine = backdropChar.repeat(cols)

  return (
    <>
      {backdrop && (
        <Box flexDirection="column" height={rows} left={0} position="absolute" top={0} width={cols}>
          {Array.from({ length: rows }, (_, i) => (
            <Text color={scrimColor} key={i}>
              {scrimLine}
            </Text>
          ))}
        </Box>
      )}

      <Box
        alignItems={align}
        flexDirection="row"
        height={rows}
        justifyContent={justify}
        left={0}
        position="absolute"
        top={0}
        width={cols}
      >
        {children}
      </Box>
    </>
  )
}

interface DialogProps {
  children: ReactNode
  hint?: ReactNode
  title?: string
  width?: number
}

/** Bordered card with optional title + hint. Pair with `Overlay` for centered modals. */
export function Dialog({ children, hint, title, width }: DialogProps) {
  const theme = useStore($uiTheme)
  const innerWidth = width !== undefined ? Math.max(1, width - 6) : undefined

  return (
    <Box
      borderColor={theme.color.primary}
      borderStyle="round"
      flexDirection="column"
      opaque
      paddingX={2}
      paddingY={1}
      width={width}
    >
      {title && (
        <Box justifyContent="center" marginBottom={1} width={innerWidth}>
          <Text bold color={theme.color.primary}>
            {title}
          </Text>
        </Box>
      )}

      {children}

      {hint && (
        <Box marginTop={1}>{typeof hint === 'string' ? <Text color={theme.color.muted}>{hint}</Text> : hint}</Box>
      )}
    </Box>
  )
}

const zoneFlex = (zone: OverlayZone): ['center' | 'flex-end' | 'flex-start', 'center' | 'flex-end' | 'flex-start'] => {
  const horizontal = {
    bottom: 'center',
    'bottom-left': 'flex-start',
    'bottom-right': 'flex-end',
    center: 'center',
    left: 'flex-start',
    right: 'flex-end',
    top: 'center',
    'top-left': 'flex-start',
    'top-right': 'flex-end'
  } as const

  const vertical = {
    bottom: 'flex-end',
    'bottom-left': 'flex-end',
    'bottom-right': 'flex-end',
    center: 'center',
    left: 'center',
    right: 'center',
    top: 'flex-start',
    'top-left': 'flex-start',
    'top-right': 'flex-start'
  } as const

  return [horizontal[zone], vertical[zone]]
}
