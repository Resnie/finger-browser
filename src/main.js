import { createApp } from 'vue';
import ElementPlus from 'element-plus';
import 'element-plus/dist/index.css';
import './styles/app.css';
import App from './App.vue';
import router from './router';
import { createPinia } from 'pinia';
import zhCn from 'element-plus/es/locale/lang/zh-cn';
import { ElMessage } from './utils/message';

const app = createApp(App);

app.use(ElementPlus, {
  locale: zhCn,
});
app.config.globalProperties.$message = ElMessage;
app.use(createPinia());
app.use(router);
app.mount('#app');
