import { readFileSync } from 'node:fs';
import { test, expect } from 'vitest';

test('published fallback data never contains private drafts', () => {
  const articles = JSON.parse(readFileSync(new URL('../data/articles.json', import.meta.url), 'utf8'));
  expect(articles.length).toBeGreaterThan(0);
  expect(articles.every(article => article.public === true)).toBe(true);
});
