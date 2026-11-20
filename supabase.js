// Supabase client for The Zone admin dashboard (secure version)
// Configure these after creating your Supabase project:
//   https://app.supabase.com -> Project Settings -> API
const SUPABASE_URL = 'https://hdzeuvvnhqjbbzpishov.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_IEDJvUlS1GYe6ci9XXXTGg_IuVcR9QL';

let supabase = null;

function initSupabase() {
  // Initialize only once.
  if (supabase) return supabase;

  if (typeof window.supabase === 'undefined') {
    console.error('Supabase client not loaded. Add the Supabase JS CDN script before js/supabase.js.');
    return null;
  }
  if (!SUPABASE_URL || SUPABASE_URL.includes('{{')) {
    console.warn('Supabase غير مهيأ. ضعي رابط المشروع والمفتاح العام في js/supabase.js (SUPABASE_URL و SUPABASE_ANON_KEY).');
    return null;
  }
  if (!SUPABASE_ANON_KEY || SUPABASE_ANON_KEY.includes('{{')) {
    console.warn('Supabase غير مهيأ. ضعي المفتاح العام (publishable/anon key) في js/supabase.js.');
    return null;
  }
  supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  return supabase;
}

function getSupabase() { return supabase; }

// ---------- Authentication helpers (Supabase Auth) ----------

// Sign in with email + password. Returns the admin profile or throws an Arabic error.
async function signIn(email, password) {
  const sb = getSupabase();
  if (!sb) throw new Error('Supabase غير مهيأ.');
  const { data, error } = await sb.auth.signInWithPassword({ email, password });
  if (error) throw new Error('البريد الإلكتروني أو كلمة المرور غير صحيحة.');
  if (!data.user) throw new Error('فشل تسجيل الدخول.');

  // Verify the user is an authorized administrator (admins table).
  const { data: profile, error: perr } = await sb
    .from('admins')
    .select('full_name, role')
    .eq('user_id', data.user.id)
    .maybeSingle();
  if (perr) throw perr;
  if (!profile || profile.role !== 'admin') {
    await sb.auth.signOut();
    throw new Error('ليس لديك صلاحية دخول لوحة الإدارة.');
  }
  return { id: data.user.id, email: data.user.email, full_name: profile.full_name || '', role: profile.role };
}

// Restore an existing Supabase Auth session (page refresh).
async function getSession() {
  const sb = getSupabase();
  if (!sb) return null;
  const { data, error } = await sb.auth.getSession();
  if (error) return null;
  const session = data.session;
  if (!session || !session.user) return null;
  const { data: profile, error: perr } = await sb
    .from('admins')
    .select('full_name, role')
    .eq('user_id', session.user.id)
    .maybeSingle();
  if (perr || !profile || profile.role !== 'admin') return null;
  return {
    id: session.user.id,
    email: session.user.email,
    full_name: profile.full_name || '',
    role: profile.role,
  };
}

async function signOut() {
  const sb = getSupabase();
  if (!sb) return;
  await sb.auth.signOut();
}

// Change the logged-in administrator's password via Supabase Auth.
async function changePassword(newPassword) {
  const sb = getSupabase();
  if (!sb) throw new Error('Supabase غير مهيأ.');
  const { error } = await sb.auth.updateUser({ password: newPassword });
  if (error) throw error;
}

// Send a password-reset email to the given address.
async function resetPassword(email) {
  const sb = getSupabase();
  if (!sb) throw new Error('Supabase غير مهيأ.');
  const { error } = await sb.auth.resetPasswordForEmail(email, {
    redirectTo: `${window.location.origin}/admin-dashboard/app.html`,
  });
  if (error) throw error;
}

// Verify protected site-editor section password via secure Edge Function (server-side secret).
async function verifySiteEditorPassword(password) {
  const sb = getSupabase();
  if (!sb) throw new Error('تعذر إكمال العملية حالياً.');
  const { data, error } = await sb.functions.invoke('verify-site-editor', { body: { password } });
  if (error) {
    throw new Error('تعذر التحقق من كلمة المرور. يرجى المحاولة مرة أخرى.');
  }
  if (!data || data.ok !== true) throw new Error('كلمة المرور غير صحيحة أو غير مصرح.');
  return true;
}

export { initSupabase, getSupabase, signIn, getSession, signOut, changePassword, resetPassword, verifySiteEditorPassword };
