const { chromium } = require('playwright');
import path from 'path';
import fs from 'fs';
import os from 'node:os';
import axios from 'axios';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { logger } from '../../utils/logger.js';
import { getVersionOfBrowserStartupPath } from '../../utils/browser.js';
import { getAppPath } from '../../utils/tools.js';
import { ipcEmitter } from '../ipc/emitter.js';
import { FingerprintInjector } from './FingerprintInjector.js';
import { HistoryManager } from './HistoryManager.js';
import { CredentialManager } from './CredentialManager.js';
import { normalizeBrowserStorageState } from './browserStorageState.mjs';
import { probeProxyConnectivity, ProxyProbeError } from './proxyProbe.mjs';
import { createSocksProxyBridge } from './socksProxyBridge.mjs';
import { applyProxyNetworkPolicy, prepareProxyNetworkProfile } from './proxyNetworkPolicy.mjs';
import { parseProxyApiResponse, normalizeProxyApiRequestError, resolveProxyApiRequestUrl, ProxyApiError } from './proxyApi.mjs';
import { restoreStartupPages } from './startupPageRestore.mjs';
import {
  BROWSER_LIFECYCLE_ACTIONS,
  claimBrowserLifecycleClose,
  closeContextWithTimeout,
  closeLifecycleContext,
  resolveBrowserLifecycleAction,
} from './browserLifecycle.mjs';
import { validateFingerprintIdentity } from '../../../shared/fingerprintIdentity.mjs';
import {
  CLOUD_RECOVERY_VERSION,
  importCloudRecoveryCaches,
  normalizeCloudRecoveryVersion,
  normalizeRecoveryRevision,
} from './browserRecovery.mjs';
import {
  awaitPendingStorageCapture,
  buildAuthoritativeCookiePlan,
  buildAuthoritativeOriginUnion,
  buildAuthoritativeOriginStoragePlan,
  shouldApplyInitialCookies,
  withStorageOperationTimeout,
} from './authoritativeStorage.mjs';
import { prepareOwnedBrowserProfile } from './browserProfilePath.mjs';
import {
  prepareBrowserProfileLaunchPath,
  getBrowserProfileProcessPaths,
  releaseBrowserProfileLaunchPath,
  browserCommandUsesProfile,
} from './browserProfileLaunchPath.mjs';
import { shouldCollectRecoveryPageUrl } from './browserPageUrl.mjs';
import { capturePortableProfile, restorePortableProfile } from './browserPortableProfile.mjs';
import { captureOpfs, restoreOpfsOrigin } from './browserOpfs.mjs';
import {
  captureSessionStorage,
  installSessionStorageForNavigation,
  isTrustedSessionStorageCheckpoint,
  normalizeSessionStorage,
  reindexSessionStorageTabs,
  selectSessionStorageForTab,
} from './browserSessionStorage.mjs';

const execFileAsync = promisify(execFile);

// 实例 ID 白名单：避免 ID 逃逸出受管理的数据目录或存储键空间。
const SAFE_INSTANCE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const isSafeInstanceId = id => typeof id === 'string' && SAFE_INSTANCE_ID.test(id);
const STORAGE_CHECKPOINT_THROTTLE_MS = 5_000;
const STORAGE_CHECKPOINT_INTERVAL_MS = 30_000;

/**
 * 浏览器实例类
 * 管理单个浏览器实例的生命周期和状态
 */
export class BrowserInstance {
  /**
   * 创建浏览器实例
   * @param {string} id - 实例唯一标识符
   * @param {Object} config - 浏览器配置
   * @param {Array} pages - 页面列表
   * @param {Object|null} state - 浏览器状态
   */
  constructor(id, config, pages = [], state = null, recovery = {}) {
    if (!isSafeInstanceId(id)) {
      throw new Error('浏览器实例 ID 格式无效');
    }
    this.id = id;
    this.config = config;
    this.state = state;
    this._hasSavedStorageState = state !== null && state !== undefined;
    this._normalizedStorageState = null;
    this.pages = pages;

    // 浏览器实例与上下文
    this.browser = null;
    this.context = null;

    // 浏览器路径和数据目录（用于进程清理）
    this.browserPath = null;
    this.userDataDir = null;
    this._profileLaunchPath = null;
    this._profileProcessStopped = false;

    // 定时器
    this.lifecycleCheckInterval = null;
    this.saveStateTimer = null;
    this.storageCheckpointTimer = null;
    this.storageCheckpointInterval = null;
    this._storageCapturePromise = null;
    this._lastPageCloseCapturePromise = null;
    this._lastStorageCaptureAt = 0;
    this._pendingStorageCheckpointReason = '';
    this._lastStorageStateSerialized = (() => {
      try {
        const normalized = normalizeBrowserStorageState(state);
        return normalized ? JSON.stringify(normalized) : '';
      } catch {
        return '';
      }
    })();

    // 关闭状态标志，防止关闭过程中触发不必要的操作
    this.isClosing = false;

    // 已注册事件的页面集合（使用弱引用避免内存泄漏）
    this.registeredPages = new WeakSet();

    // 创建实例专用的日志器
    this.logger = logger.createContextLogger(`Browser:${id}`);

    this.cloudRecoveryVersion = normalizeCloudRecoveryVersion(recovery?.cloudRecoveryVersion);
    this.ownerId = recovery?.ownerId ? String(recovery.ownerId) : null;
    this.recoveryRevision = normalizeRecoveryRevision(recovery?.recoveryRevision);
    this._recoveryChangeSequence = 0;

    // 历史记录和密码管理器
    this.historyManager = new HistoryManager(id, {
      ownerId: recovery?.ownerId,
      onChanged: reason => this.markRecoveryChanged(reason),
    });
    this.credentialManager = new CredentialManager(id, {
      ownerId: recovery?.ownerId,
      onChanged: reason => this.markRecoveryChanged(reason),
    });
    this.restoreCloudRecoveryCaches(recovery);

    // 状态变更回调（由 browserManager 设置，用于通知状态变更并持久化）
    this.onStateChanged = null;

    // 最后一次成功采集的页面快照（只在从活跃 context 成功采集到非空结果时更新）
    this._lastGoodPages = Array.isArray(pages) && pages.length > 0 ? [...pages] : [];
    // 整窗关闭时，累积本批次关闭的页面 URL
    this._closingPagesBatch = [];
    this._closingBatchTimer = null;
    // 记录每个页面的最新 URL（close 时 page.url() 可能不可用）
    this._pageLastUrl = new Map();
    // 只有初始/恢复页面处理完成后，BrowserManager 才能对外报告 started。
    this.startupReady = false;
    this._portableProfileCapturePromise = null;
    this._portableProfileCaptureError = null;
    this._restoredExtensionPaths = [];
    this._sessionStoragePageIndices = new WeakMap();
    this._sessionStorageByPage = new WeakMap();
    this._closingSessionStorageBatch = [];
    this._startupSessionStorage = null;
  }

  restoreCloudRecoveryCaches(recovery) {
    const result = importCloudRecoveryCaches({
      recovery,
      cloudRecoveryVersion: this.cloudRecoveryVersion,
      importCredentials: entries => this.credentialManager.importEntries(entries),
      importHistory: entries => this.historyManager.importEntries(entries),
    });
    if (result.restored) {
      this.logger.info('已从云端恢复浏览历史与凭据缓存');
    } else if (result.failed) {
      this.logger.warn('旧协议云端恢复缓存导入失败，已保留本地数据');
    }
  }

  markRecoveryChanged(reason = '', { notify = true } = {}) {
    this._recoveryChangeSequence += 1;
    this.logger.debug(`恢复数据已更新: ${reason || 'unknown'}`);
    if (notify) this.notifyStateChanged(reason || 'recovery-changed');
  }

  acknowledgeRecoveryRevision(expectedRevision, nextRevision) {
    const expected = normalizeRecoveryRevision(expectedRevision);
    const next = normalizeRecoveryRevision(nextRevision);
    if (this.recoveryRevision !== expected || next <= expected) return false;
    this.recoveryRevision = next;
    return true;
  }

  /**
   * 判断是否为 Chromium 内部页面
   * @param {string} url
   * @returns {boolean}
   */
  isInternalPageUrl(url = '') {
    return (
      !url ||
      url.startsWith('chrome://') ||
      url.startsWith('chrome-extension://') ||
      url.startsWith('devtools://')
    );
  }

  /**
   * 从活跃 context 中采集当前页面列表
   * 仅在成功采集到非空结果时更新 _lastGoodPages
   * @returns {Array<{url: string}>}
   */
  collectCurrentPages() {
    if (!this.context) {
      return this._lastGoodPages.length > 0 ? this._lastGoodPages : [];
    }

    try {
      const pages = [];
      for (const page of this.context.pages()) {
        if (page.isClosed()) continue;
        const url = page.url();
        if (!shouldCollectRecoveryPageUrl(url)) continue;
        pages.push({ url });
      }

      if (pages.length > 0) {
        // 成功采集到有效页面，更新快照
        this._lastGoodPages = pages;
      }

      return pages;
    } catch {
      // context 已失效
      return this._lastGoodPages.length > 0 ? this._lastGoodPages : [];
    }
  }

  /**
   * 获取当前实例的全量上下文快照（用于持久化到后端）
   * 此方法不依赖 context 是否存活，始终返回可用数据
   * @returns {{ id: string, pages: Array, state: Object|null, config: Object }}
   */
  getSnapshot() {
    if (this._portableProfileCaptureError) throw this._portableProfileCaptureError;
    let credentials;
    try {
      credentials = this.credentialManager.exportEntries();
    } catch (error) {
      this.logger.warn(`凭据快照采集失败: ${error.message}`);
    }
    return {
      id: this.id,
      pages:
        this._lastGoodPages.length > 0
          ? this._lastGoodPages
          : Array.isArray(this.pages)
            ? this.pages
            : [],
      state: this.state || null,
      config: this.config,
      history: this.historyManager.exportEntries(),
      credentials,
      recoveryRevision: this.recoveryRevision,
      ownerId: this.ownerId,
      cloudRecoveryVersion:
        this.cloudRecoveryVersion >= CLOUD_RECOVERY_VERSION ? CLOUD_RECOVERY_VERSION : 0,
    };
  }

  /**
   * 向渲染进程发送最新状态快照
   * @param {string} [logPrefix]
   */
  emitStateSnapshot(logPrefix = '状态已保存') {
    const snapshot = this.getSnapshot();
    // 渲染进程不需要看到凭据明文或历史全量。
    ipcEmitter.emitSaveBrowserState({
      id: snapshot.id,
      config: snapshot.config,
    });
    this.logger.info(`${logPrefix} (${snapshot.pages.length} 个有效页面)`);
  }

  /**
   * 通知状态变更（触发回调，由 browserManager 处理持久化）
   * @param {string} reason - 变更原因
   */
  notifyStateChanged(reason = '') {
    if (this.onStateChanged) {
      this.onStateChanged(this, reason);
    }
  }

  /**
   * 在浏览器进程退出后写回崩溃标记，避免下次启动提示异常关闭
   * @param {string} [dataDir]
   */
  async finalizeCrashSentinel(dataDir) {
    const dir = dataDir || this.userDataDir;
    if (!dir) return;

    for (let i = 0; i < 2; i++) {
      if (i > 0) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      this.cleanCrashSentinel(dir);
    }
  }

  /**
   * 启动浏览器（使用持久化上下文）
   */
  async launch() {
    this._startupPages = structuredClone(this.pages || []);
    const identityValidation = validateFingerprintIdentity({
      browserVersion: this.config?.base?.browserVersion,
      operatingSystems: this.config?.base?.operatingSystem,
      userAgent: this.config?.base?.userAgent,
      platform: this.config?.finger?.platform,
    });
    if (!identityValidation.valid) {
      throw new Error('内核、User-Agent 与操作系统不一致，请编辑窗口后重新生成 User-Agent');
    }
    this.config.finger = {
      ...(this.config.finger || {}),
      platform: identityValidation.platform,
    };

    this.browserPath = await getVersionOfBrowserStartupPath(
      this.config.base.browserVersion,
      this.id
    );

    // 构建用户数据目录路径（每个实例独立的数据目录）
    this.userDataDir = this.ownerId
      ? prepareOwnedBrowserProfile(getAppPath(), this.id, this.ownerId)
      : path.join(getAppPath(), 'browser-data', this.id);

    // 清理 Chrome 崩溃标记，防止启动时弹出"异常关闭"恢复提示
    this.cleanCrashSentinel();

    try {
      const injector = new FingerprintInjector(this.id, this.config.finger || {}, this.config.base.userAgent);
      this._runtimeFingerConfig = injector.config;
      const contextOptions = await this.buildContextOptions(this.browserPath);
      // Bootstrap会临时进入HTTP origin，必须在任何临时文档事件之前固定恢复队列。
      this._startupSessionStorage = structuredClone(
        this._normalizedStorageState?.sessionStorage || []
      );

      // 代理启用时必须先通过真实 HTTPS 出口探测。探测失败不会回退到直连。
      if (contextOptions.proxy) {
        await this.verifyProxyConnectivity(contextOptions.proxy, contextOptions);
      }

      const portableProfile = this._normalizedStorageState?.portableProfile;
      if (portableProfile) {
        this._restoredExtensionPaths = await restorePortableProfile({
          profileDir: this.userDataDir,
          kernelVersion: this.config.base.browserVersion,
          snapshot: portableProfile,
          assertStopped: async () =>
            (await this.findBrowserProcesses(this.userDataDir, this.id, { strict: true }))
              .length === 0,
        });
        if (this._restoredExtensionPaths.length) {
          contextOptions.args = contextOptions.args.filter(arg => arg !== '--disable-extensions');
          contextOptions.args.push(`--load-extension=${this._restoredExtensionPaths.join(',')}`);
          contextOptions.ignoreDefaultArgs = ['--disable-extensions'];
        }
        this.logger.info('已从云端恢复书签、站点权限和完整持久档案');
      }

      // 使用 launchPersistentContext 启动浏览器，自动持久化历史记录、密码等数据
      await prepareProxyNetworkProfile(this.userDataDir, Boolean(contextOptions.proxy));
      this._profileLaunchPath = prepareBrowserProfileLaunchPath(this.userDataDir);
      this._profileProcessStopped = false;
      this.context = await chromium.launchPersistentContext(
        this._profileLaunchPath.launchPath,
        contextOptions
      );
      this.context.once('close', () => this.closeProxyBridge());

      // Playwright 当前版本可从 persistent context 取得 Browser；
      // 主生命周期仍以 context 为准，Browser 仅作为进程级诊断引用。
      this.browser = this.context.browser();

      // pagehide在页面真正销毁前提供最后的sessionStorage检查点，避免用户
      // 改完临时状态立即关闭整窗时仅能使用30秒前的周期快照。
      await this.context.exposeBinding('__fingerBrowserSessionCheckpoint', (source, checkpoint) => {
        this.acceptSessionStorageCheckpoint(source, checkpoint);
      });
      await this.context.addInitScript(() => {
        const report = () => {
          try {
            if (!['http:', 'https:'].includes(location.protocol)) return;
            Promise.resolve(
              globalThis.__fingerBrowserSessionCheckpoint({
                url: location.href,
                origin: location.origin,
                entries: Object.entries(sessionStorage).map(([name, value]) => ({ name, value })),
              })
            ).catch(() => {});
          } catch {}
        };
        addEventListener('pagehide', report, { capture: true });
        addEventListener('DOMContentLoaded', report, { once: true });
      });

      this.logger.info(`浏览器启动成功，数据目录: ${this.userDataDir}`);

      // Playwright 1.55 的持久化上下文会忽略 storageState 启动参数；在任何
      // 业务页导航前做一层兼容恢复，新版 Playwright 原生支持后也可安全重复。
      await this.restoreSavedStorageState();

      // 注入指纹脚本（在所有页面加载前执行）
      const injectionScript = injector.getInjectionScript();
      await this.context.addInitScript(injectionScript);
      await injector.installWorkerFingerprints(this.context, this.logger);
      this.logger.info('指纹注入脚本已添加');

      // 在首个页面导航前导入用户配置的初始 Cookie。
      if (shouldApplyInitialCookies(this._hasSavedStorageState)) {
        await this.applyInitialCookies();
      } else {
        this.logger.info('已有有效会话快照，跳过初始 Cookie 导入');
      }
    } catch (error) {
      this.logger.error(`浏览器启动失败: ${error.message}`);
      this.closeProxyBridge();
      throw error;
    }

    // 必须先注册现有页和新页监听，再执行初始/恢复导航；否则首个页面会漏记历史。
    this.registerExistingPagesEvents();
    this.setupEventListeners();

    await this.restorePages();
    this._startupSessionStorage = null;
    this.startupReady = true;
    await this.ensureCurrentPagesInHistory();
    this.pages = this.collectCurrentPages();

    // 首次导航完成后立即采集，不依赖后续页面事件。
    await this.captureStorageState('启动恢复完成', { force: true, notify: false });

    // 启动生命周期检查
    this.startLifecycleCheck();
    this.startStorageCheckpointing();

    return this.context;
  }

  /**
   * 构建持久化上下文启动配置
   */
  async buildContextOptions(browserPath) {
    this._normalizedStorageState = null;
    const options = {
      headless: false,
      args: [
        '--disable-infobars',
        '--no-first-run',
        '--disable-session-crashed-bubble',
        '--hide-crash-restore-bubble',
        '--disable-restore-session-state',
        '--disable-background-networking',
        '--disable-sync',
        '--disable-default-apps',
        '--disable-component-extensions-with-background-pages',
        // 禁用可能导致额外页面创建的功能
        '--disable-prerender2',
        '--disable-speculation-rules',
        '--disable-back-forward-cache',
        '--disable-features=Prerender2,SpeculationRules,BackForwardCache,PreloadingHoldback,ChromeWhatsNewUI,InfiniteSessionRestore,SessionCrashedBubble',
        // 禁用后台标签页行为
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-background-timer-throttling',
        // 防止非正常关闭提示和崩溃报告
        '--disable-breakpad',
        '--disable-crash-reporter',
        '--noerrdialogs',
        '--no-crash-upload',
        // macOS 特定：确保关闭时不保留后台进程
        '--disable-background-mode',
        '--disable-translate',
        '--disable-prompt-on-repost',
        // 禁用可能导致后台进程的其他功能
        '--disable-domain-reliability',
        '--metrics-recording-only',
      ],
      executablePath: browserPath,
      // 保留正常的扩展权限流程；新窗口也能安装可移植的纯JS扩展。
      ignoreDefaultArgs: ['--disable-extensions'],
      userAgent: this.config.base.userAgent,
      acceptDownloads: true,
      // 处理权限请求时的默认行为
      handleSIGINT: true,
      handleSIGTERM: true,
      handleSIGHUP: true,
    };

    if (this.state !== null && this.state !== undefined) {
      const storageState = normalizeBrowserStorageState(this.state);
      if (storageState) {
        this._hasSavedStorageState = true;
        this._normalizedStorageState = storageState;
        options.storageState = { cookies: storageState.cookies, origins: storageState.origins };
        this.logger.info('已加载保存的会话状态');
      } else {
        this._hasSavedStorageState = false;
        this._normalizedStorageState = null;
        // 不记录原始状态，避免 Cookie/localStorage 内容进入日志。
        if (this.cloudRecoveryVersion >= CLOUD_RECOVERY_VERSION) {
          throw new Error('云端浏览会话格式无效，已阻止使用本地陈旧状态');
        }
        this.logger.warn('保存的会话状态格式无效，已安全忽略');
      }
    } else if (this.cloudRecoveryVersion >= CLOUD_RECOVERY_VERSION) {
      // 云端明确支持恢复但旧记录还没有 state 时，空快照仍是权威基线。
      // 先精确清理可能残留的同 ID profile，再按“首次启动”规则应用初始 Cookie。
      this._normalizedStorageState = { cookies: [], origins: [] };
      options.storageState = this._normalizedStorageState;
      this.logger.info('云端会话字段为空，已使用空权威快照清理本地残留');
    }

    // 处理代理配置
    if (this.config.proxy?.enabled) {
      const proxyConfig = await this.buildProxyConfig();
      if (!proxyConfig) {
        throw new Error('代理已启用但配置无效或获取失败，已阻止无代理启动');
      }
      applyProxyNetworkPolicy(options, proxyConfig);
    }

    // 指纹相关的 Playwright 原生配置
    const finger = this._runtimeFingerConfig || new FingerprintInjector(this.id, this.config.finger || {}, this.config.base.userAgent).config;

    if (finger.autoFingerprint === true) {
      options.args.push('--disable-gpu', '--force-color-profile=srgb');
      options.deviceScaleFactor = 1;
    }

    if (finger.timezone && finger.timezone !== 'auto') {
      options.timezoneId = finger.timezone;
    }
    if (finger.language) {
      options.locale = finger.language;
    }
    if (finger.screenResolution && finger.screenResolution !== 'auto') {
      const [w, h] = finger.screenResolution.split('x').map(Number);
      if (w && h) {
        options.viewport = { width: w, height: h };
      }
    }
    if (finger.colorScheme) {
      options.colorScheme = finger.colorScheme;
    }
    if (finger.geolocation) {
      options.geolocation = finger.geolocation;
      options.permissions = ['geolocation'];
    }

    return options;
  }

  /**
   * 为不支持 persistent-context storageState 的 Playwright 版本恢复会话。
   * 服务端快照是跨设备权威源：Cookie 整体替换，每个 origin 的
   * localStorage/IndexedDB 也会先清理再精确重建。
   */
  async restoreSavedStorageState() {
    const storageState = this._normalizedStorageState;
    if (!this.context || !storageState) return;

    try {
      let localOrigins = [];
      try {
        // 必须在清理 Cookie/origin 前采集持久化 profile，才能找到云端已删除的
        // local-only origin 并将其 localStorage/IndexedDB 一并清空。
        const localState = normalizeBrowserStorageState(
          await this.context.storageState({ indexedDB: true })
        );
        if (!localState) throw new Error('Invalid local storage snapshot');
        localOrigins = localState.origins;
      } catch {
        if (this.cloudRecoveryVersion >= CLOUD_RECOVERY_VERSION) {
          throw new Error('Unable to inspect persistent local storage');
        }
        this.logger.warn('旧协议本地存储预检查失败，仅恢复已保存的 origin');
      }

      const remoteOrigins = [...storageState.origins];
      for (const entry of storageState.opfs?.origins || []) {
        if (!remoteOrigins.some(origin => origin.origin === entry.origin)) {
          remoteOrigins.push({ origin: entry.origin, localStorage: [], indexedDB: [] });
        }
      }
      const origins = buildAuthoritativeOriginUnion(remoteOrigins, localOrigins);
      const cookiePlan = buildAuthoritativeCookiePlan(storageState.cookies);
      if (cookiePlan.clearExisting) await this.context.clearCookies();
      if (cookiePlan.cookies.length > 0) await this.context.addCookies(cookiePlan.cookies);
      await this.restoreOriginStorageForPersistentContext(origins);

      this.logger.info('已恢复保存的会话状态');
    } catch {
      // 不记录 Cookie/localStorage 或原始异常。新协议下快照是权威源，
      // 恢复不完整时必须阻止启动；旧协议继续容错。
      if (this.cloudRecoveryVersion >= CLOUD_RECOVERY_VERSION) {
        throw new Error('云端浏览会话恢复失败，已阻止使用不完整的本地状态');
      }
      this.logger.warn('恢复保存的会话状态失败，已安全忽略');
    }
  }

  /**
   * persistent context 不会应用 launch 参数里的 storageState。在任何业务页
   * 打开前，用本地拦截的空文档进入对应 origin 并精确替换本地数据。
   */
  async restoreOriginStorageForPersistentContext(origins) {
    if (!this.context || !Array.isArray(origins)) return;

    const page = await this.context.newPage();
    const recoveryCDP = await this.context.newCDPSession(page);
    await recoveryCDP.send('Network.enable');
    await recoveryCDP.send('Network.setBypassServiceWorker', { bypass: true });
    // Chromium 可能先从旧 profile 自动恢复标签页并持有 IDB 连接，先关闭它们。
    for (const stalePage of this.context.pages()) {
      if (stalePage !== page) await stalePage.close().catch(() => {});
    }

    try {
      for (const originState of origins) {
        const storagePlan = buildAuthoritativeOriginStoragePlan(originState);
        const opfs = this._normalizedStorageState?.opfs?.origins.find(
          entry => entry.origin === originState.origin
        );
        storagePlan.preserveServiceWorkers = Boolean(this._normalizedStorageState?.portableProfile);
        if (storagePlan.preserveServiceWorkers) {
          // 暂停worker释放IDB连接但保留注册，避免重新注销已恢复的云端worker。
          await recoveryCDP.send('ServiceWorker.enable');
          await recoveryCDP.send('ServiceWorker.stopAllWorkers');
        }
        const restoreUrl = `${originState.origin}/.well-known/finger-browser-recovery-${this.id}`;
        const restorePattern = `${originState.origin}/**`;
        const routeHandler = route =>
          route.fulfill({
            status: 200,
            contentType: 'text/html',
            body: '<!doctype html><title></title>',
          });
        try {
          // Discard OS-specific OPFS metadata only when a complete logical archive exists.
          if (opfs)
            await recoveryCDP.send('Storage.clearDataForOrigin', {
              origin: originState.origin,
              storageTypes: 'file_systems',
            });
          await this.context.route(restorePattern, routeHandler);
          await page.goto(restoreUrl, { waitUntil: 'domcontentloaded', timeout: 10_000 });
          await page.evaluate(async savedOrigin => {
            const requestToPromise = request =>
              new Promise((resolve, reject) => {
                request.addEventListener('success', () => resolve(request.result), { once: true });
                request.addEventListener('error', () => reject(request.error), { once: true });
              });
            const parseEncoded = (value, refs = new Map()) => {
              if (Object.is(value, undefined)) return undefined;
              if (!value || typeof value !== 'object') return value;
              if ('ref' in value) return refs.get(value.ref);
              if ('v' in value) {
                if (value.v === 'undefined') return undefined;
                if (value.v === 'null') return null;
                if (value.v === 'NaN') return Number.NaN;
                if (value.v === 'Infinity') return Number.POSITIVE_INFINITY;
                if (value.v === '-Infinity') return Number.NEGATIVE_INFINITY;
                if (value.v === '-0') return -0;
              }
              if ('d' in value) return new Date(value.d);
              if ('u' in value) return new URL(value.u);
              if ('bi' in value) return BigInt(value.bi);
              if ('r' in value) return new RegExp(value.r.p, value.r.f);
              if ('e' in value) {
                const error = new Error(value.e.m);
                error.name = value.e.n;
                error.stack = value.e.s;
                return error;
              }
              if ('ta' in value) {
                const constructors = {
                  i8: Int8Array,
                  ui8: Uint8Array,
                  ui8c: Uint8ClampedArray,
                  i16: Int16Array,
                  ui16: Uint16Array,
                  i32: Int32Array,
                  ui32: Uint32Array,
                  f32: Float32Array,
                  f64: Float64Array,
                  bi64: BigInt64Array,
                  bui64: BigUint64Array,
                };
                const Constructor = constructors[value.ta.k];
                if (!Constructor) throw new Error('Unsupported IndexedDB typed array');
                const binary = atob(value.ta.b);
                const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
                return new Constructor(bytes.buffer);
              }
              if ('a' in value) {
                const result = [];
                refs.set(value.id, result);
                for (const item of value.a) result.push(parseEncoded(item, refs));
                return result;
              }
              if ('o' in value) {
                const result = {};
                refs.set(value.id, result);
                for (const item of value.o) {
                  if (item.k !== '__proto__') result[item.k] = parseEncoded(item.v, refs);
                }
                return result;
              }
              return value;
            };

            if (
              savedOrigin.localStorageMode !== 'replace' ||
              savedOrigin.indexedDBMode !== 'replace'
            ) {
              throw new Error('Unsupported recovery merge policy');
            }
            localStorage.clear();
            for (const item of savedOrigin.localStorage || []) {
              localStorage.setItem(item.name, item.value);
            }

            if (!savedOrigin.preserveServiceWorkers) {
              const registrations = navigator.serviceWorker
                ? await navigator.serviceWorker.getRegistrations()
                : [];
              await Promise.all(registrations.map(registration => registration.unregister()));
            }
            for (const database of await indexedDB.databases()) {
              if (!database.name) continue;
              const deleteRequest = indexedDB.deleteDatabase(database.name);
              await new Promise((resolve, reject) => {
                deleteRequest.addEventListener('success', resolve, { once: true });
                deleteRequest.addEventListener('error', () => reject(deleteRequest.error), {
                  once: true,
                });
                deleteRequest.addEventListener(
                  'blocked',
                  () => reject(new Error('IndexedDB deletion blocked')),
                  { once: true }
                );
              });
            }

            for (const database of savedOrigin.indexedDB || []) {
              const openRequest = indexedDB.open(database.name, database.version);
              openRequest.addEventListener('upgradeneeded', () => {
                const db = openRequest.result;
                for (const savedStore of database.stores) {
                  const keyPath = savedStore.keyPathArray ?? savedStore.keyPath;
                  const objectStore = db.createObjectStore(savedStore.name, {
                    autoIncrement: savedStore.autoIncrement,
                    ...(keyPath === undefined ? {} : { keyPath }),
                  });
                  for (const savedIndex of savedStore.indexes) {
                    const indexKeyPath = savedIndex.keyPathArray ?? savedIndex.keyPath;
                    objectStore.createIndex(savedIndex.name, indexKeyPath, {
                      unique: savedIndex.unique,
                      multiEntry: savedIndex.multiEntry,
                    });
                  }
                }
              });
              const db = await requestToPromise(openRequest);
              if (db.objectStoreNames.length === 0) {
                db.close();
                continue;
              }
              const transaction = db.transaction([...db.objectStoreNames], 'readwrite');
              const transactionDone = new Promise((resolve, reject) => {
                transaction.addEventListener('complete', resolve, { once: true });
                transaction.addEventListener('error', () => reject(transaction.error), {
                  once: true,
                });
                transaction.addEventListener('abort', () => reject(transaction.error), {
                  once: true,
                });
              });
              for (const savedStore of database.stores) {
                const objectStore = transaction.objectStore(savedStore.name);
                for (const record of savedStore.records) {
                  const value = Object.hasOwn(record, 'value')
                    ? record.value
                    : parseEncoded(record.valueEncoded);
                  const hasKey =
                    Object.hasOwn(record, 'key') || Object.hasOwn(record, 'keyEncoded');
                  const key = Object.hasOwn(record, 'key')
                    ? record.key
                    : parseEncoded(record.keyEncoded);
                  await requestToPromise(
                    hasKey ? objectStore.add(value, key) : objectStore.add(value)
                  );
                }
              }
              await transactionDone;
              db.close();
            }
          }, storagePlan);
          if (opfs) await restoreOpfsOrigin(page, opfs);
        } catch {
          this.logger.warn(`本地存储恢复失败，已跳过 origin: ${originState.origin}`);
          throw new Error('权威存储快照恢复失败');
        } finally {
          await this.context.unroute(restorePattern, routeHandler).catch(() => {});
        }
      }
    } finally {
      await recoveryCDP.send('Network.setBypassServiceWorker', { bypass: false }).catch(() => {});
      await recoveryCDP.detach().catch(() => {});
      // Windows headed Chromium exits when its last tab closes. Keep a blank
      // bootstrap tab alive until restorePages reuses it for the first real URL.
      // Remove the intercepted recovery document before page listeners register.
      await page.goto('about:blank', { waitUntil: 'domcontentloaded' });
    }
  }

  /**
   * 构建 Chromium 启动配置（保留用于兼容性）
   */
  async buildChromiumConfig(browserPath) {
    return this.buildContextOptions(browserPath);
  }

  /**
   * 在启动 Chromium 前验证代理能否访问 HTTPS 并返回有效出口。
   * 日志只记录不含认证信息的 server，不记录用户名、密码或原始异常。
   */
  async verifyProxyConnectivity(proxyConfig, contextOptions) {
    this.logger.info(`正在验证代理 HTTPS 连通性: ${proxyConfig.server}`);
    try {
      const result = await probeProxyConnectivity(proxyConfig, {
        contextOptions,
        launchPersistentContext: (profilePath, options) =>
          chromium.launchPersistentContext(profilePath, options),
      });
      this.logger.info(`代理 HTTPS 连通性验证通过: ${proxyConfig.server} (${result.target})`);
    } catch (error) {
      const safeMessage =
        error instanceof ProxyProbeError ? error.message : '代理连通性检测失败，已阻止启动';
      this.logger.error(`代理 HTTPS 连通性验证失败: ${proxyConfig.server}; ${safeMessage}`);
      throw new Error(safeMessage);
    }
  }

  /**
   * 导入创建窗口时填写的 Cookie JSON。
   * 忽略浏览器导出数据里 Playwright 不识别的字段，避免整个窗口因单条数据失败。
   */
  async applyInitialCookies() {
    const rawCookies = this.config?.base?.cookies;
    if (!rawCookies || !this.context) return;

    try {
      const parsed = typeof rawCookies === 'string' ? JSON.parse(rawCookies) : rawCookies;
      if (!Array.isArray(parsed)) {
        throw new Error('Cookie 配置不是数组');
      }

      const initialUrl = this.config?.base?.url;
      const fallbackUrl = (() => {
        try {
          const url = new URL(initialUrl);
          return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
        } catch {
          return '';
        }
      })();

      const sameSiteMap = {
        strict: 'Strict',
        lax: 'Lax',
        none: 'None',
        no_restriction: 'None',
        unspecified: 'Lax',
      };

      const cookies = parsed
        .filter(cookie => cookie && typeof cookie === 'object' && cookie.name != null)
        .map(cookie => {
          const normalized = {
            name: String(cookie.name),
            value: String(cookie.value ?? ''),
          };

          if (cookie.url) {
            try {
              const url = new URL(cookie.url);
              if (['http:', 'https:'].includes(url.protocol)) normalized.url = url.href;
            } catch {}
          }

          if (!normalized.url && cookie.domain) {
            normalized.domain = String(cookie.domain).trim();
            normalized.path = String(cookie.path || '/');
          } else if (!normalized.url && fallbackUrl) {
            normalized.url = fallbackUrl;
          }

          if (!normalized.url && !normalized.domain) return null;

          let expires = Number(cookie.expires ?? cookie.expirationDate);
          if (expires > 1e12) expires = Math.floor(expires / 1000);
          if (Number.isFinite(expires) && expires > 0) normalized.expires = expires;
          if (typeof cookie.httpOnly === 'boolean') normalized.httpOnly = cookie.httpOnly;
          if (typeof cookie.secure === 'boolean') normalized.secure = cookie.secure;

          const sameSite = sameSiteMap[String(cookie.sameSite || '').toLowerCase()];
          if (sameSite) normalized.sameSite = sameSite;
          return normalized;
        })
        .filter(Boolean);

      if (cookies.length > 0) {
        await this.context.addCookies(cookies);
        this.logger.info(`已导入 ${cookies.length} 条初始 Cookie`);
      }
    } catch (error) {
      // 旧数据可能存在非标准格式，不应因此阻止浏览器启动。
      this.logger.warn(`导入初始 Cookie 失败: ${error.message}`);
    }
  }

  /**
   * 构建代理配置（异步：支持 manual 直接配置与 api 通过URL获取）
   * @returns {Promise<Object|null>} Playwright proxy 配置或 null
   */
  async buildProxyConfig() {
    try {
      const delimiter = this.config.proxy.delimiter || ':';
      let proxyText = '';

      if (this.config.proxy.method === 'api') {
        // 通过 URL 获取代理：请求 API 链接，解析返回的代理字符串
        proxyText = await this.fetchProxyFromApi(this.config.proxy.text);
        if (!proxyText) {
          this.logger.error('通过URL获取代理失败：返回为空');
          return null;
        }
      } else if (this.config.proxy.method === 'manual') {
        proxyText = this.config.proxy.text || '';
      } else {
        // 未指定 method 时按 manual 处理
        proxyText = this.config.proxy.text || '';
      }

      const parts = proxyText.split(delimiter).map(s => s.trim());
      if (![2, 4].includes(parts.length) || !parts[0] || !parts[1]) {
        this.logger.error('代理信息格式无效');
        return null;
      }

      const host = parts[0];
      const port = Number(parts[1]);
      const username = parts.length === 4 ? parts[2] : '';
      const password = parts.length === 4 ? parts[3] : '';

      if (
        host.length > 253 ||
        /[\s/@?#]/.test(host) ||
        !Number.isInteger(port) ||
        port < 1 ||
        port > 65535 ||
        (parts.length === 4 && (!username || !password))
      ) {
        this.logger.error('代理主机、端口或认证信息无效');
        return null;
      }

      const proxyType = this.config.proxy.type || 'http';
      if (!['http', 'https', 'socks5'].includes(proxyType)) {
        this.logger.error('代理协议不受支持');
        return null;
      }

      // 更新 config 中的代理信息（便于列表展示当前生效的代理）
      this.config.proxy.host = host;
      this.config.proxy.port = port;
      this.config.proxy.username = username;
      this.config.proxy.password = password;

      const proxyConfig = {
        server: `${proxyType}://${host}:${port}`,
      };

      if (username && password) {
        proxyConfig.username = username;
        proxyConfig.password = password;
      }

      this.logger.info(`代理配置已解析: ${proxyConfig.server}`);
      if (proxyType === 'socks5' && username && password) {
        this.closeProxyBridge();
        this._proxyBridge = await createSocksProxyBridge(proxyConfig);
        return this._proxyBridge.proxy;
      }
      return proxyConfig;
    } catch (error) {
      if (error instanceof ProxyApiError) {
        this.logger.error(error.message);
        throw error;
      }
      this.logger.error(`构建代理配置失败: ${error.message}`);
      return null;
    }
  }

  /**
   * 通过 API 链接获取代理字符串
   * 兼容纯文本(ip:port[:user:pass]，可能多行)与 JSON 两种返回格式
   * @param {string} apiUrl - 代理 API 链接
   * @returns {Promise<string>} 形如 "host:port" 或 "host:port:user:pass" 的代理串
   */
  async fetchProxyFromApi(apiUrl) {
    if (!apiUrl) throw new ProxyApiError('PROXY_API_URL', '请填写有效的代理 API 链接');
    try {
      const requestUrl = resolveProxyApiRequestUrl(apiUrl);
      const resp = await axios.get(requestUrl, {
        timeout: 15000,
        responseType: 'text',
        maxContentLength: 1024 * 1024,
        maxBodyLength: 1024 * 1024,
        maxRedirects: 3,
      });
      return parseProxyApiResponse(resp.data, { delimiter: this.config.proxy.delimiter || ':' });
    } catch (error) {
      const safeError = normalizeProxyApiRequestError(error);
      this.logger.error(safeError.message);
      throw safeError;
    }
  }

  /**
   * 解析代理 API 的 JSON 返回：成功则返回代理串，失败仅记录不含服务商原始数据的通用错误。
   */
  parseProxyJson(json) {
    return parseProxyApiResponse(json, { delimiter: this.config.proxy.delimiter || ':' });
  }

  /**
   * 从 JSON 结构中提取代理 host:port[:user:pass]
   * 兼容 {data:[{ip,port}]} / {ip,port} / [{ip,port}] 等常见结构
   */
  extractProxyFromJson(json) {
    return this.parseProxyJson(json);
  }

  /**
   * 从活跃 context 采集可跨设备恢复的 Cookie/localStorage/IndexedDB。
   * 采集全程串行，且只接受经过大小与格式校验的快照。
   */
  async captureStorageState(reason = '', { force = false, notify = true } = {}) {
    if (!this.context || (this.isClosing && !force)) return { captured: false, changed: false };
    if (this._storageCapturePromise) return this._storageCapturePromise;

    this._storageCapturePromise = (async () => {
      try {
        const rawState = await withStorageOperationTimeout(
          this.context.storageState({ indexedDB: true })
        );
        const activePages = this.context
          .pages()
          .filter(page => !page.isClosed() && shouldCollectRecoveryPageUrl(page.url()));
        activePages.forEach((page, index) => this._sessionStoragePageIndices.set(page, index));
        const sessionStorage = activePages.length
          ? await withStorageOperationTimeout(
              captureSessionStorage(activePages, this.state?.sessionStorage || [])
            )
          : this.state?.sessionStorage || [];
        activePages.forEach((page, index) => {
          const tab = sessionStorage.find(item => item.index === index);
          if (tab) this._sessionStorageByPage.set(page, structuredClone(tab));
        });
        const normalized = normalizeBrowserStorageState({
          ...rawState,
          sessionStorage,
          ...(this.state?.portableProfile ? { portableProfile: this.state.portableProfile } : {}),
          ...(this.state?.opfs ? { opfs: this.state.opfs } : {}),
        });
        if (!normalized) throw new Error('浏览器存储快照超限或格式无效');

        const serialized = JSON.stringify(normalized);
        const changed = serialized !== this._lastStorageStateSerialized;
        this.state = normalized;
        this._normalizedStorageState = normalized;
        this._lastStorageStateSerialized = serialized;
        this._lastStorageCaptureAt = Date.now();
        this.pages = this.collectCurrentPages();
        if (changed) {
          this.markRecoveryChanged(`storage:${reason || 'checkpoint'}`, { notify });
        }
        return { captured: true, changed };
      } catch (error) {
        this.logger.warn(`采集浏览器存储快照失败: ${error.message}`);
        return { captured: false, changed: false };
      } finally {
        this._storageCapturePromise = null;
      }
    })();
    return this._storageCapturePromise;
  }

  /**
   * Closing the final Chromium window can be followed almost immediately by context close.
   * Start a forced checkpoint in the page close callback and retain its promise so the
   * manager can wait for it before persisting the cached snapshot.
   */
  startFinalStorageCapture(reason = '最后窗口关闭') {
    if (this._lastPageCloseCapturePromise) return this._lastPageCloseCapturePromise;

    const captureTask = (async () => {
      try {
        const activeCapture = this._storageCapturePromise;
        if (activeCapture) {
          this.logger.info('最后窗口关闭，等待正在进行的存储检查点');
          await activeCapture;
        }
        if (!this.context) return { captured: false, changed: false };

        const result = await this.captureStorageState(reason, { force: true, notify: false });
        if (!result.captured) {
          this.logger.warn('最后窗口关闭时存储采集失败，将回退到上次检查点');
        }
        return result;
      } catch {
        this.logger.warn('最后窗口关闭时存储采集异常，将回退到上次检查点');
        return { captured: false, changed: false };
      }
    })();

    this._lastPageCloseCapturePromise = captureTask;
    void captureTask.finally(() => {
      if (this._lastPageCloseCapturePromise === captureTask) {
        this._lastPageCloseCapturePromise = null;
      }
    });
    return captureTask;
  }

  async waitForPendingStorageCapture() {
    return awaitPendingStorageCapture(
      this._lastPageCloseCapturePromise || this._storageCapturePromise
    );
  }

  acceptSessionStorageCheckpoint(source, checkpoint) {
    try {
      const page = source?.page;
      // 权威存储bootstrap和恢复导航期间的临时文档不能污染服务端恢复队列。
      // A manager-driven close has already captured every live tab. Its context
      // is then cleared before pages close; pagehide must not replace that
      // complete snapshot with an empty or partially closed topology.
      if (
        this.isClosing ||
        !this.context ||
        !this.startupReady ||
        !this.state ||
        !checkpoint ||
        !page
      )
        return;
      // 绑定可被网页调用；只允许当前主frame提供自己实际URL/origin的状态。
      if (!isTrustedSessionStorageCheckpoint(source, checkpoint)) return;
      const url = page.url();
      if (checkpoint.url !== url) return;
      let index = this._sessionStoragePageIndices.get(page);
      if (!Number.isSafeInteger(index)) {
        index = this.context
          ?.pages()
          .filter(
            candidate => !candidate.isClosed() && shouldCollectRecoveryPageUrl(candidate.url())
          )
          .indexOf(page);
      }
      if (!Number.isSafeInteger(index) || index < 0) return;
      this._sessionStoragePageIndices.set(page, index);
      let tab = this._sessionStorageByPage.get(page);
      tab = tab?.url === url ? structuredClone(tab) : { index, url, origins: [] };
      tab.origins = tab.origins.filter(item => item.origin !== checkpoint.origin);
      tab.origins.push({ origin: checkpoint.origin, entries: checkpoint.entries });
      const normalized = normalizeSessionStorage([{ ...tab, index: 0 }]);
      if (!normalized) return;
      this._sessionStorageByPage.set(page, { ...normalized[0], index });
      this.syncSessionStorageTopology();
      this.markRecoveryChanged('sessionStorage:pagehide', { notify: false });
    } catch {}
  }

  syncSessionStorageTopology() {
    if (!this.state) return;
    const pages =
      this.context
        ?.pages()
        .filter(page => !page.isClosed() && shouldCollectRecoveryPageUrl(page.url())) || [];
    const sessionStorage = reindexSessionStorageTabs({
      pages,
      byPage: this._sessionStorageByPage,
      indices: this._sessionStoragePageIndices,
      previousTabs: this.state.sessionStorage || [],
      closedTabs: this._closingSessionStorageBatch,
    });
    this.state = { ...this.state, sessionStorage };
  }

  /** 在manager完成进程清理之后、最终CAS/outbox保存之前调用。 */
  async captureStoppedPortableProfile({ notify = false } = {}) {
    if (this._portableProfileCapturePromise) return this._portableProfileCapturePromise;
    this._portableProfileCaptureError = null;
    this._portableProfileCapturePromise = (async () => {
      try {
        const portableProfile = await capturePortableProfile({
          profileDir: this.userDataDir,
          kernelVersion: this.config?.base?.browserVersion,
          assertStopped: async () =>
            (await this.findBrowserProcesses(this.userDataDir, this.id, { strict: true }))
              .length === 0,
        });
        // Read the stopped native filesystem with its own OS/kernel in an isolated copy.
        // No site scripts, workers, proxy credentials or external requests run in this reader.
        const readerDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'test-opfs-export-'));
        let reader;
        let opfs;
        try {
          await restorePortableProfile({
            profileDir: readerDir,
            kernelVersion: this.config.base.browserVersion,
            snapshot: portableProfile,
            assertStopped: async () => true,
          });
          await prepareProxyNetworkProfile(readerDir, true);
          reader = await chromium.launchPersistentContext(readerDir, applyProxyNetworkPolicy({
            executablePath: this.browserPath,
            headless: true,
            serviceWorkers: 'block',
          }, { server: 'http://127.0.0.1:9' }));
          const origins = new Set(
            [
              ...(this.state?.origins || []).map(entry => entry.origin),
              ...(this.state?.opfs?.origins || []).map(entry => entry.origin),
              ...(this.state?.sessionStorage || []).flatMap(tab =>
                tab.origins.map(entry => entry.origin)
              ),
              ...(this.pages || []).map(page => {
                try {
                  return new URL(page.url).origin;
                } catch {
                  return '';
                }
              }),
            ].filter(origin => /^https?:\/\//.test(origin))
          );
          opfs = await captureOpfs(reader, [...origins]);
        } finally {
          if (reader) await reader.close();
          await fs.promises.rm(readerDir, { recursive: true, force: true });
        }
        const normalized = normalizeBrowserStorageState({
          ...(this.state || { cookies: [], origins: [] }),
          portableProfile,
          opfs,
        });
        if (!normalized) throw new Error('完整浏览器档案超过同步限制或格式无效');
        this.state = normalized;
        this._normalizedStorageState = normalized;
        this._lastStorageStateSerialized = JSON.stringify(normalized);
        this.markRecoveryChanged('portable-profile:closed', { notify });
        return { captured: true };
      } catch (error) {
        this._portableProfileCaptureError = error;
        throw error;
      } finally {
        this._portableProfileCapturePromise = null;
      }
    })();
    return this._portableProfileCapturePromise;
  }

  /**
   * 导航和 load 可能紧密连续发生，最多每 5 秒真实采集一次。
   */
  scheduleStorageCheckpoint(reason = '') {
    if (this.isClosing || !this.context) return;
    this._pendingStorageCheckpointReason = reason || this._pendingStorageCheckpointReason;
    if (this.storageCheckpointTimer) return;

    const elapsed = Date.now() - this._lastStorageCaptureAt;
    const delay = Math.max(0, STORAGE_CHECKPOINT_THROTTLE_MS - elapsed);
    this.storageCheckpointTimer = setTimeout(async () => {
      this.storageCheckpointTimer = null;
      const pendingReason = this._pendingStorageCheckpointReason;
      this._pendingStorageCheckpointReason = '';
      await this.captureStorageState(pendingReason || 'page-event');
    }, delay);
  }

  startStorageCheckpointing() {
    if (this.storageCheckpointInterval) clearInterval(this.storageCheckpointInterval);
    this.storageCheckpointInterval = setInterval(async () => {
      if (this.isClosing || !this.context) return;
      await this.captureStorageState('周期检查点', { force: true });
    }, STORAGE_CHECKPOINT_INTERVAL_MS);
  }

  /**
   * 设置事件监听器（仅对新创建的页面生效）
   * 注意：context 的 close 事件由 browserManager 统一处理
   */
  setupEventListeners() {
    // 监听新页面创建（仅对之后新创建的页面生效）
    this.context.on('page', page => {
      if (this.isClosing) return;

      // 检查页面是否已经关闭（防止操作已关闭的页面）
      if (page.isClosed()) {
        this.logger.debug('页面已关闭，忽略事件');
        return;
      }

      // 新标签创建时通常仍是 about:blank，必须立即注册，才能捕获紧接着发生的导航。
      this.logger.info('检测到新页面');
      this.registerPageEvents(page);
      this.pages = this.collectCurrentPages();
      this.notifyStateChanged('page-created');
    });
  }

  /**
   * 为所有现有页面注册事件监听器
   */
  registerExistingPagesEvents() {
    const pages = this.context.pages();
    let registeredCount = 0;
    for (const page of pages) {
      // 跳过已关闭的页面
      if (page.isClosed()) {
        this.logger.debug(`跳过已关闭的页面`);
        continue;
      }
      // 当前即使是 about:blank/内部页面也注册，以捕获之后导航到普通网页的事件。
      this.registerPageEvents(page);
      registeredCount++;
    }
    this.logger.info(`已为 ${registeredCount} 个现有页面注册事件监听器`);
  }

  /**
   * 为单个页面注册事件监听器
   * @param {import('playwright').Page} page - 页面对象
   */
  registerPageEvents(page) {
    // 如果正在关闭，不注册事件
    if (this.isClosing) return;

    // 检查页面是否已关闭
    if (page.isClosed()) {
      this.logger.debug(`页面已关闭，跳过事件注册`);
      return;
    }

    // 检查页面是否已经注册过事件（使用 WeakSet 追踪）
    if (this.registeredPages.has(page)) {
      return;
    }

    // 标记页面已注册事件
    this.registeredPages.add(page);

    const pageUrl = page.url();
    this._pageLastUrl.set(page, pageUrl);
    this.logger.info('已注册页面事件');

    // 监听页面关闭 - 只保存状态，不设置 isClosing
    page.on('close', () => {
      if (this.isClosing) return;

      // 关闭时优先从缓存取 URL（close 时 page.url() 可能已不可用）
      let closingUrl = this._pageLastUrl.get(page);
      if (!closingUrl) {
        try {
          closingUrl = page.url();
        } catch {}
      }
      this._pageLastUrl.delete(page);

      if (shouldCollectRecoveryPageUrl(closingUrl)) {
        this._closingPagesBatch.push({ url: closingUrl });
        this._closingSessionStorageBatch.push({ page, url: closingUrl });
      }

      // 检查是否是浏览器整体关闭（多个标签页同时被关闭）
      let remainingCount = 0;
      try {
        if (!this.context) return;
        remainingCount = this.context.pages().filter(p => !p.isClosed()).length;
      } catch {
        // context 已失效，说明浏览器正在关闭
        return;
      }
      this.syncSessionStorageTopology();

      if (remainingCount === 0) {
        // Chromium 可能紧接着触发 context close，立即开始最终存储采集。
        void this.startFinalStorageCapture('最后标签页关闭');

        // 整窗关闭：使用本批次关闭的页面作为完整快照
        if (this._closingBatchTimer) {
          clearTimeout(this._closingBatchTimer);
          this._closingBatchTimer = null;
        }
        if (this._closingPagesBatch.length > 0) {
          this._lastGoodPages = [...this._closingPagesBatch];
        }
        this._closingPagesBatch = [];
        this.logger.info(
          `最后一个标签页关闭，保留 _lastGoodPages (${this._lastGoodPages.length} 个页面)`
        );
        return;
      }

      // 正常的单标签关闭，更新页面列表
      // 整窗关闭时多个 close 事件会紧密连续到达，短暂保留批次；
      // 普通单标签关闭则在事件稳定后清空。
      if (this._closingBatchTimer) clearTimeout(this._closingBatchTimer);
      this._closingBatchTimer = setTimeout(() => {
        this._closingPagesBatch = [];
        this._closingSessionStorageBatch = [];
        this._closingBatchTimer = null;
      }, 250);
      this.pages = this.collectCurrentPages();
      this.logger.info(`标签页已关闭，剩余 ${remainingCount} 个页面`);
      this.notifyStateChanged('page-closed');
    });

    // 监听主帧导航，更可靠地记录浏览历史
    page.on('framenavigated', async frame => {
      if (this.isClosing || page.isClosed()) return;
      // 仅记录主帧导航
      try {
        if (frame !== page.mainFrame()) return;
        const url = frame.url();
        this._pageLastUrl.set(page, url);
        // 先同步登记访问，再异步补标题，避免 load/启动补记与这里竞争后重复计数。
        this.historyManager.addEntry(url);
        const title = await page.title().catch(() => '');
        this.historyManager.updateEntryMetadata(url, title);
        this.logger.debug('已更新浏览历史');
      } catch {}

      this.pages = this.collectCurrentPages();
      this.scheduleStorageCheckpoint('page-navigated');
      this.notifyStateChanged('page-navigated');
    });

    // 页面完全加载后更新标题并保存状态
    page.on('load', async () => {
      if (this.isClosing) return;
      // 再次检查页面是否有效
      if (page.isClosed()) return;

      // 更新历史记录标题
      try {
        const url = page.url();
        this._pageLastUrl.set(page, url);
        const title = await page.title().catch(() => '');
        this.historyManager.updateEntryMetadata(url, title);
      } catch {}

      this.pages = this.collectCurrentPages();
      this.scheduleStorageCheckpoint('page-loaded');
      this.notifyStateChanged('page-loaded');
    });
  }

  /**
   * 将 Chromium 启动时已经恢复完成、或 restorePages 主动打开的页面补入自定义历史。
   * ensureEntry 不会增加已有条目的 visitCount，因此不会与导航事件重复计数。
   */
  async ensureCurrentPagesInHistory() {
    if (!this.context) return;

    for (const page of this.context.pages()) {
      if (page.isClosed()) continue;
      const url = page.url();
      try {
        const title = await page.title().catch(() => '');
        this.historyManager.ensureEntry(url, title);
      } catch {
        // 单个页面在遍历中关闭，不影响其他页面的历史补记。
      }
    }
  }

  /**
   * 清理 Chrome 崩溃标记文件
   * Chrome 在非正常退出后会在 Preferences 中写入 exit_type: Crashed，
   * 下次启动时会弹出"页面未正确关闭"的恢复提示。
   * 此方法在启动前将 exit_type 重置为 Normal 以抑制该提示。
   */
  /**
   * 将 Chrome Preferences 中的 exit_type 写为 Normal，exited_cleanly 写为 true。
   * 可在启动前调用（清除上次残留的 Crashed 标记），
   * 也可在关闭后调用（Playwright context.close() 不会写 Normal，需要我们手动补写）。
   * @param {string} [dataDir] - 用户数据目录，默认使用 this.userDataDir
   */
  cleanCrashSentinel(dataDir) {
    const dir = dataDir || this.userDataDir;
    if (!dir) return;

    // Chrome 可能使用 Default 或直接在根目录
    const candidates = [path.join(dir, 'Default', 'Preferences'), path.join(dir, 'Preferences')];

    for (const prefsPath of candidates) {
      try {
        if (!fs.existsSync(prefsPath)) continue;

        const raw = fs.readFileSync(prefsPath, 'utf-8');
        const prefs = JSON.parse(raw);

        if (!prefs.profile) prefs.profile = {};
        prefs.profile.exit_type = 'Normal';
        prefs.profile.exited_cleanly = true;
        // 兼容不同 Chromium 版本的字段位置
        prefs.exit_type = 'Normal';
        prefs.exited_cleanly = true;

        fs.writeFileSync(prefsPath, JSON.stringify(prefs), 'utf-8');
        this.logger.info(`已写入 exit_type=Normal: ${prefsPath}`);
      } catch (e) {
        this.logger.debug(`清理崩溃标记失败（可忽略）: ${e.message}`);
      }
    }

    // 同时删除 Crash Reports 中的 pending 文件，避免下次启动时上传崩溃报告弹窗
    try {
      const crashDir = path.join(dir, 'Crash Reports', 'pending');
      if (fs.existsSync(crashDir)) {
        const files = fs.readdirSync(crashDir);
        for (const f of files) {
          fs.unlinkSync(path.join(crashDir, f));
        }
        if (files.length > 0) {
          this.logger.info(`已清理 ${files.length} 个崩溃报告文件`);
        }
      }
    } catch (e) {
      // 忽略
    }
  }

  /**
   * 恢复已保存的页面或创建初始页面
   * 注意：launchPersistentContext 会自动从 userDataDir 恢复页面
   * 我们只需要确保至少有一个页面，并在首次启动时导航到初始 URL
   */
  async restorePages() {
    // pagehide/DOMContentLoaded绑定会更新运行态；恢复队列始终使用启动时的完整快照。
    const savedSessionStorage = structuredClone(
      this._startupSessionStorage ?? this.state?.sessionStorage ?? []
    );
    return restoreStartupPages({
      context: this.context,
      savedPages: this._startupPages || this.pages,
      initialUrl: this.config?.base?.url,
      proxyEnabled: Boolean(this.config?.proxy?.enabled),
      isInternalPageUrl: url => this.isInternalPageUrl(url),
      logger: this.logger,
      beforeNavigate: async (page, url, index) => {
        const snapshot = selectSessionStorageForTab(savedSessionStorage, url, index);
        this.logger.debug(`恢复标签临时存储: index=${index}, matched=${Boolean(snapshot)}`);
        return installSessionStorageForNavigation(this.context, page, snapshot);
      },
    });
  }

  /**
   * 启动生命周期检查
   * 检测所有页面关闭时，主动关闭 context
   */
  startLifecycleCheck() {
    this.lifecycleCheckInterval = setInterval(async () => {
      // 如果正在关闭，停止检查
      if (this.isClosing) {
        this.logger.debug('浏览器正在关闭，停止生命周期检查');
        clearInterval(this.lifecycleCheckInterval);
        this.lifecycleCheckInterval = null;
        return;
      }

      // 如果上下文已失效，停止检查
      if (!this.context) {
        this.logger.debug('浏览器上下文已失效，停止生命周期检查');
        clearInterval(this.lifecycleCheckInterval);
        this.lifecycleCheckInterval = null;
        return;
      }

      try {
        const allPages = this.context.pages();
        const openPages = allPages.filter(page => !page.isClosed());
        const validPages = openPages.filter(page => !this.isInternalPageUrl(page.url()));
        const lifecycleAction = resolveBrowserLifecycleAction({
          openPageCount: openPages.length,
          validPageCount: validPages.length,
        });

        if (lifecycleAction !== BROWSER_LIFECYCLE_ACTIONS.KEEP_OPEN) {
          // 必须在任何 await 前占用关闭流程，防止 300ms 定时器回调重入。
          if (!claimBrowserLifecycleClose(this)) return;
          this.clearTimers();

          if (lifecycleAction === BROWSER_LIFECYCLE_ACTIONS.CLOSE_AND_PRESERVE) {
            this.logger.info('检测到最后一个页面已关闭，主动关闭浏览器上下文并保留历史快照');
            await this.forceSaveState();
            try {
              const closed = await this.gracefulClose();
              if (closed) {
                this.logger.info('无页面浏览器上下文已主动关闭');
              } else {
                this.logger.warn('无页面浏览器上下文未能优雅关闭，清理残留进程');
                await this.forceKillBrowserByPaths(this.userDataDir, this.browserPath, this.id);
              }
            } catch (error) {
              this.logger.warn(`关闭无页面浏览器上下文失败: ${error.message}`);
            }
            return;
          }

          // 仍有内部页面打开 → 用户主动关闭了所有内容标签
          this.logger.info(`没有有效页面 (打开: ${openPages.length})，主动关闭浏览器上下文`);

          await this.forceSaveState();

          // 用户主动关闭了所有内容标签，下次打开不应恢复已关闭页面。
          this.pages = [];
          this._lastGoodPages = [];
          this.notifyStateChanged('all-tabs-closed');

          const dataDir = this.userDataDir;
          const browserPath = this.browserPath;
          const instanceId = this.id;
          const closeResult = await closeLifecycleContext({
            closeGracefully: () => this.gracefulClose(),
            forceClose: () => this.forceKillBrowserByPaths(dataDir, browserPath, instanceId),
          });
          if (closeResult.graceful) {
            this.logger.info('浏览器上下文已通过生命周期检查优雅关闭');
          } else if (closeResult.closed) {
            this.logger.warn('浏览器上下文关闭超时，残留进程已清理');
          } else {
            this.logger.error('浏览器上下文关闭超时，且残留进程清理失败');
          }

          await new Promise(resolve => setTimeout(resolve, 800));
          if (closeResult.closed) {
            await this.finalizeCrashSentinel(dataDir);
          }
        }
      } catch (error) {
        this.logger.error(`生命周期检查失败: ${error.message}`);
      }
    }, 300);
  }

  /**
   * 保存当前浏览器状态（防抖 500ms，由页面事件触发）
   */
  saveState() {
    if (this.isClosing) return;

    if (this.saveStateTimer) {
      clearTimeout(this.saveStateTimer);
    }

    this.saveStateTimer = setTimeout(async () => {
      this.saveStateTimer = null;
      if (this.isClosing) return;
      await this.performSaveState();
    }, 500);
  }

  /**
   * 强制采集并保存状态（关闭前调用，绕过防抖和 isClosing）
   * 返回快照数据，供 browserManager 直接使用
   * @returns {Promise<{id: string, pages: Array, state: Object|null, config: Object}>}
   */
  async forceSaveState() {
    if (this.saveStateTimer) {
      clearTimeout(this.saveStateTimer);
      this.saveStateTimer = null;
    }
    if (this._closingBatchTimer) {
      clearTimeout(this._closingBatchTimer);
      this._closingBatchTimer = null;
    }

    // 尝试从活跃 context 采集最新数据
    try {
      if (this.context) {
        try {
          // 优先获取最新的页面信息
          const currentPages = this.collectCurrentPages();
          if (currentPages.length > 0) {
            this.pages = currentPages;
            this._lastGoodPages = currentPages;
          }
          // 获取包含 IndexedDB 的最终存储状态
          await this.captureStorageState('关闭前', { force: true, notify: false });
        } catch (error) {
          this.logger.warn(`context 操作失败，使用缓存数据: ${error.message}`);
          // 即使 context 操作失败，也要尝试获取页面信息
          const currentPages = this.collectCurrentPages();
          if (currentPages.length > 0) {
            this.pages = currentPages;
            this._lastGoodPages = currentPages;
          }
        }
      }
    } catch (error) {
      this.logger.warn(`forceSaveState 采集失败: ${error.message}`);
    }

    // 无论采集是否成功，getSnapshot 始终返回可用数据（依赖 _lastGoodPages）
    const snapshot = this.getSnapshot();
    this.logger.info(`forceSaveState 完成 (${snapshot.pages.length} 个页面)`);
    return snapshot;
  }

  /**
   * 执行实际的状态保存（由防抖定时器触发）
   */
  async performSaveState() {
    if (this.isClosing) return;

    try {
      if (!this.context) {
        this.logger.debug('浏览器已关闭，跳过状态保存');
        return;
      }

      await this.captureStorageState('事件保存', { force: true, notify: false });
      this.pages = this.collectCurrentPages();
      this.emitStateSnapshot();
    } catch (error) {
      this.logger.error(`保存状态失败: ${error.message}`);
    }
  }

  /**
   * 优雅关闭浏览器：先逐个关闭页面，再关闭 context
   * 避免直接 context.close() 导致 Chrome 检测到异常退出
   */
  async gracefulClose() {
    if (!this.context) return true;

    try {
      const pages = this.context.pages().filter(p => !p.isClosed());
      // 逐个关闭页面（保留最后一个，让 context.close() 自然退出）
      for (let i = pages.length - 1; i >= 1; i--) {
        try {
          await pages[i].close();
        } catch {}
      }
      // 短暂等待页面关闭完成
      await new Promise(resolve => setTimeout(resolve, 200));
    } catch {}

    // 关闭 context
    try {
      await closeContextWithTimeout(this.context);
      return true;
    } catch (error) {
      this.logger.warn(`gracefulClose context 关闭失败: ${error.message}`);
      return false;
    }
  }

  /**
   * 关闭浏览器
   * @returns {Promise<boolean>} 是否成功关闭
   */
  async close() {
    // 防止重复关闭
    if (this.isClosing) {
      this.logger.debug('浏览器已在关闭中，跳过重复调用');
      return true;
    }

    // 关闭前强制采集最终状态（此时 context 仍然存活）
    await this.forceSaveState();

    this.isClosing = true;
    this.logger.info(`开始关闭浏览器实例: ${this.id}`);

    // 保存路径信息用于后续进程清理
    const savedUserDataDir = this.userDataDir;
    const savedBrowserPath = this.browserPath;
    const savedId = this.id;
    const savedContext = this.context;

    // 先清理定时器
    this.clearTimers();

    // 尝试优雅关闭上下文（先关闭页面再关闭 context）
    let contextClosedGracefully = false;
    if (savedContext) {
      try {
        contextClosedGracefully = await this.gracefulClose();
        if (contextClosedGracefully) this.logger.info('浏览器上下文已优雅关闭');
      } catch (error) {
        this.logger.warn(`关闭浏览器上下文失败: ${error.message}`);
      }
    }

    // 清理实例属性
    this.context = null;
    this.browser = null;

    if (contextClosedGracefully) {
      // 优雅关闭成功，等待进程自然退出
      await new Promise(resolve => setTimeout(resolve, 1500));
    } else {
      // 优雅关闭失败，使用温和方式清理残留进程
      await new Promise(resolve => setTimeout(resolve, 300));
      await this.forceKillBrowserByPaths(savedUserDataDir, savedBrowserPath, savedId);
    }

    // 在进程退出后修复 crash sentinel，避免下次启动提示"异常关闭"
    await this.finalizeCrashSentinel(savedUserDataDir);

    await this.captureStoppedPortableProfile({ notify: false });

    // 最后清理所有属性
    this.cleanupFinal();

    this.logger.info(`浏览器实例 ${savedId} 关闭完成`);
    return true;
  }

  /**
   * 清理定时器
   */
  clearTimers() {
    if (this.lifecycleCheckInterval) {
      clearInterval(this.lifecycleCheckInterval);
      this.lifecycleCheckInterval = null;
    }
    if (this.saveStateTimer) {
      clearTimeout(this.saveStateTimer);
      this.saveStateTimer = null;
    }
    if (this._closingBatchTimer) {
      clearTimeout(this._closingBatchTimer);
      this._closingBatchTimer = null;
    }
    if (this.storageCheckpointTimer) {
      clearTimeout(this.storageCheckpointTimer);
      this.storageCheckpointTimer = null;
    }
    if (this.storageCheckpointInterval) {
      clearInterval(this.storageCheckpointInterval);
      this.storageCheckpointInterval = null;
    }
    this._pendingStorageCheckpointReason = '';
  }

  /**
   * 最终清理实例资源
   */
  closeProxyBridge() {
    if (this._proxyBridge) {
      void this._proxyBridge.close();
      this._proxyBridge = null;
    }
  }

  cleanupFinal() {
    this.closeProxyBridge();
    if (this._profileProcessStopped) {
      try {
        releaseBrowserProfileLaunchPath(this._profileLaunchPath);
      } catch (error) {
        this.logger.warn(`临时启动目录清理失败: ${error.message}`);
      }
    }
    this._profileLaunchPath = null;
    // 清理定时器
    this.clearTimers();

    // 重置所有实例状态
    this.browser = null;
    this.context = null;
    this.state = null;
    this.pages = [];
    this.config = null;
    this.browserPath = null;
    this.userDataDir = null;
    this._storageCapturePromise = null;
    this._lastPageCloseCapturePromise = null;
    this._closingPagesBatch = [];
    this._closingBatchTimer = null;
    if (this._pageLastUrl) this._pageLastUrl.clear();
  }

  /**
   * 通过保存的路径信息强制关闭浏览器进程
   * @param {string} userDataDir - 用户数据目录
   * @param {string} browserPath - 浏览器路径
   * @param {string} instanceId - 实例 ID
   * @returns {Promise<boolean>} 是否成功清理所有进程
   */
  async forceKillBrowserByPaths(userDataDir, browserPath, instanceId) {
    if (!userDataDir || !isSafeInstanceId(instanceId)) {
      return true;
    }

    this.logger.info('正在强制清理浏览器进程...');

    try {
      let remainingPids = await this.findBrowserProcesses(userDataDir, instanceId);
      for (const pid of remainingPids) {
        await this.terminateProcessTree(pid, false);
      }
      await new Promise(resolve => setTimeout(resolve, 500));

      remainingPids = await this.findBrowserProcesses(userDataDir, instanceId);
      if (remainingPids.length > 0) {
        this.logger.warn(`仍有 ${remainingPids.length} 个进程未响应 SIGTERM，尝试 SIGKILL`);
        for (const pid of remainingPids) {
          await this.terminateProcessTree(pid, true);
        }
        await new Promise(resolve => setTimeout(resolve, 300));
        remainingPids = await this.findBrowserProcesses(userDataDir, instanceId);
        if (remainingPids.length > 0) {
          this.logger.warn(
            `SIGKILL 后仍有 ${remainingPids.length} 个进程: ${remainingPids.join(', ')}`
          );
          return false;
        }
      }

      this.logger.info('浏览器进程清理完成');
      return true;
    } catch (error) {
      this.logger.error(`强制关闭浏览器失败: ${error.message}`);
      return false;
    }
  }

  /**
   * 仅允许针对本应用 browser-data 下、以 <instanceId> 结尾的目录匹配进程。
   */
  resolveManagedUserDataDir(userDataDir, instanceId) {
    if (!userDataDir || !isSafeInstanceId(instanceId)) return null;
    const baseDir = path.resolve(getAppPath(), 'browser-data');
    const resolvedDir = path.resolve(userDataDir);
    if (!resolvedDir.startsWith(baseDir + path.sep) || path.basename(resolvedDir) !== instanceId) {
      this.logger.warn('拒绝清理非本应用管理的浏览器数据目录');
      return null;
    }
    return resolvedDir;
  }

  async terminateProcessTree(pid, force = false) {
    const numericPid = Number(pid);
    if (!Number.isSafeInteger(numericPid) || numericPid <= 1 || numericPid === process.pid) return;
    try {
      if (process.platform === 'win32') {
        const args = ['/PID', String(numericPid), '/T'];
        if (force) args.push('/F');
        await execFileAsync('taskkill.exe', args, { windowsHide: true });
      } else {
        process.kill(numericPid, force ? 'SIGKILL' : 'SIGTERM');
      }
    } catch (error) {
      if (error?.code !== 'ESRCH')
        this.logger.debug(`终止进程 ${numericPid} 失败: ${error.message}`);
    }
  }

  /**
   * 查找与浏览器相关的进程
   * @param {string} userDataDir - 用户数据目录
   * @param {string} instanceId - 实例 ID
   * @returns {Promise<string[]>} 进程 ID 列表
   */
  async findBrowserProcesses(userDataDir, instanceId, { strict = false } = {}) {
    const managedDir = this.resolveManagedUserDataDir(userDataDir, instanceId);
    if (!managedDir) {
      if (strict) throw new Error('浏览器档案不在受控目录，无法确认进程退出');
      return [];
    }

    try {
      if (process.platform === 'win32') {
        const command =
          'Get-CimInstance Win32_Process | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress';
        const { stdout } = await execFileAsync(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-Command', command],
          { windowsHide: true, maxBuffer: 10 * 1024 * 1024 }
        );
        const parsed = stdout.trim() ? JSON.parse(stdout) : [];
        const processes = Array.isArray(parsed) ? parsed : [parsed];
        const managedPaths = this._profileLaunchPath
          ? getBrowserProfileProcessPaths(this._profileLaunchPath, managedDir)
          : [managedDir];
        const pids = processes
          .filter(item => /chrome|chromium/i.test(item?.Name || ''))
          .filter(item => browserCommandUsesProfile(item?.CommandLine, managedPaths))
          .map(item => Number(item.ProcessId))
          .filter(pid => Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid);
        this._profileProcessStopped = pids.length === 0;
        return pids;
      }

      const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,command='], {
        maxBuffer: 10 * 1024 * 1024,
      });
      return stdout
        .split('\n')
        .map(line => line.match(/^\s*(\d+)\s+(.+)$/))
        .filter(Boolean)
        .filter(([, , command]) => /chrome|chromium/i.test(command) && command.includes(managedDir))
        .map(([, pid]) => Number(pid))
        .filter(pid => Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid);
    } catch (error) {
      this.logger.warn(`查找浏览器进程失败: ${error.message}`);
      if (strict) throw new Error('无法确认浏览器进程已退出，已停止完整档案同步');
      return [];
    }
  }

  /**
   * 强制关闭浏览器进程（使用实例属性）
   * 只匹配当前实例受管理的数据目录。
   */
  async forceKillBrowser() {
    await this.forceKillBrowserByPaths(this.userDataDir, this.browserPath, this.id);
  }

  /**
   * 清理实例资源（向后兼容方法，调用 cleanupFinal）
   * @deprecated 请使用 cleanupFinal()
   */
  cleanup() {
    this.cleanupFinal();
  }
}
