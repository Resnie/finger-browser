const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

const assertEntryArray = (value, label) => {
  if (!Array.isArray(value) || !value.every(isObject)) {
    throw new Error(`${label}格式无效，已阻止迁移`);
  }
  return value;
};

/**
 * 首次升级 cloud v1 时，仅把本机旧历史/凭据填入 revision=0 的空云字段。
 * state/pages 始终由服务端权威提供，不参与本地迁移。
 */
export const planLegacyRecoveryMigration = (serverRecovery, legacyCaches) => {
  if (!isObject(serverRecovery) || !isObject(legacyCaches)) {
    throw new Error('旧恢复缓存迁移输入无效');
  }
  if (serverRecovery.recoveryRevision !== 0) return null;

  const serverHistory = assertEntryArray(serverRecovery.history, '云端历史');
  const serverCredentials = assertEntryArray(serverRecovery.credentials, '云端凭据');
  const legacyHistory = assertEntryArray(legacyCaches.history, '本地旧历史');
  const legacyCredentials = assertEntryArray(legacyCaches.credentials, '本地旧凭据');

  const migrateHistory = serverHistory.length === 0 && legacyHistory.length > 0;
  const migrateCredentials = serverCredentials.length === 0 && legacyCredentials.length > 0;
  if (!migrateHistory && !migrateCredentials) return null;

  return {
    history: structuredClone(migrateHistory ? legacyHistory : serverHistory),
    credentials: structuredClone(migrateCredentials ? legacyCredentials : serverCredentials),
  };
};
