/**
 * ==================== 事件总线 — 模块间通信（ESM） ====================
 *
 * 模块间发布/订阅——发送方只 emit，接收方自行 on，双方互不依赖。
 *
 * import { on, off, emit } from './event-bus.mjs';
 * on('auth:login', () => { ... });
 * emit('auth:login');
 */

var _listeners = {};

function on(event, fn) {
  if (!_listeners[event]) _listeners[event] = [];
  _listeners[event].push(fn);
}

function off(event, fn) {
  var list = _listeners[event];
  if (!list) return;
  _listeners[event] = list.filter(function(l) { return l !== fn; });
}

function emit(event, data) {
  var list = _listeners[event];
  if (!list) return;
  for (var i = 0; i < list.length; i++) {
    try { list[i](data); }
    catch (e) { /* 单个监听器崩溃不阻断其他 */ }
  }
}

export const EventBus = { on, off, emit };
export { on, off, emit };

// Backward compat: classic supabase.js reads window.EventBus for onAuthStateChange callbacks
window.EventBus = EventBus;
