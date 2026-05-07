import { Box } from '@hermes/ink'
import { Fragment, memo, type ReactNode, useMemo } from 'react'

import { layoutWidgetGrid, type WidgetGridCell, type WidgetGridItem, widgetGridSpanWidth } from '../lib/widgetGrid.js'

export interface WidgetGridRenderContext {
  cell: WidgetGridCell
  width: number
}

type WidgetGridChildren = ((ctx: WidgetGridRenderContext) => ReactNode) | ReactNode

/**
 * A grid item with optional content. Use `children` for static or stateful
 * React subtrees (including a nested `WidgetGrid`) and `render` for a width-
 * aware factory; if both are provided, `render` wins.
 */
export interface WidgetGridWidget extends WidgetGridItem {
  children?: WidgetGridChildren
  render?: (width: number, cell: WidgetGridCell) => ReactNode
}

/**
 * `WidgetGrid` lays out children into rows/cols using the same primitives as
 * CSS grid: explicit `columns` count or a width-derived auto count, per-item
 * `colStart` / `colSpan`, and uniform `gap` / `rowGap`. Cells clip their
 * contents (`overflow: hidden`) so child overflow can never bleed into the
 * neighbouring cell or break the parent border.
 */
interface WidgetGridProps {
  columns?: number
  cols: number
  depth?: number
  gap?: number
  maxColumns?: number
  minColumnWidth?: number
  paddingX?: number
  paddingY?: number
  rowGap?: number
  widgets: WidgetGridWidget[]
}

const toInt = (value: number, fallback: number) => (Number.isFinite(value) ? Math.trunc(value) : fallback)

const inferredGap = (cols: number, columns: number | undefined, depth: number) => {
  if (cols < 36 || (columns ?? 0) >= 8) {
    return 0
  }

  if (depth > 0 || cols < 72 || (columns ?? 0) >= 4) {
    return 1
  }

  return 2
}

const inferredPaddingX = (cols: number, depth: number) => {
  if (depth <= 0 || cols < 24) {
    return 0
  }

  return cols >= 56 ? 2 : 1
}

const inferredRowGap = (depth: number) => (depth > 0 ? 0 : 1)

export const WidgetGrid = memo(function WidgetGrid({
  columns,
  cols,
  depth = 0,
  gap,
  maxColumns = 2,
  minColumnWidth = 46,
  paddingX,
  paddingY,
  rowGap,
  widgets
}: WidgetGridProps) {
  const safeCols = Math.max(1, toInt(cols, 1))
  const safePaddingX = Math.max(0, toInt(paddingX ?? inferredPaddingX(safeCols, depth), 0))
  const safePaddingY = Math.max(0, toInt(paddingY ?? 0, 0))
  const innerCols = Math.max(1, safeCols - safePaddingX * 2)
  const safeGap = Math.max(0, toInt(gap ?? inferredGap(innerCols, columns, depth), 0))
  const safeRowGap = Math.max(0, toInt(rowGap ?? inferredRowGap(depth), 0))

  const layout = useMemo(
    () =>
      layoutWidgetGrid({
        columns,
        gap: safeGap,
        items: widgets.map(({ colSpan, colStart, id, span }) => ({ colSpan, colStart, id, span })),
        maxColumns,
        minColumnWidth,
        width: innerCols
      }),
    [columns, innerCols, maxColumns, minColumnWidth, safeGap, widgets]
  )

  const widgetById = useMemo(() => new Map(widgets.map(widget => [widget.id, widget])), [widgets])

  if (!layout.rows.length) {
    return null
  }

  return (
    <Box flexDirection="column" paddingX={safePaddingX} paddingY={safePaddingY} width={safeCols}>
      {layout.rows.map((row, rowIdx) => (
        <Box flexDirection="column" key={`row-${rowIdx}`}>
          <Box flexDirection="row">
            <WidgetRow cells={row} columns={layout.columns} gap={safeGap} widgetById={widgetById} />
          </Box>

          {safeRowGap > 0 && rowIdx < layout.rows.length - 1 ? <Box height={safeRowGap} /> : null}
        </Box>
      ))}
    </Box>
  )
})

const WidgetRow = memo(function WidgetRow({
  cells,
  columns,
  gap,
  widgetById
}: {
  cells: WidgetGridCell[]
  columns: number[]
  gap: number
  widgetById: Map<string, WidgetGridWidget>
}) {
  return (
    <>
      {cells.map((cell, idx) => {
        const cursor = idx === 0 ? 0 : cells[idx - 1]!.col + cells[idx - 1]!.span

        const spacerWidth =
          cell.col === 0
            ? 0
            : cursor === 0
              ? widgetGridSpanWidth(columns, 0, cell.col, gap) + gap
              : gap + (cell.col > cursor ? widgetGridSpanWidth(columns, cursor, cell.col - cursor, gap) + gap : 0)

        return (
          <Fragment key={cell.id}>
            {spacerWidth > 0 ? <Box flexShrink={0} width={spacerWidth} /> : null}
            <WidgetCell cell={cell} widget={widgetById.get(cell.id)} />
          </Fragment>
        )
      })}
    </>
  )
})

const WidgetCell = memo(function WidgetCell({ cell, widget }: { cell: WidgetGridCell; widget?: WidgetGridWidget }) {
  const node =
    widget?.render?.(cell.width, cell) ??
    (typeof widget?.children === 'function' ? widget.children({ cell, width: cell.width }) : widget?.children) ??
    null

  return (
    <Box flexShrink={0} overflow="hidden" width={cell.width}>
      {node}
    </Box>
  )
})
