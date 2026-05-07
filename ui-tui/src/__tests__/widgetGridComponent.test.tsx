import { PassThrough } from 'stream'

import { renderSync, Text } from '@hermes/ink'
import React, { useState } from 'react'
import { describe, expect, it } from 'vitest'

import { WidgetGrid, type WidgetGridWidget } from '../components/widgetGrid.js'
import { stripAnsi } from '../lib/text.js'

function StatefulCell({ label }: { label: string }) {
  const [value] = useState(label)

  return <Text>{value}</Text>
}

const renderGrid = (widgets: WidgetGridWidget[]) => {
  const stdout = new PassThrough()
  const stdin = new PassThrough()
  const stderr = new PassThrough()
  let output = ''

  Object.assign(stdout, { columns: 100, isTTY: false, rows: 24 })
  Object.assign(stdin, { isTTY: false })
  Object.assign(stderr, { isTTY: false })
  stdout.on('data', chunk => {
    output += chunk.toString()
  })

  const instance = renderSync(<WidgetGrid cols={80} columns={2} gap={1} paddingX={0} widgets={widgets} />, {
    patchConsole: false,
    stderr: stderr as NodeJS.WriteStream,
    stdin: stdin as NodeJS.ReadStream,
    stdout: stdout as NodeJS.WriteStream
  })

  instance.unmount()
  instance.cleanup()

  return stripAnsi(output)
}

describe('WidgetGrid component composition', () => {
  it('renders stateful direct children and nested grids inside cells', () => {
    const output = renderGrid([
      {
        children: <StatefulCell label="stateful-c1" />,
        id: 'stateful'
      },
      {
        children: (
          <WidgetGrid
            cols={38}
            columns={2}
            gap={1}
            paddingX={0}
            widgets={[
              { children: <StatefulCell label="nested-c1" />, id: 'nested-c1' },
              { render: () => <StatefulCell label="nested-c2" />, id: 'nested-c2' }
            ]}
          />
        ),
        id: 'nested-grid'
      }
    ])

    expect(output).toContain('stateful-c1')
    expect(output).toContain('nested-c1')
    expect(output).toContain('nested-c2')
  })
})
