#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateBackendRelease } from './release-validation.mjs';
import { resolveNpmCli, resolveElectronBuilderCli } from './node-cli.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packagePath = path.join(repositoryRoot, 'package.json');
const compatibilityPath = path.join(repositoryRoot, 'config', 'release-compatibility.json');

const fail = message => {
  console.error(`发布检查失败：${message}`);
  process.exit(1);
};

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    env: options.env || process.env,
    shell: false,
  });
  if (result.error) fail(`${command} 无法执行：${result.error.message}`);
  if (result.status !== 0) {
    if (options.capture && result.stderr) console.error(result.stderr.trim());
    fail(`${command} ${args.join(' ')} 执行失败`);
  }
  return options.capture ? result.stdout.trim() : '';
};

const parseArguments = argv => {
  let action = 'dry-run';
  let platform = process.platform === 'win32' ? 'win' : 'mac';

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--build' || argument === '--release') {
      if (action !== 'dry-run') fail('--build 与 --release 只能选择一个');
      action = argument.slice(2);
      continue;
    }
    if (argument === '--platform') {
      platform = argv[index + 1];
      index += 1;
      continue;
    }
    if (argument === '--help' || argument === '-h') {
      console.log(`用法：
  node scripts/release.mjs                         仅执行发布前检查（默认，不构建、不上传）
  node scripts/release.mjs --build --platform mac  本地构建，不上传
  node scripts/release.mjs --release --platform win 构建并上传 GitHub Release

发布需要：
  RELEASE_TAG=v<package.json version>
  ELECTRON_BUILDER_GH_TOKEN（推荐）或 GH_TOKEN

可选签名变量：ELECTRON_CSC_LINK、ELECTRON_CSC_KEY_PASSWORD`);
      process.exit(0);
    }
    fail(`不支持的参数：${argument}`);
  }

  if (!['mac', 'win'].includes(platform)) fail('--platform 仅支持 mac 或 win');
  return { action, platform };
};

const hasEmbeddedCredentialField = value => {
  if (Array.isArray(value)) return value.some(hasEmbeddedCredentialField);
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(
    ([key, child]) =>
      /^(?:token|token1|privateKey|password)$/i.test(key) || hasEmbeddedCredentialField(child)
  );
};

const checkBackendCompatibility = async compatibility => {
  const endpoint = process.env.BACKEND_RELEASE_INFO_URL;
  if (!endpoint) fail('正式发布必须配置 BACKEND_RELEASE_INFO_URL');
  let parsedEndpoint;
  try {
    parsedEndpoint = new URL(endpoint);
  } catch {
    fail('BACKEND_RELEASE_INFO_URL 不是有效 URL');
  }
  if (parsedEndpoint.protocol !== 'https:') fail('正式发布的后端兼容检查地址必须使用 HTTPS');
  if (parsedEndpoint.username || parsedEndpoint.password) fail('后端兼容检查地址不得包含账号密码');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  let response;
  try {
    response = await fetch(parsedEndpoint, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
      redirect: 'error',
    });
  } catch (error) {
    fail(`无法检查已部署后端：${error.message}`);
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) fail(`后端兼容检查返回 HTTP ${response.status}`);

  const contentType = response.headers.get('content-type') || '';
  if (!contentType.toLowerCase().includes('application/json')) fail('后端兼容检查未返回 JSON');
  const payload = await response.json();
  try {
    validateBackendRelease(payload, compatibility);
  } catch (error) {
    fail(error.message);
  }
  console.log(`后端兼容门禁通过：${payload.version}（${payload.commit || '未标记提交'}）。`);
};

const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
const compatibility = JSON.parse(fs.readFileSync(compatibilityPath, 'utf8'));
const { action, platform } = parseArguments(process.argv.slice(2));

if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(packageJson.version || '')) {
  fail('package.json version 必须是有效的语义化版本');
}
if (hasEmbeddedCredentialField(packageJson.build?.publish)) {
  fail('package.json 的 build.publish 中禁止配置令牌、私钥或密码字段');
}
const githubPublishTarget = packageJson.build?.publish?.find?.(item => item.provider === 'github');
if (!githubPublishTarget) {
  fail('package.json 未配置 GitHub 发布目标');
}
const expectedGithubRepository = `${githubPublishTarget.owner}/${githubPublishTarget.repo}`;
if (process.env.GITHUB_REPOSITORY && process.env.GITHUB_REPOSITORY !== expectedGithubRepository) {
  fail(`当前 GitHub 仓库与发布目标不一致：应为 ${expectedGithubRepository}`);
}
if (!/^\d+\.\d+\.\d+$/.test(compatibility.minimumBackendVersion || '')) {
  fail('release-compatibility.json 缺少有效的 minimumBackendVersion');
}
if (
  !Array.isArray(compatibility.requiredCapabilities) ||
  compatibility.requiredCapabilities.some(item => typeof item !== 'string' || !item)
) {
  fail('release-compatibility.json 的 requiredCapabilities 格式无效');
}

let npmCli;
try {
  npmCli = resolveNpmCli();
} catch (error) {
  fail(error.message);
}
run(process.execPath, [npmCli, 'run', 'test:quality']);

const expectedTag = `v${packageJson.version}`;
if (process.env.RELEASE_TAG && process.env.RELEASE_TAG !== expectedTag) {
  fail(`RELEASE_TAG 必须为 ${expectedTag}`);
}

if (action === 'dry-run') {
  const worktree = run('git', ['status', '--short'], { capture: true });
  console.log(`发布前检查通过：版本 ${packageJson.version}，目标平台 ${platform}。`);
  console.log('当前为 dry-run：未构建、未上传，也未访问远端。');
  if (worktree) console.log('提示：工作区有未提交修改；正式发布前必须提交并打标签。');
  process.exit(0);
}

if (run('git', ['status', '--porcelain'], { capture: true })) {
  fail('构建或发布要求 Git 工作区干净');
}

let builderCli;
try {
  builderCli = resolveElectronBuilderCli();
} catch (error) {
  fail(error.message);
}
const builderArgs = [builderCli, `--${platform}`];
let childEnvironment = process.env;
if (action === 'release') {
  if (process.env.RELEASE_TAG !== expectedTag) {
    fail(`正式发布必须显式设置 RELEASE_TAG=${expectedTag}`);
  }
  const headTags = run('git', ['tag', '--points-at', 'HEAD'], { capture: true }).split('\n');
  if (!headTags.includes(expectedTag)) fail(`当前提交没有标签 ${expectedTag}`);

  const tagRef = `refs/tags/${expectedTag}`;
  if (run('git', ['cat-file', '-t', tagRef], { capture: true }) === 'tag') {
    const tagMessage = run(
      'git',
      ['for-each-ref', '--format=%(contents:subject)%0a%(contents:body)', tagRef],
      { capture: true }
    );
    if (!['', expectedTag, packageJson.version].includes(tagMessage)) {
      fail(`版本标签注释只能保留版本号 ${expectedTag}，不得填写简介`);
    }
  }

  const publishToken = process.env.ELECTRON_BUILDER_GH_TOKEN || process.env.GH_TOKEN;
  if (!publishToken) fail('缺少 GitHub 发布令牌环境变量');
  await checkBackendCompatibility(compatibility);

  childEnvironment = { ...process.env };
  childEnvironment['GH' + '_TOKEN'] = publishToken;
  if (process.env.ELECTRON_CSC_LINK) childEnvironment.CSC_LINK = process.env.ELECTRON_CSC_LINK;
  if (process.env.ELECTRON_CSC_KEY_PASSWORD) {
    childEnvironment.CSC_KEY_PASSWORD = process.env.ELECTRON_CSC_KEY_PASSWORD;
  }
}

run(process.execPath, [npmCli, 'run', 'build']);

if (action === 'build') {
  run(process.execPath, [...builderArgs, '--publish', 'never']);
  console.log(`客户端 ${platform} 构建完成；未上传。`);
  process.exit(0);
}

run(process.execPath, [...builderArgs, '--publish', 'always'], {
  env: childEnvironment,
});
console.log(`GitHub Release ${expectedTag} 的 ${platform} 安装包已上传。`);
