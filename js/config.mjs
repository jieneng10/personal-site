// ==================== Config — ES Module re-exports ====================
// Canonical constants. Also set on window by js/shared.js for IIFE compat.

export const SUPABASE_URL = 'https://nskircwzcsmbkispshif.supabase.co';
export const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5za2lyY3d6Y3NtYmtpc3BzaGlmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkxMDY0MzYsImV4cCI6MjA5NDY4MjQzNn0.jZESXIc71IAVcCEY7nLGJvpPF2XIvm-hyb6-DOKfiE0';
export const DB_NAME = 'PersonalSiteDB';
export const DB_VERSION = 1;

export function safeSetItem(key, value) {
  try { localStorage.setItem(key, value); }
  catch (e) { console.warn('[storage] 写入失败:', key, e); }
}
