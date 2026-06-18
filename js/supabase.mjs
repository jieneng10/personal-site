// ==================== Supabase — ES Module re-exports ====================
// Re-exports from window (set by js/supabase.js IIFE, which runs before modules).

export const sb              = window.sb;
export const sbStoragePath   = window.sbStoragePath;
export const sbUpload        = window.sbUpload;
export const sbPublicUrl     = window.sbPublicUrl;
export const sbSignedUrl     = window.sbSignedUrl;
export const sbDelete        = window.sbDelete;
export const escHtml         = window.escHtml;
export const getCachedUser   = window.getCachedUser;
export const showLoading     = window.showLoading;
export const hideLoading     = window.hideLoading;
export const showToast       = window.showToast;
export const saveToLocalDB   = window.saveToLocalDB;
