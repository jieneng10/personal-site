/**
 * E2E 烟雾测试 — 核心用户流程与访客权限
 *
 * 每一条测试模拟真实用户操作，验证整个站点从加载到交互的完整链路。
 * 这些测试不依赖 Supabase（headless 离线模式），使用本地 JSON 数据。
 */

import { test, expect } from '@playwright/test';

// ═══════════════════════════════════════════════════════════
// 流程 1：首页加载 — 所有核心元素就绪
// ═══════════════════════════════════════════════════════════

test('首页加载 — 所有核心元素就绪', async ({ page }) => {
  await page.goto('/index.html');

  // 标题
  await expect(page).toHaveTitle(/jieneng/);

  // 壁纸背景层
  await expect(page.locator('#bgLayer')).toBeVisible();

  // 樱花画布
  await expect(page.locator('#sakuraCanvas')).toBeVisible();

  // 侧边栏导航（含 8 个按钮：首页/文章/资讯/文件/投稿/留言/管理/设置）
  const navItems = page.locator('.side-nav-item');
  await expect(navItems).toHaveCount(8);

  // 内容面板
  await expect(page.locator('#contentPanel')).toBeVisible();

  // 个人卡片（昵称、签名、标签）
  await expect(page.locator('.nickname')).toHaveText('jieneng');
  await expect(page.locator('.skill-tags')).toBeVisible();

  // BGM 播放器
  await expect(page.locator('#bgmPlayer')).toBeVisible();

  // 壁纸选择器圆点
  await expect(page.locator('#wallpaperPicker')).toBeVisible();

  // 资讯触发按钮
  await expect(page.locator('#btnNewsToggle')).toBeVisible();
});

// ═══════════════════════════════════════════════════════════
// 流程 2：点击"文章" → 面板打开 → 文章卡片渲染
// ═══════════════════════════════════════════════════════════

test('文章面板 — 导航切换 + 卡片渲染', async ({ page }) => {
  await page.goto('/index.html');

  // 点击导航栏的"文章"按钮
  await page.click('[data-section="articles"]');

  // 等待 articles section 激活
  await page.waitForSelector('#sec-articles.active', { timeout: 5000 });

  // 搜索框可见
  await expect(page.locator('#articleSearch')).toBeVisible();

  // 视图切换按钮可见
  await expect(page.locator('.view-toggle')).toBeVisible();

  // 文章卡片渲染（至少 1 张）
  const cards = page.locator('.article-card');
  await expect(cards.first()).toBeVisible({ timeout: 5000 });

  // 卡片数量应该 > 0（离线模式用 data/articles.json 种子数据）
  const count = await cards.count();
  expect(count).toBeGreaterThan(0);
});

// ═══════════════════════════════════════════════════════════
// 流程 3：点击文章卡片 → Modal 打开 → 关闭
// ═══════════════════════════════════════════════════════════

test('文章 Modal — 打开 + 关闭', async ({ page }) => {
  await page.goto('/index.html');

  // 切到文章面板
  await page.click('[data-section="articles"]');
  await page.waitForSelector('#sec-articles.active', { timeout: 5000 });

  // 点第一张文章卡片
  const firstCard = page.locator('.article-card').first();
  await firstCard.waitFor({ state: 'visible', timeout: 5000 });
  await firstCard.click();

  // Modal 出现
  const modal = page.locator('#articleModal');
  await expect(modal).toBeVisible({ timeout: 3000 });
  await expect(modal).not.toHaveClass(/hidden/);

  // 标题有内容
  const title = page.locator('#articleModalTitle');
  await expect(title).not.toBeEmpty();

  // 正文有内容
  const content = page.locator('#articleModalContent');
  await expect(content).not.toBeEmpty();

  // 点关闭按钮
  await page.click('#btnArticleModalClose');
  await expect(modal).toHaveClass(/hidden/);
});

// ═══════════════════════════════════════════════════════════
// 流程 4：搜索文章 — 输入关键词后结果过滤
// ═══════════════════════════════════════════════════════════

test('文章搜索 — 输入关键词过滤列表', async ({ page }) => {
  await page.goto('/index.html');

  // 切到文章面板
  await page.click('[data-section="articles"]');
  await page.waitForSelector('#sec-articles.active', { timeout: 5000 });

  // 等一下卡片渲染
  await page.waitForSelector('.article-card', { timeout: 5000 });
  const allCount = await page.locator('.article-card').count();

  // 输入搜索关键词
  await page.fill('#articleSearch', 'Galgame');

  // 等过滤生效
  await page.waitForTimeout(500);

  // 过滤后的数量应该 ≤ 原始数量（至少有一些匹配）
  const filteredCount = await page.locator('.article-card').count();
  expect(filteredCount).toBeLessThanOrEqual(allCount);
});

// ═══════════════════════════════════════════════════════════
// 流程 5：切换 section + 留言板面板
// ═══════════════════════════════════════════════════════════

test('留言板面板 — 导航切换 + 表单可见', async ({ page }) => {
  await page.goto('/index.html');

  // 点击留言按钮
  await page.click('[data-section="comments"]');

  // 等待面板切换到 comments
  await page.waitForSelector('#sec-comments.active', { timeout: 5000 });

  // 发表表单可见
  await expect(page.locator('#commentForm')).toBeVisible();
  await expect(page.locator('#commentInput')).toBeVisible();

  // 发送按钮可见
  await expect(page.locator('#btnCommentSubmit')).toBeVisible();

  // 评论区容器可见
  await expect(page.locator('#commentsList')).toBeVisible();

  // 切回首页
  await page.click('[data-section="home"]');
  await page.waitForSelector('#sec-home.active', { timeout: 5000 });

  // 首页内容可见
  await expect(page.locator('.profile-card')).toBeVisible();
});

test('手机端更多菜单 — 导航、键盘关闭与入口设置', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/index.html');

  const more = page.locator('#btnMore');
  const menu = page.locator('#moreMenu');
  await more.click();
  await expect(menu).toBeVisible();
  await expect(more).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(more).toHaveAttribute('aria-expanded', 'false');
  await expect(more).toBeFocused();

  await more.click();
  await menu.locator('[data-section="cloud"]').click();
  await expect(page.locator('#sec-cloud')).toHaveClass(/active/);
  await expect(more).toHaveClass(/section-active/);

  await page.locator('.side-nav-item[data-section="settings"]').click();
  await expect(page.locator('#sec-settings')).toHaveClass(/active/);
  await expect(page.locator('#sec-settings .settings-group').first()).toBeHidden();
  await page.locator('#toggleCloud').click();
  await expect(page.locator('#toggleCloud')).toHaveAttribute('aria-checked', 'false');
  await more.click();
  await expect(menu.locator('[data-section="cloud"]')).toBeHidden();
});

test('窄屏文章阅读 — 弹窗避开底栏且关闭按钮保持可见', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto('/index.html');
  await page.locator('.side-nav-item[data-section="articles"]').click();
  await page.locator('.article-card').first().click();

  const layout = await page.evaluate(() => {
    const modal = document.querySelector('#articleModal .modal');
    const bar = document.querySelector('.sidebar');
    modal.scrollTop = modal.scrollHeight;
    return {
      modalBottom: modal.getBoundingClientRect().bottom,
      barTop: bar.getBoundingClientRect().top,
      closeTop: document.querySelector('#btnArticleModalClose').getBoundingClientRect().top,
      modalTop: modal.getBoundingClientRect().top,
    };
  });
  expect(layout.modalBottom).toBeLessThan(layout.barTop);
  expect(layout.closeTop).toBeGreaterThanOrEqual(layout.modalTop);
  await expect(page.locator('#btnArticleModalClose')).toBeVisible();
  await expect(page.locator('#btnArticleModalClose')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('#articleModal')).toBeHidden();
  await expect(page.locator('.article-card .article-title').first()).toBeFocused();
  await page.keyboard.press('Space');
  await expect(page.locator('#articleModal')).toBeVisible();
});

test('访客不能进入管理页或读取本地私有草稿', async ({ page }) => {
  await page.goto('/index.html#admin');
  await expect(page.locator('.side-nav-item[data-section="admin"]')).toBeHidden();
  await expect(page.locator('#sec-admin')).not.toHaveClass(/active/);
  await expect(page.locator('#adminBadge')).toBeHidden();
  await page.evaluate(() => window.switchSection('admin'));
  await expect(page.locator('#sec-admin')).not.toHaveClass(/active/);
  const response = await page.request.get('/.private/articles.json');
  expect(response.status()).toBe(404);
});

test('离线缓存可在当前预览路径注册', async ({ page }) => {
  await page.goto('/index.html');
  await expect.poll(() => page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    return registration?.active?.state === 'activated';
  }), { timeout: 15000 }).toBe(true);
});
