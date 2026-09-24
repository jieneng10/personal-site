-- ============================================================
-- jieneng 个人网站 — Supabase RLS 安全策略
-- ============================================================
-- 用法：在 Supabase Dashboard → SQL Editor 中粘贴并执行此文件
-- 首次部署：全选执行
-- 已有数据：先备份，执行后检查每段结果；遇到错误先排查，不要跳过
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
  DROP POLICY IF EXISTS "Anyone can submit pending articles" ON articles;
END $$;

-- 任何人可以读取已发布文章
CREATE POLICY "Anyone can read published articles"
  ON articles FOR SELECT
  USING (published = true);

-- 投稿只允许进入待审核状态；管理员可通过下方管理策略发布。
CREATE POLICY "Anyone can submit pending articles"
  ON articles FOR INSERT TO anon, authenticated
  WITH CHECK (published = false);

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
  WITH CHECK (
    category IN ('wallpaper', 'bgm')
    AND published = false
    AND user_id IS NULL
    AND storage_path LIKE 'guest/%'
  );

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

-- 添加唯一约束（按约束名判断，重复执行时跳过）
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.user_settings'::regclass
      AND conname = 'user_settings_user_id_key'
  ) THEN
    ALTER TABLE public.user_settings ADD CONSTRAINT user_settings_user_id_key UNIQUE (user_id);
  END IF;
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

-- 头像按 user_id 更新；若旧库已有重复用户记录，先人工核对并合并，避免误删文件。
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM public.avatars WHERE user_id IS NOT NULL
    GROUP BY user_id HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'avatars 存在重复 user_id；请先核对并合并记录，再添加唯一约束';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.avatars'::regclass
      AND conname = 'avatars_user_id_key'
  ) THEN
    ALTER TABLE public.avatars ADD CONSTRAINT avatars_user_id_key UNIQUE (user_id);
  END IF;
END $$;

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
  DROP POLICY IF EXISTS "Users can check own admin status" ON admins;
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

-- ==================== 8. Storage Bucket 策略 ====================
-- 先在 Dashboard 建立 wallpapers / bgm / avatars（public）与 files（private）bucket。
-- 这些是 storage.objects 的 RLS 策略，不直接增删对象；文件必须经 Storage API 操作。
-- 已有项目先检查 pg_policies 中的旧策略：Postgres 的多条 permissive 策略以 OR 合并，
-- 不能只添加下列策略而保留允许任意上传/删除的宽松旧策略。
-- public bucket 的对象凭 URL 可直接读取；published=false 仅阻止网站列表展示，
-- 不提供文件保密性。guest/ 匿名上传只能用于非机密的待审核媒体。

DROP POLICY IF EXISTS "site_guest_pending_media_upload" ON storage.objects;
DROP POLICY IF EXISTS "site_member_upload" ON storage.objects;
DROP POLICY IF EXISTS "site_member_read_own_objects" ON storage.objects;
DROP POLICY IF EXISTS "site_admin_read_media_objects" ON storage.objects;
DROP POLICY IF EXISTS "site_member_delete_own_objects" ON storage.objects;
DROP POLICY IF EXISTS "site_admin_delete_media_objects" ON storage.objects;

-- 游客只能把待审核图片/音频上传到对应公共 bucket 的 guest/ 路径。
-- 扩展名白名单只能减少误用；还需在 bucket 设置中限制 MIME 类型和大小。
CREATE POLICY "site_guest_pending_media_upload" ON storage.objects
  FOR INSERT TO anon
  WITH CHECK (
    ((bucket_id = 'wallpapers' AND lower(storage.extension(name)) IN ('jpg', 'jpeg', 'png', 'gif', 'webp', 'avif'))
      OR (bucket_id = 'bgm' AND lower(storage.extension(name)) IN ('mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac')))
    AND (storage.foldername(name))[1] = 'guest'
  );

-- 已登录用户仅在自己的目录上传；管理员另可上传文章封面到 covers/。
CREATE POLICY "site_member_upload" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    (bucket_id = 'wallpapers' AND (storage.foldername(name))[1] = (select auth.uid()::text)
      AND (storage.foldername(name))[2] = 'wallpaper')
    OR (bucket_id = 'bgm' AND (storage.foldername(name))[1] = (select auth.uid()::text)
      AND (storage.foldername(name))[2] = 'bgm')
    OR (bucket_id = 'avatars' AND (storage.foldername(name))[1] = (select auth.uid()::text)
      AND (storage.foldername(name))[2] = 'avatar')
    OR (bucket_id = 'files' AND (storage.foldername(name))[1] = (select auth.uid()::text)
      AND (storage.foldername(name))[2] = 'cloud')
    OR (bucket_id = 'wallpapers' AND (storage.foldername(name))[1] = 'covers'
      AND EXISTS (SELECT 1 FROM public.admins WHERE user_id = (select auth.uid())))
  );

-- 私有 files bucket 的签名 URL/下载以及已登录用户查看自己上传对象的元数据。
CREATE POLICY "site_member_read_own_objects" ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id IN ('wallpapers', 'bgm', 'avatars', 'files')
    AND owner_id = (select auth.uid()::text));

-- 审核页面需要读取待审核对象元数据；管理员可查看所有公共媒体对象。
CREATE POLICY "site_admin_read_media_objects" ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id IN ('wallpapers', 'bgm')
    AND EXISTS (SELECT 1 FROM public.admins WHERE user_id = (select auth.uid())));

CREATE POLICY "site_member_delete_own_objects" ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id IN ('wallpapers', 'bgm', 'avatars', 'files')
    AND owner_id = (select auth.uid()::text));

-- 审核拒绝/管理删除需要删除其他用户及游客上传的壁纸、BGM。
CREATE POLICY "site_admin_delete_media_objects" ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id IN ('wallpapers', 'bgm')
    AND EXISTS (SELECT 1 FROM public.admins WHERE user_id = (select auth.uid())));

-- 未给匿名用户开启 Storage SELECT：它会暴露整个 guest/ 路径的对象列表。
-- 当前前端使用 upsert:false；若在线匿名上传测试出现 403，请先查 Storage 日志，
-- 不要直接加宽泛的 anon SELECT；改为私有审核 bucket + 受控上传接口更稳妥。
-- 执行完毕后运行以下查询验证：

-- SELECT tablename, rowsecurity FROM pg_tables
-- WHERE schemaname = 'public' AND tablename IN ('articles','user_files','user_settings','avatars','admins','anime_news');
-- -- 所有 rowsecurity 应为 true
-- SELECT policyname, roles, cmd, qual, with_check FROM pg_policies
-- WHERE schemaname = 'storage' AND tablename = 'objects'
-- ORDER BY policyname;

-- SELECT schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
-- FROM pg_policies WHERE schemaname = 'public'
-- ORDER BY tablename, cmd;
-- -- 应列出以上创建的所有策略

-- SELECT name, bucket_id, policies FROM storage.buckets;

-- ==================== 9. comments 表策略 ====================

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
