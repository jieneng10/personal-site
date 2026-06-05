// ==================== Shared Constants ====================
// 单例来源：所有页面引用此文件避免 key 重复
(function() {
  var SUPABASE_URL = 'https://nskircwzcsmbkispshif.supabase.co';
  var SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5za2lyY3d6Y3NtYmtpc3BzaGlmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkxMDY0MzYsImV4cCI6MjA5NDY4MjQzNn0.jZESXIc71IAVcCEY7nLGJvpPF2XIvm-hyb6-DOKfiE0';

  // IndexedDB 统一配置
  var DB_NAME = 'PersonalSiteDB';
  var DB_VERSION = 1;

  window.SUPABASE_URL = SUPABASE_URL;
  window.SUPABASE_KEY = SUPABASE_KEY;
  window.DB_NAME = DB_NAME;
  window.DB_VERSION = DB_VERSION;
})();
