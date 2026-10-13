<template>
  <el-form
    size="small"
    ref="instanceForm"
    :model="newInstanceConfig"
    :rules="formRules"
    label-width="120px"
    class="instance-form"
  >
    <BillingCreationStatus
      v-if="props.mode !== 'edit'"
      resource="browser"
      @state-change="handleBillingStateChange"
    />
    <el-form-item label="自动指纹">
      <el-switch
        v-model="newInstanceConfig.finger.autoFingerprint"
        active-text="开启"
        inactive-text="关闭"
      />
      <div class="field-help">
        开启后按窗口生成稳定的 Canvas、音频和布局指纹；不同窗口使用不同指纹。
      </div>
    </el-form-item>
    <!-- 基本设置 -->
    <div class="form-section-title">基本信息</div>
    <el-form-item label="名称" prop="base.name">
      <el-input
        v-model="newInstanceConfig.base.name"
        maxlength="50"
        show-word-limit
        placeholder="例如：主账号 - 新加坡"
      ></el-input>
    </el-form-item>

    <el-form-item label="关联账号">
      <SelectAccount v-model="linkedAccountUuid" :initial-account="initialLinkedAccount" />
      <div class="field-help">可选，关联后可在浏览器列表快速读取邮箱或谷歌验证码。</div>
    </el-form-item>

    <el-form-item label="浏览器版本" prop="base.browserVersion">
      <el-select
        v-model="newInstanceConfig.base.browserVersion"
        placeholder="请选择浏览器内核版本"
        style="width: 100%"
        @change="handleFingerprintIdentitySourceChange"
      >
        <el-option
          v-for="version in browserVersions"
          :key="version"
          :label="version"
          :value="version"
        />
      </el-select>
    </el-form-item>
    <el-form-item label="分组">
      <SelectBrowserGroup v-model="newInstanceConfig.groupId" style="width: 100%" />
    </el-form-item>
    <el-form-item label="初始 URL" prop="base.url">
      <el-input
        v-model="newInstanceConfig.base.url"
        placeholder="选填，留空将打开空白页"
      ></el-input>
    </el-form-item>
    <el-form-item label="操作系统" prop="base.operatingSystem">
      <el-select
        v-model="newInstanceConfig.base.operatingSystem"
        multiple
        collapse-tags
        collapse-tags-tooltip
        placeholder="选择操作系统"
        style="width: 100%"
        @change="handleFingerprintIdentitySourceChange"
      >
        <template #header>
          <el-checkbox v-model="checkAll" :indeterminate="indeterminate" @change="handleCheckAll">
            全选
          </el-checkbox>
        </template>
        <el-option
          v-for="item in operatingSystemOptions"
          :key="item.value"
          :label="item.label"
          :value="item.value"
        />
      </el-select>
    </el-form-item>

    <!-- User-Agent -->
    <el-form-item label="User-Agent" prop="base.userAgent">
      <el-input v-model="newInstanceConfig.base.userAgent" placeholder="自定义User-Agent字符串">
        <template #append>
          <el-button
            :icon="RefreshRight"
            title="重新生成 User-Agent"
            aria-label="重新生成 User-Agent"
            @click="generateUserAgent"
          />
        </template>
      </el-input>
    </el-form-item>
    <!-- 初始cookie -->
    <el-form-item label="Cookie" prop="base.cookies">
      <el-input
        type="textarea"
        v-model="newInstanceConfig.base.cookies"
        placeholder="请输入初始Cookie，格式为数组json字符串"
        :rows="3"
      >
        <template #append>
          <el-button @click="newInstanceConfig.base.cookies = ''">清空</el-button>
        </template>
      </el-input>
      <div class="field-help">可选，填写 Playwright Cookie 数组 JSON，将在首次打开前导入。</div>
    </el-form-item>
    <el-form-item label="备注">
      <el-input
        type="textarea"
        v-model="newInstanceConfig.base.remark"
        placeholder="请输入备注信息"
        :rows="2"
      />
    </el-form-item>

    <el-collapse v-model="activeSections" class="settings-collapse">
      <el-collapse-item name="proxy">
        <template #title>
          <span class="collapse-title">代理设置</span>
          <el-tag v-if="newInstanceConfig.proxy.enabled" type="success" size="small">已启用</el-tag>
          <el-tag v-else type="info" size="small">未启用</el-tag>
        </template>

        <el-form-item label="代理状态">
          <el-switch
            v-model="newInstanceConfig.proxy.enabled"
            active-text="启用代理"
            inactive-text="禁用代理"
          ></el-switch>
        </el-form-item>

        <template v-if="newInstanceConfig.proxy.enabled">
          <!-- 代理配置方式选择 -->
          <el-form-item label="代理配置方式">
            <el-select
              v-model="newInstanceConfig.proxy.method"
              placeholder="选择代理配置方式"
              style="width: 100%"
            >
              <el-option label="直接配置" value="manual"></el-option>
              <el-option label="通过URL获取" value="api"></el-option>
            </el-select>
          </el-form-item>

          <!-- 代理类型 -->
          <el-form-item label="代理类型">
            <el-select
              v-model="newInstanceConfig.proxy.type"
              placeholder="选择代理类型"
              style="width: 100%"
            >
              <el-option label="HTTP" value="http"></el-option>
              <el-option label="HTTPS" value="https"></el-option>
              <el-option label="SOCKS5" value="socks5"></el-option>
            </el-select>
          </el-form-item>
          <el-form-item label="分隔符" prop="proxy.delimiter">
            <el-input
              v-model="newInstanceConfig.proxy.delimiter"
              placeholder="输入代理配置分隔符"
            />
          </el-form-item>
          <!-- 直接配置方式的表单字段 -->
          <template v-if="newInstanceConfig.proxy.method === 'manual'">
            <el-form-item label="代理信息" prop="proxy.text">
              <el-input
                v-model="newInstanceConfig.proxy.text"
                placeholder="host:port 或 host:port:username:password"
              ></el-input>
            </el-form-item>
          </template>

          <!-- 通过URL获取方式的表单字段 -->
          <template v-if="newInstanceConfig.proxy.method === 'api'">
            <el-form-item label="API 链接" prop="proxy.text">
              <el-input v-model="newInstanceConfig.proxy.text" placeholder="输入代理API链接" />
            </el-form-item>
          </template>
        </template>
      </el-collapse-item>

      <!-- 指纹设置 -->
      <el-collapse-item name="fingerprint">
        <template #title>
          <span class="collapse-title">高级指纹设置</span>
          <span class="collapse-description">默认值已适合大多数情况</span>
        </template>

        <el-form-item label="Canvas">
          <el-switch
            v-model="effectiveCanvas"
            :disabled="newInstanceConfig.finger.autoFingerprint"
            active-text="启用"
            inactive-text="禁用"
          ></el-switch>
        </el-form-item>

        <el-form-item label="WebGL">
          <el-switch
            v-model="effectiveWebGL"
            :disabled="newInstanceConfig.finger.autoFingerprint"
            active-text="启用"
            inactive-text="禁用"
          ></el-switch>
        </el-form-item>

        <el-form-item label="音频指纹">
          <el-switch
            v-model="effectiveAudio"
            :disabled="newInstanceConfig.finger.autoFingerprint"
            active-text="启用"
            inactive-text="禁用"
          ></el-switch>
        </el-form-item>

        <el-form-item label="时区">
          <el-select v-model="newInstanceConfig.finger.timezone" placeholder="选择时区">
            <el-option
              v-for="item in timezoneOptions"
              :key="item.value"
              :label="item.label"
              :value="item.value"
            />
          </el-select>
        </el-form-item>

        <el-form-item label="语言">
          <el-select v-model="newInstanceConfig.finger.language" placeholder="选择语言">
            <el-option
              v-for="item in languageOptions"
              :key="item.value"
              :label="item.label"
              :value="item.value"
            />
          </el-select>
        </el-form-item>

        <el-form-item label="屏幕分辨率">
          <el-select v-model="newInstanceConfig.finger.screenResolution" placeholder="选择分辨率">
            <el-option
              v-for="item in screenResolutionOptions"
              :key="item.value"
              :label="item.label"
              :value="item.value"
            />
          </el-select>
        </el-form-item>

        <el-form-item label="CPU核心数">
          <el-select
            v-model="newInstanceConfig.finger.hardwareConcurrency"
            placeholder="选择核心数"
          >
            <el-option
              v-for="item in hardwareConcurrencyOptions"
              :key="item.value"
              :label="item.label"
              :value="item.value"
            />
          </el-select>
        </el-form-item>

        <el-form-item label="设备内存">
          <el-select v-model="newInstanceConfig.finger.deviceMemory" placeholder="选择内存">
            <el-option
              v-for="item in deviceMemoryOptions"
              :key="item.value"
              :label="item.label"
              :value="item.value"
            />
          </el-select>
        </el-form-item>

        <el-form-item label="WebRTC">
          <el-select v-model="newInstanceConfig.finger.webRTC" placeholder="选择WebRTC策略">
            <el-option
              v-for="item in webrtcOptions"
              :key="item.value"
              :label="item.label"
              :value="item.value"
              :disabled="item.disabled === true"
            />
          </el-select>
          <div v-if="newInstanceConfig.finger.webRTC === 'public_only'" class="field-help">
            旧配置将继续兼容读取，但“仅公开 IP”当前尚未实现，请选择其他策略。
          </div>
        </el-form-item>

        <el-form-item label="Do Not Track">
          <el-switch
            v-model="newInstanceConfig.finger.doNotTrack"
            active-text="启用"
            inactive-text="禁用"
          ></el-switch>
        </el-form-item>

        <el-form-item label="ClientRects噪声">
          <el-switch
            v-model="effectiveClientRects"
            :disabled="newInstanceConfig.finger.autoFingerprint"
            active-text="启用"
            inactive-text="禁用"
          ></el-switch>
        </el-form-item>

        <el-form-item label="字体指纹">
          <el-select v-model="newInstanceConfig.finger.fonts" placeholder="选择字体策略">
            <el-option
              v-for="item in fontOptions"
              :key="item.value"
              :label="item.label"
              :value="item.value"
            />
          </el-select>
        </el-form-item>

        <el-form-item label="插件指纹">
          <el-select v-model="newInstanceConfig.finger.plugins" placeholder="选择插件策略">
            <el-option
              v-for="item in pluginOptions"
              :key="item.value"
              :label="item.label"
              :value="item.value"
            />
          </el-select>
        </el-form-item>

        <el-form-item label="Battery API">
          <el-select v-model="newInstanceConfig.finger.batteryAPI" placeholder="选择Battery策略">
            <el-option
              v-for="item in batteryApiOptions"
              :key="item.value"
              :label="item.label"
              :value="item.value"
            />
          </el-select>
        </el-form-item>

        <el-form-item label="媒体设备">
          <el-select v-model="newInstanceConfig.finger.mediaDevices" placeholder="选择媒体设备策略">
            <el-option
              v-for="item in mediaDevicesOptions"
              :key="item.value"
              :label="item.label"
              :value="item.value"
            />
          </el-select>
        </el-form-item>

        <el-form-item label="WebGL Vendor">
          <el-input
            v-model="newInstanceConfig.finger.webglVendor"
            placeholder="自定义WebGL Vendor（留空使用默认）"
          ></el-input>
        </el-form-item>

        <el-form-item label="WebGL Renderer">
          <el-input
            v-model="newInstanceConfig.finger.webglRenderer"
            placeholder="自定义WebGL Renderer（留空使用默认）"
          ></el-input>
        </el-form-item>
      </el-collapse-item>
    </el-collapse>
  </el-form>
  <div class="form-actions">
    <el-button @click="cancelForm">取消</el-button>
    <el-button
      type="primary"
      :loading="submitLoading"
      :disabled="submitLoading || (props.mode !== 'edit' && !creationBillingAllowed)"
      @click="submitInstance"
    >
      {{ submitButtonText }}
    </el-button>
  </div>
</template>
<script setup>
  import { computed, onMounted, reactive, ref, watch } from 'vue';
  import { RefreshRight } from '@element-plus/icons-vue';
  import { ElMessage } from '@/utils/message';
  import SelectAccount from '@/components/SelectAccount.vue';
  import SelectBrowserGroup from '@/components/SelectBrowserGroup.vue';
  import BillingCreationStatus from '@/components/BillingCreationStatus.vue';
  import { createBrowserInstance, updateBrowserInstance } from '@/api/browser';
  import {
    TIMEZONE_OPTIONS,
    LANGUAGE_OPTIONS,
    SCREEN_RESOLUTION_OPTIONS,
    HARDWARE_CONCURRENCY_OPTIONS,
    DEVICE_MEMORY_OPTIONS,
    WEBRTC_OPTIONS,
    DEFAULT_FINGERPRINT_CONFIG,
    BATTERY_API_OPTIONS,
    MEDIA_DEVICES_OPTIONS,
    FONT_OPTIONS,
    PLUGIN_OPTIONS,
    getLanguagesForLocale,
    getPlatformForOperatingSystems,
    inferPlatformFromUserAgent,
    resolveFingerprintPlatform,
  } from '@/constants/fingerprint';
  import { UserAgentGenerator } from '@/utils/fingerGenerator';
  import {
    createChromiumFingerprintIdentity,
    validateFingerprintIdentity,
  } from '@/utils/fingerprintIdentity.mjs';
  import { deepClone } from '@/utils/json';
  import { createBrowserEditPlan } from '@/utils/browserEdit.mjs';
  import { getCreationBillingFailure } from '@/utils/billing.mjs';
  import { getUserFacingErrorMessage } from '@/utils/error.mjs';
  import { isValidManualProxyText, prepareProxyConfigForStorage } from '@/utils/browserProxy.mjs';

  const emit = defineEmits(['resetForm', 'refreshData', 'saved']);
  const props = defineProps({
    mode: { type: String, default: 'create' },
    initialData: { type: Object, default: null },
  });

  const timezoneOptions = TIMEZONE_OPTIONS;
  const languageOptions = LANGUAGE_OPTIONS;
  const screenResolutionOptions = SCREEN_RESOLUTION_OPTIONS;
  const hardwareConcurrencyOptions = HARDWARE_CONCURRENCY_OPTIONS;
  const deviceMemoryOptions = DEVICE_MEMORY_OPTIONS;
  const webrtcOptions = WEBRTC_OPTIONS;
  const batteryApiOptions = BATTERY_API_OPTIONS;
  const mediaDevicesOptions = MEDIA_DEVICES_OPTIONS;
  const fontOptions = FONT_OPTIONS;
  const pluginOptions = PLUGIN_OPTIONS;

  const instanceForm = ref(null);
  const browserVersions = ref([]);
  const submitLoading = ref(false);
  const creationBillingAllowed = ref(props.mode === 'edit');
  const activeSections = ref([]);
  const checkAll = ref(false);
  const indeterminate = ref(false);
  const generator = new UserAgentGenerator();
  const linkedAccountUuid = ref('');
  const initialLinkedAccount = computed(() => {
    if (!props.initialData?.email_uuid) return null;
    return {
      email_uuid: props.initialData.email_uuid,
      account_name: props.initialData.account_name,
      account_email: props.initialData.account_email,
    };
  });

  const createDefaultConfig = () => ({
    groupId: 0,
    base: {
      name: '',
      url: '',
      browserVersion: '',
      operatingSystem: [],
      userAgent: '',
      cookies: '',
      remark: '',
    },
    proxy: {
      enabled: false,
      method: 'manual',
      delimiter: ':',
      text: '',
      type: 'http',
      host: '',
      port: 0,
      username: '',
      password: '',
    },
    finger: deepClone(DEFAULT_FINGERPRINT_CONFIG),
  });

  const newInstanceConfig = reactive(createDefaultConfig());
  const effectiveNoise = key =>
    computed({
      get: () => newInstanceConfig.finger.autoFingerprint || newInstanceConfig.finger[key],
      set: value => {
        newInstanceConfig.finger[key] = value;
      },
    });
  const effectiveCanvas = effectiveNoise('canvas');
  const effectiveWebGL = effectiveNoise('webgl');
  const effectiveAudio = effectiveNoise('audioFingerprint');
  const effectiveClientRects = effectiveNoise('clientRects');

  const validateUrl = (rule, value, callback) => {
    if (!value) return callback();
    try {
      const url = new URL(value);
      if (!['http:', 'https:'].includes(url.protocol)) {
        return callback(new Error('仅支持 HTTP 或 HTTPS 地址'));
      }
      callback();
    } catch {
      callback(new Error('请输入完整的 URL，例如 https://example.com'));
    }
  };

  const validateCookies = (rule, value, callback) => {
    if (!value?.trim()) return callback();
    try {
      const cookies = JSON.parse(value);
      if (!Array.isArray(cookies)) {
        return callback(new Error('Cookie 必须是 JSON 数组'));
      }
      callback();
    } catch {
      callback(new Error('Cookie JSON 格式不正确'));
    }
  };

  const validateProxyText = (rule, value, callback) => {
    if (!newInstanceConfig.proxy.enabled) return callback();
    if (!value?.trim()) return callback(new Error('启用代理后请填写代理信息'));

    if (newInstanceConfig.proxy.method === 'api') {
      return validateUrl(rule, value, callback);
    }

    const delimiter = newInstanceConfig.proxy.delimiter || ':';
    if (!isValidManualProxyText(value, delimiter)) {
      return callback(new Error(`请按 host${delimiter}port 格式填写有效代理`));
    }
    callback();
  };

  const formRules = {
    'base.name': [
      { required: true, message: '请输入窗口名称', trigger: 'blur' },
      { min: 1, max: 50, message: '名称不能超过 50 个字符', trigger: 'blur' },
    ],
    'base.browserVersion': [{ required: true, message: '请选择浏览器内核', trigger: 'change' }],
    'base.operatingSystem': [
      {
        type: 'array',
        required: true,
        min: 1,
        message: '请选择至少一个操作系统',
        trigger: 'change',
      },
    ],
    'base.userAgent': [{ required: true, message: '请生成或填写 User-Agent', trigger: 'blur' }],
    'base.url': [{ validator: validateUrl, trigger: 'blur' }],
    'base.cookies': [{ validator: validateCookies, trigger: 'blur' }],
    'proxy.delimiter': [{ required: true, message: '请填写代理分隔符', trigger: 'blur' }],
    'proxy.text': [{ validator: validateProxyText, trigger: 'blur' }],
  };

  const submitButtonText = computed(() => {
    if (props.mode === 'edit') return '保存修改';
    if (props.mode === 'clone') return '创建副本';
    return '创建窗口';
  });

  const replaceFormConfig = config => {
    const fresh = createDefaultConfig();
    Object.assign(fresh.base, deepClone(config?.base || {}));
    Object.assign(fresh.proxy, deepClone(config?.proxy || {}));
    fresh.proxy = prepareProxyConfigForStorage(fresh.proxy);
    Object.assign(fresh.finger, deepClone(config?.finger || {}));
    // Older windows retain their saved manual settings until explicitly enabled.
    fresh.finger.autoFingerprint = config?.finger?.autoFingerprint === true;
    fresh.groupId = config?.groupId ?? 0;
    fresh.finger.languages = getLanguagesForLocale(
      fresh.finger.language || fresh.finger.languages?.[0]
    );
    fresh.finger.platform = resolveFingerprintPlatform({
      userAgent: fresh.base.userAgent,
      operatingSystems: fresh.base.operatingSystem,
      fallback: fresh.finger.platform,
    });
    Object.assign(newInstanceConfig, fresh);
  };

  const populateFromInitial = data => {
    if (!data) return;
    const config = deepClone(data.config || data);
    config.groupId = data.group_id ?? data.groupId ?? config.groupId ?? 0;
    replaceFormConfig(config);
    linkedAccountUuid.value = typeof data.email_uuid === 'string' ? data.email_uuid : '';
    if (props.mode === 'clone') {
      newInstanceConfig.base.name = `${newInstanceConfig.base.name || '新窗口'} - 副本`;
    }
  };

  const generateUserAgent = ({ notify = true } = {}) => {
    if (!newInstanceConfig.base.browserVersion) {
      if (notify) ElMessage.warning('请先选择浏览器内核版本');
      return false;
    }
    try {
      const identity = createChromiumFingerprintIdentity({
        browserVersion: newInstanceConfig.base.browserVersion,
        operatingSystems: newInstanceConfig.base.operatingSystem,
        language: newInstanceConfig.finger.language,
        generateUserAgent: options => generator.generateDesktopChromium(options),
      });
      newInstanceConfig.base.userAgent = identity.userAgent;
      newInstanceConfig.finger.platform = identity.platform;
      return true;
    } catch (error) {
      ElMessage.warning(error?.message || 'User-Agent 生成失败');
      return false;
    }
  };

  const handleFingerprintIdentitySourceChange = () => {
    generateUserAgent({ notify: false });
  };

  const autoGenerateDefaults = () => {
    const platform = navigator.platform?.toLowerCase() || '';
    newInstanceConfig.base.operatingSystem = platform.includes('mac')
      ? ['Mac OS X 14']
      : ['Windows NT 10.0'];
    generateUserAgent();
  };

  onMounted(async () => {
    try {
      browserVersions.value = (await window.ipcRenderer.getAllBrowserVersions()) || [];
      if (props.mode === 'create') {
        newInstanceConfig.base.browserVersion = browserVersions.value[0] || '';
        if (newInstanceConfig.base.browserVersion) autoGenerateDefaults();
      }
      if (browserVersions.value.length === 0) {
        ElMessage.warning('暂无可用内核，请先在“内核管理”中刷新或下载');
      }
    } catch (error) {
      ElMessage.error('加载浏览器内核列表失败');
    }
  });

  watch(
    () => props.initialData,
    value => {
      if (['edit', 'clone'].includes(props.mode) && value) {
        populateFromInitial(value);
      }
    },
    { immediate: true }
  );

  watch(
    () => newInstanceConfig.proxy.enabled,
    enabled => {
      if (!enabled) {
        Object.assign(
          newInstanceConfig.proxy,
          prepareProxyConfigForStorage(newInstanceConfig.proxy)
        );
        instanceForm.value?.clearValidate('proxy.text');
      }
    }
  );

  const submitInstance = async () => {
    if (submitLoading.value) return;
    if (props.mode !== 'edit' && !creationBillingAllowed.value) {
      ElMessage.warning('当前无法确认免费额度或超额计费未启用');
      return;
    }
    const valid = await instanceForm.value?.validate().catch(() => false);
    if (!valid) return;

    const identityValidation = validateFingerprintIdentity({
      browserVersion: newInstanceConfig.base.browserVersion,
      operatingSystems: newInstanceConfig.base.operatingSystem,
      userAgent: newInstanceConfig.base.userAgent,
      platform: newInstanceConfig.finger.platform,
    });
    if (!identityValidation.valid) {
      ElMessage.warning('内核、User-Agent 与操作系统不一致，请重新生成 User-Agent');
      return;
    }

    submitLoading.value = true;
    try {
      const config = deepClone(newInstanceConfig);
      config.finger.platform = identityValidation.platform;
      config.base.name = config.base.name.trim();
      config.base.url = config.base.url?.trim() || '';
      config.proxy = prepareProxyConfigForStorage(config.proxy);

      if (props.mode === 'edit') {
        if (!props.initialData?.browser_id) throw new Error('缺少窗口 ID');
        const id = props.initialData.browser_id;
        const { payload, urlChanged } = createBrowserEditPlan({
          id,
          config,
          previousUrl: props.initialData.config?.base?.url,
        });
        payload.email_uuid = linkedAccountUuid.value || '';

        if (urlChanged) {
          // 先等待运行实例完整关闭并将旧快照持久化，再写入新 URL 页面种子。
          // 这个顺序可避免延迟到达的关闭快照覆盖新 URL。
          const runningIds = await window.ipcRenderer.getAllInstances();
          if (!Array.isArray(runningIds)) {
            throw new Error('无法确认窗口运行状态，请稍后重试');
          }
          if (runningIds.includes(id)) {
            await window.ipcRenderer.removeInstance(id);
          }
        }

        await updateBrowserInstance(payload);
        ElMessage.success(
          urlChanged ? '初始 URL 已更新，下次打开将从新地址启动' : '浏览器窗口已更新'
        );
      } else {
        await createBrowserInstance({ config, email_uuid: linkedAccountUuid.value || '' });
        ElMessage.success(props.mode === 'clone' ? '窗口副本已创建' : '浏览器窗口创建成功');
      }

      emit('refreshData');
      emit('saved');
      cancelForm();
    } catch (error) {
      const billingFailure =
        props.mode === 'edit' ? null : getCreationBillingFailure(error, { batch: false });
      if (billingFailure) {
        ElMessage[billingFailure.type](billingFailure.message);
      } else if (!error?.isNotified) {
        ElMessage.error(
          `${props.mode === 'edit' ? '更新' : '创建'}窗口失败：${getUserFacingErrorMessage(error)}`
        );
      }
    } finally {
      submitLoading.value = false;
    }
  };

  const handleBillingStateChange = state => {
    creationBillingAllowed.value = state?.allowed === true;
  };

  const cancelForm = () => {
    emit('resetForm');
  };

  const operatingSystemOptions = [
    {
      value: 'Windows NT 11.0',
      label: 'Windows 11',
    },
    {
      value: 'Windows NT 10.0',
      label: 'Windows 10',
    },
    {
      value: 'Windows NT 6.2',
      label: 'Windows 8',
    },
    {
      value: 'Windows NT 6.1',
      label: 'Windows 7',
    },
    {
      value: 'Mac OS X 15',
      label: 'macOS Sequoia',
    },
    {
      value: 'Mac OS X 14',
      label: 'macOS Sonoma',
    },
    {
      value: 'Mac OS X 13',
      label: 'macOS Ventura',
    },
    {
      value: 'Mac OS X 12',
      label: 'macOS Monterey',
    },
  ];
  const handleCheckAll = val => {
    checkAll.value = val;
    indeterminate.value = false;
    newInstanceConfig.base.operatingSystem = val
      ? operatingSystemOptions.map(item => item.value)
      : [];
    handleFingerprintIdentitySourceChange();
  };

  watch(
    () => newInstanceConfig.finger.language,
    language => {
      newInstanceConfig.finger.languages = getLanguagesForLocale(language);
    },
    { immediate: true }
  );

  watch(
    () => newInstanceConfig.base.operatingSystem,
    operatingSystems => {
      const platform =
        getPlatformForOperatingSystems(operatingSystems) ||
        inferPlatformFromUserAgent(newInstanceConfig.base.userAgent);
      if (platform) newInstanceConfig.finger.platform = platform;
    },
    { deep: true, immediate: true }
  );

  watch(
    () => newInstanceConfig.base.userAgent,
    userAgent => {
      const platform = inferPlatformFromUserAgent(userAgent);
      if (platform) newInstanceConfig.finger.platform = platform;
    },
    { immediate: true }
  );

  watch(
    () => newInstanceConfig.base.operatingSystem,
    values => {
      checkAll.value = values.length === operatingSystemOptions.length;
      indeterminate.value = values.length > 0 && !checkAll.value;
    },
    { deep: true }
  );
</script>

<style scoped>
  .instance-form {
    max-height: min(calc(100vh - 225px), 680px);
    overflow-y: auto;
    padding: 0 12px 8px 0;
  }

  .form-section-title {
    margin: 0 0 18px;
    color: var(--app-text-primary, #172033);
    font-size: 15px;
    font-weight: 650;
  }

  .field-help {
    margin-top: 5px;
    color: var(--app-text-secondary, #667085);
    font-size: 12px;
    line-height: 1.5;
  }

  .settings-collapse {
    margin-top: 12px;
    border-top: 1px solid var(--el-border-color-lighter);
  }

  .collapse-title {
    margin-right: 10px;
    color: var(--app-text-primary, #172033);
    font-weight: 650;
  }

  .collapse-description {
    color: var(--app-text-secondary, #667085);
    font-size: 12px;
  }

  .settings-collapse :deep(.el-collapse-item__content) {
    padding: 18px 4px 6px;
  }

  .settings-collapse :deep(.el-select) {
    width: 100%;
  }

  .form-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    padding-top: 16px;
    border-top: 1px solid var(--el-border-color-lighter);
  }
</style>
