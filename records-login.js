// ============================================================
// MU'UJIZA RECORDS — Standalone login (independent of lab login.js)
// Own session key (muujiza_records_session), own role set, own
// localStorage namespace for lockouts — does not touch lab session.
// ============================================================

// ========== IP ADDRESS CAPTURE ==========
let _clientIP = 'unknown';
(async function fetchClientIP() {
  try {
    const res = await fetch('https://api.ipify.org?format=json');
    const data = await res.json();
    _clientIP = data.ip || 'unknown';
  } catch (e) {
    try {
      const res2 = await fetch('https://api64.ipify.org?format=json');
      const d2 = await res2.json();
      _clientIP = d2.ip || 'unknown';
    } catch (e2) { _clientIP = 'fetch-failed'; }
  }
})();

// ========== CONFIGURATION ==========
const SUPABASE_URL      = 'https://npdopywxemtwzvpummsn.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5wZG9weXd4ZW10d3p2cHVtbXNuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk4NzY0MjksImV4cCI6MjA5NTQ1MjQyOX0.Mo5LfGdfSiHL6QHsPOaGkDmeaIRDqZTe8MGwz_6ou1c';

const SESSION_KEY    = 'muujiza_records_session'; // separate from 'muujiza_session'
const MAX_ATTEMPTS   = 5;
const LOCKOUT_MS      = 15 * 60 * 1000;
const SESSION_TTL_MS  = 4 * 60 * 60 * 1000;

const ROLE_PAGES = {
  records_officer: 'register-patient.html',
  records_admin:   'record-admin.html'
};

// If already logged into the Records module, skip straight to the page
(function redirectIfLoggedIn() {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return;
    const s = JSON.parse(raw);
    if (s && s.id && s.role && s.expiresAt && Date.now() < s.expiresAt) {
      if (ROLE_PAGES[s.role]) window.location.replace(ROLE_PAGES[s.role]);
    }
  } catch {}
})();

let supabaseClient = null;
try {
  if (typeof window.supabase !== 'undefined') {
    supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  } else {
    console.error('❌ window.supabase is not defined – check that the Supabase script loaded');
  }
} catch (e) {
  console.error('❌ Failed to create Supabase client:', e);
}

let selectedRole    = null;
let lockoutInterval = null;

// ========== BRUTE-FORCE PROTECTION (namespaced) ==========
function _lsKey(username) { return `rec_atx_${btoa(username.toLowerCase())}`; }

function getAttemptData(username) {
  try {
    const raw = localStorage.getItem(_lsKey(username));
    return raw ? JSON.parse(raw) : { count: 0, lockedUntil: null };
  } catch { return { count: 0, lockedUntil: null }; }
}
function saveAttemptData(username, data) {
  try { localStorage.setItem(_lsKey(username), JSON.stringify(data)); } catch {}
}
function recordFailure(username) {
  const d = getAttemptData(username);
  d.count = Math.min((d.count || 0) + 1, MAX_ATTEMPTS);
  if (d.count >= MAX_ATTEMPTS) d.lockedUntil = Date.now() + LOCKOUT_MS;
  saveAttemptData(username, d);

  if (supabaseClient) {
    sbInsert('login_attempts', {
      username:     username.toLowerCase(),
      attempted_at: new Date().toISOString(),
      locked_until: d.lockedUntil ? new Date(d.lockedUntil).toISOString() : null,
      ip_address:   _clientIP,
      user_agent:   navigator.userAgent.substring(0, 200)
    });
  }
  return d;
}
function clearAttempts(username) {
  try { localStorage.removeItem(_lsKey(username)); } catch {}
}
function isLockedOut(username) {
  const d = getAttemptData(username);
  if (!d.lockedUntil) return false;
  if (Date.now() < d.lockedUntil) return true;
  clearAttempts(username);
  return false;
}
function remainingLockoutMs(username) {
  const d = getAttemptData(username);
  return d.lockedUntil ? Math.max(0, d.lockedUntil - Date.now()) : 0;
}
function updateAttemptBar(username) {
  const d = getAttemptData(username);
  const bar = document.getElementById('attemptBar');
  if (!bar) return;
  if (d.count === 0) { bar.style.display = 'none'; return; }
  bar.style.display = 'flex';
  for (let i = 1; i <= 5; i++) {
    document.getElementById(`dot${i}`)?.classList.toggle('used', i <= d.count);
  }
  const remaining = MAX_ATTEMPTS - d.count;
  const label = document.getElementById('attemptLabel');
  if (label) label.textContent = remaining > 0
    ? `${remaining} attempt${remaining !== 1 ? 's' : ''} remaining`
    : 'Account locked';
}
function startLockoutTimer(username) {
  document.getElementById('lockoutBox')?.classList.add('show');
  const btn = document.getElementById('loginBtn');
  if (btn) btn.disabled = true;
  if (lockoutInterval) clearInterval(lockoutInterval);

  function tick() {
    const ms = remainingLockoutMs(username);
    if (ms <= 0) {
      clearInterval(lockoutInterval);
      document.getElementById('lockoutBox')?.classList.remove('show');
      const b = document.getElementById('loginBtn');
      if (b) b.disabled = false;
      clearAttempts(username);
      updateAttemptBar(username);
      return;
    }
    const m = Math.floor(ms / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    const timer = document.getElementById('lockoutTimer');
    if (timer) timer.textContent = `${m}:${s.toString().padStart(2, '0')}`;
  }
  tick();
  lockoutInterval = setInterval(tick, 1000);
}

// ========== ROLE BUTTONS ==========
const roleBtns = document.querySelectorAll('.role-btn');
roleBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    roleBtns.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    selectedRole = btn.dataset.role;
    hideError();
    document.getElementById('usernameInput')?.focus();
  });
});

// ========== UI HELPERS ==========
const pwEye = document.getElementById('pwEye');
if (pwEye) {
  pwEye.addEventListener('click', () => {
    const pw = document.getElementById('passwordInput');
    if (pw) {
      const show = pw.type === 'password';
      pw.type = show ? 'text' : 'password';
      pwEye.textContent = show ? '🙈' : '👁';
      pw.focus();
    }
  });
}
const passwordInput = document.getElementById('passwordInput');
if (passwordInput) {
  passwordInput.addEventListener('keyup', e => {
    const on = e.getModifierState && e.getModifierState('CapsLock');
    const capsWarn = document.getElementById('capsWarn');
    if (capsWarn) capsWarn.style.display = on ? 'block' : 'none';
  });
}
['usernameInput', 'passwordInput'].forEach(id => {
  const el = document.getElementById(id);
  if (el) el.addEventListener('input', hideError);
});
document.addEventListener('keydown', e => { if (e.key === 'Enter') attemptLogin(); });
const loginBtn = document.getElementById('loginBtn');
if (loginBtn) loginBtn.addEventListener('click', attemptLogin);

function sbInsert(table, row) {
  Promise.resolve(supabaseClient.from(table).insert(row)).catch(() => {});
}

// ========== SECURE LOGIN ==========
async function attemptLogin() {
  hideError();

  if (!selectedRole) return showError('Please select your role first.');

  const username = document.getElementById('usernameInput').value.trim();
  const password = document.getElementById('passwordInput').value;
  const ukey     = username.toLowerCase();

  if (!username) return showError('Please enter your username.');
  if (!password) return showError('Please enter your password.');
  if (password.length < 4) return showError('Password too short.');

  if (isLockedOut(ukey)) { startLockoutTimer(ukey); return; }

  setBusy(true);

  try {
    if (!supabaseClient) throw new Error('Cannot connect. Check your internet connection.');

    const { data: authResult, error: rpcError } = await supabaseClient.rpc('authenticate_user', {
      p_username: username,
      p_password: password
    });

    if (rpcError || !authResult || authResult.length === 0) {
      const d = recordFailure(ukey);
      updateAttemptBar(ukey);
      if (d.count >= MAX_ATTEMPTS) startLockoutTimer(ukey);

      sbInsert('audit_log', {
        ts: new Date().toISOString(),
        user_name:  username,
        user_role:  selectedRole,
        action:     'Failed Login',
        details:    (rpcError ? `RPC error: ${rpcError.message}` : 'Invalid credentials') + ` | IP: ${_clientIP} | module: records`
      });
      sbInsert('ip_access_log', {
        ip_address:   _clientIP,
        username:     username.toLowerCase(),
        action:       'failed_login',
        user_agent:   navigator.userAgent.substring(0, 200),
        attempted_at: new Date().toISOString(),
        success:      false,
        fail_reason:  rpcError ? rpcError.message : 'Invalid credentials'
      });

      throw new Error('Invalid username or password.');
    }

    const user = authResult[0];

    if (user.role !== selectedRole) {
      sbInsert('audit_log', {
        ts: new Date().toISOString(),
        user_name:  username,
        user_role:  selectedRole,
        action:     'Failed Login',
        details:    `Role mismatch — registered as "${user.role}", attempted "${selectedRole}" | module: records`
      });
      throw new Error(`Access denied. Your account role is "${user.role}" — please select the correct role.`);
    }

    const destination = ROLE_PAGES[selectedRole];
    if (!destination) throw new Error('No page configured for your role. Contact admin.');

    clearAttempts(ukey);

    const sessionToken = user.session_token || null;

    const sessionPayload = {
      id:        user.username,
      username:  user.username,
      name:      user.display_name || user.full_name || user.name || user.username,
      role:      selectedRole,
      token:     sessionToken,
      loginAt:   Date.now(),
      expiresAt: Date.now() + SESSION_TTL_MS,
    };
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(sessionPayload));

    const authedClient = sessionToken
      ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
          global: { headers: { 'x-lis-token': sessionToken } }
        })
      : supabaseClient;

    Promise.resolve(authedClient.from('audit_log').insert({
      ts: new Date().toISOString(),
      user_name:  user.username,
      user_role:  selectedRole,
      action:     'Login',
      details:    `Successful login | IP: ${_clientIP} | module: records`
    })).catch(() => {});
    Promise.resolve(authedClient.from('access_log').insert({
      username:    user.username,
      role:        selectedRole,
      action:      'login',
      created_at:  new Date().toISOString()
    })).catch(() => {});
    Promise.resolve(authedClient.from('ip_access_log').insert({
      ip_address:   _clientIP,
      username:     user.username.toLowerCase(),
      action:       'successful_login',
      user_agent:   navigator.userAgent.substring(0, 200),
      attempted_at: new Date().toISOString(),
      success:      true,
      fail_reason:  null
    })).catch(() => {});

    window.location.replace(destination + '?t=' + Date.now());

  } catch (err) {
    showError(err.message || 'Login failed. Please try again.');
  } finally {
    setBusy(false);
  }
}

function setBusy(on) {
  const btn = document.getElementById('loginBtn');
  if (btn) {
    btn.classList.toggle('loading', on);
    btn.disabled = on;
  }
}
function showError(msg) {
  const box = document.getElementById('errorBox');
  if (box) { box.textContent = msg; box.classList.add('show'); }
}
function hideError() {
  const box = document.getElementById('errorBox');
  if (box) box.classList.remove('show');
}
