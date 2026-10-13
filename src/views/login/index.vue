<template>
  <div class="login-container">
    <div class="bg-decoration"></div>

    <el-card class="login-card" shadow="never">
      <div class="login-header">
        <div class="brand-mark" aria-hidden="true">F</div>
        <h2 class="login-title">欢迎回来</h2>
        <p class="login-desc">登录 Finger Browser 管理你的浏览器环境</p>
      </div>

      <el-form
        ref="loginFormRef"
        :model="loginForm"
        :rules="loginRules"
        class="login-form"
        label-position="left"
        @submit.prevent="handleLogin"
      >
        <el-form-item prop="username">
          <el-input
            v-model="loginForm.username"
            placeholder="请输入用户名"
            prefix-icon="User"
            autocomplete="username"
            :disabled="isLoading"
          ></el-input>
        </el-form-item>

        <el-form-item prop="password">
          <el-input
            v-model="loginForm.password"
            type="password"
            placeholder="请输入密码"
            prefix-icon="Lock"
            autocomplete="current-password"
            show-password
            :disabled="isLoading"
          ></el-input>
        </el-form-item>
        <div class="form-actions">
          <el-checkbox
            v-model="isRemembered"
            class="remember-checkbox"
            :disabled="isLoading || preferencePending"
            @change="handleRememberChange"
          >
            记住账号和密码
          </el-checkbox>
          <span class="security-tip">系统加密保存在本机</span>
        </div>

        <el-form-item>
          <el-button
            type="primary"
            native-type="submit"
            class="login-btn"
            :loading="isLoading"
            :disabled="isLoading || preferencePending"
          >
            登录
          </el-button>
        </el-form-item>
      </el-form>
    </el-card>
  </div>
</template>

<script setup>
  import { ref, reactive, onMounted, watch } from 'vue';
  import { ElMessage } from '@/utils/message';
  import { login } from '@/api/user';
  import { useRoute, useRouter } from 'vue-router';
  import md5 from 'md5';
  import { useUserStore } from '@/store';

  // 登录表单数据
  const loginForm = reactive({
    username: '',
    password: '',
  });

  // 表单验证规则
  const loginRules = {
    username: [
      { required: true, message: '请输入用户名', trigger: 'blur' },
      { min: 3, max: 100, message: '用户名长度在 3 到 100 个字符', trigger: 'blur' },
    ],
    password: [
      { required: true, message: '请输入密码', trigger: 'blur' },
      { min: 6, max: 50, message: '密码长度在 6 到 50 个字符', trigger: 'blur' },
    ],
  };

  // 表单引用
  const loginFormRef = ref(null);

  // 状态变量
  const isLoading = ref(false);
  const isRemembered = ref(false);
  const preferencePending = ref(false);
  const credentialScheme = ref('plain');
  let isRestoringCredentials = false;
  let formRevision = 0;
  const userStore = useUserStore();
  const router = useRouter();
  const route = useRoute();

  // MD5 摘要仅能在加密回填后原样使用；任一字段被编辑后都按原始密码处理。
  watch(
    [() => loginForm.username, () => loginForm.password],
    () => {
      if (isRestoringCredentials) return;

      formRevision += 1;
      if (credentialScheme.value === 'md5') {
        credentialScheme.value = 'plain';
      }
    },
    { flush: 'sync' }
  );

  const clearSavedLoginCredentials = async () => {
    const clearCredentials = window.ipcRenderer?.clearLoginCredentials;
    if (typeof clearCredentials !== 'function') {
      throw new Error('登录凭据安全存储不可用');
    }
    await clearCredentials();
  };

  const handleRememberChange = async checked => {
    if (checked) return;

    preferencePending.value = true;
    try {
      await clearSavedLoginCredentials();
    } catch {
      isRemembered.value = true;
      ElMessage.warning('清除本地账号密码失败，请重试');
    } finally {
      preferencePending.value = false;
    }
  };

  const persistLoginPreference = async (username, password, scheme) => {
    try {
      if (isRemembered.value) {
        const saveCredentials = window.ipcRenderer?.saveLoginCredentials;
        if (typeof saveCredentials !== 'function') {
          throw new Error('登录凭据安全存储不可用');
        }
        await saveCredentials(username, password, scheme);
      } else {
        await clearSavedLoginCredentials();
      }
    } catch {
      ElMessage.warning('账号密码未能安全保存，但不影响本次登录');
    }
  };

  // 处理登录
  const handleLogin = async () => {
    if (isLoading.value || preferencePending.value) return;
    isLoading.value = true;

    try {
      const valid = await loginFormRef.value.validate().catch(() => false);
      if (!valid) return;

      const username = loginForm.username.trim();
      const password = loginForm.password;
      const scheme =
        credentialScheme.value === 'md5' && /^[a-f0-9]{32}$/i.test(password) ? 'md5' : 'plain';
      const res = await login({
        username,
        password: scheme === 'md5' ? password.toLowerCase() : md5(password),
      });

      if (res?.token) {
        userStore.login(res.token, res.user);
        await persistLoginPreference(username, password, scheme);

        ElMessage.success('登录成功');
        const redirect =
          typeof route.query.redirect === 'string' && route.query.redirect.startsWith('/')
            ? route.query.redirect
            : '/';
        await router.replace(redirect);
      } else {
        ElMessage.error('登录失败，服务端未返回有效会话');
      }
    } catch (error) {
      if (!error?.isNotified) {
        ElMessage.error(error?.message || '登录失败，请检查账号或密码');
      }
    } finally {
      isLoading.value = false;
    }
  };

  // 页面加载时初始化
  onMounted(async () => {
    // 旧版本仅将用户名用于当前页面的一次性回填，不迁移可重放的 MD5 摘要。
    const legacyUsername = localStorage.getItem('rememberedUsername');
    localStorage.removeItem('rememberedUser');
    localStorage.removeItem('rememberedUsername');
    const revisionBeforeLoad = formRevision;

    try {
      const getCredentials = window.ipcRenderer?.getSavedLoginCredentials;
      if (typeof getCredentials !== 'function') {
        throw new Error('登录凭据安全存储不可用');
      }

      const credentials = await getCredentials();
      if (formRevision === revisionBeforeLoad && credentials?.username && credentials?.password) {
        isRestoringCredentials = true;
        try {
          credentialScheme.value = credentials.scheme === 'md5' ? 'md5' : 'plain';
          loginForm.username = credentials.username;
          loginForm.password = credentials.password;
          isRemembered.value = true;
        } finally {
          isRestoringCredentials = false;
        }
        return;
      }
    } catch {
      ElMessage.warning('无法读取已保存的账号密码，请重新输入');
    }

    if (formRevision === revisionBeforeLoad && legacyUsername && !loginForm.username) {
      loginForm.username = legacyUsername;
    }
  });
</script>

<style scoped>
  .login-container {
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: center;
    background: #f4f7fb;
    position: relative;
    overflow: hidden;
  }

  /* 背景装饰 */
  .bg-decoration {
    position: absolute;
    width: 100%;
    height: 100%;
    background-image:
      radial-gradient(circle at 18% 24%, rgba(37, 99, 235, 0.12) 0%, transparent 34%),
      radial-gradient(circle at 82% 72%, rgba(14, 165, 233, 0.1) 0%, transparent 36%);
    z-index: 0;
  }

  /* 登录卡片样式 */
  .login-card {
    width: 100%;
    max-width: 420px;
    border: 1px solid rgba(226, 232, 240, 0.9);
    border-radius: 18px;
    box-shadow: 0 24px 70px rgba(30, 64, 175, 0.12);
    overflow: hidden;
    position: relative;
    z-index: 1;
    animation: login-card-in 0.45s cubic-bezier(0.16, 1, 0.3, 1) both;
  }

  /* 登录头部 */
  .login-header {
    text-align: center;
    padding: 34px 0 22px;
  }

  .brand-mark {
    display: grid;
    width: 48px;
    height: 48px;
    margin: 0 auto 18px;
    place-items: center;
    border-radius: 14px;
    color: #fff;
    font-size: 24px;
    font-weight: 700;
    background: linear-gradient(135deg, #2563eb, #0ea5e9);
    box-shadow: 0 10px 24px rgba(37, 99, 235, 0.24);
  }

  .login-title {
    margin: 0 0 10px;
    font-size: 24px;
    font-weight: 600;
    color: #172033;
  }

  .login-desc {
    margin: 0;
    color: #667085;
    font-size: 14px;
  }

  /* 表单样式 */
  .login-form {
    padding: 0 30px 20px;
  }

  .el-form-item {
    margin-bottom: 20px;
  }

  .el-input {
    height: 48px;
    border-radius: 8px;
    transition: all 0.3s ease;
  }

  .el-input:focus-within {
    box-shadow: 0 0 0 2px rgba(64, 158, 255, 0.2);
  }

  /* 验证码容器 */
  .code-container {
    display: flex;
    gap: 10px;
  }

  .code-image {
    width: 120px;
    height: 48px;
    border-radius: 8px;
    overflow: hidden;
    cursor: pointer;
    background-color: #f5f7fa;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .code-img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    transition: transform 0.3s ease;
  }

  .code-image:hover .code-img {
    transform: scale(1.05);
  }

  /* 表单操作区 */
  .form-actions {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 20px;
  }

  .remember-checkbox {
    color: #4e5969;
    font-size: 14px;
  }

  .security-tip {
    color: #98a2b3;
    font-size: 12px;
  }

  /* 登录按钮 */
  .login-btn {
    width: 100%;
    height: 48px;
    font-size: 16px;
    border-radius: 8px;
    transition: all 0.3s ease;
  }

  .login-btn:hover {
    transform: translateY(-2px);
    box-shadow: 0 4px 12px rgba(64, 158, 255, 0.3);
  }

  @keyframes login-card-in {
    from {
      opacity: 0;
      transform: translateY(16px) scale(0.99);
    }
    to {
      opacity: 1;
      transform: translateY(0) scale(1);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .login-card {
      animation: none;
    }
  }

  /* 其他登录方式 */
  .other-login {
    margin-top: 30px;
    text-align: center;
  }

  .other-login-text {
    color: #86909c;
    font-size: 14px;
    margin-bottom: 15px;
    position: relative;
  }

  .other-login-text::before,
  .other-login-text::after {
    content: '';
    position: absolute;
    top: 50%;
    width: 30%;
    height: 1px;
    background-color: #e5e6eb;
  }

  .other-login-text::before {
    left: 0;
  }

  .other-login-text::after {
    right: 0;
  }

  .social-buttons {
    display: flex;
    justify-content: center;
    gap: 15px;
  }

  .social-btn {
    width: 40px;
    height: 40px;
    border-radius: 50%;
    transition: all 0.3s ease;
  }

  .social-btn:hover {
    transform: translateY(-3px) scale(1.05);
  }

  .wechat-btn {
    background-color: #07c160;
    border-color: #07c160;
  }

  .alipay-btn {
    background-color: #1677ff;
    border-color: #1677ff;
  }

  .twitter-btn {
    background-color: #1da1f2;
    border-color: #1da1f2;
  }

  /* 页脚 */
  .login-footer {
    margin-top: 30px;
    color: #86909c;
    font-size: 12px;
    text-align: center;
    position: relative;
    z-index: 1;
  }

  /* 响应式调整 */
  @media (max-width: 768px) {
    .login-card {
      max-width: 100%;
      box-shadow: 0 5px 15px rgba(0, 0, 0, 0.05);
    }

    .login-header {
      padding: 25px 0 15px;
    }

    .login-title {
      font-size: 22px;
    }

    .other-login-text::before,
    .other-login-text::after {
      width: 25%;
    }
  }
</style>
