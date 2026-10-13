// 主进程代码
import fs from 'fs';
import Store from 'electron-store';

const store = new Store({ configFileMode: 0o600 });

// configFileMode 只保证新建文件的权限；旧版本已经创建的配置文件也主动收紧。
if (process.platform !== 'win32') {
  try {
    fs.chmodSync(store.path, 0o600);
  } catch {
    // 文件可能尚未创建，electron-store 首次写入时会使用 configFileMode。
  }
}

export default store;
