import { isIP } from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const restoreKey = 'finger_browser_proxy_webrtc_restore';
const protectedKeys = ['ip_handling_policy', 'ip_handling_url'];
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// Chrome reads this policy from profile preferences. The command-line switch
// alone only affects some Chromium embedders and does not protect Chrome 140.
// Apply after cloud profile restoration, before any native context is launched.
export async function prepareProxyNetworkProfile(profileDir, enabled) {
  const directory = path.join(profileDir, 'Default');
  const file = path.join(directory, 'Preferences');
  let prefs;
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('浏览器网络配置文件不是普通文件');
    prefs = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if (!enabled) return;
    prefs = {};
  }
  if (!plain(prefs) || (prefs.webrtc !== undefined && !plain(prefs.webrtc))) {
    throw new Error('浏览器网络配置格式无效，已阻止启动');
  }
  const backup = prefs[restoreKey];
  if (backup !== undefined && (!plain(backup) || backup.version !== 1 ||
      typeof backup.hadWebrtc !== 'boolean' || !plain(backup.original) ||
      protectedKeys.some(key => !plain(backup.original[key]) ||
        typeof backup.original[key].present !== 'boolean'))) {
    throw new Error('浏览器网络配置备份无效，已阻止启动');
  }
  if (enabled) {
    if (!backup) {
      prefs[restoreKey] = {
        version: 1,
        hadWebrtc: prefs.webrtc !== undefined,
        original: Object.fromEntries(protectedKeys.map(key => [key, {
          present: Object.hasOwn(prefs.webrtc || {}, key),
          ...(Object.hasOwn(prefs.webrtc || {}, key) ? { value: prefs.webrtc[key] } : {}),
        }])),
      };
    }
    prefs.webrtc ||= {};
    prefs.webrtc.ip_handling_policy = 'disable_non_proxied_udp';
    // A per-site exception takes precedence over the global policy.
    prefs.webrtc.ip_handling_url = [];
  } else {
    if (!backup) return;
    prefs.webrtc ||= {};
    for (const key of protectedKeys) {
      if (backup.original[key].present) prefs.webrtc[key] = backup.original[key].value;
      else delete prefs.webrtc[key];
    }
    if (!backup.hadWebrtc && Object.keys(prefs.webrtc).length === 0) delete prefs.webrtc;
    delete prefs[restoreKey];
  }
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await fs.lstat(directory)).isSymbolicLink()) {
    throw new Error('浏览器网络配置目录不能使用符号链接');
  }
  const temporary = `${file}.finger-proxy-${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(prefs), { mode: 0o600, flag: 'wx' });
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

// A context proxy alone does not cover WebRTC UDP or speculative DNS. Apply
// these restrictions before Chromium starts, including its temporary probe.
export function applyProxyNetworkPolicy(options, proxy) {
  const address = new URL(proxy.server);
  const host = address.hostname.replace(/^\[|\]$/g, '');
  if (!['http:', 'https:', 'socks5:'].includes(address.protocol) ||
      (!isIP(host) && !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(host))) {
    throw new Error('代理主机格式无效，已阻止启动');
  }

  // Chromium applies resolver mapping even to literal IPs. Exclude the proxy
  // endpoint so it remains reachable; an IP literal still needs no DNS query.
  // Website, STUN and speculative hostnames cannot use the local resolver.
  const resolver = `MAP * ~NOTFOUND, EXCLUDE ${host}`;
  const replaced = [
    '--force-webrtc-ip-handling-policy',
    '--host-resolver-rules',
    '--enable-quic',
    '--disable-quic',
    '--proxy-bypass-list',
  ];
  options.args = (options.args || []).filter(arg =>
    !replaced.some(flag => arg === flag || arg.startsWith(`${flag}=`))
  );
  options.args.push(
    '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    '--disable-quic',
    `--host-resolver-rules=${resolver}`,
    '--proxy-bypass-list=<-loopback>',
  );
  options.proxy = { ...proxy, bypass: '<-loopback>' };
  return options;
}
