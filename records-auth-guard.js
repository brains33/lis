// ============================================================
// MU'UJIZA RECORDS — auth guard for register-patient.html / record-admin.html
// Checks the records-only session key; redirects to records-login.html
// if missing/expired. Independent of the lab's auth-guard.js.
// ============================================================
(function () {
  const SESSION_KEY = 'muujiza_records_session';
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) { window.location.replace('records-login.html'); return; }
    const s = JSON.parse(raw);
    if (!s || !s.id || !s.role || !s.expiresAt || Date.now() >= s.expiresAt) {
      sessionStorage.removeItem(SESSION_KEY);
      window.location.replace('records-login.html');
      return;
    }
    window.recordsSession = s; // expose for the page script
  } catch {
    window.location.replace('records-login.html');
  }
})();
