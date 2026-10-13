/**
 * 格式化下载速度（字节/秒 → 可读字符串）
 * @param {number} bytesPerSecond - 每秒字节数
 * @returns {string} 格式化后的速度字符串
 */
export const formatSpeed = bytesPerSecond => {
  if (!bytesPerSecond || bytesPerSecond <= 0) return '';
  const mbps = bytesPerSecond / (1024 * 1024);
  if (mbps >= 1) return `${mbps.toFixed(1)} MB/s`;
  return `${(bytesPerSecond / 1024).toFixed(0)} KB/s`;
};
