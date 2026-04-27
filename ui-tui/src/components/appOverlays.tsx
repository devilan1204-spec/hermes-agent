import { Box, Text, useStdout } from '@hermes/ink'
import { useStore } from '@nanostores/react'

import { useGateway } from '../app/gatewayContext.js'
import type { AppOverlaysProps } from '../app/interfaces.js'
import { $overlayState, patchOverlayState } from '../app/overlayStore.js'
import { $uiState } from '../app/uiStore.js'

import { LearningLedger } from './learningLedger.js'
import { MaskedPrompt } from './maskedPrompt.js'
import { ModelPicker } from './modelPicker.js'
import { OverlayHint } from './overlayControls.js'
import { OverlayGrid } from './overlayGrid.js'
import { ApprovalPrompt, ClarifyPrompt, ConfirmPrompt } from './prompts.js'
import { SessionPicker } from './sessionPicker.js'
import { SkillsHub } from './skillsHub.js'

const COMPLETION_WINDOW = 16
const OVERLAY_GUTTER = 4
const OVERLAY_MIN_WIDTH = 44

export function PromptZone({
  cols,
  onApprovalChoice,
  onClarifyAnswer,
  onSecretSubmit,
  onSudoSubmit
}: Pick<AppOverlaysProps, 'cols' | 'onApprovalChoice' | 'onClarifyAnswer' | 'onSecretSubmit' | 'onSudoSubmit'>) {
  const overlay = useStore($overlayState)
  const ui = useStore($uiState)

  if (overlay.approval) {
    return (
      <Box flexDirection="column" flexShrink={0} paddingX={1} paddingY={1}>
        <ApprovalPrompt onChoice={onApprovalChoice} req={overlay.approval} t={ui.theme} />
      </Box>
    )
  }

  if (overlay.confirm) {
    const req = overlay.confirm

    const onConfirm = () => {
      patchOverlayState({ confirm: null })
      req.onConfirm()
    }

    const onCancel = () => patchOverlayState({ confirm: null })

    return (
      <Box flexDirection="column" flexShrink={0} paddingX={1} paddingY={1}>
        <ConfirmPrompt onCancel={onCancel} onConfirm={onConfirm} req={req} t={ui.theme} />
      </Box>
    )
  }

  if (overlay.clarify) {
    return (
      <Box flexDirection="column" flexShrink={0} paddingX={1} paddingY={1}>
        <ClarifyPrompt
          cols={cols}
          onAnswer={onClarifyAnswer}
          onCancel={() => onClarifyAnswer('')}
          req={overlay.clarify}
          t={ui.theme}
        />
      </Box>
    )
  }

  if (overlay.sudo) {
    return (
      <Box flexDirection="column" flexShrink={0} paddingX={1} paddingY={1}>
        <MaskedPrompt cols={cols} icon="🔐" label="sudo password required" onSubmit={onSudoSubmit} t={ui.theme} />
      </Box>
    )
  }

  if (overlay.secret) {
    return (
      <Box flexDirection="column" flexShrink={0} paddingX={1} paddingY={1}>
        <MaskedPrompt
          cols={cols}
          icon="🔑"
          label={overlay.secret.prompt}
          onSubmit={onSecretSubmit}
          sub={`for ${overlay.secret.envVar}`}
          t={ui.theme}
        />
      </Box>
    )
  }

  return null
}

export function FloatingOverlays({
  cols,
  compIdx,
  completions,
  onModelSelect,
  onPickerSelect,
  pagerPageSize
}: Pick<AppOverlaysProps, 'cols' | 'compIdx' | 'completions' | 'onModelSelect' | 'onPickerSelect' | 'pagerPageSize'>) {
  const { gw } = useGateway()
  const overlay = useStore($overlayState)
  const ui = useStore($uiState)
  const { stdout } = useStdout()

  const hasAny =
    overlay.learningLedger ||
    overlay.modelPicker ||
    overlay.pager ||
    overlay.picker ||
    overlay.skillsHub ||
    completions.length

  if (!hasAny) {
    return null
  }

  // Fixed viewport centered on compIdx — previously the slice end was
  // compIdx + 8 so the dropdown grew from 8 rows to 16 as the user scrolled
  // down, bouncing the height on every keystroke.
  const viewportSize = Math.min(COMPLETION_WINDOW, completions.length)

  const start = Math.max(0, Math.min(compIdx - Math.floor(COMPLETION_WINDOW / 2), completions.length - viewportSize))
  const overlayWidth = Math.max(OVERLAY_MIN_WIDTH, cols - OVERLAY_GUTTER)
  const overlayMaxHeight = Math.max(6, Math.min(18, (stdout?.rows ?? 24) - 8))

  return (
    <Box alignItems="flex-start" bottom="100%" flexDirection="column" left={0} position="absolute" right={0}>
      {overlay.picker && (
        <OverlayGrid
          borderColor={ui.theme.color.border}
          panels={[
            {
              content: (
                <SessionPicker
                  gw={gw}
                  onCancel={() => patchOverlayState({ picker: false })}
                  onSelect={onPickerSelect}
                  t={ui.theme}
                />
              ),
              id: 'sessions'
            }
          ]}
          maxHeight={overlayMaxHeight}
          t={ui.theme}
          width={overlayWidth}
        />
      )}

      {overlay.modelPicker && (
        <OverlayGrid
          borderColor={ui.theme.color.border}
          panels={[
            {
              content: (
                <ModelPicker
                  gw={gw}
                  onCancel={() => patchOverlayState({ modelPicker: false })}
                  onSelect={onModelSelect}
                  sessionId={ui.sid}
                  t={ui.theme}
                />
              ),
              id: 'models'
            }
          ]}
          maxHeight={overlayMaxHeight}
          t={ui.theme}
          width={overlayWidth}
        />
      )}

      {overlay.skillsHub && (
        <OverlayGrid
          borderColor={ui.theme.color.border}
          panels={[
            {
              content: <SkillsHub gw={gw} onClose={() => patchOverlayState({ skillsHub: false })} t={ui.theme} />,
              id: 'skills'
            }
          ]}
          maxHeight={overlayMaxHeight}
          t={ui.theme}
          width={overlayWidth}
        />
      )}

      {overlay.learningLedger && (
        <LearningLedger
          borderColor={ui.theme.color.border}
          gw={gw}
          onClose={() => patchOverlayState({ learningLedger: false })}
          t={ui.theme}
          width={overlayWidth}
          maxHeight={overlayMaxHeight}
        />
      )}

      {overlay.pager && (
        <OverlayGrid
          borderColor={ui.theme.color.border}
          panels={[
            {
              content: (
                <Box flexDirection="column">
                  {overlay.pager.lines
                    .slice(overlay.pager.offset, overlay.pager.offset + pagerPageSize)
                    .map((line, i) => (
                      <Text key={i}>{line}</Text>
                    ))}

                  <Box marginTop={1}>
                    <OverlayHint t={ui.theme}>
                      {overlay.pager.offset + pagerPageSize < overlay.pager.lines.length
                        ? `↑↓/jk line · Enter/Space/PgDn page · b/PgUp back · g/G top/bottom · Esc/q close (${Math.min(overlay.pager.offset + pagerPageSize, overlay.pager.lines.length)}/${overlay.pager.lines.length})`
                        : `end · ↑↓/jk · b/PgUp back · g top · Esc/q close (${overlay.pager.lines.length} lines)`}
                    </OverlayHint>
                  </Box>
                </Box>
              ),
              id: 'pager',
              title: overlay.pager.title
            }
          ]}
          maxHeight={overlayMaxHeight}
          t={ui.theme}
          width={overlayWidth}
        />
      )}

      {!!completions.length && (
        <OverlayGrid
          borderColor={ui.theme.color.primary}
          panels={[
            {
              content: (
                <Box flexDirection="column">
                  {completions.slice(start, start + viewportSize).map((item, i) => {
                    const active = start + i === compIdx

                    return (
                      <Box
                        backgroundColor={active ? ui.theme.color.completionCurrentBg : undefined}
                        key={`${start + i}:${item.text}`}
                        width="100%"
                      >
                        <Text bold color={ui.theme.color.label} wrap="truncate-end">
                          {item.display}
                        </Text>
                      </Box>
                    )
                  })}
                </Box>
              ),
              grow: 4,
              id: 'completion-list'
            },
            {
              content: (
                <Box flexDirection="column">
                  {completions.slice(start, start + viewportSize).map((item, i) => {
                    const active = start + i === compIdx

                    return (
                      <Box
                        backgroundColor={active ? ui.theme.color.completionCurrentBg : undefined}
                        key={`${start + i}:${item.text}:meta`}
                        width="100%"
                      >
                        <Text color={ui.theme.color.muted} wrap="truncate-end">
                          {item.meta ?? ' '}
                        </Text>
                      </Box>
                    )
                  })}
                </Box>
              ),
              grow: 6,
              id: 'completion-meta'
            }
          ]}
          maxHeight={overlayMaxHeight}
          t={ui.theme}
          width={overlayWidth}
        />
      )}
    </Box>
  )
}
