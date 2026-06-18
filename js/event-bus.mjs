/**
 * ==================== Event Bus — ES Module 包装层 ====================
 *
 * 【为什么有这个文件】
 *   event-bus.js 是旧式 IIFE 写法，把东西挂在 window.EventBus 上。
 *   新式 ES Module 需要用 import 引入，不能读 window。
 *   这个文件只做一件事：把 window.EventBus 转发成 ES Module export。
 *
 * 【怎么用】
 *   import { on, emit } from './event-bus.mjs';
 *   on('auth:login', () => { ... });
 *   emit('auth:login');
 *
 * 【加载顺序（重要！）】
 *   浏览器先加载 event-bus.js（classic script，设 window.EventBus），
 *   再加载 event-bus.mjs（module script，从 window 读值再导出）。
 *   顺序反了会拿到 undefined。
 */

// window.EventBus 在 event-bus.js 加载后已经就绪
// 这里只是换一种方式暴露出去
export const EventBus = window.EventBus;

// 提供便捷的独立函数导出，不用每次写 EventBus.on / EventBus.emit
export const on   = window.EventBus.on.bind(window.EventBus);
export const off  = window.EventBus.off.bind(window.EventBus);
export const emit = window.EventBus.emit.bind(window.EventBus);
