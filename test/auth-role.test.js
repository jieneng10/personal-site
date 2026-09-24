import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const source = readFileSync(new URL('../js/supabase.js', import.meta.url), 'utf8');

function setup(query) {
  const dom = new JSDOM(`<!doctype html><body>
    <button id="btnLock"></button><button id="btnMoreLogin"></button>
    <div id="adminBadge" class="hidden" style="display:none"></div>
    <div class="auth-only" style="display:none"></div>
    <div class="admin-only" style="display:none"></div>
  </body>`, { url: 'http://localhost/', runScripts: 'outside-only' });
  const { window } = dom;
  let authChanged;
  const events = [];
  const reload = vi.fn();
  window.SUPABASE_URL = 'https://example.supabase.co';
  window.SUPABASE_KEY = 'test-key';
  window.EventBus = { emit: (name, value) => events.push([name, value]) };
  window.supabase = { createClient: () => ({
    auth: { onAuthStateChange: callback => { authChanged = callback; } },
    from: table => {
      expect(table).toBe('admins');
      return { select: () => ({ eq: () => ({ maybeSingle: query }) }) };
    },
  }) };
  window.eval(source);
  window._reloadAdminData = reload;
  return { window, events, reload, authChanged };
}

describe('verified admin UI', () => {
  it('keeps normal signed-in users out and shows admin controls only after role verification', async () => {
    let role = false;
    const { window, events, reload } = setup(async () => ({ data: role ? { user_id: 'u1' } : null, error: null }));
    window._isLoggedIn = true;
    expect(await window._refreshAdminStatus('u1')).toBe(false);
    expect(window.document.querySelector('.auth-only').style.display).toBe('');
    expect(window.document.querySelector('.admin-only').style.display).toBe('none');
    expect(window.document.getElementById('adminBadge').classList.contains('hidden')).toBe(true);
    role = true;
    expect(await window._refreshAdminStatus('u1')).toBe(true);
    expect(window.document.querySelector('.admin-only').style.display).toBe('');
    expect(window.document.getElementById('adminBadge').classList.contains('hidden')).toBe(false);
    expect(events).toContainEqual(['auth:role', true]);
    expect(reload).toHaveBeenCalledOnce();
  });

  it('discards a pending role check after sign-out', async () => {
    let finish;
    const { window, authChanged } = setup(() => new Promise(resolve => { finish = resolve; }));
    window._isLoggedIn = true;
    const pending = window._refreshAdminStatus('u1');
    authChanged('SIGNED_OUT');
    finish({ data: { user_id: 'u1' }, error: null });
    expect(await pending).toBe(false);
    expect(window._isAdmin).toBe(false);
    expect(window.document.querySelector('.admin-only').style.display).toBe('none');
  });
});
