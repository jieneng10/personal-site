// ==================== Event Bus — Cross-Module Communication ====================
// Replaces ad-hoc window.xxx callbacks with a typed publish/subscribe system.
// Events are plain strings; each module listens to what it needs.
(function() {
  var _listeners = {};

  /**
   * Subscribe to an event.
   * @param {string} event - Event name (e.g. 'auth:login', 'cache:invalidate:articles')
   * @param {Function} fn  - Callback invoked with the event payload
   */
  function on(event, fn) {
    if (!_listeners[event]) _listeners[event] = [];
    _listeners[event].push(fn);
  }

  /**
   * Unsubscribe from an event.
   * @param {string} event
   * @param {Function} fn - The exact function reference passed to `on`
   */
  function off(event, fn) {
    var list = _listeners[event];
    if (!list) return;
    _listeners[event] = list.filter(function(l) { return l !== fn; });
  }

  /**
   * Emit an event to all subscribers.
   * @param {string} event
   * @param {*} [data] - Optional payload forwarded to each listener
   */
  function emit(event, data) {
    var list = _listeners[event];
    if (!list) return;
    for (var i = 0; i < list.length; i++) {
      try { list[i](data); } catch (e) { /* one listener failing must not break others */ }
    }
  }

  /** @type {{ on: typeof on, off: typeof off, emit: typeof emit }} */
  window.EventBus = { on: on, off: off, emit: emit };
})();
