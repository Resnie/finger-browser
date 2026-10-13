# CLAUDE.md

本文件为 Claude Code (claude.ai/code) 在本仓库中工作时提供指引。

## 项目概述

指纹浏览器是一个基于 Electron + Vue 3 的桌面应用，用于创建和管理带指纹伪装的浏览器实例。使用 Playwright 启动 Chromium，支持持久化上下文和注入指纹规避脚本。

## 开发命令

```bash
npm run dev          # 启动 Vite 开发服务器 + Electron
npm run build        # 构建渲染进程 (Vue) + 主进程/预加载脚本
npm run build:mac    # 构建 + 打包 macOS DMG
npm run build:win    # 构建 + 打包 Windows NSIS 安装包
npm run format       # Prettier 代码格式化
```

目前尚未配置测试框架。

## 架构

### 进程模型 (Electron)

```
主进程 (electron/main/)
  ├── index.js              # 入口：创建窗口，注册所有 IPC 处理器
  ├── browserManager.js     # 浏览器实例生命周期管理 (Playwright)
  ├── browserCoreManager.js # 内核版本下载/删除 IPC
  ├── updateManager.js      # 从 GitHub releases 自动更新
  └── ipc/
      ├── registry.js       # IPCRegistry - 集中式处理器注册
      └── emitter.js        # IPCEmitter 单例 - 主进程→渲染进程事件推送

预加载 (electron/preload/)
  └── index.js              # contextBridge 合并 browserManager + updateManager + loggerManager API

渲染进程 (src/)
  └── Vue 3 应用，使用 Pinia、Vue Router (hash 模式)、Element Plus
```

### IPC 通信

两种模式并存：
- **invoke/handle**（请求-响应模式）：渲染进程调用 `window.ipcRenderer.someMethod()`，映射到 `ipcRenderer.invoke(channel, ...)`。处理器通过 `ipcRegistry.registerHandlers()` 注册。
- **send/on**（事件推送模式）：主进程通过 `ipcEmitter.send(channel, data)` 推送事件。渲染进程通过 `globalIpcManager.register()`（单例，应用生命周期）或 `useIpcListener()`（组件作用域，卸载时自动清理）监听。

预加载 API 定义在 `electron/preload/browserManager.js`（浏览器操作）、`updateManager.js`（更新）、`loggerManager.js`（日志）中，统一合并到 `window.ipcRenderer`。

### 下载事件路由

下载相关的 IPC 事件（`browser-download-start`、`browser-download-progress`、`browser-download-error`、`browser-download-complete`）同时携带 `id`（浏览器实例）和 `version` 字段。`src/composables/useDownloadListeners.js` 中的全局监听器负责分发：
- `!id && version` → store 中的 `kernelDownloadInstances`（内核下载）
- `id` 存在 → store 中的 `downloadInstances`（实例级下载）

### 状态管理 (Pinia)

`src/store/index.js` 包含两个 store：
- **useUserStore** — 认证状态、下载进度跟踪（`downloadInstances` 用于浏览器实例，`kernelDownloadInstances` 用于内核版本）、浏览器实例状态
- **useBrowserVersionStore** — 可用/已选中的内核版本

### API 层

`src/utils/request.js` — Axios 实例，指向 `VITE_APP_BASE_API`。期望 Kratos 风格的 `{ code, message, data }` 响应格式（code 0 表示成功）。从 localStorage 读取 token 放入 `Authorization` 请求头。401 时重定向到登录页。

API 模块位于 `src/api/` 目录下（user.js、browser.js、group.js），封装 HTTP 请求。

### 浏览器实例生命周期

`electron/main/models/BrowserInstance.js` — 封装 Playwright 持久化浏览器上下文。处理指纹注入（`FingerprintInjector`）、历史记录追踪（`HistoryManager`）、凭据存储（`CredentialManager`）以及页面生命周期事件。

内核（Chromium 二进制文件）存储在 `{appPath}/browser/{version}/` 目录下。从 GitHub releases 下载 ZIP 文件后就地解压。`electron/utils/browser.js` 中的 `activeDownloads` Map 跟踪 AbortController，支持取消下载。

### 路由

基于 hash 的路由（`createWebHashHistory`）。导航守卫在未认证时重定向到 `/login`。主要页面：`/`（浏览器实例管理）、`/browser-kernel`（内核管理）、`/account`、`/fingerprint`、`/setting`、`/template`、`/group`。

## 代码规范

- Vue 3 组合式 API，使用 `<script setup>`（不使用选项式 API）
- Prettier 配置：单引号、尾逗号 (ES5)、2 空格缩进、100 字符行宽、`vueIndentScriptAndStyle: true`
- 代码库中全程使用中文 UI 文本和注释
- 所有 UI 组件使用 Element Plus（`ElMessage`、`ElMessageBox`、`el-table` 等）
- 路径别名：`@` → `src/`

## 环境配置

- `.env.development` — 本地 API 地址 `localhost:8888`，macOS 基础路径
- `.env.production` — 生产环境 API，Windows 基础路径
- `electron/utils/config.js` 通过 `import.meta.env` 读取 `PROJECT_*` 环境变量
