// ==================== Sakura Petals (Canvas) ====================
let sakuraEnabled = true;
let sakuraAnimId = null;
let sakuraCanvas, sakuraCtx;
let petals = [];
const MAX_PETALS = 40;
const MOBILE_MAX = 15;

function randomPetal(canvasW, startY) {
  const size = 8 + Math.random() * 14;
  return {
    x: Math.random() * canvasW,
    y: startY != null ? startY : -(Math.random() * canvasW),
    size: size,
    speed: 0.4 + Math.random() * 1.2,
    rotation: Math.random() * Math.PI * 2,
    rotSpeed: (Math.random() - 0.5) * 0.03,
    drift: (Math.random() - 0.5) * 0.4,
    opacity: 0.3 + Math.random() * 0.55,
    // gradient colors: light pink → deep pink
    hue: 340 + Math.random() * 20,
  };
}

function drawPetal(ctx, p) {
  const { x, y, size, rotation, opacity } = p;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rotation);
  ctx.globalAlpha = opacity;

  // Teardrop petal shape (rounded diamond)
  const w = size * 0.55;
  const h = size * 0.8;
  ctx.beginPath();
  ctx.moveTo(0, -h);
  ctx.bezierCurveTo(w, -h * 0.5, w, h * 0.3, 0, h);
  ctx.bezierCurveTo(-w, h * 0.3, -w, -h * 0.5, 0, -h);
  ctx.closePath();

  // Gradient fill
  const grad = ctx.createRadialGradient(0, -h * 0.2, size * 0.05, 0, h * 0.3, size * 0.7);
  grad.addColorStop(0, `hsla(${p.hue}, 90%, 88%, 1)`);
  grad.addColorStop(0.6, `hsla(${p.hue}, 70%, 65%, 0.9)`);
  grad.addColorStop(1, `hsla(${p.hue - 20}, 60%, 50%, 0.4)`);
  ctx.fillStyle = grad;
  ctx.fill();

  ctx.restore();
}

function tickSakura() {
  if (!sakuraEnabled) { sakuraAnimId = null; return; }
  sakuraAnimId = requestAnimationFrame(tickSakura);

  const w = sakuraCanvas.width;
  const h = sakuraCanvas.height;

  sakuraCtx.clearRect(0, 0, w, h);

  // Spawn new petals if below max
  const isMobile = w < 540;
  const maxP = isMobile ? MOBILE_MAX : MAX_PETALS;
  if (petals.length < maxP && Math.random() < 0.35) {
    petals.push(randomPetal(w, -10));
  }

  for (let i = petals.length - 1; i >= 0; i--) {
    const p = petals[i];
    p.y += p.speed;
    p.x += p.drift + Math.sin(p.y * 0.02) * 0.3;
    p.rotation += p.rotSpeed;

    // Fade in near top, fade out near bottom
    const fadeIn = Math.min(1, (p.y + 20) / 80);
    const fadeOut = 1 - Math.max(0, (p.y - h + 80) / 100);
    p.opacity = Math.min(p.opacity, fadeIn * fadeOut);

    drawPetal(sakuraCtx, p);

    // Remove off-screen petals
    if (p.y > h + 30 || p.x < -30 || p.x > w + 30) {
      petals.splice(i, 1);
    }
  }
}

function resizeSakura() {
  sakuraCanvas.width = window.innerWidth;
  sakuraCanvas.height = window.innerHeight;
}

function initSakura() {
  sakuraCanvas = document.getElementById('sakuraCanvas');
  sakuraCtx = sakuraCanvas.getContext('2d');
  resizeSakura();
  window.addEventListener('resize', resizeSakura);

  // Seed initial petals spread across screen
  const w = sakuraCanvas.width;
  const h = sakuraCanvas.height;
  const isMobile = w < 540;
  const count = isMobile ? MOBILE_MAX : MAX_PETALS;
  for (let i = 0; i < count; i++) {
    petals.push(randomPetal(w, Math.random() * h));
  }
  // Animation is started by applyAllSettings() based on user settings
}
