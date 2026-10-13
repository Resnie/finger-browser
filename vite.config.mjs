import { defineConfig, loadEnv } from 'vite';
import electron from 'vite-plugin-electron/simple';
import vue from '@vitejs/plugin-vue';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveApiOrigin } from './scripts/api-origin.mjs';

const rootDir = dirname(fileURLToPath(import.meta.url));

// 路径工具函数（避免硬编码路径）
const pathResolve = dir => resolve(rootDir, dir);

const apiOriginPlaceholder = '__API_ORIGIN__';

const injectApiOrigin = apiOrigin => ({
  name: 'inject-api-origin-into-csp',
  transformIndexHtml(html) {
    if (!html.includes(apiOriginPlaceholder)) {
      throw new Error('index.html 缺少 API CSP 占位符');
    }
    return html.replaceAll(apiOriginPlaceholder, apiOrigin);
  },
});

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, rootDir, 'VITE_');
  const apiOrigin = resolveApiOrigin(env.VITE_APP_BASE_API, {
    production: mode === 'production',
  });

  return {
    // Electron 生产环境通过 file:// 加载页面，资源必须使用相对路径。
    base: './',
    resolve: {
      alias: {
        '@': pathResolve('src'),
      },
    },
    define: {
      __Admin_VERSION__: JSON.stringify(process.env.npm_package_version),
    },
    build: {
      // 设置输出目录，默认为 dist
      outDir: 'dist',
    },
    plugins: [
      injectApiOrigin(apiOrigin),
      vue(),
      electron({
        main: {
          // Shortcut of `build.lib.entry`.
          entry: pathResolve('electron/main/index.js'),
          vite: {
            build: {
              // 主进程输出目录（默认 dist-electron/main）
              outDir: pathResolve('dist-electron/main'),
              // 主进程需打包为 CommonJS 模块（Electron 主进程不支持 ESM）
              lib: {
                entry: pathResolve('electron/main/index.js'),
                formats: ['cjs'], // 必须为 cjs
                fileName: () => 'index.js', // 输出文件名
              },
            },
          },
        },
        preload: {
          // Shortcut of `build.rollupOptions.input`.
          // Preload scripts may contain Web assets, so use the `build.rollupOptions.input` instead `build.lib.entry`.
          entry: pathResolve('electron/preload/index.js'),
          vite: {
            build: {
              // 预加载脚本输出目录（默认 dist-electron/preload）
              outDir: pathResolve('dist-electron/preload'),
              // 预加载脚本同样需 CommonJS 模块
              lib: {
                entry: pathResolve('electron/preload/index.js'),
                formats: ['cjs'],
                fileName: () => 'index.js',
              },
            },
          },
        },
      }),
    ],
  };
});
