import { Box, Text, useInput, useStdout } from '@hermes/ink'
import { useEffect, useState } from 'react'

import type { GatewayClient } from '../gatewayClient.js'
import type { SessionDeleteResponse, SessionListItem, SessionListResponse } from '../gatewayTypes.js'
import { asRpcResult, rpcErrorMessage } from '../lib/rpc.js'
import type { Theme } from '../theme.js'

import { OverlayHint, useOverlayKeys, windowOffset } from './overlayControls.js'
import { WidgetGrid, type WidgetGridWidget } from './widgetGrid.js'

const VISIBLE = 15
const MIN_WIDTH = 60
const MAX_WIDTH = 120

const age = (ts: number) => {
  const d = (Date.now() / 1000 - ts) / 86400

  if (d < 1) {
    return 'today'
  }

  if (d < 2) {
    return 'yesterday'
  }

  return `${Math.floor(d)}d ago`
}

export function SessionPicker({ gw, maxWidth, onCancel, onSelect, t }: SessionPickerProps) {
  const [items, setItems] = useState<SessionListItem[]>([])
  const [err, setErr] = useState('')
  const [sel, setSel] = useState(0)
  const [loading, setLoading] = useState(true)
  // When non-null, the user pressed `d` on this index and we're waiting for
  // a second `d`/`D` to confirm deletion.  Any other key cancels the prompt.
  const [confirmDelete, setConfirmDelete] = useState<null | number>(null)
  const [deleting, setDeleting] = useState(false)

  const { stdout } = useStdout()
  const terminalWidth = Math.max(1, (stdout?.columns ?? 80) - 6)
  const preferredWidth = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, terminalWidth))
  const widthCap = Math.max(24, Math.trunc(maxWidth ?? preferredWidth))
  const width = Math.max(24, Math.min(preferredWidth, widthCap))

  useOverlayKeys({ onClose: onCancel })

  useEffect(() => {
    gw.request<SessionListResponse>('session.list', { limit: 200 })
      .then(raw => {
        const r = asRpcResult<SessionListResponse>(raw)

        if (!r) {
          setErr('invalid response: session.list')
          setLoading(false)

          return
        }

        setItems(r.sessions ?? [])
        setErr('')
        setLoading(false)
      })
      .catch((e: unknown) => {
        setErr(rpcErrorMessage(e))
        setLoading(false)
      })
  }, [gw])

  const performDelete = (index: number) => {
    const target = items[index]

    if (!target || deleting) {
      return
    }

    setDeleting(true)
    gw.request<SessionDeleteResponse>('session.delete', { session_id: target.id })
      .then(raw => {
        const r = asRpcResult<SessionDeleteResponse>(raw)

        if (!r || r.deleted !== target.id) {
          setErr('invalid response: session.delete')
          setDeleting(false)

          return
        }

        setItems(prev => {
          const next = prev.filter((_, i) => i !== index)
          setSel(s => Math.max(0, Math.min(s, next.length - 1)))

          return next
        })
        setErr('')
        setDeleting(false)
      })
      .catch((e: unknown) => {
        setErr(rpcErrorMessage(e))
        setDeleting(false)
      })
  }

  useInput((ch, key) => {
    if (deleting) {
      return
    }

    if (confirmDelete !== null) {
      if (ch?.toLowerCase() === 'd') {
        const idx = confirmDelete
        setConfirmDelete(null)
        performDelete(idx)
      } else {
        setConfirmDelete(null)
      }

      return
    }

    if (key.upArrow && sel > 0) {
      setSel(s => s - 1)
    }

    if (key.downArrow && sel < items.length - 1) {
      setSel(s => s + 1)
    }

    if (key.return && items[sel]) {
      onSelect(items[sel]!.id)

      return
    }

    if (ch?.toLowerCase() === 'd' && items[sel]) {
      setConfirmDelete(sel)

      return
    }

    const n = parseInt(ch)

    if (n >= 1 && n <= Math.min(9, items.length)) {
      onSelect(items[n - 1]!.id)
    }
  })

  if (loading) {
    return <Text color={t.color.muted}>loading sessions…</Text>
  }

  if (err && !items.length) {
    return (
      <Box flexDirection="column">
        <Text color={t.color.label}>error: {err}</Text>
        <OverlayHint t={t}>Esc/q cancel</OverlayHint>
      </Box>
    )
  }

  if (!items.length) {
    return (
      <Box flexDirection="column">
        <Text color={t.color.muted}>no previous sessions</Text>
        <OverlayHint t={t}>Esc/q cancel</OverlayHint>
      </Box>
    )
  }

  const offset = windowOffset(items.length, sel, VISIBLE)
  const visible = items.slice(offset, offset + VISIBLE)

  const rowWidgets: WidgetGridWidget[] = visible.map((s, vi) => {
    const i = offset + vi
    const selected = sel === i
    const pendingDelete = confirmDelete === i
    const color = pendingDelete ? t.color.label : selected ? t.color.accent : t.color.muted
    const meta = `${s.message_count} msgs, ${age(s.started_at)}, ${s.source || 'tui'}`
    const title = pendingDelete ? 'press d again to delete' : s.title || s.preview || '(untitled)'

    return {
      id: s.id,
      render: () => (
        <Text bold={selected} color={color} inverse={selected} wrap="truncate-end">
          {selected ? '▸ ' : '  '}
          {String(i + 1).padStart(2)}. [{s.id}] ({meta}) {title}
        </Text>
      )
    }
  })

  return (
    <Box flexDirection="column" width={width}>
      <Text bold color={t.color.accent}>
        Resume Session
      </Text>

      {offset > 0 && <Text color={t.color.muted}> ↑ {offset} more</Text>}

      <WidgetGrid cols={width} columns={1} depth={1} gap={0} minColumnWidth={1} rowGap={0} widgets={rowWidgets} />

      {offset + VISIBLE < items.length && <Text color={t.color.muted}> ↓ {items.length - offset - VISIBLE} more</Text>}
      {err && <Text color={t.color.label}>error: {err}</Text>}
      {deleting ? (
        <OverlayHint t={t}>deleting…</OverlayHint>
      ) : (
        <OverlayHint t={t}>↑/↓ select · Enter resume · 1-9 quick · d delete · Esc/q cancel</OverlayHint>
      )}
    </Box>
  )
}

interface SessionPickerProps {
  gw: GatewayClient
  maxWidth?: number
  onCancel: () => void
  onSelect: (id: string) => void
  t: Theme
}
