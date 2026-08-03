export type AppRoute =
  | { page: 'files'; storageId: string | null; path: string }
  | { page: 'admin' }

export interface BrowserHistoryPosition {
  index: number
  maxIndex: number
}

const HISTORY_STATE_KEY = 'lumeNavigation'

export function readAppRoute(): AppRoute {
  const segments = window.location.pathname.split('/').filter(Boolean)
  if (segments[0] === 'admin') return { page: 'admin' }
  if (segments[0] !== 'files' || segments.length === 1) {
    return { page: 'files', storageId: null, path: '' }
  }

  try {
    return {
      page: 'files',
      storageId: decodeURIComponent(segments[1]),
      path: normalizeDirectoryPath(segments.slice(2).map(decodeURIComponent).join('/')),
    }
  } catch {
    return { page: 'files', storageId: null, path: '' }
  }
}

export function appRouteUrl(route: AppRoute): string {
  if (route.page === 'admin') return '/admin'
  if (!route.storageId) return '/files'

  const storage = encodeURIComponent(route.storageId)
  const path = normalizeDirectoryPath(route.path)
    .split('/')
    .filter(Boolean)
    .map(encodeURIComponent)
    .join('/')
  return path ? `/files/${storage}/${path}` : `/files/${storage}`
}

export function initializeBrowserHistory(): BrowserHistoryPosition {
  const current = readBrowserHistoryPosition()
  if (current) return current

  const initial = { index: 0, maxIndex: 0 }
  window.history.replaceState(
    withHistoryPosition(window.history.state, initial),
    '',
    appRouteUrl(readAppRoute()),
  )
  return initial
}

export function writeAppRoute(route: AppRoute, replace = false): BrowserHistoryPosition {
  const current = readBrowserHistoryPosition() ?? initializeBrowserHistory()
  const url = appRouteUrl(route)
  const currentUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`

  if (replace) {
    window.history.replaceState(withHistoryPosition(window.history.state, current), '', url)
    return current
  }
  if (currentUrl === url) return current

  const nextIndex = current.index + 1
  window.history.replaceState(
    withHistoryPosition(window.history.state, { index: current.index, maxIndex: nextIndex }),
    '',
    currentUrl,
  )
  const next = { index: nextIndex, maxIndex: nextIndex }
  window.history.pushState(withHistoryPosition(null, next), '', url)
  return next
}

export function readBrowserHistoryPosition(): BrowserHistoryPosition | null {
  const value = window.history.state?.[HISTORY_STATE_KEY] as
    | Partial<BrowserHistoryPosition>
    | undefined
  if (
    !value ||
    !Number.isInteger(value.index) ||
    !Number.isInteger(value.maxIndex) ||
    value.index === undefined ||
    value.maxIndex === undefined ||
    value.index < 0 ||
    value.maxIndex < value.index
  ) {
    return null
  }
  return { index: value.index, maxIndex: value.maxIndex }
}

export function normalizeDirectoryPath(path: string): string {
  const normalized = path.replace(/^\/+|\/+$/g, '')
  return normalized ? `${normalized}/` : ''
}

export function pathIsWithin(path: string, root: string): boolean {
  const normalizedPath = normalizeDirectoryPath(path).replace(/\/$/, '')
  const normalizedRoot = normalizeDirectoryPath(root).replace(/\/$/, '')
  if (!normalizedRoot) return true
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`)
}

function withHistoryPosition(state: unknown, position: BrowserHistoryPosition) {
  const current = state && typeof state === 'object' ? state : {}
  return { ...current, [HISTORY_STATE_KEY]: position }
}
