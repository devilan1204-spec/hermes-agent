import { type RefObject, useEffect } from 'react'

export function useResizeObserver(onResize: () => void, ...refs: readonly RefObject<Element | null>[]) {
  const elements = refs.map(ref => ref.current)

  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') {
      return
    }

    const observer = new ResizeObserver(() => onResize())
    let observed = false

    for (const element of elements) {
      if (!element) {
        continue
      }

      observer.observe(element)
      observed = true
    }

    if (!observed) {
      observer.disconnect()

      return
    }

    onResize()

    return () => observer.disconnect()
  }, [onResize, ...elements])
}
