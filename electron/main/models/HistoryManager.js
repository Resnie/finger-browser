import fs from 'fs';
import Store from 'electron-store';
import { logger } from '../../utils/logger.js';
import {
  addHistoryVisit,
  ensureHistoryEntry,
  isRecordableHistoryUrl,
  normalizeHistoryEntries,
  normalizeRecoveryHistoryEntries,
  updateHistoryMetadata,
} from './historyEntries.mjs';

/**
 * 每实例历史记录管理器
 */
export class HistoryManager {
  constructor(instanceId, { onChanged = null, ownerId = null } = {}) {
    this.instanceId = instanceId;
    this.ownerId = ownerId === null || ownerId === undefined ? null : String(ownerId);
    if (this.ownerId !== null && !/^[1-9][0-9]{0,19}$/.test(this.ownerId)) {
      throw new Error('历史记录用户 ID 格式无效');
    }
    this.onChanged = typeof onChanged === 'function' ? onChanged : null;
    this.store = new Store({
      name: this.ownerId ? `history-u${this.ownerId}-${instanceId}` : `history-${instanceId}`,
      configFileMode: 0o600,
      clearInvalidConfig: false,
    });
    this.logger = logger.createContextLogger(`History:${instanceId}`);

    if (process.platform !== 'win32') {
      try {
        fs.chmodSync(this.store.path, 0o600);
      } catch {
        // 文件可能尚未创建，首次写入时会使用 configFileMode。
      }
    }
  }

  /**
   * 添加历史记录
   */
  addEntry(url, title = '', favicon = '') {
    if (!isRecordableHistoryUrl(url)) return;
    const entries = addHistoryVisit(this.exportEntries(), url, title, favicon);
    this.store.set('entries', entries);
    this.onChanged?.('history-added');
  }

  /**
   * 确保已打开的初始/恢复页面至少存在一条历史记录，但不增加已有记录的访问次数。
   */
  ensureEntry(url, title = '', favicon = '') {
    if (!isRecordableHistoryUrl(url)) return;
    const entries = ensureHistoryEntry(this.exportEntries(), url, title, favicon);
    this.store.set('entries', entries);
    this.onChanged?.('history-ensured');
  }

  /**
   * 页面 load 事件只补全标题/图标，不把同一次导航重复计为一次访问。
   */
  updateEntryMetadata(url, title = '', favicon = '') {
    if (!isRecordableHistoryUrl(url)) return false;

    const currentEntries = this.exportEntries();
    const existing = currentEntries.find(entry => entry.url === url.trim());
    if (!existing) return false;

    const hasChanged =
      (typeof title === 'string' && title && title !== existing.title) ||
      (typeof favicon === 'string' && favicon && favicon !== existing.favicon);
    if (hasChanged) {
      this.store.set('entries', updateHistoryMetadata(currentEntries, url, title, favicon));
      this.onChanged?.('history-metadata');
    }
    return true;
  }

  /**
   * 获取所有历史记录
   */
  getEntries() {
    try {
      return normalizeHistoryEntries(this.store.get('entries', []));
    } catch {
      this.logger.warn('读取历史记录失败，已使用空列表');
      return [];
    }
  }

  /**
   * 导出经过限量和格式收敛的明文历史，仅用于已认证的云端恢复接口。
   */
  exportEntries() {
    let rawEntries;
    try {
      rawEntries = this.store.get('entries', []);
    } catch (cause) {
      throw new Error('本地历史缓存读取失败，已阻止覆盖云端备份', { cause });
    }
    const normalized = normalizeRecoveryHistoryEntries(rawEntries);
    if (normalized === null) {
      throw new Error('本地历史缓存格式无效，已阻止覆盖云端备份');
    }
    return normalized;
  }

  /**
   * 将后端恢复数据原子替换本地 0600 缓存。字段缺失时调用方不应调用本方法。
   */
  importEntries(rawEntries, { notify = false } = {}) {
    if (!Array.isArray(rawEntries)) throw new Error('云端浏览历史格式无效');
    const normalized = normalizeRecoveryHistoryEntries(rawEntries);
    if (normalized === null) {
      throw new Error('云端浏览历史包含无效数据');
    }
    this.store.set('entries', normalized);
    if (notify) this.onChanged?.('history-imported');
    return normalized.length;
  }

  /**
   * 获取最近访问记录
   */
  getRecent(limit = 50) {
    const entries = this.getEntries();
    return entries.sort((a, b) => b.lastVisitTime - a.lastVisitTime).slice(0, limit);
  }

  /**
   * 搜索历史记录
   */
  search(query, limit = 50) {
    if (!query) return this.getRecent(limit);
    const q = query.toLowerCase();
    return this.getEntries()
      .filter(
        e => e.url.toLowerCase().includes(q) || (e.title && e.title.toLowerCase().includes(q))
      )
      .slice(0, limit);
  }

  /**
   * 按域名分组
   */
  groupByDomain() {
    const entries = this.getEntries();
    const groups = {};
    for (const entry of entries) {
      try {
        const domain = new URL(entry.url).hostname;
        if (!groups[domain]) groups[domain] = [];
        groups[domain].push(entry);
      } catch {}
    }
    return groups;
  }

  /**
   * 清除所有历史记录
   */
  clear({ notify = true } = {}) {
    this.store.set('entries', []);
    if (notify) this.onChanged?.('history-cleared');
    this.logger.info('历史记录已清除');
  }
}
