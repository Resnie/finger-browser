<template>
  <div class="browser-kernel-manager">
    <!-- 总占用空间显示 -->
    <el-card class="total-storage-card">
      <div class="total-storage-info">
        <span class="info-label">总占用空间:</span>
        <span class="info-value">{{ totalSizeFormatted }}</span>
        <el-button type="primary" size="small" @click="showVersionDialog">添加内核</el-button>
      </div>
    </el-card>

    <!-- 本地版本管理区域 (优先展示) -->
    <el-card class="local-versions-card">
      <template #header>
        <div class="card-header">
          <span>已下载内核版本</span>
          <el-button type="primary" size="small" @click="refreshLocalVersions">刷新列表</el-button>
        </div>
      </template>

      <el-table
        v-loading="localLoading"
        size="small"
        :data="localVersionsWithDownloading"
        empty-text="暂无已下载内核，点击“添加内核”开始"
        style="width: 100%"
        fit
      >
        <el-table-column prop="version" label="版本号" />
        <el-table-column prop="size" label="占用空间">
          <template #default="scope">
            {{ scope.row.isDownloading ? '--' : formatSize(scope.row) }}
          </template>
        </el-table-column>
        <el-table-column prop="count" label="依赖窗口数量">
          <template #default="scope">
            {{ scope.row.isDownloading ? '--' : scope.row.count }}
          </template>
        </el-table-column>
        <el-table-column label="下载进度" width="280">
          <template #default="scope">
            <div v-if="isKernelDownloading(scope.row.version)" class="download-status">
              <el-progress
                style="flex: 1; min-width: 120px"
                :text-inside="true"
                :stroke-width="18"
                :percentage="getKernelDownloadProgress(scope.row.version)"
                :format="p => `${p}%`"
              />
              <span v-if="getKernelDownloadSpeed(scope.row.version)" class="download-speed">{{
                formatSpeed(getKernelDownloadSpeed(scope.row.version))
              }}</span>
            </div>
            <span v-else class="no-download">--</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" fixed="right">
          <template #default="scope">
            <template v-if="isKernelDownloading(scope.row.version)">
              <el-button
                type="warning"
                size="small"
                @click="cancelKernelDownload(scope.row.version)"
              >
                取消下载
              </el-button>
            </template>
            <el-button
              v-else
              type="danger"
              size="small"
              @click="deleteKernel(scope.row.version)"
              :disabled="scope.row.count > 0 || isDeleting.includes(scope.row.version)"
              :title="scope.row.count > 0 ? `仍有 ${scope.row.count} 个窗口依赖此内核` : '删除内核'"
            >
              {{
                isDeleting.includes(scope.row.version)
                  ? '删除中'
                  : scope.row.count > 0
                    ? '使用中'
                    : '删除'
              }}
            </el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <!-- 可用内核版本弹出层 -->
    <el-dialog
      v-model="showVersionDialogVisible"
      title="可用内核版本"
      width="min(800px, calc(100vw - 48px))"
    >
      <div class="version-dialog-content">
        <div class="search-refresh-container">
          <el-input
            v-model="searchKeyword"
            placeholder="搜索版本号"
            style="width: 200px; margin-right: 10px"
            clearable
            @input="searchVersions"
          />
          <el-button :loading="onlineLoading" size="small" @click="refreshOnlineVersions"
            >刷新版本</el-button
          >
        </div>

        <div v-if="totalOnlineVersions > 0" class="pagination-info">
          共 {{ totalOnlineVersions }} 个版本
        </div>

        <el-table
          v-loading="onlineLoading"
          :data="getCurrentPageVersions"
          empty-text="暂无可用内核版本"
          style="width: 100%"
          fit
        >
          <el-table-column prop="version" label="版本号" />
          <el-table-column label="状态">
            <template #default="scope">
              <el-tag v-if="isLocalVersion(scope.row.version)" type="success">已下载</el-tag>
              <span v-else>可下载</span>
            </template>
          </el-table-column>
          <el-table-column label="操作" fixed="right">
            <template #default="scope">
              <template v-if="isKernelDownloading(scope.row.version)">
                <div class="download-status">
                  <el-progress
                    style="flex: 1; min-width: 100px"
                    :text-inside="true"
                    :stroke-width="18"
                    :percentage="getKernelDownloadProgress(scope.row.version)"
                    :format="p => `${p}%`"
                  />
                  <span v-if="getKernelDownloadSpeed(scope.row.version)" class="download-speed">{{
                    formatSpeed(getKernelDownloadSpeed(scope.row.version))
                  }}</span>
                  <el-button
                    type="warning"
                    size="small"
                    @click="cancelKernelDownload(scope.row.version)"
                  >
                    取消
                  </el-button>
                </div>
              </template>
              <el-button
                v-else
                type="primary"
                size="small"
                @click="downloadKernel(scope.row.version)"
                :disabled="isLocalVersion(scope.row.version)"
              >
                下载
              </el-button>
            </template>
          </el-table-column>
        </el-table>

        <div v-if="totalOnlineVersions > pageSize" class="pagination-container">
          <el-pagination
            v-model:current-page="currentPage"
            v-model:page-size="pageSize"
            :page-sizes="[10, 20, 50, 100]"
            layout="total, sizes, prev, pager, next, jumper"
            :total="totalOnlineVersions"
            @size-change="handleSizeChange"
            @current-change="handleCurrentChange"
          />
        </div>
      </div>
    </el-dialog>
  </div>
</template>

<script setup>
  import { ref, onMounted, computed } from 'vue';
  import { useBrowserVersionStore, useUserStore } from '@/store';
  import { ElMessageBox } from 'element-plus';
import { ElMessage } from '@/utils/message';
  import { getEngineCount } from '@/api/browser';
  import { formatSpeed } from '@/utils/format';

  // Store
  const browserVersionStore = useBrowserVersionStore();
  const userStore = useUserStore();

  // 状态
  const onlineVersions = ref([]);
  const filteredOnlineVersions = ref([]);
  const localVersions = ref([]);
  const totalSize = ref(0);
  const totalSizeFormatted = ref('0 MB');
  const isDeleting = ref([]);
  const showVersionDialogVisible = ref(false);
  // 分页相关状态
  const currentPage = ref(1);
  const pageSize = ref(10);
  const searchKeyword = ref('');
  const totalOnlineVersions = ref(0);
  const localLoading = ref(false);
  const onlineLoading = ref(false);

  // 从统一 store 读取内核下载状态
  const isKernelDownloading = version => {
    const dl = userStore.versionDownloads[version];
    return dl && dl.isDownloading;
  };
  const getKernelDownloadProgress = version => {
    const dl = userStore.versionDownloads[version];
    return (dl && dl.progress) || 0;
  };
  const getKernelDownloadSpeed = version => {
    const dl = userStore.versionDownloads[version];
    return (dl && dl.speed) || 0;
  };

  // 将正在下载但尚未出现在本地列表中的版本合并显示
  const localVersionsWithDownloading = computed(() => {
    const localSet = new Set(localVersions.value.map(v => v.version));
    const downloadingRows = [];
    for (const [version, dl] of Object.entries(userStore.versionDownloads)) {
      if (dl.isDownloading && !localSet.has(version)) {
        downloadingRows.push({ version, size: 0, count: 0, isDownloading: true });
      }
    }
    return [...downloadingRows, ...localVersions.value];
  });

  // 计算属性 - 格式化大小
  const formatSize = row => {
    const size = row.size;
    if (size >= 1024 * 1024 * 1024) {
      return (size / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
    } else if (size >= 1024 * 1024) {
      return (size / (1024 * 1024)).toFixed(2) + ' MB';
    } else if (size >= 1024) {
      return (size / 1024).toFixed(2) + ' KB';
    }
    return size + ' B';
  };

  // 检查版本是否在本地存在
  const isLocalVersion = version => {
    return localVersions.value.some(item => item.version === version);
  };

  // 刷新在线版本
  const refreshOnlineVersions = async () => {
    onlineLoading.value = true;
    try {
      const versions = await window.ipcRenderer.getAllBrowserVersions();
      onlineVersions.value = (versions || []).map(version => ({ version }));
      searchVersions(); // 触发搜索过滤
    } catch (error) {
      ElMessage.error('刷新在线版本失败');
    } finally {
      onlineLoading.value = false;
    }
  };

  // 搜索版本
  const searchVersions = () => {
    if (!searchKeyword.value.trim()) {
      filteredOnlineVersions.value = [...onlineVersions.value];
    } else {
      filteredOnlineVersions.value = onlineVersions.value.filter(item =>
        item.version.includes(searchKeyword.value.trim())
      );
    }
    totalOnlineVersions.value = filteredOnlineVersions.value.length;
    currentPage.value = 1; // 重置到第一页
  };

  // 获取当前页的版本
  const getCurrentPageVersions = computed(() => {
    const startIndex = (currentPage.value - 1) * pageSize.value;
    const endIndex = startIndex + pageSize.value;
    return filteredOnlineVersions.value.slice(startIndex, endIndex);
  });

  // 处理分页变化
  const handleSizeChange = val => {
    pageSize.value = val;
    currentPage.value = 1;
  };

  const handleCurrentChange = val => {
    currentPage.value = val;
  };

  // 刷新本地版本
  const refreshLocalVersions = async () => {
    localLoading.value = true;
    let engineCountDict = {};
    try {
      try {
        engineCountDict = (await getEngineCount()) || {};
      } catch {
        // 统计服务暂时不可用时，仍展示本地内核列表。
      }
      const result = await window.ipcRenderer.getLocalBrowserVersions();
      localVersions.value = [];
      totalSize.value = 0;
      result.forEach(v => {
        localVersions.value.push({
          version: v.version,
          size: v.size,
          count: engineCountDict[v.version] || 0,
        });
        totalSize.value += v.size;
      });
      totalSizeFormatted.value = formatSize({ size: totalSize.value });
    } catch (error) {
      ElMessage.error('刷新本地版本失败');
    } finally {
      localLoading.value = false;
    }
  };

  // 下载内核
  const downloadKernel = async version => {
    // 初始化统一 store 下载状态
    userStore.initVersionDownload(version);

    try {
      // 开始下载
      const result = await window.ipcRenderer.downloadBrowserVersion(version);

      // 如果是取消导致的返回，不显示成功消息
      if (result && result.cancelled) return;

      // 下载完成后刷新本地版本列表
      await refreshLocalVersions();
      ElMessage.success(`版本 ${version} 下载完成`);
    } catch (error) {
      ElMessage.error(error, '内核下载失败，请稍后重试');
    } finally {
      userStore.clearVersionDownload(version);
    }
  };

  // 取消内核下载
  const cancelKernelDownload = async version => {
    try {
      await ElMessageBox.confirm(
        `确定要取消下载浏览器内核版本 ${version} 吗？这会影响所有等待该版本的浏览器实例。`,
        '取消下载',
        {
          confirmButtonText: '确定',
          cancelButtonText: '继续下载',
          type: 'warning',
        }
      );

      await window.ipcRenderer.cancelBrowserDownload(version);
      userStore.clearVersionDownload(version);
      ElMessage.info(`版本 ${version} 下载已取消`);
    } catch {
      // 用户点击"继续下载"，不做处理
    }
  };

  // 删除内核
  const deleteKernel = async version => {
    const row = localVersions.value.find(item => item.version === version);
    if (row?.count > 0) {
      ElMessage.warning(`仍有 ${row.count} 个窗口依赖此内核，无法删除`);
      return;
    }
    try {
      await ElMessageBox.confirm(
        `确定要删除浏览器内核版本 ${version} 吗？此操作不可恢复。`,
        '确认删除',
        {
          confirmButtonText: '删除',
          cancelButtonText: '取消',
          type: 'warning',
        }
      );
      isDeleting.value.push(version);
      await window.ipcRenderer.deleteBrowserVersion(version);
      await refreshLocalVersions();
      ElMessage.success(`版本 ${version} 已删除`);
    } catch (error) {
      if (error !== 'cancel' && error !== 'close') {
        ElMessage.error(error, '内核删除失败，请稍后重试');
      }
    } finally {
      isDeleting.value = isDeleting.value.filter(v => v !== version);
    }
  };

  // 显示版本选择对话框
  const showVersionDialog = async () => {
    showVersionDialogVisible.value = true;
    await refreshOnlineVersions();
  };

  // 组件挂载时初始化数据
  onMounted(() => {
    // 只初始化本地版本数据，在线版本数据在打开对话框时再获取
    refreshLocalVersions();
  });
</script>

<style scoped>
  .browser-kernel-manager {
    padding: 20px;
    height: 100%;
    display: flex;
    flex-direction: column;
  }

  .browser-kernel-manager h2 {
    margin-bottom: 20px;
    font-size: 20px;
    font-weight: 600;
  }

  .total-storage-card {
    margin-bottom: 20px;
  }

  .total-storage-info {
    display: flex;
    align-items: center;
    gap: 20px;
    flex-wrap: wrap;
  }

  .info-label {
    font-weight: 500;
  }

  .info-value {
    font-size: 18px;
    font-weight: 600;
    color: #1890ff;
  }

  .card-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    flex-wrap: wrap;
    gap: 10px;
  }

  .search-refresh-container {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .online-versions-card,
  .local-versions-card {
    margin-bottom: 20px;
    flex: 1;
    display: flex;
    flex-direction: column;
  }

  .pagination-info {
    margin-bottom: 10px;
    color: #666;
    font-size: 14px;
  }

  .pagination-container {
    margin-top: 15px;
    display: flex;
    justify-content: flex-end;
  }

  .download-progress-container {
    text-align: center;
    padding: 20px;
  }

  .download-progress-container p {
    margin-bottom: 10px;
  }

  /* 优化表格占满宽度的样式 */
  .el-table {
    width: 100% !important;
  }

  .el-table__body-wrapper {
    flex: 1;
  }

  /* 版本对话框内容样式 */
  .version-dialog-content {
    display: flex;
    flex-direction: column;
    height: 500px;
    padding: 10px 0;
  }

  .download-status {
    display: inline-flex;
    align-items: center;
    gap: 8px;
  }

  .download-speed {
    font-size: 12px;
    color: #909399;
    white-space: nowrap;
  }

  .no-download {
    color: #c0c4cc;
  }

  .version-dialog-content .search-refresh-container {
    margin-bottom: 15px;
  }

  .version-dialog-content .el-table {
    flex: 1;
    margin-bottom: 10px;
  }

  .version-dialog-content .pagination-container {
    margin-top: auto;
  }
</style>
