import { rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'

import React from 'react'

import { Box, render, Text } from '@hermes/ink'

import { Panel } from '../src/components/branding.js'
import { MessageLine } from '../src/components/messageLine.js'
import { DEFAULT_THEME } from '../src/theme.js'
import type { Theme } from '../src/theme.js'
import type { Msg } from '../src/types.js'

const showroomRoot = dirname(fileURLToPath(import.meta.url))

class Capture extends Writable {
  buffer = ''
  isTTY = true
  columns: number
  rows: number

  constructor(cols: number, rows: number) {
    super()
    this.columns = cols
    this.rows = rows
  }

  override _write(chunk: any, _encoding: any, callback: any) {
    this.buffer += chunk.toString()
    callback()
  }
}

const COLS = 80
const ROWS = 16
const t = DEFAULT_THEME

const snap = async (node: React.ReactElement, settle = 120): Promise<string> => {
  const stdout = new Capture(COLS, ROWS) as unknown as NodeJS.WriteStream
  const inst = await render(node, { stdout, exitOnCtrlC: false, patchConsole: false })

  await new Promise(resolve => setTimeout(resolve, settle))
  inst.unmount()

  return (stdout as unknown as Capture).buffer
}

const Msg = (msg: Msg) => <MessageLine cols={COLS} msg={msg} t={t} />

const ToolPanel = ({ items, title, theme }: { items: string[]; theme: Theme; title: string }) => (
  <Box flexDirection="column" marginLeft={2}>
    <Box>
      <Text color={theme.color.bronze}>⚡ </Text>
      <Text bold color={theme.color.amber}>
        {title}
      </Text>
      <Text color={theme.color.dim}>
        {' '}
        ({items.length})
      </Text>
    </Box>
    {items.map((item, i) => (
      <Box key={i}>
        <Text color={theme.color.bronze}>{i === items.length - 1 ? '└─ ' : '├─ '}</Text>
        <Text color={theme.color.dim}>{item}</Text>
      </Box>
    ))}
  </Box>
)

const Tree = ({ rows, theme }: { rows: { branch: 'mid' | 'last'; cols: string[]; tone?: 'amber' | 'dim' | 'gold' | 'ok' }[]; theme: Theme }) => (
  <Box flexDirection="column" marginLeft={2}>
    {rows.map((row, i) => {
      const stem = row.branch === 'last' ? '└─ ' : '├─ '
      const tone =
        row.tone === 'gold'
          ? theme.color.gold
          : row.tone === 'amber'
            ? theme.color.amber
            : row.tone === 'ok'
              ? theme.color.ok
              : theme.color.dim

      return (
        <Box key={i}>
          <Text color={theme.color.bronze}>{stem}</Text>
          <Text color={tone}>{row.cols.join('  ')}</Text>
        </Box>
      )
    })}
  </Box>
)

const writeWorkflow = (name: string, workflow: Record<string, unknown>) => {
  const out = join(showroomRoot, 'workflows', `${name}.json`)
  writeFileSync(out, JSON.stringify(workflow, null, 2))
  console.log(`  wrote ${out}`)
}

const featureTour = async () => {
  const userPrompt = await snap(
    <Msg role="user" text="Build a focused plan for a safer gateway approval flow." />
  )

  const assistantPlan = await snap(
    <Msg
      role="assistant"
      text="I'll trace the gateway guards first, then patch the smallest boundary that keeps approval commands live while an agent is blocked."
    />
  )

  const toolTrail = await snap(
    <ToolPanel
      items={[
        'rg "approval.request" gateway/ tui_gateway/',
        'ReadFile gateway/run.py',
        'ReadFile gateway/platforms/base.py'
      ]}
      theme={t}
      title="tool trail"
    />
  )

  const assistantResult = await snap(
    <Msg
      role="assistant"
      text="Found the split guard. Bypass both queues only for approval commands; normal chat ordering stays intact."
    />
  )

  return {
    composer: 'ask hermes anything',
    timeline: [
      { ansi: userPrompt, at: 200, id: 'user-row', type: 'frame' },
      { ansi: assistantPlan, at: 1500, id: 'assistant-plan', type: 'frame' },
      { ansi: toolTrail, at: 2900, id: 'tool-trail', type: 'frame' },
      { at: 3200, duration: 1700, target: 'tool-trail', type: 'spotlight' },
      {
        at: 3400,
        duration: 1700,
        position: 'right',
        target: 'tool-trail',
        text: 'Real ui-tui MessageLine + Panel rendered to ANSI and replayed in xterm.js.',
        type: 'caption'
      },
      { ansi: assistantResult, at: 5400, id: 'assistant-result', type: 'frame' },
      { at: 6100, duration: 1300, target: 'assistant-result', type: 'highlight' },
      {
        at: 6300,
        duration: 1700,
        position: 'right',
        target: 'assistant-result',
        text: 'Captions, spotlights, and fades layer on top of real ANSI. Best of both.',
        type: 'caption'
      },
      { at: 8100, duration: 600, text: '/approve', type: 'compose' }
    ],
    title: 'Hermes TUI · Feature Tour',
    viewport: { cols: COLS, rows: ROWS }
  }
}

const subagentTrail = async () => {
  const userPrompt = await snap(
    <Msg role="user" text="Run tests, lint, and a Railway preview deploy in parallel." />
  )

  const plan = await snap(
    <Msg
      role="assistant"
      text="Spawning three subagents on the fan-out lane and watching their tool counts."
    />
  )

  const live = await snap(
    <Tree
      rows={[
        { branch: 'mid', cols: ['tests   running   12 tools   ⏱ 14.2s'], tone: 'amber' },
        { branch: 'mid', cols: ['lint    running    4 tools   ⏱ 14.2s'], tone: 'amber' },
        { branch: 'last', cols: ['deploy  queued     0 tools   ⏱  0.0s'], tone: 'dim' }
      ]}
      theme={t}
    />
  )

  const hot = await snap(
    <Tree
      rows={[
        { branch: 'mid', cols: ['tests   complete  18 tools   ⏱ 22.7s   ✓'], tone: 'ok' },
        { branch: 'mid', cols: ['lint    complete   6 tools   ⏱ 18.1s   ✓'], tone: 'ok' },
        { branch: 'last', cols: ['deploy  running    9 tools   ⏱  9.4s'], tone: 'gold' }
      ]}
      theme={t}
    />
  )

  const summary = await snap(
    <Msg
      role="assistant"
      text="All three landed: 24 tests pass, lint clean, preview at https://pr-128.railway.app."
    />
  )

  return {
    composer: 'spawn the deploy fan-out',
    timeline: [
      { ansi: userPrompt, at: 200, id: 'ask', type: 'frame' },
      { ansi: plan, at: 1100, id: 'plan', type: 'frame' },
      { ansi: live, at: 2100, id: 'live', type: 'frame' },
      { at: 2300, duration: 1500, target: 'live', type: 'spotlight' },
      {
        at: 2500,
        duration: 1700,
        position: 'right',
        target: 'live',
        text: 'Each subagent gets its own depth and tool budget; the dashboard tracks them live.',
        type: 'caption'
      },
      { ansi: hot, at: 4400, id: 'hot', type: 'frame' },
      { at: 4600, duration: 1300, target: 'hot', type: 'highlight' },
      {
        at: 4800,
        duration: 1700,
        position: 'right',
        target: 'hot',
        text: 'Completed runs collapse, hot lanes stay vivid — the eye tracks the live agent.',
        type: 'caption'
      },
      { ansi: summary, at: 6800, id: 'summary', type: 'frame' },
      {
        at: 7000,
        duration: 1700,
        position: 'right',
        target: 'summary',
        text: 'Subagent results stream back into the parent transcript as a single highlight.',
        type: 'caption'
      },
      { at: 8800, duration: 600, text: '/agents', type: 'compose' }
    ],
    title: 'Hermes TUI · Subagent Trail',
    viewport: { cols: COLS, rows: ROWS }
  }
}

const slashCommands = async () => {
  const skillsResults = await snap(
    <Panel
      sections={[
        {
          rows: [
            ['anthropics/skills/frontend-design', '★ trusted'],
            ['openai/skills/skill-creator', '· official'],
            ['skills.sh/community/vibe-coding', '⚙ community']
          ]
        }
      ]}
      t={t}
      title="/skills search vibe"
    />,
    180
  )

  const modelSwitch = await snap(
    <Panel
      sections={[
        {
          rows: [
            ['from', 'gpt-5-codex'],
            ['to', 'claude-4.6-sonnet'],
            ['scope', 'this session']
          ]
        }
      ]}
      t={t}
      title="model switched"
    />,
    180
  )

  const agentsStatus = await snap(
    <Panel
      sections={[
        {
          rows: [
            ['delegation', 'paused'],
            ['max children', '4'],
            ['running tasks', 'queued for resume']
          ]
        }
      ]}
      t={t}
      title="/agents · paused"
    />,
    180
  )

  return {
    composer: 'press / to open the palette',
    timeline: [
      { at: 200, duration: 500, text: '/skills search vibe', type: 'compose' },
      { ansi: skillsResults, at: 800, id: 'skills', type: 'frame' },
      { at: 1100, duration: 1500, target: 'skills', type: 'spotlight' },
      {
        at: 1300,
        duration: 1700,
        position: 'right',
        target: 'skills',
        text: 'Slash commands stream live results without blocking the composer.',
        type: 'caption'
      },
      { at: 3300, duration: 600, text: '/model claude-4.6-sonnet', type: 'compose' },
      { ansi: modelSwitch, at: 4100, id: 'model', type: 'frame' },
      {
        at: 4400,
        duration: 1700,
        position: 'right',
        target: 'model',
        text: '/model also pops the inline picker when no arg is given.',
        type: 'caption'
      },
      { at: 6300, duration: 600, text: '/agents pause', type: 'compose' },
      { ansi: agentsStatus, at: 7000, id: 'agents', type: 'frame' },
      { at: 7300, duration: 1300, target: 'agents', type: 'highlight' },
      {
        at: 7500,
        duration: 1700,
        position: 'right',
        target: 'agents',
        text: 'Same registry powers TUI, gateway, Telegram, Discord — one source of truth.',
        type: 'caption'
      },
      { at: 9300, duration: 600, text: '/resume', type: 'compose' }
    ],
    title: 'Hermes TUI · Slash Commands',
    viewport: { cols: COLS, rows: ROWS }
  }
}

const voiceMode = async () => {
  const vad = await snap(
    <ToolPanel
      items={['▮ ▮▮ ▮ ▮▮▮▮ ▮▮ ▮▮▮▮▮▮ ▮▮▮ ▮', 'rms 0.42 · 1.6s captured', 'auto-stop · silence 380ms']}
      theme={t}
      title="VAD · capturing"
    />
  )

  const transcript = await snap(
    <Msg role="user" text="what's in my inbox today and what needs a reply before noon?" />
  )

  const answer = await snap(
    <Msg
      role="assistant"
      text="Three threads need you before noon: vendor renewal, podcast intro feedback, and the design review at 11."
    />
  )

  const tts = await snap(
    <ToolPanel
      items={['voice 11labs · grace_v3', 'elapsed 4.6s · 2 chunks queued', 'ducking mic input']}
      theme={t}
      title="tts · playing"
    />
  )

  return {
    composer: 'ctrl+b to start recording',
    timeline: [
      { ansi: vad, at: 250, id: 'vad', type: 'frame' },
      { at: 600, duration: 1500, target: 'vad', type: 'spotlight' },
      {
        at: 800,
        duration: 1700,
        position: 'right',
        target: 'vad',
        text: 'Continuous loop: VAD detects silence, transcribes, restarts — no key holds.',
        type: 'caption'
      },
      { ansi: transcript, at: 2700, id: 'transcript', type: 'frame' },
      { at: 3400, duration: 1100, target: 'transcript', type: 'highlight' },
      {
        at: 3600,
        duration: 1700,
        position: 'right',
        target: 'transcript',
        text: 'Transcript flows straight into the composer with the standard ❯ user glyph.',
        type: 'caption'
      },
      { ansi: answer, at: 5500, id: 'answer', type: 'frame' },
      { ansi: tts, at: 6700, id: 'tts', type: 'frame' },
      {
        at: 7000,
        duration: 1700,
        position: 'right',
        target: 'tts',
        text: 'TTS auto-ducks the mic so the loop never echoes itself back.',
        type: 'caption'
      },
      { at: 8800, duration: 600, text: '/voice off', type: 'compose' }
    ],
    title: 'Hermes TUI · Voice Mode',
    viewport: { cols: COLS, rows: ROWS }
  }
}

const main = async () => {
  console.log('recording workflows…')

  // Wipe the workflows dir so deleted/renamed scenes don't linger.
  const workflowsDir = join(showroomRoot, 'workflows')

  for (const file of ['feature-tour.json', 'subagent-trail.json', 'slash-commands.json', 'voice-mode.json', 'ink-frames.json']) {
    try {
      rmSync(join(workflowsDir, file))
    } catch {
      /* ignore */
    }
  }

  writeWorkflow('feature-tour', await featureTour())
  writeWorkflow('subagent-trail', await subagentTrail())
  writeWorkflow('slash-commands', await slashCommands())
  writeWorkflow('voice-mode', await voiceMode())

  console.log('done')
}

void main().catch(error => {
  console.error(error)
  process.exit(1)
})
