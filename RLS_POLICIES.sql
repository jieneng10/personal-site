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

-- 3a. 添加 published 列（游客上传需审核）
ALTER TABLE user_files ADD COLUMN IF NOT EXISTS published BOOLEAN DEFAULT true;

DO $$ BEGIN
  DROP POLICY IF EXISTS "Users can manage own files" ON user_files;
  DROP POLICY IF EXISTS "Select own files" ON user_files;
  DROP POLICY IF EXISTS "Insert own files" ON user_files;
  DROP POLICY IF EXISTS "Delete own files" ON user_files;
  DROP POLICY IF EXISTS "Update own files" ON user_files;
  DROP POLICY IF EXISTS "public_read_wallpapers_bgm" ON user_files;
  DROP POLICY IF EXISTS "anon_insert_wallpapers_bgm" ON user_files;
  DROP POLICY IF EXISTS "authenticated_read_user_files" ON user_files;
  DROP POLICY IF EXISTS "admin_read_all_files" ON user_files;
  DROP POLICY IF EXISTS "admin_manage_all_files" ON user_files;
  DROP POLICY IF EXISTS "authenticated_insert_own_files" ON user_files;
  DROP POLICY IF EXISTS "authenticated_manage_own_files" ON user_files;
END $$;

-- 游客可读取已发布的壁纸和 BGM
CREATE POLICY "public_read_wallpapers_bgm" ON user_files
  FOR SELECT TO anon
  USING (category IN ('wallpaper', 'bgm') AND published = true);

-- 游客可投稿壁纸/BGM（待审核，published = false）
-- ⚠ 必须强制 published = false，否则攻击者可传 published=true 绕过审核
--    因为 user_files.published 列默认值为 true（见本文件第 41 行）
CREATE POLICY "anon_insert_wallpapers_bgm" ON user_files
  FOR INSERT TO anon
  WITH CHECK (category IN ('wallpaper', 'bgm') AND published = false);

-- 已登录用户可读取自己的文件 + 所有人已发布的
CREATE POLICY "authenticated_read_user_files" ON user_files
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id OR (category IN ('wallpaper', 'bgm') AND published = true));

-- 管理员可读取所有文件（含待审核）
CREATE POLICY "admin_read_all_files" ON user_files
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM admins WHERE user_id = auth.uid()));

-- 管理员可修改/删除所有文件
CREATE POLICY "admin_manage_all_files" ON user_files
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM admins WHERE user_id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM admins WHERE user_id = auth.uid()));

-- 已登录用户可写入自己的文件
CREATE POLICY "authenticated_insert_own_files" ON user_files
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);

-- 已登录用户可管理自己的文件
CREATE POLICY "authenticated_manage_own_files" ON user_files
  FOR ALL TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- ==================== 4. user_settings 表策略 ====================

-- 确保 user_settings 表存在且有 user_id 唯一约束（upsert onConflict 需要）
CREATE TABLE IF NOT EXISTS user_settings (
  id SERIAL PRIMARY KEY,
  user_id UUID NOT NULL,
  settings JSONB DEFAULT '{}',
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- 添加唯一约束（幂等——已存在则跳过）
DO $$ BEGIN
  ALTER TABLE user_settings ADD CONSTRAINT user_settings_user_id_key UNIQUE (user_id);
EXCEPTION WHEN duplicate_table THEN NULL;
END $$;

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

CREATE TABLE IF NOT EXISTS avatars (
  id SERIAL PRIMARY KEY,
  user_id UUID NOT NULL,
  storage_path TEXT NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now()
);

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

-- 仅允许已认证用户查询自己是否在管理员表中
-- 其他表的 EXISTS (SELECT 1 FROM admins WHERE user_id = auth.uid()) 子查询
-- 会继承此 RLS 策略，因此 auth.uid() = user_id
-- 既保护了管理员身份隐私，又不影响管理员权限判定
CREATE POLICY "Users can check own admin status"
  ON admins FOR SELECT
  USING (auth.uid() = user_id);

-- admins 表不能由普通用户写入 — 没有 INSERT/UPDATE/DELETE 策略 = 禁止

-- ==================== 7. anime_news 表 ====================

-- 7a. 建表
CREATE TABLE IF NOT EXISTS anime_news (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  summary TEXT DEFAULT '',
  content TEXT DEFAULT '',
  source TEXT DEFAULT '',
  url TEXT DEFAULT '',
  news_date DATE DEFAULT CURRENT_DATE,
  pinned BOOLEAN DEFAULT false,
  heat INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- 如果表已存在但缺少列
ALTER TABLE anime_news ADD COLUMN IF NOT EXISTS content TEXT DEFAULT '';
ALTER TABLE anime_news ADD COLUMN IF NOT EXISTS pinned BOOLEAN DEFAULT false;
ALTER TABLE anime_news ADD COLUMN IF NOT EXISTS heat INTEGER DEFAULT 0;

ALTER TABLE anime_news ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  DROP POLICY IF EXISTS "public_read_news" ON anime_news;
  DROP POLICY IF EXISTS "admin_manage_news" ON anime_news;
END $$;

-- 任何人可读取资讯
CREATE POLICY "public_read_news" ON anime_news
  FOR SELECT USING (true);

-- 管理员可管理资讯（增删改）
-- ⚠ FOR ALL 必须指定 TO authenticated，否则匿名用户也能命中此策略
--    PostgreSQL RLS 对 INSERT 只看 WITH CHECK，不看 USING
--    因此 WITH CHECK 必须也校验管理员身份，不能写 true
CREATE POLICY "admin_manage_news" ON anime_news
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM admins WHERE user_id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM admins WHERE user_id = auth.uid()));

-- ==================== 8. Storage Bucket 策略（需通过 Dashboard 手动配置）====================
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
-- WHERE schemaname = 'public' AND tablename IN ('articles','user_files','user_settings','avatars','admins','anime_news');
-- -- 所有 rowsecurity 应为 true

-- SELECT schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
-- FROM pg_policies WHERE schemaname = 'public'
-- ORDER BY tablename, cmd;
-- -- 应列出以上创建的所有策略

-- SELECT name, bucket_id, policies FROM storage.buckets;

-- ==================== 7. comments 表策略 ====================

-- 创建评论表
CREATE TABLE IF NOT EXISTS comments (
  id BIGSERIAL PRIMARY KEY,
  article_id BIGINT REFERENCES articles(id) ON DELETE CASCADE, -- 绑定文章（NULL = 留言板通用）
  parent_id BIGINT REFERENCES comments(id) ON DELETE CASCADE,   -- 回复某条评论（NULL = 顶级评论）
  author_name TEXT NOT NULL DEFAULT '匿名',                      -- 显示名称
  content TEXT NOT NULL,                                         -- 评论内容（最多 2000 字）
  published BOOLEAN NOT NULL DEFAULT false,                      -- 游客评论需审核
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,     -- 登录用户关联
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- 6. comments — 留言板 / 文章评论区
-- ============================================================
CREATE TABLE IF NOT EXISTS comments (
  id bigint generated always as identity primary key,
  article_id bigint references articles(id) on delete cascade,
  parent_id  bigint references comments(id) on delete cascade,
  user_id    uuid references auth.users(id) on delete set null,
  author_name text not null default '匿名',
  content    text not null,
  published  boolean not null default false,
  created_at timestamptz not null default now()
);

ALTER TABLE comments ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  DROP POLICY IF EXISTS "Anyone can read published comments" ON comments;
  DROP POLICY IF EXISTS "Authenticated users can insert" ON comments;
  DROP POLICY IF EXISTS "Anonymous can insert pending" ON comments;
  DROP POLICY IF EXISTS "Admins can manage all comments" ON comments;
  DROP POLICY IF EXISTS "Users can delete own comments" ON comments;
END $$;

-- 任何人可以读取已审核通过的评论
CREATE POLICY "Anyone can read published comments" ON comments
  FOR SELECT
  USING (published = true);

-- 登录用户可以直接发布（自动通过审核）
CREATE POLICY "Authenticated users can insert" ON comments
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id AND published = true);

-- 游客可以提交评论（待审核）
-- ⚠ 强制 user_id IS NULL，防止攻击者伪造评论关联到其他用户
CREATE POLICY "Anonymous can insert pending" ON comments
  FOR INSERT TO anon
  WITH CHECK (published = false AND user_id IS NULL);

-- 管理员可以管理所有评论
CREATE POLICY "Admins can manage all comments" ON comments
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM admins WHERE user_id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM admins WHERE user_id = auth.uid()));

-- 登录用户可以删除自己的评论
CREATE POLICY "Users can delete own comments" ON comments
  FOR DELETE TO authenticated
  USING (user_id = auth.uid());
-- -- 每个 bucket 的 policies 应包含对应的 storage.objects 策略
