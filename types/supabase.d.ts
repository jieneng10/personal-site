// ==================== Supabase client types ====================

declare module 'supabase.mjs' {
  import type { SupabaseClient } from '@supabase/supabase-js';

  export const sb: SupabaseClient | null;
  export function sbStoragePath(userId: string, category: string, fileName: string): string;
  export function sbUpload(bucket: string, file: File, path: string): Promise<string>;
  export function sbPublicUrl(bucket: string, path: string): string | null;
  export function sbSignedUrl(bucket: string, path: string, expiresIn?: number): Promise<string | null>;
  export function sbDelete(bucket: string, paths: string | string[]): Promise<void>;
  export function escHtml(str: unknown): string;
  export function getCachedUser(): Promise<Record<string, unknown> | null>;
  export function showLoading(msg: string): void;
  export function hideLoading(): void;
  export function showToast(msg: string, type?: 'success' | 'error' | 'warn'): void;
  export function saveToLocalDB(storeName: string, entries: Record<string, unknown>[]): Promise<void>;
}
