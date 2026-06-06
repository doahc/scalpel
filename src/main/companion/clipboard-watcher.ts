/**
 * Companion mode clipboard watcher.
 *
 * Polls the clipboard every 500ms. When the text changes to a valid PoE item,
 * automatically triggers the price-check pipeline and pushes results to all
 * connected WebSocket clients via the bridge.
 *
 * This replaces the hotkey flow for companion mode because:
 *  - uiohook (X11 XRecord) cannot capture keypresses destined for
 *    Wayland-native windows (like PoE running on Hyprland).
 *  - globalShortcut via XWayland also does not intercept Wayland-native focus.
 *  - The user simply presses Ctrl+C on an item in PoE; the watcher detects
 *    the change and fires automatically.
 */

import { clipboard } from 'electron'
import type Store from 'electron-store'
import type { AppSettings, GameVariant } from '../../shared/types'
import { getProfileBackedSetting } from '../profiles/profile-settings'

let watchTimer: ReturnType<typeof setInterval> | null = null
let lastClipboardText = ''

export function startCompanionClipboardWatcher(store: Store<AppSettings>): void {
  if (watchTimer) return

  // Snapshot current clipboard so we don't fire on stale content at startup.
  try {
    lastClipboardText = clipboard.readText()
  } catch {
    lastClipboardText = ''
  }

  watchTimer = setInterval(async () => {
    let text = ''
    try {
      text = clipboard.readText()
    } catch {
      return
    }

    if (text === lastClipboardText) return
    lastClipboardText = text

    if (!text.trim()) return

    // Try to parse as a PoE item. Import lazily to avoid loading the full
    // filter/trade stack at module initialisation time.
    try {
      const { parseItemText } = await import('../trade/clipboard')
      const item = parseItemText(text)
      if (!item) return

      // Guard: if the active league is still empty (fresh install, leagues not
      // fetched yet) wait up to 5 seconds for it to populate before giving up.
      let league = getProfileBackedSetting(store, 'league') as string
      if (!league) {
        for (let i = 0; i < 10; i++) {
          await new Promise((r) => setTimeout(r, 500))
          league = getProfileBackedSetting(store, 'league') as string
          if (league) break
        }
      }

      // If still no league, write the first available one directly to the store
      // so runPriceCheck (which reads league via getProfileBackedSetting) finds it.
      if (!league) {
        const poeVersion = (store.get('poeVersion') as GameVariant) ?? 2
        const leagues = (store.get(poeVersion === 2 ? 'leaguesPoe2' : 'leaguesPoe1') as string[]) ?? []
        if (leagues[0]) {
          const { writeActiveProfileSetting } = await import('../profiles/profile-settings')
          writeActiveProfileSetting(store, 'league', leagues[0])
        }
      }

      // Item detected -- run the full price-check pipeline.
      const { runPriceCheck } = await import('../evaluation')
      await runPriceCheck(item, store)
    } catch (err) {
      console.error('[companion-clipboard] price check failed:', err)
    }
  }, 500)

  console.log('[companion] Clipboard watcher started (500ms poll)')
}

export function stopCompanionClipboardWatcher(): void {
  if (watchTimer) {
    clearInterval(watchTimer)
    watchTimer = null
  }
}
