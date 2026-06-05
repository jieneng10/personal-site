-- ============================================================
-- jieneng 个人网站 — Supabase RLS 安全策略
-- ============================================================
-- 用法：在 Supabase Dashboard → SQL Editor 中粘贴并执行此文件
-- 首次部署：全选执行
-- 已有数据：逐段执行，遇到错误跳过即可
-- ============================================================

-- ==================== 1. 确保所有表启用 RLS ====================

ALTER TABLE IF EXISTS articles ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS user_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS user_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS avatars ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS admins ENABLE ROW LEVEL SECURITY;

-- ==================== 2. articles 表策略 ====================
-- RLS 可能已存在策略需先删后建

DO $$ BEGIN
  DROP POLICY IF EXISTS "Anyone can read published articles" ON articles;
  DROP POLICY IF EXISTS "Admins can manage articles" ON articles;
  DROP POLICY IF EXISTS "Public read published articles" ON articles;
  DROP POLICY IF EXISTS "Admin full access to articles" ON articles;
END $$;

-- 任何人可以读取已发布文章
CREATE POLICY "Anyone can read published articles"
  ON articles FOR SELECT
  USING (published = true);

-- 管理员可以增删改查所有文章（通过 admins 表判断）
CREATE POLICY "Admins can manage articles"
  ON articles FOR ALL
  USING (EXISTS (SELECT 1 FROM admins WHERE user_id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM admins WHERE user_id = auth.uid()));

-- ==================== 3. user_files 表策略 ====================

DO $$ BEGIN
  DROP POLICY IF EXISTS "Users can manage own files" ON user_files;
  DROP POLICY IF EXISTS "Select own files" ON user_files;
  DROP POLICY IF EXISTS "Insert own files" ON user_files;
  DROP POLICY IF EXISTS "Delete own files" ON user_files;
  DROP POLICY IF EXISTS "Update own files" ON user_files;
END $$;

-- 用户只能读写自己的文件
CREATE POLICY "Users can manage own files"
  ON user_files FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- ==================== 4. user_settings 表策略 ====================

DO $$ BEGIN
  DROP POLICY IF EXISTS "Users can manage own settings" ON user_settings;
  DROP POLICY IF EXISTS "Select own settings" ON user_settings;
  DROP POLICY IF EXISTS "Upsert own settings" ON user_settings;
END $$;

CREATE POLICY "Users can manage own settings"
  ON user_settings FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- ==================== 5. avatars 表策略 ====================

DO $$ BEGIN
  DROP POLICY IF EXISTS "Users can manage own avatar" ON avatars;
  DROP POLICY IF EXISTS "Public read avatars" ON avatars;
END $$;

CREATE POLICY "Users can manage own avatar"
  ON avatars FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- 头像也需要被其他人看到（网页展示时），加一条公开读策略
CREATE POLICY "Public read avatars"
  ON avatars FOR SELECT
  USING (true);

-- ==================== 6. admins 表策略 ====================

DO $$ BEGIN
  DROP POLICY IF EXISTS "Anyone can read admins" ON admins;
END $$;

CREATE POLICY "Anyone can read admins"
  ON admins FOR SELECT
  USING (true);

-- admins 表不能由普通用户写入 — 没有 INSERT/UPDATE/DELETE 策略 = 禁止

-- ==================== 7. Storage Bucket 策略（需通过 Dashboard 手动配置）====================
-- ⚠ Storage 策略无法通过 SQL Editor 执行（需要 superuser 权限）
-- 请在 Supabase Dashboard → Storage → 每个 bucket → Policies 中手动操作：
--
-- ▲ 所有公共 Bucket (wallpapers / avatars / bgm):
--   → 点 "New Policy" → "Give read access to everyone (public)"
--     (即 SELECT 权限开放给 public)
--   → 再点 "New Policy" → "Give INSERT access to authenticated users only"
--     (即 INSERT 权限仅限已登录用户)
--   → 再点 "New Policy" → "Give DELETE access to users who own the object"
--     (或选择 custom: DELETE USING (owner = auth.uid()) )
--
-- ▲ 私有 Bucket (files):
--   → 点 "New Policy" → custom policy:
--     SELECT 策略:
--       Policy name: "Owner read own files"
--       Allowed operation: SELECT
--       USING expression: (owner = auth.uid())
--     INSERT 策略:
--       Policy name: "Auth insert"
--       Allowed operation: INSERT
--       WITH CHECK expression: (auth.role() = 'authenticated')
--     DELETE 策略:
--       Policy name: "Owner delete own"
--       Allowed operation: DELETE
--       USING expression: (owner = auth.uid())
--
-- 如果已创建了错误的 storage 策略，先在 Dashboard → Storage → Policies 中删除再重新添加。
-- 执行完毕后运行以下查询验证：

-- SELECT tablename, rowsecurity FROM pg_tables
-- WHERE schemaname = 'public' AND tablename IN ('articles','user_files','user_settings','avatars','admins');
-- -- 所有 rowsecurity 应为 true

-- SELECT schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
-- FROM pg_policies WHERE schemaname = 'public'
-- ORDER BY tablename, cmd;
-- -- 应列出以上创建的所有策略

-- SELECT name, bucket_id, policies FROM storage.buckets;
-- -- 每个 bucket 的 policies 应包含对应的 storage.objects 策略
