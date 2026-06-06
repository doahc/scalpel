/**
 * Companion WebSocket API Shim
 *
 * Implements the same window.api interface as src/preload/index.ts, but
 * over a WebSocket connection to the companion HTTP server instead of
 * via Electron's contextBridge.
 *
 * The shim is injected into window.api before React mounts so all
 * component code works without modification.
 *
 * Usage in companion renderer entry:
 *   import { installCompanionApi } from './companion-api'
 *   await installCompanionApi()  // connects + installs, resolves when ready
 *   // then bootstrap React
 *
 * The WebSocket URL is read from window.COMPANION_WS_URL (injected by the
 * server into the HTML) or defaults to ws://127.0.0.1:PORT derived from
 * the current page URL.
 */

type UnsubFn = () => void

// ---------------------------------------------------------------------------
// Wire protocol types
// ---------------------------------------------------------------------------
interface ReplyFrame {
  type: 'reply'
  id: number
  result?: unknown
  error?: string
}
interface EventFrame {
  type: 'event'
  channel: string
  args: unknown[]
}
type ServerFrame = ReplyFrame | EventFrame

// ---------------------------------------------------------------------------
// CompanionWsClient
// ---------------------------------------------------------------------------
class CompanionWsClient {
  private ws: WebSocket | null = null
  private nextId = 1
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  private listeners = new Map<string, Set<(...args: unknown[]) => void>>()
  // Buffer events that arrive before any listener is registered for that channel.
  // Drained (and cleared) the first time a listener registers for the channel.
  private earlyEvents = new Map<string, unknown[][]>()
  private url: string
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private intentionallyClosed = false

  constructor(url: string) {
    this.url = url
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url)
      this.ws = ws

      ws.addEventListener('open', () => {
        console.log('[companion] WebSocket connected')
        resolve()
      })

      ws.addEventListener('error', () => {
        reject(new Error('[companion] WebSocket connection failed'))
      })

      ws.addEventListener('close', () => {
        this.ws = null
        if (!this.intentionallyClosed) this.scheduleReconnect()
      })

      ws.addEventListener('message', (evt: MessageEvent<string>) => {
        let frame: ServerFrame
        try {
          frame = JSON.parse(evt.data) as ServerFrame
        } catch {
          return
        }

        if (frame.type === 'reply') {
          const pending = this.pending.get(frame.id)
          if (!pending) return
          this.pending.delete(frame.id)
          if (frame.error) {
            pending.reject(new Error(frame.error))
          } else {
            pending.resolve(frame.result ?? null)
          }
          return
        }

        if (frame.type === 'event') {
          const cbs = this.listeners.get(frame.channel)
          if (cbs) {
            for (const cb of cbs) {
              try {
                cb(...(frame.args as unknown[]))
              } catch (err) {
                console.error(`[companion] listener error on ${frame.channel}`, err)
              }
            }
          } else {
            // No listener yet -- buffer it. React subscribes during useEffect
            // which fires after the first render, so WS messages sent immediately
            // on connect can arrive before any listener is registered.
            const buf = this.earlyEvents.get(frame.channel) ?? []
            buf.push(frame.args as unknown[])
            this.earlyEvents.set(frame.channel, buf)
          }
        }
      })
    })
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect().catch(() => this.scheduleReconnect())
    }, 2000)
  }

  close(): void {
    this.intentionallyClosed = true
    this.ws?.close()
  }

  invoke<T = unknown>(method: string, ...args: unknown[]): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const id = this.nextId++
      this.pending.set(id, {
        resolve: (v) => resolve(v as T),
        reject,
      })
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        this.pending.delete(id)
        reject(new Error(`[companion] WebSocket not connected (method=${method})`))
        return
      }
      this.ws.send(JSON.stringify({ type: 'invoke', id, method, args }))
    })
  }

  send(method: string, ...args: unknown[]): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    this.ws.send(JSON.stringify({ type: 'send', method, args }))
  }

  on(channel: string, cb: (...args: unknown[]) => void): UnsubFn {
    if (!this.listeners.has(channel)) this.listeners.set(channel, new Set())
    this.listeners.get(channel)!.add(cb)

    // Drain any events that arrived before this listener was registered.
    const buffered = this.earlyEvents.get(channel)
    if (buffered?.length) {
      this.earlyEvents.delete(channel)
      // Use setTimeout(0) so the caller's useEffect cleanup runs before
      // we replay -- prevents the subscriber from seeing stale state.
      setTimeout(() => {
        for (const args of buffered) {
          try {
            cb(...args)
          } catch {}
        }
      }, 0)
    }

    return () => this.listeners.get(channel)?.delete(cb)
  }
}

// ---------------------------------------------------------------------------
// Detect companion server URL
// ---------------------------------------------------------------------------
function resolveWsUrl(): string {
  // Injected by the server as a global in the HTML, or fallback to same host
  const injected = (window as unknown as { COMPANION_WS_URL?: string }).COMPANION_WS_URL
  if (injected) return injected
  const { protocol, host } = window.location
  const ws = protocol === 'https:' ? 'wss:' : 'ws:'
  return `${ws}//${host}`
}

// ---------------------------------------------------------------------------
// Build the window.api shim object
// ---------------------------------------------------------------------------
function buildApi(client: CompanionWsClient) {
  const inv = <T = unknown>(method: string, ...args: unknown[]): Promise<T> => client.invoke<T>(method, ...args)
  const snd = (method: string, ...args: unknown[]): void => client.send(method, ...args)
  const sub = (channel: string, cb: (...a: unknown[]) => void): UnsubFn => client.on(channel, cb)

  return {
    // ----- manifest -----
    getManifest: () => inv('get-manifest'),

    // ----- settings -----
    getSettings: () => inv('get-settings'),
    setSetting: (key: string, value: unknown) => inv('set-setting', key, value),
    setProfileSettingForGame: (variant: unknown, key: string, value: unknown) =>
      inv('set-profile-setting-for-game', variant, key, value),
    listProfiles: () => inv('list-profiles'),
    createProfile: (input: unknown) => inv('create-profile', input),
    renameProfile: (id: string, name: string) => inv('rename-profile', id, name),
    duplicateProfile: (id: string, name: string) => inv('duplicate-profile', id, name),
    deleteProfile: (id: string) => inv('delete-profile', id),
    ensureProfileForGame: (variant: unknown) => inv('ensure-profile-for-game', variant),
    setActiveProfile: (id: string, restartIfNeeded?: boolean) => inv('set-active-profile', id, restartIfNeeded),
    refreshLeagues: () => inv('refresh-leagues'),
    getRegexPresets: () => inv('get-regex-presets'),
    saveRegexPreset: (preset: unknown) => inv('save-regex-preset', preset),
    deleteRegexPreset: (id: string) => inv('delete-regex-preset', id),
    reorderRegexPresets: (ids: string[]) => inv('reorder-regex-presets', ids),

    // ----- files -----
    pickFilterFile: () => inv('pick-filter-file'),
    pickFilterDir: () => inv('pick-filter-dir'),
    scanFilterDir: (dir: string) => inv('scan-filter-dir', dir),
    scanSoundFiles: (dir: string) => inv('scan-sound-files', dir),
    getSoundDataUrl: (dir: string, filename: string) => inv('get-sound-data-url', dir, filename),
    importOnlineFilter: (...args: unknown[]) => inv('import-online-filter', ...args),
    switchIngameFilter: (filterName: string, currentFilter?: string) =>
      inv('switch-ingame-filter', filterName, currentFilter),

    // ----- filter editing -----
    getColorFrequencies: () => inv('get-color-frequencies'),
    saveBlockEdit: (idx: number, block: unknown, itemJson?: string) => inv('save-block-edit', idx, block, itemJson),
    reloadFilter: () => inv('reload-filter'),
    getUniqueVisibility: () => inv('get-unique-visibility'),
    lookupBaseType: (...args: unknown[]) => inv('lookup-base-type', ...args),
    getUniquesForBase: (baseType: string) => inv('get-uniques-for-base', baseType),
    getSearchableItems: () => inv('get-searchable-items'),
    getDivCardTiers: () => inv('get-div-card-tiers'),
    batchLookupDivCardPrices: (cardNames: string[], league: string) =>
      inv('batch-lookup-div-card-prices', cardNames, league),
    batchLookupPrices: (baseTypes: string[], league: string, uniqueTier?: boolean) =>
      inv('batch-lookup-prices', baseTypes, league, uniqueTier),
    batchLookupRefPrices: (refs: unknown[], league: string) => inv('batch-lookup-ref-prices', refs, league),
    sisterOpenPriceCheck: (ref: unknown) => inv('sister-open-price-check', ref),
    moveItemTier: (...args: unknown[]) => inv('move-item-tier', ...args),
    batchMoveItemTier: (...args: unknown[]) => inv('batch-move-item-tier', ...args),
    updateStackThresholds: (...args: unknown[]) => inv('update-stack-thresholds', ...args),
    updateQualityThresholds: (...args: unknown[]) => inv('update-quality-thresholds', ...args),
    updateStrandThresholds: (...args: unknown[]) => inv('update-strand-thresholds', ...args),
    getHistory: () => inv('get-history'),
    undoEdit: (itemJson?: string) => inv('undo-edit', itemJson),
    listVersions: () => inv('list-versions'),
    createCheckpoint: (label?: string) => inv('create-checkpoint', label),
    restoreVersion: (filename: string, itemJson?: string) => inv('restore-version', filename, itemJson),
    deleteVersion: (filename: string) => inv('delete-version', filename),

    // ----- overlay state -----
    getOverlayState: () => inv('get-overlay-state'),
    getIconCache: () => inv('get-icon-cache'),
    refreshPrices: () => inv('refresh-prices'),

    // ----- trade -----
    tradeSearch: (...args: unknown[]) => inv('trade-search', ...args),
    bulkExchange: (...args: unknown[]) => inv('bulk-exchange', ...args),
    checkBulkItem: (...args: unknown[]) => inv('check-bulk-item', ...args),
    mapRegexTrade: (params: unknown) => inv('map-regex-trade', params),
    fetchMoreListings: (queryId: string, ids: string[]) => inv('fetch-more-listings', queryId, ids),
    visitHideout: (...args: unknown[]) => {
      console.warn('[companion] visitHideout not available in companion mode')
      return Promise.resolve('not-available')
    },
    whisperSeller: (...args: unknown[]) => {
      console.warn('[companion] whisperSeller not available in companion mode')
      return Promise.resolve('not-available')
    },
    poeLogin: () => inv('poe-login'),
    poeCheckAuth: () => inv('poe-check-auth'),
    poeLogout: () => inv('poe-logout'),
    openExternal: (url: string) => inv('open-external', url),

    // ----- online sync -----
    checkForOnlineUpdate: () => inv('check-online-update'),
    quickUpdateFilter: () => inv('quick-update-filter'),
    mergeOnlineFilter: (...args: unknown[]) => inv('merge-online-filter', ...args),

    // ----- updater -----
    downloadUpdate: () => inv('download-update'),
    installUpdate: () => inv('install-update'),
    getUpdateState: () => inv('get-update-state'),
    devFakeUpdate: (version: string) => inv('dev-fake-update', version),

    // ----- diagnostics -----
    reportRendererError: (payload: unknown) => snd('diagnostics:renderer-error', payload),
    createBugReport: () => inv('diagnostics:create-report'),
    showBugReport: (reportPath: string) => inv('diagnostics:show-report', reportPath),

    // ----- app window (no-ops in companion mode) -----
    setAppWindowMode: () => {},
    openDevTools: () => {},
    closeOverlay: () => snd('close-overlay'),
    reportPanelRect: () => {}, // no-op: no panel rect tracking in browser
    lockInteractive: () => {},
    unlockInteractive: () => {},
    suspendHotkeys: () => {},
    resumeHotkeys: () => {},
    setOverlayInputFocused: () => {},
    suspendInputHook: () => Promise.resolve(),
    resumeInputHook: () => Promise.resolve(),
    reportRegex: () => {},
    recordPrefObservation: (...args: unknown[]) => snd('record-pref-observation', ...args),
    resetLearning: (scope: unknown) => inv('reset-learning', scope),
    regexRemoteMountState: () => Promise.resolve(null),
    regexRemoteApply: () => {},
    closeRegexRemote: () => {},
    regexRemoteHandFocus: () => {},

    // ----- cheat sheets (secondary overlay -- no-ops) -----
    addCheatSheetFromFile: (...args: unknown[]) => inv('cheat-sheet:add-from-file', ...args),
    addCheatSheetFromUrl: (...args: unknown[]) => inv('cheat-sheet:add-from-url', ...args),
    removeCheatSheet: (...args: unknown[]) => inv('cheat-sheet:remove', ...args),
    removeCheatSheetCategory: (id: string) => inv('cheat-sheet:remove-category', id),
    listCheatSheetPrefabs: () => inv('cheat-sheet:list-prefabs'),
    importCheatSheetPrefab: (slug: string) => inv('cheat-sheet:import-prefab', slug),
    pinnedZoneSetVisible: () => {},
    pinnedZoneSetContentHeight: () => {},
    closeCheatSheets: () => {},
    minimizeCheatSheets: () => {},
    restoreCheatSheets: () => {},
    openSettingsTab: () => {},
    showCheatSheetPreview: () => {},
    hideCheatSheetPreview: () => {},
    respondGameSwitch: () => {},
    saveOverlayState: () => {},

    // ----- clipboard -----
    clipboardReadImage: () => inv('clipboard:read-image'),

    // ----- client log -----
    getRecentLogLines: (count?: number) => inv('client-log:recent-lines', count),

    // ----- plugins -----
    listInstalledPlugins: () => inv('plugins:list-installed'),
    listUnpackedPlugins: () => inv('plugins:list-unpacked'),
    getInstalledPlugin: (id: string) => inv('plugins:get-installed', id),
    pluginStorageGet: (id: string, key: string) => inv('plugins:storage-get', id, key),
    pluginStorageSet: (id: string, key: string, value: unknown) => inv('plugins:storage-set', id, key, value),
    pluginStorageDelete: (id: string, key: string) => inv('plugins:storage-delete', id, key),
    pluginStorageKeys: (id: string) => inv('plugins:storage-keys', id),
    pluginRegisterHotkey: (...args: unknown[]) => inv('plugins:register-hotkey', ...args),
    pluginListRegisteredHotkeys: () => inv('plugins:list-registered-hotkeys'),
    pluginRegisterTab: (...args: unknown[]) => inv('plugins:register-tab', ...args),
    pluginUnregisterTab: (id: string) => inv('plugins:unregister-tab', id),
    pluginListRegisteredTabs: () => inv('plugins:list-registered-tabs'),
    pluginInstallUnpacked: () => inv('plugins:install-unpacked'),
    pluginFetchRegistry: () => inv('plugins:fetch-registry'),
    pluginInstallFromRegistry: (entry: unknown) => inv('plugins:install-from-registry', entry),
    pluginUninstall: (id: string) => inv('plugins:uninstall', id),
    pluginUnregisterHotkey: (id: string) => inv('plugins:unregister-hotkey', id),
    pluginTriggerMainHotkey: () => inv('plugins:trigger-main-hotkey'),
    pluginShowOverlay: () => inv('plugins:show-overlay'),
    pluginRegisterOverlay: (...args: unknown[]) => inv('plugins:register-overlay', ...args),
    pluginOpenOverlay: (id: string) => inv('plugins:open-overlay', id),
    pluginCloseOverlay: (id: string) => inv('plugins:close-overlay', id),

    // ----- game config -----
    gameConfigRead: () => inv('plugins:game-config-read'),
    gameConfigWrite: (content: string) => inv('plugins:game-config-write', content),

    // ----- whiteboard -----
    whiteboard: {
      load: (version: 1 | 2, gameSize: { w: number; h: number }) => inv('whiteboard:load', version, gameSize),
      saveActive: (version: 1 | 2, state: unknown) => snd('whiteboard:save-active', version, state),
      saveAsSnapshot: (version: 1 | 2, payload: unknown) => inv('whiteboard:save-as-snapshot', version, payload),
      deleteSnapshot: (version: 1 | 2, payload: unknown) => inv('whiteboard:delete-snapshot', version, payload),
      renameSnapshot: (version: 1 | 2, payload: unknown) => inv('whiteboard:rename-snapshot', version, payload),
      requestClose: () => {},
      setMode: () => {},
      reportToolbarRects: () => {},
      clearToolbarRect: () => {},
      requestShownState: () => {},
      onPleaseFlush: (cb: () => void) => sub('whiteboard:please-flush', cb),
      onShown: (cb: () => void) => sub('whiteboard:shown', cb),
      onHidden: (cb: () => void) => sub('whiteboard:hidden', cb),
    },

    // ----- push event subscriptions (same names as preload) -----
    onDevDiagnosticError: (cb: (...a: unknown[]) => void) => sub('diagnostics:dev-error', cb),
    onIconCacheUpdated: (cb: (...a: unknown[]) => void) => sub('icon-cache-updated', cb),
    onRegexRemoteMountChanged: (cb: (...a: unknown[]) => void) => sub('regex-remote:mount-changed', cb),
    onCheatSheetFocusCategory: (cb: (...a: unknown[]) => void) => sub('cheat-sheet:focus-category', cb),
    onSecondaryOverlaySnapGhost: (cb: (...a: unknown[]) => void) => sub('secondary-overlay-canvas:snap-ghost', cb),
    onCheatSheetPreview: (cb: (...a: unknown[]) => void) => sub('cheat-sheet-preview:render', cb),
    onOverlayData: (cb: (...a: unknown[]) => void) => sub('overlay-data', cb),
    onCursorSide: (cb: (...a: unknown[]) => void) => sub('cursor-side', cb),
    onNoFilterLoaded: (cb: (...a: unknown[]) => void) => sub('no-filter-loaded', cb),
    onNoItemInClipboard: (cb: (...a: unknown[]) => void) => sub('no-item-in-clipboard', cb),
    onOpenSettings: (cb: (...a: unknown[]) => void) => sub('open-settings', cb),
    onOpenView: (cb: (...a: unknown[]) => void) => sub('open-view', cb),
    onOpenLinkPending: (cb: (...a: unknown[]) => void) => sub('open-link-pending', cb),
    onOverlayHide: (cb: (...a: unknown[]) => void) => sub('overlay-hide', cb),
    onSettingUpdated: (cb: (...a: unknown[]) => void) => sub('setting-updated', cb),
    onLeagueUpdated: (cb: (...a: unknown[]) => void) => sub('league-updated', cb),
    onSkipAnimation: (cb: (...a: unknown[]) => void) => sub('skip-animation', cb),
    onPoeVersion: (cb: (...a: unknown[]) => void) => sub('poe-version', cb),
    onZoneChanged: (cb: (...a: unknown[]) => void) => sub('zone-changed', cb),
    onLogLine: (cb: (...a: unknown[]) => void) => {
      // Also send subscribe/unsubscribe signals
      snd('client-log:subscribe')
      const unsub = sub('client-log:line', cb)
      return () => {
        snd('client-log:unsubscribe')
        unsub()
      }
    },
    onGameConfigChange: (cb: (...a: unknown[]) => void) => {
      snd('plugins:game-config-watch')
      const unsub = sub('plugins:game-config-changed', cb)
      return () => {
        snd('plugins:game-config-unwatch')
        unsub()
      }
    },
    onOverlayDetach: (cb: (...a: unknown[]) => void) => sub('overlay-detach', cb),
    onOverlayReattach: (cb: (...a: unknown[]) => void) => sub('overlay-reattach', cb),
    onPriceCheckOpen: (cb: (...a: unknown[]) => void) => sub('price-check-open', cb),
    onFilterHotkeyOpen: (cb: (...a: unknown[]) => void) => sub('filter-hotkey-open', cb),
    onGameSwitchPrompt: (cb: (...a: unknown[]) => void) => sub('game-switch-prompt', cb),
    onPriceCheck: (cb: (...a: unknown[]) => void) => sub('price-check', cb),
    onGameBounds: (cb: (...a: unknown[]) => void) => sub('game-bounds', cb),
    onElevationHint: (cb: (...a: unknown[]) => void) => sub('elevation-hint', cb),
    onRateLimit: (cb: (...a: unknown[]) => void) => sub('rate-limit', cb),
    onTradePenalty: (cb: (...a: unknown[]) => void) => sub('trade-penalty', cb),
    onOnlineFilterChanged: (cb: (...a: unknown[]) => void) => sub('online-filter-changed', cb),
    onFilterChanged: (cb: (...a: unknown[]) => void) => sub('filter-changed', cb),
    onUpdateAvailable: (cb: (...a: unknown[]) => void) => sub('update-available', cb),
    onUpdateDownloadProgress: (cb: (...a: unknown[]) => void) => sub('update-download-progress', cb),
    onUpdateDownloaded: (cb: (...a: unknown[]) => void) => sub('update-downloaded', cb),
    onUpdateRescinded: (cb: (...a: unknown[]) => void) => sub('update-rescinded', cb),
    onUpdateApplied: (cb: (...a: unknown[]) => void) => sub('update-applied', cb),
    onBrickedRelease: (cb: (...a: unknown[]) => void) => sub('bricked-release', cb),
    onPluginMacro: (cb: (...a: unknown[]) => void) => sub('plugin-macro', cb),
    onPluginInstalled: (cb: (...a: unknown[]) => void) => sub('plugin-installed', cb),
    onPluginUninstalled: (cb: (...a: unknown[]) => void) => sub('plugin-uninstalled', cb),
    onPluginHotkeysChanged: (cb: (...a: unknown[]) => void) => sub('plugin-hotkeys-changed', cb),
    onPluginTabsChanged: (cb: (...a: unknown[]) => void) => sub('plugin-tabs-changed', cb),
    onRegexPresetsChanged: (cb: (...a: unknown[]) => void) => sub('regex-presets-changed', cb),
    onPluginOverlayInit: (cb: (...a: unknown[]) => void) => sub('plugin-overlay:init', cb),
  }
}

// ---------------------------------------------------------------------------
// Public: install the shim
// ---------------------------------------------------------------------------
let _client: CompanionWsClient | null = null

export async function installCompanionApi(): Promise<void> {
  const url = resolveWsUrl()
  const client = new CompanionWsClient(url)
  _client = client
  await client.connect()

  const api = buildApi(client)
  // Install as window.api to match the Electron preload contract
  ;(window as unknown as { api: typeof api }).api = api
}

export function getCompanionClient(): CompanionWsClient | null {
  return _client
}
