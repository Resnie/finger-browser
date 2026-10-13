const userAgentData = {
  devices: {
    desktop: {
      types: ['Desktop', 'Laptop', 'Workstation'],
      architectures: ['x86_64', 'x86', 'amd64', 'arm64'],
      screenSizes: ['1920x1080', '1366x768', '1440x900', '2560x1440', '1280x720', '3840x2160'],
    },
    mobile: {
      types: ['Mobile', 'Tablet', 'Phablet'],
      architectures: ['arm64', 'armv7', 'x86', 'x86_64'],
      screenSizes: ['375x667', '414x736', '360x640', '768x1024', '1024x768', '428x926', '390x844'],
      models: {
        ios: ['iPhone 13', 'iPhone 14', 'iPhone 15', 'iPad Pro', 'iPad Air', 'iPad mini'],
        android: [
          'Samsung Galaxy S23',
          'Samsung Galaxy S24',
          'Google Pixel 7',
          'Google Pixel 8',
          'OnePlus 11',
          'OnePlus 12',
          'Xiaomi 13',
          'Xiaomi 14',
        ],
      },
    },
  },
  browsers: {
    chrome: {
      name: 'Chrome',
      versions: [
        '112.0.0.0',
        '113.0.0.0',
        '114.0.0.0',
        '115.0.0.0',
        '116.0.0.0',
        '117.0.0.0',
        '118.0.0.0',
        '119.0.0.0',
      ],
      engines: ['AppleWebKit/537.36 (KHTML, like Gecko)'],
      renderers: ['Safari/537.36'],
    },
    firefox: {
      name: 'Firefox',
      versions: ['111.0', '112.0', '113.0', '114.0', '115.0', '116.0', '117.0', '118.0'],
      engines: ['Gecko/20100101'],
      renderers: [],
    },
    safari: {
      name: 'Safari',
      versions: ['16.4', '16.5', '16.6', '17.0', '17.1', '17.2', '17.3'],
      engines: ['AppleWebKit/605.1.15 (KHTML, like Gecko)'],
      renderers: [],
    },
    edge: {
      name: 'Edge',
      versions: ['112.0.0.0', '113.0.0.0', '114.0.0.0', '115.0.0.0', '116.0.0.0', '117.0.0.0'],
      engines: ['AppleWebKit/537.36 (KHTML, like Gecko)'],
      renderers: ['Chrome/114.0.0.0 Safari/537.36 Edg/114.0.0.0'],
    },
    samsung: {
      name: 'Samsung Internet',
      versions: ['20.0', '21.0', '22.0', '23.0', '24.0'],
      engines: ['AppleWebKit/537.36 (KHTML, like Gecko)'],
      renderers: ['Chrome/112.0.0.0 Mobile Safari/537.36'],
    },
  },
  operatingSystems: {
    windows: {
      versions: [
        { name: 'Windows NT 6.1', builds: ['7600', '7601'], fullName: 'Windows 7' }, // Windows 7
        { name: 'Windows NT 6.2', builds: ['9200'], fullName: 'Windows 8' }, // Windows 8
        { name: 'Windows NT 6.3', builds: ['9600'], fullName: 'Windows 8.1' }, // Windows 8.1
        {
          name: 'Windows NT 10.0',
          builds: [
            '10240',
            '10586',
            '14393',
            '15063',
            '16299',
            '17134',
            '17763',
            '18362',
            '18363',
            '19041',
            '19042',
            '19043',
            '19044',
            '19045',
          ],
          fullName: 'Windows 10',
        }, // Windows 10
        { name: 'Windows NT 11.0', builds: ['22000', '22621', '22631'], fullName: 'Windows 11' }, // Windows 11
      ],
      platforms: ['Win64; x64', 'WOW64', 'Win32; x86'],
    },
    macos: {
      versions: [
        { name: 'Mac OS X 10_15', builds: ['10_15_7'], fullName: 'macOS Catalina' },
        {
          name: 'Mac OS X 12',
          builds: ['12_0', '12_1', '12_2', '12_3', '12_4', '12_5', '12_6'],
          fullName: 'macOS Monterey',
        },
        {
          name: 'Mac OS X 13',
          builds: ['13_0', '13_1', '13_2', '13_3', '13_4'],
          fullName: 'macOS Ventura',
        },
        { name: 'Mac OS X 14', builds: ['14_0', '14_1', '14_2', '14_3'], fullName: 'macOS Sonoma' },
        { name: 'Mac OS X 15', builds: ['15_0'], fullName: 'macOS Sequoia' },
      ],
      platforms: [
        'Intel Mac OS X',
        'Macintosh; Intel Mac OS X',
        'Macintosh; Apple M1 Mac OS X',
        'Macintosh; Apple M2 Mac OS X',
        'Macintosh; Apple M3 Mac OS X',
      ],
    },
    linux: {
      versions: [
        {
          name: 'Linux',
          distros: ['Ubuntu', 'Fedora', 'Debian', 'CentOS'],
          builds: ['20.04', '22.04', '22.10', '23.04', '23.10'],
        },
      ],
      platforms: ['x86_64', 'i686', 'arm64'],
    },
    ios: {
      versions: [
        {
          name: 'iPhone OS',
          deviceTypes: ['iPhone'],
          builds: ['16.5', '16.6', '16.7', '17.0', '17.1', '17.2', '17.3'],
        },
        {
          name: 'iPadOS',
          deviceTypes: ['iPad'],
          builds: ['16.5', '16.6', '16.7', '17.0', '17.1', '17.2', '17.3'],
        },
      ],
      platforms: ['iPhone', 'iPad', 'iPod touch'],
    },
    android: {
      versions: [
        { name: 'Android', builds: ['12'], codeName: 'Snow Cone' },
        { name: 'Android', builds: ['13'], codeName: 'Tiramisu' },
        { name: 'Android', builds: ['14'], codeName: 'Upside Down Cake' },
        { name: 'Android', builds: ['15'], codeName: 'Vanilla Ice Cream' },
      ],
      platforms: ['Linux; Android'],
    },
  },
  languages: [
    'en-US',
    'en-GB',
    'zh-CN',
    'zh-TW',
    'ja-JP',
    'de-DE',
    'fr-FR',
    'es-ES',
    'ru-RU',
    'ko-KR',
    'it-IT',
    'pt-BR',
  ],
};

class UserAgentGenerator {
  constructor() {
    // 基础数据，按操作系统名称组织版本信息
    this.data = userAgentData;
  }

  // 随机选择数组中的一个元素
  getRandomItem(array) {
    return array[Math.floor(Math.random() * array.length)];
  }

  // 解析值：如果是数组则随机选择一个，否则直接返回
  resolveValue(value, allowedValues) {
    if (Array.isArray(value)) {
      // 验证数组中的每个值是否有效
      const invalidValues = value.filter(v => !allowedValues.includes(v));
      if (invalidValues.length > 0) {
        throw new Error(
          `无效的值: ${invalidValues.join(', ')}, 允许的值: ${allowedValues.join(', ')}`
        );
      }
      return this.getRandomItem(value);
    }
    return value !== null ? value : this.getRandomItem(allowedValues);
  }

  // 根据设备类型获取匹配的操作系统
  getMatchingOS(deviceType) {
    if (deviceType === 'desktop') {
      return ['windows', 'macos', 'linux'];
    } else {
      // mobile
      return ['ios', 'android'];
    }
  }

  // 获取操作系统的可用名称
  getOSNames(osType) {
    const os = this.data.operatingSystems[osType];
    if (!os) return [];

    return [...new Set(os.versions.map(v => v.name))];
  }

  // 获取特定操作系统类型下的所有可用名称（用于验证）
  getOSNamesForType(osType) {
    const os = this.data.operatingSystems[osType];
    if (!os) return [];

    return os.versions.map(v => v.name);
  }

  // 内核列表可以比内置样本更新，UA 只接受标准的数字版本段。
  normalizeBrowserVersion(value) {
    const version = String(value || '').trim();
    if (!/^\d{1,4}(?:\.\d{1,8}){0,3}$/.test(version)) {
      throw new Error(`无效的浏览器版本: ${version || '空'}`);
    }
    return version;
  }

  generateDesktopChromium(options = {}) {
    return this.generate({
      ...options,
      deviceType: 'desktop',
      browser: 'chrome',
      architecture: options.architecture || 'x86_64',
      language: options.language ?? null,
    });
  }

  // 生成User-Agent
  generate(options = {}) {
    // 默认参数 - 全部随机
    const defaults = {
      deviceType: null,
      deviceModel: null,
      browser: null,
      browserVersion: null,
      os: null,
      osName: null, // 支持多选的操作系统名称
      architecture: null,
      language: null,
      screenSize: null,
      includeDetails: false,
    };

    // 合并参数
    const config = { ...defaults, ...options };

    // 处理设备类型 - 支持多选
    const resolvedDeviceType = this.resolveValue(config.deviceType, Object.keys(this.data.devices));

    // 获取设备信息
    const device = this.data.devices[resolvedDeviceType];
    if (!device) {
      throw new Error(`无效的设备类型: ${resolvedDeviceType}`);
    }

    // 处理操作系统 - 支持多选
    const possibleOS = this.getMatchingOS(resolvedDeviceType);
    const resolvedOS = this.resolveValue(config.os, possibleOS);

    // 获取操作系统信息
    const os = this.data.operatingSystems[resolvedOS];
    if (!os) {
      throw new Error(`无效的操作系统: ${resolvedOS}`);
    }

    // 获取该操作系统类型下的所有可用名称
    const availableOSNames = this.getOSNamesForType(resolvedOS);

    // 处理操作系统名称 - 支持多选
    let resolvedOSName = this.resolveValue(config.osName, availableOSNames);

    // 根据选择的osName获取对应的版本信息
    const osVersionInfo = os.versions.find(v => v.name === resolvedOSName);
    if (!osVersionInfo) {
      throw new Error(`操作系统 ${resolvedOS} 不支持名称 ${resolvedOSName}`);
    }

    // 自动选择匹配的版本号/build号
    let resolvedOSVersion, resolvedOSFullName;

    switch (resolvedOS) {
      case 'windows':
      case 'macos':
        resolvedOSVersion = this.getRandomItem(osVersionInfo.builds);
        resolvedOSFullName = osVersionInfo.fullName;
        break;
      case 'ios':
        resolvedOSVersion = this.getRandomItem(osVersionInfo.builds);
        resolvedOSFullName = osVersionInfo.name;
        break;
      case 'android':
        resolvedOSVersion = this.getRandomItem(osVersionInfo.builds);
        resolvedOSFullName = `Android ${resolvedOSVersion} (${osVersionInfo.codeName})`;
        break;
      case 'linux':
        const distro = this.getRandomItem(osVersionInfo.distros);
        const build = this.getRandomItem(osVersionInfo.builds);
        resolvedOSVersion = `${distro} ${build}`;
        resolvedOSFullName = resolvedOSVersion;
        break;
    }

    // 处理浏览器 - 支持多选
    const resolvedBrowser = this.resolveValue(config.browser, Object.keys(this.data.browsers));

    // 获取浏览器信息
    const browser = this.data.browsers[resolvedBrowser];
    if (!browser) {
      throw new Error(`无效的浏览器: ${resolvedBrowser}`);
    }

    // 处理浏览器版本 - 支持多选
    const resolvedBrowserVersion = this.normalizeBrowserVersion(
      this.resolveValue(config.browserVersion, browser.versions)
    );

    // 处理架构 - 支持多选
    const resolvedArchitecture = this.resolveValue(config.architecture, device.architectures);

    // 处理屏幕尺寸 - 支持多选
    const resolvedScreenSize = this.resolveValue(config.screenSize, device.screenSizes);

    // 处理语言 - 支持多选
    const resolvedLanguage = this.resolveValue(config.language, this.data.languages);

    // 处理设备型号 - 支持多选
    let resolvedDeviceModel = null;
    if (resolvedDeviceType === 'mobile') {
      const possibleModels = this.data.devices.mobile.models[resolvedOS];
      resolvedDeviceModel = this.resolveValue(config.deviceModel, possibleModels);

      // 对于iOS，确保设备型号与OS名称匹配
      if (resolvedOS === 'ios') {
        if (resolvedDeviceModel.includes('iPad') && resolvedOSName !== 'iPadOS') {
          // 如果选择了iPad型号但OS名称不是iPadOS，自动调整
          const ipadOSVersion = os.versions.find(v => v.name === 'iPadOS');
          resolvedOSName = 'iPadOS';
          resolvedOSVersion = this.getRandomItem(ipadOSVersion.builds);
        } else if (resolvedDeviceModel.includes('iPhone') && resolvedOSName !== 'iPhone OS') {
          // 如果选择了iPhone型号但OS名称不是iPhone OS，自动调整
          const iphoneOSVersion = os.versions.find(v => v.name === 'iPhone OS');
          resolvedOSName = 'iPhone OS';
          resolvedOSVersion = this.getRandomItem(iphoneOSVersion.builds);
        }
      }
    }

    // 构建User-Agent各个部分
    let uaParts = ['Mozilla/5.0'];

    // 添加操作系统和设备信息
    let osPart = '';
    switch (resolvedOS) {
      case 'ios':
        osPart = `(${resolvedDeviceModel}; CPU ${resolvedOSName} ${resolvedOSVersion.replace('.', '_')} like Mac OS X)`;
        break;
      case 'android':
        osPart = `(${os.platforms[0]} ${resolvedOSVersion}; ${resolvedArchitecture}; ${resolvedDeviceModel})`;
        break;
      case 'windows':
        osPart = `(${resolvedOSName === 'Windows NT 11.0' ? 'Windows NT 10.0' : resolvedOSName}; ${
          resolvedArchitecture === 'arm64'
            ? 'Win64; ARM64'
            : resolvedArchitecture === 'x86'
              ? 'WOW64'
              : 'Win64; x64'
        })`;
        break;
      case 'macos':
        // Chromium 在 macOS 上始终使用这一标准平台片段，Apple Silicon 也不写 M1/M2/M3。
        osPart = `(Macintosh; Intel Mac OS X ${resolvedOSVersion.replaceAll('.', '_')})`;
        break;
      case 'linux':
        osPart = `(X11; Linux ${
          resolvedArchitecture === 'arm64'
            ? 'aarch64'
            : resolvedArchitecture === 'x86'
              ? 'i686'
              : 'x86_64'
        })`;
        break;
    }
    uaParts.push(osPart);

    // 添加浏览器引擎信息
    uaParts.push(this.getRandomItem(browser.engines));

    // 添加浏览器版本信息
    if (resolvedBrowser === 'firefox') {
      uaParts.push(`${browser.name}/${resolvedBrowserVersion}`);
    } else if (resolvedBrowser === 'safari' && resolvedDeviceType === 'mobile') {
      uaParts.push(
        `Version/${resolvedBrowserVersion} Mobile/15E148 ${browser.name}/${resolvedBrowserVersion}`
      );
    } else if (resolvedBrowser === 'safari') {
      uaParts.push(`Version/${resolvedBrowserVersion} ${browser.name}/605.1.15`);
    } else if (resolvedBrowser === 'samsung') {
      uaParts.push(`SamsungBrowser/${resolvedBrowserVersion}`);
      uaParts.push(this.getRandomItem(browser.renderers));
    } else if (resolvedBrowser === 'edge') {
      uaParts.push(`Chrome/${resolvedBrowserVersion} Safari/537.36 Edg/${resolvedBrowserVersion}`);
    } else {
      uaParts.push(`${browser.name}/${resolvedBrowserVersion}`);
      if (browser.renderers.length > 0) {
        uaParts.push(this.getRandomItem(browser.renderers));
      }
    }

    // 组合成完整的User-Agent
    const userAgent = uaParts.join(' ');

    // 如果需要详细信息，返回包含配置和User-Agent的对象
    if (config.includeDetails) {
      return {
        userAgent,
        details: {
          deviceType: resolvedDeviceType,
          device: {
            type: this.getRandomItem(device.types),
            model: resolvedDeviceModel,
            architecture: resolvedArchitecture,
            screenSize: resolvedScreenSize,
          },
          browser: {
            name: browser.name,
            version: resolvedBrowserVersion,
          },
          os: {
            type: resolvedOS,
            name: resolvedOSName,
            fullName: resolvedOSFullName,
            version: resolvedOSVersion,
          },
          language: resolvedLanguage,
        },
      };
    }

    return userAgent;
  }

  // 辅助方法：获取所有可用选项
  getAvailableOptions() {
    return {
      deviceTypes: Object.keys(this.data.devices),
      browsers: Object.keys(this.data.browsers).reduce((acc, key) => {
        acc[key] = {
          versions: this.data.browsers[key].versions,
        };
        return acc;
      }, {}),
      operatingSystems: Object.keys(this.data.operatingSystems).reduce((acc, key) => {
        acc[key] = {
          names: this.getOSNames(key),
        };
        return acc;
      }, {}),
      architectures: {
        desktop: this.data.devices.desktop.architectures,
        mobile: this.data.devices.mobile.architectures,
      },
      screenSizes: {
        desktop: this.data.devices.desktop.screenSizes,
        mobile: this.data.devices.mobile.screenSizes,
      },
      mobileModels: this.data.devices.mobile.models,
      languages: this.data.languages,
    };
  }
}

export { UserAgentGenerator, userAgentData, FingerprintValueGenerator };

/**
 * 基于种子的确定性指纹值生成器
 */
class FingerprintValueGenerator {
  constructor(instanceId) {
    this.seed = this._hashToSeed(instanceId || 'default');
  }

  _hashToSeed(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash |= 0;
    }
    return Math.abs(hash);
  }

  _rng() {
    this.seed |= 0;
    this.seed = this.seed + 0x6D2B79F5 | 0;
    let t = Math.imul(this.seed ^ this.seed >>> 15, 1 | this.seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  }

  _pick(arr) {
    return arr[Math.floor(this._rng() * arr.length)];
  }

  static WEBGL_COMBOS = [
    { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1080 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
    { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
    { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
    { vendor: 'Google Inc. (AMD)', renderer: 'ANGLE (AMD, AMD Radeon RX 6700 XT Direct3D11 vs_5_0 ps_5_0, D3D11)' },
    { vendor: 'Google Inc. (AMD)', renderer: 'ANGLE (AMD, AMD Radeon RX 580 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
    { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)' },
    { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)' },
    { vendor: 'Google Inc. (Apple)', renderer: 'ANGLE (Apple, Apple M1, OpenGL 4.1)' },
    { vendor: 'Google Inc. (Apple)', renderer: 'ANGLE (Apple, Apple M2, OpenGL 4.1)' },
  ];

  generateWebGLCombo() {
    return this._pick(FingerprintValueGenerator.WEBGL_COMBOS);
  }

  generateHardwareConcurrency() {
    return this._pick([2, 4, 6, 8, 12, 16]);
  }

  generateDeviceMemory() {
    return this._pick([2, 4, 8, 16]);
  }

  generateScreenResolution() {
    return this._pick(['1920x1080', '2560x1440', '1366x768', '1440x900', '1536x864']);
  }
}
