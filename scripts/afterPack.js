const path = require('node:path')
const fs = require('node:fs')

exports.default = async function afterPack(context) {
  // Remove app-update.yml (we use our own update system, not electron-updater)
  const ymlPath = path.join(context.appOutDir, 'resources', 'app-update.yml')
  if (fs.existsSync(ymlPath)) {
    fs.unlinkSync(ymlPath)
    console.log('[afterPack] Removed app-update.yml')
  }

  // Fix AppRun for Linux AppImage: the auto-generated AppRun tries to find a
  // file named after $1 (the first CLI arg) when detecting APPDIR. This breaks
  // when the first arg is a flag like --companion-mode instead of a filename.
  // Replace the faulty APPDIR detection with a simple dirname-based one.
  if (context.electronPlatformName !== 'linux') return
  const appRunPath = path.join(context.appOutDir, 'AppRun')
  if (!fs.existsSync(appRunPath)) return

  const original = fs.readFileSync(appRunPath, 'utf8')
  const fixed = original.replace(
    // Replace the while-loop APPDIR detection block
    /if \[ -z "\$APPDIR" \] ; then[\s\S]*?APPDIR="\$path"\nfi/,
    `if [ -z "$APPDIR" ] ; then
  APPDIR="$(dirname "$(readlink -f "$0")")"
fi`
  )

  if (fixed !== original) {
    fs.writeFileSync(appRunPath, fixed, 'utf8')
    console.log('[afterPack] Patched AppRun APPDIR detection for flag-only invocations')
  }
}
