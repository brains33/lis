// ============================================================
// MU'UJIZA HMS — pharmacy-login.js
// ============================================================
const SUPABASE_URL      = 'https://npdopywxemtwzvpummsn.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5wZG9weXd4ZW10d3p2cHVtbXNuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk4NzY0MjksImV4cCI6MjA5NTQ1MjQyOX0.Mo5LfGdfSiHL6QHsPOaGkDmeaIRDqZTe8MGwz_6ou1c';
const SESSION_KEY   = 'muujiza_pharmacy_session';
const MAX_ATTEMPTS  = 5;
const LOCKOUT_MS    = 15 * 60 * 1000;
const SESSION_TTL   = 8 * 60 * 60 * 1000;
const ROLE_PAGES    = { pharmacist: 'pharmacy-queue.html', pharmacy_admin: 'pharmacy-admin.html' };

let _ip = 'unknown';
(async()=>{ try{ const r=await fetch('https://api.ipify.org?format=json'); _ip=(await r.json()).ip||'unknown'; }catch{} })();

// Redirect if already logged in
try{
  const s = JSON.parse(sessionStorage.getItem(SESSION_KEY)||'null');
  if(s?.token && Date.now()<s.expiresAt && ROLE_PAGES[s.role]) window.location.replace(ROLE_PAGES[s.role]);
}catch{}

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
let selectedRole = null;
let lockoutInterval = null;

// Role buttons
document.querySelectorAll('.role-btn').forEach(btn=>{
  btn.addEventListener('click',()=>{
    document.querySelectorAll('.role-btn').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');
    selectedRole = btn.dataset.role;
    hideError();
    document.getElementById('usernameInput').focus();
  });
});

// Password eye
document.getElementById('pwEye').addEventListener('click',()=>{
  const pw = document.getElementById('passwordInput');
  pw.type = pw.type==='password'?'text':'password';
  document.getElementById('pwEye').textContent = pw.type==='password'?'👁':'🙈';
});

// Caps lock
document.getElementById('passwordInput').addEventListener('keyup',e=>{
  document.getElementById('capsWarn').style.display =
    e.getModifierState('CapsLock') ? 'block' : 'none';
});

document.addEventListener('keydown',e=>{ if(e.key==='Enter') attemptLogin(); });
document.getElementById('loginBtn').addEventListener('click', attemptLogin);

// Brute-force protection
function _lsKey(u){ return `phm_atx_${btoa(u.toLowerCase())}`; }
function getAttempts(u){ try{ return JSON.parse(localStorage.getItem(_lsKey(u))||'{"count":0,"lockedUntil":null}'); }catch{ return {count:0,lockedUntil:null}; } }
function saveAttempts(u,d){ try{ localStorage.setItem(_lsKey(u),JSON.stringify(d)); }catch{} }
function recordFailure(u){ const d=getAttempts(u); d.count=Math.min((d.count||0)+1,MAX_ATTEMPTS); if(d.count>=MAX_ATTEMPTS) d.lockedUntil=Date.now()+LOCKOUT_MS; saveAttempts(u,d); return d; }
function clearAttempts(u){ try{ localStorage.removeItem(_lsKey(u)); }catch{} }
function isLockedOut(u){ const d=getAttempts(u); if(!d.lockedUntil) return false; if(Date.now()<d.lockedUntil) return true; clearAttempts(u); return false; }
function remainingMs(u){ const d=getAttempts(u); return d.lockedUntil?Math.max(0,d.lockedUntil-Date.now()):0; }
function updateDots(u){
  const d=getAttempts(u); const bar=document.getElementById('attemptBar');
  if(!bar||d.count===0){if(bar)bar.style.display='none';return;}
  bar.style.display='flex';
  for(let i=1;i<=5;i++) document.getElementById(`dot${i}`)?.classList.toggle('used',i<=d.count);
  const lbl=document.getElementById('attemptLabel');
  if(lbl){ const r=MAX_ATTEMPTS-d.count; lbl.textContent=r>0?`${r} attempt${r!==1?'s':''} remaining`:'Account locked'; }
}
function startLockout(u){
  document.getElementById('lockoutBox').classList.add('show');
  document.getElementById('loginBtn').disabled=true;
  if(lockoutInterval) clearInterval(lockoutInterval);
  function tick(){
    const ms=remainingMs(u);
    if(ms<=0){ clearInterval(lockoutInterval); document.getElementById('lockoutBox').classList.remove('show');
      document.getElementById('loginBtn').disabled=false; clearAttempts(u); updateDots(u); return; }
    const m=Math.floor(ms/60000),s=Math.floor((ms%60000)/1000);
    document.getElementById('lockoutTimer').textContent=`${m}:${s.toString().padStart(2,'0')}`;
  }
  tick(); lockoutInterval=setInterval(tick,1000);
}

function showError(msg){ document.getElementById('errorBox').textContent=msg; document.getElementById('errorBox').classList.add('show'); }
function hideError(){ document.getElementById('errorBox').classList.remove('show'); }
function setBusy(on){ const btn=document.getElementById('loginBtn'); btn.classList.toggle('loading',on); btn.disabled=on; }

async function attemptLogin(){
  hideError();
  if(!selectedRole) return showError('Please select your role first.');
  const username = document.getElementById('usernameInput').value.trim();
  const password = document.getElementById('passwordInput').value;
  if(!username) return showError('Enter your username.');
  if(!password) return showError('Enter your password.');
  if(isLockedOut(username.toLowerCase())){ startLockout(username.toLowerCase()); return; }

  setBusy(true);
  try{
    const { data, error } = await sb.rpc('authenticate_user',{ p_username:username, p_password:password });
    if(error||!data||data.length===0){
      const d=recordFailure(username.toLowerCase());
      updateDots(username.toLowerCase());
      if(d.count>=MAX_ATTEMPTS) startLockout(username.toLowerCase());
      throw new Error('Invalid username or password.');
    }
    const user = data[0];
    if(user.role !== selectedRole)
      throw new Error(`Your account role is "${user.role}". Please select the correct role.`);
    if(!ROLE_PAGES[selectedRole])
      throw new Error('No page configured for your role. Contact admin.');

    clearAttempts(username.toLowerCase());
    const payload = {
      id: user.username, username: user.username,
      name: user.display_name||user.full_name||user.name||user.username,
      role: selectedRole, token: user.session_token||null,
      loginAt: Date.now(), expiresAt: Date.now()+SESSION_TTL
    };
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(payload));

    const authed = user.session_token
      ? window.supabase.createClient(SUPABASE_URL,SUPABASE_ANON_KEY,{global:{headers:{'x-lis-token':user.session_token}}})
      : sb;
    authed.from('audit_log').insert({ts:new Date().toISOString(),user_name:user.username,user_role:selectedRole,action:'Login',details:`Pharmacy module | IP:${_ip}`}).then(()=>{}).catch(()=>{});

    window.location.replace(ROLE_PAGES[selectedRole]+'?t='+Date.now());
  }catch(err){
    showError(err.message||'Login failed.');
  }finally{ setBusy(false); }
}
