/**
 * ==================== 事件总线 — 模块间通信 ====================
 *
 * 【这是什么】
 *   网站内部的"广播站"——不同模块之间不用知道对方是谁，
 *   只管发消息（emit）和听消息（on）就行。
 *
 * 【为什么需要它】
 *   以前模块之间靠 window 全局变量传话：
 *     wallpaper.js 写 window.currentWallpaper = 3
 *     bgm.js 读 window.currentWallpaper
 *   问题：A 不知道 B 什么时候读、会不会改、改了谁知道。
 *
 *   现在改成事件方式：
 *     登录成功后：emit('auth:login')        ← 我只管喊一声
 *     谁关心登录：  on('auth:login', fn)    ← 你关心就自己来听
 *   双方互不依赖，少一个模块也不会报错。
 *
 * 【怎么用】
 *   发送消息：EventBus.emit('事件名', 可选数据)
 *   接收消息：EventBus.on( '事件名', function(数据) { ... })
 *   取消接收：EventBus.off('事件名', 同一个函数)
 *
 * 【所有事件清单】（方便搜索定位）
 *   auth:login                  登录成功        → articles/wallpaper/bgm/nav 刷新
 *   auth:logout                 登出            → 清理管理员 UI
 *   cache:invalidate:articles   文章缓存失效    → 管理员编辑后触发
 *   cache:invalidate:wallpaper  壁纸缓存失效    → 管理员审核后触发
 *   cache:invalidate:tracks     BGM 缓存失效    → 管理员审核后触发
 *   news:panelOpened            资讯面板打开    → nav 同步高亮
 *   news:panelClosed            资讯面板关闭    → nav 清除高亮
 *   news:refresh                资讯数据刷新    → nav 重新渲染
 *
 * 【注意】
 *   - 事件名是区分大小写的纯字符串，拼错了不会报错只是收不到
 *   - emit 时如果某个监听函数报错，不会影响其他监听者
 *   - off 需要传入和 on 完全相同的函数引用，匿名函数无法取消
 */
(function() {

  /**
   * 监听者存储结构：
   * {
   *   'auth:login': [fn1, fn2, fn3],   ← 登录事件有 3 个模块在听
   *   'news:panelOpened': [fn4],        ← 新闻面板打开事件有 1 个在听
   * }
   * 每个事件名对应一个函数数组，emit 时依次调用
   */
  var _listeners = {};

  /**
   * 订阅事件 —— "我对这个事件感兴趣，发生的时候通知我"
   *
   * @param {string}   event - 事件名，如 'auth:login'
   * @param {Function} fn    - 回调函数，事件发生时被调用，可以接收 emit 传来的数据
   *
   * 【示例】
   *   EventBus.on('auth:login', function() {
   *     console.log('有人登录了！');
   *     refreshUI();
   *   });
   *
   * 【注意】
   *   - 同一个函数可以被多次注册（不检查重复）
   *   - 如果要取消监听，必须保留这个 fn 的引用传给 off()
   */
  function on(event, fn) {
    // 如果这个事件还没有人监听过，先创建空数组
    if (!_listeners[event]) _listeners[event] = [];
    _listeners[event].push(fn);
  }

  /**
   * 取消订阅 —— "我不关心这个事件了"
   *
   * @param {string}   event - 事件名
   * @param {Function} fn    - 必须和 on 时传入的是同一个函数对象
   *
   * 【示例】
   *   var handler = function() { refreshUI(); };
   *   EventBus.on('auth:login', handler);      // 开始监听
   *   EventBus.off('auth:login', handler);     // 停止监听
   *
   * 【常见错误】
   *   EventBus.on('auth:login', function() { ... });
   *   EventBus.off('auth:login', function() { ... });  ← 错！这是两个不同的函数
   */
  function off(event, fn) {
    var list = _listeners[event];
    if (!list) return;
    // filter 返回一个新数组，排除掉要移除的那个函数
    _listeners[event] = list.filter(function(l) { return l !== fn; });
  }

  /**
   * 发送事件 —— "有事情发生了，通知所有关心的人"
   *
   * @param {string} event - 事件名
   * @param {*}      [data] - 可选，随事件传递的数据
   *
   * 【示例】
   *   EventBus.emit('auth:login');                        // 不带数据
   *   EventBus.emit('cache:invalidate:articles', 123);    // 带文章 ID
   *
   * 【安全机制】
   *   每个监听函数的调用都包了 try/catch
   *   即使 A 模块的监听器崩溃了，B 和 C 仍然能收到通知
   *   这是故意设计的——一个模块挂了不应该拖垮全站
   */
  function emit(event, data) {
    var list = _listeners[event];
    if (!list) return; // 没人在听，直接返回
    for (var i = 0; i < list.length; i++) {
      try { list[i](data); }
      catch (e) { /* 单个监听器崩溃不阻断其他 */ }
    }
  }

  // 暴露到全局，让其他模块可以直接 EventBus.on / EventBus.emit
  window.EventBus = { on: on, off: off, emit: emit };
})();
