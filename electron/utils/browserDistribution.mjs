import { createHash } from 'node:crypto';
import fs from 'node:fs';

const RELEASE_BASE_URL = 'https://github.com/Resnie/finger-browser/releases/download/chrome';

// 内核包必须同时固定下载地址与 SHA-256。后端只公布版本号，
// 客户端仅接受当前平台已审核的发行包，避免把任意版本拼成 URL 后直接执行。
const DISTRIBUTIONS = Object.freeze({
  darwin: Object.freeze({
    '140.0.7259': Object.freeze({
      url: 'https://storage.googleapis.com/chrome-for-testing-public/140.0.7259.2/mac-arm64/chrome-mac-arm64.zip',
      sha256: 'c7943035dd1c720992e6ed530e1dd585e5bad4eb287ae280cc39cb5c8d5b49f6',
    }),
    '144.0.7500': Object.freeze({
      url: `${RELEASE_BASE_URL}/chrome-mac-arm64.144.0.7500.zip`,
      sha256: '47a6fc58f59f2723f1a6db868fc9ad3e7fc4c580865caf47550e92f5ddf193ff',
    }),
  }),
  win32: Object.freeze({
    '113.0.5672': Object.freeze({
      url: `${RELEASE_BASE_URL}/chrome-win64.113.0.5672.zip`,
      sha256: 'f7972bb5e72c4443abce98f326e4eb3101c48187146d48654058b32222df6d17',
    }),
    '120.0.6046': Object.freeze({
      url: `${RELEASE_BASE_URL}/chrome-win64.120.0.6046.zip`,
      sha256: '0e9d1b57a3dd1ce56dddb1764ef197f6572878493a25c8d098ad59588a041124',
    }),
    '125.0.6368': Object.freeze({
      url: `${RELEASE_BASE_URL}/chrome-win64.125.0.6368.zip`,
      sha256: '55a6e7d8cf131a7ed54125b15baca7f8fdd73ae6358f5acb8bd6e51de51daf46',
    }),
    '130.0.6669': Object.freeze({
      url: `${RELEASE_BASE_URL}/chrome-win64.130.0.6669.zip`,
      sha256: '74a17eab1bf7ba1ce63f3c1bb3e7bc601705f05e0d9f2e3edbbba30767888cca',
    }),
    '135.0.6999': Object.freeze({
      url: `${RELEASE_BASE_URL}/chrome-win64.135.0.6999.zip`,
      sha256: 'fdc17e191c6dd1c14ac22151dfd5e538420c122df61b1767cba4e08c2a2f5dce',
    }),
    '140.0.7259': Object.freeze({
      url: `${RELEASE_BASE_URL}/chrome-win64.140.0.7259.zip`,
      sha256: '37af1891243dda2217e49c5e1cf93b748f749577f3e7bd4c12a0cd464f430648',
    }),
    '144.0.7500': Object.freeze({
      url: `${RELEASE_BASE_URL}/chrome-win64.144.0.7500.zip`,
      sha256: '0888182fb809403b862c8e3f76a97050c4903dbce9ef9651df90ce9c8fdf031e',
    }),
  }),
});

export const getBrowserDistribution = (version, platform) => {
  const distribution = DISTRIBUTIONS[platform]?.[version];
  if (!distribution) {
    throw new Error(`内核版本 ${version} 暂不支持当前系统`);
  }
  return distribution;
};

export const isBrowserDistributionSupported = (version, platform) =>
  Boolean(DISTRIBUTIONS[platform]?.[version]);

export const filterSupportedBrowserVersions = (versions, platform) =>
  versions.filter(version => isBrowserDistributionSupported(version, platform));

export const calculateFileSha256 = filePath =>
  new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });

export const verifyBrowserArchive = async (filePath, expectedSha256) => {
  const actualSha256 = await calculateFileSha256(filePath);
  if (actualSha256 !== expectedSha256.toLowerCase()) {
    const error = new Error('浏览器内核包完整性校验失败');
    error.code = 'BROWSER_ARCHIVE_INTEGRITY_FAILED';
    throw error;
  }
  return actualSha256;
};
