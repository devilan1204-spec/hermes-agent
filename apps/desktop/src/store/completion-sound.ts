import { atom } from 'nanostores'

import { persistString, storedString } from '@/lib/storage'

const COMPLETION_SOUND_VARIANT_STORAGE_KEY = 'hermes.desktop.completionSoundVariantId'
const DEFAULT_COMPLETION_SOUND_VARIANT_ID = 1
const MAX_COMPLETION_SOUND_VARIANT_ID = 14
const MIN_COMPLETION_SOUND_VARIANT_ID = 1

function resolveCompletionSoundVariantId(variantId: number): number {
  if (!Number.isFinite(variantId)) {
    return DEFAULT_COMPLETION_SOUND_VARIANT_ID
  }

  if (variantId < MIN_COMPLETION_SOUND_VARIANT_ID || variantId > MAX_COMPLETION_SOUND_VARIANT_ID) {
    return DEFAULT_COMPLETION_SOUND_VARIANT_ID
  }

  return variantId
}

function loadCompletionSoundVariantId(): number {
  const stored = storedString(COMPLETION_SOUND_VARIANT_STORAGE_KEY)

  if (!stored) {
    return DEFAULT_COMPLETION_SOUND_VARIANT_ID
  }

  return resolveCompletionSoundVariantId(Number.parseInt(stored, 10))
}

export const $completionSoundVariantId = atom(loadCompletionSoundVariantId())

$completionSoundVariantId.subscribe(variantId => {
  persistString(COMPLETION_SOUND_VARIANT_STORAGE_KEY, String(resolveCompletionSoundVariantId(variantId)))
})

export function setCompletionSoundVariantId(variantId: number) {
  $completionSoundVariantId.set(resolveCompletionSoundVariantId(variantId))
}
