/**
 * Companion Bridge Wiring
 *
 * In companion mode (isCompanion=true):
 *   - Sets a fake window via setCompanionWindow so evaluation.ts / trade.ts
 *     route ALL their webContents.send calls through the bridge.
 *     This includes overlay-data, price-check, setting-updated, etc.
 *   - Does NOT add explicit setting/league listeners (fake window covers them).
 *
 * In normal mode (isCompanion=false):
 *   - Does NOT set the fake window (real overlay window handles evaluation events).
 *   - Adds explicit listeners for setting/league updates so browser clients
 *     receive those changes even without the fake window.
 */

import { wsBridge } from './ws-bridge'

export async function wireCompanionBridge(isCompanion: boolean): Promise<void> {
  // ---- zone changes (both modes) -------------------------------------------
  const { onZoneChanged } = await import('../client-log/zone-state')
  onZoneChanged((zone) => wsBridge.push('zone-changed', zone))

  // ---- filter loaded (both modes) ------------------------------------------
  const { onFilterLoaded } = await import('../filter-state')
  onFilterLoaded(() => wsBridge.push('filter-changed'))

  // ---- rate-limit state (both modes) ---------------------------------------
  const { onRateLimitUpdate } = await import('../trade/trade')
  onRateLimitUpdate((state) => wsBridge.push('rate-limit', state))

  if (isCompanion) {
    // Companion mode: inject a fake window that forwards ALL webContents.send
    // calls (overlay-data, price-check, setting-updated, league-updated, etc.)
    // directly to the bridge. This avoids needing per-channel explicit listeners.
    const { setCompanionWindow } = await import('../overlay')
    setCompanionWindow({
      isDestroyed: () => false,
      webContents: {
        send(channel: string, ...args: unknown[]): void {
          wsBridge.push(channel, ...args)
        },
      },
    })
  } else {
    // Normal mode: real overlay window handles evaluation events for Electron.
    // Add explicit listeners only for setting/league so browser clients also
    // receive those when connected alongside the normal overlay.
    const { addCompanionSettingListener, addCompanionLeagueListener } = await import('../settings-write')
    addCompanionSettingListener((key, value) => wsBridge.push('setting-updated', key, value))
    addCompanionLeagueListener((league) => wsBridge.push('league-updated', league))
  }
}
