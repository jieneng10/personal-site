import { beforeEach, describe, expect, it, vi } from 'vitest';

let response;
let query;

beforeEach(() => {
  vi.resetModules();
  document.body.innerHTML = '<form id="commentForm"><textarea id="commentInput"></textarea></form>' +
    '<div id="commentsList"></div><div id="replyIndicator"></div>';
  response = { data: [], error: null };
  query = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    is: vi.fn().mockReturnThis(),
    delete: vi.fn().mockReturnThis(),
    insert: vi.fn(() => Promise.resolve({ error: null })),
    then(resolve, reject) { return Promise.resolve(response).then(resolve, reject); },
  };
  globalThis.window = {
    sb: { from: vi.fn(() => query) },
    escHtml: value => String(value),
    getCachedUser: vi.fn(() => Promise.resolve(null)),
    showToast: vi.fn(),
    _isAdmin: false,
  };
  globalThis.confirm = vi.fn(() => true);
});

describe('评论权限与失败状态', () => {
  it('查询报错时显示失败，而不是“暂无评论”', async () => {
    response = { data: null, error: new Error('database unavailable') };
    const { initComments } = await import('../js/comments.js');
    await initComments(null);
    expect(document.getElementById('commentsList').textContent).toContain('comments.loadFailed');
    expect(document.getElementById('commentsList').textContent).not.toContain('comments.empty');
  });

  it('权限撤销后立即移除删除入口，并拒绝旧按钮的点击', async () => {
    response = { data: [{ id: 7, author_name: 'A', content: 'hello', published: true }], error: null };
    window._isAdmin = true;
    const { initComments } = await import('../js/comments.js');
    const { emit } = await import('../js/event-bus.mjs');
    await initComments(null);
    const staleButton = document.querySelector('[data-delete-comment]');
    expect(staleButton).not.toBeNull();

    window._isAdmin = false;
    staleButton.click();
    expect(query.delete).not.toHaveBeenCalled();
    emit('auth:role', false);
    expect(document.querySelector('[data-delete-comment]')).toBeNull();
  });
});
