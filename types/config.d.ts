// ==================== Config types ====================

declare module 'config.mjs' {
  export const SUPABASE_URL: string;
  export const SUPABASE_KEY: string;
  export const DB_NAME: string;
  export const DB_VERSION: number;
  export function safeSetItem(key: string, value: string): void;
}
