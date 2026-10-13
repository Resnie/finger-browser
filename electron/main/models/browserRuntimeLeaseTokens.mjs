const tokenPattern = /^[a-f0-9]{64}$/;
const idPattern = /^[A-Za-z0-9_-]{1,64}$/;

// Tokens stay in the desktop's OS-encrypted store and are never archived with a
// browser profile or included in a cloud recovery snapshot.
export class BrowserRuntimeLeaseTokens {
  constructor({ StoreClass, safeStorageAdapter }) {
    this.StoreClass = StoreClass;
    this.safeStorage = safeStorageAdapter;
  }
  _key(owner, id) {
    if (!Number.isSafeInteger(Number(owner)) || Number(owner) < 1 || !idPattern.test(id))
      throw new Error('运行锁的用户或浏览器归属无效');
    return `tokens.u${Number(owner)}.${id}`;
  }
  _store() {
    this.store ||= new this.StoreClass({ name: 'browser-runtime-locks' });
    return this.store;
  }
  _crypto() {
    if (!this.safeStorage?.isEncryptionAvailable?.())
      throw new Error('系统安全存储不可用，无法保存浏览器运行锁');
  }
  load(owner, id) {
    const value = this._store().get(this._key(owner, id));
    if (value === undefined) return '';
    this._crypto();
    if (typeof value !== 'string' || !value.startsWith('v1:'))
      throw new Error('本地运行锁格式损坏，已阻止忽略原设备占用');
    let token;
    try {
      token = this.safeStorage.decryptString(Buffer.from(value.slice(3), 'base64'));
    } catch {
      throw new Error('本地运行锁无法解密，已保留原设备占用');
    }
    if (!tokenPattern.test(token)) throw new Error('本地运行锁内容无效');
    return token;
  }
  save(owner, id, token) {
    if (!tokenPattern.test(token)) throw new Error('运行锁令牌无效');
    this._crypto();
    const encrypted = this.safeStorage.encryptString(token);
    if (!Buffer.isBuffer(encrypted) || !encrypted.length) throw new Error('运行锁加密失败');
    this._store().set(this._key(owner, id), 'v1:' + encrypted.toString('base64'));
  }
  clear(owner, id) {
    this._store().delete(this._key(owner, id));
  }
}
