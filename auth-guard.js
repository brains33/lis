/**
 * auth-guard.js — MU'UJIZA LIS
 * ═══════════════════════════════════════════════════════════════
 *
 * HOW TO USE — add to EVERY protected page
 * ─────────────────────────────────────────
 * 1. Add this ONE line inside <head>, BEFORE any other scripts:
 *
 *      <script src="auth-guard.js"></script>
 *
 * 2. At the very top of your page's own <script> block, call:
 *
 *      const currentSession = checkAuth(['reception']);          // accession.html
 *      const currentSession = checkAuth(['technologist','admin','supervisor']); // result_entry.html
 *      const currentSession = checkAuth(['supervisor','admin']); // management1.html
 *      const currentSession = checkAuth(['admin','supervisor']); // management.html
 *
 * 3. Remove the old inline checkAuth() and logoutUser() functions
 *    from each page — this file replaces them all.
 *
 * 4. Replace any inline logoutUser() call with window.logoutUser()
 *    (it is already on window so most pages need no change).
 *
 * WHAT IT DOES
 * ─────────────────────────────────────────
 * • Reads the session written by login.html from sessionStorage.
 * • Validates: exists, not expired, role is allowed for this page.
 * • Redirects to login.html immediately if ANY check fails.
 * • Auto-refreshes the expiry timer on user activity (debounced).
 * • Exposes window.checkAuth, window.getSession, window.logoutUser,
 *   window.refreshSession for use anywhere on the page.
 *
 * SESSION FIELDS (written by login.html, read here)
 * ─────────────────────────────────────────
 *   id        — username string (required — used as primary identity)
 *   username  — same as id
 *   name      — display name (may equal username)
 *   role      — one of: reception | technologist | supervisor | admin | patient
 *   token     — DB session token (x-lis-token header) for RLS validation
 *   loginAt   — timestamp when session was created
 *   expiresAt — timestamp when session expires (loginAt + 4 hours)
 *
 * SUPABASE CLIENT
 * ─────────────────────────────────────────
 * Use window.buildAuthClient(SUPABASE_URL, SUPABASE_ANON_KEY) on every
 * protected page instead of createClient() directly. It automatically
 * injects the x-lis-token header so all DB requests pass RLS checks.
 *
 * ═══════════════════════════════════════════════════════════════
 */

(function () {
  'use strict';

  const LOGIN_PAGE     = 'login.html';
  const SESSION_KEY    = 'muujiza_session';
  const SESSION_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours — must match login.html

  // ── Core session reader ──────────────────────────────────────
  /**
   * Reads, parses, and validates the session from sessionStorage.
   * Returns the session object if valid, null if missing/expired/corrupt.
   */
  function getValidSession() {
    try {
      const raw = sessionStorage.getItem(SESSION_KEY);
      if (!raw) return null;

      const session = JSON.parse(raw);

      // Required fields — id (username), role, and expiry must all be present
      if (!session || !session.id || !session.role || !session.expiresAt) return null;

      // Reject expired sessions immediately and clean up
      if (Date.now() > session.expiresAt) {
        sessionStorage.removeItem(SESSION_KEY);
        return null;
      }

      return session;
    } catch {
      // Corrupt JSON or storage error — treat as no session
      sessionStorage.removeItem(SESSION_KEY);
      return null;
    }
  }

  // ── Redirect helper ──────────────────────────────────────────
  /**
   * Wipes the session and sends the user to the login page.
   * reason is only logged in development (not shown to the user).
   */
  function logout(reason) {
    sessionStorage.removeItem(SESSION_KEY);
    // Electron (Windows): use IPC so main process calls win.loadFile() + win.focus().
    // Plain browser: location.replace() is fine — autofocus on the input handles focus.
    if (window.electronLIS?.send) {
      window.electronLIS.send('lis-logout');
    } else {
      window.location.replace(LOGIN_PAGE);
    }
  }

  // ── Public API ───────────────────────────────────────────────

  /**
   * checkAuth(allowedRoles)
   * ────────────────────────
   * Call once at the top of every protected page's script block.
   * Redirects to login if the session is missing, expired, or the
   * user's role is not in allowedRoles.
   *
   * @param  {string[]} allowedRoles  e.g. ['supervisor', 'admin']
   * @returns {object|null}           Session object on success, null on redirect
   */
  window.checkAuth = function (allowedRoles) {
    if (!Array.isArray(allowedRoles) || allowedRoles.length === 0) {
      logout('checkAuth called without allowedRoles');
      return null;
    }

    const session = getValidSession();

    if (!session) {
      logout('No valid session');
      return null;
    }

    if (!allowedRoles.includes(session.role)) {
      logout(`Role "${session.role}" not permitted here`);
      return null;
    }

    return session;
  };

  /**
   * getSession()
   * ────────────
   * Returns the current session without redirecting.
   * Useful for reading the username or role on any page.
   * Returns null if there is no valid session.
   */
  window.getSession = function () {
    return getValidSession();
  };

  /**
   * logoutUser()
   * ────────────
   * Call from any "Sign Out" button.
   * Wipes the session and redirects to login.
   */
  window.logoutUser = function () {
    logout('User requested logout');
  };

  /**
   * refreshSession()
   * ────────────────
   * Extends the session expiry by another SESSION_TTL_MS from now.
   * Called automatically on user activity — no need to call manually.
   */
  window.refreshSession = function () {
    const session = getValidSession();
    if (!session) return; // already expired — don't create a ghost session
    session.expiresAt = Date.now() + SESSION_TTL_MS;
    try {
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
    } catch {}
  };

  /**
   * buildAuthClient(url, anonKey)
   * ──────────────────────────────
   * Creates a Supabase client pre-configured with the x-lis-token header
   * from the current session. Use this on EVERY protected page instead of
   * calling window.supabase.createClient() directly.
   *
   * If window.supabase is not yet loaded this throws — ensure the Supabase
   * CDN script appears before auth-guard.js in <head>.
   *
   * @param  {string} url      Supabase project URL
   * @param  {string} anonKey  Supabase anon/public key
   * @returns {SupabaseClient}
   */
  window.buildAuthClient = function (url, anonKey) {
    const session = getValidSession();
    const token   = session && session.token ? session.token : '';
    return window.supabase.createClient(url, anonKey, {
      global: {
        headers: { 'x-lis-token': token }
      }
    });
  };

  // ── Auto-refresh on user activity ───────────────────────────
  // Debounced: the refresh only fires after 10 seconds of inactivity
  // following an event, so rapid typing doesn't hammer sessionStorage.
  let refreshDebounce = null;
  ['click', 'keydown', 'mousemove', 'touchstart'].forEach(evt => {
    document.addEventListener(evt, function () {
      clearTimeout(refreshDebounce);
      refreshDebounce = setTimeout(window.refreshSession, 10_000);
    }, { passive: true });
  });

})();
