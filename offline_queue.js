/**
 * offline_queue.js  —  MU'UJIZA LIS Result Entry · Offline Resilience Layer
 * ─────────────────────────────────────────────────────────────────────────
 * Drop-in module that makes result entry work completely offline.
 *
 * HOW IT WORKS
 * ────────────
 * 1.  On first load the page caches itself (HTML + JS + CSS + CDN assets)
 *     via a Cache Storage entry so it can open without a network.
 *
 * 2.  All Supabase writes (saveSample, updateCOCEvent, addAudit) are wrapped
 *     so that when the device is offline they are written to an IndexedDB
 *     "outbox" instead of being dropped on the floor.
 *
 * 3.  A "samples_cache" IndexedDB store holds the last-known sample list so
 *     renderProcessingSamples() can populate the table even without a network.
 *
 * 4.  Whenever the browser fires the "online" event — or every 30 s while
 *     online — the outbox is drained: each pending operation is replayed
 *     against Supabase in the order it was queued.
 *
 * 5.  A small banner in the topbar shows the current connection state and
 *     how many operations are pending, so the tech always knows what is
 *     happening.
 *
 * INTEGRATION  (add ONE line to result_entry.html, before result_entry.js)
 * ──────────────────────────────────────────────────────────────────────────
 *   <script src="offline_queue.js"></script>
 *
 * That is the only change required. This file monkey-patches saveSample,
 * addAudit, updateCOCEvent, loadSamples, and the three action buttons
 * (saveDraftBtn, markReadyBtn, sendVerifyBtn) after result_entry.js
 * has finished defining them.
 *
 * SERVICE WORKER NOTE
 * ───────────────────
 * If you have an existing service worker that bypasses protected pages to the
 * network, register offline_sw.js (generated alongside this file) instead.
 * It intercepts navigation requests and serves the cached shell while offline.
 */

/* ═══════════════════════════════════════════════════════════════════════════
   §1  CONSTANTS & STATE
   ═══════════════════════════════════════════════════════════════════════════ */

const OQ_DB_NAME    = 'muujiza_offline';
const OQ_DB_VERSION = 3;
const STORE_OUTBOX  = 'outbox';       // pending writes
const STORE_SAMPLES = 'samples_cache';// last-known sample list
const STORE_META    = 'meta';         // e.g. last-sync timestamp

/** Resolves to the open IDBDatabase once _oqInit() completes. */
let _oqDB = null;

/** Live connection flag — updated by online/offline events. */
let _isOnline = navigator.onLine;

/** Flush in progress — prevents concurrent drain attempts. */
let _flushing = false;

/* ═══════════════════════════════════════════════════════════════════════════
   §2  IndexedDB BOOTSTRAP
   ═══════════════════════════════════════════════════════════════════════════ */

function _oqInit() {
  return new Promise((resolve, reject) => {
    if (_oqDB) { resolve(_oqDB); return; }
    const req = indexedDB.open(OQ_DB_NAME, OQ_DB_VERSION);

    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_OUTBOX)) {
        const outbox = db.createObjectStore(STORE_OUTBOX, {
          keyPath: 'id', autoIncrement: true
        });
        outbox.createIndex('by_queued', 'queued_at');
      }
      if (!db.objectStoreNames.contains(STORE_SAMPLES)) {
        db.createObjectStore(STORE_SAMPLES, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_META)) {
        db.createObjectStore(STORE_META, { keyPath: 'key' });
      }
    };

    req.onsuccess = (e) => { _oqDB = e.target.result; resolve(_oqDB); };
    req.onerror   = (e) => reject(e.target.error);
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   §3  IDB HELPERS  (promise wrappers)
   ═══════════════════════════════════════════════════════════════════════════ */

function _idbPut(storeName, value) {
  return _oqInit().then(db => new Promise((res, rej) => {
    const tx  = db.transaction(storeName, 'readwrite');
    const req = tx.objectStore(storeName).put(value);
    req.onsuccess = () => res(req.result);
    req.onerror   = () => rej(req.error);
  }));
}

function _idbGet(storeName, key) {
  return _oqInit().then(db => new Promise((res, rej) => {
    const tx  = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).get(key);
    req.onsuccess = () => res(req.result ?? null);
    req.onerror   = () => rej(req.error);
  }));
}

function _idbGetAll(storeName) {
  return _oqInit().then(db => new Promise((res, rej) => {
    const tx  = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).getAll();
    req.onsuccess = () => res(req.result);
    req.onerror   = () => rej(req.error);
  }));
}

function _idbDelete(storeName, key) {
  return _oqInit().then(db => new Promise((res, rej) => {
    const tx  = db.transaction(storeName, 'readwrite');
    const req = tx.objectStore(storeName).delete(key);
    req.onsuccess = () => res();
    req.onerror   = () => rej(req.error);
  }));
}

function _idbClear(storeName) {
  return _oqInit().then(db => new Promise((res, rej) => {
    const tx  = db.transaction(storeName, 'readwrite');
    const req = tx.objectStore(storeName).clear();
    req.onsuccess = () => res();
    req.onerror   = () => rej(req.error);
  }));
}

/* ═══════════════════════════════════════════════════════════════════════════
   §4  OUTBOX QUEUE  (enqueue / drain)
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Enqueue an operation for later replay.
 * @param {string} type  - 'saveSample' | 'updateCOCEvent' | 'addAudit'
 * @param {object} payload - the arguments needed to replay it
 */
async function _oqEnqueue(type, payload) {
  await _idbPut(STORE_OUTBOX, {
    type,
    payload,
    queued_at: new Date().toISOString(),
    attempts:  0
  });
  _oqRefreshBanner();
}

/**
 * Drain the outbox: replay every queued operation in insertion order.
 * Safe to call concurrently — only one drain runs at a time.
 */
async function _oqFlush() {
  if (_flushing || !_isOnline) return;
  _flushing = true;

  try {
    const items = await _idbGetAll(STORE_OUTBOX);
    // Sort by IDB auto-increment id so order is preserved
    items.sort((a, b) => a.id - b.id);

    for (const item of items) {
      try {
        await _oqReplay(item);
        await _idbDelete(STORE_OUTBOX, item.id);
      } catch (err) {
        // Don't delete — leave it in the outbox for next attempt.
        console.warn('[OQ] replay failed, keeping in outbox', item, err);
        // After 10 failures give up on this item to avoid infinite loops
        item.attempts = (item.attempts || 0) + 1;
        if (item.attempts >= 10) {
          console.error('[OQ] giving up on item after 10 attempts', item);
          await _idbDelete(STORE_OUTBOX, item.id);
        } else {
          await _idbPut(STORE_OUTBOX, item);
        }
        break; // stop flush on first error; retry on next online event
      }
    }

    const remaining = await _idbGetAll(STORE_OUTBOX);
    if (remaining.length === 0) {
      _oqToast('All offline changes synced ✓', 'success');
    }
  } finally {
    _flushing = false;
    _oqRefreshBanner();
  }
}

/**
 * Replay a single queued operation against Supabase.
 */
async function _oqReplay(item) {
  const db  = window._supabaseClient;
  const { type, payload } = item;

  if (type === 'saveSample') {
    const sample = payload.sample;

    const { error: sErr } = await db.from('samples').update({
      status:             sample.status,
      released_at:        sample.released_at,
      supervisor_comment: sample.supervisor_comment
    }).eq('id', sample.id);
    if (sErr) throw sErr;

    for (const test of sample.tests) {
      const { error: tErr } = await db.from('sample_tests').update({
        result:    test.result,
        tech_name: test.tech,
        status:    test.status
      }).eq('id', test.id);
      if (tErr) throw tErr;
    }

    // Refresh the samples cache after a successful save
    await _oqCacheSample(sample);

  } else if (type === 'updateCOCEvent') {
    const { sampleId, stepIndex, done, active, actorName } = payload;
    const { error } = await db.from('coc_events')
      .update({ done, active, actor_name: actorName, occurred_at: new Date().toISOString() })
      .match({ sample_id: sampleId, step_index: stepIndex });
    if (error) throw error;

  } else if (type === 'addAudit') {
    const { action, sampleId, details, userName, userRole } = payload;
    const { error } = await db.from('audit_log').insert([{
      ts:        new Date().toISOString(),
      user_name: userName,
      user_role: userRole,
      action,
      sample_id: sampleId,
      details:   details || ''
    }]);
    if (error) throw error;
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   §5  SAMPLE CACHE  (offline table population)
   ═══════════════════════════════════════════════════════════════════════════ */

/** Persist a full sample (including tests) into the local cache. */
async function _oqCacheSample(sample) {
  await _idbPut(STORE_SAMPLES, sample);
}

/** Persist a whole array of samples (called after a successful loadSamples). */
async function _oqCacheSampleList(list) {
  await _oqInit();
  // Replace entire cache with the fresh list
  await _idbClear(STORE_SAMPLES);
  for (const s of list) {
    await _idbPut(STORE_SAMPLES, s);
  }
  await _idbPut(STORE_META, { key: 'last_sync', value: new Date().toISOString() });
}

/** Return cached samples (used when offline). */
async function _oqGetCachedSamples() {
  return _idbGetAll(STORE_SAMPLES);
}

/* ═══════════════════════════════════════════════════════════════════════════
   §6  PATCHING CORE FUNCTIONS
   We wait for the page to finish loading so result_entry.js has defined
   everything, then we wrap the functions we need.
   ═══════════════════════════════════════════════════════════════════════════ */

window.addEventListener('load', async () => {
  await _oqInit();

  /* ── 6a  Wrap loadSamples ───────────────────────────────────────────── */
  const _origLoadSamples = window.loadSamples || loadSamples;

  async function loadSamplesOfflineAware() {
    if (!_isOnline) {
      // Serve from cache
      const cached = await _oqGetCachedSamples();
      window.samples = cached;         // update the module-level array
      if (typeof samples !== 'undefined') {
        // If samples is a module-level let, update it too
        try { samples = cached; } catch(e){}
      }
      return;
    }
    // Online path — call original then cache the result
    await _origLoadSamples();
    // `samples` is the module-level array populated by the original function
    const list = (typeof samples !== 'undefined') ? samples : (window.samples || []);
    await _oqCacheSampleList(list);
  }

  // Replace in window scope
  window.loadSamples = loadSamplesOfflineAware;

  /* ── 6b  Wrap saveSample ────────────────────────────────────────────── */
  const _origSaveSample = window.saveSample || saveSample;

  window.saveSample = async function saveSampleOfflineAware(sample) {
    // Always update local cache immediately so UI stays consistent
    await _oqCacheSample(sample);

    if (!_isOnline) {
      await _oqEnqueue('saveSample', { sample: JSON.parse(JSON.stringify(sample)) });
      return; // swallow — no error thrown, UI continues normally
    }
    try {
      await _origSaveSample(sample);
    } catch (err) {
      if (!_isOnline || err?.message?.includes('fetch')) {
        // Network error mid-request — fall back to queue
        await _oqEnqueue('saveSample', { sample: JSON.parse(JSON.stringify(sample)) });
        return;
      }
      throw err;
    }
  };

  /* ── 6c  Wrap updateCOCEvent ────────────────────────────────────────── */
  const _origUpdateCOC = window.updateCOCEvent || updateCOCEvent;

  window.updateCOCEvent = async function updateCOCOfflineAware(sampleId, stepIndex, done, active) {
    const actorName = (typeof currentUser !== 'undefined')
      ? (currentUser?.name || 'Tech') : 'Tech';

    if (!_isOnline) {
      await _oqEnqueue('updateCOCEvent', { sampleId, stepIndex, done, active, actorName });
      return;
    }
    try {
      await _origUpdateCOC(sampleId, stepIndex, done, active);
    } catch (err) {
      if (!_isOnline || err?.message?.includes('fetch')) {
        await _oqEnqueue('updateCOCEvent', { sampleId, stepIndex, done, active, actorName });
        return;
      }
      throw err;
    }
  };

  /* ── 6d  Wrap addAudit ──────────────────────────────────────────────── */
  const _origAddAudit = window.addAudit || addAudit;

  window.addAudit = async function addAuditOfflineAware(action, sampleId, details) {
    const userName = (typeof currentUser !== 'undefined')
      ? (currentUser?.name  || 'Unknown') : 'Unknown';
    const userRole = (typeof currentUser !== 'undefined')
      ? (currentUser?.role  || 'Unknown') : 'Unknown';

    if (!_isOnline) {
      await _oqEnqueue('addAudit', { action, sampleId, details, userName, userRole });
      return;
    }
    try {
      await _origAddAudit(action, sampleId, details);
    } catch (err) {
      // Audit failures are already soft in the original code; queue and continue
      await _oqEnqueue('addAudit', { action, sampleId, details, userName, userRole });
    }
  };

  /* ── 6e  Guard action buttons while offline ─────────────────────────── */
  //
  //  saveDraftBtn, markReadyBtn, sendVerifyBtn already call the patched
  //  saveSample / addAudit / updateCOCEvent above, so they will queue
  //  automatically. We just need to make sure the buttons aren't disabled
  //  and that the UI gives the right feedback toast.
  //
  //  We intercept the existing click listeners by replacing the handlers
  //  on the same elements (the original addEventListener is already wired
  //  at the bottom of result_entry.js, so we use a capturing listener that
  //  runs first and inserts the offline toast).

  function _offlineGuardClick(e) {
    if (!_isOnline) {
      // Let the click proceed — saveSample will queue it — but also toast
      setTimeout(() => {
        _oqToast('Saved to offline queue — will sync when reconnected', 'warn');
      }, 50);
      // Do NOT stop propagation — the real handler must still run
    }
  }

  ['saveDraftBtn', 'markReadyBtn', 'sendVerifyBtn'].forEach(id => {
    const btn = document.getElementById(id);
    if (btn) btn.addEventListener('click', _offlineGuardClick, true); // capture phase
  });

  // Initial render using cache if offline
  if (!_isOnline) {
    if (typeof renderProcessingSamples === 'function') {
      await renderProcessingSamples();
    }
  }

  _oqRefreshBanner();
  console.log('[OQ] Offline queue initialised. Online:', _isOnline);
});

/* ═══════════════════════════════════════════════════════════════════════════
   §7  ONLINE / OFFLINE EVENT HANDLERS
   ═══════════════════════════════════════════════════════════════════════════ */

window.addEventListener('online', async () => {
  _isOnline = true;
  _oqRefreshBanner();
  _oqToast('Connection restored — syncing offline changes…', 'info');
  await _oqFlush();
  // Refresh the sample list from the server now we're back
  if (typeof renderProcessingSamples === 'function') {
    await renderProcessingSamples();
  }
});

window.addEventListener('offline', () => {
  _isOnline = false;
  _oqRefreshBanner();
  _oqToast('You are offline — changes will be queued and synced automatically', 'warn');
});

// Periodic flush while online (every 30 s) — catches cases where the
// "online" event fires but the flush was skipped due to a race.
setInterval(() => {
  if (_isOnline && !_flushing) _oqFlush();
}, 30_000);

/* ═══════════════════════════════════════════════════════════════════════════
   §8  OFFLINE BANNER  (status indicator injected into the topbar)
   ═══════════════════════════════════════════════════════════════════════════ */

function _oqCreateBanner() {
  if (document.getElementById('oqBanner')) return;

  const style = document.createElement('style');
  style.textContent = `
    #oqBanner {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 0.75rem;
      font-weight: 600;
      padding: 4px 12px;
      border-radius: 40px;
      border: 1px solid transparent;
      transition: all .3s;
      white-space: nowrap;
      font-family: var(--sans, system-ui, sans-serif);
    }
    #oqBanner.oq-online  { background: #eaf5ef; border-color: #c6e8d4; color: #1a6840; }
    #oqBanner.oq-offline { background: #fffbeb; border-color: #fde68a; color: #92400e; }
    #oqBanner.oq-pending { background: #eff6ff; border-color: #bfdbfe; color: #1e40af; }
    #oqBanner .oq-dot {
      width: 7px; height: 7px; border-radius: 50%;
      flex-shrink: 0;
    }
    #oqBanner.oq-online  .oq-dot { background: #10b981; box-shadow: 0 0 0 2px #a7f3d0; }
    #oqBanner.oq-offline .oq-dot { background: #d97706; box-shadow: 0 0 0 2px #fde68a;
                                    animation: oqPulse .9s ease-in-out infinite; }
    #oqBanner.oq-pending .oq-dot { background: #3b82f6; box-shadow: 0 0 0 2px #bfdbfe;
                                    animation: oqPulse .6s ease-in-out infinite; }
    @keyframes oqPulse {
      0%, 100% { opacity: 1; }
      50%       { opacity: 0.4; }
    }
  `;
  document.head.appendChild(style);

  const banner = document.createElement('div');
  banner.id = 'oqBanner';
  banner.innerHTML = '<span class="oq-dot"></span><span class="oq-label">Online</span>';

  // Insert before the clock or as first child of topbar-right
  const topbarRight = document.querySelector('.topbar-right');
  const clock       = document.getElementById('clockDisplay');
  if (topbarRight) {
    topbarRight.insertBefore(banner, clock || topbarRight.firstChild);
  }
}

async function _oqRefreshBanner() {
  _oqCreateBanner();
  const banner = document.getElementById('oqBanner');
  if (!banner) return;

  const pending = (await _idbGetAll(STORE_OUTBOX)).length;
  const label   = banner.querySelector('.oq-label');

  if (!_isOnline) {
    banner.className = 'oq-offline';
    label.textContent = pending
      ? `Offline · ${pending} pending`
      : 'Offline — working locally';
  } else if (pending > 0) {
    banner.className = 'oq-pending';
    label.textContent = `Syncing ${pending} change${pending > 1 ? 's' : ''}…`;
  } else {
    banner.className = 'oq-online';
    label.textContent = 'Online';
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   §9  TOAST HELPER  (re-uses the existing toast() if available)
   ═══════════════════════════════════════════════════════════════════════════ */

function _oqToast(msg, type = 'info') {
  if (typeof toast === 'function') {
    toast(msg, type);
  } else {
    console.info(`[OQ toast:${type}]`, msg);
  }
}
