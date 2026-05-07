import { Box, Text, useStdout } from '@hermes/ink'
import { useStore } from '@nanostores/react'
import { type ReactNode } from 'react'

import { $uiTheme } from '../app/uiStore.js'
import type { Theme } from '../theme.js'

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
  /** Faux scrim filling the viewport behind the content. */
  backdrop?: boolean
  backdropColor?: string
  children: ReactNode
  /** Nine CSS-grid-style zones. Defaults to `center`. */
  zone?: OverlayZone
}

/**
 * Viewport-level overlay primitive. Positions its child in one of nine zones
 * and optionally renders an opaque backdrop that obscures content behind it.
 * Uses stdout dims for deterministic placement regardless of tree depth.
 */
export function Overlay({ backdrop = false, backdropColor, children, zone = 'center' }: OverlayProps) {
  const { stdout } = useStdout()
  const theme = useStore($uiTheme)
  const cols = stdout?.columns ?? 80
  const rows = stdout?.rows ?? 24
  const [justify, align] = zoneFlex(zone)
  const bg = backdrop ? (backdropColor ?? scrim(theme)) : undefined

  return (
    <Box
      alignItems={align}
      backgroundColor={bg}
      flexDirection="row"
      height={rows}
      justifyContent={justify}
      left={0}
      opaque={backdrop}
      position="absolute"
      top={0}
      width={cols}
    >
      {children}
    </Box>
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

const scrim = (t: Theme) => t.color.completionBg ?? t.color.statusBg

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
