// ==================== Cache types ====================

declare module 'cache.mjs' {
  interface Cache<T> {
    get(forceRefresh?: boolean): Promise<T>;
    invalidate(): void;
  }
  export function createCache<T>(fetchFn: () => Promise<T>, ttlMs: number): Cache<T>;
}
