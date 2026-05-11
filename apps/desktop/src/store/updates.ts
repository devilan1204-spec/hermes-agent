/**
 * Desktop self-update store. Tracks distance from the configured branch,
 * surfaces it as an ambient pill, and orchestrates the apply flow.
 */

import { atom } from 'nanostores'

import type {
  DesktopUpdateApplyOptions,
  DesktopUpdateApplyResult,
  DesktopUpdateProgress,
  DesktopUpdateStage,
  DesktopUpdateStatus,
  DesktopVersionInfo
} from '@/global'
import { persistString, storedString } from '@/lib/storage'
import { dismissNotification, notify } from '@/store/notifications'

export interface UpdateApplyState {
  applying: boolean
  stage: DesktopUpdateStage
  message: string
  percent: number | null
  error: string | null
  log: readonly { stage: DesktopUpdateStage; message: string; at: number }[]
}

const IDLE: UpdateApplyState = { applying: false, stage: 'idle', message: '', percent: null, error: null, log: [] }

export const $desktopVersion = atom<DesktopVersionInfo | null>(null)
export const $updateApply = atom<UpdateApplyState>(IDLE)
export const $updateChecking = atom<boolean>(false)
export const $updateOverlayOpen = atom<boolean>(false)
export const $updateStatus = atom<DesktopUpdateStatus | null>(null)

export const setUpdateOverlayOpen = (open: boolean) => $updateOverlayOpen.set(open)
export const resetUpdateApplyState = () => $updateApply.set(IDLE)

const UPDATE_TOAST_ID = 'desktop-update-available'
const UPDATE_TOAST_DISMISSED_KEY = 'hermes:update-toast-dismissed-sha'

function markToastDismissed(sha: string | undefined) {
  if (sha) {
    persistString(UPDATE_TOAST_DISMISSED_KEY, sha)
  }
}

/**
 * Fire a one-shot toast the first time we see a particular target commit so
 * users don't have to notice the status-bar version pill turning colors.
 * Dismissal is remembered per-target-sha so the toast doesn't keep popping
 * back for the same update across restarts.
 */
function maybeNotifyUpdateAvailable(status: DesktopUpdateStatus | null) {
  if (!status || status.supported === false || status.error || !status.targetSha) {
    return
  }

  if ((status.behind ?? 0) <= 0) {
    return
  }

  if (storedString(UPDATE_TOAST_DISMISSED_KEY) === status.targetSha) {
    return
  }

  if ($updateApply.get().applying) {
    return
  }

  const behind = status.behind ?? 0
  const targetSha = status.targetSha

  notify({
    action: {
      label: "See what's new",
      onClick: () => {
        markToastDismissed(targetSha)
        openUpdatesWindow()
      }
    },
    durationMs: 0,
    id: UPDATE_TOAST_ID,
    kind: 'info',
    message: `${behind} new change${behind === 1 ? '' : 's'} available.`,
    onDismiss: () => markToastDismissed(targetSha),
    title: 'Update ready'
  })
}

/**
 * Opens the updates dialog and kicks off a fresh check so the user always
 * sees current state, even if a stale status is cached from earlier.
 */
export function openUpdatesWindow(): void {
  $updateOverlayOpen.set(true)
  void checkUpdates()
}

export async function checkUpdates(): Promise<DesktopUpdateStatus | null> {
  const bridge = window.hermesDesktop?.updates

  if (!bridge || $updateChecking.get()) {
    return $updateStatus.get()
  }

  $updateChecking.set(true)

  try {
    const status = await bridge.check()
    $updateStatus.set(status)
    maybeNotifyUpdateAvailable(status)

    return status
  } catch (error) {
    const previous = $updateStatus.get()

    const fallback: DesktopUpdateStatus = {
      supported: previous?.supported ?? true,
      branch: previous?.branch,
      error: 'check-failed',
      message: error instanceof Error ? error.message : String(error),
      fetchedAt: Date.now()
    }

    $updateStatus.set(fallback)

    return fallback
  } finally {
    $updateChecking.set(false)
  }
}

export async function applyUpdates(opts: DesktopUpdateApplyOptions = {}): Promise<DesktopUpdateApplyResult> {
  const bridge = window.hermesDesktop?.updates

  if (!bridge) {
    return { ok: false, error: 'unavailable', message: 'Desktop bridge unavailable.' }
  }

  dismissNotification(UPDATE_TOAST_ID)
  $updateApply.set({ ...IDLE, applying: true, stage: 'prepare', message: 'Starting update…' })

  try {
    return await bridge.apply(opts)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    $updateApply.set({ ...$updateApply.get(), applying: false, stage: 'error', error: 'apply-failed', message })

    return { ok: false, error: 'apply-failed', message }
  }
}

function ingestProgress(payload: DesktopUpdateProgress): void {
  const current = $updateApply.get()
  const log = [...current.log, { stage: payload.stage, message: payload.message, at: payload.at }].slice(-50)
  const terminal = payload.stage === 'error' || payload.stage === 'restart'

  $updateApply.set({
    applying: !terminal,
    stage: payload.stage,
    message: payload.message,
    percent: payload.percent,
    error: payload.error,
    log
  })
}

let pollerStarted = false
let backgroundTimer: ReturnType<typeof setInterval> | null = null
let lastFocusAt = 0

/** Wire up background polling + progress streaming. Idempotent. */
export function startUpdatePoller(): void {
  if (pollerStarted || typeof window === 'undefined') {
    return
  }

  const bridge = window.hermesDesktop?.updates

  if (!bridge) {
    return
  }

  pollerStarted = true
  void checkUpdates()
  void window.hermesDesktop?.getVersion?.().then(info => $desktopVersion.set(info))
  bridge.onProgress(ingestProgress)

  window.addEventListener('focus', onFocus)
  backgroundTimer = setInterval(() => void checkUpdates(), 30 * 60 * 1000)
}

export function stopUpdatePoller(): void {
  if (backgroundTimer !== null) {
    clearInterval(backgroundTimer)
    backgroundTimer = null
  }

  window.removeEventListener('focus', onFocus)
  pollerStarted = false
}

function onFocus() {
  const now = Date.now()

  if (now - lastFocusAt < 5 * 60 * 1000) {
    return
  }

  lastFocusAt = now
  void checkUpdates()
}
