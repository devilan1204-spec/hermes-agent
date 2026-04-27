import { Box, Text } from '@hermes/ink'
import type { ReactNode } from 'react'

import type { Theme } from '../theme.js'

const GAP = 2

export function OverlayGrid({ borderColor, footer, maxHeight, panels, t, width }: OverlayGridProps) {
  const visible = panels.filter(p => p.content)
  const innerWidth = Math.max(20, width - 4)
  const innerHeight = maxHeight ? Math.max(1, maxHeight - 2) : undefined
  const panelHeight = innerHeight ? Math.max(1, innerHeight - (footer ? 1 : 0)) : undefined
  const gapTotal = Math.max(0, visible.length - 1) * GAP
  const usable = Math.max(1, innerWidth - gapTotal)
  const growTotal = visible.reduce((sum, p) => sum + (p.grow ?? 1), 0) || 1
  let used = 0

  return (
    <Box
      alignSelf="flex-start"
      borderColor={borderColor}
      borderStyle="double"
      flexDirection="column"
      marginTop={1}
      opaque
      paddingX={1}
      width={width}
    >
      <Box flexDirection="row">
        {visible.map((panel, i) => {
          const last = i === visible.length - 1
          const panelWidth = last
            ? Math.max(1, usable - used)
            : Math.max(1, Math.floor((usable * (panel.grow ?? 1)) / growTotal))
          used += panelWidth

          return (
            <Box flexDirection="row" key={panel.id}>
              <Box flexDirection="column" flexShrink={0} width={panelWidth}>
                {panel.title ? (
                  <Text bold color={t.color.accent}>
                    {panel.title}
                  </Text>
                ) : null}
                <Box
                  flexDirection="column"
                  height={panelHeight ? Math.max(1, panelHeight - (panel.title ? 1 : 0) - (panel.footer ? 1 : 0)) : undefined}
                  overflow="hidden"
                >
                  {panel.content}
                </Box>
                {panel.footer ? <Box flexDirection="column">{panel.footer}</Box> : null}
              </Box>
              {!last ? <Box flexShrink={0} width={GAP} /> : null}
            </Box>
          )
        })}
      </Box>
      {footer ? <Box flexDirection="column">{footer}</Box> : null}
    </Box>
  )
}

export interface OverlayGridPanel {
  content: ReactNode
  footer?: ReactNode
  grow?: number
  id: string
  title?: string
}

interface OverlayGridProps {
  borderColor: string
  footer?: ReactNode
  maxHeight?: number
  panels: OverlayGridPanel[]
  t: Theme
  width: number
}
