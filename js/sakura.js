// ==================== Sakura Petals (Canvas) ====================
(function() {
  var MAX_PETALS = 40;
  var MOBILE_MAX = 15;
  var petals = [];
  var canvas, ctx;

  // Public mutable state (also accessed by settings.js)
  window.sakuraEnabled = true;
  window.sakuraAnimId = null;

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

  function drawPetal(ctx, p) {
    var x = p.x, y = p.y, size = p.size, rotation = p.rotation, opacity = p.opacity;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rotation);
    ctx.globalAlpha = opacity;

    var w = size * 0.55;
    var h = size * 0.8;
    ctx.beginPath();
    ctx.moveTo(0, -h);
    ctx.bezierCurveTo(w, -h * 0.5, w, h * 0.3, 0, h);
    ctx.bezierCurveTo(-w, h * 0.3, -w, -h * 0.5, 0, -h);
    ctx.closePath();

    var grad = ctx.createRadialGradient(0, -h * 0.2, size * 0.05, 0, h * 0.3, size * 0.7);
    grad.addColorStop(0, 'hsla(' + p.hue + ', 90%, 88%, 1)');
    grad.addColorStop(0.6, 'hsla(' + p.hue + ', 70%, 65%, 0.9)');
    grad.addColorStop(1, 'hsla(' + (p.hue - 20) + ', 60%, 50%, 0.4)');
    ctx.fillStyle = grad;
    ctx.fill();

    ctx.restore();
  }

  function tickSakura() {
    if (!window.sakuraEnabled) { window.sakuraAnimId = null; return; }
    // 防护: prefers-reduced-motion 时 initSakura 早退，canvas/ctx 未初始化
    if (!canvas || !ctx) return;
    // B-16: 页面不可见或 canvas 被隐藏时暂停动画循环
    if (document.hidden || (canvas.style.display === 'none')) {
      window.sakuraAnimId = null;
      return;
    }
    window.sakuraAnimId = requestAnimationFrame(tickSakura);

    var w = canvas.width;
    var h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    var isMobile = w < 540;
    var maxP = isMobile ? MOBILE_MAX : MAX_PETALS;
    if (petals.length < maxP && Math.random() < 0.35) {
      petals.push(randomPetal(w, -10));
    }

    for (var i = petals.length - 1; i >= 0; i--) {
      var p = petals[i];
      p.y += p.speed;
      p.x += p.drift + Math.sin(p.y * 0.02) * 0.3;
      p.rotation += p.rotSpeed;

      var fadeIn = Math.min(1, (p.y + 20) / 80);
      var fadeOut = 1 - Math.max(0, (p.y - h + 80) / 100);
      p.opacity = Math.min(p.opacity, fadeIn * fadeOut);

      drawPetal(ctx, p);

      if (p.y > h + 30 || p.x < -30 || p.x > w + 30) {
        petals.splice(i, 1);
      }
    }
  }

  function resizeSakura() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  }

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

    var w = canvas.width;
    var h = canvas.height;
    var isMobile = w < 540;
    var count = isMobile ? MOBILE_MAX : MAX_PETALS;
    for (var i = 0; i < count; i++) {
      petals.push(randomPetal(w, Math.random() * h));
    }
  }

  // B-16: 页面重新可见时恢复动画
  document.addEventListener('visibilitychange', function() {
    if (!document.hidden && window.sakuraEnabled && !window.sakuraAnimId) {
      window.tickSakura();
    }
  });

  window.initSakura = initSakura;
  window.tickSakura = tickSakura;
  // sakuraCanvas exposed as getter so settings.js can read it after init
  Object.defineProperty(window, '_sakuraCanvas', { get: function() { return canvas; } });
})();
