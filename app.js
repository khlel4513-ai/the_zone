// The Zone Admin Dashboard — Application logic (secure version)
// Arabic-first RTL. Uses Supabase Auth for administrator authentication.
// No client-side password hashing. No localStorage session.
import {
  initSupabase,
  getSupabase,
  signIn,
  getSession,
  signOut,
  changePassword,
  resetPassword,
  verifySiteEditorPassword,
} from './supabase.js';
import { describeAdminError } from './admin-errors.mjs';
import { saveEventRecord } from './event-operations.mjs';

// ---------- Config / state ----------
const state = {
  admin: null,
  page: 'dashboard',
  events: [],
  eventBookings: [],
  spaceBookings: [],
  community: [],
  ideas: [],
  tickets: [],
  activityLog: [],
  loading: false,
  eventBookingsFilterEvent: '',
};
let attendanceStream = null;
let attendanceScanTimer = 0;
let attendanceScanRun = 0;
let eventDialogOpener = null;

// ---------- DOM refs ----------
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

// ---------- Toast ----------
function friendlyError(error, fallback = 'تعذر إكمال العملية. يرجى المحاولة مرة أخرى.') {
  const text = String(error?.message || error || '');
  return /supabase|\brpc\b|migration|relation .* does not exist|column .* does not exist|could not find the .*column|schema cache|permission denied|edge function|service_role|stack trace|failed to fetch/i.test(text)
    ? fallback
    : (text || fallback);
}

function showEventOperationError(operation, error, form = null) {
  const lang = document.documentElement.lang || 'ar';
  const report = describeAdminError(operation, error, lang);
  const target = form?.querySelector('#event-form-error') || $('#events-operation-status');
  if (!target) {
    showToast(`${report.title}: ${report.reason}`, 'error');
    return;
  }
  target.hidden = false;
  target.innerHTML = `<div class="event-operation-error" role="alert">
    <strong>${esc(report.title)}</strong><p>${esc(report.reason)}</p><p>${esc(report.next)}</p>
    <details><summary>${lang.startsWith('ar') ? 'تفاصيل تقنية آمنة' : 'Safe technical details'}</summary><code>${esc(report.technical)}</code></details>
  </div>`;
  target.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' });
}

function showToast(message, type = 'success') {
  const t = $('#toast');
  if (!t) return;
  t.textContent = type === 'error' ? friendlyError(message) : String(message || '');
  t.className = 'toast ' + type + ' show';
  setTimeout(() => { t.classList.remove('show'); }, 3000);
}

function setLoading(el, loading) {
  if (!el) return;
  if (loading) {
    el.setAttribute('aria-busy', 'true');
    el.classList.add('loading');
  } else {
    el.removeAttribute('aria-busy');
    el.classList.remove('loading');
  }
}

// ---------- Escaping ----------
function esc(t) {
  return String(t == null ? '' : t)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function dateOnly(d) {
  if (!d) return '-';
  return String(d).slice(0, 10);
}

function timeShort(t) {
  if (!t) return '-';
  return String(t).slice(0, 5);
}

function isTodayOrLater(dateStr) {
  if (!dateStr) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return new Date(dateStr) >= today;
}

// ---------- Labels ----------
function arCategory(c) {
  const m = {
    scholarship_opportunity: 'ورش المنح والفرص',
    creative_artistic: 'الورش الفنية',
    community_scientific: 'الفعاليات المجتمعية والعلمية',
    study_work: 'جلسات الدراسة والعمل',
    chess_tournaments: 'الشطرنج والبطولات والأنشطة المرتبطة به',
    other: 'فعاليات أخرى',
  };
  return m[c] || c;
}

function ideaTypeAr(t) {
  const m = { event: 'فعالية', initiative: 'مبادرة', club: 'نادي', community_activity: 'نشاط مجتمعي', other: 'أخرى' };
  return m[t] || t;
}

function supportAr(s) {
  const arr = Array.isArray(s) ? s : [];
  const m = { space: 'مساحة', promotion: 'ترويج', organization: 'تنظيم', collaboration: 'تعاون', other: 'أخرى' };
  return arr.map((x) => m[x] || x).join('، ');
}

function statusBadge(status) {
  const map = {
    pending: 'badge-pending', reviewed: 'badge-reviewed', contacted: 'badge-contacted',
    confirmed: 'badge-confirmed', rejected: 'badge-rejected',
    pending_review: 'badge-pending', under_review: 'badge-reviewed',
    accepted_for_discussion: 'badge-confirmed', declined: 'badge-rejected',
    published: 'badge-published', unpublished: 'badge-unpublished',
  };
  const cls = map[status] || 'badge-unpublished';
  const label = {
    pending: 'قيد الانتظار', reviewed: 'تم المراجعة', contacted: 'تم التواصل',
    confirmed: 'تم التأكيد', rejected: 'مرفوض',
    pending_review: 'قيد المراجعة', under_review: 'تحت المراجعة',
    contacted: 'تم التواصل', accepted_for_discussion: 'مقبول للمناقشة', declined: 'مرفوض',
    published: 'منشور', unpublished: 'غير منشور',
  }[status] || status;
  return `<span class="badge ${cls}">${esc(label)}</span>`;
}

// ---------- Field error helpers ----------
function clearFieldErrors(form) {
  if (!form) return;
  form.querySelectorAll('.field.error').forEach((f) => {
    f.classList.remove('error');
    const m = f.querySelector('.error-msg');
    if (m) m.style.display = 'none';
  });
}

function showFieldError(fieldSelector, msg) {
  const field = $(fieldSelector);
  if (!field) return;
  field.classList.add('error');
  const msgEl = field.querySelector('.error-msg');
  if (msgEl) { msgEl.textContent = msg; msgEl.style.display = 'block'; }
}

function readForm(form) {
  const data = {};
  new FormData(form).forEach((v, k) => { data[k] = v; });
  return data;
}

// ---------- Supabase ----------
function sb() {
  const s = getSupabase();
  if (!s) throw new Error('Supabase غير مهيأ. راجع إعدادات js/supabase.js');
  return s;
}

// Fetch all rows with explicit pagination to avoid default row limits hiding records.
async function fetchAll(table, select = '*', options = {}) {
  const pageSize = 1000;
  let from = 0;
  let all = [];
  for (;;) {
    let q = sb().from(table).select(select).range(from, from + pageSize - 1);
    const orders = options.orders || [];
    orders.forEach((o) => { q = q.order(o.column, { ascending: o.ascending !== false, nullsFirst: !!o.nullsFirst }); });
    const { data, error } = await q;
    if (error) throw error;
    const chunk = data || [];
    all = all.concat(chunk);
    if (chunk.length < pageSize) break;
    from += pageSize;
  }
  return all;
}


// ---------- Admin activity logging (best-effort, DB-backed when available) ----------
async function logAdminActivity(action, entityType = null, entityId = null, details = {}) {
  try {
    if (!getSupabase()) return;
    const { error } = await sb().rpc('admin_log_activity', {
      p_action: String(action || 'action'),
      p_entity_type: entityType ? String(entityType) : null,
      p_entity_id: entityId != null ? String(entityId) : null,
      p_details: details && typeof details === 'object' ? details : { value: details }
    });
    if (error) console.warn('[activity-log] rpc failed', error.message || error);
  } catch (e) {
    console.warn('[activity-log] unavailable', e && e.message ? e.message : e);
  }
}

async function loadTickets(force = false) {
  if (!force && state.tickets && state.tickets.length) return state.tickets;
  try {
    const { data, error } = await sb().rpc('admin_list_tickets', { p_event_id: null, p_status: null, p_limit: 1000 });
    if (error) throw error;
    state.tickets = Array.isArray(data) ? data : [];
  } catch (e) {
    // fallback: try direct select if RPC unavailable but RLS allows admin
    try {
      state.tickets = await fetchAll('event_tickets', '*, event_bookings(id,visitor_name,phone,seats,status,event_id), events(id,title_ar,title_en,event_date,event_time)', { orders: [{ column: 'issued_at', ascending: false }] });
      // normalize shape minimally
      state.tickets = (state.tickets || []).map(t => ({
        ticket_id: t.id || t.ticket_id,
        ticket_number: t.ticket_number,
        qr_token: t.qr_token,
        ticket_status: t.status || t.ticket_status,
        issued_at: t.issued_at,
        used_at: t.used_at,
        booking_id: t.booking_id || t.event_bookings?.id,
        booking_status: t.event_bookings?.status || t.booking_status,
        visitor_name: t.event_bookings?.visitor_name || t.visitor_name,
        phone: t.event_bookings?.phone || t.phone,
        seats: t.event_bookings?.seats || t.seats || 1,
        event_id: t.event_id || t.events?.id,
        event_title: t.events?.title_ar || t.events?.title_en || t.event_title || '',
        event_date: t.events?.event_date || t.event_date,
        event_time: t.events?.event_time || t.event_time,
      }));
    } catch (e2) {
      console.warn('[tickets] load failed', e, e2);
      state.tickets = [];
    }
  }
  return state.tickets;
}

async function loadActivityLog() {
  try {
    state.activityLog = await fetchAll('admin_activity_log', '*', { orders: [{ column: 'created_at', ascending: false }] });
  } catch (e) {
    console.warn('[activity-log] load failed', e);
    state.activityLog = [];
  }
  return state.activityLog;
}

function computeInsights() {
  const now = new Date();
  const in7 = new Date(now.getTime() + 7*24*3600*1000);
  const in30 = new Date(now.getTime() + 30*24*3600*1000);
  const upcoming7 = state.events.filter(e => e.published && e.event_date && new Date(e.event_date+'T00:00:00') >= new Date(now.toDateString()) && new Date(e.event_date+'T00:00:00') <= in7);
  const upcoming30 = state.events.filter(e => e.published && e.event_date && new Date(e.event_date+'T00:00:00') >= new Date(now.toDateString()) && new Date(e.event_date+'T00:00:00') <= in30);
  const pendingBookings = state.eventBookings.filter(b => b.status === 'pending').length;
  const confirmed = state.eventBookings.filter(b => b.status === 'confirmed').length;
  const bookingsByEvent = state.eventBookings.reduce((acc,b)=>{ const k=String(b.event_id||'none'); acc[k]=(acc[k]||0)+1; return acc; }, {});
  const topEvents = Object.entries(bookingsByEvent).filter(([k])=>k!=='none').map(([k,v])=>{
    const ev = state.events.find(e=>String(e.id)===k);
    return { id:k, title: ev ? (ev.title_ar||ev.title_en||'فعالية') : 'فعالية', count:v, published: !!(ev&&ev.published) };
  }).sort((a,b)=>b.count-a.count).slice(0,5);
  const lowEngagement = state.events.filter(e=>e.published && isTodayOrLater(e.event_date)).map(e=>{
    const c = bookingsByEvent[String(e.id)]||0;
    return { id:e.id, title:e.title_ar||e.title_en||'فعالية', count:c, date:e.event_date };
  }).filter(x=>x.count===0).slice(0,5);
  const ticketsIssued = state.tickets ? state.tickets.length : 0;
  const attended = state.tickets ? state.tickets.filter(t => t.ticket_status==='used' || t.used_at).length : 0;
  const attendanceRate = ticketsIssued ? Math.round((attended/ticketsIssued)*100) : 0;
  // registration trend by day (last 14 days)
  const dayCounts = {};
  for (let i=13;i>=0;i--){ const d=new Date(now.getTime()-i*24*3600*1000); dayCounts[d.toISOString().slice(0,10)] = 0; }
  state.eventBookings.forEach(b=>{ const d=dateOnly(b.created_at); if (d in dayCounts) dayCounts[d]++; });
  const trend = Object.entries(dayCounts).map(([date,count])=>({date,count}));
  return { upcoming7: upcoming7.length, upcoming30: upcoming30.length, pendingBookings, confirmed, topEvents, lowEngagement, ticketsIssued, attended, attendanceRate, trend, bookingsByEvent };
}

function renderBarChart(items, valueKey='count', labelKey='title', maxVal=null) {
  const vals = items.map(i=>Number(i[valueKey]||0));
  const max = maxVal != null ? maxVal : (Math.max(1, ...vals));
  if (!items.length) return '<div class="empty" style="padding:16px"><p>لا توجد بيانات كافية بعد.</p></div>';
  return `<div class="bar-chart">${items.map(i=>{
    const v = Number(i[valueKey]||0);
    const pct = Math.round((v/max)*100);
    return `<div class="bar-row"><div title="${esc(i[labelKey]||'')}">${esc(String(i[labelKey]||'-')).slice(0,28)}</div><div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div><div><strong>${v}</strong></div></div>`;
  }).join('')}</div>`;
}

function renderMiniTrend(trend) {
  if (!trend || !trend.length) return '<div class="empty" style="padding:16px"><p>لا توجد بيانات.</p></div>';
  const max = Math.max(1, ...trend.map(t=>t.count||0));
  const bars = trend.map(t=>{
    const h = Math.max(4, Math.round(((t.count||0)/max)*80));
    return `<div title="${esc(t.date)}: ${t.count}" style="flex:1;min-width:8px;display:flex;flex-direction:column;align-items:center;gap:4px"><div style="width:100%;height:${h}px;background:linear-gradient(180deg,var(--accent),#dcb155);border-radius:6px 6px 2px 2px"></div><div style="font-size:10px;color:var(--muted)">${String(t.date).slice(8)}</div></div>`;
  }).join('');
  const total = trend.reduce((a,b)=>a+(b.count||0),0);
  return `<div style="display:flex;align-items:flex-end;gap:6px;height:110px;padding:8px 4px">${bars}</div><div class="hint">إجمالي آخر 14 يوماً: <strong>${total}</strong> تسجيل</div>`;
}

function buildNotifications() {
  const items = [];
  const pendingBookings = state.eventBookings.filter(b => b.status === 'pending');
  const pendingSpace = state.spaceBookings.filter(b => b.status === 'pending');
  const pendingCommunity = state.community.filter(c => c.status === 'pending');
  const pendingIdeas = state.ideas.filter(i => i.status === 'pending_review');
  const now = new Date();
  const soon = state.events.filter(e => e.published && e.event_date).filter(e => {
    const d = new Date(e.event_date + 'T00:00:00'); const diff = (d - new Date(now.toDateString()))/(24*3600*1000);
    return diff >= 0 && diff <= 3;
  });
  const bookingsByEvent = state.eventBookings.reduce((acc,b)=>{ const k=String(b.event_id||''); if(k) acc[k]=(acc[k]||0)+1; return acc; }, {});
  if (pendingBookings.length) items.push({ level:'warn', text:`${pendingBookings.length} تسجيل فعالية بانتظار المراجعة`, action:`router('eventbookings')`, cta:'مراجعة' });
  if (pendingSpace.length) items.push({ level:'warn', text:`${pendingSpace.length} طلب حجز مساحة بانتظار المراجعة`, action:`router('spacebookings')`, cta:'مراجعة' });
  if (pendingCommunity.length) items.push({ level:'info', text:`${pendingCommunity.length} طلب انضمام للمجتمع بانتظار المراجعة`, action:`router('community')`, cta:'فتح' });
  if (pendingIdeas.length) items.push({ level:'info', text:`${pendingIdeas.length} فكرة/مبادرة بانتظار المراجعة`, action:`router('ideas')`, cta:'فتح' });
  soon.forEach(e => items.push({ level:'info', text:`فعالية قريبة: ${e.title_ar||e.title_en||'فعالية'} (${dateOnly(e.event_date)}) — ${bookingsByEvent[String(e.id)]||0} تسجيل`, action:`router('eventbookings')`, cta:'التسجيلات' }));
  state.events.filter(e=>e.published && e.capacity_enabled).forEach(e => {
    const occ = bookingsByEvent[String(e.id)]||0;
    // do not expose exact counts to public; admin can see operationally here
    if (e.total_seats && occ >= e.total_seats) items.push({ level:'warn', text:`اكتملت سعة فعالية: ${e.title_ar||e.title_en||'فعالية'}`, action:`router('events')`, cta:'إدارة' });
  });
  if (!items.length) items.push({ level:'ok', text:'لا توجد تنبيهات حرجة حالياً. جميع المؤشرات مستقرة.' });
  return items;
}

// ---------- Data loading ----------
async function loadEvents() {
  state.events = await fetchAll('events', '*', { orders: [{ column: 'event_date', ascending: true }, { column: 'event_time', ascending: true }] });
}

async function loadEventBookings() {
  state.eventBookings = await fetchAll('event_bookings', '*, events(id,title_ar,title_en,event_date,event_time)', { orders: [{ column: 'created_at', ascending: false }] });
}

async function loadSpaceBookings() {
  state.spaceBookings = await fetchAll('space_bookings', '*', { orders: [{ column: 'created_at', ascending: false }] });
}

async function loadCommunity() {
  state.community = await fetchAll('community_registrations', '*', { orders: [{ column: 'created_at', ascending: false }] });
}

async function loadIdeas() {
  state.ideas = await fetchAll('ideas_initiatives', '*', { orders: [{ column: 'created_at', ascending: false }] });
}

async function loadAll() {
  await Promise.all([
    loadEvents(), loadEventBookings(), loadSpaceBookings(), loadCommunity(), loadIdeas(),
  ]);
}

// ---------- Auth ----------
async function restoreSession() {
  const session = await getSession();
  if (session) {
    state.admin = session;
    return true;
  }
  state.admin = null;
  return false;
}

async function doLogin(email, password) {
  const admin = await signIn(email, password);
  state.admin = admin;
  return admin;
}

let siteDevUnlocked = false;

function doLogout() {
  siteDevUnlocked = false;
  signOut();
  state.admin = null;
  const loginBox = $('#login-box');
  const appBox = $('#app-box');
  if (loginBox) loginBox.style.display = 'block';
  if (appBox) appBox.style.display = 'none';
}

async function doChangePassword(newPassword) {
  await changePassword(newPassword);
}

// ---------- Router ----------
function closeSidebar() {
  const sidebarEl = document.querySelector('.sidebar');
  const sidebarOverlay = $('#sidebar-overlay');
  const navToggle = $('#nav-toggle');
  if (sidebarEl) sidebarEl.classList.remove('open');
  if (sidebarEl) {
    sidebarEl.inert = window.matchMedia('(max-width: 900px)').matches;
    sidebarEl.setAttribute('aria-hidden', String(sidebarEl.inert));
  }
  if (sidebarOverlay) { sidebarOverlay.style.display = 'none'; sidebarOverlay.setAttribute('aria-hidden', 'true'); }
  if (navToggle) navToggle.setAttribute('aria-expanded', 'false');
}

const PAGE_META = {
  dashboard: { title: 'لوحة التحكم', sub: 'ملخص الأداء والطلبات والتنبيهات.' },
  insights: { title: 'التحليلات والنمو', sub: 'مؤشرات حقيقية لأداء الفعاليات والتسجيلات والحضور واتجاهات النمو.' },
  events: { title: 'إدارة الفعاليات', sub: 'إنشاء وتعديل ونشر الفعاليات مع التحكم الاختياري بالسعة والتذاكر وQR لكل فعالية.' },
  eventbookings: { title: 'إدارة التسجيلات', sub: 'متابعة طلبات التسجيل حسب الفعالية مع فلاتر، تفاصيل، وحالات واضحة.' },
  tickets: { title: 'التذاكر الرقمية', sub: 'إصدار التذاكر الرقمية وإدارتها لكل فعالية.' },
  attendance: { title: 'إدارة الحضور', sub: 'تحقق QR بالكاميرا أو إدخال يدوي مع تسجيل حضور آمن ومنع إعادة الاستخدام.' },
  spacebookings: { title: 'حجوزات المساحة', sub: 'طلبات استئجار/حجز المساحة الواردة من الموقع العام.' },
  community: { title: 'إدارة المجتمع', sub: 'تسجيلات الاهتمام بالانضمام إلى مجتمع ذا زون.' },
  ideas: { title: 'المبادرات والأفكار', sub: 'الأفكار والمقترحات المقدمة للمراجعة الداخلية.' },
  sitedev: { title: 'إدارة محتوى الموقع', sub: 'تحرير ونشر نصوص الموقع العام (قسم محمي).' },
  settings: { title: 'الإعدادات', sub: 'حساب المشرف والأمان وربط المنصة.' },
  activitylog: { title: 'سجل النشاطات', sub: 'متابعة الإجراءات الإدارية الأخيرة.' },
};

function router(page) {
  if (page && page !== state.page && $('#event-form-card')) closeEventForm();
  if (page) {
    state.page = page;
    if (location.hash !== '#' + page) location.hash = page;
  } else {
    state.page = location.hash.replace('#', '') || 'dashboard';
  }
  $$('.nav-item').forEach((el) => el.classList.toggle('active', el.dataset.page === state.page));
  $$('.page').forEach((el) => el.classList.toggle('active', el.id === state.page + '-page'));
  const meta = PAGE_META[state.page] || PAGE_META.dashboard;
  const titleEl = $('#page-title');
  const subEl = $('#page-sub');
  if (titleEl) titleEl.textContent = meta.title;
  if (subEl) subEl.textContent = meta.sub;
  closeSidebar();
  renderCurrent();
}

async function renderCurrent() {
  const p = state.page;
  if (p !== 'sitedev') siteDevUnlocked = false;
  if (p !== 'attendance') { try { stopAttendanceScan(); } catch(_){} }
  try {
    if (p === 'dashboard') await renderDashboard();
    else if (p === 'insights') await renderInsights();
    else if (p === 'events') await renderEvents();
    else if (p === 'eventbookings') await renderEventBookings(true);
    else if (p === 'tickets') await renderTickets();
    else if (p === 'attendance') await renderAttendance();
    else if (p === 'spacebookings') await renderSpaceBookings();
    else if (p === 'community') await renderCommunity();
    else if (p === 'ideas') await renderIdeas();
    else if (p === 'settings') await renderSettings();
    else if (p === 'activitylog') await renderActivityLog();
    else if (p === 'sitedev') await renderSiteDev();
    else { state.page = 'dashboard'; await renderDashboard(); }
  } catch (err) {
    console.error(err);
    showToast(err.message || 'حدث خطأ أثناء تحميل الصفحة.', 'error');
  }
}

// ---------- Dashboard ----------
async function renderDashboard() {
  await loadAll();
  try { await loadTickets(true); } catch (_) {}
  const ins = computeInsights();
  const published = state.events.filter((e) => e.published).length;
  const upcoming = state.events.filter((e) => e.published && isTodayOrLater(e.event_date)).length;
  const totalBookings = state.eventBookings.length;
  const pendingBookings = state.eventBookings.filter((b) => b.status === 'pending').length;
  const spaceReqs = state.spaceBookings.length;
  const pendingSpace = state.spaceBookings.filter((b) => b.status === 'pending').length;
  const communityCount = state.community.length;
  const pendingCommunity = state.community.filter((c) => c.status === 'pending').length;
  const ideasCount = state.ideas.length;
  const pendingIdeas = state.ideas.filter((i) => i.status === 'pending_review').length;

  const statsEl = $('#stats');
  if (statsEl) {
    statsEl.innerHTML = `
      <div class="stat"><div class="label">الفعاليات المنشورة</div><div class="value">${published}</div><div class="sub">قادمة: ${upcoming} · خلال 7 أيام: ${ins.upcoming7}</div></div>
      <div class="stat"><div class="label">تسجيلات الفعاليات</div><div class="value">${totalBookings}</div><div class="sub">قيد الانتظار: ${pendingBookings} · مؤكدة: ${ins.confirmed}</div></div>
      <div class="stat"><div class="label">التذاكر والحضور</div><div class="value">${ins.ticketsIssued}</div><div class="sub">حضور مسجّل: ${ins.attended} (${ins.attendanceRate}%)</div></div>
      <div class="stat"><div class="label">حجوزات المساحة</div><div class="value">${spaceReqs}</div><div class="sub">قيد الانتظار: ${pendingSpace}</div></div>
      <div class="stat"><div class="label">المجتمع</div><div class="value">${communityCount}</div><div class="sub">قيد الانتظار: ${pendingCommunity}</div></div>
      <div class="stat"><div class="label">الأفكار والمبادرات</div><div class="value">${ideasCount}</div><div class="sub">قيد المراجعة: ${pendingIdeas}</div></div>
    `;
  }

  const recent = [
    ...state.eventBookings.map((r) => ({ ...r, _kind: 'event_booking' })),
    ...state.spaceBookings.map((r) => ({ ...r, _kind: 'space_booking' })),
    ...state.community.map((r) => ({ ...r, _kind: 'community' })),
    ...state.ideas.map((r) => ({ ...r, _kind: 'idea' })),
  ].sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, 8);

  const recentBox = $('#recent-requests');
  if (recentBox) {
    if (!recent.length) {
      recentBox.innerHTML = '<div class="empty"><h3>لا توجد طلبات حديثة</h3><p>عند وصول طلبات من الموقع العام ستظهر هنا.</p></div>';
    } else {
      recentBox.innerHTML = '<div class="table-wrap"><table><thead><tr><th>المقدم</th><th>النوع</th><th>الحالة</th><th>التاريخ</th></tr></thead><tbody>' +
        recent.map((r) => {
          const map = { event_booking: 'حجز فعالية', space_booking: 'حجز مساحة', community: 'تسجيل مجتمع', idea: 'فكرة/مبادرة' };
          const name = r.visitor_name || r.submitter_name || '-';
          return `<tr><td>${esc(name)}</td><td>${esc(map[r._kind])}</td><td>${statusBadge(r.status)}</td><td>${dateOnly(r.created_at)}</td></tr>`;
        }).join('') + '</tbody></table></div>';
    }
  }

  const notifBox = $('#pending-actions');
  if (notifBox) {
    const notifs = buildNotifications();
    notifBox.innerHTML = `<div class="insight-list">${notifs.map(n => `<div class="insight ${esc(n.level||'info')}"><div style="display:flex;justify-content:space-between;gap:10px;align-items:center"><div>${esc(n.text)}</div>${n.action ? `<button type="button" class="btn-secondary" style="padding:6px 10px;font-size:12px" onclick="${esc(n.action)};return false;">${esc(n.cta||'فتح')}</button>` : ''}</div></div>`).join('')}</div>`;
  }

  const regChart = $('#chart-registrations');
  if (regChart) regChart.innerHTML = renderMiniTrend(ins.trend);
  const evChart = $('#chart-events');
  if (evChart) evChart.innerHTML = ins.topEvents.length ? renderBarChart(ins.topEvents, 'count', 'title') : (ins.lowEngagement.length ? `<div class="hint" style="margin-bottom:8px">فعاليات منشورة قادمة بدون تسجيلات بعد (فرصة متابعة):</div>${renderBarChart(ins.lowEngagement, 'count', 'title')}` : '<div class="empty" style="padding:16px"><p>لا توجد بيانات أداء كافية بعد.</p></div>');
}

// ---------- Events ----------
async function renderEvents() {
  try { await Promise.all([loadEvents(), loadEventBookings()]); }
  catch (error) { showEventOperationError('load_events', error); throw error; }
  const container = $('#events-list');
  const statEl = $('#events-stat');
  const publishedCount = state.events.filter((e) => e.published).length;
  if (statEl) statEl.textContent = `${publishedCount} منشور · ${state.events.length} إجمالي`;

  const box = $('#event-form-box');
  const counts = state.eventBookings.reduce((acc, b) => {
    const k = b.event_id ? String(b.event_id) : '';
    if (k) acc[k] = (acc[k] || 0) + 1;
    return acc;
  }, {});

  if (!state.events.length) {
    if (container) container.innerHTML = '<div class="empty"><h3>لا توجد فعاليات</h3><p>أضف فعالية جديدة ثم انشرها لتظهر في الموقع العام مع زر التسجيل.</p></div>';
    if (box && !box.dataset.keep) box.innerHTML = '';
    return;
  }

  if (container) {
    container.innerHTML = '<div class="table-wrap"><table><thead><tr><th>الفعالية</th><th>التصنيف</th><th>التاريخ والوقت</th><th>السعر</th><th>التسجيلات</th><th>النشر</th><th>الإجراءات</th></tr></thead><tbody>' +
      state.events.map((e) => {
        const price = e.price_iqd != null && e.price_iqd !== '' ? `${Number(e.price_iqd).toLocaleString('en-US')} دينار عراقي` : (e.price_note || 'حسب الطلب / مجاني');
        const regCount = counts[String(e.id)] || 0;
        return `<tr>
          <td><strong>${esc(e.title_ar)}</strong>${e.title_en ? `<div class="sub">${esc(e.title_en)}</div>` : ''}</td>
          <td>${esc(arCategory(e.category))}</td>
          <td>${dateOnly(e.event_date)}<div class="sub">${timeShort(e.event_time)}</div></td>
          <td>${esc(price)}</td>
          <td><span class="badge badge-reviewed">${regCount} تسجيل</span></td>
          <td>${statusBadge(e.published ? 'published' : 'unpublished')}<div class="sub">${e.registration_open === false ? 'التسجيل مغلق' : 'التسجيل مفتوح'}</div></td>
          <td><div class="actions">
            <button class="status" type="button" onclick="app.viewEventRegistrations('${esc(e.id)}')">التسجيلات</button>
            <button class="edit" type="button" onclick="app.openEventEdit('${esc(e.id)}')">تعديل</button>
            <button class="${e.published ? 'delete' : 'status'}" type="button" onclick="app.togglePublish('${esc(e.id)}', ${e.published ? 'false' : 'true'})">${e.published ? 'إلغاء النشر' : 'نشر'}</button>
            <button class="delete" type="button" onclick="app.deleteEvent('${esc(e.id)}')">حذف</button>
          </div></td>
        </tr>`;
      }).join('') + '</tbody></table></div>';
  }
}

window.viewEventRegistrations = (eventId) => {
  state.eventBookingsFilterEvent = eventId ? String(eventId) : '';
  router('eventbookings');
};

function eventFormHtml(edit = null) {
  const isEdit = !!edit;
  const e = edit || {};
  const categories = [
    { v: 'scholarship_opportunity', l: 'ورش المنح والفرص' },
    { v: 'creative_artistic', l: 'الورش الفنية' },
    { v: 'community_scientific', l: 'الفعاليات المجتمعية والعلمية' },
    { v: 'study_work', l: 'جلسات الدراسة والعمل' },
    { v: 'chess_tournaments', l: 'الشطرنج والبطولات والأنشطة المرتبطة به' },
    { v: 'other', l: 'فعاليات أخرى' },
  ];
  const catOpts = categories.map((c) => `<option value="${c.v}" ${e.category === c.v ? 'selected' : ''}>${esc(c.l)}</option>`).join('');
  const img = e.image_url ? String(e.image_url) : '';
  return `
  <div class="form-card event-editor" id="event-form-card" role="dialog" aria-modal="true" aria-labelledby="event-form-title" tabindex="-1">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap">
      <div>
        <h3 id="event-form-title">${isEdit ? 'تعديل فعالية' : 'إضافة فعالية جديدة'}</h3>
        <p class="lead">تظهر الفعالية للزوار بعد نشرها.</p>
      </div>
      <button type="button" class="btn-cancel" onclick="app.closeEventForm()">إغلاق</button>
    </div>
    <nav class="event-jump-nav" aria-label="أقسام إعداد الفعالية">
      <button type="button" data-jump="f-title-ar">التفاصيل</button>
      <button type="button" data-jump="event-registration-settings">التسجيل</button>
      <button type="button" data-jump="event-capacity-settings">السعة</button>
      <button type="button" data-jump="event-ticket-settings">التذاكر والحضور</button>
      <button type="button" data-jump="f-image">الصورة</button>
    </nav>
    <form id="event-form" data-edit="${edit ? esc(edit.id) : ''}">
      <div id="event-form-error" class="event-operation-status" role="alert" hidden></div>
      <div class="form-grid">
        <div class="field" id="f-title-ar"><label>العنوان (عربي) *</label><input name="title_ar" value="${esc(e.title_ar || '')}" required><div class="error-msg"></div></div>
        <div class="field" id="f-title-en"><label>العنوان (English) *</label><input name="title_en" value="${esc(e.title_en || '')}" required><div class="error-msg"></div></div>
        <div class="field full"><label>التصنيف</label><select name="category">${catOpts}</select></div>
        <div class="field" id="f-date"><label>التاريخ *</label><input type="date" name="event_date" value="${e.event_date ? String(e.event_date).slice(0,10) : ''}" required><div class="error-msg"></div></div>
        <div class="field" id="f-time"><label>الوقت *</label><input type="time" name="event_time" value="${e.event_time ? String(e.event_time).slice(0,5) : ''}" required><div class="error-msg"></div></div>
        <div class="field" id="f-price"><label>السعر (دينار عراقي)</label><input type="number" name="price_iqd" value="${e.price_iqd != null ? e.price_iqd : ''}" min="0" step="1" placeholder="اتركه فارغاً إن كان مجاني/حسب الطلب"></div>
        <div class="field"><label>ملاحظة السعر</label><input name="price_note" value="${esc(e.price_note || '')}" placeholder="مثال: مجاني / الدفع عند الحضور"></div>
        <div class="field full"><label>تفاصيل المشاركة</label><textarea name="participation_details" rows="3">${esc(e.participation_details || '')}</textarea></div>
        <div class="field full"><label>الوصف (عربي)</label><textarea name="description_ar" rows="3">${esc(e.description_ar || '')}</textarea></div>
        <div class="field full"><label>الوصف (English)</label><textarea name="description_en" rows="3">${esc(e.description_en || '')}</textarea></div>

        <div class="field full event-settings" id="event-registration-settings" style="margin-top:6px">
          <div class="panel" style="padding:14px;border:1px solid var(--line);border-radius:12px;background:var(--surface-2)">
            <div style="font-weight:600;margin-bottom:6px">حالة التسجيل</div>
            <div class="hint" style="margin-bottom:10px">تبقى الفعالية المنشورة ظاهرة عند إغلاق التسجيل، مع إيقاف التسجيلات الجديدة.</div>
            <label style="display:flex;align-items:center;gap:10px;margin-bottom:8px"><input type="checkbox" id="ev-registration-open" ${e.registration_open !== false ? 'checked' : ''}> استقبال تسجيلات جديدة</label>
          </div>
        </div>

        <div class="field full event-settings" id="event-capacity-settings" style="margin-top:6px">
          <div class="panel" style="padding:14px;border:1px solid var(--line);border-radius:12px;background:var(--surface-2)">
            <div style="font-weight:600;margin-bottom:6px">إدارة سعة الفعالية (اختياري)</div>
            <div class="hint" style="margin-bottom:10px">فعّل الحد الأقصى للمقاعد فقط عند الحاجة. عند التعطيل تبقى التسجيلات مفتوحة دون حد. لا تظهر أعداد المقاعد للمستخدمين في الموقع العام.</div>
            <label style="display:flex;align-items:center;gap:10px;margin-bottom:10px"><input type="checkbox" id="ev-capacity-enabled" ${e.capacity_enabled ? 'checked' : ''}> تفعيل نظام المقاعد لهذه الفعالية</label>
            <div id="ev-capacity-fields" style="display:${e.capacity_enabled ? 'grid' : 'none'};gap:10px;grid-template-columns:repeat(auto-fit,minmax(180px,1fr))">
              <div class="field" id="f-total-seats"><label>العدد الإجمالي للمقاعد</label><input type="number" id="ev-total-seats" min="1" step="1" value="${e.total_seats != null ? esc(e.total_seats) : ''}" placeholder="مثال: 30"><div class="error-msg"></div></div>
              <div class="field"><label>معلومة</label><div class="hint">تُرفض التسجيلات الجديدة بعد اكتمال المقاعد.</div></div>
            </div>
          </div>
        </div>

        <div class="field full event-settings" id="event-ticket-settings">
          <div class="panel" style="padding:14px;border:1px solid var(--line);border-radius:12px;background:var(--surface-2)">
            <div style="font-weight:600;margin-bottom:6px">التذاكر الرقمية (اختياري لكل فعالية)</div>
            <div class="hint" style="margin-bottom:10px">عند تفعيلها، تُصدر تذكرة برمز QR لكل تسجيل مؤهل.</div>
            <label style="display:flex;align-items:center;gap:10px;margin-bottom:8px"><input type="checkbox" id="ev-tickets-enabled" ${e.tickets_enabled ? 'checked' : ''}> تفعيل التذاكر الرقمية لهذه الفعالية</label>
            <label style="display:flex;align-items:center;gap:10px;margin-bottom:8px"><input type="checkbox" id="ev-show-ticket-attendee" ${(e.show_ticket_to_attendee !== false) ? 'checked' : ''}> إظهار التذكرة للمسجّل بعد التسجيل</label>
            <label style="display:flex;align-items:center;gap:10px"><input type="checkbox" id="ev-qr-checkin-enabled" ${e.qr_checkin_enabled ? 'checked' : ''}> تفعيل نظام التحقق من الحضور (QR)</label>
            <div class="hint" style="margin-top:8px">يمكن إبقاء التذكرة للإدارة فقط وتوزيعها يدوياً.</div>
          </div>
        </div>
        <div class="field full" id="f-image">
          <label>صورة/بوستر الفعالية</label>
          <input type="hidden" name="image_url" id="event-image-url" value="${esc(img)}">
          <div class="image-uploader">
            <div class="image-preview" id="event-image-preview">${img ? `<img src="${esc(img)}" alt="معاينة صورة الفعالية">` : '<div class="image-placeholder">لا توجد صورة حالياً</div>'}</div>
            <div class="image-controls">
              <input type="file" id="event-image-file" accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp" hidden>
              <div class="actions">
                <button type="button" class="btn-secondary" id="event-image-pick">اختيار صورة من الجهاز</button>
                <button type="button" class="btn-cancel" id="event-image-remove" ${img ? '' : 'disabled'}>إزالة الصورة</button>
              </div>
              <div class="hint">الصيغ المدعومة: JPG وPNG وWebP — الحد الأقصى 5MB.</div>
              <div id="event-image-status" class="upload-status" aria-live="polite"></div>
              <div class="upload-progress" id="event-image-progress" style="display:none"><div class="upload-progress-bar" id="event-image-progress-bar"></div></div>
              <div class="hint" style="margin-top:6px">يمكنك أيضاً استخدام رابط خارجي إن لزم (سيتم الاحتفاظ به كما هو إذا لم ترفع صورة جديدة):</div>
              <input type="url" id="event-image-url-input" value="${esc(img)}" placeholder="https://..." inputmode="url">
            </div>
          </div>
          <div class="error-msg"></div>
        </div>
      </div>
      <div class="save-bar">
        <button type="submit" class="btn-primary" id="event-save-btn">${isEdit ? 'حفظ التعديلات' : 'إنشاء الفعالية'}</button>
        <button type="button" class="btn-cancel" onclick="app.closeEventForm()">إلغاء</button>
      </div>
    </form>
  </div>`;
}

function openEventForm() {
  const box = $('#event-form-box');
  if (!box) return;
  eventDialogOpener = document.activeElement;
  box.dataset.keep = '1';
  document.body.classList.add('dialog-open');
  const appBox = $('#app-box');
  if (appBox) { appBox.inert = true; appBox.setAttribute('aria-hidden', 'true'); }
  document.body.append(box);
  box.innerHTML = eventFormHtml();
  bindEventForm();
  box.onclick = (ev) => { if (ev.target === box) closeEventForm(); };
  $('#f-title-ar input')?.focus({ preventScroll: true });
}
function closeEventForm() {
  const box = $('#event-form-box');
  if (!box) return;
  delete box.dataset.keep;
  box.innerHTML = '';
  box.onclick = null;
  document.body.classList.remove('dialog-open');
  const appBox = $('#app-box');
  if (appBox) { appBox.inert = false; appBox.setAttribute('aria-hidden', 'false'); }
  const eventsPage = $('#events-page');
  if (eventsPage) eventsPage.append(box);
  if (eventDialogOpener && typeof eventDialogOpener.focus === 'function') eventDialogOpener.focus({ preventScroll: true });
  eventDialogOpener = null;
}
async function openEventEdit(id) {
  const e = state.events.find((x) => String(x.id) === String(id));
  if (!e) { showToast('تعذر العثور على الفعالية.', 'error'); return; }
  const box = $('#event-form-box');
  if (!box) return;
  eventDialogOpener = document.activeElement;
  box.dataset.keep = '1';
  document.body.classList.add('dialog-open');
  const appBox = $('#app-box');
  if (appBox) { appBox.inert = true; appBox.setAttribute('aria-hidden', 'true'); }
  document.body.append(box);
  box.innerHTML = eventFormHtml(e);
  bindEventForm();
  box.onclick = (ev) => { if (ev.target === box) closeEventForm(); };
  $('#f-title-ar input')?.focus({ preventScroll: true });
}
function setEventImageUI(url, statusText = '', statusType = '') {
  const hidden = $('#event-image-url');
  const input = $('#event-image-url-input');
  const preview = $('#event-image-preview');
  const removeBtn = $('#event-image-remove');
  const status = $('#event-image-status');
  const clean = (url || '').trim();
  if (hidden) hidden.value = clean;
  if (input && input.value !== clean) input.value = clean;
  if (preview) preview.innerHTML = clean ? `<img src="${esc(clean)}" alt="معاينة صورة الفعالية">` : '<div class="image-placeholder">لا توجد صورة حالياً</div>';
  if (removeBtn) removeBtn.disabled = !clean;
  if (status) {
    status.textContent = statusText || '';
    status.className = 'upload-status' + (statusType ? ' ' + statusType : '');
  }
}

async function uploadEventImageFile(file) {
  const allowed = ['image/jpeg', 'image/png', 'image/webp'];
  const maxBytes = 5 * 1024 * 1024;
  if (!file) throw new Error('لم يتم اختيار ملف.');
  if (!allowed.includes(file.type)) throw new Error('صيغة الصورة غير مدعومة. استخدم JPG أو PNG أو WebP.');
  if (file.size > maxBytes) throw new Error('حجم الصورة كبير. الحد الأقصى 5MB.');
  const ext = (file.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
  const safeExt = ['jpg','jpeg','png','webp'].includes(ext) ? ext : (file.type === 'image/png' ? 'png' : file.type === 'image/webp' ? 'webp' : 'jpg');
  const path = `events/${Date.now()}-${Math.random().toString(36).slice(2,8)}.${safeExt}`;
  const status = $('#event-image-status');
  const prog = $('#event-image-progress');
  const bar = $('#event-image-progress-bar');
  if (status) { status.textContent = 'جارٍ رفع الصورة...'; status.className = 'upload-status'; }
  if (prog) prog.style.display = 'block';
  if (bar) { bar.style.width = '35%'; }
  // supabase-js storage.upload does not expose granular progress in browser; show active state.
  const { error } = await sb().storage.from('event-posters').upload(path, file, { cacheControl: '3600', upsert: false, contentType: file.type });
  if (bar) bar.style.width = '85%';
  if (error) throw error;
  const { data } = sb().storage.from('event-posters').getPublicUrl(path);
  const publicUrl = data && data.publicUrl ? data.publicUrl : '';
  if (!publicUrl) throw new Error('تم الرفع لكن تعذر الحصول على رابط الصورة العام.');
  if (bar) bar.style.width = '100%';
  setTimeout(() => { if (prog) prog.style.display = 'none'; if (bar) bar.style.width = '0%'; }, 500);
  return publicUrl;
}

function bindEventForm() {
  const form = $('#event-form');
  if (!form) return;
  form.noValidate = true;
  $$('.event-jump-nav [data-jump]').forEach((button) => {
    button.onclick = () => {
      const target = document.getElementById(button.dataset.jump);
      target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
  });
  const capToggle = $('#ev-capacity-enabled');
  const capFields = $('#ev-capacity-fields');
  if (capToggle && capFields) capToggle.onchange = () => { capFields.style.display = capToggle.checked ? 'grid' : 'none'; };

  const fileInput = $('#event-image-file');
  const pickBtn = $('#event-image-pick');
  const removeBtn = $('#event-image-remove');
  const urlInput = $('#event-image-url-input');

  if (pickBtn && fileInput) pickBtn.onclick = () => fileInput.click();
  if (fileInput) fileInput.onchange = async () => {
    const file = fileInput.files && fileInput.files[0];
    if (!file) return;
    try {
      const url = await uploadEventImageFile(file);
      setEventImageUI(url, 'تم رفع الصورة بنجاح وحفظ رابطها. اضغط "حفظ التعديلات/إنشاء الفعالية" لتخزينه في سجل الفعالية.', 'success');
      showToast('تم رفع الصورة بنجاح');
    } catch (err) {
      const prog = $('#event-image-progress'); const bar = $('#event-image-progress-bar');
      if (prog) prog.style.display = 'none'; if (bar) bar.style.width = '0%';
      const report = describeAdminError('upload_event_image', err, document.documentElement.lang || 'ar');
      setEventImageUI($('#event-image-url')?.value || '', `${report.title}: ${report.reason}`, 'error');
      showEventOperationError('upload_event_image', err, form);
    } finally {
      fileInput.value = '';
    }
  };
  if (removeBtn) removeBtn.onclick = () => {
    if (!confirm('إزالة صورة الفعالية من هذا السجل؟ (لن تُحذف تلقائياً من التخزين إن كانت مستخدمة في مكان آخر)')) return;
    setEventImageUI('', 'تمت إزالة الصورة من النموذج. احفظ التعديلات لتطبيق ذلك.', '');
  };
  if (urlInput) urlInput.oninput = () => {
    const v = (urlInput.value || '').trim();
    const hidden = $('#event-image-url'); if (hidden) hidden.value = v;
    const preview = $('#event-image-preview'); if (preview) preview.innerHTML = v ? `<img src="${esc(v)}" alt="معاينة صورة الفعالية">` : '<div class="image-placeholder">لا توجد صورة حالياً</div>';
    const rb = $('#event-image-remove'); if (rb) rb.disabled = !v;
  };

  form.onsubmit = async (ev) => {
    ev.preventDefault();
    clearFieldErrors(form);
    const priorError = form.querySelector('#event-form-error');
    if (priorError) { priorError.hidden = true; priorError.innerHTML = ''; }
    const fd = readForm(form);
    const editId = form.dataset.edit || null;
    const capacityEnabled = !!$('#ev-capacity-enabled')?.checked;
    const totalSeatsRaw = $('#ev-total-seats')?.value;
    const totalSeats = capacityEnabled && totalSeatsRaw !== '' && totalSeatsRaw != null ? parseInt(totalSeatsRaw, 10) : null;
    const priceRaw = String(fd.price_iqd || '').trim();
    const parsedPrice = priceRaw ? Number(priceRaw) : null;
    const ticketsEnabled = !!$('#ev-tickets-enabled')?.checked;
    const registrationOpen = !!$('#ev-registration-open')?.checked;
    const showTicketToAttendee = !!$('#ev-show-ticket-attendee')?.checked;
    const qrCheckinEnabled = !!$('#ev-qr-checkin-enabled')?.checked;
    const payload = {
      title_ar: (fd.title_ar || '').trim(),
      title_en: (fd.title_en || '').trim(),
      category: fd.category || 'other',
      event_date: fd.event_date || null,
      event_time: fd.event_time || null,
      price_iqd: parsedPrice,
      price_note: (fd.price_note || '').trim() || null,
      participation_details: (fd.participation_details || '').trim() || null,
      description_ar: (fd.description_ar || '').trim() || null,
      description_en: (fd.description_en || '').trim() || null,
      image_url: (fd.image_url || $('#event-image-url-input')?.value || '').trim() || null,
      registration_open: registrationOpen,
      capacity_enabled: capacityEnabled,
      total_seats: capacityEnabled ? (Number.isFinite(totalSeats) && totalSeats > 0 ? totalSeats : null) : null,
      tickets_enabled: ticketsEnabled,
      show_ticket_to_attendee: showTicketToAttendee,
      qr_checkin_enabled: qrCheckinEnabled,
      updated_at: new Date().toISOString(),
    };
    let bad = false;
    if (!payload.title_ar) { showFieldError('#f-title-ar', 'العنوان مطلوب'); bad = true; }
    if (!payload.title_en) { showFieldError('#f-title-en', 'العنوان الإنجليزي مطلوب وفقاً لمخطط قاعدة البيانات.'); bad = true; }
    if (!payload.event_date) { showFieldError('#f-date', 'التاريخ مطلوب'); bad = true; }
    if (!payload.event_time) { showFieldError('#f-time', 'الوقت مطلوب'); bad = true; }
    if (priceRaw && (!Number.isSafeInteger(parsedPrice) || parsedPrice < 0)) {
      showFieldError('#f-price', 'أدخل سعراً صحيحاً كعدد صحيح غير سالب.'); bad = true;
    }
    if (payload.capacity_enabled && (!/^\d+$/.test(String(totalSeatsRaw || '').trim()) || !payload.total_seats || payload.total_seats < 1)) {
      showFieldError('#f-total-seats', 'أدخل عدداً صحيحاً للمقاعد لا يقل عن 1.'); bad = true;
    }
    if (bad) {
      form.querySelector('.field.error input, .field.error textarea, .field.error select')?.focus({ preventScroll: false });
      return;
    }
    if (form.dataset.saving === 'true') return;
    form.dataset.saving = 'true';
    const saveBtn = $('#event-save-btn');
    if (saveBtn) { saveBtn.disabled = true; saveBtn.setAttribute('aria-busy', 'true'); }
    try {
      const saved = await saveEventRecord(sb(), editId, payload);
      showToast(editId ? 'تم تحديث الفعالية' : 'تم إنشاء الفعالية (غير منشورة)');
      await logAdminActivity(editId ? 'update_event' : 'create_event', 'event', editId || saved.id, { title: payload.title_ar });
      closeEventForm();
      try { await renderEvents(); }
      catch (refreshError) { showEventOperationError('refresh_events', refreshError); }
    } catch (err) { showEventOperationError(editId ? 'update_event' : 'create_event', err, form); }
    finally {
      delete form.dataset.saving;
      if (saveBtn) { saveBtn.disabled = false; saveBtn.removeAttribute('aria-busy'); }
    }
  };
}

window.togglePublish = async (id, publish) => {
  const next = publish === true || publish === 'true';
  if (!confirm(next ? 'نشر هذه الفعالية على الموقع العام؟' : 'إلغاء نشر هذه الفعالية من الموقع العام؟')) return;
  try {
    const { error } = await sb().from('events').update({ published: next, updated_at: new Date().toISOString() }).eq('id', id);
    if (error) throw error;
    showToast(next ? 'تم نشر الفعالية' : 'تم إلغاء نشر الفعالية');
    await logAdminActivity(next ? 'publish_event' : 'unpublish_event', 'event', id, { published: next });
    try { await renderEvents(); } catch (err) { showEventOperationError('refresh_events', err); }
  } catch (err) { showEventOperationError(next ? 'publish_event' : 'unpublish_event', err); }
};

window.deleteEvent = async (id) => {
  if (!confirm('هل تريد حذف هذه الفعالية؟ ستبقى التسجيلات محفوظة.')) return;
  try {
    const { error } = await sb().from('events').delete().eq('id', id);
    if (error) throw error;
    showToast('تم حذف الفعالية');
    await logAdminActivity('delete_event', 'event', id, {});
    closeEventForm();
    try { await renderEvents(); } catch (err) { showEventOperationError('refresh_events', err); }
  } catch (err) { showEventOperationError('delete_event', err); }
};

// ---------- Event Bookings / Registrations ----------
async function renderEventBookings(forceReload = true) {
  const container = $('#eventbookings-list');
  const detailBox = $('#eventbooking-detail');
  if (container) container.innerHTML = '<div class="loading-state">جاري تحميل التسجيلات…</div>';
  if (detailBox) detailBox.innerHTML = '';
  try {
    if (forceReload !== false) await Promise.all([loadEventBookings(), loadEvents(), loadTickets(true)]);
    else {
      if (!state.events.length) await loadEvents();
      await loadTickets(true);
    }
  } catch (err) {
    if (container) container.innerHTML = `<div class="empty"><h3>تعذر تحميل التسجيلات</h3><p>${esc(friendlyError(err, 'حدث خطأ أثناء تحميل التسجيلات.'))}</p><div style="margin-top:12px"><button type="button" class="btn-secondary" onclick="app.renderEventBookings(true)">إعادة المحاولة</button></div></div>`;
    return;
  }

  const search = ($('#eb-search')?.value || '').toLowerCase().trim();
  const presetEvent = state.eventBookingsFilterEvent || '';
  const eventFilter = ($('#eb-event-filter')?.value ?? presetEvent) || '';
  const statusFilter = $('#eb-status-filter')?.value || '';
  const dateFrom = $('#eb-date-from')?.value || '';
  const dateTo = $('#eb-date-to')?.value || '';

  const ticketByBooking = (state.tickets || []).reduce((acc,t)=>{ const bid = String(t.booking_id||''); if (bid) acc[bid]=t; return acc; }, {});
  const filtered = state.eventBookings.filter((b) => {
    const evTitle = b.events?.title_ar || b.events?.title_en || '';
    const tk = ticketByBooking[String(b.id||'')] || null;
    const text = `${b.visitor_name || ''} ${b.phone || ''} ${evTitle} ${tk?.ticket_number || ''} ${b.id || ''}`.toLowerCase();
    const d = dateOnly(b.created_at);
    if (search && !text.includes(search)) return false;
    if (eventFilter && String(b.event_id || '') !== String(eventFilter)) return false;
    if (statusFilter && b.status !== statusFilter) return false;
    if (dateFrom && d !== '-' && d < dateFrom) return false;
    if (dateTo && d !== '-' && d > dateTo) return false;
    return true;
  });

  const eventOpts = state.events.map((e) => `<option value="${esc(e.id)}" ${String(eventFilter)===String(e.id)?'selected':''}>${esc(e.title_ar || e.title_en || 'فعالية')} — ${dateOnly(e.event_date)}</option>`).join('');
  const countsByEvent = state.eventBookings.reduce((acc, b) => { const k = b.event_id ? String(b.event_id) : 'none'; acc[k] = (acc[k]||0)+1; return acc; }, {});
  const selectedEvent = eventFilter ? state.events.find((e) => String(e.id) === String(eventFilter)) : null;
  const selectedCount = eventFilter ? (countsByEvent[String(eventFilter)] || 0) : state.eventBookings.length;

  if (!container) return;
  if (!state.eventBookings.length) {
    container.innerHTML = `<div class="empty"><h3>لا توجد تسجيلات فعاليات</h3><p>ستظهر هنا تسجيلات الزوار للفعاليات المنشورة.</p><div style="margin-top:12px"><button type="button" class="btn-secondary" onclick="app.renderEventBookings(true)">تحديث القائمة</button></div></div>`;
    return;
  }

    container.innerHTML = `
    ${selectedEvent ? `<div class="panel" style="margin-bottom:14px"><div class="panel-head"><h3>تسجيلات فعالية: ${esc(selectedEvent.title_ar || selectedEvent.title_en || '')}</h3></div><div class="panel-body" style="display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between"><div><div class="sub">${dateOnly(selectedEvent.event_date)} ${timeShort(selectedEvent.event_time)} · ${statusBadge(selectedEvent.published?'published':'unpublished')}</div><div style="margin-top:6px"><span class="badge badge-reviewed">${selectedCount} تسجيل مرتبط</span></div></div><div class="actions"><button type="button" class="btn-secondary" onclick="app.clearEventBookingFilter()">عرض كل التسجيلات</button></div></div></div>` : ''}
    <div class="panel" style="margin-bottom:14px"><div class="panel-body">
      <div class="toolbar" style="margin:0">
        <div class="search"><input id="eb-search" placeholder="بحث بالاسم أو الهاتف أو اسم الفعالية أو رقم التذكرة" value="${esc(search)}"></div>
        <select id="eb-event-filter"><option value="">كل الفعاليات</option>${eventOpts}</select>
        <select id="eb-status-filter">
          <option value="">كل الحالات</option>
          <option value="pending" ${statusFilter==='pending'?'selected':''}>قيد الانتظار</option>
          <option value="reviewed" ${statusFilter==='reviewed'?'selected':''}>تمت المراجعة</option>
          <option value="contacted" ${statusFilter==='contacted'?'selected':''}>تم التواصل</option>
          <option value="confirmed" ${statusFilter==='confirmed'?'selected':''}>تم التأكيد</option>
          <option value="rejected" ${statusFilter==='rejected'?'selected':''}>مرفوض</option>
        </select>
        <input type="date" id="eb-date-from" value="${esc(dateFrom)}" title="من تاريخ التسجيل">
        <input type="date" id="eb-date-to" value="${esc(dateTo)}" title="إلى تاريخ التسجيل">
        <button type="button" class="btn-secondary" onclick="app.renderEventBookings(true)">تحديث</button>
        <button type="button" class="btn-secondary" onclick="app.exportEventBookingsCsv()">تصدير CSV</button>
      </div>
      <div class="page-meta" style="margin:10px 0 0">إجمالي التسجيلات: ${state.eventBookings.length} · المعروض بعد الفلاتر: ${filtered.length}</div>
    </div></div>
    ${filtered.length ? `<div class="table-wrap"><table><thead><tr><th>المسجّل</th><th>الهاتف</th><th>الفعالية</th><th>التذكرة / الحضور</th><th>تاريخ ووقت التسجيل</th><th>الحالة</th><th>ملاحظات إدارية</th><th>الإجراءات</th></tr></thead><tbody>` + filtered.map((b) => {
      const ev = b.events ? `<strong>${esc(b.events.title_ar || b.events.title_en || 'فعالية')}</strong><div class="sub">${dateOnly(b.events.event_date)} ${timeShort(b.events.event_time)}</div>` : '<span class="sub">طلب عام / بدون فعالية محددة</span>';
      const created = b.created_at ? String(b.created_at) : '';
      const tpart = created.includes('T') ? created.split('T')[1].slice(0,5) : '';
      const tk = ticketByBooking[String(b.id||'')] || null;
      const evObj = state.events.find(e=>String(e.id)===String(b.event_id||''));
      const tStatus = tk ? String(tk.ticket_status||'') : '';
      const tBadge = !tk ? '<span class="sub">—</span>' : (tStatus==='used'?'<span class="badge badge-reviewed">تم الحضور</span>':tStatus==='cancelled'?'<span class="badge badge-rejected">ملغاة</span>':'<span class="badge badge-confirmed">صالحة</span>');
      const ticketCell = tk
        ? `<div><strong class="mono">${esc(tk.ticket_number||'-')}</strong></div>${tBadge}${tk.used_at?`<div class="sub">استخدام: ${dateOnly(tk.used_at)}</div>`:''}`
        : (evObj && evObj.tickets_enabled ? '<span class="sub">لا توجد تذكرة مُصدرة</span>' : '<span class="sub">—</span>');
      const canIssue = !tk && evObj && evObj.tickets_enabled && !['rejected','cancelled'].includes(String(b.status||''));
      return `<tr>
        <td><strong>${esc(b.visitor_name || '-')}</strong><div class="sub">مقاعد: ${esc(b.seats ?? 1)}</div></td>
        <td><a class="m-link" href="tel:${esc(b.phone)}">${esc(b.phone || '-')}</a></td>
        <td>${ev}</td>
        <td>${ticketCell}</td>
        <td>${dateOnly(b.created_at)}${tpart ? `<div class="sub">${esc(tpart)}</div>` : ''}</td>
        <td>${statusBadge(b.status)}</td>
        <td>${esc(b.admin_notes || '—')}</td>
        <td><div class="actions">
          <button type="button" class="edit" onclick="app.viewBookingDetail('${esc(b.id)}')">التفاصيل</button>
          ${tk ? `<button type="button" class="status" onclick="app.viewTicket('${esc(tk.ticket_id||tk.id||'')}')">التذكرة/QR</button>` : ''}
          ${canIssue ? `<button type="button" class="status" onclick="app.issueTicket('${esc(b.id)}')">إصدار تذكرة</button>` : ''}
          <select aria-label="تغيير الحالة" onchange="app.updateBookingStatus('${esc(b.id)}', this.value)">
            ${['pending','reviewed','contacted','confirmed','rejected'].map(s=>`<option value="${s}" ${b.status===s?'selected':''}>${s}</option>`).join('')}
          </select>
          <button type="button" onclick="app.editBookingNotes('${esc(b.id)}')">ملاحظات</button>
        </div></td>
      </tr>`;
    }).join('') + '</tbody></table></div>' : '<div class="empty"><h3>لا نتائج مطابقة</h3><p>لا توجد تسجيلات تطابق الفلاتر الحالية. جرّب مسح البحث أو تغيير الفعالية/الحالة/نطاق التاريخ.</p></div>'}`;

  const rerender = () => renderEventBookings(false);
  $('#eb-search') && ($('#eb-search').oninput = rerender);
  $('#eb-event-filter') && ($('#eb-event-filter').onchange = () => { state.eventBookingsFilterEvent = $('#eb-event-filter').value || ''; rerender(); });
  $('#eb-status-filter') && ($('#eb-status-filter').onchange = rerender);
  $('#eb-date-from') && ($('#eb-date-from').onchange = rerender);
  $('#eb-date-to') && ($('#eb-date-to').onchange = rerender);
}

window.clearEventBookingFilter = () => { state.eventBookingsFilterEvent = ''; renderEventBookings(false); };
window.exportEventBookingsCsv = () => {
  const search = ($('#eb-search')?.value || '').toLowerCase().trim();
  const eventFilter = $('#eb-event-filter')?.value || state.eventBookingsFilterEvent || '';
  const statusFilter = $('#eb-status-filter')?.value || '';
  const dateFrom = $('#eb-date-from')?.value || '';
  const dateTo = $('#eb-date-to')?.value || '';
  const ticketByBooking = (state.tickets || []).reduce((acc,t)=>{ const bid = String(t.booking_id||''); if (bid) acc[bid]=t; return acc; }, {});
  const rows = (state.eventBookings || []).filter((b) => {
    const evTitle = (b.events && (b.events.title_ar || b.events.title_en)) || '';
    const tk = ticketByBooking[String(b.id||'')] || null;
    const text = `${b.visitor_name || ''} ${b.phone || ''} ${evTitle} ${tk?.ticket_number || ''} ${b.id || ''}`.toLowerCase();
    const matchSearch = !search || text.includes(search);
    const matchEvent = !eventFilter || String(b.event_id || '') === String(eventFilter);
    const matchStatus = !statusFilter || b.status === statusFilter;
    const d = b.created_at ? String(b.created_at).slice(0,10) : '';
    const matchFrom = !dateFrom || (d && d >= dateFrom);
    const matchTo = !dateTo || (d && d <= dateTo);
    return matchSearch && matchEvent && matchStatus && matchFrom && matchTo;
  });
  if (!rows.length) { showToast('لا توجد تسجيلات لتصديرها وفق الفلاتر الحالية.', 'error'); return; }
  const headers = ['booking_id','visitor_name','phone','seats','booking_status','event_id','event_title','event_date','event_time','created_at','ticket_number','ticket_status','used_at','admin_notes'];
  const csvEsc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g,'""') + '"' : s;
  };
  const lines = [headers.join(',')];
  rows.forEach((b) => {
    const ev = b.events || {};
    const tk = ticketByBooking[String(b.id||'')] || null;
    lines.push([
      b.id, b.visitor_name, b.phone, b.seats ?? 1, b.status,
      b.event_id || '', ev.title_ar || ev.title_en || '', ev.event_date || '', ev.event_time || '',
      b.created_at || '', tk?.ticket_number || '', tk?.ticket_status || (tk?.status || ''), tk?.used_at || '', b.admin_notes || ''
    ].map(csvEsc).join(','));
  });
  const blob = new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `the-zone-event-bookings-${new Date().toISOString().slice(0,10)}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(url), 2000);
  showToast(`تم تصدير ${rows.length} تسجيل إلى CSV`);
};
window.viewBookingDetail = (id) => {
  const b = state.eventBookings.find((x) => String(x.id) === String(id));
  const box = $('#eventbooking-detail');
  if (!b || !box) return;
  const ev = b.events;
  const tk = (state.tickets || []).find(t => String(t.booking_id||'') === String(b.id||'')) || null;
  const evObj = state.events.find(e=>String(e.id)===String(b.event_id||''));
  const tStatus = tk ? String(tk.ticket_status||'') : '';
  const tLabel = !tk ? '—' : (tStatus==='used'?'تم تسجيل الحضور':tStatus==='cancelled'?'ملغاة':'صالحة');
  box.innerHTML = `<div class="panel"><div class="panel-head"><h3>تفاصيل التسجيل</h3></div><div class="panel-body">
    <div class="form-grid">
      <div><div class="hint">المسجّل</div><strong>${esc(b.visitor_name || '-')}</strong></div>
      <div><div class="hint">الهاتف</div><a class="m-link" href="tel:${esc(b.phone)}">${esc(b.phone || '-')}</a></div>
      <div><div class="hint">الفعالية</div><strong>${esc(ev?.title_ar || ev?.title_en || 'طلب عام / بدون فعالية')}</strong>${ev ? `<div class="sub">${dateOnly(ev.event_date)} ${timeShort(ev.event_time)}</div>` : ''}</div>
      <div><div class="hint">عدد المقاعد</div><strong>${esc(b.seats ?? 1)}</strong></div>
      <div><div class="hint">حالة التسجيل</div>${statusBadge(b.status)}</div>
      <div><div class="hint">تاريخ التسجيل</div>${dateOnly(b.created_at)}</div>
      <div><div class="hint">رقم التذكرة</div><strong class="mono">${esc(tk?.ticket_number || '—')}</strong></div>
      <div><div class="hint">حالة التذكرة / الحضور</div><strong>${esc(tLabel)}</strong>${tk?.used_at?`<div class="sub">وقت الاستخدام: ${esc(String(tk.used_at).replace('T',' ').slice(0,19))}</div>`:''}</div>
      <div class="full"><div class="hint">ملاحظات إدارية</div><div>${esc(b.admin_notes || '—')}</div></div>
    </div>
    <div class="save-bar">
      ${tk ? `<button type="button" class="btn-secondary" onclick="app.viewTicket('${esc(tk.ticket_id||tk.id||'')}')">عرض التذكرة / QR</button>` : ''}
      ${(!tk && evObj && evObj.tickets_enabled && !['rejected','cancelled'].includes(String(b.status||''))) ? `<button type="button" class="btn-secondary" onclick="app.issueTicket('${esc(b.id)}')">إصدار تذكرة</button>` : ''}
      <button type="button" class="btn-cancel" onclick="document.getElementById('eventbooking-detail').innerHTML=''">إغلاق</button>
    </div>
  </div></div>`;
  box.scrollIntoView({ behavior: 'smooth', block: 'start' });
};

window.updateBookingStatus = async (id, status) => {
  try {
    const { error } = await sb().from('event_bookings').update({ status, updated_at: new Date().toISOString() }).eq('id', id);
    if (error) throw error;
    showToast('تم تحديث حالة الطلب');
    await logAdminActivity('update_event_booking_status', 'event_booking', id, { status });
    await renderEventBookings(true);
  } catch (err) { showToast(err.message, 'error'); }
};

window.editBookingNotes = async (id) => {
  const current = state.eventBookings.find((x)=>String(x.id)===String(id))?.admin_notes || '';
  const notes = prompt('ملاحظات إدارية:', current);
  if (notes === null) return;
  try {
    const { error } = await sb().from('event_bookings').update({ admin_notes: notes, updated_at: new Date().toISOString() }).eq('id', id);
    if (error) throw error;
    showToast('تم حفظ الملاحظات');
    await logAdminActivity('update_event_booking_notes', 'event_booking', id, {});
    await renderEventBookings(true);
  } catch (err) { showToast(err.message, 'error'); }
};

// ---------- Space Bookings ----------
async function renderSpaceBookings() {
  await loadSpaceBookings();
  const container = $('#spacebookings-list');
  if (!state.spaceBookings.length) {
    if (container) container.innerHTML = '<div class="empty"><h3>لا توجد طلبات حجز مساحة</h3><p>عندما يرسل زائر طلب حجز مساحة سيظهر هنا.</p></div>';
    return;
  }
  const search = ($('#sb-search')?.value || '').toLowerCase();
  const statusFilter = $('#sb-status-filter')?.value || '';
  const rows = state.spaceBookings.filter((b) => {
    const text = `${b.visitor_name || ''} ${b.phone || ''} ${b.organization || ''} ${b.usage_type || ''}`.toLowerCase();
    return (!search || text.includes(search)) && (!statusFilter || b.status === statusFilter);
  });
  if (container) {
    container.innerHTML = `
    <div class="toolbar">
      <div class="search"><input id="sb-search" placeholder="بحث بالاسم أو الهاتف أو الجهة" value="${esc(search)}"></div>
      <select id="sb-status-filter">
        <option value="">كل الحالات</option>
        ${['pending','reviewed','contacted','confirmed','rejected'].map(s=>`<option value="${s}" ${statusFilter===s?'selected':''}>${s}</option>`).join('')}
      </select>
    </div>
    ${rows.length ? `<div class="table-wrap"><table><thead><tr><th>الزائر</th><th>الهاتف</th><th>الجهة/النوع</th><th>الموعد المطلوب</th><th>الحضور</th><th>المرافق</th><th>التفاصيل</th><th>الحالة</th><th>الإجراءات</th></tr></thead><tbody>` + rows.map((b) => `<tr>
      <td>${esc(b.visitor_name)}</td>
      <td><a class="m-link" href="tel:${esc(b.phone)}">${esc(b.phone)}</a></td>
      <td><strong>${esc(b.usage_type || '-')}</strong><div class="sub">${esc(b.organization || 'بدون جهة')}</div></td>
      <td>${dateOnly(b.requested_date)}<div class="sub">${timeShort(b.start_time)} – ${timeShort(b.end_time)}</div></td>
      <td>${esc(b.expected_attendance)}</td>
      <td>${esc((b.facilities || []).join('، ') || '-')}</td>
      <td>${esc(b.details || '-')}</td>
      <td>${statusBadge(b.status)}</td>
      <td><div class="actions">
        <select onchange="app.updateSpaceStatus('${esc(b.id)}', this.value)">
          ${['pending','reviewed','contacted','confirmed','rejected'].map(s=>`<option value="${s}" ${b.status===s?'selected':''}>${s}</option>`).join('')}
        </select>
        <button type="button" onclick="app.editSpaceNotes('${esc(b.id)}')">ملاحظات</button>
      </div></td>
    </tr>`).join('') + '</tbody></table></div>' : '<div class="empty"><h3>لا نتائج مطابقة</h3><p>جرّب تعديل البحث أو الفلاتر.</p></div>'}`;
    $('#sb-search')?.addEventListener('input', () => renderSpaceBookings());
    $('#sb-status-filter')?.addEventListener('change', () => renderSpaceBookings());
  }
}

window.updateSpaceStatus = async (id, status) => {
  try {
    const { error } = await sb().from('space_bookings').update({ status, updated_at: new Date().toISOString() }).eq('id', id);
    if (error) throw error;
    showToast('تم تحديث حالة الطلب');
    await renderSpaceBookings();
  } catch (err) { showToast(err.message, 'error'); }
};

window.editSpaceNotes = async (id) => {
  const current = state.spaceBookings.find((x)=>String(x.id)===String(id))?.admin_notes || '';
  const notes = prompt('ملاحظات إدارية:', current);
  if (notes === null) return;
  try {
    const { error } = await sb().from('space_bookings').update({ admin_notes: notes, updated_at: new Date().toISOString() }).eq('id', id);
    if (error) throw error;
    showToast('تم حفظ الملاحظات');
    await renderSpaceBookings();
  } catch (err) { showToast(err.message, 'error'); }
};

// ---------- Community ----------
async function renderCommunity() {
  await loadCommunity();
  const container = $('#community-list');
  if (!state.community.length) {
    if (container) container.innerHTML = '<div class="empty"><h3>لا توجد تسجيلات مجتمع</h3><p>عندما يسجل زائر اهتمامه بالانضمام سيظهر هنا.</p></div>';
    return;
  }
  const search = ($('#c-search')?.value || '').toLowerCase();
  const statusFilter = ($('#c-status-filter')?.value || '');
  const rows = state.community.filter((c) => {
    const text = `${c.visitor_name || ''} ${c.phone || ''} ${c.interest || ''} ${c.message || ''}`.toLowerCase();
    return (!search || text.includes(search)) && (!statusFilter || c.status === statusFilter);
  });
  if (container) {
    container.innerHTML = `
    <div class="toolbar">
      <div class="search"><input id="c-search" placeholder="بحث بالاسم أو الهاتف أو الاهتمام" value="${esc(search)}"></div>
      <select id="c-status-filter">
        <option value="">كل الحالات</option>
        ${['pending','reviewed','contacted'].map(s=>`<option value="${s}" ${statusFilter===s?'selected':''}>${s}</option>`).join('')}
      </select>
    </div>
    ${rows.length ? `<div class="table-wrap"><table><thead><tr><th>الاسم</th><th>الهاتف</th><th>الاهتمام</th><th>الرسالة</th><th>الحالة</th><th>الإجراءات</th></tr></thead><tbody>` + rows.map((c) => `<tr>
      <td>${esc(c.visitor_name)}</td>
      <td><a class="m-link" href="tel:${esc(c.phone)}">${esc(c.phone)}</a></td>
      <td>${esc(c.interest)}</td>
      <td>${esc(c.message || '-')}</td>
      <td>${statusBadge(c.status)}</td>
      <td><div class="actions">
        <select onchange="app.updateCommunityStatus('${esc(c.id)}', this.value)">
          ${['pending','reviewed','contacted'].map(s=>`<option value="${s}" ${c.status===s?'selected':''}>${s}</option>`).join('')}
        </select>
        <button type="button" onclick="app.editCommunityNotes('${esc(c.id)}')">ملاحظات</button>
      </div></td>
    </tr>`).join('') + '</tbody></table></div>' : '<div class="empty"><h3>لا نتائج مطابقة</h3><p>جرّب تعديل البحث أو الفلاتر.</p></div>'}`;
    $('#c-search')?.addEventListener('input', () => renderCommunity());
    $('#c-status-filter')?.addEventListener('change', () => renderCommunity());
  }
}

window.updateCommunityStatus = async (id, status) => {
  try {
    const { error } = await sb().from('community_registrations').update({ status, updated_at: new Date().toISOString() }).eq('id', id);
    if (error) throw error;
    showToast('تم تحديث حالة التسجيل');
    await renderCommunity();
  } catch (err) { showToast(err.message, 'error'); }
};

window.editCommunityNotes = async (id) => {
  const current = state.community.find((x)=>String(x.id)===String(id))?.admin_notes || '';
  const notes = prompt('ملاحظات إدارية:', current);
  if (notes === null) return;
  try {
    const { error } = await sb().from('community_registrations').update({ admin_notes: notes, updated_at: new Date().toISOString() }).eq('id', id);
    if (error) throw error;
    showToast('تم حفظ الملاحظات');
    await renderCommunity();
  } catch (err) { showToast(err.message, 'error'); }
};

// ---------- Ideas ----------
async function renderIdeas() {
  await loadIdeas();
  const container = $('#ideas-list');
  if (!state.ideas.length) {
    if (container) container.innerHTML = '<div class="empty"><h3>لا توجد أفكار أو مبادرات</h3><p>عندما يرسل زائر فكرة من الموقع العام ستظهر هنا للمراجعة.</p></div>';
    return;
  }
  const search = ($('#i-search')?.value || '').toLowerCase();
  const typeFilter = $('#i-type-filter')?.value || '';
  const statusFilter = $('#i-status-filter')?.value || '';
  const rows = state.ideas.filter((idea) => {
    const text = `${idea.idea_title || ''} ${idea.submitter_name || ''} ${idea.phone || ''} ${idea.summary || ''}`.toLowerCase();
    return (!search || text.includes(search)) && (!typeFilter || idea.idea_type === typeFilter) && (!statusFilter || idea.status === statusFilter);
  });
  if (container) {
    container.innerHTML = `
    <div class="toolbar">
      <div class="search"><input id="i-search" placeholder="بحث بالعنوان أو المقدم أو الملخص" value="${esc(search)}"></div>
      <select id="i-type-filter">
        <option value="">كل الأنواع</option>
        <option value="event" ${typeFilter==='event'?'selected':''}>فعالية</option>
        <option value="initiative" ${typeFilter==='initiative'?'selected':''}>مبادرة</option>
        <option value="club" ${typeFilter==='club'?'selected':''}>نادي</option>
        <option value="community_activity" ${typeFilter==='community_activity'?'selected':''}>نشاط مجتمعي</option>
        <option value="other" ${typeFilter==='other'?'selected':''}>أخرى</option>
      </select>
      <select id="i-status-filter">
        <option value="">كل الحالات</option>
        ${['pending_review','under_review','contacted','accepted_for_discussion','declined'].map(s=>`<option value="${s}" ${statusFilter===s?'selected':''}>${s}</option>`).join('')}
      </select>
    </div>
    ${rows.length ? `<div class="table-wrap"><table><thead><tr><th>الفكرة</th><th>المقدم</th><th>النوع</th><th>الفئة/الدعم</th><th>الحالة</th><th>الإجراءات</th></tr></thead><tbody>` + rows.map((idea) => `<tr>
      <td><strong>${esc(idea.idea_title)}</strong><div class="sub">${esc(idea.summary || '')}</div></td>
      <td>${esc(idea.submitter_name)}<div class="sub"><a class="m-link" href="tel:${esc(idea.phone)}">${esc(idea.phone)}</a></div></td>
      <td>${esc(ideaTypeAr(idea.idea_type))}</td>
      <td>${esc(idea.target_audience || '-')}<div class="sub">${esc(supportAr(idea.requested_support) || '-')}</div></td>
      <td>${statusBadge(idea.status)}</td>
      <td><div class="actions">
        <select onchange="app.updateIdeaStatus('${esc(idea.id)}', this.value)">
          ${['pending_review','under_review','contacted','accepted_for_discussion','declined'].map(s=>`<option value="${s}" ${idea.status===s?'selected':''}>${s}</option>`).join('')}
        </select>
        <button type="button" onclick="app.editIdeaNotes('${esc(idea.id)}')">ملاحظات</button>
      </div></td>
    </tr>`).join('') + '</tbody></table></div>' : '<div class="empty"><h3>لا نتائج مطابقة</h3><p>جرّب تعديل البحث أو الفلاتر.</p></div>'}`;
    $('#i-search')?.addEventListener('input', () => renderIdeas());
    $('#i-type-filter')?.addEventListener('change', () => renderIdeas());
    $('#i-status-filter')?.addEventListener('change', () => renderIdeas());
  }
}

window.updateIdeaStatus = async (id, status) => {
  try {
    const { error } = await sb().from('ideas_initiatives').update({ status, updated_at: new Date().toISOString() }).eq('id', id);
    if (error) throw error;
    showToast('تم تحديث حالة الفكرة');
    await renderIdeas();
  } catch (err) { showToast(err.message, 'error'); }
};

window.editIdeaNotes = async (id) => {
  const current = state.ideas.find((x)=>String(x.id)===String(id))?.admin_notes || '';
  const notes = prompt('ملاحظات مراجعة داخلية:', current);
  if (notes === null) return;
  try {
    const { error } = await sb().from('ideas_initiatives').update({ admin_notes: notes, updated_at: new Date().toISOString() }).eq('id', id);
    if (error) throw error;
    showToast('تم حفظ الملاحظات');
    await renderIdeas();
  } catch (err) { showToast(err.message, 'error'); }
};


// ---------- Insights ----------
async function renderInsights() {
  const root = $('#insights-root');
  if (root) root.innerHTML = '<div class="loading-state">جاري تحميل التحليلات الحقيقية…</div>';
  await loadAll();
  try { await loadTickets(true); } catch (_) {}
  const ins = computeInsights();
  const byEvent = ins.bookingsByEvent || {};
  const capEvents = state.events.filter(e => e.capacity_enabled && e.total_seats).map(e => {
    const occ = byEvent[String(e.id)] || 0;
    const total = Number(e.total_seats)||0;
    const pct = total ? Math.min(100, Math.round((occ/total)*100)) : 0;
    return { title: e.title_ar||e.title_en||'فعالية', occ, total, pct, remaining: Math.max(0,total-occ) };
  }).sort((a,b)=>b.pct-a.pct).slice(0,8);
  const notifications = buildNotifications();
  const eventPerf = state.events.filter(e=>e.published).map(e=>({ title: e.title_ar||e.title_en||'فعالية', count: byEvent[String(e.id)]||0, date: e.event_date||'' }))
    .sort((a,b)=>b.count-a.count).slice(0,8);
  if (!root) return;
  root.innerHTML = `
    <div class="kpi-grid">
      <div class="kpi"><div class="k">فعاليات قادمة (7 أيام)</div><div class="v">${ins.upcoming7}</div><div class="s">منشورة ضمن الأسبوع القادم</div></div>
      <div class="kpi"><div class="k">فعاليات قادمة (30 يوماً)</div><div class="v">${ins.upcoming30}</div><div class="s">نافذة تخطيط شهرية</div></div>
      <div class="kpi"><div class="k">تسجيلات معلّقة</div><div class="v">${ins.pendingBookings}</div><div class="s">تحتاج مراجعة/تواصل</div></div>
      <div class="kpi"><div class="k">نسبة الحضور (للتذاكر)</div><div class="v">${ins.attendanceRate}%</div><div class="s">${ins.attended} من ${ins.ticketsIssued} تذكرة</div></div>
    </div>
    <div class="dashboard-grid">
      <div class="panel"><div class="panel-head"><h3>اتجاه التسجيلات (14 يوماً)</h3></div><div class="panel-body">${renderMiniTrend(ins.trend)}</div></div>
      <div class="panel"><div class="panel-head"><h3>أفضل الفعاليات من حيث الطلب</h3></div><div class="panel-body">${eventPerf.length ? renderBarChart(eventPerf,'count','title') : '<div class="empty" style="padding:16px"><p>لا توجد تسجيلات كافية بعد.</p></div>'}</div></div>
    </div>
    <div class="dashboard-grid" style="margin-top:14px">
      <div class="panel"><div class="panel-head"><h3>إشغال السعة (للأدمن فقط)</h3></div><div class="panel-body">${capEvents.length ? `<div class="bar-chart">${capEvents.map(c=>`<div class="bar-row"><div>${esc(c.title).slice(0,26)}</div><div class="bar-track"><div class="bar-fill" style="width:${c.pct}%"></div></div><div><strong>${c.occ}/${c.total}</strong></div></div>`).join('')}</div><div class="hint" style="margin-top:8px">هذه الأرقام تشغيلية للإدارة ولا تُعرض للمستخدمين في الموقع العام.</div>` : '<div class="empty" style="padding:16px"><p>لا توجد فعاليات مفعّل لها نظام السعة حالياً أو لا توجد بيانات.</p></div>'}</div></div>
      <div class="panel"><div class="panel-head"><h3>التنبيهات</h3></div><div class="panel-body"><div class="insight-list">${notifications.map(n=>`<div class="insight ${esc(n.level||'info')}"><div style="display:flex;justify-content:space-between;gap:10px;align-items:center"><div>${esc(n.text)}</div>${n.action?`<button type="button" class="btn-secondary" style="padding:6px 10px;font-size:12px" onclick="${esc(n.action)};return false;">${esc(n.cta||'فتح')}</button>`:''}</div></div>`).join('')}${ins.lowEngagement.length?`<div class="insight info"><strong>فعاليات بلا تسجيلات:</strong> ${ins.lowEngagement.length} فعالية قادمة منشورة.</div>`:''}</div></div></div>
    </div>`;
}


window.viewTicket = async (ticketId) => {
  if (!ticketId) return;
  let t = (state.tickets || []).find(x => String(x.ticket_id||x.id||'') === String(ticketId));
  if (!t) { try { await loadTickets(true); } catch(_){} t = (state.tickets || []).find(x => String(x.ticket_id||x.id||'') === String(ticketId)); }
  if (!t) { showToast('تعذر العثور على التذكرة.', 'error'); return; }
  const status = String(t.ticket_status||'');
  const label = status==='used'?'تم تسجيل الحضور':status==='cancelled'?'ملغاة':'صالحة';
  const qrSrc = t.qr_token ? adminQrDataUrl(t.qr_token, 220) : '';
  const qr = qrSrc ? `<img src="${esc(qrSrc)}" alt="QR" style="width:220px;height:220px;border:1px solid var(--line);border-radius:12px;background:#fff">` : '<div class="hint">لا يوجد رمز QR محلي متاح.</div>';
  const host = $('#eventbooking-detail') || $('#tickets-root') || $('#app-body');
  if (!host) return;
  const modal = document.createElement('div');
  modal.className = 'panel'; modal.style.marginTop = '14px';
  modal.innerHTML = `<div class="panel-head"><h3>تفاصيل التذكرة الرقمية</h3><button type="button" class="btn-secondary" id="close-ticket-view">إغلاق</button></div>
    <div class="panel-body"><div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px;align-items:start">
      <div style="display:grid;gap:8px">
        <div><div class="hint">رقم التذكرة</div><strong class="mono">${esc(t.ticket_number||'-')}</strong></div>
        <div><div class="hint">الفعالية</div><strong>${esc(t.event_title||'-')}</strong><div class="sub">${dateOnly(t.event_date)} ${timeShort(t.event_time)}</div></div>
        <div><div class="hint">المسجّل</div><strong>${esc(t.visitor_name||'-')}</strong><div class="sub">${esc(t.phone||'-')}</div></div>
        <div><div class="hint">حالة التذكرة</div><strong>${esc(label)}</strong>${t.used_at?`<div class="sub">وقت الاستخدام: ${esc(String(t.used_at).replace('T',' ').slice(0,19))}</div>`:''}</div>
        <div><div class="hint">رقم الحجز</div><span class="mono">${esc(t.booking_id||'-')}</span></div>
      </div>
      <div style="text-align:center">${qr}<div class="hint" style="margin-top:6px">رمز QR خاص بهذه التذكرة</div></div>
    </div></div>`;
  // replace previous ticket view if any
  const prev = document.getElementById('ticket-detail-view'); if (prev) prev.remove();
  modal.id = 'ticket-detail-view';
  host.prepend(modal);
  modal.querySelector('#close-ticket-view').onclick = ()=> modal.remove();
  modal.scrollIntoView({ behavior:'smooth', block:'start' });
};


// ---------- Tickets ----------
let ticketsUi = { eventId: '', status: 'all', search: '', sort: 'issued_desc', page: 1, pageSize: 20, view: 'all' }; // view: all | missing | event:{id}

function _tzTicketStatusLabel(st){ st=String(st||''); if(st==='used') return 'تم تسجيل الحضور'; if(st==='cancelled') return 'ملغاة'; if(st==='valid') return 'صالحة'; if(st==='missing') return 'بانتظار الإصدار'; return st||'-'; }
function _tzTicketBadge(st){ st=String(st||''); if(st==='used') return '<span class="badge badge-reviewed">تم الحضور</span>'; if(st==='cancelled') return '<span class="badge badge-rejected">ملغاة</span>'; if(st==='valid') return '<span class="badge badge-confirmed">صالحة</span>'; if(st==='missing') return '<span class="badge badge-pending">بانتظار الإصدار</span>'; return `<span class="badge badge-unpublished">${esc(st||'-')}</span>`; }
function _tzNormalizeTicketRow(t){
  const b = t.event_bookings || t.booking || null;
  const e = t.events || t.event || null;
  const ticketId = t.ticket_id || t.id || (t.event_tickets && t.event_tickets.id) || null;
  const bookingId = t.booking_id || (b && b.id) || null;
  const eventId = t.event_id || (b && b.event_id) || (e && e.id) || null;
  return {
    ...t,
    ticket_id: ticketId,
    booking_id: bookingId,
    event_id: eventId,
    ticket_number: t.ticket_number || (ticketId ? ('#'+String(ticketId).slice(0,8)) : (bookingId ? '(غير مُصدر)' : '-')),
    ticket_status: t.ticket_status || t.status || (ticketId ? 'valid' : 'missing'),
    issued_at: t.issued_at || null,
    used_at: t.used_at || null,
    visitor_name: t.visitor_name || (b && b.visitor_name) || '-',
    phone: t.phone || (b && b.phone) || '-',
    seats: (t.seats != null ? t.seats : (b && b.seats != null ? b.seats : 1)),
    booking_status: t.booking_status || (b && b.status) || 'pending',
    event_title: t.event_title || (e && (e.title_ar || e.title_en)) || ((state.events||[]).find(x=>String(x.id)===String(eventId))||{}).title_ar || ((state.events||[]).find(x=>String(x.id)===String(eventId))||{}).title_en || 'فعالية',
    event_date: t.event_date || (e && e.event_date) || ((state.events||[]).find(x=>String(x.id)===String(eventId))||{}).event_date || null,
    event_time: t.event_time || (e && e.event_time) || ((state.events||[]).find(x=>String(x.id)===String(eventId))||{}).event_time || null,
    qr_token: t.qr_token || null,
    event_show_ticket_to_attendee: (e && e.show_ticket_to_attendee != null) ? e.show_ticket_to_attendee : ((state.events||[]).find(x=>String(x.id)===String(eventId))||{}).show_ticket_to_attendee,
  };
}


// Local QR generator for admin (no external dependency, keeps qr_token private). Byte mode, v1-10, ECC L.
const AdminTZQR = (() => {
  const GF256_EXP=new Array(512).fill(0), GF256_LOG=new Array(256).fill(0);
  (function(){let x=1; for(let i=0;i<255;i++){GF256_EXP[i]=x; GF256_LOG[x]=i; x<<=1; if(x&0x100) x^=0x11d;} for(let i=255;i<512;i++) GF256_EXP[i]=GF256_EXP[i-255];})();
  function gfMul(a,b){ if(a===0||b===0) return 0; return GF256_EXP[GF256_LOG[a]+GF256_LOG[b]]; }
  function rsPoly(ecLen){ let poly=[1]; for(let i=0;i<ecLen;i++){ const next=new Array(poly.length+1).fill(0); for(let j=0;j<poly.length;j++){ next[j]^=poly[j]; next[j+1]^=gfMul(poly[j],GF256_EXP[i]); } poly=next; } return poly; }
  function rsEncode(data,ecLen){ const gen=rsPoly(ecLen); const out=data.concat(new Array(ecLen).fill(0)); for(let i=0;i<data.length;i++){ const coef=out[i]; if(coef!==0){ for(let j=0;j<gen.length;j++) out[i+j]^=gfMul(gen[j],coef);} } return out.slice(data.length); }
  const VT={1:{s:21,dc:19,g:[[1,19,7]]},2:{s:25,dc:34,g:[[1,34,10]]},3:{s:29,dc:55,g:[[1,55,15]]},4:{s:33,dc:80,g:[[1,80,20]]},5:{s:37,dc:108,g:[[1,108,26]]},6:{s:41,dc:136,g:[[2,68,18]]},7:{s:45,dc:156,g:[[2,78,20]]},8:{s:49,dc:194,g:[[2,97,24]]},9:{s:53,dc:232,g:[[2,116,30]]},10:{s:57,dc:274,g:[[2,68,18],[2,69,18]]}};
  function chooseVer(len){ for(let v=1;v<=10;v++){ const capBits=VT[v].dc*8; const hdr=(v<=9)?12:16; if(hdr+len*8<=capBits) return v; } return 10; }
  function makeData(ver,bytes){ const spec=VT[ver]; const total=spec.dc; const bits=[]; const push=(val,len)=>{ for(let i=len-1;i>=0;i--) bits.push((val>>i)&1); }; push(0b0100,4); push(bytes.length, ver<=9?8:16); for(let i=0;i<bytes.length;i++) push(bytes[i],8); const cap=total*8; let term=0; while(bits.length<cap && term<4){bits.push(0);term++;} while(bits.length%8!==0) bits.push(0); const pad=[0xec,0x11]; let pi=0; while(bits.length<cap){ push(pad[pi%2],8); pi++; } const data=[]; for(let i=0;i<bits.length;i+=8){ let b=0; for(let j=0;j<8;j++) b=(b<<1)|bits[i+j]; data.push(b);} const groups=spec.g; let offset=0; const blocks=[]; groups.forEach(([count,dcnt,ecnt])=>{ for(let c=0;c<count;c++){ const d=data.slice(offset,offset+dcnt); offset+=dcnt; blocks.push({d,ec:rsEncode(d,ecnt)});} }); const res=[]; const maxD=Math.max(...blocks.map(b=>b.d.length)); const maxE=Math.max(...blocks.map(b=>b.ec.length)); for(let i=0;i<maxD;i++) blocks.forEach(b=>{ if(i<b.d.length) res.push(b.d[i]); }); for(let i=0;i<maxE;i++) blocks.forEach(b=>{ if(i<b.ec.length) res.push(b.ec[i]); }); return res; }
  function createMatrix(ver){ const n=VT[ver].s; const m=Array.from({length:n},()=>Array(n).fill(null)); const rsv=Array.from({length:n},()=>Array(n).fill(false)); function set(x,y,v,resv){ if(x<0||y<0||x>=n||y>=n) return; m[y][x]=v?1:0; rsv[y][x]=!!resv; } function finder(x,y){ for(let dy=-1;dy<=7;dy++) for(let dx=-1;dx<=7;dx++){ const xx=x+dx,yy=y+dy; if(xx<0||yy<0||xx>=n||yy>=n) continue; const on=(dx>=0&&dx<=6&&(dy===0||dy===6))||(dy>=0&&dy<=6&&(dx===0||dx===6))||(dx>=2&&dx<=4&&dy>=2&&dy<=4); set(xx,yy,on,true);} } finder(0,0); finder(n-7,0); finder(0,n-7); for(let i=8;i<n-8;i++){ if(!rsv[6][i]) set(i,6,i%2===0,true); if(!rsv[i][6]) set(6,i,i%2===0,true);} const AP={1:[],2:[6,18],3:[6,22],4:[6,26],5:[6,30],6:[6,34],7:[6,22,38],8:[6,24,42],9:[6,26,46],10:[6,28,50]}; const aps=AP[ver]; for(let i=0;i<aps.length;i++) for(let j=0;j<aps.length;j++){ const cx=aps[i],cy=aps[j]; if(rsv[cy][cx]) continue; let skip=false; if((cx<=8&&cy<=8)||(cx>=n-9&&cy<=8)||(cx<=8&&cy>=n-9)) skip=true; if(skip) continue; for(let dy=-2;dy<=2;dy++) for(let dx=-2;dx<=2;dx++){ const on=Math.abs(dx)===2||Math.abs(dy)===2||(dx===0&&dy===0); set(cx+dx,cy+dy,on,true);} } set(8,n-8,1,true); for(let i=0;i<9;i++){ if(i!==6){ if(!rsv[8][i]) set(i,8,0,true); if(!rsv[i][8]) set(8,i,0,true);} } for(let i=0;i<8;i++){ if(!rsv[8][n-1-i]) set(n-1-i,8,0,true); if(!rsv[n-1-i][8]) set(8,n-1-i,0,true);} if(ver>=7){ const VER_BITS={7:0x07C94,8:0x085BC,9:0x09A99,10:0x0A4D3}; const vs=VER_BITS[ver]||0; for(let i=0;i<18;i++){ const bit=(vs>>i)&1; const a=n-11+i%3,b=Math.floor(i/3),c=Math.floor(i/3),d=n-11+i%3; if(!rsv[b][a]) set(a,b,bit,true); if(!rsv[d][c]) set(c,d,bit,true);} } return {m,rsv,n}; }
  const FMT_BITS=[0x77C4,0x72F3,0x7DAA,0x789D,0x662F,0x6318,0x6C41,0x6976];
  function maskFunc(mask,x,y){ switch(mask){case 0:return (y+x)%2===0;case 1:return y%2===0;case 2:return x%3===0;case 3:return (y+x)%3===0;case 4:return (Math.floor(y/2)+Math.floor(x/3))%2===0;case 5:return ((y*x)%2+(y*x)%3)===0;case 6:return (((y*x)%2+(y*x)%3)%2)===0;case 7:return (((y+x)%2+(y*x)%3)%2)===0;} return false; }
  function writeFormat(obj,mask){ const {m,n}=obj; const bits=FMT_BITS[mask]; const coords1=[[0,8],[1,8],[2,8],[3,8],[4,8],[5,8],[7,8],[8,8],[8,7],[8,5],[8,4],[8,3],[8,2],[8,1],[8,0]]; const coords2=[]; for(let i=0;i<7;i++) coords2.push([8,n-1-i]); for(let i=0;i<8;i++) coords2.push([n-8+i,8]); for(let i=0;i<15;i++){ const b=(bits>>(14-i))&1; const [x1,y1]=coords1[i]; m[y1][x1]=b; const [x2,y2]=coords2[i]; m[y2][x2]=b; } }
  function placeData(obj,data,mask){ const {m,rsv,n}=obj; let bitIdx=0; const bits=[]; data.forEach(b=>{ for(let i=7;i>=0;i--) bits.push((b>>i)&1); }); let dir=-1; for(let x=n-1;x>0;x-=2){ if(x===6) x--; for(let i=0;i<n;i++){ const y=dir===-1?n-1-i:i; for(let dx=0;dx<2;dx++){ const xx=x-dx; if(rsv[y][xx]) continue; let bit=bitIdx<bits.length?bits[bitIdx++]:0; if(maskFunc(mask,xx,y)) bit^=1; m[y][xx]=bit; } } dir*=-1; } writeFormat(obj,mask); }
  function penalty(obj){ const {m,n}=obj; let p=0; for(let y=0;y<n;y++){ let run=1; for(let x=1;x<n;x++){ if(m[y][x]===m[y][x-1]){ run++; if(run===5) p+=3; else if(run>5) p+=1; } else run=1; } } for(let x=0;x<n;x++){ let run=1; for(let y=1;y<n;y++){ if(m[y][x]===m[y-1][x]){ run++; if(run===5) p+=3; else if(run>5) p+=1; } else run=1; } } for(let y=0;y<n-1;y++) for(let x=0;x<n-1;x++){ const v=m[y][x]; if(v===m[y][x+1]&&v===m[y+1][x]&&v===m[y+1][x+1]) p+=3; } let dark=0; for(let y=0;y<n;y++) for(let x=0;x<n;x++) if(m[y][x]) dark++; const total=n*n; const pct=Math.abs(dark*100/total-50); p+=Math.floor(pct/5)*10; return p; }
  function encode(text){ const utf8=unescape(encodeURIComponent(String(text||''))); const bytes=[]; for(let i=0;i<utf8.length;i++) bytes.push(utf8.charCodeAt(i)); const ver=chooseVer(bytes.length); let best=null,bestP=1e9; for(let mask=0;mask<8;mask++){ const obj=createMatrix(ver); const data=makeData(ver,bytes); placeData(obj,data,mask); const p=penalty(obj); if(p<bestP){bestP=p;best=obj;} } return best; }
  function toCanvas(text,size=220,margin=10){ const qr=encode(text); const n=qr.n; const cell=Math.max(2,Math.floor((size-margin*2)/n)); const dim=cell*n+margin*2; const c=document.createElement('canvas'); c.width=dim; c.height=dim; const ctx=c.getContext('2d'); ctx.fillStyle='#fff'; ctx.fillRect(0,0,dim,dim); ctx.fillStyle='#111'; for(let y=0;y<n;y++) for(let x=0;x<n;x++) if(qr.m[y][x]) ctx.fillRect(margin+x*cell, margin+y*cell, cell, cell); return c; }
  function toDataURL(text,size,margin){ return toCanvas(text,size,margin).toDataURL('image/png'); }
  return {toCanvas,toDataURL};
})();
function _tzLocalQrImg(token, size=240){
  if (!token) return '';
  try { if (typeof AdminTZQR!=='undefined' && AdminTZQR.toDataURL) return AdminTZQR.toDataURL(String(token), size, 10); } catch(_){}
  try { if (window.TZQR && typeof window.TZQR.toDataURL === 'function') return window.TZQR.toDataURL(String(token), size, 10); } catch(_) {}
  return '';
}
function adminQrDataUrl(token, size=180){
  return _tzLocalQrImg(token, size);
}


function _tzGetTicketManagementRows(){
  const tickets = (state.tickets||[]).map(_tzNormalizeTicketRow).filter(t=>t.ticket_id || t.booking_id);
  const byBooking = new Set(tickets.map(t=>String(t.booking_id||'')).filter(Boolean));
  const ticketedEvents = (state.events||[]).filter(e=>e.tickets_enabled);
  const ticketedEventIds = new Set(ticketedEvents.map(e=>String(e.id)));
  // awaiting issuance: eligible registrations in ticketed events with no issued ticket record
  (state.eventBookings||[]).forEach(b => {
    const eid = String(b.event_id||''); const bid = String(b.id||'');
    if (!eid || !ticketedEventIds.has(eid)) return;
    if (byBooking.has(bid)) return;
    if (['rejected','cancelled'].includes(String(b.status||''))) return;
    const ev = (state.events||[]).find(x=>String(x.id)===eid) || {};
    tickets.push(_tzNormalizeTicketRow({
      ticket_id: null,
      booking_id: b.id,
      event_id: b.event_id,
      visitor_name: b.visitor_name,
      phone: b.phone,
      seats: b.seats,
      booking_status: b.status,
      ticket_status: 'missing',
      event_title: ev.title_ar || ev.title_en || 'فعالية',
      event_date: ev.event_date, event_time: ev.event_time,
      issued_at: null, used_at: null, qr_token: null,
      events: ev
    }));
  });
  return tickets;
}

async function _tzBuildTicketPngBlob(ticket, scale=2){
  const t = _tzNormalizeTicketRow(ticket);
  const W = 1080*scale, H = 1500*scale, pad = 70*scale;
  const c = document.createElement('canvas'); c.width=W; c.height=H;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#f3ede3'; ctx.fillRect(0,0,W,H);
  const cx=pad, cy=pad, cw=W-pad*2, ch=H-pad*2, r=40*scale;
  function rr(x,y,w,h,rad){ ctx.beginPath(); ctx.moveTo(x+rad,y); ctx.arcTo(x+w,y,x+w,y+h,rad); ctx.arcTo(x+w,y+h,x,y+h,rad); ctx.arcTo(x,y+h,x,y,rad); ctx.arcTo(x,y,x+w,y,rad); ctx.closePath(); }
  rr(cx,cy,cw,ch,r); ctx.fillStyle='#fffdf9'; ctx.fill();
  ctx.strokeStyle='#e2d7c7'; ctx.lineWidth=3*scale; rr(cx,cy,cw,ch,r); ctx.stroke();
  // header band
  const grad = ctx.createLinearGradient(cx,cy,cx+cw,cy+220*scale);
  grad.addColorStop(0,'#1f1713'); grad.addColorStop(1,'#3a2a22');
  ctx.save(); rr(cx,cy,cw,220*scale,r); ctx.clip(); ctx.fillStyle=grad; ctx.fillRect(cx,cy,cw,220*scale); ctx.restore();
  ctx.fillStyle='#f6efe6'; ctx.textAlign='right';
  ctx.font=`700 ${36*scale}px "Google Sans", Arial, sans-serif`; ctx.fillText('THE ZONE', cx+cw-48*scale, cy+78*scale);
  ctx.font=`500 ${22*scale}px "Google Sans", Arial, sans-serif`; ctx.fillStyle='#e8c9a8';
  ctx.fillText('Digital Ticket · تذكرة رقمية', cx+cw-48*scale, cy+118*scale);
  const st = String(t.ticket_status||'');
  const stLabel = _tzTicketStatusLabel(st);
  const stColor = st==='valid' ? '#1f8b4c' : st==='used' ? '#a86800' : st==='cancelled' ? '#c62828' : '#6d625b';
  ctx.textAlign='left'; ctx.fillStyle=stColor; ctx.font=`700 ${22*scale}px "Google Sans", Arial, sans-serif`;
  const stW = ctx.measureText(stLabel).width + 34*scale;
  rr(cx+40*scale, cy+70*scale, stW, 44*scale, 22*scale); ctx.fill();
  ctx.fillStyle='#fff'; ctx.fillText(stLabel, cx+57*scale, cy+100*scale);
  // event
  let y = cy + 290*scale; const right = cx+cw-48*scale;
  ctx.textAlign='right'; ctx.fillStyle='#1a120f'; ctx.font=`700 ${54*scale}px "Google Sans", Arial, sans-serif`;
  const evTitle = String(t.event_title||'فعالية'); ctx.fillText(evTitle.length>30?evTitle.slice(0,30)+'…':evTitle, right, y); y+=64*scale;
  ctx.fillStyle='#6d625b'; ctx.font=`400 ${30*scale}px "Google Sans", Arial, sans-serif`;
  const dt=[t.event_date?String(t.event_date).slice(0,10):'', t.event_time?String(t.event_time).slice(0,5):''].filter(Boolean).join(' · ');
  ctx.fillText(dt||'—', right, y); y+=70*scale;
  ctx.strokeStyle='#eadfce'; ctx.lineWidth=2*scale; ctx.beginPath(); ctx.moveTo(cx+48*scale,y); ctx.lineTo(cx+cw-48*scale,y); ctx.stroke(); y+=44*scale;
  const fields=[
    ['الاسم', String(t.visitor_name||'-')],
    ['رقم التذكرة', String(t.ticket_number||'-')],
    ['مرجع الحجز', String(t.booking_id||'-')],
    ['عدد المقاعد', String(t.seats ?? 1)],
    ['الحالة', stLabel],
  ];
  fields.forEach(([k,v])=>{
    ctx.fillStyle='#7a6b61'; ctx.textAlign='right'; ctx.font=`400 ${26*scale}px "Google Sans", Arial, sans-serif`; ctx.fillText(k,right,y);
    ctx.fillStyle='#1a120f'; ctx.textAlign='left'; ctx.font=(k.includes('تذكرة')||k.includes('حجز'))?`600 ${28*scale}px ui-monospace, Menlo, Arial`:`600 ${30*scale}px "Google Sans", Arial, sans-serif`;
    ctx.fillText(String(v).length>28?String(v).slice(0,28)+'…':String(v), cx+48*scale, y);
    ctx.strokeStyle='#efe5d8'; ctx.lineWidth=1.5*scale; ctx.setLineDash([7*scale,6*scale]); ctx.beginPath(); ctx.moveTo(cx+48*scale,y+20*scale); ctx.lineTo(cx+cw-48*scale,y+20*scale); ctx.stroke(); ctx.setLineDash([]);
    y += 78*scale;
  });
  // QR
  const qrSize = 430*scale; const qx=(W-qrSize)/2; const qy=y+24*scale;
  ctx.fillStyle='#fff'; rr(qx-20*scale,qy-20*scale,qrSize+40*scale,qrSize+40*scale,26*scale); ctx.fill();
  ctx.strokeStyle='#e7ddd0'; ctx.lineWidth=2*scale; rr(qx-20*scale,qy-20*scale,qrSize+40*scale,qrSize+40*scale,26*scale); ctx.stroke();
  let qrDrawn=false;
  if (t.qr_token) {
    try {
      const src = _tzLocalQrImg(t.qr_token, qrSize);
      if (src) {
        const img = await new Promise((res,rej)=>{ const im=new Image(); im.onload=()=>res(im); im.onerror=rej; im.src=src; });
        ctx.drawImage(img,qx,qy,qrSize,qrSize); qrDrawn=true;
      }
    } catch(_) {}
  }
  if (t.qr_token && !qrDrawn) throw new Error('تعذر إنشاء رمز QR للتذكرة. أعد المحاولة قبل تنزيل الصورة.');
  if (!t.qr_token) {
    ctx.fillStyle='#6d625b'; ctx.textAlign='center'; ctx.font=`400 ${28*scale}px Arial`; ctx.fillText('لا يوجد رمز QR', W/2, qy+qrSize/2);
  }
  ctx.fillStyle='#6d625b'; ctx.textAlign='center'; ctx.font=`400 ${24*scale}px "Google Sans", Arial, sans-serif`;
  ctx.fillText('امسح رمز QR عند الدخول', W/2, qy+qrSize+58*scale);
  ctx.fillStyle='#a8927f'; ctx.font=`400 ${20*scale}px "Google Sans", Arial, sans-serif`;
  ctx.fillText('THE ZONE — تذكرة دخول مرتبطة بالتسجيل. لا تشارك رمز QR علناً.', W/2, H-pad-22*scale);
  return await new Promise(res=>c.toBlob(res,'image/png',1.0));
}

async function _tzDownloadTicketPng(ticket){
  try {
    const t=_tzNormalizeTicketRow(ticket);
    if (!t.ticket_id && !t.ticket_number) { showToast('لا يمكن تحميل تذكرة غير مُصدرة.', 'error'); return; }
    const blob = await _tzBuildTicketPngBlob(t,2);
    if (!blob) throw new Error('تعذر إنشاء صورة التذكرة');
    const name = `THE-ZONE-ticket-${String(t.ticket_number||t.booking_id||'ticket').replace(/[^a-zA-Z0-9_-]/g,'')}.png`;
    const file = new File([blob], name, {type:'image/png'});
    if (navigator.canShare && navigator.canShare({files:[file]}) && navigator.share) {
      try { await navigator.share({files:[file], title:'THE ZONE Ticket', text:String(t.event_title||'THE ZONE')}); return; } catch(e){ if(e && e.name==='AbortError') return; }
    }
    const url=URL.createObjectURL(blob); const a=document.createElement('a'); a.href=url; a.download=name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(url), 5000);
    showToast('تم تجهيز صورة التذكرة (PNG) بجودة عالية');
  } catch(e){ console.error(e); showToast(e.message||'تعذر تحميل صورة التذكرة.', 'error'); }
}

async function _tzCopyText(v,label='النص'){ try { await navigator.clipboard.writeText(String(v||'')); showToast('تم نسخ '+label); } catch(_){ showToast(label+': '+String(v||'')); } }

window.openTicketModal = async (ticketIdOrBookingId, kind='ticket') => {
  // kind: 'ticket' | 'booking' (for missing)
  let t = null;
  if (kind === 'booking') {
    const b = (state.eventBookings||[]).find(x=>String(x.id)===String(ticketIdOrBookingId));
    const ev = b ? (state.events||[]).find(e=>String(e.id)===String(b.event_id||'')) : null;
    const existing = (state.tickets||[]).map(_tzNormalizeTicketRow).find(x=>String(x.booking_id||'')===String(ticketIdOrBookingId));
    t = existing || (b ? _tzNormalizeTicketRow({ ticket_id:null, booking_id:b.id, event_id:b.event_id, visitor_name:b.visitor_name, phone:b.phone, seats:b.seats, booking_status:b.status, ticket_status:'missing', event_title:ev?(ev.title_ar||ev.title_en):'فعالية', event_date:ev&&ev.event_date, event_time:ev&&ev.event_time, events:ev }) : null);
  } else {
    t = (state.tickets||[]).map(_tzNormalizeTicketRow).find(x=>String(x.ticket_id||x.id||'')===String(ticketIdOrBookingId));
    if (!t) { try { await loadTickets(true); } catch(_){} t = (state.tickets||[]).map(_tzNormalizeTicketRow).find(x=>String(x.ticket_id||x.id||'')===String(ticketIdOrBookingId)); }
  }
  if (!t) { showToast('تعذر العثور على التذكرة/التسجيل.', 'error'); return; }
  const st = String(t.ticket_status||'');
  const stLabel = _tzTicketStatusLabel(st);
  const stClass = st==='valid'?'valid':st==='used'?'used':st==='cancelled'?'cancelled':'pending';
  const evObj = (state.events||[]).find(e=>String(e.id)===String(t.event_id||'')) || {};
  const canIssue = !t.ticket_id && evObj.tickets_enabled && !['rejected','cancelled'].includes(String(t.booking_status||''));
  const qrSrc = t.qr_token ? adminQrDataUrl(t.qr_token, 320) : '';
  const qrBig = qrSrc ? `<img id="tm-qr-img" src="${esc(qrSrc)}" alt="QR" class="tm-qr">` : `<div class="tm-qr tm-qr-empty">${st==='missing'?'لم تُصدر التذكرة بعد':'تعذر إنشاء رمز QR محلياً'}</div>`;

  const overlay = document.createElement('div');
  overlay.className = 'tm-overlay';
  overlay.innerHTML = `<div class="tm-modal" role="dialog" aria-modal="true" aria-label="معاينة التذكرة">
    <div class="tm-head">
      <div><div class="tm-kicker">THE ZONE · إدارة التذاكر الرقمية</div><h3>معاينة التذكرة</h3></div>
      <button type="button" class="btn-secondary" id="tm-close">إغلاق</button>
    </div>
    <div class="tm-body">
      <div class="tm-ticket ${stClass}" id="tm-ticket-card">
        <div class="tm-band">
          <div><div class="tm-brand">THE ZONE</div><div class="tm-brand-sub">Digital Admission Ticket</div></div>
          <div class="tm-status-badge ${stClass}">${esc(stLabel)}</div>
        </div>
        <div class="tm-main">
          <div class="tm-info">
            <div class="tm-event">${esc(t.event_title||'-')}</div>
            <div class="tm-date">${esc([t.event_date?String(t.event_date).slice(0,10):'', t.event_time?String(t.event_time).slice(0,5):''].filter(Boolean).join(' · ') || '—')}</div>
            <div class="tm-grid">
              <div><span>الاسم الكامل</span><strong>${esc(t.visitor_name||'-')}</strong></div>
              <div><span>رقم التذكرة</span><strong class="mono">${esc(t.ticket_number||'—')}</strong></div>
              <div><span>مرجع الحجز</span><strong class="mono">${esc(String(t.booking_id||'-'))}</strong></div>
              <div><span>عدد المقاعد</span><strong>${esc(t.seats ?? 1)}</strong></div>
              <div><span>تاريخ الإصدار</span><strong>${esc(t.issued_at ? String(t.issued_at).replace('T',' ').slice(0,16) : '—')}</strong></div>
              <div><span>حالة الحضور</span><strong>${esc(st==='used' ? ('تم الحضور'+(t.used_at?(' — '+String(t.used_at).replace('T',' ').slice(0,16)):'') ) : (st==='cancelled'?'ملغاة':'لم يُسجّل بعد'))}</strong></div>
            </div>
            <div class="tm-note">تذكرة مرتبطة بالتسجيل والفعالية، ويمكن استخدامها لتسجيل الحضور مرة واحدة.</div>
          </div>
          <div class="tm-qr-wrap">
            ${qrBig}
            <div class="tm-qr-label">${t.qr_token?'رمز QR للتحقق عند الدخول':'—'}</div>
            ${t.qr_token?'<button type="button" class="btn-secondary" id="tm-zoom-qr">تكبير رمز QR</button>':''}
          </div>
        </div>
      </div>
      <div class="tm-actions">
        ${t.qr_token || t.ticket_number ? `<button type="button" class="btn-primary" id="tm-download">تحميل PNG بجودة عالية</button>` : ''}
        ${t.qr_token ? `<button type="button" class="btn-secondary" id="tm-download-qr">تحميل رمز QR فقط</button>` : ''}
        <button type="button" class="btn-secondary" id="tm-copy-num">نسخ رقم التذكرة</button>
        <button type="button" class="btn-secondary" id="tm-copy-booking">نسخ مرجع الحجز</button>
        <button type="button" class="btn-secondary" id="tm-print">طباعة التذكرة</button>
        ${canIssue ? `<button type="button" class="btn-secondary" id="tm-issue">إصدار/استعادة التذكرة (آمن)</button>` : ''}
        ${st==='valid' && t.ticket_id ? `<button type="button" class="delete" id="tm-cancel">إلغاء التذكرة</button>` : ''}
      </div>
      ${canIssue ? '<div class="hint" style="margin-top:8px">هذه التذكرة بانتظار الإصدار. يمكنك إصدارها لتظهر في قائمة التذاكر.</div>' : ''}
    </div>
  </div>`;
  document.body.appendChild(overlay);
  const close = ()=>{ overlay.remove(); };
  overlay.addEventListener('click',(e)=>{ if(e.target===overlay) close(); });
  overlay.querySelector('#tm-close').onclick = close;
  overlay.querySelector('#tm-copy-num').onclick = ()=>_tzCopyText(t.ticket_number||'', 'رقم التذكرة');
  overlay.querySelector('#tm-copy-booking').onclick = ()=>_tzCopyText(t.booking_id||'', 'مرجع الحجز');
  overlay.querySelector('#tm-print').onclick = ()=>{ window.print(); };
  const dl = overlay.querySelector('#tm-download'); if (dl) dl.onclick = ()=>_tzDownloadTicketPng(t);
  const dlqr = overlay.querySelector('#tm-download-qr'); if (dlqr) dlqr.onclick = async ()=>{
    if (!t.qr_token) return;
    const src = adminQrDataUrl(t.qr_token, 800);
    if (!src) { showToast('تعذر إنشاء رمز QR على هذا الجهاز.', 'error'); return; }
    const a=document.createElement('a'); a.href=src; a.download=`THE-ZONE-qr-${String(t.ticket_number||t.booking_id).replace(/[^a-zA-Z0-9_-]/g,'')}.png`; document.body.appendChild(a); a.click(); a.remove();
  };
  const zoom = overlay.querySelector('#tm-zoom-qr'); if (zoom) zoom.onclick = ()=>{
    const src = adminQrDataUrl(t.qr_token,900); if (!src) { showToast('تعذر إنشاء رمز QR على هذا الجهاز.', 'error'); return; }
    const w = window.open('', '_blank'); if(!w) return;
    w.document.write(`<!doctype html><title>QR — ${esc(t.ticket_number||'')}</title><body style="margin:0;display:grid;place-items:center;min-height:100vh;background:#111"><img src="${esc(src)}" style="width:min(92vmin,900px);height:auto;background:#fff;padding:24px;border-radius:18px"></body>`);
  };
  const issue = overlay.querySelector('#tm-issue'); if (issue) issue.onclick = async ()=>{ await window.issueTicket(String(t.booking_id)); close(); };
  const cancel = overlay.querySelector('#tm-cancel'); if (cancel) cancel.onclick = async ()=>{ await window.cancelTicket(String(t.ticket_id)); close(); };
};

window.viewTicket = async (ticketId) => window.openTicketModal(ticketId, 'ticket');

async function renderTickets() {
  const root = $('#tickets-root');
  if (root) root.innerHTML = '<div class="loading-state">جاري تحميل التذاكر…</div>';
  await Promise.all([loadEvents(), loadEventBookings()]);
  await loadTickets(true);
  const events = state.events || [];
  const allRows = _tzGetTicketManagementRows();
  const issued = allRows.filter(r=>r.ticket_id);
  const awaiting = allRows.filter(r=>!r.ticket_id);
  const valid = issued.filter(r=>String(r.ticket_status)==='valid').length;
  const used = issued.filter(r=>String(r.ticket_status)==='used').length;
  const cancelled = issued.filter(r=>String(r.ticket_status)==='cancelled').length;
  const q = (ticketsUi.search||'').toLowerCase().trim();
  const view = ticketsUi.view || 'all';
  const viewEventId = view.startsWith('event:') ? view.slice(6) : '';

  let rows = allRows.slice();
  if (view === 'missing') rows = rows.filter(r=>!r.ticket_id);
  if (viewEventId) rows = rows.filter(r=>String(r.event_id||'')===String(viewEventId));
  if (ticketsUi.eventId) rows = rows.filter(r=>String(r.event_id||'')===String(ticketsUi.eventId));
  if (ticketsUi.status && ticketsUi.status!=='all') {
    if (ticketsUi.status==='missing') rows = rows.filter(r=>!r.ticket_id);
    else rows = rows.filter(r=>String(r.ticket_status||'')===String(ticketsUi.status));
  }
  if (q) {
    rows = rows.filter(t => (`${t.ticket_number||''} ${t.visitor_name||''} ${t.phone||''} ${t.event_title||''} ${t.booking_id||''}`).toLowerCase().includes(q));
  }
  // sort
  rows.sort((a,b)=>{
    const da = a.issued_at||a.created_at||''; const db = b.issued_at||b.created_at||'';
    const na = String(a.visitor_name||''); const nb = String(b.visitor_name||'');
    const ea = String(a.event_title||''); const eb = String(b.event_title||'');
    switch(ticketsUi.sort){
      case 'issued_asc': return String(da).localeCompare(String(db));
      case 'name': return na.localeCompare(nb,'ar');
      case 'event': return ea.localeCompare(eb,'ar');
      case 'status': return String(a.ticket_status||'').localeCompare(String(b.ticket_status||''));
      default: return String(db).localeCompare(String(da));
    }
  });

  const total = rows.length;
  const pageSize = Math.max(5, Number(ticketsUi.pageSize)||20);
  const pages = Math.max(1, Math.ceil(total/pageSize));
  if (ticketsUi.page>pages) ticketsUi.page = pages; if (ticketsUi.page<1) ticketsUi.page = 1;
  const start = (ticketsUi.page-1)*pageSize;
  const pageRows = rows.slice(start, start+pageSize);

  // per-event stats
  const byEvent = new Map();
  allRows.forEach(r=>{ const k=String(r.event_id||'none'); if(!byEvent.has(k)) byEvent.set(k,{id:r.event_id,title:r.event_title||'فعالية',issued:0,valid:0,used:0,cancelled:0,awaiting:0,total:0}); const o=byEvent.get(k); o.total++; if(r.ticket_id){ o.issued++; if(r.ticket_status==='valid') o.valid++; if(r.ticket_status==='used') o.used++; if(r.ticket_status==='cancelled') o.cancelled++; } else o.awaiting++; });
  const eventStats = [...byEvent.values()].filter(e=>e.id && String(e.id)!=='none');

  const eventOpts = events.map(e=>`<option value="${esc(e.id)}" ${String(ticketsUi.eventId)===String(e.id)?'selected':''}>${esc(e.title_ar||e.title_en||'فعالية')}</option>`).join('');

  if (!root) return;
  root.innerHTML = `
    <div class="kpi-grid">
      <div class="kpi"><div class="k">إجمالي التذاكر المُصدرة</div><div class="v">${issued.length}</div><div class="s">تذاكر مسجلة</div></div>
      <div class="kpi"><div class="k">صالحة</div><div class="v">${valid}</div><div class="s">جاهزة للاستخدام</div></div>
      <div class="kpi"><div class="k">مستخدمة (تم الحضور)</div><div class="v">${used}</div><div class="s">تم تسجيل الحضور</div></div>
      <div class="kpi"><div class="k">ملغاة</div><div class="v">${cancelled}</div><div class="s">غير صالحة للدخول</div></div>
      <div class="kpi"><div class="k">بانتظار الإصدار</div><div class="v">${awaiting.length}</div><div class="s">تسجيلات مؤهلة بدون تذكرة</div></div>
    </div>

    <div class="panel" style="margin-bottom:14px"><div class="panel-head"><h3>إحصاءات حسب الفعالية</h3></div><div class="panel-body">${eventStats.length ? `<div class="table-wrap"><table><thead><tr><th>الفعالية</th><th>مُصدرة</th><th>صالحة</th><th>مستخدمة</th><th>ملغاة</th><th>بانتظار الإصدار</th><th></th></tr></thead><tbody>${eventStats.map(es=>`<tr><td><strong>${esc(es.title)}</strong></td><td>${es.issued}</td><td>${es.valid}</td><td>${es.used}</td><td>${es.cancelled}</td><td>${es.awaiting}</td><td><button type="button" class="btn-secondary" data-view-event="${esc(es.id)}">عرض تذاكر الفعالية</button></td></tr>`).join('')}</tbody></table></div>` : '<div class="empty" style="padding:16px"><p>لا توجد بيانات تذاكر/فعاليات مفعّل لها التذاكر بعد.</p></div>'}</div></div>

    <div class="panel" style="margin-bottom:14px"><div class="panel-body">
      <div class="toolbar" style="margin:0">
        <div class="search"><input id="tk-search" placeholder="بحث بالاسم أو رقم التذكرة أو مرجع الحجز أو الهاتف" value="${esc(ticketsUi.search)}"></div>
        <select id="tk-event"><option value="">كل الفعاليات</option>${eventOpts}</select>
        <select id="tk-status">
          <option value="all" ${ticketsUi.status==='all'?'selected':''}>كل الحالات</option>
          <option value="valid" ${ticketsUi.status==='valid'?'selected':''}>صالحة</option>
          <option value="used" ${ticketsUi.status==='used'?'selected':''}>مستخدمة (تم الحضور)</option>
          <option value="cancelled" ${ticketsUi.status==='cancelled'?'selected':''}>ملغاة</option>
          <option value="missing" ${ticketsUi.status==='missing'?'selected':''}>بانتظار الإصدار</option>
        </select>
        <select id="tk-sort">
          <option value="issued_desc" ${ticketsUi.sort==='issued_desc'?'selected':''}>الأحدث إصداراً</option>
          <option value="issued_asc" ${ticketsUi.sort==='issued_asc'?'selected':''}>الأقدم إصداراً</option>
          <option value="name" ${ticketsUi.sort==='name'?'selected':''}>حسب الاسم</option>
          <option value="event" ${ticketsUi.sort==='event'?'selected':''}>حسب الفعالية</option>
          <option value="status" ${ticketsUi.sort==='status'?'selected':''}>حسب الحالة</option>
        </select>
        <button type="button" class="btn-secondary" id="tk-refresh">تحديث</button>
      </div>
      <div class="actions" style="margin-top:10px;gap:8px">
        <button type="button" class="${view==='all'?'btn-primary':'btn-secondary'}" id="tk-view-all">كل السجلات</button>
        <button type="button" class="${view==='missing'?'btn-primary':'btn-secondary'}" id="tk-view-missing">بانتظار الإصدار (${awaiting.length})</button>
        ${viewEventId?`<span class="pill">عرض حسب فعالية: ${esc((events.find(e=>String(e.id)===String(viewEventId))||{}).title_ar||'فعالية')} <button type="button" class="edit" id="tk-clear-view" style="margin-inline-start:6px">مسح</button></span>`:''}
      </div>
      <div class="hint" style="margin-top:8px">التذاكر المعروضة: ${total} سجل.</div>
    </div></div>

    <div class="panel"><div class="panel-head"><h3>سجل التذاكر الرقمية</h3></div><div class="panel-body">${pageRows.length ? `<div class="table-wrap"><table><thead><tr><th>الاسم الكامل</th><th>الفعالية</th><th>مرجع الحجز</th><th>رقم التذكرة</th><th>حالة التذكرة</th><th>تاريخ الإصدار</th><th>حالة الحضور</th><th>إجراءات</th></tr></thead><tbody>${pageRows.map(t=>{
        const st = String(t.ticket_status||'');
        const canIssue = !t.ticket_id && (events.find(e=>String(e.id)===String(t.event_id))||{}).tickets_enabled && !['rejected','cancelled'].includes(String(t.booking_status||''));
        const att = st==='used' ? `تم الحضور${t.used_at?`<div class="sub">${esc(String(t.used_at).replace('T',' ').slice(0,16))}</div>`:''}` : (st==='cancelled'?'—':'لم يُسجّل');
        return `<tr>
          <td><strong>${esc(t.visitor_name||'-')}</strong><div class="sub">${esc(t.phone||'-')} · مقاعد: ${esc(t.seats??1)}</div></td>
          <td>${esc(t.event_title||'-')}<div class="sub">${esc([t.event_date?String(t.event_date).slice(0,10):'', t.event_time?String(t.event_time).slice(0,5):''].filter(Boolean).join(' ')||'-')}</div></td>
          <td class="mono" style="font-size:12px">${esc(String(t.booking_id||'-'))}</td>
          <td><strong class="mono">${esc(t.ticket_number||'—')}</strong></td>
          <td>${_tzTicketBadge(st)}</td>
          <td>${esc(t.issued_at?String(t.issued_at).replace('T',' ').slice(0,16): (st==='missing'?'—':'—'))}</td>
          <td>${att}</td>
          <td><div class="actions">
            <button type="button" class="edit" onclick="app.openTicketModal('${esc(t.ticket_id||t.booking_id)}','${t.ticket_id?'ticket':'booking'}')">معاينة</button>
            ${t.ticket_id?`<button type="button" class="status" onclick="app.downloadTicketPngById('${esc(t.ticket_id)}')">PNG</button>`:''}
            ${canIssue?`<button type="button" class="status" onclick="app.issueTicket('${esc(t.booking_id)}')">إصدار</button>`:''}
            ${st==='valid' && t.ticket_id?`<button type="button" class="delete" onclick="app.cancelTicket('${esc(t.ticket_id)}')">إلغاء</button>`:''}
          </div></td>
        </tr>`; }).join('')}</tbody></table></div>
        <div class="actions" style="margin-top:12px;justify-content:space-between;flex-wrap:wrap">
          <div class="hint">صفحة ${ticketsUi.page} من ${pages} · ${total} سجل</div>
          <div class="actions" style="gap:6px">
            <button type="button" class="btn-secondary" id="tk-prev" ${ticketsUi.page<=1?'disabled':''}>السابق</button>
            <button type="button" class="btn-secondary" id="tk-next" ${ticketsUi.page>=pages?'disabled':''}>التالي</button>
          </div>
        </div>` : '<div class="empty"><h3>لا توجد سجلات مطابقة</h3><p>جرّب تعديل البحث/الفلاتر. عند تفعيل التذاكر الرقمية لفعالية وإتمام تسجيلات مؤهلة ستظهر التذاكر والتسجيلات بانتظار الإصدار هنا.</p></div>'}</div></div>`;

  // bind
  $('#tk-search') && ($('#tk-search').oninput = (e)=>{ ticketsUi.search=e.target.value; ticketsUi.page=1; renderTickets(); });
  $('#tk-event') && ($('#tk-event').onchange = (e)=>{ ticketsUi.eventId=e.target.value; ticketsUi.page=1; renderTickets(); });
  $('#tk-status') && ($('#tk-status').onchange = (e)=>{ ticketsUi.status=e.target.value; ticketsUi.page=1; renderTickets(); });
  $('#tk-sort') && ($('#tk-sort').onchange = (e)=>{ ticketsUi.sort=e.target.value; ticketsUi.page=1; renderTickets(); });
  $('#tk-refresh') && ($('#tk-refresh').onclick = async ()=>{ await loadTickets(true); renderTickets(); });
  $('#tk-view-all') && ($('#tk-view-all').onclick = ()=>{ ticketsUi.view='all'; ticketsUi.page=1; renderTickets(); });
  $('#tk-view-missing') && ($('#tk-view-missing').onclick = ()=>{ ticketsUi.view='missing'; ticketsUi.status='all'; ticketsUi.page=1; renderTickets(); });
  $('#tk-clear-view') && ($('#tk-clear-view').onclick = ()=>{ ticketsUi.view='all'; ticketsUi.page=1; renderTickets(); });
  $('#tk-prev') && ($('#tk-prev').onclick = ()=>{ ticketsUi.page=Math.max(1,ticketsUi.page-1); renderTickets(); });
  $('#tk-next') && ($('#tk-next').onclick = ()=>{ ticketsUi.page=Math.min(pages,ticketsUi.page+1); renderTickets(); });
  root.querySelectorAll('[data-view-event]').forEach(btn=> btn.onclick = ()=>{ ticketsUi.view='event:'+btn.getAttribute('data-view-event'); ticketsUi.page=1; renderTickets(); });
}

window.downloadTicketPngById = async (ticketId) => {
  let t = (state.tickets||[]).map(_tzNormalizeTicketRow).find(x=>String(x.ticket_id||x.id||'')===String(ticketId));
  if (!t) { try { await loadTickets(true); } catch(_){} t=(state.tickets||[]).map(_tzNormalizeTicketRow).find(x=>String(x.ticket_id||x.id||'')===String(ticketId)); }
  if (!t) { showToast('تعذر العثور على التذكرة.', 'error'); return; }
  await _tzDownloadTicketPng(t);
};

function stopAttendanceScan() {
  attendanceScanRun += 1;
  if (attendanceScanTimer) clearTimeout(attendanceScanTimer);
  attendanceScanTimer = 0;
  if (attendanceStream) attendanceStream.getTracks().forEach((track) => track.stop());
  attendanceStream = null;
  const video = $('#att-video');
  if (video) {
    video.pause();
    video.srcObject = null;
    video.hidden = true;
  }
}

async function startAttendanceScan(onToken) {
  stopAttendanceScan();
  const run = attendanceScanRun;
  const video = $('#att-video');
  const status = $('#att-scan-status');
  const report = (message, type = '') => {
    if (!status) return;
    status.textContent = message;
    status.className = `hint${type ? ` ${type}` : ''}`;
  };
  if (!video) return;
  if (!navigator.mediaDevices?.getUserMedia) {
    report('يتطلب مسح QR اتصالاً آمناً وميزة كاميرا متاحة في المتصفح.', 'warn');
    return;
  }
  if (typeof window.BarcodeDetector !== 'function') {
    report('هذا المتصفح لا يدعم قراءة QR بالكاميرا. استخدم حقل الإدخال اليدوي.', 'warn');
    return;
  }

  let detector;
  try {
    detector = new window.BarcodeDetector({ formats: ['qr_code'] });
  } catch (_) {
    report('تعذر تهيئة قارئ QR في هذا المتصفح. استخدم حقل الإدخال اليدوي.', 'warn');
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
    if (run !== attendanceScanRun) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    attendanceStream = stream;
    video.hidden = false;
    video.srcObject = stream;
    await video.play();
    report('وجّه الكاميرا إلى رمز QR للتذكرة.', 'ok');

    const scan = async () => {
      if (run !== attendanceScanRun || !attendanceStream) return;
      try {
        if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
          const codes = await detector.detect(video);
          if (run !== attendanceScanRun || !attendanceStream) return;
          const token = codes.find((code) => typeof code.rawValue === 'string' && code.rawValue.trim())?.rawValue.trim();
          if (token) {
            stopAttendanceScan();
            report('تمت قراءة الرمز. جارٍ التحقق من التذكرة…', 'ok');
            Promise.resolve(onToken(token)).catch((error) => {
              report(error?.message || 'تعذر التحقق من التذكرة.', 'error');
            });
            return;
          }
        }
      } catch (_) {
        stopAttendanceScan();
        report('تعذر قراءة الرمز. أوقف الكاميرا وحاول مرة أخرى.', 'error');
        return;
      }
      attendanceScanTimer = setTimeout(scan, 250);
    };
    scan();
  } catch (error) {
    stopAttendanceScan();
    const message = error?.name === 'NotAllowedError'
      ? 'لم يُسمح باستخدام الكاميرا. امنح الموقع صلاحية الكاميرا ثم أعد المحاولة.'
      : error?.name === 'NotFoundError'
        ? 'لم يتم العثور على كاميرا متاحة.'
        : 'تعذر تشغيل الكاميرا. تحقق من صلاحيات المتصفح واتصال HTTPS.';
    report(message, 'error');
  }
}

async function doCheckinToken(value, source = 'manual-token', eventId = null) {
  const token = String(value || '').trim();
  const out = $('#att-result');
  const status = $('#att-scan-status');
  if (!token) {
    if (out) out.innerHTML = '<div class="insight warn">أدخل رمز QR صالحاً للتحقق.</div>';
    return;
  }
  if (!eventId) {
    if (out) out.innerHTML = '<div class="insight warn">اختر الفعالية أولاً للتحقق من أن التذكرة تخصها.</div>';
    return;
  }
  try {
    const { data, error } = await sb().rpc('admin_checkin_ticket_for_event', { p_token: token, p_event_id: eventId });
    if (error) throw error;
    const result = Array.isArray(data) ? data[0] : data;
    if (!result) throw new Error('لم يُرجع الخادم نتيجة للتحقق.');
    const payload = result.payload || {};
    const stateLabel = ({ checked_in: 'تم تسجيل الحضور الآن', used: 'تم تسجيل الحضور مسبقاً', invalid: 'تذكرة غير صالحة', cancelled: 'التذكرة ملغاة', wrong_event: 'التذكرة تخص فعالية أخرى', booking_ineligible: 'التسجيل المرتبط غير مؤهل', disabled: 'التحقق غير مفعّل لهذه الفعالية', conflict: 'تعذر إكمال التحقق' })[result.state] || String(result.state || '-');
    if (out) out.innerHTML = `<div class="insight ${result.ok && result.state !== 'used' ? 'ok' : 'warn'}"><div style="font-weight:700;margin-bottom:6px">${esc(result.message || 'نتيجة التحقق')}</div>
      ${payload.ticket_number ? `<div>رقم التذكرة: <strong class="mono">${esc(payload.ticket_number)}</strong></div>` : ''}
      ${payload.visitor_name ? `<div>الاسم: <strong>${esc(payload.visitor_name)}</strong></div>` : ''}
      ${payload.title_ar || payload.title_en ? `<div>الفعالية: <strong>${esc(payload.title_ar || payload.title_en)}</strong></div>` : ''}
      <div class="hint" style="margin-top:6px">الحالة: ${esc(stateLabel)}</div></div>`;
    if (status && source === 'qr') status.textContent = result.message || 'اكتمل التحقق من الرمز.';
    if (result.ok) {
      await logAdminActivity(result.state === 'used' ? 'checkin_duplicate' : source === 'qr' ? 'checkin_qr' : 'checkin_manual_token', 'event_ticket', payload.ticket_id || null, { state: result.state });
      await loadTickets(true);
    }
  } catch (error) {
    if (out) out.innerHTML = `<div class="insight warn"><strong>${esc(friendlyError(error, 'تعذر التحقق من التذكرة.'))}</strong></div>`;
  }
}

async function renderAttendance() {
  stopAttendanceScan();
  const root = $('#attendance-root');
  if (!root) return;
  await loadEvents();
  const eventOpts = state.events.map(e=>`<option value="${esc(e.id)}">${esc(e.title_ar||e.title_en||'فعالية')} ${e.qr_checkin_enabled?'· QR مفعّل':''}</option>`).join('');
  root.innerHTML = `
    <div class="dashboard-grid">
      <div class="panel"><div class="panel-head"><h3>مسح QR بالكاميرا</h3></div><div class="panel-body qr-box">
        <div class="hint">فعّل التذاكر الرقمية والتحقق من الحضور للفعالية قبل بدء المسح. لا يمكن تسجيل الحضور أكثر من مرة للتذكرة نفسها.</div>
        <label class="field"><span>الفعالية التي يجري التحقق من تذاكرها</span><select id="att-qr-event" required><option value="" selected disabled>اختر الفعالية</option>${eventOpts}</select></label>
        <video id="att-video" class="qr-video" playsinline muted hidden></video>
        <div class="actions">
          <button type="button" class="btn-primary" id="att-start">تشغيل الكاميرا</button>
          <button type="button" class="btn-secondary" id="att-stop">إيقاف</button>
        </div>
        <div id="att-scan-status" class="hint">الكاميرا متوقفة.</div>
      </div></div>
      <div class="panel"><div class="panel-head"><h3>تحقق/بحث يدوي</h3></div><div class="panel-body">
        <div class="qr-box">
          <label class="field"><span>رمز QR للتحقق المباشر، أو رقم التذكرة/الحجز/الهاتف للبحث اليدوي</span><input id="att-manual-input" placeholder="ألصق أو أدخل القيمة"></label>
          <label class="field"><span>تقييد بفعالية (اختياري للبحث اليدوي)</span><select id="att-event"><option value="">كل الفعاليات</option>${eventOpts}</select></label>
          <div class="actions">
            <button type="button" class="btn-primary" id="att-check-token">تحقق برمز QR</button>
            <button type="button" class="btn-secondary" id="att-manual-checkin">تسجيل حضور يدوي (بحث)</button>
          </div>
          <div class="hint">استخدم رمز QR مع اختيار الفعالية للتحقق المباشر، أو ابحث برقم التذكرة أو الحجز أو الهاتف.</div>
        </div>
      </div></div>
    </div>
    <div class="panel" style="margin-top:14px"><div class="panel-head"><h3>نتيجة آخر تحقق</h3></div><div class="panel-body" id="att-result"><div class="empty" style="padding:16px"><p>لا توجد عملية تحقق بعد.</p></div></div></div>`;

  $('#att-start') && ($('#att-start').onclick = ()=>startAttendanceScan((token)=>doCheckinToken(token,'qr',$('#att-qr-event')?.value||null)));
  $('#att-stop') && ($('#att-stop').onclick = ()=>{ stopAttendanceScan(); const s=$('#att-scan-status'); if(s) s.textContent='الكاميرا متوقفة.'; });
  $('#att-check-token') && ($('#att-check-token').onclick = ()=>doCheckinToken($('#att-manual-input')?.value||'','manual-token',$('#att-qr-event')?.value||null));
  $('#att-manual-checkin') && ($('#att-manual-checkin').onclick = async ()=>{
    const q = ($('#att-manual-input')?.value||'').trim();
    const eventId = $('#att-event')?.value || null;
    const out = $('#att-result');
    try {
      const { data, error } = await sb().rpc('admin_manual_checkin', { p_query: q, p_event_id: eventId || null });
      if (error) throw error;
      const r = Array.isArray(data)?data[0]:data;
      const pld = (r&&r.payload)||{};
      const ok = r && r.ok; const stateRes = r&&r.state||'';
      const stateLabel = ({ checked_in: 'تم تسجيل الحضور الآن', used: 'تم تسجيل الحضور مسبقاً', invalid: 'تذكرة غير صالحة', not_found: 'لم يتم العثور على تذكرة مطابقة', cancelled: 'التذكرة ملغاة', booking_ineligible: 'التسجيل المرتبط غير مؤهل', disabled: 'التحقق غير مفعّل لهذه الفعالية', ambiguous: 'أكثر من تذكرة تطابق الرقم. اختر الفعالية.', conflict: 'تعذر إكمال التحقق' })[stateRes] || String(stateRes || '-');
      if (out) out.innerHTML = `<div class="insight ${ok && stateRes!=='used'?'ok':'warn'}"><div style="font-weight:700;margin-bottom:6px">${esc((r&&r.message)||'نتيجة')}</div>
        ${pld.ticket_number?`<div>رقم التذكرة: <strong class="mono">${esc(pld.ticket_number)}</strong></div>`:''}
        ${pld.visitor_name?`<div>الاسم: <strong>${esc(pld.visitor_name)}</strong></div>`:''}
        ${pld.phone?`<div>الهاتف: <strong>${esc(pld.phone)}</strong></div>`:''}
        ${pld.title_ar||pld.title_en?`<div>الفعالية: <strong>${esc(pld.title_ar||pld.title_en)}</strong></div>`:''}
        <div class="hint" style="margin-top:6px">الحالة: ${esc(stateLabel)}</div></div>`;
      if (r && r.ok) await logAdminActivity(stateRes==='used'?'checkin_duplicate':'checkin_manual', 'event_ticket', pld.ticket_id||null, { state: stateRes, query: q ? '[provided]' : '' });
      await loadTickets(true);
    } catch (e) {
      if (out) out.innerHTML = `<div class="insight warn"><strong>تعذر التحقق من التذكرة.</strong><div class="hint">تأكد من تفعيل التذاكر والتحقق من الحضور للفعالية، ثم أعد المحاولة.</div></div>`;
    }
  });
}

// stop camera when leaving page
const _origRenderCurrent = renderCurrent;
document.addEventListener('visibilitychange', ()=>{ if (document.hidden) stopAttendanceScan(); });

// ---------- Activity Log ----------
async function renderActivityLog() {
  const root = $('#activitylog-root');
  if (root) root.innerHTML = '<div class="loading-state">جاري تحميل سجل النشاطات…</div>';
  await loadActivityLog();
  if (!root) return;
  const rows = state.activityLog || [];
  if (!rows.length) {
    root.innerHTML = `<div class="empty"><h3>لا توجد نشاطات لعرضها</h3><p>ستظهر هنا الإجراءات الإدارية عند تسجيلها.</p><button type="button" class="btn-secondary" onclick="app.renderActivityLog()">إعادة المحاولة</button></div>`;
    return;
  }
  root.innerHTML = `<div class="panel"><div class="panel-head"><h3>آخر النشاطات (${rows.length})</h3><button type="button" class="btn-secondary" onclick="app.renderActivityLog()">تحديث</button></div><div class="panel-body"><div class="table-wrap"><table><thead><tr><th>الوقت</th><th>المشرف</th><th>الإجراء</th><th>الكيان</th><th>تفاصيل</th></tr></thead><tbody>${rows.slice(0,300).map(r=>`<tr>
    <td>${esc(String(r.created_at||'').replace('T',' ').slice(0,19))}</td>
    <td>${esc(r.actor_email||'-')}</td>
    <td><span class="pill">${esc(r.action||'-')}</span></td>
    <td>${esc([r.entity_type,r.entity_id].filter(Boolean).join(' #')||'-')}</td>
    <td class="mono" style="font-size:12px;max-width:420px;white-space:pre-wrap">${esc(typeof r.details==='string'?r.details:JSON.stringify(r.details||{})).slice(0,300)}</td>
  </tr>`).join('')}</tbody></table></div>${rows.length>300?'<div class="hint">يُعرض آخر 300 سجل.</div>':''}</div></div>`;
}


// ---------- Settings ----------
async function renderSettings() {
  const a = state.admin;
  const box = $('#settings-box');
  if (!box) return;
  box.innerHTML = `
  <div class="form-card">
    <h3>الحساب والأمان</h3>
    <p class="lead">حدّث بيانات حسابك أو غيّر كلمة المرور.</p>
    <form id="settings-form">
      <div class="form-grid">
        <div class="field"><label>البريد الإلكتروني</label><input name="email" value="${esc(a?.email || '')}" disabled></div>
        <div class="field"><label>الاسم الكامل</label><input name="full_name" value="${esc(a?.full_name || '')}" required></div>
        <div class="field full"><label>كلمة مرور جديدة (اختياري)</label><input type="password" name="new_password" placeholder="اتركه فارغاً للإبقاء على الكلمة الحالية" minlength="6"></div>
      </div>
      <div class="save-bar">
        <button type="submit" class="btn-primary">حفظ التغييرات</button>
      </div>
    </form>
  </div>`;
  const form = $('#settings-form');
  if (form) {
    form.onsubmit = async (ev) => {
      ev.preventDefault();
      const fd = readForm(ev.target);
      try {
        const fullName = (fd.full_name || '').trim();
        const { error } = await sb().from('admins').update({ full_name: fullName }).eq('user_id', a.id);
        if (error) throw error;
        if (fd.new_password) {
          await doChangePassword(fd.new_password);
        }
        state.admin.full_name = fullName;
        const un = $('#user-name');
        if (un) un.textContent = state.admin.full_name || state.admin.email;
        showToast('تم حفظ الإعدادات');
        ev.target.reset();
        await renderSettings();
      } catch (err) { showToast(err.message, 'error'); }
    };
  }
}

// ---------- Init ----------
async function init() {
  initSupabase();
  const client = getSupabase();
  if (!client) {
    const body = $('#app-body');
    if (body) body.innerHTML = '<div class="empty"><h3>الخدمة غير متاحة حالياً</h3><p>تعذر الاتصال. يرجى المحاولة لاحقاً أو التواصل مع مسؤول المنصة.</p></div>';
    return;
  }

  const loggedIn = await restoreSession();
  const loginBox = $('#login-box');
  const appBox = $('#app-box');
  const userNameEl = $('#user-name');

  if (loggedIn) {
    if (loginBox) loginBox.style.display = 'none';
    if (appBox) appBox.style.display = 'grid';
    if (userNameEl) userNameEl.textContent = state.admin.full_name || state.admin.email;
    router();
  } else {
    if (loginBox) loginBox.style.display = 'block';
    if (appBox) appBox.style.display = 'none';
    const form = $('#login-form');
    if (form) {
      const btn = form.querySelector('button[type="submit"]');
      form.onsubmit = async (ev) => {
        ev.preventDefault();
        const fd = readForm(form);
        const errEl = $('#login-error');
        if (errEl) errEl.style.display = 'none';
        setLoading(btn, true);
        try {
          await doLogin(fd.email, fd.password);
          if (loginBox) loginBox.style.display = 'none';
          if (appBox) appBox.style.display = 'grid';
          if (userNameEl) userNameEl.textContent = state.admin.full_name || state.admin.email;
          router();
        } catch (err) {
          if (errEl) { errEl.textContent = friendlyError(err, 'تعذر تسجيل الدخول. تحقق من بياناتك وحاول مرة أخرى.'); errEl.style.display = 'block'; }
        } finally {
          setLoading(btn, false);
        }
      };
    }
    const resetLink = $('#reset-link');
    if (resetLink) {
      resetLink.onclick = async (ev) => {
        ev.preventDefault();
        const email = prompt('أدخل بريدك الإلكتروني لإعادة تعيين كلمة المرور:');
        if (!email) return;
        try {
          await resetPassword(email);
          showToast('تم إرسال تعليمات إعادة تعيين كلمة المرور إلى بريدك الإلكتروني.', 'success');
        } catch (err) { showToast(err.message || 'فشل إرسال تعليمات إعادة التعيين.', 'error'); }
      };
    }
  }

  const logoutBtn = $('#btn-logout');
  if (logoutBtn) logoutBtn.onclick = doLogout;

  // Mobile sidebar toggle (opens/closes via toggle button or overlay)
  const navToggle = $('#nav-toggle');
  const sidebarOverlay = $('#sidebar-overlay');
  const sidebarEl = document.querySelector('.sidebar');
  function toggleSidebar() {
    if (!sidebarEl) return;
    const open = !sidebarEl.classList.contains('open');
    sidebarEl.classList.toggle('open');
    sidebarEl.inert = !open;
    sidebarEl.setAttribute('aria-hidden', String(!open));
    if (sidebarOverlay) { sidebarOverlay.style.display = open ? 'block' : 'none'; sidebarOverlay.setAttribute('aria-hidden', String(!open)); }
    if (navToggle) navToggle.setAttribute('aria-expanded', String(open));
  }
  window.addEventListener('resize', () => {
    if (window.matchMedia('(min-width: 901px)').matches && sidebarEl) {
      sidebarEl.inert = false;
      sidebarEl.setAttribute('aria-hidden', 'false');
      if (sidebarOverlay) { sidebarOverlay.style.display = 'none'; sidebarOverlay.setAttribute('aria-hidden', 'true'); }
      if (navToggle) navToggle.setAttribute('aria-expanded', 'false');
    }
  }, { passive: true });
  if (navToggle) navToggle.onclick = toggleSidebar;
  if (sidebarOverlay) sidebarOverlay.onclick = toggleSidebar;
  // Collapsible sidebar groups
  $$('.group-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      const group = btn.closest('.nav-group');
      if (group) {
        const collapsed = group.classList.toggle('collapsed');
        btn.setAttribute('aria-expanded', String(!collapsed));
      }
    });
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') {
      if ($('#event-form-card')) closeEventForm();
      else if (sidebarEl?.classList.contains('open')) toggleSidebar();
      return;
    }
    const dialog = $('#event-form-card');
    if (dialog && ev.key === 'Tab') {
      const controls = [...dialog.querySelectorAll('button:not(:disabled), input:not(:disabled):not([type="hidden"]), select:not(:disabled), textarea:not(:disabled), [href], [tabindex]:not([tabindex="-1"])')].filter(el => el.offsetParent !== null);
      if (!controls.length) { ev.preventDefault(); dialog.focus(); return; }
      if (ev.shiftKey && document.activeElement === controls[0]) { ev.preventDefault(); controls.at(-1).focus(); }
      else if (!ev.shiftKey && document.activeElement === controls.at(-1)) { ev.preventDefault(); controls[0].focus(); }
    }
  });
  window.addEventListener('hashchange', () => router());

  // Listen for auth state changes (e.g. logout in another tab, token expiry)
  client.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT' || event === 'USER_DELETED' || event === 'TOKEN_REFRESH_FAILED') {
      state.admin = null;
      if (loginBox) loginBox.style.display = 'block';
      if (appBox) appBox.style.display = 'none';
    }
  });
}

// Expose public API for inline onclick handlers
const app = {
  router,
  renderEventBookings,
  renderSpaceBookings,
  renderCommunity,
  renderIdeas,
  renderInsights,
  renderTickets,
  renderAttendance,
  renderActivityLog,
  openEventForm,
  closeEventForm,
  openEventEdit,
  viewEventRegistrations: window.viewEventRegistrations,
  clearEventBookingFilter: window.clearEventBookingFilter,
  viewBookingDetail: window.viewBookingDetail,
  togglePublish: window.togglePublish,
  deleteEvent: window.deleteEvent,
  viewTicket: window.viewTicket,
  openTicketModal: window.openTicketModal,
  downloadTicketPngById: window.downloadTicketPngById,
  issueTicket: window.issueTicket,
  cancelTicket: window.cancelTicket,
  exportEventBookingsCsv: window.exportEventBookingsCsv,
  updateBookingStatus,
  editBookingNotes,
  updateSpaceStatus,
  editSpaceNotes,
  updateCommunityStatus,
  editCommunityNotes,
  updateIdeaStatus,
  editIdeaNotes,
};
window.app = app;

// متغيرات عامة للعناصر التي يناديها HTML مباشرة (app.html)
window.router = router;
window.openEventForm = openEventForm;
window.closeEventForm = closeEventForm;
window.openEventEdit = openEventEdit;

init();

// ===================== Site CMS (إعادة تطوير الموقع) =====================
let cmsItems = [];
let cmsSearch = '';
let cmsPageFilter = '';

async function ensureCmsUnlockedUI() {
  const root = document.getElementById('sitedev-root');
  if (!root) return false;
  // require admin session
  if (!state.admin) {
    root.innerHTML = '<div class="empty"><h3>غير مصرح</h3><p>يجب تسجيل الدخول كمشرف.</p></div>';
    return false;
  }
  // verify protected password via server-side Edge Function (secret stored on server, never in frontend)
  if (!siteDevUnlocked) {
    root.innerHTML = `
      <div class="panel" style="max-width:560px">
        <div class="panel-head"><h3>قسم محمي: إعادة تطوير الموقع</h3></div>
        <div class="panel-body">
          <p style="margin:0 0 12px;color:var(--muted)">أدخل كلمة مرور القسم للمتابعة.</p>
          <form id="cms-unlock-form" class="form-grid">
            <div class="field full"><label>كلمة مرور القسم</label><input type="password" name="password" autocomplete="off" required placeholder="أدخل كلمة المرور"></div>
            <div class="field full"><div id="cms-unlock-error" class="error-msg" style="display:none"></div></div>
            <div class="save-bar"><button type="submit" class="btn-primary" id="cms-unlock-btn">دخول إلى محرر المحتوى</button></div>
          </form>
        </div>
      </div>`;
    const form = document.getElementById('cms-unlock-form');
    if (form) {
      form.onsubmit = async (e) => {
        e.preventDefault();
        const btn = document.getElementById('cms-unlock-btn');
        const err = document.getElementById('cms-unlock-error');
        const pw = (new FormData(form).get('password') || '').toString();
        if (err) { err.style.display = 'none'; err.textContent = ''; }
        if (btn) { btn.disabled = true; btn.setAttribute('aria-busy','true'); }
        try {
          await verifySiteEditorPassword(pw);
          siteDevUnlocked = true;
          showToast('تم فتح محرر المحتوى');
          await renderSiteDev();
        } catch (ex) {
          if (err) { err.textContent = friendlyError(ex, 'تعذر التحقق من كلمة المرور. يرجى المحاولة مرة أخرى.'); err.style.display = 'block'; }
        } finally {
          if (btn) { btn.disabled = false; btn.removeAttribute('aria-busy'); }
        }
      };
    }
    return false;
  }
  return true;
}

function cmsEscape(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

function cmsPageLabel(p){
  const m={global:'عام/الموقع',nav:'التنقل',home:'الصفحة الرئيسية',space:'المساحة والحجز',events:'الفعاليات',community:'المجتمع',experiences:'تجارب',rates:'الأسعار',ideas:'شارك فكرتك',faq:'الأسئلة الشائعة',contact:'تواصل',footer:'التذييل'};
  return m[p]||p;
}

async function cmsLoadAll() {
  const catalog = await cmsLoadCatalog();
  // ensure rows exist / fetch
  let rows = [];
  try { rows = await cmsSyncAndFetch(catalog); } catch (e) { throw e; }
  const rowMap = new Map(rows.map(r=>[r.key,r]));
  // merge local drafts kept in memory/storage
  const local = cmsGetLocalDrafts();
  cmsItems = catalog.map(c => {
    const r = rowMap.get(c.key) || {};
    const ld = local[c.key] || {};
    const baseDraftEn = (r.draft_en != null) ? r.draft_en : (r.published_en != null ? r.published_en : (r.default_en != null ? r.default_en : c.default_en));
    const baseDraftAr = (r.draft_ar != null) ? r.draft_ar : (r.published_ar != null ? r.published_ar : (r.default_ar != null ? r.default_ar : c.default_ar));
    const draft_en = (ld.draft_en != null) ? ld.draft_en : baseDraftEn;
    const draft_ar = (ld.draft_ar != null) ? ld.draft_ar : baseDraftAr;
    const published_en = (r.published_en != null) ? r.published_en : (r.default_en != null ? r.default_en : c.default_en);
    const published_ar = (r.published_ar != null) ? r.published_ar : (r.default_ar != null ? r.default_ar : c.default_ar);
    const isPublished = !!(r.published_en != null || r.published_ar != null);
    const differsFromPublished = (String(draft_en||'') !== String(published_en||'')) || (String(draft_ar||'') !== String(published_ar||''));
    return { ...c, ...r, _draft_en: draft_en ?? '', _draft_ar: draft_ar ?? '', _published_en: published_en ?? '', _published_ar: published_ar ?? '', _isPublished: isPublished, _differsFromPublished: differsFromPublished };
  });
  return cmsItems;
}

let _cmsCatalogCache = null;
async function cmsLoadCatalog(){
  if (_cmsCatalogCache) return _cmsCatalogCache;
  const res = await fetch('./js/cms-catalog.json', { cache: 'no-store' });
  if (!res.ok) throw new Error('تعذر تحميل كتالوج المحتوى (cms-catalog.json).');
  _cmsCatalogCache = await res.json();
  return _cmsCatalogCache;
}
async function cmsSyncAndFetch(catalog){
  const sbx = sb();
  // fetch existing
  let { data: rows, error } = await sbx.from('site_content').select('*').order('sort_order', { ascending: true });
  if (error) throw error;
  rows = rows || [];
  const existing = new Set(rows.map(r=>r.key));
  const missing = catalog.filter(c=>!existing.has(c.key)).map(c=>({
    key:c.key,page:c.page,section:c.section,label:c.label,
    default_en:c.default_en||'',default_ar:c.default_ar||'',
    sort_order:c.sort_order||0, updated_at:new Date().toISOString()
  }));
  if (missing.length) {
    const { error: upErr } = await sbx.from('site_content').upsert(missing, { onConflict: 'key', ignoreDuplicates: true });
    if (upErr && !/duplicate|23505/i.test(String(upErr.message||'')+String(upErr.code||''))) throw upErr;
    const ref = await sbx.from('site_content').select('*').order('sort_order', { ascending: true });
    if (ref.error) throw ref.error;
    rows = ref.data || [];
  }
  return rows;
}

function cmsGetLocalDrafts(){
  try { return JSON.parse(localStorage.getItem('tz_cms_draft_v1')||'{}')||{}; } catch { return {}; }
}
function cmsSetLocalDrafts(d){
  try { localStorage.setItem('tz_cms_draft_v1', JSON.stringify(d||{})); } catch {}
}
function cmsSetDraftValue(key, lang, value){
  const d = cmsGetLocalDrafts();
  if (!d[key]) d[key] = {};
  d[key][lang==='ar'?'draft_ar':'draft_en'] = value;
  cmsSetLocalDrafts(d);
  const it = cmsItems.find(x=>x.key===key);
  if (it) { if (lang==='ar') it._draft_ar = value; else it._draft_en = value; it._differsFromPublished = (String(it._draft_en||'')!==String(it._published_en||'')) || (String(it._draft_ar||'')!==String(it._published_ar||'')); }
}

let cmsLastUndoSnapshot = null;

async function cmsSaveDraftsToDb(items){
  const sbx = sb();
  const updates = items.map(it=>({ key: it.key, draft_en: it._draft_en ?? '', draft_ar: it._draft_ar ?? '', updated_at: new Date().toISOString() }));
  cmsLastUndoSnapshot = { type:'save', prev: items.map(it=>({key:it.key, draft_en: it.draft_en ?? null, draft_ar: it.draft_ar ?? null})) };
  for (let i=0;i<updates.length;i+=60){ const chunk=updates.slice(i,i+60); const {error}=await sbx.from('site_content').upsert(chunk,{onConflict:'key'}); if(error) throw error; }
}

async function cmsPublishToDb(items){
  const sbx = sb();
  const now = new Date().toISOString();
  cmsLastUndoSnapshot = { type:'publish', prev: items.map(it=>({key:it.key, published_en: it.published_en ?? null, published_ar: it.published_ar ?? null, last_published_en: it.last_published_en ?? null, last_published_ar: it.last_published_ar ?? null, draft_en: it.draft_en ?? null, draft_ar: it.draft_ar ?? null})) };
  const updates = items.map(it=>({
    key: it.key,
    last_published_en: it.published_en ?? null,
    last_published_ar: it.published_ar ?? null,
    published_en: it._draft_en ?? '',
    published_ar: it._draft_ar ?? '',
    draft_en: it._draft_en ?? '',
    draft_ar: it._draft_ar ?? '',
    updated_at: now
  }));
  for (let i=0;i<updates.length;i+=60){ const chunk=updates.slice(i,i+60); const {error}=await sbx.from('site_content').upsert(chunk,{onConflict:'key'}); if(error) throw error; }
  cmsSetLocalDrafts({});
}

async function cmsUndoLast(){
  if (!cmsLastUndoSnapshot) throw new Error('لا يوجد إجراء للتراجع عنه في هذه الجلسة.');
  const sbx = sb();
  const updates = cmsLastUndoSnapshot.prev.map(p=>({ ...p, updated_at: new Date().toISOString() }));
  for (let i=0;i<updates.length;i+=60){ const chunk=updates.slice(i,i+60); const {error}=await sbx.from('site_content').upsert(chunk,{onConflict:'key'}); if(error) throw error; }
  cmsLastUndoSnapshot = null;
  cmsSetLocalDrafts({});
}

function cmsRenderItems(){
  const root = document.getElementById('cms-editor-area');
  if (!root) return;
  const q = (cmsSearch||'').toLowerCase().trim();
  const pageF = cmsPageFilter || '';
  const filtered = cmsItems.filter(it => {
    if (pageF && it.page !== pageF) return false;
    if (!q) return true;
    const hay = [it.key,it.label,it.section,it.page,it._draft_en,it._draft_ar,it._published_en,it._published_ar,it.default_en,it.default_ar].join(' ').toLowerCase();
    return hay.includes(q);
  });
  if (!filtered.length) { root.innerHTML = '<div class="empty"><h3>لا توجد نتائج</h3><p>جرّب كلمة بحث أخرى أو غيّر الفلتر.</p></div>'; return; }

  // group by page > section
  const byPage = new Map();
  filtered.forEach(it=>{ if(!byPage.has(it.page)) byPage.set(it.page,new Map()); const s=byPage.get(it.page); if(!s.has(it.section)) s.set(it.section,[]); s.get(it.section).push(it); });
  let html = '';
  for (const [page, secs] of byPage.entries()) {
    html += `<div class="panel" style="margin-bottom:14px"><div class="panel-head"><h3>${cmsEscape(cmsPageLabel(page))}</h3></div><div class="panel-body">`;
    for (const [sec, items] of secs.entries()) {
      html += `<div style="margin-bottom:16px"><div style="font-weight:600;margin-bottom:8px;color:var(--ink)">${cmsEscape(sec)}</div><div style="display:grid;gap:10px">`;
      items.forEach(it => {
        const status = it._isPublished ? (it._differsFromPublished ? '<span class="badge badge-reviewed">مسودة مختلفة عن المنشور</span>' : '<span class="badge badge-published">منشور</span>') : '<span class="badge badge-unpublished">غير منشور</span>';
        html += `<div class="form-card cms-item" data-key="${cmsEscape(it.key)}" style="padding:14px">
          <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;justify-content:space-between;margin-bottom:8px">
            <div><div style="font-weight:600">${cmsEscape(it.label)}</div><div class="sub" style="font-family:monospace">${cmsEscape(it.key)}</div></div>
            <div style="display:flex;gap:6px;align-items:center">${status}</div>
          </div>
          <div class="form-grid">
            <div class="field full"><label>النص الإنجليزي (EN)</label><textarea rows="2" data-cms-lang="en" data-cms-key="${cmsEscape(it.key)}">${cmsEscape(it._draft_en)}</textarea></div>
            <div class="field full"><label>النص العربي (AR)</label><textarea rows="2" dir="rtl" data-cms-lang="ar" data-cms-key="${cmsEscape(it.key)}">${cmsEscape(it._draft_ar)}</textarea></div>
          </div>
          <div class="actions" style="margin-top:8px">
            <button type="button" class="edit" data-cms-action="restore" data-key="${cmsEscape(it.key)}">استعادة النص الأصلي</button>
          </div>
        </div>`;
      });
      html += `</div></div>`;
    }
    html += `</div></div>`;
  }
  root.innerHTML = html;
  // bind inputs
  root.querySelectorAll('textarea[data-cms-key]').forEach(t => {
    t.addEventListener('input', (e)=>{
      const key = e.target.getAttribute('data-cms-key');
      const lang = e.target.getAttribute('data-cms-lang');
      cmsSetDraftValue(key, lang, e.target.value);
    });
  });
  root.querySelectorAll('button[data-cms-action="restore"]').forEach(b=>{
    b.addEventListener('click', ()=>{
      const key = b.getAttribute('data-key');
      const it = cmsItems.find(x=>x.key===key);
      if (!it) return;
      cmsSetDraftValue(key,'en', it.default_en || '');
      cmsSetDraftValue(key,'ar', it.default_ar || '');
      it._draft_en = it.default_en || ''; it._draft_ar = it.default_ar || '';
      it._differsFromPublished = (String(it._draft_en)!==String(it._published_en)) || (String(it._draft_ar)!==String(it._published_ar));
      showToast('تمت استعادة النص الأصلي لهذا العنصر (احفظ/انشر لتطبيقه)');
      cmsRenderItems();
    });
  });
}

async function renderSiteDev() {
  const root = document.getElementById('sitedev-root');
  if (!root) return;
  if (!(await ensureCmsUnlockedUI())) return;
  root.innerHTML = '<div class="loading-state">جاري تحميل محرر المحتوى...</div>';
  try {
    await cmsLoadAll();
  } catch (e) {
    root.innerHTML = `<div class="empty"><h3>تعذر تحميل محرر المحتوى</h3><p>يرجى المحاولة مرة أخرى. إذا استمرت المشكلة، تواصل مع مسؤول المنصة.</p><button type="button" class="btn-secondary" onclick="app.router('sitedev')">إعادة المحاولة</button></div>`;
    return;
  }
  const pages = [...new Set(cmsItems.map(i=>i.page))];
  root.innerHTML = `
    <div class="panel" style="margin-bottom:14px">
      <div class="panel-head"><h3>إعادة تطوير الموقع — محرر المحتوى</h3></div>
      <div class="panel-body">
        <p style="margin:0 0 10px;color:var(--muted)">عدّل نصوص الموقع بالعربية والإنجليزية. احفظ التغييرات كمسودة أو انشرها لتظهر للزوار.</p>
        <div class="toolbar">
          <div class="search"><input id="cms-search" placeholder="بحث عن نص أو مفتاح..." value="${cmsEscape(cmsSearch)}"></div>
          <select id="cms-page-filter"><option value="">كل الصفحات/الأقسام</option>${pages.map(p=>`<option value="${cmsEscape(p)}" ${cmsPageFilter===p?'selected':''}>${cmsEscape(cmsPageLabel(p))}</option>`).join('')}</select>
        </div>
        <div class="actions" style="margin:8px 0 4px;gap:8px">
          <button type="button" class="btn-primary" id="cms-save-btn">حفظ المسودة</button>
          <button type="button" class="btn-secondary" id="cms-publish-btn">نشر التغييرات على الموقع</button>
          <button type="button" class="btn-secondary" id="cms-preview-btn">معاينة (محلياً)</button>
          <button type="button" class="btn-secondary" id="cms-undo-btn">تراجع عن آخر إجراء</button>
          <button type="button" class="btn-secondary" id="cms-reload-btn">إعادة تحميل</button>
        </div>
        <div id="cms-status-msg" class="hint" style="margin-top:6px"></div>
      </div>
    </div>
    <div id="cms-editor-area"></div>
  `;
  const searchEl = document.getElementById('cms-search');
  const filterEl = document.getElementById('cms-page-filter');
  if (searchEl) searchEl.oninput = (e)=>{ cmsSearch = e.target.value; cmsRenderItems(); };
  if (filterEl) filterEl.onchange = (e)=>{ cmsPageFilter = e.target.value; cmsRenderItems(); };
  document.getElementById('cms-save-btn').onclick = async ()=>{
    const msg = document.getElementById('cms-status-msg'); if (msg) msg.textContent = 'جارٍ حفظ المسودة...';
    try { await cmsSaveDraftsToDb(cmsItems); await cmsLoadAll(); cmsRenderItems(); showToast('تم حفظ المسودة'); if (msg) msg.textContent = 'تم الحفظ.'; }
    catch(e){ showToast(e.message||'فشل الحفظ','error'); if(msg) msg.textContent = friendlyError(e, 'تعذر حفظ المسودة.'); }
  };
  document.getElementById('cms-publish-btn').onclick = async ()=>{
    if (!confirm('نشر التغييرات الحالية سيجعلها ظاهرة لجميع زوار الموقع. هل تريد المتابعة؟')) return;
    const msg = document.getElementById('cms-status-msg'); if (msg) msg.textContent = 'جارٍ النشر...';
    try { await cmsPublishToDb(cmsItems); await cmsLoadAll(); cmsRenderItems(); showToast('تم نشر التغييرات على الموقع'); if (msg) msg.textContent = 'تم النشر بنجاح.'; }
    catch(e){ showToast(e.message||'فشل النشر','error'); if(msg) msg.textContent = friendlyError(e, 'تعذر نشر المحتوى.'); }
  };
  document.getElementById('cms-preview-btn').onclick = ()=>{
    // local preview: store current drafts to a preview key read by public site
    try { localStorage.setItem('tz_cms_preview_v1', JSON.stringify({ ts: Date.now(), items: cmsItems.map(i=>({key:i.key,en:i._draft_en,ar:i._draft_ar})) })); } catch {}
    window.open('../index.html?cms_preview=1', '_blank');
  };
  document.getElementById('cms-undo-btn').onclick = async ()=>{
    try { await cmsUndoLast(); await cmsLoadAll(); cmsRenderItems(); showToast('تم التراجع عن آخر إجراء'); }
    catch(e){ showToast(e.message||'لا يمكن التراجع','error'); }
  };
  document.getElementById('cms-reload-btn').onclick = async ()=>{ try{ await cmsLoadAll(); cmsRenderItems(); showToast('تمت إعادة التحميل'); }catch(e){ showToast(e.message||'فشل التحميل','error'); } };

  cmsRenderItems();
}
