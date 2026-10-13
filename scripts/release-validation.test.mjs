import assert from 'node:assert/strict';
import test from 'node:test';
import { validateBackendRelease } from './release-validation.mjs';

const compatibility = {
  minimumBackendVersion: '0.2.0',
  requiredCapabilities: ['cloud-recovery-v1', 'portable-profile-v1'],
};
const valid = {
  status: 'ok',
  version: '0.2.0',
  commit: '1234567abcde',
  capabilities: compatibility.requiredCapabilities,
};
test('正式后端版本、提交和能力齐备才允许发布客户端', () => {
  assert.equal(validateBackendRelease(valid, compatibility), '0.2.0');
  assert.equal(validateBackendRelease({ ...valid, version: '1.0.0' }, compatibility), '1.0.0');
});
test('dev、unknown、缺失或预发布版本不能因NaN比较绕过版本门禁', () => {
  for (const version of ['dev', 'unknown', undefined, '0.2.0-beta', '0.2', 'Infinity.2.0']) {
    assert.throws(() => validateBackendRelease({ ...valid, version }, compatibility));
  }
});
test('过低版本和缺少恢复能力时阻止发布', () => {
  assert.throws(
    () => validateBackendRelease({ ...valid, version: '0.1.99' }, compatibility),
    /低于/
  );
  assert.throws(
    () => validateBackendRelease({ ...valid, capabilities: ['cloud-recovery-v1'] }, compatibility),
    /portable-profile/
  );
});
test('本地验收、unknown提交及健康失败不能作为正式后端', () => {
  for (const commit of ['local-acceptance', 'unknown', '', undefined]) {
    assert.throws(() => validateBackendRelease({ ...valid, commit }, compatibility), /提交标识/);
  }
  assert.throws(() => validateBackendRelease({ ...valid, status: 'error' }, compatibility), /健康/);
});
