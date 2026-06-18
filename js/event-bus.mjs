// ==================== Event Bus — ES Module re-exports ====================
// Re-exports from window.EventBus (set by js/event-bus.js IIFE).

export const EventBus = window.EventBus;
export const on   = window.EventBus.on.bind(window.EventBus);
export const off  = window.EventBus.off.bind(window.EventBus);
export const emit = window.EventBus.emit.bind(window.EventBus);
