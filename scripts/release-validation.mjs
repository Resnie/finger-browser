const stableVersion = value => {
  if (typeof value !== 'string' || !/^\d+\.\d+\.\d+$/.test(value)) {
    throw new Error('后端必须提供正式版本号，不能使用 dev、unknown 或预发布版本');
  }
  const parts = value.split('.').map(Number);
  if (!parts.every(Number.isSafeInteger)) throw new Error('后端版本号超出有效范围');
  return parts;
};

export const validateBackendRelease = (payload, compatibility) => {
  if (payload?.status !== 'ok') throw new Error('后端健康检查未通过');
  if (compatibility.requiredDatabaseMode && payload.databaseMode !== compatibility.requiredDatabaseMode) {
    throw new Error('后端未启用所需的共享账户与账务模式');
  }
  const actual = stableVersion(payload.version);
  const required = stableVersion(compatibility.minimumBackendVersion);
  for (let index = 0; index < 3; index += 1) {
    if (actual[index] > required[index]) break;
    if (actual[index] < required[index]) {
      throw new Error(
        `后端版本 ${payload.version} 低于最低要求 ${compatibility.minimumBackendVersion}`
      );
    }
  }
  if (typeof payload.commit !== 'string' || !/^[a-f0-9]{7,64}$/i.test(payload.commit)) {
    throw new Error('后端没有正式提交标识，不能使用本地验收或未标记的后端发布客户端');
  }
  const capabilities = new Set(Array.isArray(payload.capabilities) ? payload.capabilities : []);
  const missing = compatibility.requiredCapabilities.filter(item => !capabilities.has(item));
  if (missing.length) throw new Error(`后端缺少接口能力：${missing.join(', ')}`);
  return payload.version;
};
