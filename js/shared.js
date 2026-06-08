// ==================== Shared Constants ====================
// Single source of truth — every page includes this file so keys stay in sync.

/**
 * @fileoverview Global constants shared across all modules.
 *
 * @typedef  {import('@supabase/supabase-js').SupabaseClient} SupabaseClient
 */

(function() {
  /** @type {string} Supabase project URL */
  var SUPABASE_URL = 'https://nskircwzcsmbkispshif.supabase.co';

  /** @type {string} Supabase anonymous key (safe for client-side) */
  var SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5za2lyY3d6Y3NtYmtpc3BzaGlmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkxMDY0MzYsImV4cCI6MjA5NDY4MjQzNn0.jZESXIc71IAVcCEY7nLGJvpPF2XIvm-hyb6-DOKfiE0';

  /** @type {string} IndexedDB database name */
  var DB_NAME = 'PersonalSiteDB';

  /** @type {number} IndexedDB schema version */
  var DB_VERSION = 1;

  // ---- window exports ----
  /** @type {string} */
  window.SUPABASE_URL = SUPABASE_URL;

  /** @type {string} */
  window.SUPABASE_KEY = SUPABASE_KEY;

  /** @type {string} */
  window.DB_NAME = DB_NAME;

  /** @type {number} */
  window.DB_VERSION = DB_VERSION;
})();
