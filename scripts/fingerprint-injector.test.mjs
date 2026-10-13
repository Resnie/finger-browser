import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';

const projectRoot = path.resolve(import.meta.dirname, '..');
const fingerprintIdentityUrl = pathToFileURL(
  path.join(projectRoot, 'shared/fingerprintIdentity.mjs')
).href;
const fingerprintIdentity = await import(fingerprintIdentityUrl);

const loadSourceModule = async (filePath, replacements = []) => {
  let source = fs.readFileSync(filePath, 'utf8');
  for (const [from, to] of replacements) source = source.replace(from, to);
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
};

const { FingerprintInjector, resolveNavigatorPlatform } = await loadSourceModule(
  path.join(projectRoot, 'electron/main/models/FingerprintInjector.js'),
  [
    ["from './fingerprintCanvasText.mjs';", `from '${pathToFileURL(path.join(projectRoot, 'electron/main/models/fingerprintCanvasText.mjs')).href}';`],
    ["import crypto from 'crypto';", "import crypto from 'node:crypto';"],
    ["from '../../../shared/fingerprintIdentity.mjs';", `from '${fingerprintIdentityUrl}';`],
  ]
);

const fingerprintConstants = await loadSourceModule(
  path.join(projectRoot, 'src/constants/fingerprint.js'),
  [["from '../utils/fingerprintIdentity.mjs';", `from '${fingerprintIdentityUrl}';`]]
);
const { UserAgentGenerator } = await loadSourceModule(
  path.join(projectRoot, 'src/utils/fingerGenerator.js')
);

const createFakeRuntime = instanceId => {
  class Navigator {}
  class Plugin {}
  class MimeType {}
  class PluginArray {}
  class MimeTypeArray {}
  class MediaDeviceInfo {}

  Object.defineProperty(Navigator.prototype, 'webdriver', {
    get: () => true,
    configurable: true,
  });

  class CanvasRenderingContext2D {
    constructor(canvas) {
      this.canvas = canvas;
    }

    getImageData() {
      return { data: Uint8ClampedArray.from(this.canvas.pixels) };
    }

    putImageData(imageData) {
      this.canvas.pixels = Uint8ClampedArray.from(imageData.data);
    }

    drawImage(source) {
      this.canvas.pixels = Uint8ClampedArray.from(source.pixels);
    }
  }

  class HTMLCanvasElement {
    constructor() {
      this._width = 1;
      this._height = 1;
      this.pixels = new Uint8ClampedArray(4);
      this.context = new CanvasRenderingContext2D(this);
    }

    get width() {
      return this._width;
    }

    set width(value) {
      this._width = Number(value);
      this.resetPixels();
    }

    get height() {
      return this._height;
    }

    set height(value) {
      this._height = Number(value);
      this.resetPixels();
    }

    resetPixels() {
      this.pixels = new Uint8ClampedArray(Math.max(0, this._width * this._height * 4));
    }

    getContext(type) {
      return type === '2d' ? this.context : null;
    }

    toDataURL() {
      return Array.from(this.pixels).join(',');
    }

    toBlob(callback) {
      callback(Array.from(this.pixels).join(','));
    }
  }

  class DOMRect {
    constructor(x, y, width, height) {
      this.x = x;
      this.y = y;
      this.width = width;
      this.height = height;
      this.top = y;
      this.right = x + width;
      this.bottom = y + height;
      this.left = x;
    }
  }

  class Element {
    getBoundingClientRect() {
      return new DOMRect(20, 30, 120, 40);
    }

    getClientRects() {
      const values = [this.getBoundingClientRect()];
      values.item = index => values[index] || null;
      return values;
    }
  }

  const navigator = new Navigator();
  navigator.mediaDevices = {
    enumerateDevices: async () => [],
  };
  const screen = {};
  const document = {
    createElement: name => {
      assert.equal(name, 'canvas');
      return new HTMLCanvasElement();
    },
    fonts: {
      check: () => true,
    },
  };

  const sandbox = {
    CanvasRenderingContext2D,
    DOMRect,
    Element,
    HTMLCanvasElement,
    MediaDeviceInfo,
    MimeType,
    MimeTypeArray,
    Navigator,
    Plugin,
    PluginArray,
    Uint8ClampedArray,
    document,
    navigator,
    screen,
  };

  const config = {
    canvas: true,
    webgl: false,
    audioFingerprint: false,
    language: 'ja-JP',
    // 模拟旧配置：language 改过，languages 仍是旧默认值。
    languages: ['zh-CN', 'zh', 'en-US', 'en'],
    platform: 'Win32',
    screenResolution: 'auto',
    hardwareConcurrency: 4,
    deviceMemory: 8,
    webRTC: 'default',
    doNotTrack: true,
    fonts: 'limited',
    plugins: 'limited',
    clientRects: true,
    batteryAPI: 'real',
    mediaDevices: 'random',
  };
  const script = new FingerprintInjector(instanceId, config).getInjectionScript();
  vm.runInNewContext(script, sandbox);

  return {
    classes: { MediaDeviceInfo, MimeType, MimeTypeArray, Plugin, PluginArray },
    config,
    document,
    Element,
    HTMLCanvasElement,
    navigator,
    script,
  };
};

const createSourceCanvas = RuntimeCanvas => {
  const canvas = new RuntimeCanvas();
  canvas.width = 12;
  canvas.height = 1;
  canvas.pixels = Uint8ClampedArray.from(
    Array.from({ length: 12 }, (_, index) => [20 + index, 40 + index, 60 + index, 255]).flat()
  );
  return canvas;
};

const serializeRect = rect => [rect.x, rect.y, rect.width, rect.height].join(',');

const readInjectedWebGLIdentity = ({ platform, userAgent, vendor = '', renderer = '' }) => {
  const debugInfo = {
    UNMASKED_VENDOR_WEBGL: 0x9245,
    UNMASKED_RENDERER_WEBGL: 0x9246,
  };
  class WebGLRenderingContext {
    getExtension(name) {
      return name === 'WEBGL_debug_renderer_info' ? debugInfo : null;
    }

    getParameter(param) {
      return `native-${param}`;
    }
  }

  const injector = new FingerprintInjector(
    'test-webgl-platform',
    {
      platform,
      webglVendor: vendor,
      webglRenderer: renderer,
    },
    userAgent
  );
  vm.runInNewContext(injector._buildWebGLOverrides(), { WebGLRenderingContext });
  const context = new WebGLRenderingContext();
  return {
    platform: injector.config.platform,
    vendor: context.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL),
    renderer: context.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL),
  };
};

test('webdriver 在 Navigator.prototype 上隐藏，且旧 languages 以 language 为首项', () => {
  const runtime = createFakeRuntime('test-fingerprint-unit-alpha');
  assert.equal(runtime.navigator.webdriver, undefined);
  assert.equal(Object.hasOwn(runtime.navigator, 'webdriver'), false);
  assert.equal(runtime.navigator.language, 'ja-JP');
  assert.deepEqual(Array.from(runtime.navigator.languages), [
    'ja-JP',
    'zh-CN',
    'zh',
    'en-US',
    'en',
  ]);
  assert.equal(runtime.navigator.platform, 'Win32');
  assert.equal(runtime.navigator.hardwareConcurrency, 4);
  assert.equal(runtime.navigator.deviceMemory, 8);
  assert.equal(runtime.navigator.doNotTrack, '1');
});

test('运行时以明确 UA 修正 platform，且不修改原配置', () => {
  const cases = [
    {
      name: 'Windows UA',
      configuredPlatform: '',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/144.0.0.0',
      expected: 'Win32',
    },
    {
      name: 'macOS UA',
      configuredPlatform: '',
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) Chrome/144.0.0.0',
      expected: 'MacIntel',
    },
    {
      name: '明确 UA 修正矛盾的显式配置',
      configuredPlatform: 'MacIntel',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/144.0.0.0',
      expected: 'Win32',
    },
    {
      name: 'Linux UA',
      configuredPlatform: '',
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/144.0.0.0',
      expected: 'Linux x86_64',
    },
    {
      name: '未知 UA 不猜测',
      configuredPlatform: '',
      userAgent: 'test-unknown-agent',
      expected: '',
    },
    {
      name: '手机 UA 中的 like Mac OS X 不视为 macOS',
      configuredPlatform: '',
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
      expected: '',
    },
    {
      name: '矛盾 UA 不猜测',
      configuredPlatform: '',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Macintosh; Intel Mac OS X 14_6)',
      expected: '',
    },
  ];

  for (const item of cases) {
    assert.equal(
      resolveNavigatorPlatform(item.configuredPlatform, item.userAgent),
      item.expected,
      item.name
    );
  }

  const legacyConfig = { language: 'en-US', platform: '' };
  const injector = new FingerprintInjector(
    'test-legacy-platform',
    legacyConfig,
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/144.0.0.0'
  );
  assert.equal(injector.config.platform, 'Win32');
  assert.equal(legacyConfig.platform, '');
  assert.notEqual(injector.config, legacyConfig);
});

test('WebGL 空值按 Windows、macOS 与 Linux 平台注入自洽默认值', () => {
  const windows = readInjectedWebGLIdentity({
    platform: 'Win32',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/144.0.7500',
  });
  const mac = readInjectedWebGLIdentity({
    // 模拟历史上 platform 与 UA 冲突的数据。
    platform: 'Win32',
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) Chrome/144.0.7500',
  });
  const linux = readInjectedWebGLIdentity({
    platform: '',
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/144.0.7500',
  });

  assert.equal(windows.platform, 'Win32');
  assert.match(windows.renderer, /Direct3D11/);
  assert.equal(mac.platform, 'MacIntel');
  assert.match(mac.vendor, /Apple/);
  assert.match(mac.renderer, /Apple/);
  assert.doesNotMatch(mac.renderer, /Direct3D/);
  assert.equal(linux.platform, 'Linux x86_64');
  assert.match(linux.renderer, /Mesa/);
  assert.doesNotMatch(linux.renderer, /Direct3D/);
});

test('WebGL 明确自定义值不被平台默认值覆盖', () => {
  const identity = readInjectedWebGLIdentity({
    platform: 'MacIntel',
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) Chrome/144.0.7500',
    vendor: 'test-custom-vendor',
    renderer: 'test-custom-renderer',
  });

  assert.equal(identity.vendor, 'test-custom-vendor');
  assert.equal(identity.renderer, 'test-custom-renderer');
});

test('Canvas 序列化不修改原画布，同实例稳定且跨实例有差异', () => {
  const alpha = createFakeRuntime('test-fingerprint-unit-alpha');
  const beta = createFakeRuntime('test-fingerprint-unit-beta');
  const alphaCanvas = createSourceCanvas(alpha.HTMLCanvasElement);
  const betaCanvas = createSourceCanvas(beta.HTMLCanvasElement);
  const originalPixels = Array.from(alphaCanvas.pixels);

  const alphaFirst = alphaCanvas.toDataURL();
  const alphaSecond = alphaCanvas.toDataURL();
  const betaFirst = betaCanvas.toDataURL();

  assert.equal(alphaFirst, alphaSecond);
  assert.deepEqual(Array.from(alphaCanvas.pixels), originalPixels);
  assert.notEqual(alphaFirst, betaFirst);
});

test('ClientRects 基于原始几何值产生稳定且跨实例不同的噪声', () => {
  const alpha = createFakeRuntime('test-fingerprint-unit-alpha');
  const beta = createFakeRuntime('test-fingerprint-unit-beta');
  const alphaElement = new alpha.Element();
  const betaElement = new beta.Element();

  const alphaFirst = serializeRect(alphaElement.getBoundingClientRect());
  const alphaSecond = serializeRect(alphaElement.getBoundingClientRect());
  const betaFirst = serializeRect(betaElement.getBoundingClientRect());

  assert.equal(alphaFirst, alphaSecond);
  assert.notEqual(alphaFirst, betaFirst);
});

test('限制字体正确识别多词字体名', () => {
  const runtime = createFakeRuntime('test-fingerprint-unit-alpha');
  assert.equal(runtime.document.fonts.check('12px "Times New Roman"'), true);
  assert.equal(runtime.document.fonts.check('italic 700 12px/1.2 "Comic Sans MS"'), true);
  assert.equal(runtime.document.fonts.check('12px "test-missing-font"'), false);
});

test('plugins 与 mimeTypes 提供类原生接口并保持双向关联', () => {
  const runtime = createFakeRuntime('test-fingerprint-unit-alpha');
  const { plugins, mimeTypes } = runtime.navigator;

  assert.equal(Object.prototype.toString.call(plugins), '[object PluginArray]');
  assert.equal(Object.prototype.toString.call(mimeTypes), '[object MimeTypeArray]');
  assert.equal(plugins instanceof runtime.classes.PluginArray, true);
  assert.equal(mimeTypes instanceof runtime.classes.MimeTypeArray, true);
  assert.equal(plugins.item(0), plugins[0]);
  assert.equal(plugins.namedItem('Chrome PDF Plugin'), plugins[0]);
  assert.equal(Array.from(plugins).length, 3);
  assert.equal(typeof plugins.refresh, 'function');
  assert.equal(mimeTypes.item(0), mimeTypes[0]);
  assert.equal(mimeTypes.namedItem('application/pdf'), mimeTypes[0]);
  assert.equal(plugins[0].item(0), mimeTypes[0]);
  assert.equal(plugins[0].namedItem('application/pdf'), mimeTypes[0]);
  assert.equal(mimeTypes[0].enabledPlugin, plugins[0]);
});

test('mediaDevices random 在同实例稳定、跨实例不同且可 toJSON', async () => {
  const alpha = createFakeRuntime('test-fingerprint-unit-alpha');
  const beta = createFakeRuntime('test-fingerprint-unit-beta');
  const alphaFirst = await alpha.navigator.mediaDevices.enumerateDevices();
  const alphaSecond = await alpha.navigator.mediaDevices.enumerateDevices();
  const betaFirst = await beta.navigator.mediaDevices.enumerateDevices();

  assert.deepEqual(
    alphaFirst.map(device => device.toJSON()),
    alphaSecond.map(device => device.toJSON())
  );
  assert.notDeepEqual(
    alphaFirst.map(device => device.toJSON()),
    betaFirst.map(device => device.toJSON())
  );
  assert.equal(Object.prototype.toString.call(alphaFirst[0]), '[object MediaDeviceInfo]');
  assert.equal(alphaFirst[0] instanceof alpha.classes.MediaDeviceInfo, true);
  assert.equal(alphaFirst[0].groupId, alphaFirst[1].groupId);
  assert.notEqual(alphaFirst[0].groupId, alphaFirst[2].groupId);
});

test('语言、操作系统与旧 UA 辅助函数生成自洽配置', () => {
  assert.deepEqual(fingerprintConstants.getLanguagesForLocale('ja-JP'), [
    'ja-JP',
    'ja',
    'en-US',
    'en',
  ]);
  assert.deepEqual(fingerprintConstants.getLanguagesForLocale('en-US'), ['en-US', 'en']);
  assert.equal(fingerprintConstants.getPlatformForOperatingSystems(['Windows NT 10.0']), 'Win32');
  assert.equal(fingerprintConstants.getPlatformForOperatingSystems(['Mac OS X 14']), 'MacIntel');
  assert.equal(
    fingerprintConstants.getPlatformForOperatingSystems(['Windows NT 10.0', 'Mac OS X 14']),
    ''
  );
  assert.equal(
    fingerprintConstants.inferPlatformFromUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    ),
    'Win32'
  );
  assert.equal(fingerprintConstants.inferPlatformFromUserAgent('unknown-agent'), '');
  assert.equal(
    fingerprintConstants.resolveFingerprintPlatform({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_3) AppleWebKit/537.36',
      operatingSystems: ['Windows NT 10.0', 'Mac OS X 14'],
      fallback: 'Win32',
    }),
    'MacIntel'
  );
});

test('混合多选会先抽取单一实际系统，生成的 UA 与 platform 一致', () => {
  const selectedOS = fingerprintConstants.selectOperatingSystemForUserAgent(
    ['Windows NT 10.0', 'Mac OS X 14'],
    () => 0.75
  );
  assert.deepEqual(selectedOS, {
    name: 'Mac OS X 14',
    osType: 'macos',
    platform: 'MacIntel',
  });

  const generator = new UserAgentGenerator();
  let userAgent = '';
  assert.doesNotThrow(() => {
    userAgent = generator.generate({
      os: [selectedOS.osType],
      deviceType: ['desktop'],
      osName: [selectedOS.name],
    });
  });
  assert.equal(fingerprintConstants.inferPlatformFromUserAgent(userAgent), selectedOS.platform);
});

test('macOS Chromium UA 与内核版本一致且不泄露语言或硬件型号', () => {
  const generator = new UserAgentGenerator();
  const userAgent = generator.generateDesktopChromium({
    os: 'macos',
    osName: 'Mac OS X 14',
    architecture: 'arm64',
    browserVersion: '144.0.7500',
    language: 'es-ES',
  });

  assert.match(
    userAgent,
    /^Mozilla\/5\.0 \(Macintosh; Intel Mac OS X 14_\d(?:_\d+)?\) AppleWebKit\/537\.36 \(KHTML, like Gecko\) Chrome\/144\.0\.7500 Safari\/537\.36$/
  );
  assert.equal((userAgent.match(/Mac OS X/g) || []).length, 1);
  assert.equal(fingerprintConstants.inferPlatformFromUserAgent(userAgent), 'MacIntel');
  assert.doesNotMatch(userAgent, /Apple M[123]|Language\/|Firefox\/|Version\/|Safari\/17(?:\.0)?/);
});

test('Windows Chromium UA 使用标准平台片段并保留完整内核版本', () => {
  const generator = new UserAgentGenerator();
  const result = generator.generateDesktopChromium({
    os: 'windows',
    osName: 'Windows NT 10.0',
    architecture: 'x86_64',
    browserVersion: '144.0.7500',
    language: 'zh-CN',
    includeDetails: true,
  });

  assert.equal(
    result.userAgent,
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.7500 Safari/537.36'
  );
  assert.equal(result.details.browser.name, 'Chrome');
  assert.equal(result.details.browser.version, '144.0.7500');
  assert.equal(result.details.language, 'zh-CN');
  assert.equal(fingerprintConstants.inferPlatformFromUserAgent(result.userAgent), 'Win32');
  assert.doesNotMatch(result.userAgent, /Language\/|Firefox\/|Version\//);
});

test('Linux Chromium UA 使用标准 X11 平台片段', () => {
  const generator = new UserAgentGenerator();
  const userAgent = generator.generateDesktopChromium({
    os: 'linux',
    osName: 'Linux',
    architecture: 'x86_64',
    browserVersion: '144.0.7500',
  });

  assert.equal(
    userAgent,
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.7500 Safari/537.36'
  );
  assert.equal(fingerprintIdentity.inferPlatformFromUserAgent(userAgent), 'Linux x86_64');
});

test('指纹身份纯函数同步生成内核版本、UA 与 platform', () => {
  const generator = new UserAgentGenerator();
  const identity = fingerprintIdentity.createChromiumFingerprintIdentity({
    browserVersion: '145.0.7600',
    operatingSystems: ['Windows NT 10.0', 'Mac OS X 15'],
    language: 'zh-CN',
    random: () => 0.99,
    generateUserAgent: options => generator.generateDesktopChromium(options),
  });

  assert.equal(identity.operatingSystem, 'Mac OS X 15');
  assert.equal(identity.platform, 'MacIntel');
  assert.match(identity.userAgent, /Macintosh; Intel Mac OS X 15_/);
  assert.match(identity.userAgent, /Chrome\/145\.0\.7600\b/);
  assert.deepEqual(
    fingerprintIdentity.validateFingerprintIdentity({
      browserVersion: '145.0.7600',
      operatingSystems: ['Windows NT 10.0', 'Mac OS X 15'],
      userAgent: identity.userAgent,
      platform: identity.platform,
    }),
    { valid: true, code: '', platform: 'MacIntel' }
  );
});

test('指纹身份校验拒绝跨内核、跨系统和矛盾 platform', () => {
  const macUserAgent =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.7500 Safari/537.36';

  assert.equal(
    fingerprintIdentity.validateFingerprintIdentity({
      browserVersion: '145.0.7600',
      operatingSystems: ['Mac OS X 14'],
      userAgent: macUserAgent,
      platform: 'MacIntel',
    }).code,
    'browser-version-mismatch'
  );
  assert.equal(
    fingerprintIdentity.validateFingerprintIdentity({
      browserVersion: '144.0.7500',
      operatingSystems: ['Windows NT 10.0'],
      userAgent: macUserAgent,
      platform: 'MacIntel',
    }).code,
    'operating-system-mismatch'
  );
  assert.equal(
    fingerprintIdentity.validateFingerprintIdentity({
      browserVersion: '144.0.7500',
      operatingSystems: ['Mac OS X 14'],
      userAgent: macUserAgent,
      platform: 'Win32',
    }).code,
    'navigator-platform-mismatch'
  );
  assert.equal(fingerprintIdentity.areChromiumVersionsCompatible('144.0.7500', macUserAgent), true);
});

test('动态 Chromium 版本支持服务端新内核但拒绝非法 UA 版本片段', () => {
  const generator = new UserAgentGenerator();
  assert.match(
    generator.generateDesktopChromium({
      os: 'windows',
      osName: 'Windows NT 10.0',
      browserVersion: '144.0.7500',
    }),
    /Chrome\/144\.0\.7500 Safari\/537\.36$/
  );
  assert.throws(
    () =>
      generator.generateDesktopChromium({
        os: 'windows',
        osName: 'Windows NT 10.0',
        browserVersion: '144.0.7500 Language/es-ES',
      }),
    /无效的浏览器版本/
  );
});

test('public_only 保留旧值但在 UI 明确禁选', () => {
  const option = fingerprintConstants.WEBRTC_OPTIONS.find(item => item.value === 'public_only');
  assert.equal(option.disabled, true);
  assert.match(option.label, /暂未支持/);
});


test('自动硬件、屏幕和时区默认值由环境固定，手动选项保持有效', () => {
 const first = new FingerprintInjector('test-portable-identity', {autoFingerprint:true,language:'zh-CN',hardwareConcurrency:0,deviceMemory:0,screenResolution:'auto',timezone:'auto'});
 const second = new FingerprintInjector('test-portable-identity', {autoFingerprint:true,language:'zh-CN'});
 assert.deepEqual(first.config, {...second.config, hardwareConcurrency:first.config.hardwareConcurrency,deviceMemory:first.config.deviceMemory,screenResolution:first.config.screenResolution,timezone:first.config.timezone});
 assert.ok(first.config.hardwareConcurrency>0);assert.ok(first.config.deviceMemory>0);assert.match(first.config.screenResolution,/^\d+x\d+$/);assert.equal(first.config.timezone,'Asia/Shanghai');assert.equal(first.config.colorDepth,24);
 const manual=new FingerprintInjector('test-portable-identity',{autoFingerprint:true,hardwareConcurrency:6,deviceMemory:16,screenResolution:'1280x720',timezone:'Europe/Berlin',colorDepth:30});
 assert.equal(manual.config.hardwareConcurrency,6);assert.equal(manual.config.deviceMemory,16);assert.equal(manual.config.screenResolution,'1280x720');assert.equal(manual.config.timezone,'Europe/Berlin');assert.equal(manual.config.colorDepth,30);
});

test('离线音频浮点归一化覆盖所有通道，并且 complete 与 Promise 读取不会重复加噪', async () => {
 const render = async delta => {
  const data=[new Float32Array([0.1000001+delta,-0.2000001+delta]),new Float32Array([0.3000001+delta,-0.4000001+delta])];
  const buffer={numberOfChannels:2,getChannelData:channel=>data[channel]};let observed;
  class Offline {addEventListener(_name,callback){this.complete=callback;}startRendering(){this.complete({renderedBuffer:buffer});observed=data.map(x=>[...x]);return Promise.resolve(buffer);}}
  class Analyser {getFloatFrequencyData(){}}
  const runtime=vm.createContext({OfflineAudioContext:Offline,AnalyserNode:Analyser,WeakSet});
  const injector=new FingerprintInjector('test-audio-portable',{autoFingerprint:true});
  vm.runInContext(injector._buildSeedRng()+injector._buildAudioOverrides(),runtime);
  const result=await new Offline().startRendering();assert.deepEqual(data.map(x=>[...x]),observed);assert.equal(result,buffer);return observed;
 };
 assert.deepEqual(await render(0),await render(0.0000002));
});
