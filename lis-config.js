/**
 * lis-config.js
 * ─────────────────────────────────────────────────────────────
 * SINGLE SOURCE OF TRUTH for all LIS configuration.
 * Include this file FIRST in every HTML page:
 *   <script src="lis-config.js"></script>
 *
 * To rotate keys or move to a new Supabase project:
 * Change values HERE only — all pages update automatically.
 * ─────────────────────────────────────────────────────────────
 */

window.LIS_CONFIG = {

    // ── Supabase ────────────────────────────────────────────────
    SUPABASE_URL:      'https://avdotxgndobwrwgqjzcj.supabase.co',
    SUPABASE_ANON_KEY: 'sb_publishable_QfUB_6lH0HTW48gTmYgyQw_nWjGdmst',

    // ── Edge Functions ──────────────────────────────────────────
    SUBS_FUNCTION_URL: 'https://avdotxgndobwrwgqjzcj.supabase.co/functions/v1/LIS-SUBS',

    // ── Lab Identity ────────────────────────────────────────────
    LAB_NAME:    'A.B DAWANAU MEDICAL LABORATORY SERVICES',
    LAB_ADDRESS: 'MARKET STREET, 3RD AVENUE, GWARINPA',
    LAB_PHONE:   '08160040909',

    // ── Subscription Plans ──────────────────────────────────────
    PLANS: {
        monthly: { price: 21500,  days: 30,  label: 'Monthly' },
        yearly:  { price: 203000, days: 365, label: 'Yearly'  },
    },

};

// ── Convenience aliases ───────────────────────────────────────
window._supabaseUrl  = window.LIS_CONFIG.SUPABASE_URL;
window._supabaseKey  = window.LIS_CONFIG.SUPABASE_ANON_KEY;
window._labName      = window.LIS_CONFIG.LAB_NAME;
window._labAddress   = window.LIS_CONFIG.LAB_ADDRESS;
window._labPhone     = window.LIS_CONFIG.LAB_PHONE;

console.log('[LIS] Config loaded for:', window.LIS_CONFIG.LAB_NAME);
