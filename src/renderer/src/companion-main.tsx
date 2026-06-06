/**
 * Companion renderer entry point.
 *
 * 1. Installs the WebSocket-backed window.api shim.
 * 2. Bootstraps the theme (reads settings via the shim, applies CSS vars).
 * 3. Mounts the same overlay App component as the Electron renderer.
 *
 * The importmap from index.html is NOT present here because the companion
 * build doesn't use scalpel-internal:// protocol URIs. React is bundled
 * normally by Vite.
 */
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './overlay'
import './styles.css'
import { installCompanionApi } from './companion-api'
import { applyCachedVars, bootstrapTheme } from './shared/apply-theme'
import { DiagnosticErrorBoundary, installRendererDiagnostics } from './shared/diagnostics'

// Apply cached theme immediately to avoid flash
applyCachedVars()
installRendererDiagnostics('companion')

async function main(): Promise<void> {
  // Connect to the main process over WebSocket and expose window.api
  try {
    await installCompanionApi()
  } catch (err) {
    const loadingEl = document.getElementById('companion-loading')
    if (loadingEl) {
      loadingEl.textContent = 'Could not connect to Scalpel. Make sure the app is running with companion mode enabled.'
      loadingEl.style.color = '#ff6b6b'
    }
    console.error('[companion] Failed to connect:', err)
    // Retry silently after 3s -- the WsClient will reconnect on its own
    setTimeout(main, 3000)
    return
  }

  // Reconcile theme with persisted settings
  void bootstrapTheme()

  const root = document.getElementById('root')!
  // Remove the loading placeholder
  root.innerHTML = ''
  createRoot(root).render(
    <StrictMode>
      <DiagnosticErrorBoundary source="companion">
        <App />
      </DiagnosticErrorBoundary>
    </StrictMode>,
  )
}

void main()
