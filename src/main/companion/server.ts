/**
 * Companion HTTP + WebSocket Server
 *
 * Serves the companion renderer bundle over HTTP on localhost and
 * multiplexes all window.api IPC calls over a single WebSocket connection.
 *
 * Protocol (JSON frames over WebSocket):
 *
 *   Client -> Server (invoke):
 *     { type: 'invoke', id: number, method: string, args: unknown[] }
 *   Server -> Client (invoke reply):
 *     { type: 'reply', id: number, result: unknown }
 *     { type: 'reply', id: number, error: string }
 *
 *   Client -> Server (send, fire-and-forget):
 *     { type: 'send', method: string, args: unknown[] }
 *
 *   Server -> Client (push event from main process):
 *     { type: 'event', channel: string, args: unknown[] }
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { WebSocketServer, type WebSocket } from 'ws'
import type Store from 'electron-store'
import type { AppSettings, FilterBlock, GameVariant, PoeItem } from '../../shared/types'
import type { RegexPreset } from '../../shared/types'
import type { ProfileSettingKey, ProfileSettingValue } from '../profiles/profile-settings'
import { wsBridge } from './ws-bridge'

// ---------------------------------------------------------------------------
// MIME map for static file serving
// ---------------------------------------------------------------------------
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
}

// ---------------------------------------------------------------------------
// Dispatch table
// ---------------------------------------------------------------------------
type DispatchFn = (args: unknown[]) => Promise<unknown> | unknown

function reg(table: Map<string, DispatchFn>, method: string, fn: DispatchFn): void {
  table.set(method, fn)
}

async function buildDispatchTable(store: Store<AppSettings>): Promise<Map<string, DispatchFn>> {
  const table = new Map<string, DispatchFn>()

  // Import all business-logic modules once at table-build time.
  const [
    profileSettings,
    manifestModule,
    historyModule,
    versionsModule,
    filterStateModule,
    iconCacheModule,
    pricesModule,
    settingsWriteModule,
    learningModule,
    tailBufferModule,
    pluginManagerModule,
    pluginStorageModule,
    whiteboardModule,
    leaguesModule,
    filesModule,
  ] = await Promise.all([
    import('../profiles/profile-settings'),
    import('../manifest'),
    import('../history'),
    import('../update/versions'),
    import('../filter-state'),
    import('../trade/icon-cache'),
    import('../trade/prices'),
    import('../settings-write'),
    import('../learning/index'),
    import('../client-log/tail-buffer'),
    import('../plugins/manager'),
    import('../plugins/storage'),
    import('../whiteboard'),
    import('../trade/leagues'),
    import('../handlers/files'),
  ])

  // ----- settings / profiles -----
  reg(table, 'get-settings', () => profileSettings.getEffectiveSettings(store))

  reg(table, 'get-color-frequencies', () => filterStateModule.getColorFrequencies())

  reg(table, 'list-profiles', () => profileSettings.listProfileSummaries(store))

  reg(table, 'create-profile', (args) => {
    const [input] = args as [{ name: string; gameVariant: 1 | 2; cloneFromId?: string }]
    return profileSettings.createProfile(input)
  })
  reg(table, 'rename-profile', (args) => {
    const [id, name] = args as [string, string]
    return profileSettings.renameProfile(id, name)
  })
  reg(table, 'delete-profile', (args) => {
    const [id] = args as [string]
    profileSettings.deleteProfileAndChooseFallback(store, id)
  })
  reg(table, 'ensure-profile-for-game', (args) => {
    const [variant] = args as [1 | 2]
    profileSettings.ensureProfileForGame(store, variant)
  })

  reg(table, 'set-setting', (args) => {
    const [key, value] = args as [keyof AppSettings, unknown]
    settingsWriteModule.applySetting(store, key, value as AppSettings[typeof key], null)
  })

  reg(table, 'set-profile-setting-for-game', (args) => {
    const [variant, key, value] = args as [GameVariant, ProfileSettingKey, ProfileSettingValue<ProfileSettingKey>]
    return settingsWriteModule.applyProfileSettingForGame(store, variant, key, value, null)
  })

  reg(table, 'refresh-leagues', async () => {
    // refreshLeagues takes (store, fetcher, options); pass store explicitly
    return leaguesModule.refreshLeagues(
      store,
      undefined as unknown as Parameters<typeof leaguesModule.refreshLeagues>[1],
      { force: true },
    )
  })

  reg(table, 'get-regex-presets', () => {
    const key = store.get('poeVersion') === 2 ? 'regexPresetsPoe2' : 'regexPresetsPoe1'
    return store.get(key) ?? []
  })
  reg(table, 'save-regex-preset', (args) => {
    const [preset] = args as [{ id: string; label: string; text: string }]
    const key = store.get('poeVersion') === 2 ? 'regexPresetsPoe2' : 'regexPresetsPoe1'
    const current = (store.get(key) ?? []) as RegexPreset[]
    const idx = current.findIndex((p) => p.id === preset.id)
    // biome-ignore lint/suspicious/noExplicitAny: preset shape varies at runtime
    if (idx >= 0) current[idx] = preset as any
    // biome-ignore lint/suspicious/noExplicitAny: preset shape varies at runtime
    else current.push(preset as any)
    store.set(key, current)
    wsBridge.push('regex-presets-changed')
    return current
  })
  reg(table, 'delete-regex-preset', (args) => {
    const [id] = args as [string]
    const key = store.get('poeVersion') === 2 ? 'regexPresetsPoe2' : 'regexPresetsPoe1'
    const current = ((store.get(key) ?? []) as { id: string }[]).filter((p) => p.id !== id)
    store.set(key, current)
    wsBridge.push('regex-presets-changed')
    return current
  })

  // ----- manifest -----
  reg(table, 'get-manifest', () => manifestModule.getManifest())

  // ----- files -----
  reg(table, 'pick-filter-file', () => filesModule.pickFilterFile(store))
  reg(table, 'pick-filter-dir', () => filesModule.pickFilterDir(store))
  reg(table, 'scan-filter-dir', (args) => {
    const [dir] = args as [string]
    return filesModule.scanFilterDir(dir)
  })
  reg(table, 'scan-sound-files', (args) => {
    const [dir] = args as [string]
    return filesModule.scanSoundFiles(dir)
  })
  reg(table, 'get-sound-data-url', (args) => {
    const [dir, filename] = args as [string, string]
    return filesModule.getSoundDataUrl(dir, filename)
  })

  // ----- history / versions -----
  reg(table, 'get-history', () => historyModule.getHistory())
  reg(table, 'list-versions', () => {
    const profile = profileSettings.getActiveProfile(store)
    if (!profile?.filterPath) return []
    return versionsModule.listVersions(profile.filterPath)
  })
  reg(table, 'create-checkpoint', (args) => {
    const [label] = args as [string | undefined]
    const profile = profileSettings.getActiveProfile(store)
    if (!profile?.filterPath) return { ok: false, error: 'No filter loaded' }
    versionsModule.saveVersion(profile.filterPath, true, label ?? 'Manual checkpoint')
    return { ok: true }
  })
  reg(table, 'restore-version', async (args) => {
    const [filename, itemJson] = args as [string, string | undefined]
    const profile = profileSettings.getActiveProfile(store)
    if (!profile?.filterPath) return { ok: false, error: 'No filter loaded' }
    const result = versionsModule.restoreVersion(profile.filterPath, filename)
    if (result.ok) {
      filterStateModule.loadFilter(profile.filterPath)
      historyModule.clearHistory()
      if (itemJson) {
        const { evaluateAndSend } = await import('../evaluation')
        evaluateAndSend(JSON.parse(itemJson) as PoeItem)
      }
    }
    return result
  })
  reg(table, 'delete-version', (args) => {
    const [filename] = args as [string]
    return versionsModule.deleteVersion(filename)
  })
  reg(table, 'undo-edit', async (args) => {
    const [itemJson] = args as [string | undefined]
    const profile = profileSettings.getActiveProfile(store)
    if (!profile?.filterPath) return { ok: false, error: 'No filter loaded' }
    const result = historyModule.undoLast(profile.filterPath)
    if (result.ok) {
      filterStateModule.loadFilter(profile.filterPath)
      if (itemJson) {
        const { evaluateAndSend } = await import('../evaluation')
        evaluateAndSend(JSON.parse(itemJson) as PoeItem)
      }
    }
    return result
  })

  // ----- prices -----
  reg(table, 'get-icon-cache', () => {
    const v = (store.get('poeVersion') ?? 2) as 1 | 2
    return iconCacheModule.loadIconCache(v)
  })
  reg(table, 'get-uniques-for-base', (args) => {
    const [baseType] = args as [string]
    return pricesModule.getUniquesByBase()[baseType] ?? []
  })
  reg(table, 'refresh-prices', async () => {
    const league = profileSettings.getProfileBackedSetting(store, 'league')
    await pricesModule.refreshPrices(league)
  })
  reg(table, 'batch-lookup-prices', async (args) => {
    const [baseTypes, league, uniqueTier] = args as [string[], string, boolean | undefined]
    await pricesModule.refreshPrices(league)
    const result: Record<string, { chaosValue: number; divineValue?: number } | null> = {}
    for (const bt of baseTypes) {
      result[bt] =
        (uniqueTier ? pricesModule.lookupBestUniquePrice(bt) : undefined) ?? pricesModule.lookupPrice(bt, bt) ?? null
    }
    return result
  })
  reg(table, 'batch-lookup-ref-prices', async (args) => {
    const [refs, league] = args as [Array<{ name: string; baseType?: string }>, string]
    await pricesModule.refreshPrices(league)
    const result: Record<string, { chaosValue: number; divineValue?: number } | null> = {}
    for (const r of refs) {
      result[r.name] = pricesModule.lookupPrice(r.name, r.baseType ?? r.name) ?? null
    }
    return result
  })
  reg(table, 'batch-lookup-div-card-prices', async (args) => {
    const [cardNames, league] = args as [string[], string]
    await pricesModule.refreshPrices(league)
    const result: Record<string, { chaosValue: number; divineValue?: number } | null> = {}
    for (const name of cardNames) {
      result[name] = pricesModule.lookupDivCardPrice(name) ?? null
    }
    return result
  })
  reg(table, 'get-unique-visibility', async () => {
    if (!filterStateModule.getCurrentFilter()) return {}
    const pricesHandler = await import('../handlers/prices')
    await pricesHandler.primeSearchableItemsCache(store)
    const f = filterStateModule.getCurrentFilter()
    if (!f) return {}
    const result: Record<string, 'Show' | 'Hide'> = {}
    for (const block of f.blocks) {
      if (block.visibility !== 'Hide') continue
      const hasUniqueCond = block.conditions.some((c) => c.type === 'Rarity' && c.values.includes('Unique'))
      if (!hasUniqueCond) continue
      for (const cond of block.conditions) {
        if (cond.type === 'BaseType') {
          for (const v of cond.values) result[v] = 'Hide'
        }
      }
    }
    return result
  })
  reg(table, 'get-div-card-tiers', () => {
    const f = filterStateModule.getCurrentFilter()
    if (!f) return { tierStyles: {}, cardTiers: {}, hiddenCards: {} }
    const tierStyles: Record<string, { border: string; bg: string; text: string }> = {}
    const cardTiers: Record<string, string> = {}
    const hiddenCards: Record<string, boolean> = {}
    const toRgba = (a: { values: string[] }): string => {
      const [r, g, b, alpha] = a.values.map(Number)
      return `rgba(${r ?? 0},${g ?? 0},${b ?? 0},${(alpha ?? 255) / 255})`
    }
    for (const block of f.blocks) {
      if (!block.tierTag || block.tierTag.typePath !== 'divination') continue
      const tier = block.tierTag.tier
      const isHidden = block.visibility === 'Hide'
      const border = block.actions.find((a) => a.type === 'SetBorderColor')
      const bg = block.actions.find((a) => a.type === 'SetBackgroundColor')
      const text = block.actions.find((a) => a.type === 'SetTextColor')
      tierStyles[tier] = {
        border: border ? toRgba(border) : 'transparent',
        bg: bg ? toRgba(bg) : 'transparent',
        text: text ? toRgba(text) : '#fff',
      }
      for (const cond of block.conditions) {
        if (cond.type === 'BaseType') {
          for (const v of cond.values) {
            cardTiers[v] = tier
            if (isHidden) hiddenCards[v] = true
          }
        }
      }
    }
    return { tierStyles, cardTiers, hiddenCards }
  })
  reg(table, 'get-searchable-items', async () => {
    const pricesHandler = await import('../handlers/prices')
    await pricesHandler.primeSearchableItemsCache(store)
    // Return empty; the cache is not directly exported; caller can use batch-lookup-prices
    return []
  })

  // ----- trade -----
  reg(table, 'trade-search', async (args) => {
    const [item, statFilters, searchOptions] = args as [
      {
        name: string
        baseType: string
        itemClass: string
        rarity: string
        armour?: number
        evasion?: number
        energyShield?: number
        ward?: number
        block?: number
        vaalGem?: boolean
      },
      Parameters<typeof import('../trade/trade').searchTrade>[2],
      { listedTime?: string; priceOption?: string; statusOption?: string } | undefined,
    ]
    const { searchTrade, searchNeedsLogin } = await import('../trade/trade')
    const league = profileSettings.getProfileBackedSetting(store, 'league')
    const status = searchOptions?.statusOption ?? store.get('tradeStatus') ?? 'available'
    const price =
      searchOptions?.priceOption ?? profileSettings.getProfileBackedSetting(store, 'tradePriceOption') ?? 'chaos_divine'
    const collapse = store.get('tradeCollapseListings') ?? true
    const { session } = await import('electron')
    const cookie = await session.defaultSession.cookies.get({ name: 'POESESSID' })
    const loggedIn = searchNeedsLogin(statFilters as Parameters<typeof searchNeedsLogin>[0]) ? cookie.length > 0 : true
    return searchTrade(league, item, statFilters as Parameters<typeof searchTrade>[2], {
      tradeStatus: status,
      tradePriceOption: price as string,
      listedTime: searchOptions?.listedTime,
      collapseListings: collapse as boolean,
      loggedIn,
    })
  })
  reg(table, 'bulk-exchange', async (args) => {
    const [itemName, baseType, haveId] = args as [string, string, string | undefined]
    const { searchBulkExchange, getBulkExchangeId } = await import('../trade/trade')
    const league = profileSettings.getProfileBackedSetting(store, 'league')
    const wantId = getBulkExchangeId(itemName, baseType)
    if (!wantId) return { total: 0, listings: [], queryId: '' }
    return searchBulkExchange(league, wantId, haveId ?? 'chaos')
  })
  reg(table, 'check-bulk-item', async (args) => {
    const [itemName, baseType, itemClass, rarity] = args as [string, string, string, string | undefined]
    const { isBulkExchangeItem } = await import('../trade/trade')
    return isBulkExchangeItem(itemClass, itemName, baseType, rarity)
  })
  reg(table, 'map-regex-trade', async (args) => {
    const [params] = args as [
      {
        tier: number
        avoidTexts: string[]
        wantTexts: string[]
        wantMode: 'any' | 'all'
        qualifiers: Record<string, number>
        nightmare: boolean
        originator: boolean
        corrupted8mod: boolean
      },
    ]
    const { searchMapsByRegex } = await import('../trade/trade')
    const league = profileSettings.getProfileBackedSetting(store, 'league')
    const tradeStatus = store.get('tradeStatus') ?? 'available'
    const tradePriceOption = profileSettings.getProfileBackedSetting(store, 'tradePriceOption') ?? 'chaos_divine'
    const collapse = store.get('tradeCollapseListings') ?? true
    const result = await searchMapsByRegex(
      league,
      params.tier,
      params.avoidTexts,
      params.wantTexts,
      params.wantMode,
      params.qualifiers,
      params.nightmare,
      params.originator,
      params.corrupted8mod,
      tradeStatus as string,
      tradePriceOption as string,
      collapse as boolean,
    )
    return { ...result, league }
  })
  reg(table, 'fetch-more-listings', async (args) => {
    const [queryId, ids] = args as [string, string[]]
    const { fetchMoreListings } = await import('../trade/trade')
    return fetchMoreListings(queryId, ids)
  })
  reg(table, 'poe-login', async () => {
    // Open the real Electron login window so POESESSID lands in the Electron
    // session (not the browser's session). The ipcMain handler for poe-login
    // is registered by tradeHandlers.register(store) -- call it directly here.
    const { BrowserWindow } = await import('electron')
    const { POE_WEBSITE } = await import('../../shared/endpoints')
    return new Promise<void>((resolve) => {
      const LOGIN_TITLE = 'Login - Path of Exile'
      const loginWindow = new BrowserWindow({
        width: 800,
        height: 700,
        title: LOGIN_TITLE,
        autoHideMenuBar: true,
        webPreferences: { nodeIntegration: false, contextIsolation: true },
      })
      loginWindow.webContents.on('page-title-updated', (event) => {
        event.preventDefault()
        loginWindow.setTitle(LOGIN_TITLE)
      })
      loginWindow.loadURL(`${POE_WEBSITE}/login`)
      loginWindow.webContents.on('did-navigate', (_event, url) => {
        if (url.includes('pathofexile.com/my-account') || url === `${POE_WEBSITE}/`) {
          loginWindow.close()
        }
      })
      loginWindow.on('closed', () => resolve())
    })
  })
  reg(table, 'poe-check-auth', async () => {
    const { session } = await import('electron')
    const cookie = await session.defaultSession.cookies.get({ name: 'POESESSID' })
    return { loggedIn: cookie.length > 0 }
  })
  reg(table, 'poe-logout', async () => {
    const { session } = await import('electron')
    await session.defaultSession.cookies.remove('https://www.pathofexile.com', 'POESESSID')
  })
  reg(table, 'open-external', async (args) => {
    const { shell } = await import('electron')
    await shell.openExternal(args[0] as string)
  })

  // ----- overlay state (synthetic values for companion mode) -----
  reg(table, 'get-overlay-state', () => ({
    poeVersion: store.get('poeVersion') ?? 2,
    gameBounds: null, // no overlay window in companion mode
  }))

  // ----- filter editing -----
  reg(table, 'reload-filter', () => {
    const f = filterStateModule.getCurrentFilter()
    if (!f) return { ok: false, error: 'No filter loaded' }
    filterStateModule.loadFilter(f.path)
    return { ok: true }
  })
  reg(table, 'save-block-edit', async (args) => {
    const [blockIndex, updatedBlock, itemJson] = args as [number, FilterBlock, string | undefined]
    const f = filterStateModule.getCurrentFilter()
    if (!f) return { ok: false, error: 'No filter loaded' }
    try {
      const { writeBlockEdit } = await import('../filter/writer')
      const { captureSnapshot } = await import('../history')
      captureSnapshot(f.path, 'block-edit', `Block edit #${blockIndex + 1}`, undefined)
      writeBlockEdit(f, blockIndex, updatedBlock)
      const profile = profileSettings.getActiveProfile(store)
      if (profile?.filterPath) filterStateModule.loadFilter(profile.filterPath)
      const fresh = filterStateModule.getCurrentFilter()
      if (fresh && itemJson) {
        const { evaluateAndSend } = await import('../evaluation')
        evaluateAndSend(JSON.parse(itemJson) as PoeItem)
      }
      return { ok: true }
    } catch (err) {
      return { ok: false, error: String(err) }
    }
  })
  reg(table, 'move-item-tier', async (args) => {
    const [baseType, from, to, itemJson] = args as [string, number, number, string]
    const f = filterStateModule.getCurrentFilter()
    if (!f) return { ok: false, error: 'No filter loaded' }
    try {
      const { moveBaseTypeBetweenTiers } = await import('../filter/writer')
      const { captureSnapshot } = await import('../history')
      captureSnapshot(f.path, 'tier-move', `Moved "${baseType}"`, baseType)
      moveBaseTypeBetweenTiers(f, baseType, from, to)
      const profile = profileSettings.getActiveProfile(store)
      if (profile?.filterPath) filterStateModule.loadFilter(profile.filterPath)
      if (itemJson) {
        const fresh = filterStateModule.getCurrentFilter()
        if (fresh) {
          const { evaluateAndSend } = await import('../evaluation')
          evaluateAndSend(JSON.parse(itemJson) as PoeItem)
        }
      }
      return { ok: true }
    } catch (err) {
      return { ok: false, error: String(err) }
    }
  })
  reg(table, 'batch-move-item-tier', async (args) => {
    const [baseTypes, from, to, itemJson] = args as [string[], number, number, string]
    const f = filterStateModule.getCurrentFilter()
    if (!f) return { ok: false, error: 'No filter loaded' }
    try {
      const { moveBaseTypeBetweenTiers } = await import('../filter/writer')
      const { captureSnapshot } = await import('../history')
      captureSnapshot(f.path, 'tier-move', `Batch moved ${baseTypes.length} items`, undefined)
      for (const bt of baseTypes) moveBaseTypeBetweenTiers(f, bt, from, to)
      const profile = profileSettings.getActiveProfile(store)
      if (profile?.filterPath) filterStateModule.loadFilter(profile.filterPath)
      if (itemJson) {
        const fresh = filterStateModule.getCurrentFilter()
        if (fresh) {
          const { evaluateAndSend } = await import('../evaluation')
          evaluateAndSend(JSON.parse(itemJson) as PoeItem)
        }
      }
      return { ok: true }
    } catch (err) {
      return { ok: false, error: String(err) }
    }
  })
  reg(table, 'update-stack-thresholds', async (args) => {
    const [oldBoundary, newBoundary, itemJson] = args as [number, number, string]
    const f = filterStateModule.getCurrentFilter()
    if (!f) return { ok: false, error: 'No filter loaded' }
    try {
      const { updateStackThresholds } = await import('../filter/writer')
      updateStackThresholds(f, oldBoundary, newBoundary)
      const profile = profileSettings.getActiveProfile(store)
      if (profile?.filterPath) filterStateModule.loadFilter(profile.filterPath)
      const { evaluateAndSend } = await import('../evaluation')
      evaluateAndSend(JSON.parse(itemJson) as PoeItem)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: String(err) }
    }
  })
  reg(table, 'update-quality-thresholds', async (args) => {
    const [oldBoundary, newBoundary, itemJson] = args as [number, number, string]
    const f = filterStateModule.getCurrentFilter()
    if (!f) return { ok: false, error: 'No filter loaded' }
    try {
      const { updateQualityThresholds } = await import('../filter/writer')
      updateQualityThresholds(f, oldBoundary, newBoundary)
      const profile = profileSettings.getActiveProfile(store)
      if (profile?.filterPath) filterStateModule.loadFilter(profile.filterPath)
      const { evaluateAndSend } = await import('../evaluation')
      evaluateAndSend(JSON.parse(itemJson) as PoeItem)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: String(err) }
    }
  })
  reg(table, 'update-strand-thresholds', async (args) => {
    const [oldBoundary, newBoundary, itemJson] = args as [number, number, string]
    const f = filterStateModule.getCurrentFilter()
    if (!f) return { ok: false, error: 'No filter loaded' }
    try {
      const { updateStrandThresholds } = await import('../filter/writer')
      updateStrandThresholds(f, oldBoundary, newBoundary)
      const profile = profileSettings.getActiveProfile(store)
      if (profile?.filterPath) filterStateModule.loadFilter(profile.filterPath)
      const { evaluateAndSend } = await import('../evaluation')
      evaluateAndSend(JSON.parse(itemJson) as PoeItem)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: String(err) }
    }
  })

  // ----- learning -----
  reg(table, 'reset-learning', (args) => {
    const [scope] = args as [unknown]
    learningModule.resetLearning(scope as 'all' | { rarity: string; itemClass: string })
  })

  // ----- client-log -----
  reg(table, 'client-log:recent-lines', (args) => {
    const [count] = args as [number | undefined]
    return tailBufferModule.getRecentLogLines(count ?? 100)
  })

  // ----- plugins (subset usable without the overlay window) -----
  reg(table, 'plugins:list-installed', () => pluginManagerModule.getInstalledPlugins())
  reg(table, 'plugins:storage-get', (args) => {
    const [pluginId, key] = args as [string, string]
    return pluginStorageModule.getValue(pluginId, key)
  })
  reg(table, 'plugins:storage-set', (args) => {
    const [pluginId, key, value] = args as [string, string, unknown]
    pluginStorageModule.setValue(pluginId, key, value)
  })
  reg(table, 'plugins:storage-delete', (args) => {
    const [pluginId, key] = args as [string, string]
    pluginStorageModule.deleteValue(pluginId, key)
  })
  reg(table, 'plugins:storage-keys', (args) => {
    const [pluginId] = args as [string]
    return pluginStorageModule.listKeys(pluginId)
  })

  // ----- whiteboard (persistence) -----
  reg(table, 'whiteboard:load', (args) => {
    const [version, gameSize] = args as [1 | 2, { w: number; h: number }]
    return whiteboardModule.loadLibrary(version, gameSize)
  })
  reg(table, 'whiteboard:save-active', (args) => {
    const [version, state] = args as [1 | 2, Parameters<typeof whiteboardModule.saveLibrary>[1]]
    whiteboardModule.saveLibrary(version, state)
  })

  return table
}

// ---------------------------------------------------------------------------
// Message handling
// ---------------------------------------------------------------------------
interface InvokeFrame {
  type: 'invoke'
  id: number
  method: string
  args: unknown[]
}
interface SendFrame {
  type: 'send'
  method: string
  args: unknown[]
}
type ClientFrame = InvokeFrame | SendFrame

async function handleFrame(frame: ClientFrame, table: Map<string, DispatchFn>, ws: WebSocket): Promise<void> {
  if (frame.type === 'invoke') {
    const { id, method, args } = frame
    try {
      const fn = table.get(method)
      if (!fn) {
        ws.send(JSON.stringify({ type: 'reply', id, error: `Unknown method: ${method}` }))
        return
      }
      const result = await fn(args)
      ws.send(JSON.stringify({ type: 'reply', id, result: result ?? null }))
    } catch (err) {
      ws.send(JSON.stringify({ type: 'reply', id, error: String(err) }))
    }
    return
  }

  if (frame.type === 'send') {
    const { method, args } = frame
    const fn = table.get(method)
    if (fn) void fn(args)
    return
  }
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------
let serverInstance: ReturnType<typeof createServer> | null = null
let wssInstance: WebSocketServer | null = null

export interface CompanionServerOptions {
  store: Store<AppSettings>
  port?: number
  /** Absolute path to the companion renderer build output.
   *  Defaults to out/renderer/companion/ next to the ASAR. */
  staticDir?: string
}

export function startCompanionServer(opts: CompanionServerOptions): void {
  if (serverInstance) return

  const { store, port = 0 } = opts

  const staticDir = opts.staticDir ?? (process.env.ELECTRON_RENDERER_URL ? null : join(__dirname, '../renderer'))

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')

    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    if (process.env.ELECTRON_RENDERER_URL) {
      const devBase = process.env.ELECTRON_RENDERER_URL.replace(/\/$/, '')
      res.writeHead(302, { Location: `${devBase}/companion.html` })
      res.end()
      return
    }

    if (!staticDir) {
      res.writeHead(503)
      res.end('Companion build not available')
      return
    }

    let urlPath = (req.url ?? '/').split('?')[0]
    if (urlPath === '/') urlPath = '/companion.html'

    const extMatch = urlPath.match(/\.[^./]+$/)
    const ext = extMatch ? extMatch[0] : ''
    const contentType = MIME[ext] ?? 'application/octet-stream'
    const filePath = join(staticDir, urlPath)

    try {
      if (!existsSync(filePath)) {
        const indexPath = join(staticDir, 'index.html')
        if (existsSync(indexPath)) {
          const data = await readFile(indexPath)
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
          res.end(data)
        } else {
          res.writeHead(404)
          res.end('Not found')
        }
        return
      }
      const data = await readFile(filePath)
      res.writeHead(200, { 'Content-Type': contentType })
      res.end(data)
    } catch {
      res.writeHead(500)
      res.end()
    }
  })

  const wss = new WebSocketServer({ server: httpServer })
  wssInstance = wss

  let tablePromise: Promise<Map<string, DispatchFn>> | null = null
  function getTable(): Promise<Map<string, DispatchFn>> {
    if (!tablePromise) tablePromise = buildDispatchTable(store)
    return tablePromise
  }

  const onBridgeEvent = ({ channel, args }: { channel: string; args: unknown[] }): void => {
    if (wss.clients.size === 0) return
    const msg = JSON.stringify({ type: 'event', channel, args })
    for (const client of wss.clients) {
      if (client.readyState === client.OPEN) client.send(msg)
    }
  }
  wsBridge.on('event', onBridgeEvent)

  wss.on('connection', (ws: WebSocket) => {
    // When a browser client connects in companion mode, push it into the settings
    // view immediately -- the overlay App starts in 'idle' (hidden) by default
    // and only shows after a hotkey fires, which never happens in companion mode.
    ws.send(JSON.stringify({ type: 'event', channel: 'open-view', args: ['setup'] }))

    ws.on('message', async (raw: Buffer) => {
      let frame: ClientFrame
      try {
        frame = JSON.parse(raw.toString()) as ClientFrame
      } catch {
        return
      }
      const table = await getTable()
      await handleFrame(frame, table, ws)
    })
    ws.on('error', (err) => console.error('[companion] WS error:', err.message))
  })

  httpServer.listen(port, '127.0.0.1', () => {
    const addr = httpServer.address() as { port: number }
    console.log(`[companion] Listening on http://127.0.0.1:${addr.port}`)
  })

  serverInstance = httpServer
}

export function stopCompanionServer(): void {
  wssInstance?.close()
  wssInstance = null
  serverInstance?.close()
  serverInstance = null
}

export function getCompanionPort(): number {
  if (!serverInstance) return -1
  const addr = serverInstance.address()
  if (!addr || typeof addr === 'string') return -1
  return addr.port
}
