import { expect, test, vi } from 'vitest';
import { JSDOM } from 'jsdom';

const queries = vi.hoisted(() => ({ resolve: null }));

vi.mock('../js/supabase.mjs', () => ({
  sb: {
    from() {
      return {
        select() { return this; },
        eq() { return this; },
        limit() { return this; },
        then(resolve) { queries.resolve = resolve; },
      };
    },
  },
  getCachedUser: vi.fn(async () => ({ id: 'user-a' })),
  showLoading: vi.fn(), hideLoading: vi.fn(), showToast: vi.fn(),
  saveToLocalDB: vi.fn(), escHtml: value => String(value),
}));
vi.mock('../js/i18n.js', () => ({ tSync: key => key }));

test('a signed-out account cannot overwrite local settings with a late cloud response', async () => {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' });
  const oldWindow = globalThis.window;
  const oldDocument = globalThis.document;
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;

  try {
    dom.window._isLoggedIn = true;
    dom.window.localStorage.setItem('siteSettings', JSON.stringify({ nickname: 'local' }));
    const { emit } = await import('../js/event-bus.mjs');
    const { syncSettingsFromCloud } = await import('../js/settings.js');
    const pending = syncSettingsFromCloud();
    await vi.waitFor(() => expect(queries.resolve).toBeTypeOf('function'));

    dom.window._isLoggedIn = false;
    emit('auth:logout');
    queries.resolve({ data: [{ settings: { nickname: 'old account' } }], error: null });
    await pending;

    expect(JSON.parse(dom.window.localStorage.getItem('siteSettings')).nickname).toBe('local');
  } finally {
    globalThis.window = oldWindow;
    globalThis.document = oldDocument;
    dom.window.close();
  }
});
