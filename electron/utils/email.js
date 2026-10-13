import Imap from 'imap';
import { resolveMailTlsOptions } from './mailTlsPolicy.mjs';
import Pop3Command from 'node-pop3';
import { simpleParser } from 'mailparser';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { dialog } from 'electron';
import ExcelJS from 'exceljs';
import { getProjectBasePath, ensureDir } from './config.js';
import { rsaEncrypt } from './googleAuth.js';
import {
  buildGoogleAuthCloudValue,
  normalizeGoogleAuthPreparationOptions,
  normalizeGoogleAuthSecret,
} from './googleAuthProtocol.mjs';
import store from './store.js';
import { logger } from './logger.js';
import { ipcEmitter } from '../main/ipc/emitter.js';
import { findVerificationCode } from './verificationCode.mjs';

const emailLogger = logger.createContextLogger('Email');

// 邮箱地址格式校验，禁止任何可用于路径穿越的字符（如 / 或 ..）
const EMAIL_PATTERN = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+$/;
// 收件箱名称白名单：仅允许字母数字、下划线、连字符
const BOX_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
const POP3_LOCAL_UID_PATTERN = /^pop3-[a-f0-9]{24}$/;

const parseMailCacheFileName = fileName => {
  const match = /^(\d+)_(.+)_(\d+|pop3-[a-f0-9]{24})\.data$/.exec(fileName);
  if (!match || !BOX_NAME_PATTERN.test(match[2])) return null;
  const timestamp = Number(match[1]);
  return {
    emailTime: match[1].length === 10 ? timestamp * 1000 : timestamp,
    boxName: match[2],
    uid: match[3],
  };
};

const sortMailCacheFiles = (files, directory) =>
  files
    .map(fileName => ({ fileName, ...parseMailCacheFileName(fileName) }))
    .filter(item => Number.isFinite(item.emailTime))
    .sort((a, b) => {
      const dateDifference = b.emailTime - a.emailTime;
      if (dateDifference) return dateDifference;
      // Date 邮件头仅精确到秒；同秒邮件必须按递增 UID 取最新，避免读到上一个码。
      if (/^\d+$/.test(a.uid) && /^\d+$/.test(b.uid)) return Number(b.uid) - Number(a.uid);
      return (
        fs.statSync(path.join(directory, b.fileName)).mtimeMs -
        fs.statSync(path.join(directory, a.fileName)).mtimeMs
      );
    });

const validateMailConnection = ({ email, password, host, port, tls = true }) => {
  if (typeof email !== 'string' || !EMAIL_PATTERN.test(email)) throw new Error('邮箱地址无效');
  if (typeof password !== 'string' || !password || /[\r\n\0]/.test(password))
    throw new Error('邮箱密码无效');
  if (typeof host !== 'string' || !host || /[\s/\\\0]/.test(host))
    throw new Error('邮件服务器地址无效');
  if (
    port != null &&
    (!Number.isInteger(Number(port)) || Number(port) < 1 || Number(port) > 65535)
  ) {
    throw new Error('邮件服务器端口无效');
  }
  if (tls !== true) throw new Error('邮件同步需要使用 TLS 加密连接');
};

const getPop3UidCacheKey = email => {
  const accountHash = crypto.createHash('sha256').update(email).digest('hex');
  return `emailPop3Uids.${accountHash}`;
};

const getCachedPop3Uids = email => {
  const cachedUids = store.get(getPop3UidCacheKey(email), []);
  if (!Array.isArray(cachedUids)) return new Set();
  return new Set(cachedUids.filter(uid => typeof uid === 'string' && uid.length > 0));
};

const saveCachedPop3Uids = (email, uids) => {
  store.set(getPop3UidCacheKey(email), Array.from(uids));
};

// POP3 UIDL 通常是非数字字符串。本地标识由原始 UIDL 稳定派生，
// 不再依赖会随邮件删除而变化的消息序号。pop3- 前缀也使 IMAP
// 的数字 UID 扫描能够忽略 POP3 缓存。
const getPop3LocalUid = uid => {
  const uidHash = crypto.createHash('sha256').update(uid).digest('hex').slice(0, 24);
  return `pop3-${uidHash}`;
};

const mailOperationTimeoutMs = 30000;
const withMailTimeout = async (operation, timeoutMs, onTimeout) => {
  let timer;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          onTimeout();
          reject(new Error('邮件服务器响应超时，请稍后重试'));
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

// UID 只在同一个 UIDVALIDITY 中有效。邮箱重建后清理此收件箱的可重建缓存，
// 防止旧 UID 阻止新邮件同步；逐个比较缓存也能重试上次漏存的邮件。
const prepareImapCache = (email, boxName, uidValidity) => {
  getLatestLocalIndex(email, boxName); // 兼容清理旧的秒级文件名。
  const key = `emailImapValidity.${crypto.createHash('sha256').update(`${email}\n${boxName}`).digest('hex')}`;
  const previous = store.get(key);
  const validity = String(uidValidity || '');
  const items = listLocalEmailCache(email).filter(item => item.boxName === boxName);
  if (previous && validity && previous !== validity) {
    for (const item of items) {
      fs.unlinkSync(item.bodyPath);
      store.delete(`emailHeaders.${email}_${item.fileName}`);
    }
  }
  if (validity) store.set(key, validity);
  return new Set(
    (previous && validity && previous !== validity ? [] : items)
      .filter(item => /^\d+$/.test(item.uid))
      .map(item => Number(item.uid))
  );
};

/**
 * 获取邮件存储根路径
 * @returns {string}
 */
export const getEmailBasePath = () => {
  return ensureDir(path.join(getProjectBasePath(), 'email'));
};

/**
 * 校验邮箱地址并解析其本地目录，确保结果落在邮件根目录内（防路径穿越）
 * @param {string} email - 邮箱地址
 * @returns {string} 该邮箱的本地目录绝对路径
 */
const resolveEmailDir = email => {
  if (typeof email !== 'string' || !EMAIL_PATTERN.test(email)) {
    throw new Error(`非法邮箱地址: ${email}`);
  }
  const base = path.resolve(getEmailBasePath());
  const dir = path.resolve(base, email);
  if (!dir.startsWith(base + path.sep)) {
    throw new Error('邮箱路径越界');
  }
  return dir;
};

/**
 * 获取某邮箱某收件箱下本地已缓存的最新 UID
 * 扫描本地邮件文件目录，解析文件名 {emailTime}_{boxName}_{uid}.data 获取最大 UID
 * 与旧项目 getBoxNewIndex 逻辑一致
 * @param {string} email - 邮箱地址
 * @param {string} boxName - 收件箱名称
 * @returns {number} 最新 UID，未缓存返回 0
 */
export const getLatestLocalIndex = (email, boxName = 'INBOX') => {
  let nowIndex = 0;

  try {
    const filePath = resolveEmailDir(email);
    if (!fs.existsSync(filePath)) {
      ensureDir(filePath);
      return nowIndex;
    }

    const stat = fs.statSync(filePath);
    if (!stat.isDirectory()) return nowIndex;

    const emailDir = fs.readdirSync(filePath);
    const emailList = emailDir.filter(f => f.endsWith('.data'));

    // 按时间戳降序排列
    emailList.sort((a, b) => b.substring(0, 13) - a.substring(0, 13));

    let haveOldFile = false;
    for (const item of emailList) {
      const itemData = parseMailCacheFileName(item);
      if (itemData) {
        // 检测旧的 10 位时间戳文件
        if (item.split('_')[0].length === 10) {
          haveOldFile = true;
        }
        if (itemData.boxName === boxName) {
          const uid = parseInt(itemData.uid) || 0;
          if (uid > nowIndex) {
            nowIndex = uid;
          }
        }
      }
    }

    // 如果存在旧格式文件，清除并返回 0 强制重新下载
    if (haveOldFile) {
      for (const file of emailList) {
        try {
          fs.unlinkSync(path.join(filePath, file));
        } catch (e) {
          // 忽略删除错误
        }
      }
      return 0;
    }
  } catch (error) {
    emailLogger.error(`获取本地索引失败 (${email}/${boxName}): ${error.message}`);
  }

  return nowIndex;
};

/**
 * 保存单封邮件到本地
 * 文件命名: {emailTime}_{boxName}_{uid}.data（与旧项目一致）
 * 邮件头存入 electron-store，键: {email}_{emailTime}_{boxName}_{uid}.data
 * @param {string} email - 邮箱地址
 * @param {string} header - 邮件主题/头信息字符串
 * @param {string} content - 邮件正文（HTML 或文本）
 * @param {string|number} emailTime - 邮件时间戳
 * @param {string} boxName - 收件箱名称
 * @param {string|number} uid - 邮件 UID
 */
export const saveEmailToLocal = (email, header, content, emailTime, boxName, uid) => {
  try {
    // 转换时间戳：如果是 10 位（秒），转为 13 位（毫秒）
    if ((emailTime + '').length === 10) {
      emailTime = emailTime * 1000;
    }
    // 如果是 ISO 字符串，转为时间戳
    if (typeof emailTime === 'string' && emailTime.includes('T')) {
      emailTime = new Date(emailTime).getTime();
    }

    // 校验文件名各组成部分，防止服务端响应或邮件元数据构造路径穿越
    const safeTime = String(emailTime).replace(/[^0-9]/g, '') || '0';
    const safeBox = BOX_NAME_PATTERN.test(boxName) ? boxName : 'INBOX';
    const rawUid = String(uid);
    const numericUid = /^\d+$/.test(rawUid) ? Number(rawUid) : NaN;
    const safeUid = POP3_LOCAL_UID_PATTERN.test(rawUid)
      ? rawUid
      : Number.isSafeInteger(numericUid) && numericUid >= 0
        ? String(numericUid)
        : null;
    if (!safeUid) {
      throw new Error(`非法邮件 UID: ${uid}`);
    }

    const emailDir = ensureDir(resolveEmailDir(email));
    const fileName = `${safeTime}_${safeBox}_${safeUid}.data`;

    // 保存邮件正文到文件
    const bodyPath = path.join(emailDir, fileName);
    fs.writeFileSync(bodyPath, content || '', { encoding: 'utf-8', mode: 0o600 });
    if (process.platform !== 'win32') {
      fs.chmodSync(bodyPath, 0o600);
    }

    // 保存邮件头到 electron-store（键格式与旧项目一致）
    const headerKey = `emailHeaders.${email}_${fileName}`;
    const headerStr = typeof header === 'string' ? header : header.subject || '';
    store.set(headerKey, headerStr);

    emailLogger.info(`保存邮件: ${email}/${boxName}/${uid}`);
  } catch (error) {
    emailLogger.error(`保存邮件失败: ${error.message}`);
    throw error;
  }
};

/**
 * 通过 IMAP 读取邮件
 * @param {Object} data - 连接参数
 * @param {string} data.email - 邮箱地址
 * @param {string} data.password - 密码或授权码
 * @param {string} data.host - IMAP 服务器
 * @param {number} data.port - 端口
 * @param {boolean} [data.tls] - 是否使用 TLS
 * @param {string} [data.boxName] - 收件箱名称，默认 INBOX
 * @returns {Promise<{ success: boolean, count?: number, message?: string }>}
 */
export const fetchEmailsViaImap = async data => {
  validateMailConnection(data);
  const { email, password, host, port, tls = true, boxName = 'INBOX' } = data;

  const imap = new Imap({
    user: email,
    password,
    host,
    port: port || 993,
    tls,
    tlsOptions: resolveMailTlsOptions(data),
    connTimeout: 30000,
    authTimeout: 30000,
    socketTimeout: mailOperationTimeoutMs,
    keepalive: false,
  });

  let completedSuccessfully = false;

  try {
    const result = await new Promise((resolve, reject) => {
      let settled = false;
      let fetchedCount = 0;
      let failedCount = 0;

      const resolveOnce = value => {
        if (settled) return;
        settled = true;
        resolve(value);
      };

      const rejectOnce = (error, context) => {
        if (settled) return;
        settled = true;
        emailLogger.error(`${context} (${email}): ${error.message}`);
        ipcEmitter.send('email-fetch-error', { email, message: error.message });
        reject(error);
      };

      const complete = (message, count) => {
        ipcEmitter.send('email-fetch-complete', { email, message, count });
        resolveOnce({ success: true, count });
      };

      imap.once('ready', () => {
        imap.openBox(boxName, true, (err, box) => {
          if (err) {
            rejectOnce(err, '打开收件箱失败');
            return;
          }

          const totalMessages = box.messages.total;
          let cachedUids;
          try {
            cachedUids = prepareImapCache(email, boxName, box.uidvalidity);
          } catch (cacheError) {
            rejectOnce(cacheError, '准备邮件缓存失败');
            return;
          }

          ipcEmitter.send('email-fetch-progress', {
            email,
            status: 'started',
            message: `开始读取邮件，共 ${totalMessages} 封`,
            total: totalMessages,
          });

          if (totalMessages === 0) {
            complete('没有新邮件', 0);
            return;
          }

          imap.search(['ALL'], (searchErr, uids) => {
            if (searchErr) {
              rejectOnce(searchErr, '搜索邮件失败');
              return;
            }

            // 过滤掉已缓存的 UID
            const newUids = uids.filter(uid => !cachedUids.has(uid));

            if (newUids.length === 0) {
              complete('没有新邮件', 0);
              return;
            }

            const pendingMessages = [];
            let processedCount = 0;
            const fetch = imap.fetch(newUids, { bodies: '' });

            fetch.on('message', msg => {
              const rawChunks = [];
              let bodyError = null;
              let uid = null;

              const pendingMessage = new Promise(resolveMessage => {
                msg.on('body', stream => {
                  stream.on('data', chunk => {
                    rawChunks.push(Buffer.from(chunk));
                  });
                  stream.once('error', error => {
                    bodyError = error;
                  });
                });

                msg.once('attributes', attrs => {
                  uid = attrs.uid;
                });

                msg.once('end', () => {
                  void (async () => {
                    try {
                      if (bodyError) throw bodyError;

                      const parsed = await simpleParser(Buffer.concat(rawChunks));
                      const subject = parsed.subject || '(无主题)';
                      const htmlContent = parsed.html || parsed.textAsHtml || parsed.text || '';
                      const emailTime = parsed.date ? parsed.date.getTime() : Date.now();

                      saveEmailToLocal(email, subject, htmlContent, emailTime, boxName, uid);
                      fetchedCount++;
                    } catch (parseErr) {
                      failedCount++;
                      emailLogger.error(`解析邮件失败 (${email}, uid=${uid}): ${parseErr.message}`);
                    } finally {
                      processedCount++;
                      ipcEmitter.send('email-fetch-progress', {
                        email,
                        status: 'progress',
                        message: `已处理 ${processedCount}/${newUids.length}，成功 ${fetchedCount} 封`,
                        current: processedCount,
                        total: newUids.length,
                      });
                      resolveMessage();
                    }
                  })();
                });
              });

              pendingMessages.push(pendingMessage);
            });

            fetch.once('error', fetchErr => {
              rejectOnce(fetchErr, '获取邮件失败');
            });

            fetch.once('end', () => {
              void (async () => {
                await Promise.all(pendingMessages);
                if (failedCount > 0) {
                  rejectOnce(
                    new Error(`已读取 ${fetchedCount} 封邮件，${failedCount} 封未能读取，请重试`),
                    '邮件读取不完整'
                  );
                  return;
                }
                complete(`读取完成，共 ${fetchedCount} 封新邮件`, fetchedCount);
              })();
            });
          });
        });
      });

      imap.once('error', err => {
        rejectOnce(err, 'IMAP 连接错误');
      });

      imap.once('end', () => {
        emailLogger.info(`IMAP 连接关闭: ${email}`);
        if (!settled) rejectOnce(new Error('邮件服务器提前关闭了连接，请重试'), 'IMAP 连接中断');
      });
      imap.once('close', () => {
        if (!settled) rejectOnce(new Error('邮件服务器连接中断，请重试'), 'IMAP 连接中断');
      });

      imap.connect();
    });

    completedSuccessfully = true;
    return result;
  } finally {
    try {
      if (completedSuccessfully && imap.state === 'authenticated') {
        imap.end();
      } else {
        imap.destroy();
      }
    } catch (closeError) {
      emailLogger.warn(`关闭 IMAP 连接失败 (${email}): ${closeError.message}`);
      imap.destroy();
    }
  }
};

/**
 * 通过 POP3 读取邮件
 * @param {Object} data - 连接参数
 * @param {string} data.email - 邮箱地址
 * @param {string} data.password - 密码或授权码
 * @param {string} data.host - POP3 服务器
 * @param {number} data.port - 端口
 * @param {boolean} [data.tls] - 是否使用 TLS
 * @returns {Promise<{ success: boolean, count?: number, message?: string }>}
 */
export const fetchEmailsViaPop3 = async data => {
  validateMailConnection(data);
  const { email, password, host, port, tls = true } = data;
  const boxName = 'INBOX';
  let pop3 = null;

  try {
    pop3 = new Pop3Command({
      user: email,
      password,
      host,
      port: port || 995,
      tls,
      tlsOptions: resolveMailTlsOptions(data),
      timeout: mailOperationTimeoutMs,
    });

    const closeSocket = () => pop3?._socket?.destroy();
    const list = await withMailTimeout(pop3.UIDL(), mailOperationTimeoutMs, closeSocket);

    ipcEmitter.send('email-fetch-progress', {
      email,
      status: 'started',
      message: `开始读取邮件，共 ${list.length} 封`,
      total: list.length,
    });

    const cachedUids = getCachedPop3Uids(email);
    let fetchedCount = 0;
    let failedCount = 0;

    for (let i = 0; i < list.length; i++) {
      const [msgNum, uid] = list[i];
      const stringUid = String(uid || '').trim();

      if (!stringUid) {
        emailLogger.warn(`POP3 返回空 UIDL (${email}, msg=${msgNum})`);
        continue;
      }
      if (cachedUids.has(stringUid)) continue;

      try {
        const rawMessage = await withMailTimeout(
          pop3.RETR(msgNum),
          mailOperationTimeoutMs,
          closeSocket
        );
        const parsed = await simpleParser(rawMessage);

        const subject = parsed.subject || '(无主题)';
        const htmlContent = parsed.html || parsed.textAsHtml || parsed.text || '';
        const emailTime = parsed.date ? parsed.date.getTime() : Date.now();

        saveEmailToLocal(
          email,
          subject,
          htmlContent,
          emailTime,
          boxName,
          getPop3LocalUid(stringUid)
        );
        cachedUids.add(stringUid);
        // 每成功落盘一封就记录 UIDL，中途失败后不会重复下载已成功邮件。
        saveCachedPop3Uids(email, cachedUids);
        fetchedCount++;

        ipcEmitter.send('email-fetch-progress', {
          email,
          status: 'progress',
          message: `已读取 ${fetchedCount}/${list.length}`,
          current: fetchedCount,
          total: list.length,
        });
      } catch (msgErr) {
        failedCount++;
        emailLogger.error(`POP3 读取单封邮件失败 (${email}, msg=${msgNum}): ${msgErr.message}`);
      }
    }

    if (failedCount > 0) {
      throw new Error(`已读取 ${fetchedCount} 封邮件，${failedCount} 封未能读取，请重试`);
    }

    ipcEmitter.send('email-fetch-complete', {
      email,
      message: `读取完成，共 ${fetchedCount} 封新邮件`,
      count: fetchedCount,
    });

    return { success: true, count: fetchedCount };
  } catch (error) {
    emailLogger.error(`POP3 连接错误 (${email}): ${error.message}`);
    ipcEmitter.send('email-fetch-error', { email, message: error.message });
    throw error;
  } finally {
    if (pop3) {
      try {
        await withMailTimeout(pop3.QUIT(), 2000, () => pop3?._socket?.destroy());
      } catch (closeError) {
        emailLogger.warn(`关闭 POP3 连接失败 (${email}): ${closeError.message}`);
        if (pop3._socket && !pop3._socket.destroyed) {
          pop3._socket.destroy();
        }
      }
    }
  }
};

/**
 * 列出某邮箱的本地缓存邮件
 * 扫描邮件目录的 .data 文件，从 electron-store 读取对应 header
 * @param {string} email - 邮箱地址
 * @returns {Object[]} 邮件列表 [{subject, emailTime, boxName, uid, bodyPath}]
 */
export const listLocalEmailCache = email => {
  try {
    const filePath = resolveEmailDir(email);
    if (!fs.existsSync(filePath)) return [];

    const files = fs.readdirSync(filePath).filter(f => f.endsWith('.data'));

    return sortMailCacheFiles(files, filePath).map(({ fileName, emailTime, boxName, uid }) => {
      const bodyPath = path.join(filePath, fileName);

      // 从 electron-store 读取 header（主题）
      const headerKey = `emailHeaders.${email}_${fileName}`;
      const subject = store.get(headerKey) || '(无主题)';

      return {
        subject,
        emailTime,
        boxName,
        uid,
        bodyPath,
        fileName,
      };
    });
  } catch (error) {
    emailLogger.error(`列出本地邮件缓存失败 (${email}): ${error.message}`);
    return [];
  }
};

/**
 * 读取本地邮件正文
 * @param {string} filePath - 邮件正文文件路径
 * @returns {string} HTML 正文内容
 */
export const readLocalEmailBody = filePath => {
  try {
    // 仅允许读取邮件根目录内的文件，拒绝渲染进程传入的任意/越界路径
    const base = path.resolve(getEmailBasePath());
    if (typeof filePath !== 'string' || path.extname(filePath).toLowerCase() !== '.data') {
      return '<p>非法的邮件路径</p>';
    }
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(base + path.sep)) {
      emailLogger.warn('拒绝越界邮件路径');
      return '<p>非法的邮件路径</p>';
    }
    if (!fs.existsSync(resolved)) {
      return '<p>邮件文件不存在</p>';
    }
    const stat = fs.lstatSync(resolved);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      return '<p>非法的邮件文件</p>';
    }

    const realBase = fs.realpathSync(base);
    const realFile = fs.realpathSync(resolved);
    if (!realFile.startsWith(realBase + path.sep)) {
      emailLogger.warn('拒绝读取指向邮件目录外的文件');
      return '<p>非法的邮件路径</p>';
    }
    return fs.readFileSync(realFile, 'utf-8');
  } catch (error) {
    emailLogger.error(`读取邮件正文失败: ${error.message}`);
    return '<p>读取邮件失败</p>';
  }
};

/**
 * 扫描邮件判断实名认证状态
 * 与旧项目 updateEmailAuth 逻辑一致，5 种状态:
 *   0=未检测, 1=认证成功, 2=认证失败, 3=失败→成功, 4=成功→失败
 * @param {Object} data - { email }
 * @param {string} data.email - 邮箱地址
 * @returns {{ authState: number }}
 */
export const scanEmailAuthStatus = data => {
  const { email } = data;
  let authState = 0;

  try {
    const filePath = resolveEmailDir(email);
    if (!fs.existsSync(filePath)) {
      ensureDir(filePath);
      return { authState };
    }

    const stat = fs.statSync(filePath);
    if (!stat.isDirectory()) return { authState };

    const emailDir = fs.readdirSync(filePath).filter(f => f.endsWith('.data'));

    for (const emailFileName of emailDir) {
      // 读取 header（主题）从 electron-store
      const headerKey = `emailHeaders.${email}_${emailFileName}`;
      const emailItem = store.get(headerKey) || '';

      // 状态转换逻辑（与旧项目一致）
      if (authState === 0) {
        // 首次状态
        if (
          emailItem.indexOf('标准身份认证审核成功提醒') !== -1 ||
          emailItem.indexOf('Verification Successful') !== -1
        ) {
          authState = 1;
        } else if (
          emailItem.indexOf('标准身份认证审核失败提醒') !== -1 ||
          (emailItem.indexOf('Verification Successful') === -1 &&
            emailItem.indexOf('Verification') !== -1)
        ) {
          authState = 2;
        }
      } else if (authState === 2) {
        // 失败转成功
        if (
          emailItem.indexOf('标准身份认证审核成功提醒') !== -1 ||
          emailItem.indexOf('Verification Successful') !== -1
        ) {
          authState = 3;
        }
      } else if (authState === 1) {
        // 成功转失败
        if (
          emailItem.indexOf('标准身份认证审核失败提醒') !== -1 ||
          (emailItem.indexOf('Verification Successful') === -1 &&
            emailItem.indexOf('Verification') !== -1)
        ) {
          authState = 4;
        }
      }
    }

    return { authState };
  } catch (error) {
    emailLogger.error(`扫描邮件认证状态失败 (${email}): ${error.message}`);
    return { authState };
  }
};

/**
 * 从最近缓存的邮件中提取 6 位验证码。
 * 只返回验证码供界面展示，复制动作必须由用户显式触发。
 * @param {Object} data - { email, maxAgeMs? }
 * @param {string} data.email - 邮箱地址
 * @returns {{ success: boolean, code?: string, emailTime?: number, subject?: string, message?: string }}
 */
export const extractVerificationCode = data => {
  const { email } = data || {};
  const requestedMaxAge = Number(data?.maxAgeMs);
  const maxAgeMs = Number.isFinite(requestedMaxAge)
    ? Math.min(Math.max(requestedMaxAge, 60 * 1000), 24 * 60 * 60 * 1000)
    : 30 * 60 * 1000;

  try {
    const filePath = resolveEmailDir(email);
    if (!fs.existsSync(filePath)) {
      return { success: false, message: '没有缓存的邮件' };
    }

    const stat = fs.statSync(filePath);
    if (!stat.isDirectory()) {
      return { success: false, message: '没有缓存的邮件' };
    }

    const emailDir = fs.readdirSync(filePath).filter(f => f.endsWith('.data'));
    if (emailDir.length === 0) {
      return { success: false, message: '没有缓存的邮件' };
    }

    // 按时间戳降序排列（最新在前），并限制为近期邮件，降低误取历史验证码的概率。
    const oldestAllowedTime = Date.now() - maxAgeMs;
    for (const { fileName: item, emailTime } of sortMailCacheFiles(emailDir, filePath)) {
      if (!emailTime || emailTime < oldestAllowedTime) continue;

      const itemPath = path.join(filePath, item);
      const itemStat = fs.lstatSync(itemPath);
      if (!itemStat.isFile() || itemStat.isSymbolicLink()) continue;
      const emailData = fs.readFileSync(itemPath, 'utf-8');
      const headerKey = `emailHeaders.${email}_${item}`;
      const subject = String(store.get(headerKey) || '');
      const code = findVerificationCode(subject, emailData);
      if (code) {
        emailLogger.info('已从最近的本地邮件中提取验证码');
        return { success: true, code, emailTime, subject };
      }
    }

    return { success: false, message: '最近 30 分钟未找到验证码' };
  } catch (error) {
    emailLogger.error(`提取验证码失败 (${email}): ${error.message}`);
    return { success: false, message: error.message };
  }
};

/**
 * 解析 Excel 导入文件
 * 列映射与旧项目一致:
 *   col2=groupName, col3=email, col4=mailPassword, col5=bianPassword,
 *   col6=apiName, col7=apiKey, col8=apiSecret, col9=yongjin, col10=yongjinsj,
 *   col11=googleAuth, col12=backupEmail, col13=googleEmail
 * @returns {Promise<Object[]>} 解析后的数据数组
 */
export const parseExcelImportFile = async () => {
  try {
    // 文件路径只能来自主进程选择框，不接受渲染进程传入任意路径。
    const result = await dialog.showOpenDialog({
      title: '选择导入文件',
      filters: [{ name: 'Excel Files', extensions: ['xlsx'] }],
      properties: ['openFile'],
    });
    if (result.canceled || result.filePaths.length === 0) {
      throw new Error('用户取消');
    }
    const filePath = result.filePaths[0];
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 20 * 1024 * 1024) {
      throw new Error('请选择不超过 20MB 的有效 .xlsx 文件');
    }
    if (path.extname(filePath).toLowerCase() !== '.xlsx') {
      throw new Error('仅支持 .xlsx 文件');
    }

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filePath);

    const worksheet = workbook.getWorksheet(1);
    if (!worksheet) {
      throw new Error('Excel 文件中没有工作表');
    }
    if (worksheet.actualRowCount > 501) {
      throw new Error('单次最多导入 500 条账号数据');
    }

    const rows = [];

    worksheet.eachRow((row, rowNumber) => {
      // 跳过第一行表头
      if (rowNumber < 2) return;

      const cells = Array.from({ length: 12 }, (_, index) => row.getCell(index + 2).text || '');
      if (cells.every(value => !String(value).trim())) return;

      rows.push({
        uuid: crypto.randomUUID(),
        groupName: cells[0],
        email: cells[1],
        mailPassword: cells[2],
        bianPassword: cells[3],
        apiName: cells[4],
        apiKey: cells[5],
        apiSecret: cells[6],
        yongjin: cells[7] || '0',
        yongjinsj: cells[8] || '0',
        googleAuth: cells[9],
        backupEmail: cells[10],
        googleEmail: cells[11],
      });
    });

    emailLogger.info(`解析 Excel 成功: ${rows.length} 条记录`);
    return rows;
  } catch (error) {
    emailLogger.error(`解析 Excel 失败: ${error.message}`);
    throw error;
  }
};

/**
 * 导出 Excel 导入模板
 * 列与旧项目一致
 * @returns {Promise<{ success: boolean, filePath?: string, message?: string }>}
 */
export const exportImportTemplate = async () => {
  try {
    const { filePath } = await dialog.showSaveDialog({
      title: '下载账号导入模板',
      defaultPath: '账号导入模板.xlsx',
      filters: [{ name: 'Excel Files', extensions: ['xlsx'] }],
    });

    if (!filePath) {
      return { success: false, message: '用户取消' };
    }

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('账号导入');

    worksheet.columns = [
      { header: '序号', key: 'index', width: 10 },
      { header: '账号分组', key: 'groupName', width: 15 },
      { header: '邮箱地址', key: 'email', width: 30 },
      { header: '邮箱密码', key: 'mailPassword', width: 20 },
      { header: '账号密码', key: 'bianPassword', width: 20 },
      { header: '账号名称', key: 'apiName', width: 25 },
      { header: 'API Key', key: 'apiKey', width: 30 },
      { header: 'API Secret', key: 'apiSecret', width: 30 },
      { header: '佣金', key: 'yongjin', width: 10 },
      { header: '佣金时间', key: 'yongjinsj', width: 10 },
      { header: '谷歌验证密钥', key: 'googleAuth', width: 30 },
      { header: '备用邮箱', key: 'backupEmail', width: 25 },
      { header: 'Google邮箱', key: 'googleEmail', width: 25 },
    ];

    worksheet.views = [{ state: 'frozen', ySplit: 1 }];
    worksheet.getRow(1).font = { bold: true };

    const instructions = workbook.addWorksheet('填写说明');
    instructions.columns = [
      { header: '项目', key: 'item', width: 24 },
      { header: '说明', key: 'description', width: 72 },
    ];
    instructions.addRows([
      { item: '填写位置', description: '请从“账号导入”工作表第 2 行开始填写。' },
      { item: '必填字段', description: '邮箱地址、邮箱密码为必填项。' },
      { item: '账号名称', description: '可留空，导入后默认使用邮箱地址。' },
      {
        item: '密码内容',
        description: '邮箱密码与账号密码会按原样导入，不会自动移除首尾空格。',
      },
      { item: '导入上限', description: '单次最多导入 500 条账号数据。' },
      {
        item: '安全提示',
        description: '模板可能包含敏感凭据；使用后请妥善保管或安全删除。谷歌密钥会在本机加密保存。',
      },
    ]);
    instructions.views = [{ state: 'frozen', ySplit: 1 }];
    instructions.getRow(1).font = { bold: true };

    await workbook.xlsx.writeFile(filePath);

    emailLogger.info(`导出模板成功: ${filePath}`);
    return { success: true, filePath };
  } catch (error) {
    emailLogger.error(`导出模板失败: ${error.message}`);
    return { success: false, message: error.message };
  }
};

/**
 * 统一处理账号提交前的密钥协议：
 *   - apiSecret: 长度 < 100 则 RSA 加密
 *   - cloudRecoveryVersion>=1: googleAuth 发送 totp:v1 版本化 Base32，由后端 AES-GCM 保护
 *   - 旧后端: 保留 isGoAuthCloud + RSA 兼容路径
 *   - mailPassword/bianPassword 保持用户输入原样，不做 trim
 * @param {Object} emailData - 邮箱数据
 * @param {boolean|Object} isGoAuthCloud - 旧布尔开关或新协议能力对象
 * @returns {Object} 加密处理后的数据
 */
export const prepareEmailForImport = (emailData, isGoAuthCloud) => {
  try {
    const result = { ...emailData };

    // 仅规范非密码字段；密码可能有合法的首尾空格，必须保持原样。
    if (result.email) result.email = result.email.trim();
    if (result.apiName) result.apiName = (result.apiName + '').trim();
    if (result.apiKey) result.apiKey = result.apiKey.trim();
    if (result.googleEmail) result.googleEmail = result.googleEmail.trim();
    if (result.backupEmail) result.backupEmail = result.backupEmail.trim();
    if (result.localInviteCode) result.localInviteCode = result.localInviteCode.trim();
    if (result.localInviteCode2) result.localInviteCode2 = result.localInviteCode2.trim();
    if (result.highInviteCode) result.highInviteCode = result.highInviteCode.trim();
    if (result.yongjin) result.yongjin = result.yongjin + '';
    if (result.yongjinsj) result.yongjinsj = result.yongjinsj + '';
    if (result.groupName) result.groupName = (result.groupName + '').trim();

    // groupId 默认 0
    if (!result.groupId) result.groupId = 0;

    // 账号名称留空时默认使用邮箱地址。
    if (!result.apiName && result.email) {
      result.apiName = result.email;
    }

    // 加密 apiSecret（长度 < 100 视为明文，需要 RSA 加密）
    if (result.apiSecret && result.apiSecret.length < 100) {
      result.apiSecret = rsaEncrypt(result.apiSecret.trim());
    }

    const googleAuthOptions = normalizeGoogleAuthPreparationOptions(isGoAuthCloud);
    // 本地缓存由渲染进程在 API 成功后单独提交，本函数绝不提前改写本地状态。
    if (result.googleAuth) {
      if (!googleAuthOptions.cloudRecoveryCapabilityKnown) {
        throw new Error('无法确认服务端 Google Auth 恢复能力，已阻止仅保存到本机');
      }
      const rawAuthSecret = normalizeGoogleAuthSecret(result.googleAuth);
      if (googleAuthOptions.cloudRecoveryVersion >= 1) {
        result.googleAuth = buildGoogleAuthCloudValue(rawAuthSecret);
      } else if (googleAuthOptions.isGoAuthCloud) {
        result.googleAuth = rsaEncrypt(rawAuthSecret);
      } else {
        result.googleAuth = '';
      }
    }

    return result;
  } catch (error) {
    emailLogger.error(`准备导入数据失败: ${error.message}`);
    throw error;
  }
};
