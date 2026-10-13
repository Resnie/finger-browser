<template>
  <Main>
    <MainTablePane>
      <template #search>
        <el-tabs v-model="activeTab" @tab-change="handleTabChange" style="width: 100%">
          <el-tab-pane label="浏览器分组" name="browser" />
          <el-tab-pane label="账号分组" name="email" />
        </el-tabs>
      </template>

      <!-- 浏览器分组 -->
      <template v-if="activeTab === 'browser'">
        <div class="toolbar">
          <el-input
            v-model="browserSearchKeyword"
            placeholder="搜索关键字"
            style="width: 200px"
            size="small"
            clearable
            @keyup.enter="handleBrowserSearch"
          />
          <el-button size="small" :loading="browserLoading" @click="handleBrowserSearch">
            搜索
          </el-button>
          <el-button
            size="small"
            style="margin-left: 10px"
            type="primary"
            @click="showAddBrowserGroupDialog = true"
          >
            新建
          </el-button>
        </div>
        <el-table
          size="small"
          :data="browserGroups"
          v-loading="browserLoading"
          empty-text="暂无浏览器分组"
          style="width: 100%; margin-top: 10px"
        >
          <el-table-column type="index" width="50" label="序号" />
          <el-table-column prop="name" label="分组" />
          <el-table-column label="窗口数量">
            <template #default="scope">
              {{ scope.row.count }}
            </template>
          </el-table-column>
          <el-table-column label="操作" width="220">
            <template #default="scope">
              <el-button size="small" type="success" @click="editBrowserGroup(scope.row)">
                编辑
              </el-button>
              <el-button size="small" type="primary" @click="openBrowserGroupDetail(scope.row)">
                详情
              </el-button>
              <el-button
                size="small"
                type="danger"
                :loading="browserDeletingId === scope.row.id"
                :disabled="scope.row.name === '未分组' || scope.row.count > 0"
                :title="scope.row.count > 0 ? '请先将窗口移出该分组' : '删除分组'"
                @click="handleDeleteBrowserGroup(scope.row)"
              >
                删除
              </el-button>
            </template>
          </el-table-column>
        </el-table>
      </template>

      <!-- 账号分组 -->
      <template v-if="activeTab === 'email'">
        <div class="toolbar">
          <el-input
            v-model="emailSearchKeyword"
            placeholder="搜索关键字"
            style="width: 200px"
            size="small"
            clearable
            @keyup.enter="handleEmailSearch"
          />
          <el-button size="small" :loading="emailLoading" @click="handleEmailSearch">
            搜索
          </el-button>
          <el-button
            size="small"
            style="margin-left: 10px"
            type="primary"
            @click="showAddEmailGroupDialog = true"
          >
            新建
          </el-button>
        </div>
        <el-table
          size="small"
          :data="emailGroups"
          v-loading="emailLoading"
          empty-text="暂无账号分组"
          style="width: 100%; margin-top: 10px"
        >
          <el-table-column type="index" width="50" label="序号" />
          <el-table-column prop="name" label="分组" />
          <el-table-column label="账号数量">
            <template #default="scope">
              {{ scope.row.count }}
            </template>
          </el-table-column>
          <el-table-column label="操作" width="220">
            <template #default="scope">
              <el-button size="small" type="success" @click="editEmailGroup(scope.row)">
                编辑
              </el-button>
              <el-button size="small" type="primary" @click="openEmailGroupDetail(scope.row)">
                详情
              </el-button>
              <el-button
                size="small"
                type="danger"
                :loading="emailDeletingId === scope.row.id"
                :disabled="scope.row.name === '未分组'"
                @click="handleDeleteEmailGroup(scope.row)"
              >
                删除
              </el-button>
            </template>
          </el-table-column>
        </el-table>
      </template>

      <template #page>
        <PagePane
          v-if="activeTab === 'browser'"
          :total="browserTotal"
          :page="browserPage"
          :page-size="browserSize"
          @size-change="handleBrowserSizeChange"
          @current-change="handleBrowserCurrentChange"
        />
        <PagePane
          v-if="activeTab === 'email'"
          :total="emailTotal"
          :page="emailPage"
          :page-size="emailSize"
          @size-change="handleEmailSizeChange"
          @current-change="handleEmailCurrentChange"
        />
      </template>
    </MainTablePane>

    <!-- 浏览器分组：新建弹窗 -->
    <el-dialog
      title="新建浏览器分组"
      v-model="showAddBrowserGroupDialog"
      :destroy-on-close="true"
      width="420px"
    >
      <el-input
        v-model="newBrowserGroupName"
        maxlength="30"
        show-word-limit
        placeholder="请输入分组名称"
        @keyup.enter="confirmAddBrowserGroup"
      />
      <template #footer>
        <el-button @click="showAddBrowserGroupDialog = false">取消</el-button>
        <el-button type="primary" :loading="browserSaving" @click="confirmAddBrowserGroup"
          >创建</el-button
        >
      </template>
    </el-dialog>

    <!-- 浏览器分组：编辑弹窗 -->
    <el-dialog
      title="编辑浏览器分组"
      v-model="showEditBrowserGroupDialog"
      :destroy-on-close="true"
      width="420px"
    >
      <el-input
        v-model="editBrowserGroupName"
        maxlength="30"
        show-word-limit
        placeholder="分组名称"
      />
      <template #footer>
        <el-button @click="showEditBrowserGroupDialog = false">取消</el-button>
        <el-button type="primary" :loading="browserEditSaving" @click="confirmEditBrowserGroup"
          >保存</el-button
        >
      </template>
    </el-dialog>

    <!-- 账号分组：新建弹窗 -->
    <el-dialog
      title="新建账号分组"
      v-model="showAddEmailGroupDialog"
      :destroy-on-close="true"
      width="420px"
    >
      <el-input
        v-model="newEmailGroupName"
        maxlength="30"
        show-word-limit
        placeholder="分组名称"
        @keyup.enter="confirmAddEmailGroup"
      />
      <template #footer>
        <el-button @click="showAddEmailGroupDialog = false">取消</el-button>
        <el-button type="primary" :loading="emailSaving" @click="confirmAddEmailGroup"
          >创建</el-button
        >
      </template>
    </el-dialog>

    <!-- 账号分组：编辑弹窗 -->
    <el-dialog
      title="编辑账号分组"
      v-model="showEditEmailGroupDialog"
      :destroy-on-close="true"
      width="420px"
    >
      <el-input
        v-model="editEmailGroupName"
        maxlength="30"
        show-word-limit
        placeholder="分组名称"
      />
      <template #footer>
        <el-button @click="showEditEmailGroupDialog = false">取消</el-button>
        <el-button type="primary" :loading="emailEditSaving" @click="confirmEditEmailGroup"
          >保存</el-button
        >
      </template>
    </el-dialog>
  </Main>
</template>

<script setup>
  import { ref, onMounted } from 'vue';
  import { useRouter } from 'vue-router';
  import MainTablePane from '@/components/MainTablePane.vue';
  import Main from '@/views/home/Main.vue';
  import { createGroup, searchGroupDetail, updateGroup, deleteGroup } from '@/api/group';
  import {
    createEmailGroup,
    updateEmailGroupName,
    deleteEmailGroup,
    searchEmailGroupDetail,
  } from '@/api/email';
  import PagePane from '@/components/pagePane.vue';
  import { useMessage, useConfirm } from '@/composables/useGlobalProperties';

  const router = useRouter();
  const message = useMessage();
  const { confirm } = useConfirm();

  const activeTab = ref('browser');

  // ==================== 浏览器分组 ====================
  const browserTotal = ref(0);
  const browserGroups = ref([]);
  const browserSearchKeyword = ref('');
  const browserPage = ref(1);
  const browserSize = ref(20);
  const browserLoading = ref(false);
  const browserSaving = ref(false);
  const browserEditSaving = ref(false);
  const browserDeletingId = ref(null);
  const showAddBrowserGroupDialog = ref(false);
  const newBrowserGroupName = ref('');
  const showEditBrowserGroupDialog = ref(false);
  const editBrowserGroupName = ref('');
  const editBrowserGroupId = ref(null);
  const originalBrowserGroupName = ref('');

  let browserLoadSequence = 0;
  const loadBrowserGroups = async () => {
    const sequence = ++browserLoadSequence;
    browserLoading.value = true;
    try {
      const res = await searchGroupDetail({
        page: browserPage.value,
        size: browserSize.value,
        name: browserSearchKeyword.value,
      });
      const list = res.list || res;
      if (sequence === browserLoadSequence) {
        browserTotal.value = res.total ?? list.length;
        browserGroups.value = list;
      }
    } catch (err) {
      if (sequence === browserLoadSequence && !err?.isNotified) {
        message.error('加载浏览器分组失败');
      }
    } finally {
      if (sequence === browserLoadSequence) browserLoading.value = false;
    }
  };

  const handleBrowserSearch = () => {
    browserPage.value = 1;
    loadBrowserGroups();
  };

  const confirmAddBrowserGroup = async () => {
    const name = newBrowserGroupName.value.trim();
    if (!name) return message.warning('请输入分组名称');
    if (browserSaving.value) return;
    browserSaving.value = true;
    try {
      await createGroup({ name });
      message.success('浏览器分组已创建');
      newBrowserGroupName.value = '';
      showAddBrowserGroupDialog.value = false;
      handleBrowserSearch();
    } catch (error) {
      if (!error?.isNotified) message.error('创建浏览器分组失败');
    } finally {
      browserSaving.value = false;
    }
  };

  const editBrowserGroup = group => {
    showEditBrowserGroupDialog.value = true;
    editBrowserGroupName.value = group.name || '';
    originalBrowserGroupName.value = group.name || '';
    editBrowserGroupId.value = group.id;
  };

  const confirmEditBrowserGroup = async () => {
    const name = editBrowserGroupName.value.trim();
    if (!name) return message.warning('请输入分组名称');
    if (name === originalBrowserGroupName.value) {
      showEditBrowserGroupDialog.value = false;
      return;
    }
    if (browserEditSaving.value) return;
    browserEditSaving.value = true;
    try {
      await updateGroup({ id: editBrowserGroupId.value, name });
      message.success('分组更新成功');
      editBrowserGroupName.value = '';
      editBrowserGroupId.value = null;
      showEditBrowserGroupDialog.value = false;
      loadBrowserGroups();
    } catch (err) {
      if (!err?.isNotified) message.error('更新分组失败');
    } finally {
      browserEditSaving.value = false;
    }
  };

  const openBrowserGroupDetail = group => {
    const gid = group.id || group.group_id || group.groupId || 0;
    router.push({ path: '/', query: { group_id: gid } });
  };

  const handleDeleteBrowserGroup = async group => {
    const count = group.count || 0;
    if (count > 0) {
      message.warning(`该分组仍有 ${count} 个窗口，请先将它们移到其他分组`);
      return;
    }
    try {
      await confirm(`确定要删除空分组「${group.name}」吗？`);
      browserDeletingId.value = group.id;
      await deleteGroup({ id: group.id });
      message.success('浏览器分组已删除');
      if (browserGroups.value.length === 1 && browserPage.value > 1) browserPage.value -= 1;
      loadBrowserGroups();
    } catch (err) {
      if (err !== 'cancel' && err !== 'close' && !err?.isNotified) {
        message.error('删除浏览器分组失败');
      }
    } finally {
      browserDeletingId.value = null;
    }
  };

  const handleBrowserSizeChange = pageData => {
    browserSize.value = pageData.size;
    browserPage.value = 1;
    loadBrowserGroups();
  };

  const handleBrowserCurrentChange = pageData => {
    browserPage.value = pageData.page;
    loadBrowserGroups();
  };

  // ==================== 账号分组 ====================
  const emailGroups = ref([]);
  const emailTotal = ref(0);
  const emailSearchKeyword = ref('');
  const emailPage = ref(1);
  const emailSize = ref(20);
  const showAddEmailGroupDialog = ref(false);
  const showEditEmailGroupDialog = ref(false);
  const newEmailGroupName = ref('');
  const editEmailGroupName = ref('');
  const editEmailGroupId = ref(null);
  const emailLoading = ref(false);
  const emailSaving = ref(false);
  const emailEditSaving = ref(false);
  const emailDeletingId = ref(null);

  let emailLoadSequence = 0;
  const loadEmailGroups = async () => {
    const sequence = ++emailLoadSequence;
    emailLoading.value = true;
    try {
      const res = await searchEmailGroupDetail({
        page: emailPage.value,
        size: emailSize.value,
        name: emailSearchKeyword.value,
      });
      if (sequence === emailLoadSequence) {
        emailGroups.value = res.list || [];
        emailTotal.value = res.total || 0;
      }
    } catch (err) {
      if (sequence === emailLoadSequence && !err?.isNotified) {
        message.error('加载账号分组失败');
      }
    } finally {
      if (sequence === emailLoadSequence) emailLoading.value = false;
    }
  };

  const handleEmailSearch = () => {
    emailPage.value = 1;
    loadEmailGroups();
  };

  const handleEmailSizeChange = pageData => {
    emailSize.value = pageData.size;
    emailPage.value = 1;
    loadEmailGroups();
  };

  const handleEmailCurrentChange = pageData => {
    emailPage.value = pageData.page;
    loadEmailGroups();
  };

  const confirmAddEmailGroup = async () => {
    if (!newEmailGroupName.value.trim()) {
      message.warning('请输入分组名称');
      return;
    }
    if (emailSaving.value) return;
    emailSaving.value = true;
    try {
      await createEmailGroup({ name: newEmailGroupName.value.trim() });
      message.success('账号分组创建成功');
      newEmailGroupName.value = '';
      showAddEmailGroupDialog.value = false;
      loadEmailGroups();
    } catch (err) {
      if (!err?.isNotified) message.error('创建账号分组失败');
    } finally {
      emailSaving.value = false;
    }
  };

  const editEmailGroup = group => {
    showEditEmailGroupDialog.value = true;
    editEmailGroupName.value = group.name || '';
    editEmailGroupId.value = group.id;
  };

  const confirmEditEmailGroup = async () => {
    if (!editEmailGroupName.value.trim()) {
      message.warning('请输入分组名称');
      return;
    }
    if (emailEditSaving.value) return;
    emailEditSaving.value = true;
    try {
      await updateEmailGroupName({
        id: editEmailGroupId.value,
        name: editEmailGroupName.value.trim(),
      });
      message.success('账号分组更新成功');
      editEmailGroupName.value = '';
      editEmailGroupId.value = null;
      showEditEmailGroupDialog.value = false;
      loadEmailGroups();
    } catch (err) {
      if (!err?.isNotified) message.error('更新账号分组失败');
    } finally {
      emailEditSaving.value = false;
    }
  };

  const handleDeleteEmailGroup = async group => {
    try {
      await confirm(`确定要删除分组「${group.name}」吗？组内账号将取消分组关联，变为未分组。`);
      emailDeletingId.value = group.id;
      await deleteEmailGroup({ id: group.id, all: 0 });
      message.success('账号分组已删除');
      if (emailGroups.value.length === 1 && emailPage.value > 1) emailPage.value -= 1;
      loadEmailGroups();
    } catch (err) {
      if (err !== 'cancel' && err !== 'close' && !err?.isNotified) {
        message.error('删除账号分组失败');
      }
    } finally {
      emailDeletingId.value = null;
    }
  };

  const openEmailGroupDetail = group => {
    const gid = group.id || 0;
    router.push({ path: '/email', query: { group_id: gid } });
  };

  // ==================== Tab 切换 ====================
  const handleTabChange = tab => {
    if (tab === 'browser') {
      loadBrowserGroups();
    } else {
      loadEmailGroups();
    }
  };

  onMounted(() => {
    loadBrowserGroups();
  });
</script>

<style scoped>
  .toolbar {
    display: flex;
    align-items: center;
    margin-top: 10px;
  }
</style>
