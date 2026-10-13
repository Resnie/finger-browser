import test from 'node:test';
import assert from 'node:assert/strict';
import { createErrorFeedback, getUserFacingErrorMessage } from '../src/utils/error.mjs';

test('IPC 包装、技术细节和不可信响应不进入失败提示', () => {
  for (const raw of [
    'Error invoking remote method \'restore-instance\': Error: ENOENT /Users/test/private.json\n at launch (index.js:4)',
    '加载密码列表失败：Error invoking remote method \'get-passwords\': Error: ENOENT C:\\Users\\test\\vault.json',
    '请求失败：{"message":"internal","token":"private"}',
    '<img src=x onerror=alert(1)>',
    '请求失败：password=private',
    '请求失败：' + '详细信息'.repeat(60),
  ]) {
    const message = getUserFacingErrorMessage(raw);
    assert.ok(message.length <= 90);
    assert.doesNotMatch(message, /private|ENOENT|Error invoking|<img|token|\\Users|\/Users/);
  }
});

test('保留可处理的业务原因，隐藏占用、代理和同步的内部信息', () => {
  const cases = [
    ['Error invoking remote method \'open\': Error: 该浏览器的运行锁仍由原设备持有，请等待原设备保存并确认关闭后再打开', '此环境由原设备占用，请在原设备保存并关闭后再打开'],
    ['代理已启用但配置无效或获取失败，已阻止无代理启动', '代理连接失败，请检查代理地址和账号密码'],
    ['AxiosError: Network Error at http://127.0.0.1:8889/api/v1', '连接失败，请检查网络后重试'],
    ['SQLSTATE: SELECT password FROM t_user', '服务暂时不可用，请稍后重试'],
    ['本机最新恢复数据未能加密保存，请先修复系统安全存储', '本地数据无法安全保存，请检查系统安全存储后重试'],
    ['浏览器数据尚未完整同步，已保留运行锁', '数据尚未同步完成，请检查网络后重试'],
    ['USDT 余额不足，本次创建未执行，请充值后再试。', 'USDT 余额不足，本次创建未执行，请充值后再试。'],
    ['没有操作权限', '没有操作权限'],
  ];
  for (const [raw, expected] of cases) assert.equal(getUserFacingErrorMessage(raw), expected);
  assert.equal(getUserFacingErrorMessage(new Error('opaque internal'), '内核下载失败，请稍后重试'), '内核下载失败，请稍后重试');
});

test('接口、页面与 IPC 的同一个失败只展示一次，过后允许重试提示', () => {
  const calls = [];
  let time = 0;
  const show = createErrorFeedback(options => {
    const handle = { closed: false, close() { this.closed = true; options.onClose(); } };
    calls.push({ options, handle });
    return handle;
  }, { now: () => time });
  const original = new Error('Network Error');
  show(original);
  show(original);
  const same = new Error('ECONNRESET');
  show(same);
  assert.equal(same.isNotified, true);
  assert.equal(calls.length, 1);
  time = 3001;
  show(new Error('Network Error'));
  assert.equal(calls.length, 2);
  assert.equal(calls[0].handle.closed, true);
  show('没有操作权限');
  assert.equal(calls.length, 3);
  assert.equal(calls[1].handle.closed, true);
});

test('取消不提示，失败浮层统一样式与纯文本，数据保护提示可保留', () => {
  const calls = [];
  const show = createErrorFeedback(options => { calls.push(options); return { close() {} }; });
  show('cancel');
  show('close');
  show('用户取消');
  show({ message: '已处理', isNotified: true });
  assert.equal(calls.length, 0);
  show({ message: '<script>private()</script>', dangerouslyUseHTMLString: true, customClass: 'long-popup', duration: 0 });
  assert.equal(calls[0].message, '操作失败，请稍后重试');
  assert.equal(calls[0].dangerouslyUseHTMLString, false);
  assert.equal(calls[0].customClass, 'app-error-message');
  assert.equal(calls[0].showClose, true);
  assert.equal(calls[0].duration, 0);
  show('暂无可用内核，请先下载', undefined, 'warning');
  assert.equal(calls[1].type, 'warning');
});
