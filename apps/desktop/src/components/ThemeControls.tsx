/**
 * Leva-driven palette fine-tuning, dev-mode only.
 *
 * Two folders (`Theme / Light` and `Theme / Dark`) expose color pickers
 * for the most-tweaked surface tokens of the *active* skin. Edits write
 * CSS variables directly — they're live-only and do not persist or feed
 * back into the theme resolver.
 */

import { button, useControls } from 'leva'
import { useMemo } from 'react'

import { getBaseColors, useTheme } from '@/themes/context'
import type { DesktopThemeColors } from '@/themes/types'

/** Curated subset of tokens that materially change the app's look. */
const FIELDS: Array<[keyof DesktopThemeColors, string]> = [
  ['background', 'background'],
  ['foreground', 'foreground'],
  ['card', 'card'],
  ['muted', 'muted'],
  ['mutedForeground', 'muted text'],
  ['primary', 'primary'],
  ['primaryForeground', 'primary text'],
  ['secondary', 'secondary'],
  ['accent', 'accent'],
  ['border', 'border'],
  ['ring', 'ring'],
  ['midground', 'midground'],
  ['composerRing', 'composer ring'],
  ['sidebarBackground', 'sidebar bg'],
  ['userBubble', 'user bubble']
]

const CSS_VARS: Record<keyof DesktopThemeColors, string> = {
  background: '--dt-background',
  foreground: '--dt-foreground',
  card: '--dt-card',
  cardForeground: '--dt-card-foreground',
  muted: '--dt-muted',
  mutedForeground: '--dt-muted-foreground',
  popover: '--dt-popover',
  popoverForeground: '--dt-popover-foreground',
  primary: '--dt-primary',
  primaryForeground: '--dt-primary-foreground',
  secondary: '--dt-secondary',
  secondaryForeground: '--dt-secondary-foreground',
  accent: '--dt-accent',
  accentForeground: '--dt-accent-foreground',
  border: '--dt-border',
  input: '--dt-input',
  ring: '--dt-ring',
  midground: '--dt-midground',
  midgroundForeground: '--dt-midground-foreground',
  composerRing: '--dt-composer-ring',
  destructive: '--dt-destructive',
  destructiveForeground: '--dt-destructive-foreground',
  sidebarBackground: '--dt-sidebar-bg',
  sidebarBorder: '--dt-sidebar-border',
  userBubble: '--dt-user-bubble',
  userBubbleBorder: '--dt-user-bubble-border'
}

const HEX_RE = /^#[0-9a-f]{6}$/i

// Leva's color picker only renders concrete `#rrggbb` values; non-hex seeds
// (e.g. color-mix(...)) fall back to a dark grey so the swatch is clickable.
const swatch = (value: string | undefined) =>
  typeof value === 'string' && HEX_RE.test(value.trim()) ? value : '#444444'

const setVar = (key: keyof DesktopThemeColors, value: string) =>
  document.documentElement.style.setProperty(CSS_VARS[key], value)

function buildSchema(skinName: string, mode: 'light' | 'dark') {
  const base = getBaseColors(skinName, mode)
  const entries: Record<string, unknown> = {}

  for (const [key, label] of FIELDS) {
    entries[key] = {
      value: swatch(base[key]),
      label,
      transient: false,
      onChange: (value: string, _path: string, ctx: { initial: boolean }) => {
        if (!ctx.initial) {
          setVar(key, value)
        }
      }
    }
  }

  entries['reset live edits'] = button(() => {
    for (const [key] of FIELDS) {
      const v = base[key]

      if (typeof v === 'string') {
        setVar(key, v)
      }
    }
  })

  return entries as Parameters<typeof useControls>[1]
}

/** Renders nothing — Leva's UI is a portal driven by `useControls`. */
export function ThemeControls() {
  const { themeName } = useTheme()
  const light = useMemo(() => buildSchema(themeName, 'light'), [themeName])
  const dark = useMemo(() => buildSchema(themeName, 'dark'), [themeName])

  useControls('Theme / Light', light, { collapsed: true }, [themeName])
  useControls('Theme / Dark', dark, { collapsed: true }, [themeName])

  return null
}
