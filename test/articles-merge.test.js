// ==================== Articles Merge Logic Tests ====================
// Tests the article data pipeline: Supabase → JSON fallback → dedup → sort.
// Source: js/articles.js (_fetchArticleData)
//
// This is the most critical data path — if merge/dedup logic breaks,
// users see duplicate articles or missing content.

import { describe, it, expect } from 'vitest';

// ---- Clone the production merge logic ----
// (Stage 0: copy-paste. Stage 1 → proper import from articles.js)

/**
 * Merge articles from Supabase and local JSON, deduplicate by id,
 * filter non-public for guests, and sort by date descending.
 *
 * @param {Array|null} supabaseRows - Articles from Supabase (published=true)
 * @param {Array|null} jsonAll      - All articles from data/articles.json
 * @param {boolean}    isLoggedIn   - Whether the user is authenticated
 * @returns {{ articles: Array, map: Record<number, object>, tags: string[] }}
 */
function fetchAndMergeArticles(supabaseRows, jsonAll, isLoggedIn) {
  const merged = [];
  const seenIds = {};
  const map = {};

  // 1. Supabase articles (already filtered to published=true by caller)
  if (supabaseRows && supabaseRows.length > 0) {
    for (const a of supabaseRows) {
      seenIds[a.id] = true;
      map[a.id] = a;
      merged.push(a);
    }
  }

  // 2. JSON fallback — skip ids already from Supabase
  if (jsonAll && jsonAll.length > 0) {
    const fromLocal = isLoggedIn
      ? jsonAll
      : jsonAll.filter(function (a) { return a.public !== false; });
    for (const a of fromLocal) {
      if (!seenIds[a.id]) {
        seenIds[a.id] = true;
        map[a.id] = a;
        merged.push(a);
      }
    }
  }

  // 3. Sort by created_at descending
  merged.sort(function (a, b) {
    return (b.created_at || '').localeCompare(a.created_at || '');
  });

  // 4. Extract unique tags
  const tagSet = {};
  for (const a of merged) {
    if (a.tags && typeof a.tags === 'string') {
      a.tags.split(',').forEach(function (t) {
        const tt = t.trim();
        if (tt) tagSet[tt] = true;
      });
    }
  }
  const tags = Object.keys(tagSet).sort();

  return { articles: merged, map, tags };
}

// ================================================================
// Tests
// ================================================================

describe('fetchAndMergeArticles', () => {

  // ---- Basic pipeline ----
  it('should merge Supabase articles with JSON fallback', () => {
    const supabase = [
      { id: 1, title: 'From Supabase', tags: 'Galgame', created_at: '2025-06-01' },
    ];
    const json = [
      { id: 2, title: 'From JSON', tags: 'OST', created_at: '2025-05-01' },
    ];
    const result = fetchAndMergeArticles(supabase, json, false);
    expect(result.articles.length).toBe(2);
    expect(result.articles[0].title).toBe('From Supabase'); // newer first
    expect(result.articles[1].title).toBe('From JSON');
  });

  // ---- Dedup: Supabase wins ----
  it('should deduplicate by id — Supabase takes priority', () => {
    const supabase = [
      { id: 1, title: 'Cloud Version', tags: 'Galgame', created_at: '2025-06-01' },
    ];
    const json = [
      { id: 1, title: 'Local Version', tags: 'OST', created_at: '2025-05-01' },
    ];
    const result = fetchAndMergeArticles(supabase, json, false);
    expect(result.articles.length).toBe(1);
    expect(result.articles[0].title).toBe('Cloud Version');
  });

  // ---- Guest filter: hide non-public ----
  it('should hide public=false articles for guests', () => {
    const json = [
      { id: 1, title: 'Public Article', public: true, tags: '', created_at: '2025-06-01' },
      { id: 2, title: 'Private Draft', public: false, tags: '', created_at: '2025-05-01' },
    ];
    const result = fetchAndMergeArticles(null, json, false);
    expect(result.articles.length).toBe(1);
    expect(result.articles[0].title).toBe('Public Article');
  });

  it('should show all articles (including public=false) for logged-in users', () => {
    const json = [
      { id: 1, title: 'Public', public: true, tags: '', created_at: '2025-06-01' },
      { id: 2, title: 'Draft', public: false, tags: '', created_at: '2025-05-01' },
    ];
    const result = fetchAndMergeArticles(null, json, true);
    expect(result.articles.length).toBe(2);
  });

  // ---- Sort order ----
  it('should sort articles by created_at descending', () => {
    const json = [
      { id: 1, title: 'Old', tags: '', created_at: '2025-01-01' },
      { id: 2, title: 'New', tags: '', created_at: '2025-12-31' },
      { id: 3, title: 'Mid', tags: '', created_at: '2025-06-15' },
    ];
    const result = fetchAndMergeArticles(null, json, false);
    expect(result.articles[0].title).toBe('New');
    expect(result.articles[1].title).toBe('Mid');
    expect(result.articles[2].title).toBe('Old');
  });

  // ---- Tag extraction ----
  it('should extract unique sorted tags from all articles', () => {
    const json = [
      { id: 1, title: 'A', tags: 'Galgame, 评测', created_at: '2025-06-01' },
      { id: 2, title: 'B', tags: 'OST, Galgame', created_at: '2025-05-01' },
    ];
    const result = fetchAndMergeArticles(null, json, false);
    expect(result.tags).toEqual(['Galgame', 'OST', '评测']);
  });

  it('should handle empty tags gracefully', () => {
    const json = [
      { id: 1, title: 'No Tags', tags: '', created_at: '2025-06-01' },
      { id: 2, title: 'Also None', tags: null, created_at: '2025-05-01' },
    ];
    const result = fetchAndMergeArticles(null, json, false);
    expect(result.tags).toEqual([]);
  });

  // ---- Edge cases ----
  it('should handle no articles at all', () => {
    const result = fetchAndMergeArticles(null, null, false);
    expect(result.articles).toEqual([]);
    expect(result.tags).toEqual([]);
    expect(Object.keys(result.map).length).toBe(0);
  });

  it('should handle Supabase returning empty array', () => {
    const json = [
      { id: 1, title: 'Only JSON', tags: 'Test', created_at: '2025-06-01' },
    ];
    const result = fetchAndMergeArticles([], json, false);
    expect(result.articles.length).toBe(1);
    expect(result.articles[0].title).toBe('Only JSON');
  });

  it('should handle Supabase error (null)', () => {
    const json = [
      { id: 1, title: 'Fallback Works', tags: 'Test', created_at: '2025-06-01' },
    ];
    const result = fetchAndMergeArticles(null, json, false);
    expect(result.articles.length).toBe(1);
    expect(result.articles[0].title).toBe('Fallback Works');
  });

  // ---- id variability ----
  it('should handle numeric and string ids consistently', () => {
    const supabase = [
      { id: 1, title: 'S1', tags: '', created_at: '2025-06-01' },
      { id: '2', title: 'S2', tags: '', created_at: '2025-06-02' },
    ];
    const json = [
      { id: 1, title: 'Should be deduped', tags: '', created_at: '2025-01-01' },
      { id: '2', title: 'Also deduped', tags: '', created_at: '2025-01-01' },
    ];
    const result = fetchAndMergeArticles(supabase, json, false);
    expect(result.articles.length).toBe(2);
    expect(result.articles[0].title).toBe('S2');
  });

  // ---- map integrity ----
  it('should build a complete id→article map', () => {
    const json = [
      { id: 1, title: 'Article 1', content: 'Content 1', tags: 'A', created_at: '2025-06-01' },
      { id: 5, title: 'Article 5', content: 'Content 5', tags: 'B', created_at: '2025-06-02' },
    ];
    const result = fetchAndMergeArticles(null, json, false);
    expect(result.map[1].content).toBe('Content 1');
    expect(result.map[5].content).toBe('Content 5');
    expect(result.map[99]).toBeUndefined();
  });
});
