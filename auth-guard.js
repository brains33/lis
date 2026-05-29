/**
 * auth-guard.js — MU'UJIZA LIS
 * ─────────────────────────────────────────────────────────
 * Include this script at the TOP of every protected page:
 *
 *   <script src="auth-guard.js"></script>
 *
 * Then call checkAuth(['allowed_role', ...]) immediately.
 * The page should be invisible (display:none or opacity:0)
 * until checkAuth resolves, to prevent a flash of content.
 *
 * Example — accession.html (reception only):
 *   checkAuth(['reception']);
 *
 * Example — management.html (supervisor + admin):
 *   checkAuth(['supervisor', 'admin']);
 *
 * The function redirects to login.html and wipes the session
 * if ANY check fails. It never throws — it always redirects.
 * ─────────────────────────────────────────────────────────
 */

(function () {
  'use strict';

  const LOGIN_PAGE     = 'login.html';
  const SESSION_KEY    = 'muujiza_session';
  const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // must match login.html

  /**
   * Reads and validates the session stored by login.html.
   * Returns the session object if valid, null otherwise.
   */
  function getValidSession() {
    try {
      const raw = sessionStorage.getItem(SESSION_KEY);
      if (!raw) return null;

      const session = JSON.parse(raw);

      // Must have required fields
      if (!session?.id || !session?.role || !session?.expiresAt) return null;

      // Must not be expired
      if (Date.now() > session.expiresAt) {
        sessionStorage.removeItem(SESSION_KEY);
        return null;
      }

      return session;
    } catch {
      return null;
    }
  }

  /**
   * Wipe session and redirect to login.
   * `reason` is logged to console (dev visibility only).
   */
  function logout(reason) {
    console.warn('[Auth] Redirecting to login:', reason);
    sessionStorage.removeItem(SESSION_KEY);

    // Also sign out of Supabase Auth if the client is available
    if (window.supabase && window._supabaseClient) {
      window._supabaseClient.auth.signOut().catch(() => {});
    }

    window.location.replace(LOGIN_PAGE);
  }

  /**
   * Main guard function. Call once at the top of every protected page.
   *
   * @param {string[]} allowedRoles  Roles permitted to see this page.
   * @returns {object}               The session object (for use on the page).
   */
  window.checkAuth = function (allowedRoles) {
    if (!Array.isArray(allowedRoles) || allowedRoles.length === 0) {
      logout('checkAuth called without allowedRoles');
      return null;
    }

    const session = getValidSession();

    if (!session) {
      logout('No valid session found');
      return null;
    }

    // Role must be in the allowed list for THIS page
    if (!allowedRoles.includes(session.role)) {
      logout(`Role "${session.role}" not allowed on this page (allowed: ${allowedRoles.join(', ')})`);
      return null;
    }

    return session;
  };

  /**
   * Returns the current session without redirecting.
   * Useful for reading username / display name on a page.
   */
  window.getSession = function () {
    return getValidSession();
  };

  /**
   * Manually log out from any page (e.g. a "Sign Out" button).
   */
  window.logoutUser = function () {
    logout('User requested logout');
  };

  /**
   * Refresh the session expiry (call periodically on active pages).
   */
  window.refreshSession = function () {
    const session = getValidSession();
    if (!session) return;
    session.expiresAt = Date.now() + SESSION_TTL_MS;
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
  };

  // ── Auto-refresh on user activity ───────────────────────
  // Reset expiry timer whenever the user interacts with the page.
  let refreshDebounce = null;
  ['click', 'keydown', 'mousemove', 'touchstart'].forEach(evt => {
    document.addEventListener(evt, () => {
      clearTimeout(refreshDebounce);
      refreshDebounce = setTimeout(window.refreshSession, 10_000); // debounce 10s
    }, { passive: true });
  });

})();
