export interface WidgetGridItem {
  colSpan?: number
  colStart?: number
  id: string
  span?: number
}

export interface WidgetGridCell {
  col: number
  id: string
  span: number
  width: number
}

export interface WidgetGridLayout {
  columnCount: number
  columns: number[]
  rows: WidgetGridCell[][]
}

export interface WidgetGridLayoutOptions {
  columns?: number
  gap?: number
  items: WidgetGridItem[]
  maxColumns?: number
  minColumnWidth?: number
  width: number
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))

const toInt = (value: number, fallback: number) => {
  if (!Number.isFinite(value)) {
    return fallback
  }

  return Math.trunc(value)
}

const columnCountForWidth = (width: number, minColumnWidth: number, gap: number, maxColumns: number) => {
  const safeWidth = Math.max(1, toInt(width, 1))
  const safeMinWidth = Math.max(1, toInt(minColumnWidth, 1))
  const safeGap = Math.max(0, toInt(gap, 0))
  const safeMaxColumns = Math.max(1, toInt(maxColumns, 1))
  const count = Math.floor((safeWidth + safeGap) / (safeMinWidth + safeGap))

  return clamp(count || 1, 1, safeMaxColumns)
}

const buildColumnWidths = (width: number, columnCount: number, gap: number) => {
  const safeWidth = Math.max(1, toInt(width, 1))
  const safeGap = Math.max(0, toInt(gap, 0))
  const slots = Math.max(1, toInt(columnCount, 1))
  const usable = Math.max(1, safeWidth - safeGap * Math.max(0, slots - 1))
  const base = Math.floor(usable / slots)
  const remainder = usable % slots

  return Array.from({ length: slots }, (_, idx) => base + (idx < remainder ? 1 : 0))
}

const spanWidth = (columns: number[], colStart: number, span: number, gap: number) => {
  const end = Math.min(columns.length, colStart + span)
  const width = columns.slice(colStart, end).reduce((acc, value) => acc + value, 0)
  const safeGap = Math.max(0, toInt(gap, 0))

  return width + safeGap * Math.max(0, end - colStart - 1)
}

export const widgetGridSpanWidth = spanWidth

const itemSpan = (item: WidgetGridItem, columnCount: number) =>
  clamp(toInt(item.colSpan ?? item.span ?? 1, 1), 1, columnCount)

const itemColStart = (item: WidgetGridItem, columnCount: number, span: number) => {
  if (item.colStart === undefined) {
    return null
  }

  return clamp(toInt(item.colStart, 0), 0, Math.max(0, columnCount - span))
}

const rangeIsFree = (occupied: boolean[], colStart: number, span: number) => {
  for (let col = colStart; col < colStart + span; col++) {
    if (occupied[col]) {
      return false
    }
  }

  return true
}

const occupyRange = (occupied: boolean[], colStart: number, span: number) => {
  for (let col = colStart; col < colStart + span; col++) {
    occupied[col] = true
  }
}

const firstFreeCol = (occupied: boolean[], span: number) => {
  for (let col = 0; col <= occupied.length - span; col++) {
    if (rangeIsFree(occupied, col, span)) {
      return col
    }
  }

  return null
}

const sortRow = (row: WidgetGridCell[]) => row.sort((a, b) => a.col - b.col)

export function layoutWidgetGrid({
  columns: requestedColumns,
  gap = 1,
  items,
  maxColumns = 3,
  minColumnWidth = 28,
  width
}: WidgetGridLayoutOptions): WidgetGridLayout {
  const safeGap = Math.max(0, toInt(gap, 1))
  const safeWidth = Math.max(1, toInt(width, 1))
  const maxDrawableColumns = safeGap > 0 ? Math.max(1, Math.floor((safeWidth + safeGap) / (safeGap + 1))) : safeWidth

  const columnCount =
    requestedColumns === undefined
      ? columnCountForWidth(safeWidth, minColumnWidth, safeGap, maxColumns)
      : clamp(toInt(requestedColumns, 1), 1, maxDrawableColumns)

  const columns = buildColumnWidths(width, columnCount, safeGap)
  const rows: WidgetGridCell[][] = []
  let row: WidgetGridCell[] = []
  let occupied = Array.from({ length: columnCount }, () => false)

  const pushRow = () => {
    rows.push(sortRow(row))
    row = []
    occupied = Array.from({ length: columnCount }, () => false)
  }

  for (const item of items) {
    const wantedSpan = itemSpan(item, columnCount)
    const explicitCol = itemColStart(item, columnCount, wantedSpan)
    let col = explicitCol ?? firstFreeCol(occupied, wantedSpan)

    if (col === null || (explicitCol !== null && !rangeIsFree(occupied, explicitCol, wantedSpan))) {
      if (row.length > 0) {
        pushRow()
      }

      col = explicitCol ?? 0
    }

    row.push({
      col,
      id: item.id,
      span: wantedSpan,
      width: spanWidth(columns, col, wantedSpan, safeGap)
    })

    occupyRange(occupied, col, wantedSpan)
  }

  if (row.length > 0) {
    rows.push(sortRow(row))
  }

  return { columnCount, columns, rows }
}
