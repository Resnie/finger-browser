import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const isFile = target => {
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
};
const realpath = target => {
  try {
    return fs.realpathSync(target);
  } catch {
    return null;
  }
};

/** Resolve npm's JavaScript entry point; never execute npm.cmd or a shell. */
export const resolveNpmCli = ({
  env = process.env,
  execPath = process.execPath,
  platform = process.platform,
  fileExists = isFile,
  resolveRealpath = realpath,
} = {}) => {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const candidates = [];
  const add = target => {
    if (typeof target === 'string' && target && paths.basename(target) === 'npm-cli.js') {
      candidates.push(paths.resolve(target));
    }
  };
  const addInstallation = directory => {
    add(paths.join(directory, 'node_modules', 'npm', 'bin', 'npm-cli.js'));
    add(paths.join(directory, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  };

  // npm run sets this to its own official CLI, including version-manager installs.
  add(env.npm_execpath);
  addInstallation(paths.dirname(execPath));
  const actualNode = resolveRealpath(execPath);
  if (actualNode) addInstallation(paths.dirname(actualNode));
  const pathValue = Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1] || '';
  for (const entry of pathValue.split(platform === 'win32' ? ';' : ':')) {
    const directory = entry.replace(/^"(.*)"$/, '$1');
    if (!directory) continue;
    addInstallation(directory);
    const actualNpm = resolveRealpath(paths.join(directory, 'npm'));
    if (actualNpm) add(actualNpm);
  }
  for (const candidate of new Set(candidates)) {
    if (fileExists(candidate)) return candidate;
  }
  throw new Error('未找到 npm-cli.js，请安装当前 Node.js 对应的 npm 后重试');
};

/** Use the project's installed builder, equivalent to npx --no-install. */
export const resolveElectronBuilderCli = ({ resolveModule = require.resolve } = {}) => {
  try {
    return resolveModule('electron-builder/out/cli/cli.js');
  } catch {
    throw new Error('未找到已安装的 electron-builder，请先执行 npm ci');
  }
};
