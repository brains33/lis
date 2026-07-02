// ============================================================
// MU'UJIZA HMS — pharmacy-auth-guard.js
// Shared guard for pharmacy-queue.html and pharmacy-admin.html.
// Include this <script> BEFORE pharmacy-queue.js / pharmacy-admin.js.
// ============================================================
(function(){
  const KEY = 'muujiza_pharmacy_session';
  const ALLOWED_ROLES = ['pharmacist','pharmacy_admin'];
  try{
    const s = JSON.parse(sessionStorage.getItem(KEY)||'null');
    if(!s || !s.token || !ALLOWED_ROLES.includes(s.role) || Date.now()>=s.expiresAt){
      sessionStorage.removeItem(KEY); window.location.replace('pharmacy-login.html'); return;
    }
    window.pharmacySession = s;
  }catch{ window.location.replace('pharmacy-login.html'); }
})();
