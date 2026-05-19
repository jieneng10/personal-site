-- ==================== Supabase RLS 安全策略 ====================
-- 在 Supabase SQL Editor 中逐条执行，或整段粘贴后执行

-- ===== articles 表 =====

-- 任何人可以阅读已发布文章
CREATE POLICY "public_read_published" ON articles
  FOR SELECT TO anon, authenticated
  USING (published = true);

-- 已登录用户可以阅读自己的文章（含未发布）
-- 注意：如果不需要区分作者，可跳过此条
-- CREATE POLICY "user_read_own" ON articles
--   FOR SELECT TO authenticated
--   USING (auth.uid() = author_id);

-- 管理员可以读取所有文章（通过 admin.html 的 admins 表校验）
-- 这里用 authenticated 角色，实际鉴权在应用层
CREATE POLICY "authenticated_read_all" ON articles
  FOR SELECT TO authenticated
  USING (true);

-- 任何人（含匿名游客）可以投稿，默认 published = false
-- ⚠ 如果不需要游客投稿，改为 TO authenticated
CREATE POLICY "anon_insert_articles" ON articles
  FOR INSERT TO anon, authenticated
  WITH CHECK (true);

-- 仅认证用户可以更新/删除（admin.html 登录后操作）
CREATE POLICY "authenticated_update_articles" ON articles
  FOR UPDATE TO authenticated
  USING (true)
  WITH CHECK (true);

CREATE POLICY "authenticated_delete_articles" ON articles
  FOR DELETE TO authenticated
  USING (true);


-- ===== user_files 表 =====

-- 已登录用户只能读写自己的文件
CREATE POLICY "user_select_own_files" ON user_files
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "user_insert_own_files" ON user_files
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "user_update_own_files" ON user_files
  FOR UPDATE TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "user_delete_own_files" ON user_files
  FOR DELETE TO authenticated
  USING (auth.uid() = user_id);


-- ===== user_settings 表 =====

CREATE POLICY "user_manage_own_settings" ON user_settings
  FOR ALL TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);


-- ===== avatars 表 =====

CREATE POLICY "user_manage_own_avatar" ON avatars
  FOR ALL TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);


-- ===== admins 表 =====

-- 所有人可读（admin.html 用于校验是否为管理员）
CREATE POLICY "public_read_admins" ON admins
  FOR SELECT TO authenticated
  USING (true);

-- 仅 admin 本人可管理
CREATE POLICY "user_manage_own_admin" ON admins
  FOR ALL TO authenticated
  USING (auth.uid() = user_id);


-- ===== Storage Bucket 策略 =====
-- 以下在 Supabase Storage → Policies 中为每个 bucket 添加

/*
  -- wallpapers bucket（公开读，认证写）
  CREATE POLICY "public_read_wallpapers"
    ON storage.objects FOR SELECT
    USING (bucket_id = 'wallpapers');
  CREATE POLICY "authenticated_insert_wallpapers"
    ON storage.objects FOR INSERT TO authenticated
    WITH CHECK (bucket_id = 'wallpapers');
  CREATE POLICY "authenticated_delete_wallpapers"
    ON storage.objects FOR DELETE TO authenticated
    USING (bucket_id = 'wallpapers');

  -- files bucket（私密，仅所有者读写）
  CREATE POLICY "user_read_own_files"
    ON storage.objects FOR SELECT TO authenticated
    USING (bucket_id = 'files' AND owner = auth.uid());
  CREATE POLICY "user_insert_own_files"
    ON storage.objects FOR INSERT TO authenticated
    WITH CHECK (bucket_id = 'files' AND owner = auth.uid());
  CREATE POLICY "user_delete_own_files"
    ON storage.objects FOR DELETE TO authenticated
    USING (bucket_id = 'files' AND owner = auth.uid());

  -- bgm bucket（公开读，认证写）
  CREATE POLICY "public_read_bgm"
    ON storage.objects FOR SELECT
    USING (bucket_id = 'bgm');
  CREATE POLICY "authenticated_insert_bgm"
    ON storage.objects FOR INSERT TO authenticated
    WITH CHECK (bucket_id = 'bgm');
  CREATE POLICY "authenticated_delete_bgm"
    ON storage.objects FOR DELETE TO authenticated
    USING (bucket_id = 'bgm');

  -- avatars bucket（公开读，认证写）
  CREATE POLICY "public_read_avatars"
    ON storage.objects FOR SELECT
    USING (bucket_id = 'avatars');
  CREATE POLICY "authenticated_manage_avatars"
    ON storage.objects FOR INSERT TO authenticated
    WITH CHECK (bucket_id = 'avatars');
*/
