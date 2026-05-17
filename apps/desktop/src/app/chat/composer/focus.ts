export type ComposerFocusTarget = 'main' | 'edit'

interface ComposerFocusRequestDetail {
  target: ComposerFocusTarget
}

const COMPOSER_FOCUS_REQUEST_EVENT = 'hermes:composer-focus-request'

let activeComposerTarget: ComposerFocusTarget = 'main'

function resolveTarget(target: ComposerFocusTarget | 'active'): ComposerFocusTarget {
  return target === 'active' ? activeComposerTarget : target
}

export function markActiveComposer(target: ComposerFocusTarget) {
  activeComposerTarget = target
}

export function requestComposerFocus(target: ComposerFocusTarget | 'active' = 'active') {
  if (typeof window === 'undefined') {
    return
  }

  const resolvedTarget = resolveTarget(target)

  const event = new CustomEvent<ComposerFocusRequestDetail>(COMPOSER_FOCUS_REQUEST_EVENT, {
    detail: { target: resolvedTarget }
  })

  window.dispatchEvent(event)
}

export function onComposerFocusRequest(handler: (target: ComposerFocusTarget) => void) {
  if (typeof window === 'undefined') {
    return () => undefined
  }

  const listener = (event: Event) => {
    const detail = (event as CustomEvent<ComposerFocusRequestDetail>).detail

    if (detail?.target === 'main' || detail?.target === 'edit') {
      handler(detail.target)
    }
  }

  window.addEventListener(COMPOSER_FOCUS_REQUEST_EVENT, listener)

  return () => window.removeEventListener(COMPOSER_FOCUS_REQUEST_EVENT, listener)
}
