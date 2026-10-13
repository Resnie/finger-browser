# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Finger Browser is an Electron + Vue 3 desktop application for creating and managing fingerprinted browser instances. It uses Playwright to launch Chromium with persistent contexts and injected fingerprint evasion scripts.

## Development Commands

```bash
npm run dev          # Start Vite dev server + Electron
npm run build        # Build renderer (Vue) + main/preload processes
npm run build:mac    # Build + package macOS DMG
npm run build:win    # Build + package Windows NSIS installer
npm run format       # Prettier formatting
```

No test runner is currently configured.

## Architecture

### Process Model (Electron)

```
Main Process (electron/main/)
  ├── index.js              # Entry: creates window, registers all IPC handlers
  ├── browserManager.js     # Browser instance lifecycle (Playwright)
  ├── browserCoreManager.js # Kernel version download/delete IPC
  ├── updateManager.js      # Auto-update from GitHub releases
  └── ipc/
      ├── registry.js       # IPCRegistry - centralized handler registration
      └── emitter.js        # IPCEmitter singleton - main→renderer events

Preload (electron/preload/)
  └── index.js              # contextBridge merges browserManager + updateManager + loggerManager APIs

Renderer (src/)
  └── Vue 3 app with Pinia, Vue Router (hash mode), Element Plus
```

### IPC Communication

Two patterns coexist:
- **invoke/handle** (request-response): Renderer calls `window.ipcRenderer.someMethod()` which maps to `ipcRenderer.invoke(channel, ...)`. Handlers registered via `ipcRegistry.registerHandlers()`.
- **send/on** (events): Main process pushes events via `ipcEmitter.send(channel, data)`. Renderer listens via `globalIpcManager.register()` (singleton, app-lifetime) or `useIpcListener()` (component-scoped, auto-cleanup on unmount).

Preload APIs are defined in `electron/preload/browserManager.js` (browser ops), `updateManager.js` (updates), `loggerManager.js` (logging). All merged into `window.ipcRenderer`.

### Download Event Routing

Download IPC events (`browser-download-start`, `browser-download-progress`, `browser-download-error`, `browser-download-complete`) carry both `id` (browser instance) and `version` fields. The global listener in `src/composables/useDownloadListeners.js` routes:
- `!id && version` → `kernelDownloadInstances` in store (kernel downloads)
- `id` exists → `downloadInstances` in store (instance-level downloads)

### State Management (Pinia)

`src/store/index.js` contains two stores:
- **useUserStore** — auth state, download progress tracking (`downloadInstances` for browser instances, `kernelDownloadInstances` for kernel versions), browser instance status
- **useBrowserVersionStore** — available/selected kernel versions

### API Layer

`src/utils/request.js` — Axios instance pointing to `VITE_APP_BASE_API`. Expects Kratos-style `{ code, message, data }` responses (code 0 = success). Token from localStorage in `Authorization` header. 401 redirects to login.

API modules in `src/api/` (user.js, browser.js, group.js) wrap HTTP calls.

### Browser Instance Lifecycle

`electron/main/models/BrowserInstance.js` — wraps a Playwright persistent browser context. Handles fingerprint injection (`FingerprintInjector`), history tracking (`HistoryManager`), credential storage (`CredentialManager`), and page lifecycle events.

Kernels (Chromium binaries) are stored under `{appPath}/browser/{version}/`. Downloaded as ZIP from GitHub releases, extracted in place. The `activeDownloads` Map in `electron/utils/browser.js` tracks AbortControllers for cancellable downloads.

### Routing

Hash-based routing (`createWebHashHistory`). Navigation guard redirects to `/login` if not authenticated. Main pages: `/` (browser instances), `/browser-kernel` (kernel management), `/account`, `/fingerprint`, `/setting`, `/template`, `/group`.

## Code Conventions

- Vue 3 Composition API with `<script setup>` (no Options API)
- Prettier: single quotes, trailing commas (ES5), 2-space indent, 100-char width, `vueIndentScriptAndStyle: true`
- Chinese UI text and comments throughout the codebase
- Element Plus for all UI components (`ElMessage`, `ElMessageBox`, `el-table`, etc.)
- Path alias: `@` → `src/`

## Environment

- `.env.development` — local API at `localhost:8888`, macOS base path
- `.env.production` — production API, Windows base path
- `electron/utils/config.js` reads `PROJECT_*` env vars via `import.meta.env`
