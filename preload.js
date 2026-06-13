/**
 * preload.js — MU'UJIZA LIS
 * Runs in the renderer context but has access to Node APIs.
 * Exposes only what the app needs — nothing more.
 */

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronLIS', {
  // App version for About dialog
  version: process.env.npm_package_version || '2.0.0',
  // Platform detection (so app can adjust UI if needed)
  platform: process.platform,
  // Let renderer signal the main process (e.g. for logout confirm bypass)
  send: (channel, data) => {
    const allowed = ['lis-ready', 'lis-logout']
    if (allowed.includes(channel)) ipcRenderer.send(channel, data)
  },
})
