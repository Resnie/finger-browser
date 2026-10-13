import fs from 'fs';
import path from 'path';
import { getLogsPath, ensureDir } from './config.js';

/**
 * 日志级别枚举
 */
const LogLevel = {
  DEBUG: 'DEBUG',
  INFO: 'INFO',
  WARN: 'WARN',
  ERROR: 'ERROR',
};

/**
 * 统一日志管理类
 * 提供一致的日志输出接口，支持文件日志和控制台输出
 */
class Logger {
  constructor(options = {}) {
    this.enableConsole = options.enableConsole ?? true;
    this.enableFile = options.enableFile ?? true;
    this.logDir = null;
    this.logStream = null;
    this.logStreamDate = '';
  }

  /**
   * 获取日志目录路径
   */
  getLogDir() {
    if (!this.logDir) {
      // 使用配置模块获取日志路径
      this.logDir = getLogsPath();
      ensureDir(this.logDir);
      this.cleanupOldLogs();
    }
    return this.logDir;
  }

  cleanupOldLogs(retentionDays = 14) {
    try {
      const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
      for (const fileName of fs.readdirSync(this.logDir)) {
        if (!/^\d{4}-\d{2}-\d{2}\.log$/.test(fileName)) continue;
        const filePath = path.join(this.logDir, fileName);
        if (fs.statSync(filePath).mtimeMs < cutoff) fs.unlinkSync(filePath);
      }
    } catch (error) {
      console.warn('清理旧日志失败:', error.message);
    }
  }

  getLogStream() {
    const date = new Date().toISOString().split('T')[0];
    if (this.logStream && this.logStreamDate === date) return this.logStream;

    this.logStream?.end();
    this.logStreamDate = date;
    const logPath = path.join(this.getLogDir(), `${date}.log`);
    if (process.platform !== 'win32' && fs.existsSync(logPath)) {
      fs.chmodSync(logPath, 0o600);
    }
    this.logStream = fs.createWriteStream(logPath, {
      flags: 'a',
      encoding: 'utf8',
      mode: 0o600,
    });
    this.logStream.on('error', error => {
      console.error('写入日志文件失败:', error.message);
    });
    return this.logStream;
  }

  /**
   * 格式化日志消息
   */
  formatMessage(level, message, context = '') {
    const timestamp = new Date().toISOString();
    const contextStr = context ? `[${context}] ` : '';
    return `[${timestamp}] [${level}] ${contextStr}${message}`;
  }

  /**
   * 写入日志
   */
  write(level, message, context = '') {
    const formattedMessage = this.formatMessage(level, message, context);

    // 控制台输出
    if (this.enableConsole) {
      switch (level) {
        case LogLevel.ERROR:
          console.error(formattedMessage);
          break;
        case LogLevel.WARN:
          console.warn(formattedMessage);
          break;
        case LogLevel.DEBUG:
          console.debug(formattedMessage);
          break;
        default:
          console.log(formattedMessage);
      }
    }

    // 文件输出
    if (this.enableFile) {
      try {
        this.getLogStream().write(formattedMessage + '\n');
      } catch (error) {
        console.error('写入日志文件失败:', error.message);
      }
    }
  }

  /**
   * 调试级别日志
   */
  debug(message, context = '') {
    this.write(LogLevel.DEBUG, message, context);
  }

  /**
   * 信息级别日志
   */
  info(message, context = '') {
    this.write(LogLevel.INFO, message, context);
  }

  /**
   * 警告级别日志
   */
  warn(message, context = '') {
    this.write(LogLevel.WARN, message, context);
  }

  /**
   * 错误级别日志
   */
  error(message, context = '') {
    this.write(LogLevel.ERROR, message, context);
  }

  /**
   * 创建带上下文的子日志器
   */
  createContextLogger(context) {
    const parent = this;
    return {
      debug: message => parent.debug(message, context),
      info: message => parent.info(message, context),
      warn: message => parent.warn(message, context),
      error: message => parent.error(message, context),
    };
  }
}

// 导出单例实例
export const logger = new Logger();

// 导出类以便创建自定义实例
export { Logger, LogLevel };

// 兼容旧的 log 函数
export const log = (message, type = 'info') => {
  logger[type.toLowerCase()]?.(message) ?? logger.info(message);
};
