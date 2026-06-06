/**
 * Remote backend self-update. When a desktop window drives a backend on
 * another host, the Electron native updater can't reach it — only the remote
 * gateway can update its own box. This kicks off `update.start` on the gateway,
 * then polls `update.status` across the inevitable disconnect/reconnect,
 * surfacing a lightweight status pill (a persistent notification) throughout.
 */

import { atom } from 'nanostores'

import { dismissNotification, notify } from '@/store/notifications'

export type RemoteUpdatePhase = 'idle' | 'starting' | 'running' | 'reconnecting' | 'done' | 'error'

export interface RemoteUpdateState {
  phase: RemoteUpdatePhase
  message: string
}

interface RemoteUpdateStatus {
  running: boolean
  finished: boolean
  exit_code: number | null
  output: string
}

type RequestGateway = <T>(method: string, params?: Record<string, unknown>) => Promise<T>

const TOAST_ID = 'remote-backend-update'
const POLL_INTERVAL_MS = 2_000
const POLL_TIMEOUT_MS = 30 * 60 * 1_000
const IDLE: RemoteUpdateState = { phase: 'idle', message: '' }
const ACTIVE_PHASES: ReadonlySet<RemoteUpdatePhase> = new Set(['starting', 'running', 'reconnecting'])

export const $remoteUpdate = atom<RemoteUpdateState>(IDLE)

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

function setPhase(phase: RemoteUpdatePhase, message: string): void {
  $remoteUpdate.set({ phase, message })

  if (phase === 'error') {
    notify({ id: TOAST_ID, kind: 'error', title: 'Backend update', message, durationMs: 0 })
  } else if (phase === 'done') {
    notify({ id: TOAST_ID, kind: 'success', title: 'Backend update', message })
  } else if (ACTIVE_PHASES.has(phase)) {
    notify({ id: TOAST_ID, kind: 'info', title: 'Backend update', message, durationMs: 0 })
  } else {
    dismissNotification(TOAST_ID)
  }
}

export function resetRemoteUpdate(): void {
  dismissNotification(TOAST_ID)
  $remoteUpdate.set(IDLE)
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function tail(output: string, lines = 4): string {
  const trimmed = (output || '').trim()

  return trimmed ? trimmed.split('\n').slice(-lines).join('\n') : ''
}

export async function startRemoteUpdate(requestGateway: RequestGateway): Promise<void> {
  if (ACTIVE_PHASES.has($remoteUpdate.get().phase)) {
    return
  }

  setPhase('starting', 'Starting backend update…')

  try {
    await requestGateway('update.start')
  } catch (error) {
    setPhase('error', errorText(error) || 'Could not start the backend update.')

    return
  }

  setPhase('running', 'Updating remote backend…')
  await pollRemoteUpdate(requestGateway)
}

async function pollRemoteUpdate(requestGateway: RequestGateway): Promise<void> {
  const deadline = Date.now() + POLL_TIMEOUT_MS

  while (Date.now() < deadline) {
    await delay(POLL_INTERVAL_MS)

    let status: RemoteUpdateStatus

    try {
      status = await requestGateway<RemoteUpdateStatus>('update.status')
    } catch {
      // The backend likely dropped to restart with the new code. requestGateway
      // already attempted a reconnect; reflect that and keep polling.
      setPhase('reconnecting', 'Reconnecting to backend…')

      continue
    }

    if ($remoteUpdate.get().phase === 'reconnecting') {
      setPhase('running', 'Updating remote backend…')
    }

    if (status.finished) {
      if ((status.exit_code ?? 1) === 0) {
        setPhase('done', 'Backend updated. Restart it to load the new version.')
      } else {
        setPhase('error', tail(status.output) || 'Backend update failed.')
      }

      return
    }
  }

  setPhase('error', 'Backend update timed out.')
}
