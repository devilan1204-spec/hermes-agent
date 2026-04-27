import { Box, Text, useInput, useStdout } from '@hermes/ink'
import { useEffect, useMemo, useState } from 'react'

import type { GatewayClient } from '../gatewayClient.js'
import { rpcErrorMessage } from '../lib/rpc.js'
import type { Theme } from '../theme.js'

import { OverlayHint, windowItems, windowOffset } from './overlayControls.js'

const EDGE_GUTTER = 10
const MAX_WIDTH = 132
const MIN_WIDTH = 64
const VISIBLE_ROWS = 10

const typeIcon: Record<string, string> = {
  integration: '◇',
  memory: '◆',
  recall: '↺',
  'skill-use': '✦',
  user: '●'
}

const typeVerb: Record<string, string> = {
  integration: 'connected',
  memory: 'remembered',
  recall: 'recalled',
  'skill-use': 'reused skill',
  user: 'remembered'
}

const fmtTime = (ts?: null | number) => {
  if (!ts) {
    return ''
  }

  const days = Math.floor((Date.now() - ts * 1000) / 86_400_000)

  return days <= 0 ? 'today' : `${days}d ago`
}

export function LearningLedger({ gw, onClose, t }: LearningLedgerProps) {
  const [ledger, setLedger] = useState<LearningLedgerResponse | null>(null)
  const [idx, setIdx] = useState(0)
  const [expanded, setExpanded] = useState(false)
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(true)
  const { stdout } = useStdout()
  const width = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, (stdout?.columns ?? 80) - EDGE_GUTTER))
  const columns = width >= 92 ? 2 : 1
  const pageSize = VISIBLE_ROWS * columns
  const colWidth = columns === 2 ? Math.floor((width - 3) / 2) : width

  useEffect(() => {
    gw.request<LearningLedgerResponse>('learning.ledger', { limit: 120 })
      .then(r => {
        setLedger(r)
        setErr('')
      })
      .catch((e: unknown) => setErr(rpcErrorMessage(e)))
      .finally(() => setLoading(false))
  }, [gw])

  const items = ledger?.items ?? []
  const selected = items[idx]
  const counts = useMemo(
    () =>
      Object.entries(ledger?.counts ?? {})
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}:${v}`)
        .join(' · '),
    [ledger?.counts]
  )

  useInput((ch, key) => {
    if (key.escape || ch.toLowerCase() === 'q') {
      onClose()

      return
    }

    if (key.leftArrow && columns === 2 && idx > 0) {
      setIdx(v => v - 1)

      return
    }

    if (key.rightArrow && columns === 2 && idx < items.length - 1) {
      setIdx(v => v + 1)

      return
    }

    if (key.upArrow && idx > 0) {
      setIdx(v => Math.max(0, v - columns))

      return
    }

    if (key.downArrow && idx < items.length - 1) {
      setIdx(v => Math.min(items.length - 1, v + columns))

      return
    }

    if (key.return || ch === ' ') {
      setExpanded(v => !v)

      return
    }

    const n = ch === '0' ? 10 : parseInt(ch, 10)
    if (!Number.isNaN(n) && n >= 1 && n <= Math.min(10, items.length)) {
      const next = windowOffset(items.length, idx, pageSize) + n - 1

      if (items[next]) {
        setIdx(next)
      }
    }
  })

  if (loading) {
    return <Text color={t.color.dim}>indexing learning ledger…</Text>
  }

  if (err) {
    return (
      <Box flexDirection="column" width={width}>
        <Text color={t.color.label}>learning ledger error: {err}</Text>
        <OverlayHint t={t}>Esc/q close</OverlayHint>
      </Box>
    )
  }

  if (!items.length) {
    return (
      <Box flexDirection="column" width={width}>
        <Text bold color={t.color.amber}>
          Recent Learning
        </Text>
        <Text color={t.color.dim}>no memories, recalls, used skills, or integrations found yet</Text>
        {ledger?.inventory?.skills ? (
          <Text color={t.color.dim}>available knowledge: {ledger.inventory.skills} installed skills</Text>
        ) : null}
        <OverlayHint t={t}>Esc/q close</OverlayHint>
      </Box>
    )
  }

  const { items: visible, offset } = windowItems(items, idx, pageSize)
  const rows = Array.from({ length: Math.ceil(visible.length / columns) }, (_, row) =>
    visible.slice(row * columns, row * columns + columns)
  )

  return (
    <Box flexDirection="column" width={width}>
      <Text bold color={t.color.amber}>
        Recent Learning
      </Text>
      <Text color={t.color.dim}>
        {ledger?.total ?? items.length} traces{counts ? ` · ${counts}` : ''}
      </Text>
      {ledger?.inventory?.skills ? (
        <Text color={t.color.dim}>available knowledge: {ledger.inventory.skills} installed skills</Text>
      ) : null}
      {offset > 0 && <Text color={t.color.dim}> ↑ {offset} more</Text>}

      {rows.map((row, rowIdx) => (
        <Box flexDirection="row" gap={1} key={rowIdx} width={width}>
          {row.map((item, colIdx) => {
            const visibleIdx = rowIdx * columns + colIdx
            const absolute = offset + visibleIdx
            const active = absolute === idx

            return (
              <LedgerRow
                active={active}
                index={visibleIdx + 1}
                item={item}
                key={`${item.type}:${item.name}:${visibleIdx}`}
                t={t}
                width={colWidth}
              />
            )
          })}
        </Box>
      ))}

      {offset + pageSize < items.length && <Text color={t.color.dim}> ↓ {items.length - offset - pageSize} more</Text>}

      {selected && expanded ? (
        <Box borderColor={t.color.dim} borderStyle="single" flexDirection="column" marginTop={1} paddingX={1}>
          <Text color={t.color.gold}>
            {selected.type === 'memory' || selected.type === 'user' ? selected.name : selected.summary}
          </Text>
          {selected.type === 'memory' || selected.type === 'user' ? (
            <Text color={t.color.cornsilk}>{selected.summary}</Text>
          ) : null}
          <Text color={t.color.dim}>source: {selected.source}</Text>
        </Box>
      ) : null}

      <OverlayHint t={t}>
        {`${columns === 2 ? '↑↓←→ select' : '↑/↓ select'} · Enter/Space details · 1-9,0 quick · Esc/q close`}
      </OverlayHint>
    </Box>
  )
}

function LedgerRow({ active, index, item, t, width }: LedgerRowProps) {
  const when = fmtTime(item.last_used_at ?? item.learned_at)
  const count = item.count ? ` ×${item.count}` : ''
  const icon = typeIcon[item.type] ?? '•'
  const verb = typeVerb[item.type] ?? item.type
  const title = item.type === 'memory' || item.type === 'user' ? item.summary : item.name

  return (
    <Box width={width}>
      <Text bold={active} color={active ? t.color.amber : t.color.dim} inverse={active} wrap="truncate-end">
        {active ? '▸ ' : '  '}
        {index}. {icon} {verb}: {title}
        <Text color={active ? t.color.amber : t.color.dim}>
          {' '}
          {count}
          {when ? ` · ${when}` : ''}
        </Text>
      </Text>
    </Box>
  )
}

interface LearningLedgerItem {
  count?: number
  last_used_at?: null | number
  learned_at?: null | number
  name: string
  source: string
  summary: string
  type: string
}

interface LearningLedgerResponse {
  counts?: Record<string, number>
  generated_at?: number
  home?: string
  inventory?: { skills?: number }
  items?: LearningLedgerItem[]
  total?: number
}

interface LedgerRowProps {
  active: boolean
  index: number
  item: LearningLedgerItem
  t: Theme
  width: number
}

interface LearningLedgerProps {
  gw: GatewayClient
  onClose: () => void
  t: Theme
}
