/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        startForkUpdater
 * CVM-Role:        Utility function
 * Maintainer:      James C. Morey
 * License:         GNU GPL v3
 *
 * Description:     Fork-only (JamesCMorey/Zettlr): in-place updates for the
 *                  fork's macOS builds. The fork's CI writes
 *                  Resources/fork-build.json into every build it publishes;
 *                  official builds and development runs lack that file, so
 *                  this does nothing there. Squirrel.Mac downloads a newer
 *                  fork release in the background and installs it when
 *                  Zettlr quits.
 *
 * END HEADER
 */

import { app, autoUpdater, dialog } from 'electron'
import { readFileSync } from 'fs'
import path from 'path'
import type LogProvider from '@providers/log'

const FEED_URL = 'https://update.electronjs.org/JamesCMorey/Zettlr'
const CHECK_INTERVAL = 4 * 60 * 60 * 1000 // Four hours

/**
 * Returns the fork version CI recorded in the app bundle, or undefined.
 */
function getForkVersion (): string|undefined {
  try {
    const file = path.join(process.resourcesPath, 'fork-build.json')
    const data: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (data !== null && typeof data === 'object' && 'version' in data && typeof data.version === 'string') {
      return data.version
    }
  } catch (err: unknown) {
    // No fork build: nothing to update from.
  }
  return undefined
}

/**
 * Starts checking for fork updates, if this is a packaged fork build on macOS.
 *
 * @param  {LogProvider}  logger  The logger
 */
export function startForkUpdater (logger: LogProvider): void {
  if (process.platform !== 'darwin' || !app.isPackaged) {
    return
  }

  const version = getForkVersion()
  if (version === undefined) {
    return
  }

  autoUpdater.on('error', (err) => {
    logger.warning(`[Fork Updater] ${err.message}`)
  })

  autoUpdater.on('update-available', () => {
    logger.info('[Fork Updater] An update is available, downloading ...')
  })

  autoUpdater.on('update-not-available', () => {
    logger.verbose(`[Fork Updater] Version ${version} is up to date.`)
  })

  const timer = setInterval(() => { autoUpdater.checkForUpdates() }, CHECK_INTERVAL)

  autoUpdater.on('update-downloaded', (_event, _notes, releaseName) => {
    // One downloaded update is enough until the app restarts.
    clearInterval(timer)
    logger.info(`[Fork Updater] ${releaseName} is downloaded and installs when Zettlr quits.`)
    dialog.showMessageBox({
      type: 'info',
      message: `${releaseName} is ready`,
      detail: 'The update is installed the next time Zettlr quits. Restart Zettlr now?',
      buttons: [ 'Restart now', 'Later' ],
      defaultId: 0,
      cancelId: 1
    }).then(result => {
      if (result.response === 0) {
        autoUpdater.quitAndInstall()
      }
    }).catch(err => logger.error(`[Fork Updater] ${String(err)}`))
  })

  autoUpdater.setFeedURL({ url: `${FEED_URL}/${process.platform}-${process.arch}/${version}` })
  logger.info(`[Fork Updater] Fork version ${version}; checking ${FEED_URL} for updates.`)
  autoUpdater.checkForUpdates()
}
