// THE ZONE - Site Content CMS (admin "إعادة تطوير الموقع")
// Requires: getSupabase() from supabase.js, global state/admin context in app.js is not required.

const CMS_STORAGE_KEY = 'tz_cms_draft_v1';
let _cmsUnlocked = false;
let _cmsRows = [];
let _cmsDrafts = {}; // key -> {draft_en,draft_ar}
let _cmsLastAction = null; // {type:'save'|'publish', prev: {...}}
let _cmsCatalog = null;

export function isCmsUnlocked() { return _cmsUnlocked; }
export function lockCms() { _cmsUnlocked = false; _cmsRows = []; _cmsDrafts = {}; _cmsLastAction = null; }
export function unlockCms() { _cmsUnlocked = true; }

export async function loadCatalog() {
  if (_cmsCatalog) return _cmsCatalog;
  const res = await fetch('./js/cms-catalog.json', { cache: 'no-store' });
  if (!res.ok) throw new Error('تعذر تحميل كتالوج المحتوى.');
  _cmsCatalog = await res.json();
  return _cmsCatalog;
}

function loadLocalDrafts() {
  try { _cmsDrafts = JSON.parse(localStorage.getItem(CMS_STORAGE_KEY) || '{}') || {}; } catch { _cmsDrafts = {}; }
}
function saveLocalDrafts() {
  try { localStorage.setItem(CMS_STORAGE_KEY, JSON.stringify(_cmsDrafts)); } catch {}
}

export async function verifyCmsPassword(getSupabase, password) {
  const sb = getSupabase();
  if (!sb) throw new Error('تعذر إكمال العملية حالياً.');
  const { data, error } = await sb.functions.invoke('verify-site-editor', { body: { password } });
  if (error) throw new Error('تعذر التحقق من كلمة المرور. يرجى المحاولة مرة أخرى.');
  if (!data || data.ok !== true) throw new Error('كلمة المرور غير صحيحة أو غير مصرح.');
  _cmsUnlocked = true;
  loadLocalDrafts();
  return true;
}

export async function fetchContentRows(getSupabase) {
  const sb = getSupabase();
  if (!sb) throw new Error('تعذر تحميل المحتوى حالياً.');
  const { data, error } = await sb.from('site_content').select('*').order('sort_order', { ascending: true });
  if (error) throw error;
  _cmsRows = data || [];
  return _cmsRows;
}

function rowMap(rows) {
  const m = new Map();
  (rows||[]).forEach(r => m.set(r.key, r));
  return m;
}

export async function syncCatalogToDb(getSupabase) {
  const sb = getSupabase();
  if (!sb) throw new Error('تعذر مزامنة المحتوى حالياً.');
  const catalog = await loadCatalog();
  const existing = rowMap(await fetchContentRows(getSupabase));
  const missing = catalog.filter(c => !existing.has(c.key)).map(c => ({
    key: c.key, page: c.page, section: c.section, label: c.label,
    default_en: c.default_en || '', default_ar: c.default_ar || '',
    draft_en: null, draft_ar: null, published_en: null, published_ar: null,
    last_published_en: null, last_published_ar: null,
    sort_order: c.sort_order || 0, updated_at: new Date().toISOString()
  }));
  if (missing.length) {
    const { error } = await sb.from('site_content').upsert(missing, { onConflict: 'key', ignoreDuplicates: true });
    // ignore duplicates/conflicts silently; RLS/admin issues will be thrown on real ops
    if (error && !/duplicate|conflict/i.test(error.message||'')) throw error;
  }
  // refresh
  await fetchContentRows(getSupabase);
  return _cmsRows;
}

function mergedItems(catalog, rows) {
  const rm = rowMap(rows);
  return catalog.map(c => {
    const r = rm.get(c.key) || {};
    const local = _cmsDrafts[c.key] || {};
    const draft_en = (local.draft_en != null) ? local.draft_en : (r.draft_en != null ? r.draft_en : (r.published_en != null ? r.published_en : (r.default_en != null ? r.default_en : c.default_en)));
    const draft_ar = (local.draft_ar != null) ? local.draft_ar : (r.draft_ar != null ? r.draft_ar : (r.published_ar != null ? r.published_ar : (r.default_ar != null ? r.default_ar : c.default_ar)));
    const published_en = r.published_en != null ? r.published_en : (r.default_en != null ? r.default_en : c.default_en);
    const published_ar = r.published_ar != null ? r.published_ar : (r.default_ar != null ? r.default_ar : c.default_ar);
    const hasDraftChanges = (draft_en !== (r.draft_en != null ? r.draft_en : (r.published_en != null ? r.published_en : (r.default_en != null ? r.default_en : c.default_en))))
      || (draft_ar !== (r.draft_ar != null ? r.draft_ar : (r.published_ar != null ? r.published_ar : (r.default_ar != null ? r.default_ar : c.default_ar))))
      || !!local._dirty;
    const isPublished = (r.published_en != null || r.published_ar != null);
    const differsFromPublished = (draft_en !== published_en) || (draft_ar !== published_ar);
    return { ...c, ...r, _draft_en: draft_en, _draft_ar: draft_ar, _published_en: published_en, _published_ar: published_ar, _hasDraftChanges: hasDraftChanges, _isPublished: isPublished, _differsFromPublished: differsFromPublished };
  });
}

export function getEditorState() { return { catalog: _cmsCatalog, rows: _cmsRows, drafts: _cmsDrafts }; }

export function setDraft(key, lang, value) {
  if (!_cmsDrafts[key]) _cmsDrafts[key] = {};
  _cmsDrafts[key][lang === 'ar' ? 'draft_ar' : 'draft_en'] = value;
  _cmsDrafts[key]._dirty = true;
  saveLocalDrafts();
}

export function restoreOriginal(key, catalogItem) {
  if (!_cmsDrafts[key]) _cmsDrafts[key] = {};
  _cmsDrafts[key].draft_en = catalogItem.default_en || '';
  _cmsDrafts[key].draft_ar = catalogItem.default_ar || '';
  _cmsDrafts[key]._dirty = true;
  saveLocalDrafts();
}

export async function saveDrafts(getSupabase, items) {
  const sb = getSupabase(); if (!sb) throw new Error('تعذر حفظ المسودة حالياً.');
  // save current editor drafts (local) to DB draft_* fields
  const updates = items.map(it => ({
    key: it.key,
    draft_en: it._draft_en ?? '',
    draft_ar: it._draft_ar ?? '',
    updated_at: new Date().toISOString()
  }));
  // keep last published for undo
  const prev = {};
  items.forEach(it => { prev[it.key] = { draft_en: it.draft_en, draft_ar: it.draft_ar }; });
  for (let i=0; i<updates.length; i+=50) {
    const chunk = updates.slice(i,i+50);
    const { error } = await sb.from('site_content').upsert(chunk, { onConflict: 'key' });
    if (error) throw error;
  }
  _cmsLastAction = { type: 'save', prev };
  // clear dirty flags locally but keep values
  Object.keys(_cmsDrafts).forEach(k => { if (_cmsDrafts[k]) delete _cmsDrafts[k]._dirty; });
  saveLocalDrafts();
  await fetchContentRows(getSupabase);
}

export async function publishDrafts(getSupabase, items) {
  const sb = getSupabase(); if (!sb) throw new Error('تعذر نشر المحتوى حالياً.');
  const now = new Date().toISOString();
  const prev = {};
  items.forEach(it => { prev[it.key] = { published_en: it.published_en, published_ar: it.published_ar, last_published_en: it.last_published_en, last_published_ar: it.last_published_ar }; });
  const updates = items.map(it => ({
    key: it.key,
    last_published_en: it.published_en ?? null,
    last_published_ar: it.published_ar ?? null,
    published_en: it._draft_en ?? '',
    published_ar: it._draft_ar ?? '',
    draft_en: it._draft_en ?? '',
    draft_ar: it._draft_ar ?? '',
    updated_at: now
  }));
  for (let i=0; i<updates.length; i+=50) {
    const chunk = updates.slice(i,i+50);
    const { error } = await sb.from('site_content').upsert(chunk, { onConflict: 'key' });
    if (error) throw error;
  }
  _cmsLastAction = { type: 'publish', prev };
  _cmsDrafts = {}; saveLocalDrafts();
  await fetchContentRows(getSupabase);
}

export async function undoLast(getSupabase, catalogItems) {
  const sb = getSupabase(); if (!sb) throw new Error('تعذر استعادة المحتوى حالياً.');
  if (!_cmsLastAction) throw new Error('لا يوجد تعديل للتراجع عنه.');
  const { type, prev } = _cmsLastAction;
  const updates = Object.keys(prev).map(key => ({ key, ...prev[key], updated_at: new Date().toISOString() }));
  if (!updates.length) { _cmsLastAction = null; return; }
  for (let i=0; i<updates.length; i+=50) {
    const chunk = updates.slice(i,i+50);
    const { error } = await sb.from('site_content').upsert(chunk, { onConflict: 'key' });
    if (error) throw error;
  }
  _cmsLastAction = null;
  _cmsDrafts = {}; saveLocalDrafts();
  await fetchContentRows(getSupabase);
}

export async function buildEditorItems(getSupabase) {
  const catalog = await loadCatalog();
  await syncCatalogToDb(getSupabase);
  return mergedItems(catalog, _cmsRows);
}

export function groupItems(items) {
  const pages = new Map();
  items.forEach(it => {
    if (!pages.has(it.page)) pages.set(it.page, new Map());
    const secs = pages.get(it.page);
    if (!secs.has(it.section)) secs.set(it.section, []);
    secs.get(it.section).push(it);
  });
  return pages;
}
