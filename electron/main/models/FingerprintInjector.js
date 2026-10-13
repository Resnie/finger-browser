import crypto from 'crypto';
import { buildStableCanvasTextScript } from './fingerprintCanvasText.mjs';
import {
  resolveNavigatorPlatform,
  resolveWebGLIdentity,
} from '../../../shared/fingerprintIdentity.mjs';

export { resolveNavigatorPlatform, resolveWebGLIdentity };

/**
 * 指纹注入器
 * 基于实例 ID 和配置生成确定性指纹注入脚本
 */
export class FingerprintInjector {
  /**
   * @param {string} instanceId - 实例 ID（用于生成确定性种子）
   * @param {Object} fingerConfig - 指纹配置
   * @param {string} userAgent - 用于兼容旧配置的 User-Agent
   */
  constructor(instanceId, fingerConfig = {}, userAgent = '') {
    this.instanceId = instanceId;
    this.userAgent = userAgent;
    // 仅构造运行时副本，不回写从服务端读取的旧配置。
    this.seed = this._deriveSeed(instanceId);
    const automatic = fingerConfig?.autoFingerprint === true;
    this.config = {
      ...fingerConfig,
      ...(fingerConfig?.autoFingerprint === true
        ? { canvas: true, webgl: true, audioFingerprint: true, clientRects: true }
        : {}),
      platform: resolveNavigatorPlatform(fingerConfig?.platform, userAgent),
    };
    if (automatic) {
      if (!(Number(this.config.hardwareConcurrency) > 0)) this.config.hardwareConcurrency = [4, 8, 12, 16][this.seed % 4];
      if (!(Number(this.config.deviceMemory) > 0)) this.config.deviceMemory = [4, 8][(this.seed >>> 3) % 2];
      if (!this.config.screenResolution || this.config.screenResolution === 'auto') this.config.screenResolution = ['1366x768', '1440x900', '1920x1080'][(this.seed >>> 6) % 3];
      if (!this.config.timezone || this.config.timezone === 'auto') this.config.timezone = String(this.config.language || '').startsWith('zh') ? 'Asia/Shanghai' : 'UTC';
      if (!Number(this.config.colorDepth)) this.config.colorDepth = 24;
    }
  }

  /**
   * 基于实例 ID 派生确定性种子
   */
  _deriveSeed(id) {
    const hash = crypto.createHash('sha256').update(`fingerprint-seed-${id}`).digest('hex');
    return parseInt(hash.substring(0, 8), 16);
  }

  /**
   * 获取完整的注入脚本
   */
  getInjectionScript() {
    const parts = [
      this._buildSeedRng(),
      ...(this.config.autoFingerprint === true ? [buildStableCanvasTextScript()] : []),
      this._buildNavigatorOverrides(),
      this._buildScreenOverrides(),
    ];

    if (this.config.canvas !== false) {
      parts.push(this._buildCanvasOverrides());
      parts.push(this._buildOffscreenCanvasOverrides());
    }
    if (this.config.webgl !== false) {
      parts.push(this._buildWebGLOverrides());
    }
    if (this.config.audioFingerprint !== false) {
      parts.push(this._buildAudioOverrides());
    }
    if (this.config.webRTC === 'disable') {
      parts.push(this._buildWebRTCDisable());
    } else if (this.config.webRTC === 'proxy_only') {
      parts.push(this._buildWebRTCProxyOnly());
    }
    if (this.config.fonts && this.config.fonts !== 'default') {
      parts.push(this._buildFontOverrides());
    }
    if (this.config.plugins && this.config.plugins !== 'default') {
      parts.push(this._buildPluginOverrides());
    }
    if (this.config.clientRects) {
      parts.push(this._buildClientRectsOverrides());
    }
    if (this.config.batteryAPI && this.config.batteryAPI !== 'real') {
      parts.push(this._buildBatteryOverrides());
    }
    if (this.config.mediaDevices && this.config.mediaDevices !== 'real') {
      parts.push(this._buildMediaDevicesOverrides());
    }

    return `(function() {\n'use strict';\n${parts.join('\n')}\n})();`;
  }

  /**
   * 确定性伪随机数生成器（Mulberry32）
   */
  _buildSeedRng() {
    return `
const __seed = ${this.seed};
function __rng(s) {
  return function() {
    s |= 0; s = s + 0x6D2B79F5 | 0;
    var t = Math.imul(s ^ s >>> 15, 1 | s);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
const __random = __rng(__seed);
function __canvasNoise(image, sx, sy, width, height, sw, sh) {
  if (image.data.BYTES_PER_ELEMENT !== 1) return image;
  let state = __seed;
  sx = Math.trunc(Number(sx) || 0) + (Number(sw) < 0 ? Math.trunc(Number(sw)) : 0);
  sy = Math.trunc(Number(sy) || 0) + (Number(sh) < 0 ? Math.trunc(Number(sh)) : 0);
  const stride = image.width || width;
  for (let i = 0; i < image.data.length; i += 4) {
    let noise;
    if (${this.config.autoFingerprint === true}) {
      const x = sx + (i / 4) % stride, y = sy + Math.floor(i / 4 / stride);
      if (x < 0 || x >= width || y < 0 || y >= height) continue;
      let value = Math.imul(__seed ^ (y * width + x), 0x45d9f3b);
      value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
      noise = ((value ^ (value >>> 16)) >>> 0) % 3 - 1;
    } else {
      state = (state * 1103515245 + 12345) & 0x7fffffff;
      noise = state % 3 - 1;
    }
    image.data[i] = Math.max(0, Math.min(255, image.data[i] + noise));
  }
  return image;
}

`;
  }

  /**
   * Navigator 属性覆盖
   */
  _buildNavigatorOverrides() {
    const overrides = [];
    const c = this.config;
    const hardwareConcurrency = Number.parseInt(c.hardwareConcurrency, 10);
    const deviceMemory = Number(c.deviceMemory);
    const configuredLanguages = Array.isArray(c.languages) ? c.languages : [];
    const primaryLanguage = String(c.language || configuredLanguages[0] || '')
      .trim()
      .slice(0, 35);
    const languages = [
      ...new Set(
        [primaryLanguage, ...configuredLanguages]
          .map(value =>
            String(value || '')
              .trim()
              .slice(0, 35)
          )
          .filter(Boolean)
      ),
    ].slice(0, 10);

    // Playwright 默认会暴露 webdriver=true。改在原型上覆盖，
    // 避免给 navigator 增加一个异常的自有属性。
    overrides.push(
      `if (typeof Navigator !== 'undefined') Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => undefined, configurable: true });`
    );

    if (Number.isInteger(hardwareConcurrency) && hardwareConcurrency > 0) {
      overrides.push(
        `Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => ${Math.min(hardwareConcurrency, 64)} });`
      );
    }
    if (Number.isFinite(deviceMemory) && deviceMemory > 0) {
      overrides.push(
        `Object.defineProperty(navigator, 'deviceMemory', { get: () => ${Math.min(deviceMemory, 64)} });`
      );
    }
    if (c.platform) {
      overrides.push(
        `Object.defineProperty(navigator, 'platform', { get: () => ${JSON.stringify(String(c.platform).slice(0, 100))} });`
      );
    }
    if (languages.length > 0) {
      overrides.push(
        `Object.defineProperty(navigator, 'languages', { get: () => ${JSON.stringify(languages)} });`
      );
      overrides.push(
        `Object.defineProperty(navigator, 'language', { get: () => ${JSON.stringify(languages[0])} });`
      );
    }
    if (c.doNotTrack) {
      overrides.push(`Object.defineProperty(navigator, 'doNotTrack', { get: () => '1' });`);
    }

    return overrides.join('\n');
  }

  getWorkerInjectionScript() {
    return `(function(){\n${this._buildSeedRng()}\n${this.config.autoFingerprint === true ? buildStableCanvasTextScript() : ''}\n${this._buildNavigatorOverrides()}\n${this.config.canvas !== false ? this._buildOffscreenCanvasOverrides() : ''}\n})();`;
  }

  async installWorkerFingerprints(context, logger) {
    const script = this.getWorkerInjectionScript();
    // The pinned in-process Playwright adapter lets us inject before its own
    // worker resume. A second CDP attachment races that resume and is unsafe.
    const implementation = context._connection?.toImpl?.(context);
    if (!implementation?._browser?._session) throw new Error('Worker 指纹适配器不可用');
    const patched = new WeakSet();
    const cleanup = [];
    const patch = (parent, owned = true) => {
      if (patched.has(parent)) return;
      patched.add(parent);
      const targets = new Map();
      const targetListener = event => {
        const info = event.targetInfo;
        const browser = implementation._browser;
        const defaultTarget =
          browser._defaultContext === implementation &&
          !browser._contexts.has(info.browserContextId);
        if (owned || info.browserContextId === implementation._browserContextId || defaultTarget)
          targets.set(event.sessionId, info);
      };
      parent.prependListener('Target.attachedToTarget', targetListener);
      const originalCreate = parent.createChildSession;
      const create = function (id, ...args) {
        const child = originalCreate.call(this, id, ...args);
        const info = targets.get(id);
        if (!info) return child;
        patch(child);
        if (['worker', 'shared_worker', 'service_worker'].includes(info.type)) {
          const originalSend = child.send;
          let initialized = false;
          child.send = async function (method, params) {
            if (method === 'Runtime.runIfWaitingForDebugger' && !initialized) {
              initialized = true;
              try {
                await originalSend.call(this, 'Runtime.enable');
                const result = await originalSend.call(this, 'Runtime.evaluate', {
                  expression: script,
                });
                if (result.exceptionDetails) throw new Error(String(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'Worker script failed').slice(0, 300));
              } catch (error) {
                logger?.warn?.('Worker 指纹初始化失败: ' + error.message);
              }
            }
            return originalSend.call(this, method, params);
          };
        }
        return child;
      };
      parent.createChildSession = create;
      cleanup.push(() => {
        parent.removeListener('Target.attachedToTarget', targetListener);
        if (parent.createChildSession === create) parent.createChildSession = originalCreate;
      });
    };
    patch(implementation._browser._session, false);
    const installPage = page => {
      const nativePage = context._connection.toImpl(page);
      const session = nativePage?.delegate?._mainFrameSession?._client;
      if (!session) throw new Error('Worker 页面适配器不可用');
      patch(session);
    };
    context.on('page', installPage);
    context.pages().forEach(installPage);
    context.once('close', () => {
      context.removeListener('page', installPage);
      cleanup.reverse().forEach(fn => fn());
    });
  }

  _buildOffscreenCanvasOverrides() {
    return `
(function() {
  if (typeof OffscreenCanvasRenderingContext2D === 'undefined') return;
  const original = OffscreenCanvasRenderingContext2D.prototype.getImageData;
  OffscreenCanvasRenderingContext2D.prototype.getImageData = function() {
    const result = original.apply(this, arguments);
    return __canvasNoise(result, arguments[0], arguments[1], this.canvas.width, this.canvas.height, arguments[2], arguments[3]);
  };
  if (typeof OffscreenCanvas !== 'undefined' && OffscreenCanvas.prototype.convertToBlob) {
    const convert = OffscreenCanvas.prototype.convertToBlob;
    OffscreenCanvas.prototype.convertToBlob = function() {
      let copy;
      try {
        if (this.width && this.height) {
          copy = new OffscreenCanvas(this.width, this.height);
          const ctx = copy.getContext('2d');
          ctx.drawImage(this, 0, 0);
          const pixels = original.call(ctx, 0, 0, this.width, this.height);
          __canvasNoise(pixels, 0, 0, this.width, this.height);
          ctx.putImageData(pixels, 0, 0);
        }
      } catch { copy = null; }
      return convert.apply(copy || this, arguments);
    };
  }
})();
`;
  }

  /**
   * Screen 属性覆盖
   */
  _buildScreenOverrides() {
    const c = this.config;
    if (!c.screenResolution || c.screenResolution === 'auto') return '';

    if (!/^\d{3,5}x\d{3,5}$/.test(c.screenResolution)) return '';
    const [rawWidth, rawHeight] = c.screenResolution.split('x').map(Number);
    const w = Math.min(Math.max(Math.round(rawWidth), 320), 10000);
    const h = Math.min(Math.max(Math.round(rawHeight), 240), 10000);

    const requestedDepth = Number.parseInt(c.colorDepth, 10);
    const colorDepth = [24, 30, 32, 48].includes(requestedDepth) ? requestedDepth : 24;
    return `
Object.defineProperty(screen, 'width', { get: () => ${w} });
Object.defineProperty(screen, 'height', { get: () => ${h} });
Object.defineProperty(screen, 'availWidth', { get: () => ${w} });
Object.defineProperty(screen, 'availHeight', { get: () => ${h - 40} });
Object.defineProperty(screen, 'colorDepth', { get: () => ${colorDepth} });
Object.defineProperty(screen, 'pixelDepth', { get: () => ${colorDepth} });
`;
  }

  /**
   * Canvas 指纹噪声注入
   */
  _buildCanvasOverrides() {
    return `
(function() {
  const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
  const origToBlob = HTMLCanvasElement.prototype.toBlob;
  const origGetImageData = CanvasRenderingContext2D.prototype.getImageData;

  function createNoisyCopy(canvas) {
    try {
      if (!canvas.width || !canvas.height) return null;
      const copy = document.createElement('canvas');
      copy.width = canvas.width;
      copy.height = canvas.height;
      const ctx = copy.getContext('2d');
      if (!ctx) return null;
      ctx.drawImage(canvas, 0, 0);
      const imageData = origGetImageData.call(ctx, 0, 0, copy.width, copy.height);
      __canvasNoise(imageData, 0, 0, copy.width, copy.height);
      ctx.putImageData(imageData, 0, 0);
      return copy;
    } catch(e) {
      return null;
    }
  }

  HTMLCanvasElement.prototype.toDataURL = function() {
    const copy = createNoisyCopy(this);
    return origToDataURL.apply(copy || this, arguments);
  };
  HTMLCanvasElement.prototype.toBlob = function() {
    const copy = createNoisyCopy(this);
    return origToBlob.apply(copy || this, arguments);
  };
  CanvasRenderingContext2D.prototype.getImageData = function() {
    const result = origGetImageData.apply(this, arguments);
    return __canvasNoise(result, arguments[0], arguments[1], this.canvas.width, this.canvas.height, arguments[2], arguments[3]);
  };
})();
`;
  }

  /**
   * WebGL 指纹覆盖
   */
  _buildWebGLOverrides() {
    const identity = resolveWebGLIdentity({
      platform: this.config.platform,
      userAgent: this.userAgent,
      vendor: this.config.webglVendor,
      renderer: this.config.webglRenderer,
    });
    const vendor = JSON.stringify(identity.vendor.slice(0, 256));
    const renderer = JSON.stringify(identity.renderer.slice(0, 512));

    return `
(function() {
  const getParamOrig = WebGLRenderingContext.prototype.getParameter;
  const getParam2Orig = typeof WebGL2RenderingContext !== 'undefined' ? WebGL2RenderingContext.prototype.getParameter : null;

  function patchGetParameter(original) {
    return function(param) {
      const debugExt = this.getExtension('WEBGL_debug_renderer_info');
      if (debugExt) {
        if (param === debugExt.UNMASKED_VENDOR_WEBGL) return ${vendor};
        if (param === debugExt.UNMASKED_RENDERER_WEBGL) return ${renderer};
      }
      return original.call(this, param);
    };
  }

  WebGLRenderingContext.prototype.getParameter = patchGetParameter(getParamOrig);
  if (getParam2Orig) {
    WebGL2RenderingContext.prototype.getParameter = patchGetParameter(getParam2Orig);
  }
})();
`;
  }

  /**
   * AudioContext 指纹噪声
   */
  _buildAudioOverrides() {
    const normalize = this.config.autoFingerprint === true ? 'Math.round(array[i] * 1000) / 1000' : 'array[i]';
    const normalizeBuffer = this.config.autoFingerprint === true ? 'Math.round(data[i] * 1000) / 1000' : 'data[i]';
    return `
(function() {
  const origGetFloatFreq = AnalyserNode.prototype.getFloatFrequencyData;
  AnalyserNode.prototype.getFloatFrequencyData = function(array) {
    origGetFloatFreq.call(this, array);
    let r = __seed;
    for (let i = 0; i < array.length; i++) {
      r = (r * 1103515245 + 12345) & 0x7fffffff;
      array[i] = ${normalize} + (r % 100) * 0.00001;
    }
  };

  if (typeof OfflineAudioContext !== 'undefined') {
    const normalized = new WeakSet();
    function normalize(buffer) {
      if (normalized.has(buffer)) return buffer;
      normalized.add(buffer);
      for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
        const data = buffer.getChannelData(channel);
        let r = __seed ^ channel;
        for (let i = 0; i < data.length; i++) {
          r = (r * 1103515245 + 12345) & 0x7fffffff;
          data[i] = ${normalizeBuffer} + (r % 100) * 0.0000001;
        }
      }
      return buffer;
    }
    const origStartRendering = OfflineAudioContext.prototype.startRendering;
    OfflineAudioContext.prototype.startRendering = function() {
      if (this.addEventListener) this.addEventListener('complete', event => normalize(event.renderedBuffer), { capture: true, once: true });
      return origStartRendering.call(this).then(normalize);
    };
  }
})();
`;
  }

  /**
   * WebRTC 禁用
   */
  _buildWebRTCDisable() {
    return `
window.RTCPeerConnection = undefined;
window.webkitRTCPeerConnection = undefined;
window.mozRTCPeerConnection = undefined;
if (navigator.mediaDevices) {
  navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('Not allowed', 'NotAllowedError'));
}
`;
  }

  /**
   * WebRTC 仅代理模式
   */
  _buildWebRTCProxyOnly() {
    return `
(function() {
  const OrigRTC = window.RTCPeerConnection || window.webkitRTCPeerConnection;
  if (!OrigRTC) return;
  window.RTCPeerConnection = function(config) {
    if (config && config.iceServers) {
      config.iceServers = [];
    }
    config = config || {};
    config.iceTransportPolicy = 'relay';
    return new OrigRTC(config);
  };
  window.RTCPeerConnection.prototype = OrigRTC.prototype;
})();
`;
  }

  /**
   * 字体指纹覆盖
   */
  _buildFontOverrides() {
    return `
(function() {
  const origCheck = document.fonts.check.bind(document.fonts);
  const allowedFonts = new Set(['Arial', 'Helvetica', 'Times New Roman', 'Courier New', 'Verdana', 'Georgia', 'Palatino', 'Garamond', 'Comic Sans MS', 'Trebuchet MS'].map(font => font.toLowerCase()));

  function extractFontFamilies(font) {
    const value = String(font || '');
    const match = value.match(/(?:^|\\s)\\d*\\.?\\d+(?:px|pt|pc|in|cm|mm|em|rem|ex|ch|vw|vh|vmin|vmax|%)(?:\\/[^\\s]+)?\\s+(.+)$/i);
    if (!match) return [];
    return match[1]
      .split(',')
      .map(family => family.trim().replace(/^['"]|['"]$/g, '').replace(/\\s+/g, ' ').toLowerCase())
      .filter(Boolean);
  }

  document.fonts.check = function(font, text) {
    if (extractFontFamilies(font).some(family => allowedFonts.has(family))) {
      return origCheck(font, text);
    }
    return false;
  };
})();
`;
  }

  /**
   * 插件指纹覆盖
   */
  _buildPluginOverrides() {
    return `
(function() {
  const pluginPrototype = typeof Plugin !== 'undefined' ? Plugin.prototype : Object.prototype;
  const mimeTypePrototype = typeof MimeType !== 'undefined' ? MimeType.prototype : Object.prototype;
  const pluginArrayPrototype = typeof PluginArray !== 'undefined' ? PluginArray.prototype : Object.prototype;
  const mimeTypeArrayPrototype = typeof MimeTypeArray !== 'undefined' ? MimeTypeArray.prototype : Object.prototype;

  function defineValue(target, key, value, enumerable = true) {
    Object.defineProperty(target, key, { value, enumerable, configurable: false, writable: false });
  }

  function createPlugin(name, filename, description) {
    const plugin = Object.create(pluginPrototype);
    defineValue(plugin, 'name', name);
    defineValue(plugin, 'filename', filename);
    defineValue(plugin, 'description', description);
    defineValue(plugin, Symbol.toStringTag, 'Plugin', false);
    return plugin;
  }

  function createMimeType(type, suffixes, description) {
    const mime = Object.create(mimeTypePrototype);
    defineValue(mime, 'type', type);
    defineValue(mime, 'suffixes', suffixes);
    defineValue(mime, 'description', description);
    defineValue(mime, Symbol.toStringTag, 'MimeType', false);
    return mime;
  }

  function finishPlugin(plugin, mimeTypes) {
    mimeTypes.forEach((mime, index) => {
      defineValue(plugin, index, mime);
      defineValue(plugin, mime.type, mime, false);
      defineValue(mime, 'enabledPlugin', plugin);
    });
    defineValue(plugin, 'length', mimeTypes.length, false);
    defineValue(plugin, 'item', index => mimeTypes[Number(index)] || null, false);
    defineValue(plugin, 'namedItem', name => mimeTypes.find(mime => mime.type === String(name)) || null, false);
    defineValue(plugin, Symbol.iterator, () => mimeTypes[Symbol.iterator](), false);
    return plugin;
  }

  const pdfMime = createMimeType('application/pdf', 'pdf', 'Portable Document Format');
  const pdfPlugin = finishPlugin(
    createPlugin('Chrome PDF Plugin', 'internal-pdf-viewer', 'Portable Document Format'),
    [pdfMime]
  );
  const pdfViewer = finishPlugin(
    createPlugin('Chrome PDF Viewer', 'mhjfbmdgcfjbbpaeojofohoefgiehjai', ''),
    []
  );
  const nativeClient = finishPlugin(
    createPlugin('Native Client', 'internal-nacl-plugin', ''),
    []
  );
  const pluginValues = [pdfPlugin, pdfViewer, nativeClient];
  const mimeValues = [pdfMime];

  function createArrayLike(prototype, tag, values, nameKey, includeRefresh) {
    const result = Object.create(prototype);
    values.forEach((value, index) => {
      defineValue(result, index, value);
      defineValue(result, value[nameKey], value, false);
    });
    defineValue(result, 'length', values.length, false);
    defineValue(result, 'item', index => values[Number(index)] || null, false);
    defineValue(result, 'namedItem', name => values.find(value => value[nameKey] === String(name)) || null, false);
    defineValue(result, Symbol.iterator, () => values[Symbol.iterator](), false);
    if (includeRefresh) defineValue(result, 'refresh', () => undefined, false);
    defineValue(result, Symbol.toStringTag, tag, false);
    return result;
  }

  const plugins = createArrayLike(pluginArrayPrototype, 'PluginArray', pluginValues, 'name', true);
  const mimeTypes = createArrayLike(mimeTypeArrayPrototype, 'MimeTypeArray', mimeValues, 'type', false);

  Object.defineProperty(Navigator.prototype, 'plugins', {
    get: () => plugins,
    configurable: true,
  });
  Object.defineProperty(Navigator.prototype, 'mimeTypes', {
    get: () => mimeTypes,
    configurable: true,
  });
})();
`;
  }

  /**
   * ClientRects / BoundingClientRect 噪声
   */
  _buildClientRectsOverrides() {
    return `
(function() {
  const origGetClientRects = Element.prototype.getClientRects;
  const origGetBoundingClientRect = Element.prototype.getBoundingClientRect;

  function geometryNoise(rect) {
    let hash = __seed >>> 0;
    const key = [rect.x, rect.y, rect.width, rect.height]
      .map(value => Number.isFinite(value) ? Number(value).toFixed(6) : String(value))
      .join('|');
    for (let i = 0; i < key.length; i++) {
      hash = Math.imul(hash ^ key.charCodeAt(i), 16777619) >>> 0;
    }
    hash ^= hash >>> 16;
    hash = Math.imul(hash, 2246822507) >>> 0;
    hash ^= hash >>> 13;
    return ((hash >>> 0) / 4294967296 - 0.5) * 0.01;
  }

  function addRectNoise(rect) {
    const noise = geometryNoise(rect);
    return new DOMRect(
      rect.x + noise, rect.y + noise,
      rect.width + noise, rect.height + noise
    );
  }

  Element.prototype.getBoundingClientRect = function() {
    const rect = origGetBoundingClientRect.call(this);
    return addRectNoise(rect);
  };

  Element.prototype.getClientRects = function() {
    const rects = origGetClientRects.call(this);
    const result = [];
    for (let i = 0; i < rects.length; i++) {
      result.push(addRectNoise(rects[i]));
    }
    result.item = (index) => result[index];
    result.length = rects.length;
    return result;
  };
})();
`;
  }

  /**
   * Battery API 覆盖
   */
  _buildBatteryOverrides() {
    if (this.config.batteryAPI === 'disable') {
      return `navigator.getBattery = undefined;`;
    }
    // random
    return `
(function() {
  const level = 0.5 + __random() * 0.5;
  const charging = __random() > 0.3;
  navigator.getBattery = () => Promise.resolve({
    charging, level,
    chargingTime: charging ? Math.floor(__random() * 3600) : Infinity,
    dischargingTime: charging ? Infinity : Math.floor(3600 + __random() * 14400),
    addEventListener: () => {},
    removeEventListener: () => {},
  });
})();
`;
  }

  /**
   * MediaDevices 覆盖
   */
  _buildMediaDevicesOverrides() {
    if (this.config.mediaDevices === 'disable') {
      return `
if (navigator.mediaDevices) {
  navigator.mediaDevices.enumerateDevices = () => Promise.resolve([]);
}
`;
    }
    // random
    return `
(function() {
  if (!navigator.mediaDevices) return;
  const mediaDevicePrototype = typeof MediaDeviceInfo !== 'undefined' ? MediaDeviceInfo.prototype : Object.prototype;

  function token(label) {
    let hash = __seed >>> 0;
    for (let i = 0; i < label.length; i++) {
      hash = Math.imul(hash ^ label.charCodeAt(i), 16777619) >>> 0;
    }
    const first = hash.toString(16).padStart(8, '0');
    hash = Math.imul(hash ^ 0x9e3779b9, 2246822507) >>> 0;
    const second = hash.toString(16).padStart(8, '0');
    return first + second;
  }

  function createDevice(kind, deviceLabel, groupLabel) {
    const values = {
      deviceId: 'device-' + token(deviceLabel),
      kind,
      label: '',
      groupId: 'group-' + token(groupLabel),
    };
    const device = Object.create(mediaDevicePrototype);
    for (const [key, value] of Object.entries(values)) {
      Object.defineProperty(device, key, { value, enumerable: true, configurable: false });
    }
    Object.defineProperty(device, 'toJSON', {
      value: () => ({ ...values }),
      enumerable: false,
      configurable: false,
    });
    Object.defineProperty(device, Symbol.toStringTag, {
      value: 'MediaDeviceInfo',
      enumerable: false,
      configurable: false,
    });
    return device;
  }

  const devices = [
    createDevice('audioinput', 'audio-input', 'audio-group'),
    createDevice('audiooutput', 'audio-output', 'audio-group'),
    createDevice('videoinput', 'video-input', 'video-group'),
  ];
  navigator.mediaDevices.enumerateDevices = () => Promise.resolve(devices.slice());
})();
`;
  }
}
