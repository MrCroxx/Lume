import { useEffect, useRef, useState } from 'react'

const EMPTY_SELECTION = new Set<string>()

interface SelectionState {
  scope: string
  keys: Set<string>
}

export function useEntrySelection(visibleKeys: string[], scope: string) {
  const [state, setState] = useState<SelectionState>(() => ({
    scope,
    keys: new Set(),
  }))
  const anchor = useRef<{ scope: string; key: string } | null>(null)
  const selectedKeys = state.scope === scope ? state.keys : EMPTY_SELECTION
  const allVisibleSelected =
    visibleKeys.length > 0 && visibleKeys.every((key) => selectedKeys.has(key))

  useEffect(() => {
    const visible = new Set(visibleKeys)
    setState((current) => {
      if (current.scope !== scope) return { scope, keys: new Set() }
      const keys = new Set([...current.keys].filter((key) => visible.has(key)))
      return keys.size === current.keys.size ? current : { scope, keys }
    })
    if (anchor.current?.scope !== scope || !visible.has(anchor.current.key)) {
      anchor.current = null
    }
  }, [scope, visibleKeys])

  function toggle(key: string, range: boolean) {
    setState((current) => {
      const currentKeys = current.scope === scope ? current.keys : EMPTY_SELECTION
      const keys = new Set(currentKeys)
      const anchorKey = anchor.current?.scope === scope ? anchor.current.key : null
      const anchorIndex = anchorKey ? visibleKeys.indexOf(anchorKey) : -1
      const keyIndex = visibleKeys.indexOf(key)

      if (range && anchorIndex >= 0 && keyIndex >= 0) {
        const shouldSelect = !currentKeys.has(key)
        const start = Math.min(anchorIndex, keyIndex)
        const end = Math.max(anchorIndex, keyIndex)
        visibleKeys.slice(start, end + 1).forEach((visibleKey) => {
          if (shouldSelect) keys.add(visibleKey)
          else keys.delete(visibleKey)
        })
      } else if (keys.has(key)) {
        keys.delete(key)
      } else {
        keys.add(key)
      }
      return { scope, keys }
    })
    anchor.current = { scope, key }
  }

  function toggleAllVisible() {
    setState((current) => {
      const currentKeys = current.scope === scope ? current.keys : EMPTY_SELECTION
      const keys = new Set(currentKeys)
      const allSelected =
        visibleKeys.length > 0 && visibleKeys.every((key) => currentKeys.has(key))
      visibleKeys.forEach((key) => {
        if (allSelected) keys.delete(key)
        else keys.add(key)
      })
      return { scope, keys }
    })
    anchor.current = null
  }

  function clear() {
    setState({ scope, keys: new Set() })
    anchor.current = null
  }

  function replace(keys: Iterable<string>) {
    setState({ scope, keys: new Set(keys) })
    anchor.current = null
  }

  return {
    selectedKeys,
    allVisibleSelected,
    toggle,
    toggleAllVisible,
    clear,
    replace,
  }
}
