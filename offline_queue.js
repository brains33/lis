/**
 * offline_queue.js  —  MU'UJIZA LIS · Offline Resilience (LOAD-FIXED)
 * PATCHES ONLY: saveSample, updateCOCEvent, addAudit
 * DOES NOT PATCH loadSamples → original result_entry.js loadSamples runs untouched.
 */

/* ═══════════════════════════════════════════════════════════════════════════
   §1  CONSTANTS & STATE
   ═══════════════════════════════════════════════════════════════════════════ */

const OQ_DB_NAME         = 'muujiza_offline';
const OQ_DB_VERSION      = 9;                    // bumped: added portal_cache + portal_rejected
const STORE_OUTBOX       = 'outbox';
const STORE_SAMPLES      = 'samples_cache';
const STORE_META         = 'meta';
const STORE_TESTDEF      = 'test_definitions';
const STORE_REJECTED     = 'rejected_groups';     // accession rejected panel cache
const STORE_PENDING      = 'pending_samples';
const STORE_PORTAL_CACHE = 'portal_cache';        // pending_portal released samples
const STORE_PORTAL_REJ   = 'portal_rejected';     // pending_portal rejected groups

let _oqDB = null;
let _isOnline = navigator.onLine;
let _flushing = false;

// Expose OFFLINE globally so result_entry.js and other scripts can read it.
// Uses a getter so it always reflects the live _isOnline state.
Object.defineProperty(window, 'OFFLINE', {
  get: () => !_isOnline,
  configurable: true
});

// Expose OQ's own reliable online flag — more trustworthy than navigator.onLine
// because it's set synchronously on the 'online'/'offline' events.
Object.defineProperty(window, '_oqIsOnline', {
  get: () => _isOnline,
  configurable: true
});

/* ═══════════════════════════════════════════════════════════════════════════
   §2  IndexedDB BOOTSTRAP (unchanged)
   ═══════════════════════════════════════════════════════════════════════════ */

function _oqInit() {
  return new Promise((resolve, reject) => {
    if (_oqDB) { resolve(_oqDB); return; }
    const req = indexedDB.open(OQ_DB_NAME, OQ_DB_VERSION);

    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_OUTBOX)) {
        const outbox = db.createObjectStore(STORE_OUTBOX, { keyPath: 'id', autoIncrement: true });
        outbox.createIndex('by_queued', 'queued_at');
      }
      if (!db.objectStoreNames.contains(STORE_SAMPLES)) db.createObjectStore(STORE_SAMPLES, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(STORE_META)) db.createObjectStore(STORE_META, { keyPath: 'key' });
      if (!db.objectStoreNames.contains(STORE_TESTDEF)) db.createObjectStore(STORE_TESTDEF, { keyPath: 'id', autoIncrement: true });
      if (!db.objectStoreNames.contains(STORE_REJECTED)) db.createObjectStore(STORE_REJECTED, { keyPath: 'key' });
      if (!db.objectStoreNames.contains(STORE_PENDING)) db.createObjectStore(STORE_PENDING, { keyPath: 'offline_ref' });
      if (!db.objectStoreNames.contains(STORE_PORTAL_CACHE)) db.createObjectStore(STORE_PORTAL_CACHE, { keyPath: 'key' });
      if (!db.objectStoreNames.contains(STORE_PORTAL_REJ)) db.createObjectStore(STORE_PORTAL_REJ, { keyPath: 'key' });
    };

    req.onsuccess = (e) => {
      _oqDB = e.target.result;

      // ── Health check — verify we can actually read/write ─────────────────
      // A corrupted or partially-upgraded DB can open successfully but fail
      // on the first real transaction. Catch it here so callers get a clear
      // error instead of a silent queue that never saves anything.
      const healthTx = _oqDB.transaction(STORE_META, 'readwrite');
      const healthReq = healthTx.objectStore(STORE_META).put({
        key: '_healthcheck', value: Date.now()
      });
      healthReq.onsuccess = () => resolve(_oqDB);
      healthReq.onerror = (ev) => {
        console.error('[OQ] IndexedDB health check FAILED — queue degraded', ev.target.error);
        // Mark queue as degraded so banner reflects it
        window._oqDegraded = true;
        // Still resolve so the rest of the app doesn't break —
        // individual operations will fail gracefully and fall through to online path
        resolve(_oqDB);
      };
      // ─────────────────────────────────────────────────────────────────────
    };

    req.onerror   = (e) => reject(e.target.error);
    req.onblocked = (e) => {
      console.warn('[OQ] IndexedDB open blocked — another tab may be holding an older version open');
    };
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   §3  GENERIC IDB HELPERS (safe: always return array)
   ═══════════════════════════════════════════════════════════════════════════ */

async function _idbPut(storeName, value) {
  const db = await _oqInit();
  return new Promise((res, rej) => {
    const tx = db.transaction(storeName, 'readwrite');
    const req = tx.objectStore(storeName).put(value);
    req.onsuccess = () => res(req.result);
    req.onerror   = () => rej(req.error);
  });
}

async function _idbGet(storeName, key) {
  const db = await _oqInit();
  return new Promise((res, rej) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).get(key);
    req.onsuccess = () => res(req.result ?? null);
    req.onerror   = () => rej(req.error);
  });
}

async function _idbGetAll(storeName) {
  const db = await _oqInit();
  return new Promise((res, rej) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).getAll();
    req.onsuccess = () => res(req.result || []);
    req.onerror   = () => rej(req.error);
  });
}

async function _idbDelete(storeName, key) {
  const db = await _oqInit();
  return new Promise((res, rej) => {
    const tx = db.transaction(storeName, 'readwrite');
    const req = tx.objectStore(storeName).delete(key);
    req.onsuccess = () => res();
    req.onerror   = () => rej(req.error);
  });
}

async function _idbClear(storeName) {
  const db = await _oqInit();
  return new Promise((res, rej) => {
    const tx = db.transaction(storeName, 'readwrite');
    const req = tx.objectStore(storeName).clear();
    req.onsuccess = () => res();
    req.onerror   = () => rej(req.error);
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   §4  OUTBOX QUEUE (enqueue / flush)
   ═══════════════════════════════════════════════════════════════════════════ */

async function _oqEnqueue(type, payload) {
  await _idbPut(STORE_OUTBOX, {
    type, payload,
    queued_at: new Date().toISOString(),
    attempts: 0
  });
  _oqRefreshBanner();
}

async function _oqFlush() {
  if (_flushing || !_isOnline) return;
  _flushing = true;

  try {
    const items = await _idbGetAll(STORE_OUTBOX);
    items.sort((a, b) => a.id - b.id);

    // Track which offline sample refs failed this pass so dependent items
    // (rejectTest, saveSample, sendToVerify) can be skipped without consuming
    // attempts — they'll succeed once their registerSample has synced.
    const failedOfflineRefs = new Set();

    for (const item of items) {
      const p = item.payload || {};
      const refId = p.sampleId || (p.sample && p.sample.id) || '';
      const isOfflineRef = typeof refId === 'string' && refId.startsWith('OFFLINE-');

      // If a prior item for the same offline sample already failed this pass,
      // skip without incrementing attempts — it's a dependency issue, not a real error.
      if (isOfflineRef && failedOfflineRefs.has(refId)) continue;

      try {
        await _oqReplay(item);
        await _idbDelete(STORE_OUTBOX, item.id);
      } catch (err) {
        const errMsg = err?.message || err?.code || (err && typeof err === 'object' ? JSON.stringify(err) : String(err));
        console.warn('[OQ] replay failed, keeping in outbox', item, errMsg, err);
        item.attempts = (item.attempts || 0) + 1;
        if (item.attempts >= 10) {
          console.error('[OQ] giving up on item after 10 attempts', item);
          await _idbDelete(STORE_OUTBOX, item.id);
        } else {
          await _idbPut(STORE_OUTBOX, item);
          // Track the failed ref so dependent items are skipped this pass
          if (isOfflineRef) failedOfflineRefs.add(refId);
          // If registerSample itself failed, track its offlineRef too
          if (item.type === 'registerSample' && p.offlineRef) {
            failedOfflineRefs.add(`OFFLINE-${p.offlineRef}`);
          }
        }
        // Don't break — continue trying other independent items
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

// Called after any rejection/resolution syncs to mark cached rejected groups as stale.
// Accession and pending_portal will re-fetch on next load.
async function _oqInvalidateRejectedCaches() {
  for (const store of [STORE_REJECTED, STORE_PORTAL_REJ]) {
    try {
      const entry = await _idbGet(store, 'list');
      if (entry) {
        // Set a stale flag so loadRejectedSamples knows to re-fetch
        await _idbPut(store, { ...entry, stale: true });
      }
    } catch(e) { /* silent */ }
  }
}

async function _oqReplay(item) {
  // Reuse the existing authenticated client — do NOT call buildAuthClient on every
  // replay as that creates a new GoTrueClient instance each time (triggers warning
  // and undefined behaviour). Only fall back to rebuilding if the client is missing.
  const db = window._supabaseClient || window.db;
  if (!db) throw new Error('No Supabase client available for replay');

  const { type, payload } = item;

  if (type === 'saveSample') {
    const sample = payload.sample;
    // If still OFFLINE-, registerSample hasn't run yet — defer so it retries after
    if (!sample.id || String(sample.id).startsWith('OFFLINE-')) {
      throw new Error('Sample not yet synced — deferring saveSample replay');
    }
    if (sample.id && !String(sample.id).startsWith('OFFLINE-')) {
      await db.from('samples').update({
        status: sample.status,
        released_at: sample.released_at,
        supervisor_comment: sample.supervisor_comment
      }).eq('id', sample.id);
      for (const test of sample.tests) {
        if (test.id) {
          // Happy path: real test id known
          await db.from('sample_tests').update({
            result: test.result,
            tech_name: test.tech,
            status: test.status,
            rejection_reason: test.rejection_reason || null
          }).eq('id', test.id);
        } else if (test.test_name && sample.id) {
          // Fallback: outbox item was queued before test ids were known —
          // match by sample_id + test_name instead.
          await db.from('sample_tests').update({
            result: test.result,
            tech_name: test.tech,
            status: test.status,
            rejection_reason: test.rejection_reason || null
          }).eq('sample_id', sample.id).eq('test_name', test.test_name);
        }
      }
    }
    await _oqCacheSample(sample);
    return;
  }

  if (type === 'rejectSample') {
    const { sampleId, reason, userName, userRole } = payload;
    if (!sampleId || String(sampleId).startsWith('OFFLINE-')) {
      throw new Error('Sample not yet synced — deferring rejectSample replay');
    }
    await db.from('samples')
      .update({ status: 'Rejected', rejection_reason: reason })
      .eq('id', sampleId);
    // Also mark all tests on this sample as Rejected so they show in the accession rejection panel
    await db.from('sample_tests')
      .update({ status: 'Rejected', rejection_reason: reason })
      .eq('sample_id', sampleId);
    await db.from('sample_timeline').insert([{
      sample_id: sampleId,
      event_type: 'Sample Rejected',
      event_description: reason,
      performed_by: userName,
      performed_role: userRole,
      created_at: new Date().toISOString()
    }]).catch(e => console.warn('[OQ] sample_timeline insert skipped:', e?.message || e));

    await db.from('audit_log').insert([{
      ts: new Date().toISOString(), user_name: userName, user_role: userRole,
      action: 'Sample Rejected', sample_id: sampleId, details: reason
    }]).catch(e => console.warn('[OQ] audit_log insert skipped:', e?.message || e));

    // Invalidate cached rejected groups so next load reflects this rejection
    await _oqInvalidateRejectedCaches();
    return;
  }

  if (type === 'rejectTest') {
    const { sampleId, testName, reason, userName, userRole } = payload;
    if (!sampleId || String(sampleId).startsWith('OFFLINE-')) {
      throw new Error('Sample not yet synced — deferring rejectTest replay');
    }
    // Core update — must succeed
    const { error: rtErr } = await db.from('sample_tests')
      .update({ status: 'Rejected', rejection_reason: reason })
      .eq('sample_id', sampleId)
      .eq('test_name', testName);
    if (rtErr) throw new Error(`rejectTest sample_tests update failed: ${rtErr.message || rtErr.code || JSON.stringify(rtErr)}`);

    // Timeline insert — optional table, skip silently if it doesn't exist
    await db.from('sample_timeline').insert([{
      sample_id: sampleId,
      event_type: 'Test Rejected',
      event_description: `${testName}: ${reason}`,
      performed_by: userName,
      performed_role: userRole,
      created_at: new Date().toISOString()
    }]).catch(e => console.warn('[OQ] sample_timeline insert skipped:', e?.message || e));

    // Audit log — optional, skip silently if it fails
    await db.from('audit_log').insert([{
      ts: new Date().toISOString(), user_name: userName, user_role: userRole,
      action: 'Test Rejected', sample_id: sampleId,
      details: `${testName} rejected: ${reason}`
    }]).catch(e => console.warn('[OQ] audit_log insert skipped:', e?.message || e));

    // Invalidate cached rejected groups so next load reflects this rejection
    await _oqInvalidateRejectedCaches();
    return;
  }

  if (type === 'resolveTestRejection') {
    const { sampleId, testName, userName, userRole } = payload;
    if (!sampleId || String(sampleId).startsWith('OFFLINE-')) {
      throw new Error('Sample not yet synced — deferring resolveTestRejection replay');
    }
    await db.from('sample_tests')
      .update({ status: 'Processing', rejection_reason: null })
      .eq('sample_id', sampleId)
      .eq('test_name', testName);
    await db.from('audit_log').insert([{
      ts: new Date().toISOString(), user_name: userName, user_role: userRole,
      action: 'Test Rejection Resolved', sample_id: sampleId,
      details: `${testName} — rejection cleared`
    }]);
    return;
  }

  if (type === 'updateCOCEvent') {
    const { sampleId, stepIndex, done, active, actorName } = payload;
    await db.from('coc_events')
      .update({ done, active, actor_name: actorName, occurred_at: new Date().toISOString() })
      .match({ sample_id: sampleId, step_index: stepIndex });
    return;
  }

  if (type === 'addAudit') {
    const { action, sampleId, details, userName, userRole } = payload;
    await db.from('audit_log').insert([{
      ts: new Date().toISOString(),
      user_name: userName,
      user_role: userRole,
      action,
      sample_id: sampleId,
      details: details || ''
    }]);
    return;
  }

  // accession operations (keep as is)
  if (type === 'registerSample') {
    const { sampleRow, testRows, registeredBy, paystatus, offlineRef } = payload;
    const { data: sampleData, error: sErr } = await db.from('samples')
      .insert(sampleRow).select('id').single();
    if (sErr) throw sErr;
    const sampleId = sampleData.id;

    const finalReceipt = `RCP-${sampleId}-${Date.now()}`;
    await db.from('samples').update({
      receipt_no: finalReceipt,
      former_offline_ref: offlineRef || null
    }).eq('id', sampleId);

    // sample_type and tube are stored on the samples row, not per-test — strip them before insert
    const testRowsInsert = testRows.map(({ sample_type: _st, tube: _tb, ...t }) => ({ ...t, sample_id: sampleId }));
    const { data: insertedTests, error: tErr } = await db.from('sample_tests')
      .insert(testRowsInsert)
      .select('id, test_name, unit_name, status');
    if (tErr) throw tErr;

    // Build testRowsWithId using real DB-assigned IDs so downstream
    // outbox items (saveSample, rejectTest, etc.) can reference them.
    const testRowsWithId = testRowsInsert.map((t, i) => ({
      ...t,
      id: insertedTests?.[i]?.id ?? null
    }));

    const now = new Date().toISOString();
    await db.from('coc_events').insert([
      { sample_id: sampleId, step_index: 0, step_name: 'Registered', done: true, active: false,
        actor_name: registeredBy, occurred_at: now },
      { sample_id: sampleId, step_index: 1, step_name: 'Collected', done: false, active: true,
        actor_name: null, occurred_at: now }
    ]);

    await db.from('audit_log').insert([{
      ts: now, user_name: registeredBy, user_role: 'reception',
      action: 'Sample Registered', sample_id: sampleId,
      details: `${testRows.length} test(s) | Total: ${sampleRow.total_amount} NGN | Mode: ${sampleRow.pay_mode} | Status: ${paystatus}`
    }]);

    if (offlineRef) {
      await _oqRemovePendingSample(offlineRef);
      // Clean up any OFFLINE- entries from rejected caches that reference this sample
      for (const store of [STORE_REJECTED, STORE_PORTAL_REJ]) {
        try {
          const entry = await _idbGet(store, 'list');
          if (entry && Array.isArray(entry.value)) {
            const cleaned = entry.value.filter(g => {
              const sid = g.sample?.id || g.id || '';
              return !String(sid).startsWith('OFFLINE-');
            });
            if (cleaned.length !== entry.value.length) {
              await _idbPut(store, { ...entry, value: cleaned });
            }
          }
        } catch(e) { /* silent — caches are best-effort */ }
      }
      // Remove the stale OFFLINE- cache entry and replace with real sample
      const offlineFullId = `OFFLINE-${offlineRef}`;
      await _idbDelete(STORE_SAMPLES, offlineFullId).catch(() => {});
      const realSample = {
        id: sampleId,
        patient: sampleRow.patient,
        age: sampleRow.age,
        gender: sampleRow.gender,
        priority: sampleRow.priority,
        status: sampleRow.status,
        tests: testRowsWithId,
        offline_ref: null,
        former_offline_ref: offlineRef,
        online_ref: `REF-${sampleId}`,
        pay_status: paystatus,
        pay_mode: sampleRow.pay_mode,
        total_amount: sampleRow.total_amount,
        amount_paid: sampleRow.amount_paid,
        balance_due: sampleRow.balance_due,
        collection_date: sampleRow.collection_date,
        collection_time: sampleRow.collection_time,
        registered_by: registeredBy
      };
      await _idbPut(STORE_SAMPLES, realSample);

      // Update any outbox items that still reference the offline ID so they
      // can replay correctly now that the real sampleId is known.
      const allOutbox = await _idbGetAll(STORE_OUTBOX);

      // Build a test_name → real DB id lookup for patching saveSample payloads
      const testIdByName = {};
      for (const t of testRowsWithId) {
        if (t.test_name && t.id) testIdByName[t.test_name] = t.id;
      }

      for (const outboxItem of allOutbox) {
        let updated = false;
        const p = outboxItem.payload;

        // Patch top-level sampleId references
        if (p && p.sampleId === offlineFullId) {
          p.sampleId = sampleId;
          updated = true;
        }

        // Patch saveSample payloads — update sample.id AND individual test ids
        if (p && p.sample && p.sample.id === offlineFullId) {
          p.sample.id = sampleId;
          if (Array.isArray(p.sample.tests)) {
            p.sample.tests = p.sample.tests.map(t => ({
              ...t,
              sample_id: sampleId,
              // Use real DB id if we now know it; keep whatever was there otherwise
              id: testIdByName[t.test_name] ?? testRowsWithId.find(
                    (r, i) => p.sample.tests.indexOf(t) === i
                  )?.id ?? t.id ?? null
            }));
          }
          updated = true;
        }

        if (updated) await _idbPut(STORE_OUTBOX, outboxItem);
      }
    }
    return;
  }

  if (type === 'settleBalance') {
    const { sampleId, total, mode, ref, patient, registeredBy } = payload;
    const now = new Date().toISOString();
    await db.from('samples').update({
      pay_status: 'Paid',
      amount_paid: total,
      balance_due: 0,
      pay_mode: mode,
      receipt_no: ref,
      payment_date: now
    }).eq('id', sampleId);
    await db.from('audit_log').insert([{
      ts: now, user_name: registeredBy, user_role: 'reception',
      action: 'Balance Settled', sample_id: sampleId,
      details: `Mode: ${mode} | Ref: ${ref} | Patient: ${patient}`
    }]);
    return;
  }

  if (type === 'sendToVerify') {
    const { sampleId, techName, rejectedNote } = payload;
    if (!sampleId || String(sampleId).startsWith('OFFLINE-')) {
      throw new Error('sendToVerify deferred — waiting for registerSample to assign real id');
    }
    // Mark all non-rejected tests as Verifying and update sample status
    const { data: tests } = await db.from('sample_tests')
      .select('id, status')
      .eq('sample_id', sampleId);
    if (tests) {
      for (const t of tests) {
        if (t.status !== 'Rejected') {
          await db.from('sample_tests').update({ status: 'Verifying' }).eq('id', t.id);
        }
      }
    }
    await db.from('samples').update({ status: 'Verifying' }).eq('id', sampleId);
    await db.from('coc_events')
      .update({ done: true, active: false })
      .match({ sample_id: sampleId, step_index: 4 });
    await db.from('coc_events')
      .update({ done: false, active: true })
      .match({ sample_id: sampleId, step_index: 5 });
    await db.from('audit_log').insert([{
      ts: new Date().toISOString(), user_name: techName, user_role: 'technologist',
      action: 'Sent to Verify', sample_id: sampleId,
      details: `Actionable tests complete — sent by ${techName}${rejectedNote || ''}`
    }]);
    return;
  }

  if (type === 'resolveRejected') {
    const { sampleId, actorName } = payload;

    // Fetch all tests first — do NOT filter by status='Rejected' because the old
    // result_entry may have only marked the sample row as Rejected without updating
    // the individual sample_tests rows, making that filter a silent no-op.
    const { data: allTests } = await db.from('sample_tests')
      .select('id, status')
      .eq('sample_id', sampleId);

    for (const t of (allTests || [])) {
      if (['Rejected', 'Processing', 'Collected'].includes(t.status)) {
        await db.from('sample_tests')
          .update({ status: 'Processing', rejection_reason: null })
          .eq('id', t.id);
      }
      // Restore any tests that were already Verifying back to Ready
      if (t.status === 'Verifying') {
        await db.from('sample_tests')
          .update({ status: 'Ready' })
          .eq('id', t.id);
      }
    }

    // Always reset sample status — this is the critical line that prevents bounce-back
    await db.from('samples').update({ status: 'Processing' }).eq('id', sampleId);

    const hasDoneTests = (allTests || []).some(t => t.status === 'Ready' || t.status === 'Verifying');

    if (hasDoneTests) {
      // Some tests already done — put COC back at Result Entry (step 4)
      await db.from('coc_events')
        .update({ done: false, active: true, actor_name: actorName, occurred_at: new Date().toISOString() })
        .eq('sample_id', sampleId).eq('step_index', 4);
      await db.from('coc_events')
        .update({ done: false, active: false })
        .eq('sample_id', sampleId).gte('step_index', 5);
    } else {
      // No tests done yet — put COC back at Processing (step 3)
      await db.from('coc_events')
        .update({ done: false, active: true, actor_name: actorName, occurred_at: new Date().toISOString() })
        .eq('sample_id', sampleId).eq('step_index', 3);
      await db.from('coc_events')
        .update({ done: false, active: false })
        .eq('sample_id', sampleId).gte('step_index', 4);
    }

    await db.from('audit_log').insert([{
      ts: new Date().toISOString(), user_name: actorName, user_role: 'reception',
      action: 'Rejection Resolved', sample_id: sampleId,
      details: `Resolved by reception — tests reset to Processing${hasDoneTests ? '; previously Done tests preserved as Ready' : ''}`
    }]);
    return;
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   §5  ACCESSION-SPECIFIC PUBLIC FUNCTIONS
   ═══════════════════════════════════════════════════════════════════════════ */

window._oqEnqueueSample = async function(sampleRow, testRows, registeredBy, paystatus, isPaystack) {
  const offlineRef = sampleRow.receipt_no;
  await _oqAddPendingSample(sampleRow, testRows, offlineRef);
  await _oqEnqueue('registerSample', {
    sampleRow: JSON.parse(JSON.stringify(sampleRow)),
    testRows: JSON.parse(JSON.stringify(testRows)),
    registeredBy, paystatus, isPaystack,
    offlineRef
  });
};

window._oqEnqueueSettlement = async function(sampleId, total, mode, ref, patient) {
  const registeredBy = window.currentSession?.name || 'Reception';
  await _oqEnqueue('settleBalance', { sampleId, total, mode, ref, patient, registeredBy });
};

window._oqEnqueueResolveRejected = async function(sampleId, actorName) {
  await _oqEnqueue('resolveRejected', { sampleId, actorName });
};

/* ═══════════════════════════════════════════════════════════════════════════
   §6  PENDING SAMPLE HELPERS (safe arrays)
   ═══════════════════════════════════════════════════════════════════════════ */

async function _oqAddPendingSample(sampleRow, testRows, offlineRef) {
  await _idbPut(STORE_PENDING, {
    offline_ref: offlineRef,
    sample: sampleRow,
    tests: testRows,
    queued_at: new Date().toISOString()
  });
  const cachedSample = {
    id: `OFFLINE-${offlineRef}`,
    patient: sampleRow.patient,
    age: sampleRow.age,
    gender: sampleRow.gender,
    priority: sampleRow.priority,
    status: sampleRow.status,
    tests: testRows.map(t => ({
      ...t,
      sample_id: null,
      id: null,
      result: '',
      tech_name: '',
      status: 'Collected'
    })),
    offline_ref: offlineRef,
    pay_status: sampleRow.pay_status,
    pay_mode: sampleRow.pay_mode,
    total_amount: sampleRow.total_amount,
    amount_paid: sampleRow.amount_paid,
    balance_due: sampleRow.balance_due,
    collection_date: sampleRow.collection_date,
    collection_time: sampleRow.collection_time,
    registered_by: sampleRow.registered_by
  };
  await _idbPut(STORE_SAMPLES, cachedSample);
}

async function _oqGetPendingSamples() {
  return _idbGetAll(STORE_PENDING);
}

async function _oqRemovePendingSample(offlineRef) {
  await _idbDelete(STORE_PENDING, offlineRef);
}

// Merge function still available but NOT used by loadSamples (since we don't patch it)
window._oqMergePendingSamples = async function(serverSamples) {
  const safeServer = Array.isArray(serverSamples) ? serverSamples : [];
  const pending = await _oqGetPendingSamples();

  // Build a set of offline_refs that already exist in server results —
  // this means registerSample has synced and Supabase returned the real row.
  const syncedRefs = new Set(
    safeServer
      .filter(s => s.former_offline_ref)
      .map(s => s.former_offline_ref)
  );

  const offlineSamples = [];
  for (const p of pending) {
    // Skip if the real sample already came back from Supabase
    if (syncedRefs.has(p.offline_ref)) {
      // Clean up the stale pending entry silently
      _oqRemovePendingSample(p.offline_ref).catch(() => {});
      _idbDelete(STORE_SAMPLES, `OFFLINE-${p.offline_ref}`).catch(() => {});
      continue;
    }

    // Prefer the cached sample (may have results/status edits) over the raw pending row
    const cached = await _idbGet(STORE_SAMPLES, `OFFLINE-${p.offline_ref}`).catch(() => null);
    offlineSamples.push(cached || {
      id: `OFFLINE-${p.offline_ref}`,
      patient: p.sample.patient,
      age: p.sample.age,
      gender: p.sample.gender,
      priority: p.sample.priority,
      status: p.sample.status,
      tests: p.tests.map(t => ({ ...t, sample_id: null, id: null })),
      offline_ref: p.offline_ref,
      former_offline_ref: null,
      pay_status: p.sample.pay_status,
      pay_mode: p.sample.pay_mode,
      total_amount: p.sample.total_amount,
      amount_paid: p.sample.amount_paid,
      balance_due: p.sample.balance_due,
      collection_date: p.sample.collection_date,
      collection_time: p.sample.collection_time,
      registered_by: p.sample.registered_by
    });
  }
  return [...safeServer, ...offlineSamples];
};

/* ═══════════════════════════════════════════════════════════════════════════
   §7  CACHE MANAGEMENT
   ═══════════════════════════════════════════════════════════════════════════ */

window._oqCacheTestDefinitions = async function(definitions) {
  await _oqInit();
  await _idbClear(STORE_TESTDEF);
  for (const def of definitions) {
    await _idbPut(STORE_TESTDEF, def);
  }
  await _idbPut(STORE_META, { key: 'testdef_last_sync', value: new Date().toISOString() });
};

window._oqGetCachedTestDefinitions = async function() {
  return _idbGetAll(STORE_TESTDEF);
};

window._oqCacheRejectedGroups = async function(groups) {
  await _idbPut(STORE_REJECTED, { key: 'list', value: groups, updated_at: new Date().toISOString() });
};

window._oqGetCachedRejectedGroups = async function() {
  const entry = await _idbGet(STORE_REJECTED, 'list');
  return entry ? entry.value : [];
};

// ── Pending portal: released samples cache ────────────────────────────────
window._oqCachePortalSamples = async function(samples) {
  await _idbPut(STORE_PORTAL_CACHE, {
    key: 'released',
    value: samples,
    updated_at: new Date().toISOString()
  });
};
window._oqGetCachedPortalSamples = async function() {
  const entry = await _idbGet(STORE_PORTAL_CACHE, 'released');
  return entry ? { samples: entry.value, updated_at: entry.updated_at } : null;
};

// ── Pending portal: rejected groups cache ────────────────────────────────
window._oqCachePortalRejected = async function(groups) {
  await _idbPut(STORE_PORTAL_REJ, {
    key: 'list',
    value: groups,
    updated_at: new Date().toISOString()
  });
};
window._oqGetCachedPortalRejected = async function() {
  const entry = await _idbGet(STORE_PORTAL_REJ, 'list');
  return entry ? { groups: entry.value, updated_at: entry.updated_at } : null;
};

async function _oqCacheSample(sample) {
  const safeObj = {
    id: sample.id,
    status: sample.status,
    tests: sample.tests || [],
    released_at: sample.released_at,
    supervisor_comment: sample.supervisor_comment,
    ...sample
  };
  await _idbPut(STORE_SAMPLES, safeObj);
}

async function _oqCacheSampleList(list) {
  const safeList = Array.isArray(list) ? list : [];
  for (const s of safeList) {
    await _oqCacheSample(s);
  }
  await _idbPut(STORE_META, { key: 'last_sync', value: new Date().toISOString() });
}

async function _oqGetCachedSamples() {
  const cached = await _idbGetAll(STORE_SAMPLES);
  return Array.isArray(cached) ? cached : [];
}

window._oqGetCachedSamples = _oqGetCachedSamples;
window._oqCacheSampleList = _oqCacheSampleList;

/* ═══════════════════════════════════════════════════════════════════════════
   §8  PATCHING RESULT_ENTRY CORE FUNCTIONS (LOAD FIX: NO PATCH FOR loadSamples)
   ═══════════════════════════════════════════════════════════════════════════ */

window.addEventListener('load', async () => {
  await _oqInit();

  // Flush any pending outbox items immediately on page load if we are online.
  // After flush, reload samples so newly-synced real IDs replace OFFLINE- entries.
  if (_isOnline) {
    setTimeout(async () => {
      const hadPending = (await _idbGetAll(STORE_OUTBOX)).length > 0 ||
                         (await _idbGetAll(STORE_PENDING)).length > 0;
      await _oqFlush();
      if (hadPending) {
        // Re-fetch so synced samples appear with real IDs instead of OFFLINE- placeholders
        if (typeof loadSamples === 'function') await loadSamples().catch(() => {});
        if (typeof renderProcessingSamples === 'function') renderProcessingSamples();
      }
    }, 1500); // slight delay so db/auth client is ready
  }

  // ✅ DO NOT PATCH loadSamples — leave original untouched
  // ✅ ONLY patch saveSample, updateCOCEvent, addAudit

  if (typeof window.saveSample === 'function') {
    const _origSaveSample = window.saveSample;
    window.saveSample = async function saveSampleOfflineAware(sample) {
      await _oqCacheSample(sample);
      if (!_isOnline) {
        await _oqEnqueue('saveSample', { sample: JSON.parse(JSON.stringify(sample)) });
        return;
      }
      try {
        await _origSaveSample(sample);
      } catch (err) {
        if (!_isOnline || err?.message?.includes('fetch')) {
          await _oqEnqueue('saveSample', { sample: JSON.parse(JSON.stringify(sample)) });
        } else throw err;
      }
    };
  }

  if (typeof window.updateCOCEvent === 'function') {
    const _origUpdateCOC = window.updateCOCEvent;
    window.updateCOCEvent = async function updateCOCOfflineAware(sampleId, stepIndex, done, active) {
      const actorName = (typeof currentUser !== 'undefined') ? (currentUser?.name || 'Tech') : 'Tech';
      if (!_isOnline) {
        await _oqEnqueue('updateCOCEvent', { sampleId, stepIndex, done, active, actorName });
        return;
      }
      try {
        await _origUpdateCOC(sampleId, stepIndex, done, active);
      } catch (err) {
        if (!_isOnline || err?.message?.includes('fetch')) {
          await _oqEnqueue('updateCOCEvent', { sampleId, stepIndex, done, active, actorName });
        } else throw err;
      }
    };
  }

  if (typeof window.addAudit === 'function') {
    const _origAddAudit = window.addAudit;
    window.addAudit = async function addAuditOfflineAware(action, sampleId, details) {
      const userName = (typeof currentUser !== 'undefined') ? (currentUser?.name || 'Unknown') : 'Unknown';
      const userRole = (typeof currentUser !== 'undefined') ? (currentUser?.role || 'Unknown') : 'Unknown';
      if (!_isOnline) {
        await _oqEnqueue('addAudit', { action, sampleId, details, userName, userRole });
        return;
      }
      try {
        await _origAddAudit(action, sampleId, details);
      } catch (err) {
        await _oqEnqueue('addAudit', { action, sampleId, details, userName, userRole });
      }
    };
  }

  function _offlineGuardClick(e) {
    if (!_isOnline) {
      setTimeout(() => _oqToast('Saved to offline queue — will sync when reconnected', 'warn'), 50);
    }
  }
  ['saveDraftBtn', 'markReadyBtn', 'sendVerifyBtn'].forEach(id => {
    const btn = document.getElementById(id);
    if (btn) btn.addEventListener('click', _offlineGuardClick, true);
  });

  _oqRefreshBanner();
  console.log('[OQ] Offline queue initialised. loadSamples NOT patched. Online:', _isOnline);
});

/* ═══════════════════════════════════════════════════════════════════════════
   §9  ONLINE / OFFLINE EVENT HANDLERS
   ═══════════════════════════════════════════════════════════════════════════ */

window.addEventListener('online', async () => {
  _isOnline = true;
  _oqRefreshBanner();
  _oqToast('Connection restored — syncing offline changes…', 'info');
  await _oqFlush();
  // Reload samples so OFFLINE- ids are replaced with real Supabase ids on screen
  if (typeof loadSamples === 'function') await loadSamples();
  if (typeof renderProcessingSamples === 'function') await renderProcessingSamples();
  if (typeof loadRejectedSamples === 'function') await loadRejectedSamples();
  if (typeof loadTestDefinitions === 'function') await loadTestDefinitions();
});

window.addEventListener('offline', () => {
  _isOnline = false;
  _oqRefreshBanner();
  _oqToast('You are offline — changes will be queued and synced automatically', 'warn');
});

setInterval(() => {
  if (_isOnline && !_flushing) _oqFlush();
}, 30000);

/* ═══════════════════════════════════════════════════════════════════════════
   §10  STATUS BANNER & TOAST
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
      font-family: 'DM Sans', system-ui, sans-serif;
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

  const topbarRight = document.querySelector('.topbar-right');
  const clock = document.getElementById('clockDisplay');
  if (topbarRight) {
    topbarRight.insertBefore(banner, clock || topbarRight.firstChild);
  } else {
    const topbarUser = document.querySelector('.topbar-user');
    if (topbarUser) topbarUser.parentNode.insertBefore(banner, topbarUser);
  }
}

async function _oqRefreshBanner() {
  _oqCreateBanner();
  const banner = document.getElementById('oqBanner');
  if (!banner) return;

  const label = banner.querySelector('.oq-label');

  // ── Degraded state — IndexedDB health check failed ───────────────────────
  if (window._oqDegraded) {
    banner.className = 'oq-offline';
    label.textContent = '⚠ Offline queue degraded — reload page';
    return;
  }
  // ─────────────────────────────────────────────────────────────────────────

  const pending = (await _idbGetAll(STORE_OUTBOX)).length;

  if (!_isOnline) {
    banner.className = 'oq-offline';
    label.textContent = pending ? `Offline · ${pending} pending` : 'Offline — working locally';
  } else if (pending > 0) {
    banner.className = 'oq-pending';
    label.textContent = `Syncing ${pending} change${pending > 1 ? 's' : ''}…`;
  } else {
    banner.className = 'oq-online';
    label.textContent = 'Online';
  }
}

function _oqToast(msg, type = 'info') {
  if (typeof toast === 'function') {
    toast(msg, type);
  } else {
    console.info(`[OQ toast:${type}]`, msg);
  }
}