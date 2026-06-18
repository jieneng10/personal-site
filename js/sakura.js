/**
 * sakura.js — Canvas 樱花飘落动画模块
 *
 * 【这是什么】
 *   在页面顶部 Canvas 层上绘制循环飘落的樱花花瓣动画。
 *   只在用户未开启 reduced-motion 偏好时启用，且可通过 window.sakuraEnabled
 *   动态开关（例如设置面板可关闭动画）。移动端自动降级花瓣数量以节省性能。
 *
 * 【数据流向】
 *   DOM → initSakura() 读取 #sakuraCanvas 并绑定 resize 事件
 *        → tickSakura() 每帧更新花瓣数组、绘制到 Canvas
 *        → settings.js 通过 window.sakuraEnabled / window.tickSakura() 控制开关
 *        → visibilitychange 事件自动暂停/恢复动画
 *
 * 【依赖】
 *   - DOM: 需要 id="sakuraCanvas" 的 Canvas 元素提前存在于 HTML 中
 *   - 无其他 JS 模块依赖（纯自包含 IIFE）
 *
 * 【全局变量关系（window 导出）】
 *   - window.sakuraEnabled  : boolean — 是否启用樱花动画（可被 settings.js 读写）
 *   - window.sakuraAnimId   : number|null — 当前 requestAnimationFrame 的 ID（可被外部取消）
 *   - window.initSakura()   : function — 初始化 Canvas 并启动动画
 *   - window.tickSakura()   : function — 恢复/手动触发一帧动画循环
 *   - window._sakuraCanvas  : getter → HTMLCanvasElement|null — 供 settings.js 读取 canvas 引用
 */

// ==================== Sakura Petals (Canvas) ====================
(function() {
  // ---------------------------------------------------------------
  // 常量 & 模块级变量（IIFE 闭包内，外部不可直接访问）
  // ---------------------------------------------------------------

  /** 桌面端最大花瓣数量 */
  var MAX_PETALS = 40;

  /**
   * 移动端最大花瓣数量
   *
   * 【为什么是 15】
   *   移动端 GPU 性能有限，40 片花瓣在低端设备上可能掉帧明显。
   *   15 片在视觉上仍有足够密度，同时把每帧绘制开销控制在 <2ms。
   */
  var MOBILE_MAX = 15;

  /** 活动花瓣数组，每个元素是 randomPetal() 返回的对象 */
  var petals = [];

  /** Canvas 元素引用（initSakura 后赋值） */
  var canvas;

  /** Canvas 2D 渲染上下文（initSakura 后赋值） */
  var ctx;

  // ---------------------------------------------------------------
  // window 导出（外部可读写状态）
  // ---------------------------------------------------------------

  /**
   * 是否启用樱花动画。
   * 初始化时若检测到 prefers-reduced-motion 则自动设为 false。
   * settings.js 设置面板可切换此值，切换后调用 window.tickSakura() 恢复动画。
   */
  window.sakuraEnabled = true;

  /**
   * 当前动画帧 ID。
   * 由 tickSakura() 内部 requestAnimationFrame 赋值。
   * 当动画被暂停（页面隐藏 / sakuraEnabled=false / reduced-motion）时设为 null。
   */
  window.sakuraAnimId = null;

  // ---------------------------------------------------------------
  // 内部函数
  // ---------------------------------------------------------------

  /**
   * 生成一片花瓣的随机属性对象。
   *
   * 【它做什么】
   *   用随机数创建一个花瓣的状态对象，包含位置、大小、速度、旋转、
   *   透明度、色相等所有动画参数。每片花瓣都不同，避免视觉重复感。
   *
   * 【输入】
   *   canvasW — Canvas 宽度（用于确定 X 轴随机范围）
   *   startY  — 可选初始 Y 坐标；不传则从 Canvas 上方随机位置开始（分批入场效果）
   *
   * 【输出】
   *   { x, y, size, speed, rotation, rotSpeed, drift, opacity, hue }
   *
   *   x        : 水平坐标（0 ~ canvasW 随机）
   *   y        : 垂直坐标（startY 或 Canvas 上方随机）
   *   size     : 花瓣大小 8~22px（随机，模拟远近层次）
   *   speed    : 下落速度 0.4~1.6 px/帧（随机）
   *   rotation : 当前旋转角度（弧度）
   *   rotSpeed : 旋转速度（-0.015 ~ +0.015，可正可负）
   *   drift    : 水平漂移速度（-0.2 ~ +0.2，模拟风）
   *   opacity  : 不透明度 0.3~0.85（随机，模拟远近）
   *   hue      : HSL 色相 340~360（粉红范围，略有差异避免单调）
   *
   * 【调用者】
   *   initSakura() — 初始化时批量生成初始花瓣
   *   tickSakura() — 每帧按概率补充新花瓣（维持总数）
   */
  function randomPetal(canvasW, startY) {
    var size = 8 + Math.random() * 14;
    return {
      x: Math.random() * canvasW,
      y: startY != null ? startY : -(Math.random() * canvasW),
      size: size,
      speed: 0.4 + Math.random() * 1.2,
      rotation: Math.random() * Math.PI * 2,
      rotSpeed: (Math.random() - 0.5) * 0.03,
      drift: (Math.random() - 0.5) * 0.4,
      opacity: 0.3 + Math.random() * 0.55,
      hue: 340 + Math.random() * 20,
    };
  }

  /**
   * 在 Canvas 上绘制一片花瓣。
   *
   * 【它做什么】
   *   用贝塞尔曲线绘制花瓣形状（对称两片），填充径向渐变，
   *   并根据花瓣对象的 rotation/opacity/hue 执行平移、旋转、透明度变换。
   *
   * 【输入】
   *   ctx — Canvas 2D 渲染上下文
   *   p   — 花瓣对象（由 randomPetal 生成 + tickSakura 更新）
   *
   * 【副作用】
   *   在 Canvas 上绘制（ctx.save/restore 保证不影响后续绘制）
   *
   * 【为什么用贝塞尔曲线 + 径向渐变】
   *   贝塞尔曲线绘制的花瓣形状比椭圆更自然（有尖端和圆润底部）。
   *   径向渐变模拟花瓣从中心到边缘的颜色变化（亮粉→深粉），
   *   比纯色填充更有立体感。
   *
   * 【调用者】
   *   tickSakura() — 每帧对每片活动花瓣调用一次
   */
  function drawPetal(ctx, p) {
    var x = p.x, y = p.y, size = p.size, rotation = p.rotation, opacity = p.opacity;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rotation);
    ctx.globalAlpha = opacity;

    // 花瓣宽高 —— 宽约为 size*0.55，高约为 size*0.8（稍长）
    var w = size * 0.55;
    var h = size * 0.8;
    ctx.beginPath();
    // 从顶部尖端开始，右半边贝塞尔曲线
    ctx.moveTo(0, -h);
    ctx.bezierCurveTo(w, -h * 0.5, w, h * 0.3, 0, h);
    // 左半边贝塞尔曲线（对称）
    ctx.bezierCurveTo(-w, h * 0.3, -w, -h * 0.5, 0, -h);
    ctx.closePath();

    // 径向渐变：中心偏上 → 底部偏下
    var grad = ctx.createRadialGradient(0, -h * 0.2, size * 0.05, 0, h * 0.3, size * 0.7);
    grad.addColorStop(0, 'hsla(' + p.hue + ', 90%, 88%, 1)');       // 中心：亮粉
    grad.addColorStop(0.6, 'hsla(' + p.hue + ', 70%, 65%, 0.9)');   // 中间：深粉
    grad.addColorStop(1, 'hsla(' + (p.hue - 20) + ', 60%, 50%, 0.4)'); // 边缘：暗红半透明
    ctx.fillStyle = grad;
    ctx.fill();

    ctx.restore();
  }

  /**
   * 单帧动画 tick —— 樱花动画的主循环。
   *
   * 【它做什么】
   *   1. 检查是否应该继续动画（sakuraEnabled、canvas/ctx 存在、页面可见）
   *   2. 注册下一帧回调（requestAnimationFrame）
   *   3. 补充新花瓣（维持总数）
   *   4. 更新每片花瓣位置、透明度（淡入淡出）、旋转
   *   5. 绘制每片花瓣
   *   6. 移除超出边界的花瓣
   *
   * 【副作用】
   *   - 修改 petals 数组（增删花瓣）
   *   - 修改 window.sakuraAnimId
   *   - 在 Canvas 上绘制
   *
   * 【调用者】
   *   - initSakura() 末尾通过 window.tickSakura() 启动循环
   *   - visibilitychange 事件中恢复动画
   *   - settings.js 用户重新开启樱花时调用
   *
   * 【为什么每帧检查 document.hidden】
   *   当用户切到其他标签页时 requestAnimationFrame 也会暂停，
   *   但恢复时可能积压多帧。主动检测 document.hidden 可以立即停止，
   *   并通过 visibilitychange 事件精准恢复，避免不必要的 CPU 消耗。
   */
  function tickSakura() {
    // 用户关闭了樱花动画 → 清空 ID 并退出
    if (!window.sakuraEnabled) { window.sakuraAnimId = null; return; }
    // 防护: prefers-reduced-motion 时 initSakura 早退，canvas/ctx 未初始化
    if (!canvas || !ctx) return;
    // B-16: 页面不可见或 canvas 被隐藏时暂停动画循环
    if (document.hidden || (canvas.style.display === 'none')) {
      window.sakuraAnimId = null;
      return;
    }
    // 注册下一帧 —— 必须在所有 early return 之后，确保只在需要时继续循环
    window.sakuraAnimId = requestAnimationFrame(tickSakura);

    var w = canvas.width;
    var h = canvas.height;
    // 每帧清空画布，准备新的绘制
    ctx.clearRect(0, 0, w, h);

    // 移动端/桌面端使用不同花瓣上限
    var isMobile = w < 540;
    var maxP = isMobile ? MOBILE_MAX : MAX_PETALS;

    // 按 35% 概率补充新花瓣，直到达到上限
    if (petals.length < maxP && Math.random() < 0.35) {
      petals.push(randomPetal(w, -10));
    }

    // 反向遍历以便安全 splice（不影响后续索引）
    for (var i = petals.length - 1; i >= 0; i--) {
      var p = petals[i];

      // 更新位置
      p.y += p.speed;                                      // 下落
      p.x += p.drift + Math.sin(p.y * 0.02) * 0.3;        // 水平漂移 + 正弦摆动
      p.rotation += p.rotSpeed;                            // 自转

      // 淡入淡出：顶部入场时逐渐显现，底部离场时逐渐消失
      // 避免花瓣在边界突然出现/消失
      var fadeIn = Math.min(1, (p.y + 20) / 80);
      var fadeOut = 1 - Math.max(0, (p.y - h + 80) / 100);
      p.opacity = Math.min(p.opacity, fadeIn * fadeOut);

      drawPetal(ctx, p);

      // 移出边界的花瓣：销毁
      if (p.y > h + 30 || p.x < -30 || p.x > w + 30) {
        petals.splice(i, 1);
      }
    }
  }

  /**
   * 响应窗口大小变化，更新 Canvas 尺寸。
   *
   * 【副作用】
   *   修改 canvas.width / canvas.height（会清空 Canvas 内容，但下一帧会重绘）
   *
   * 【调用者】
   *   initSakura() 末尾注册的 window resize 事件
   */
  function resizeSakura() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  }

  /**
   * 初始化樱花动画系统。
   *
   * 【它做什么】
   *   1. 检测用户系统是否开启了 reduced-motion（尊重无障碍偏好）
   *   2. 获取 Canvas 元素和 2D 上下文
   *   3. 设置 Canvas 尺寸并监听窗口 resize
   *   4. 生成初始花瓣池（预填充到上限）
   *   5. 启动动画循环
   *
   * 【副作用】
   *   - 可能设置 window.sakuraEnabled = false（reduced-motion 时）
   *   - 赋值模块级 canvas / ctx 变量
   *   - 往 window 注册 resize 事件监听
   *
   * 【调用者】
   *   页面加载时由 main.js 或 HTML 内联脚本调用 window.initSakura()
   *
   * 【为什么 reduced-motion 时直接 return 而不初始化 Canvas】
   *   避免不必要的 DOM 操作和事件绑定。此时 canvas/ctx 保持 undefined，
   *   tickSakura() 的防护检查会安全跳过，不会有任何绘制。
   */
  function initSakura() {
    // 尊重用户系统的 reduced-motion 偏好
    var prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (prefersReduced) {
      window.sakuraEnabled = false;
      return;
    }
    canvas = document.getElementById('sakuraCanvas');
    ctx = canvas.getContext('2d');
    resizeSakura();
    window.addEventListener('resize', resizeSakura);

    // 预填充初始花瓣：均匀分布在 Canvas 垂直范围内
    // （避免启动时从零开始，导致前几秒画面太空）
    var w = canvas.width;
    var h = canvas.height;
    var isMobile = w < 540;
    var count = isMobile ? MOBILE_MAX : MAX_PETALS;
    for (var i = 0; i < count; i++) {
      petals.push(randomPetal(w, Math.random() * h));
    }
    // 启动动画循环
    window.tickSakura();
  }

  // ---------------------------------------------------------------
  // 页面可见性变化监听
  // ---------------------------------------------------------------

  /**
   * 当用户切回标签页时自动恢复动画。
   *
   * 【为什么需要这个】
   *   浏览器在标签页不可见时会暂停 requestAnimationFrame。
   *   切回来时 sakuraAnimId 已是 null（tickSakura 在检测到 hidden 时会停止）。
   *   这里监听 visibilitychange，页面重新可见 + 用户未关闭动画 → 恢复循环。
   */
  // B-16: 页面重新可见时恢复动画
  document.addEventListener('visibilitychange', function() {
    if (!document.hidden && window.sakuraEnabled && !window.sakuraAnimId) {
      window.tickSakura();
    }
  });

  // ---------------------------------------------------------------
  // window 导出
  // ---------------------------------------------------------------

  window.initSakura = initSakura;
  window.tickSakura = tickSakura;

  /**
   * 只读 getter：供 settings.js 读取 canvas 引用（用于切换显示/隐藏）。
   *
   * 【为什么用 getter 而不是直接赋值】
   *   直接赋值 window._sakuraCanvas = canvas 在 IIFE 执行时 canvas 还是 undefined
   *   （initSakura 尚未调用）。用 getter 保证每次读取都拿到最新的模块级 canvas 变量。
   */
  // sakuraCanvas exposed as getter so settings.js can read it after init
  Object.defineProperty(window, '_sakuraCanvas', { get: function() { return canvas; } });
})();
