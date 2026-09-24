import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  from: vi.fn(), insert: vi.fn(), upload: vi.fn(), remove: vi.fn(),
  storagePath: vi.fn(), user: vi.fn(), toast: vi.fn(), loading: vi.fn(), hidden: vi.fn(),
}));

vi.mock('../js/supabase.mjs', () => ({
  sb: { from: api.from },
  sbStoragePath: api.storagePath,
  sbUpload: api.upload,
  sbDelete: api.remove,
  sbPublicUrl: vi.fn(),
  sbSignedUrl: vi.fn(),
  saveToLocalDB: vi.fn(),
  getCachedUser: api.user,
  showToast: api.toast,
  showLoading: api.loading,
  hideLoading: api.hidden,
  escHtml: (value) => value,
}));
vi.mock('../js/i18n.js', () => ({ tSync: (key) => key }));

let handleFiles;
let removeFile;
let renderFileList;

beforeAll(async () => {
  global.window = document.defaultView;
  ({ handleFiles, removeFile, renderFileList } = await import('../js/cloud.js'));
});

beforeEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = '<div id="fileList"></div>';
  window._isLoggedIn = true;
  api.user.mockResolvedValue({ id: 'user-1' });
  api.storagePath.mockImplementation((_user, _category, name) => 'user-1/cloud/' + name);
  api.upload.mockResolvedValue('uploaded');
  api.remove.mockResolvedValue(undefined);
  // List refresh is separate from the mutation under test and may fail offline.
  api.from.mockImplementation(() => ({
    insert: api.insert,
    select: () => ({ eq: () => ({ eq: () => ({ order: async () => ({ error: new Error('offline') }) }) }) }),
  }));
});

const file = (name) => ({ name, size: 10, type: 'text/plain' });

describe('cloud file consistency', () => {
  it('removes the uploaded object when its database record is rejected', async () => {
    api.insert.mockResolvedValue({ error: new Error('permission denied') });

    await handleFiles([file('a.txt'), file('b.txt')]);

    expect(api.upload).toHaveBeenCalledTimes(1);
    expect(api.remove).toHaveBeenCalledWith('files', 'user-1/cloud/a.txt');
    expect(api.toast).toHaveBeenCalledWith(expect.stringContaining('permission denied'), 'error');
  });

  it('keeps a completed first file and rolls back only the failed second file', async () => {
    api.insert.mockResolvedValueOnce({ error: null }).mockResolvedValueOnce({ error: new Error('offline') });

    await handleFiles([file('a.txt'), file('b.txt')]);

    expect(api.upload).toHaveBeenCalledTimes(2);
    expect(api.remove).toHaveBeenCalledTimes(1);
    expect(api.remove).toHaveBeenCalledWith('files', 'user-1/cloud/b.txt');
  });

  it('reports a denied row deletion instead of treating the file as removed', async () => {
    api.from.mockImplementation(() => ({
      select: () => ({ eq: () => ({ eq: () => ({ single: async () => ({ data: { storage_path: 'user-1/cloud/a.txt' } }) }) }) }),
      delete: () => ({ eq: () => ({ eq: () => ({ select: async () => ({ error: new Error('delete denied') }) }) }) }),
    }));

    await removeFile(42);

    expect(api.remove).toHaveBeenCalledWith('files', 'user-1/cloud/a.txt');
    expect(api.toast).toHaveBeenCalledWith(expect.stringContaining('delete denied'), 'warn');
  });

  it('does not show the previous user’s file names after sign-out', async () => {
    let completeQuery;
    api.from.mockImplementation(() => ({
      select: () => ({ eq: () => ({ eq: () => ({
        order: () => new Promise(resolve => { completeQuery = resolve; }),
      }) }) }),
    }));
    const oldRender = renderFileList();
    await vi.waitFor(() => expect(completeQuery).toBeTypeOf('function'));
    window._isLoggedIn = false;
    await renderFileList();
    completeQuery({ data: [{ id: 1, name: 'private-name.txt', size: 10 }], error: null });
    await oldRender;
    expect(document.getElementById('fileList').textContent).not.toContain('private-name.txt');
    expect(document.getElementById('fileList').textContent).toContain('cloud.emptyLogin');
  });
});
