import { createApp } from 'vue';
import ElementPlus from 'element-plus';
import { messageDefaults } from 'element-plus/es/components/message/src/message.mjs';
import zhCn from 'element-plus/dist/locale/zh-cn.mjs';
import 'element-plus/dist/index.css';
import App from './App.vue';
import './style.css';

// 缩短全局提示时长（默认 3000ms → 1600ms），避免提示停留过久
(messageDefaults as { duration: number }).duration = 1600;

// 在挂载前应用持久化的外观设置，避免闪烁
const accent = localStorage.getItem('bs-accent') || 'rose';
const dark = localStorage.getItem('bs-dark') !== 'light';
const el = document.documentElement;
el.setAttribute('data-accent', accent);
el.setAttribute('data-theme', dark ? 'dark' : 'light');

createApp(App).use(ElementPlus, { locale: zhCn }).mount('#app');