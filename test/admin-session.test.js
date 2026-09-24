import { expect, test, vi } from 'vitest';
import { JSDOM } from 'jsdom';

const queries = vi.hoisted(() => ({ pending: [] }));

vi.mock('../js/supabase.mjs', () => ({
  sb: {
    from() {
      return {
        select() { return this; },
        eq() { return this; },
        order() { return this; },
        then(resolve) { queries.pending.push(() => resolve({ data: [], error: null })); },
      };
    },
  },
  sbPublicUrl: vi.fn(), getCachedUser: vi.fn(), showLoading: vi.fn(),
  hideLoading: vi.fn(), showToast: vi.fn(), escHtml: value => String(value),
  sbStoragePath: vi.fn(), sbUpload: vi.fn(), sbDelete: vi.fn(),
}));

test('pending admin lists cannot reappear after sign-out', async () => {
  const dom = new JSDOM(`<!doctype html><body>
    <div id="adminArticleList"></div><div id="adminPendingList"></div>
    <div id="adminWallpaperList"></div><div id="adminTrackList"></div>
    <div id="adminNewsList"></div><span id="adminPendingCount"></span>
  </body>`, { url: 'http://localhost/' });
  const oldWindow = globalThis.window;
  const oldDocument = globalThis.document;
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;

  try {
    const { emit } = await import('../js/event-bus.mjs');
    await import('../js/admin.js');
    dom.window._isAdmin = true;
    dom.window._reloadAdminData();
    await vi.waitFor(() => expect(queries.pending).toHaveLength(5));

    dom.window._isAdmin = false;
    emit('auth:logout');
    const lists = [...dom.window.document.querySelectorAll('[id^="admin"][id$="List"]')];
    lists.forEach(list => { list.textContent = ''; });
    queries.pending.splice(0).forEach(resolve => resolve());
    await new Promise(resolve => setTimeout(resolve, 0));

    lists.forEach(list => expect(list.textContent).toBe(''));
  } finally {
    globalThis.window = oldWindow;
    globalThis.document = oldDocument;
    dom.window.close();
  }
});
