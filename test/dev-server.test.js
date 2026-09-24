import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createSiteServer } = require('../scripts/dev-server.js');

describe('local preview public-file boundary', () => {
  it('serves site files but blocks private drafts and project sources', async () => {
    const server = createSiteServer();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const origin = `http://127.0.0.1:${server.address().port}`;
      for (const file of ['/', '/index.html', '/data/articles.json', '/js/main.js']) {
        expect((await fetch(origin + file)).status).toBe(200);
      }
      for (const file of ['/.private/articles.json', '/%2eprivate/articles.json', '/.git/config', '/scripts/build.js', '/README.md', '/node_modules/vitest/package.json']) {
        expect((await fetch(origin + file)).status).toBe(404);
      }
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });
});
