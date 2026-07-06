// accession.js – Fully aligned with accession.html (includes Rejected Samples panel)
(function () {
  // --------------------------------------------------------------
  //  GLOBALS & INIT (same as inline script)
  // --------------------------------------------------------------
  const SUPABASE_URL = 'https://npdopywxemtwzvpummsn.supabase.co';
  const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5wZG9weXd4ZW10d3p2cHVtbXNuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk4NzY0MjksImV4cCI6MjA5NTQ1MjQyOX0.Mo5LfGdfSiHL6QHsPOaGkDmeaIRDqZTe8MGwz_6ou1c';
  const PAYSTACK_PUBLIC_KEY = 'pk_test_8564df5226f404c1952b77183cc611d283be1a0c';

  // Auth session from auth-guard.js
  const currentSession = window.currentSession || { name: 'Reception', role: 'reception' };
  const db = window._supabaseClient;    // token-authenticated client

  // --------------------------------------------------------------
  //  HOSPITAL NUMBER LOOKUP (links samples back to patient_registry
  //  so doctor-consultation.js can later find results by hosp. no.)
  // --------------------------------------------------------------
  let _linkedPatient = null; // { hospital_number, name, age, gender, phone } once a match is picked
  let _pulledLabRequestIds = []; // lab_requests.id values auto-added into this cart, marked fulfilled on save
  let _hospnumDebounce = null;

  function _initHospnumSearch() {
    const input = document.getElementById('f-hospnum');
    const resultsBox = document.getElementById('hospnum-results');
    const statusEl = document.getElementById('hospnum-status');
    if (!input || !resultsBox) return;

    input.addEventListener('input', () => {
      _linkedPatient = null; // any manual edit invalidates a prior match
      _pulledLabRequestIds = []; // don't mark requests fulfilled if the link was abandoned
      if (statusEl) statusEl.textContent = '';
      clearTimeout(_hospnumDebounce);
      const q = input.value.trim();
      if (q.length < 2) { resultsBox.style.display = 'none'; resultsBox.innerHTML = ''; return; }
      _hospnumDebounce = setTimeout(() => _searchHospnum(q), 300);
    });

    input.addEventListener('blur', () => {
      // small delay so a click on a result registers before the box hides
      setTimeout(() => { resultsBox.style.display = 'none'; }, 150);
    });

    document.addEventListener('click', (e) => {
      if (!resultsBox.contains(e.target) && e.target !== input) resultsBox.style.display = 'none';
    });
  }

  async function _searchHospnum(q) {
    const resultsBox = document.getElementById('hospnum-results');
    const statusEl = document.getElementById('hospnum-status');
    if (!db || !resultsBox) return;
    try {
      const { data, error } = await db
        .from('patient_registry')
        .select('hospital_number, surname, first_name, middle_name, age, gender, phone, date_of_birth')
        .or(`hospital_number.ilike.%${q}%,surname.ilike.%${q}%,first_name.ilike.%${q}%`)
        .limit(8);
      if (error) throw error;

      if (!data || data.length === 0) {
        resultsBox.innerHTML = `<div style="padding:8px 10px; color:var(--muted,#888); font-size:13px;">No match — will register as walk-in with this as a free-text ID</div>`;
        resultsBox.style.display = 'block';
        return;
      }

      resultsBox.innerHTML = data.map(p => {
        const fullName = [p.surname, p.first_name, p.middle_name].filter(Boolean).join(' ');
        return `<div class="hospnum-result-row" data-hn="${esc(p.hospital_number)}"
                     style="padding:8px 10px; cursor:pointer; border-bottom:1px solid #f0f0f0; font-size:13px;">
                  <strong>${esc(p.hospital_number)}</strong> — ${esc(fullName)}
                  <span style="color:var(--muted,#888);">${p.age ? ` · ${p.age}y` : ''}${p.gender ? ` · ${esc(p.gender)}` : ''}</span>
                </div>`;
      }).join('');
      resultsBox.style.display = 'block';

      resultsBox.querySelectorAll('.hospnum-result-row').forEach((row, idx) => {
        row.addEventListener('mouseenter', () => row.style.background = '#f5f5f5');
        row.addEventListener('mouseleave', () => row.style.background = '#fff');
        // mousedown fires BEFORE the input's blur event, so it can never lose
        // the race against the blur handler's setTimeout that hides this
        // dropdown. Plain 'click' meant on slower/touch devices the row could
        // already be display:none by the time click fired, silently dropping
        // the selection — so patient details AND pending lab_requests never
        // got pulled in.
        row.addEventListener('mousedown', (e) => {
          e.preventDefault();
          _pickHospnumMatch(data[idx]);
        });
      });
    } catch (err) {
      console.error('[AC] hospnum search failed', err);
      if (statusEl) statusEl.textContent = 'Search failed — you can still type a manual ID.';
    }
  }

  function _findUnitForTest(testName) {
    for (const [unit, tests] of Object.entries(testDefinitions.units)) {
      if (tests.includes(testName)) return unit;
    }
    return null;
  }

  async function _autoAddPendingLabRequests(hospitalNumber) {
    if (!db || !hospitalNumber) return;
    // Guard against test_definitions still loading on a slow connection
    if (Object.keys(testDefinitions.units).length === 0) {
      await new Promise(r => setTimeout(r, 800));
    }
    try {
      const { data: requests, error } = await db
        .from('lab_requests')
        .select('id, urgency, clinical_notes, lab_request_tests(test_name)')
        .eq('hospital_number', hospitalNumber)
        .eq('status', 'pending');
      if (error) throw error;
      if (!requests || requests.length === 0) return;

      let added = 0, skipped = [];
      const fulfilledRequestIds = new Set();
      requests.forEach(r => {
        (r.lab_request_tests || []).forEach(t => {
          const testName = t.test_name;
          const unit = _findUnitForTest(testName);
          if (!unit) { skipped.push(testName); return; }
          if (tempTests.find(x => x.unit_name === unit && x.test_name === testName)) { fulfilledRequestIds.add(r.id); return; } // already in cart, still counts as fulfilled
          const testType = testDefinitions.testTypes[testName] || 'simple';
          const sampleType = testDefinitions.sampleTypes[testName] || null;
          const tube = testDefinitions.tubes[testName] || null;
          tempTests.push({
            unit_name: unit, test_name: testName, test_type: testType,
            sample_type: sampleType, tube: tube,
            result: '', result_json: null, tech_name: '', status: 'Collected', sort_order: tempTests.length
          });
          added++;
          fulfilledRequestIds.add(r.id);
        });
      });
      _pulledLabRequestIds = [...new Set([..._pulledLabRequestIds, ...fulfilledRequestIds])];

      if (added > 0) { renderCart(); updateSampleSummary(); }

      // Carry the doctor's urgency/notes into the accession form if set and not already filled
      const firstReq = requests[0];
      const priorityEl = document.getElementById('f-priority');
      if (priorityEl && firstReq.urgency) {
        const urgencyMap = { routine: 'Routine', urgent: 'Urgent', stat: 'STAT' };
        const mapped = urgencyMap[(firstReq.urgency || '').toLowerCase()];
        if (mapped) priorityEl.value = mapped;
      }
      const historyEl = document.getElementById('f-history');
      if (historyEl && !historyEl.value.trim() && firstReq.clinical_notes) {
        historyEl.value = firstReq.clinical_notes;
      }

      const statusEl = document.getElementById('hospnum-status');
      if (statusEl) {
        let msg = `✓ Linked. ${added} pending doctor-ordered test${added===1?'':'s'} auto-added to cart.`;
        if (skipped.length > 0) msg += ` (${skipped.length} unmatched: ${skipped.join(', ')} — add manually)`;
        statusEl.textContent = msg;
      }
      if (added > 0) toast(`${added} doctor-ordered test${added===1?'':'s'} auto-added`, 'success');
      if (skipped.length > 0) toast(`Could not auto-match: ${skipped.join(', ')} — please add manually`, 'warn');
    } catch (err) {
      console.error('[AC] auto-add pending lab_requests failed', err);
    }
  }

  function _pickHospnumMatch(p) {
    const fullName = [p.surname, p.first_name, p.middle_name].filter(Boolean).join(' ');
    document.getElementById('f-hospnum').value = p.hospital_number;
    document.getElementById('f-name').value = fullName;
    if (p.age) document.getElementById('f-age').value = p.age;
    if (p.gender) document.getElementById('f-gender').value = p.gender;
    if (p.phone) document.getElementById('f-phone').value = p.phone;
    document.getElementById('f-name')?.classList.remove('required-empty');

    _linkedPatient = { hospital_number: p.hospital_number, name: fullName, age: p.age, gender: p.gender, phone: p.phone };

    const statusEl = document.getElementById('hospnum-status');
    if (statusEl) statusEl.textContent = `✓ Linked. Checking for pending doctor-ordered tests…`;
    const resultsBox = document.getElementById('hospnum-results');
    if (resultsBox) resultsBox.style.display = 'none';

    _autoAddPendingLabRequests(p.hospital_number);
  }

  document.addEventListener('DOMContentLoaded', _initHospnumSearch);
  if (document.readyState !== 'loading') _initHospnumSearch();

  // --------------------------------------------------------------
  //  SERVER-SIDE PAYSTACK VERIFICATION
  // --------------------------------------------------------------
  // Never trust the Paystack inline `callback` alone — it fires in the
  // browser and proves nothing about whether money actually moved. This
  // calls a Supabase Edge Function that re-checks the transaction directly
  // with Paystack's servers (using the secret key, which never reaches this
  // file) and only then writes pay_status: 'Paid' to the database, using
  // the service role so the write itself can't be raced or spoofed either.
  //
  // purpose: 'registration' | 'settlement'
  // expectedAmount: the exact naira amount Paystack was charged for this
  //                 transaction (total for registration, balance for settlement)
  // fullTotal: only needed for 'settlement' — the sample's full bill total,
  //            so amount_paid is recorded correctly once the balance clears
  async function verifyPaystackPayment({ reference, sampleId, expectedAmount, purpose, fullTotal }) {
    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/verify-paystack-payment`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
          'apikey': SUPABASE_ANON_KEY,
          'x-lis-token': currentSession.token || ''
        },
        body: JSON.stringify({
          reference, sampleId, expectedAmount, purpose, fullTotal,
          actorName: currentSession.name || 'Reception'
        })
      });
      const json = await res.json();
      if (!res.ok || !json.ok) {
        return { ok: false, error: json.error || `Verification failed (HTTP ${res.status})` };
      }
      return json;
    } catch (err) {
      return { ok: false, error: `Could not reach verification server: ${err.message}` };
    }
  }

  // Test definitions storage
  let testDefinitions = { units: {}, testPrices: {}, testTypes: {} };
  let tempTests = [];                   // cart
  window.tempTests = tempTests;

  // Rejected samples storage
  let rejectedGroups = [];

  // Helper: escape HTML
  function esc(str) {
    if (str == null) return '';
    return String(str).replace(/[&<>"']/g, m => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[m]);
  }

  function toast(msg, type = 'success') {
    const stack = document.getElementById('toastStack');
    if (!stack) return;
    const div = document.createElement('div');
    div.className = `toast ${type}`;
    const icon = type === 'error' ? 'times-circle' : type === 'warn' ? 'exclamation-triangle' : 'check-circle';
    div.innerHTML = `<i class="fas fa-${icon}"></i> ${esc(msg)}`;
    stack.appendChild(div);
    setTimeout(() => { div.style.opacity = '0'; setTimeout(() => div.remove(), 300); }, 3500);
  }

  async function addAudit(action, sampleId, details) {
    try {
      await db.from('audit_log').insert([{
        ts: new Date().toISOString(),
        user_name: currentSession.name || 'Unknown',
        user_role: currentSession.role || 'Unknown',
        action,
        sample_id: sampleId,
        details: details || ''
      }]);
    } catch (err) { console.warn('Audit failed', err); }
  }

  // --------------------------------------------------------------
  //  LOAD TEST DEFINITIONS (with offline cache)
  // --------------------------------------------------------------
  async function loadTestDefinitions() {
    try {
      const { data, error } = await db.from('test_definitions').select('*');
      if (error) throw error;
      applyTestDefinitions(data);
      if (window._oqCacheTestDefinitions) window._oqCacheTestDefinitions(data);
    } catch (err) {
      console.warn('loadTestDefinitions online failed, trying cache:', err);
      const cached = window._oqGetCachedTestDefinitions ? await window._oqGetCachedTestDefinitions() : null;
      if (cached) {
        applyTestDefinitions(cached);
        toast('Using cached test definitions (offline)', 'warn');
      } else {
        toast('Failed to load test definitions', 'error');
        document.getElementById('noTestsNotice').style.display = 'block';
        document.getElementById('addTestBtn').disabled = true;
      }
    }
  }

  function applyTestDefinitions(data) {
    testDefinitions = { units: {}, testPrices: {}, testTypes: {}, sampleTypes: {}, tubes: {} };
    data.forEach(td => {
      if (!testDefinitions.units[td.unit_name]) testDefinitions.units[td.unit_name] = [];
      testDefinitions.units[td.unit_name].push(td.test_name);
      testDefinitions.testPrices[td.test_name] = td.price_ngn;
      if (td.test_type !== 'simple') testDefinitions.testTypes[td.test_name] = td.test_type;
      if (td.sample_type) testDefinitions.sampleTypes[td.test_name] = td.sample_type;
      if (td.tube) testDefinitions.tubes[td.test_name] = td.tube;
    });
    populateUnits();
  }

  function getTestPrice(testName) { return testDefinitions.testPrices[testName] || 0; }
  window.getTestPrice = getTestPrice;   // for offline_queue

  function populateUnits() {
    const units = Object.keys(testDefinitions.units);
    const notice = document.getElementById('noTestsNotice');
    const addBtn = document.getElementById('addTestBtn');
    if (!units.length) {
      if (notice) notice.style.display = 'block';
      if (addBtn) addBtn.disabled = true;
      return;
    }
    if (notice) notice.style.display = 'none';
    if (addBtn) addBtn.disabled = false;
    const sel = document.getElementById('f-unit');
    if (sel) sel.innerHTML = units.map(u => `<option value="${esc(u)}">${esc(u)}</option>`).join('');
    updateTests();
  }

  function updateTests() {
    const unit = document.getElementById('f-unit')?.value;
    const tests = testDefinitions.units[unit] || [];
    const sel = document.getElementById('f-test');
    if (sel) sel.innerHTML = tests.map(t => `<option value="${esc(t)}">${esc(t)}</option>`).join('');
  }

  // --------------------------------------------------------------
  //  CART & TOTAL
  // --------------------------------------------------------------
  function renderCart() {
    const cart = document.getElementById('testCart');
    if (!cart) return;
    if (!tempTests.length) {
      cart.innerHTML = '<span style="color:var(--text3);">No tests added yet.</span>';
      updateTotal();
      updateSampleSummary();
      return;
    }
    cart.innerHTML = tempTests.map((t, i) => `
      <div class="test-chip">
        <span>${esc(t.unit_name)}: ${esc(t.test_name)} – <strong>${getTestPrice(t.test_name).toFixed(2)} NGN</strong>
          ${t.sample_type ? `<span style="font-size:0.7rem;color:var(--primary);margin-left:4px;">🧪 ${esc(t.sample_type)}</span>` : ''}
        </span>
        <button class="chip-remove" data-idx="${i}" title="Remove">×</button>
      </div>`).join('');
    cart.querySelectorAll('.chip-remove').forEach(btn => {
      btn.addEventListener('click', () => { tempTests.splice(parseInt(btn.dataset.idx), 1); renderCart(); updateSampleSummary(); });
    });
    updateTotal();
    updateSampleSummary();
  }

  // ── Sample Summary: groups tests by sample type and shows required tubes ──
  function updateSampleSummary() {
    const wrap = document.getElementById('sampleSummary');
    if (!wrap) return;
    if (!tempTests.length) { wrap.innerHTML = ''; wrap.style.display = 'none'; return; }

    // Group by sample_type
    const groups = {};
    tempTests.forEach(t => {
      const st = t.sample_type || 'Not specified';
      const tb = t.tube || 'Not specified';
      const key = st + '||' + tb;
      if (!groups[key]) groups[key] = { sample_type: st, tube: tb, tests: [] };
      groups[key].tests.push(t.test_name);
    });

    const groupsArr = Object.values(groups);
    wrap.style.display = 'block';
    wrap.innerHTML = `
      <div style="font-weight:600;font-size:0.85rem;margin-bottom:8px;color:var(--primary);">
        <i class="fas fa-vials"></i> Sample Collection Required (${groupsArr.length} sample${groupsArr.length > 1 ? 's' : ''})
      </div>
      ${groupsArr.map((g, i) => `
        <div style="background:#f0f9f4;border:1.5px solid #bbf7d0;border-radius:10px;padding:10px 14px;margin-bottom:8px;">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
            <span style="background:var(--primary);color:#fff;border-radius:50%;width:20px;height:20px;display:inline-flex;align-items:center;justify-content:center;font-size:0.7rem;font-weight:700;">${i+1}</span>
            <strong style="font-size:0.85rem;">🧪 ${esc(g.sample_type)}</strong>
            <span style="font-size:0.75rem;color:#6b7280;">— ${esc(g.tube)}</span>
          </div>
          <div style="font-size:0.75rem;color:var(--text2);padding-left:28px;">
            Tests: ${g.tests.map(t => `<span style="background:#e0f2fe;border-radius:4px;padding:1px 6px;margin:1px;display:inline-block;">${esc(t)}</span>`).join('')}
          </div>
        </div>`).join('')}`;
  }

  function updateTotal() {
    const total = tempTests.reduce((sum, t) => sum + getTestPrice(t.test_name), 0);
    let paidRaw = parseFloat(document.getElementById('amountPaid')?.value) || 0;
    if (paidRaw > total) {
      paidRaw = total;
      if (document.getElementById('amountPaid')) document.getElementById('amountPaid').value = total.toFixed(2);
      toast('Amount paid capped at total', 'warn');
    }
    const balance = total - paidRaw;
    document.getElementById('totalAmount').textContent = total.toFixed(2);
    document.getElementById('balanceDue').textContent = balance.toFixed(2);
    const badge = document.getElementById('payStatusBadge');
    if (badge) {
      if (total === 0 || (balance > 0 && paidRaw === 0)) {
        badge.textContent = 'Unpaid'; badge.className = 'pay-badge pay-unpaid';
      } else if (balance > 0) {
        badge.textContent = 'Partial'; badge.className = 'pay-badge pay-partial';
      } else {
        badge.textContent = 'Paid'; badge.className = 'pay-badge pay-paid';
      }
    }
  }

  function addTest() {
    const unit = document.getElementById('f-unit')?.value;
    const test = document.getElementById('f-test')?.value;
    if (!unit || !test) { toast('Select a unit and test first', 'warn'); return; }
    if (tempTests.find(t => t.unit_name === unit && t.test_name === test)) {
      toast(`"${test}" already in the cart`, 'warn'); return;
    }
    const testType = testDefinitions.testTypes[test] || 'simple';
    const sampleType = testDefinitions.sampleTypes[test] || null;
    const tube = testDefinitions.tubes[test] || null;
    tempTests.push({
      unit_name: unit, test_name: test, test_type: testType,
      sample_type: sampleType, tube: tube,
      result: '', result_json: null, tech_name: '', status: 'Collected', sort_order: tempTests.length
    });
    renderCart();
    updateSampleSummary();
    toast(`${test} added`);
  }

  // --------------------------------------------------------------
  //  REGISTER SAMPLE (online + offline queue)
  // --------------------------------------------------------------
  async function registerSample() {
    let name = document.getElementById('f-name')?.value.trim();
    document.getElementById('f-name')?.classList.toggle('required-empty', !name);
    if (!name) { toast('Patient name is required', 'error'); document.getElementById('f-name')?.focus(); return; }
    if (!tempTests.length) { toast('Add at least one test', 'error'); return; }

    const paymode = document.getElementById('f-paymode')?.value || 'Cash';
    const isPaystack = (paymode === 'Paystack');
    const total = tempTests.reduce((sum, t) => sum + getTestPrice(t.test_name), 0);
    let paid = isPaystack ? 0 : Math.min(parseFloat(document.getElementById('amountPaid')?.value) || 0, total);
    let balance = total - paid;
    let paystatus = isPaystack ? 'Unpaid' : (balance <= 0 ? 'Paid' : paid > 0 ? 'Partial' : 'Unpaid');

    const now = new Date();
    const collDate = document.getElementById('f-collDate')?.value || now.toISOString().slice(0, 10);
    const collTime = document.getElementById('f-collTime')?.value || now.toTimeString().slice(0, 5);

    const sampleRow = {
      patient: name, age: parseInt(document.getElementById('f-age')?.value) || null,
      gender: document.getElementById('f-gender')?.value || 'Male',
      phone: document.getElementById('f-phone')?.value.trim() || null,
      hospital_number: _linkedPatient?.hospital_number || document.getElementById('f-hospnum')?.value.trim() || null,
      area: document.getElementById('f-area')?.value.trim() || null,
      clinician: document.getElementById('f-clinician')?.value.trim() || null,
      history: document.getElementById('f-history')?.value.trim() || null,
      priority: document.getElementById('f-priority')?.value || 'Routine',
      sample_type: [...new Set(tempTests.map(t => t.sample_type).filter(Boolean))].join('; ') || null,
      tube: [...new Set(tempTests.map(t => t.tube).filter(Boolean))].join('; ') || null,
      collection_date: collDate, collection_time: collTime,
      due_date: document.getElementById('f-due')?.value || null,
      pay_mode: paymode, insurance_no: document.getElementById('f-insurance')?.value.trim() || null,
      pay_status: paystatus, total_amount: total, amount_paid: paid, balance_due: balance,
      receipt_no: `RCP-${Date.now()}`, payment_date: now.toISOString(),
      status: 'Collected', registered_by: currentSession.name || 'Reception'
    };

    const btn = document.getElementById('registerBtn');
    if (btn) { btn.classList.add('loading'); btn.disabled = true; }

    // --- OFFLINE: enqueue ---
    if (!navigator.onLine) {
      // Poll briefly in case offline_queue.js is still initialising (race condition)
      let _oqReady = typeof window._oqEnqueueSample === 'function';
      if (!_oqReady) {
        await new Promise(r => setTimeout(r, 600));
        _oqReady = typeof window._oqEnqueueSample === 'function';
      }
      if (_oqReady) {
        window._oqEnqueueSample(sampleRow, [...tempTests], currentSession.name, paystatus, isPaystack);
        toast('Saved offline. Will sync when internet returns.', 'warn');
        showOfflineReceipt({
          patient: name, priority: sampleRow.priority, tests: tempTests,
          totalAmount: total, amountPaid: paid, balanceDue: balance, paystatus,
          paymode: paymode, receiptNo: sampleRow.receipt_no, paymentDate: now.toISOString()
        });
        clearForm();
      } else {
        // offline_queue.js not loaded on this page — do a direct IndexedDB save
        // so data is never lost even without the queue script
        try {
          await _accessionDirectOfflineSave(sampleRow, [...tempTests], currentSession.name, paystatus);
          toast('Saved offline. Will sync when internet returns.', 'warn');
          showOfflineReceipt({
            patient: name, priority: sampleRow.priority, tests: tempTests,
            totalAmount: total, amountPaid: paid, balanceDue: balance, paystatus,
            paymode: paymode, receiptNo: sampleRow.receipt_no, paymentDate: now.toISOString()
          });
          clearForm();
        } catch(e) {
          toast('Offline save failed — please check storage permissions', 'error');
          console.error('[AC] offline fallback save failed', e);
        }
      }
      if (btn) { btn.classList.remove('loading'); btn.disabled = false; }
      return;
    }

    // --- ONLINE: normal Supabase transaction ---
    try {
      // Guard: ensure we have an authenticated client before trying to insert.
      // If the client is missing or the session has expired, the insert will fail
      // with an RLS error. Fall back to offline draft in that case.
      if (!db) throw new Error('No authenticated Supabase client — session may have expired. Please reload.');

      const { data: sampleData, error: sampleError } = await db.from('samples').insert(sampleRow).select('id').single();
      if (sampleError) {
        // RLS / auth errors: save as offline draft rather than losing the data
        const isAuthError = sampleError.code === '42501' ||
          (sampleError.message || '').toLowerCase().includes('row-level security') ||
          (sampleError.message || '').toLowerCase().includes('violates') ||
          (sampleError.message || '').toLowerCase().includes('jwt') ||
          (sampleError.message || '').toLowerCase().includes('unauthorized');
        if (isAuthError) {
          console.warn('[AC] RLS/auth error on insert — saving as offline draft:', sampleError);
          if (typeof window._oqEnqueueSample === 'function') {
            window._oqEnqueueSample(sampleRow, [...tempTests], currentSession.name, paystatus, false);
            toast('Session error — sample saved as offline draft and will sync automatically.', 'warn');
            showOfflineReceipt({
              patient: name, priority: sampleRow.priority, tests: tempTests,
              totalAmount: total, amountPaid: paid, balanceDue: balance, paystatus,
              paymode: paymode, receiptNo: sampleRow.receipt_no, paymentDate: now.toISOString()
            });
            clearForm();
          } else {
            toast('Registration failed (auth error): ' + sampleError.message, 'error');
          }
          if (btn) { btn.classList.remove('loading'); btn.disabled = false; }
          return;
        }
        throw sampleError;
      }

      const sampleId = sampleData.id;
      const finalReceipt = `RCP-${sampleId}-${Date.now()}`;
      await db.from('samples').update({ receipt_no: finalReceipt }).eq('id', sampleId);

      const testRows = tempTests.map((t, idx) => ({
        sample_id: sampleId, test_name: t.test_name, unit_name: t.unit_name,
        test_type: t.test_type, result: '', result_json: null, tech_name: '', status: 'Collected', sort_order: idx
      }));
      await db.from('sample_tests').insert(testRows);

      await db.from('coc_events').insert([
        { sample_id: sampleId, step_index: 0, step_name: 'Registered', done: true, active: false,
          actor_name: currentSession.name || 'Reception', occurred_at: now.toISOString() },
        { sample_id: sampleId, step_index: 1, step_name: 'Collected', done: false, active: true,
          actor_name: null, occurred_at: now.toISOString() }
      ]);

      // Mark any doctor-ordered lab_requests that fed this sample as fulfilled,
      // so re-searching this patient later doesn't auto-add the same tests again.
      if (_pulledLabRequestIds.length > 0) {
        await db.from('lab_requests')
          .update({ status: 'fulfilled', updated_at: now.toISOString() })
          .in('id', _pulledLabRequestIds);
      }

      await addAudit('Sample Registered', sampleId, `${tempTests.length} test(s) | Total: ${total} NGN | Mode: ${paymode} | Status: ${paystatus}`);

      toast(`MU-${sampleId} registered ✓`);

      if (isPaystack && total > 0) {
        if (btn) { btn.classList.remove('loading'); btn.disabled = false; }
        const patientEmail = document.getElementById('f-patient-email')?.value.trim() || (`patient${sampleId}@muujiza-lab.com`);
        const paystackRef = `MU-${sampleId}-${Date.now()}`;
        window._pendingPaystack = {
          sampleId, receiptNo: paystackRef, patient: name, priority: sampleRow.priority,
          tests: [...tempTests], totalAmount: total, paymode
        };
        const handler = PaystackPop.setup({
          key: PAYSTACK_PUBLIC_KEY, email: patientEmail, amount: Math.round(total * 100),
          currency: 'NGN', ref: paystackRef,
          metadata: { custom_fields: [
            { display_name: 'Sample ID', variable_name: 'sample_id', value: 'MU-' + sampleId },
            { display_name: 'Patient', variable_name: 'patient_name', value: name },
            { display_name: 'Registered By', variable_name: 'registered_by', value: currentSession.name }
          ] },
          // NOTE: this must be a plain (non-async) function. Some builds of
          // Paystack's inline.js validate `callback` by checking that its
          // string representation starts with "function" — an `async
          // function` callback fails that check and throws "Attribute
          // callback must be a valid function". The async work is done in
          // a separate named async function instead, called from here.
          callback: function (response) {
            handlePaystackRegistrationCallback(response);
          },
          onClose: function () {
            toast(`Payment window closed. Sample MU-${window._pendingPaystack?.sampleId} saved as Unpaid. Use "Settle Balance" later.`, 'warn');
            clearForm();
          }
        });
        handler.openIframe();
        return;
      } else {
        showReceiptModal({
          id: sampleId, patient: name, priority: sampleRow.priority, tests: tempTests,
          totalAmount: total, amountPaid: paid, balanceDue: balance, paystatus,
          paymode, receiptNo: finalReceipt, paymentDate: now.toISOString()
        });
        clearForm();
      }
    } catch (err) {
      console.error(err);
      // Network error mid-attempt — save to offline queue so data is never lost
      const isNetworkErr = !navigator.onLine ||
        (err?.message || '').match(/fetch|network|failed to fetch|load failed/i) ||
        err?.name === 'TypeError';
      if (isNetworkErr && typeof window._oqEnqueueSample === 'function') {
        window._oqEnqueueSample(sampleRow, [...tempTests], currentSession.name, paystatus, false);
        toast('Network error — sample saved offline and will sync automatically.', 'warn');
        showOfflineReceipt({
          patient: name, priority: sampleRow.priority, tests: tempTests,
          totalAmount: total, amountPaid: paid, balanceDue: balance, paystatus,
          paymode: paymode, receiptNo: sampleRow.receipt_no, paymentDate: now.toISOString()
        });
        clearForm();
      } else {
        toast(`Registration failed: ${err.message}`, 'error');
      }
    } finally {
      if (btn) { btn.classList.remove('loading'); btn.disabled = false; }
    }
  }
  window.registerSample = registerSample;

  // Async logic for the registration Paystack callback, pulled out of the
  // PaystackPop.setup() options object — see the comment at the `callback`
  // key above for why this can't be an inline async function.
  async function handlePaystackRegistrationCallback(response) {
    const ctx = window._pendingPaystack;
    toast(`Payment received, verifying with Paystack…`, 'warn');
    const result = await verifyPaystackPayment({
      reference: response.reference,
      sampleId: ctx.sampleId,
      expectedAmount: ctx.totalAmount,
      purpose: 'registration'
    });
    if (!result.ok) {
      toast(`Payment verification failed: ${result.error}. Sample MU-${ctx.sampleId} remains Unpaid — use "Settle Balance" once resolved. Ref: ${response.reference}`, 'error');
      clearForm();
      return;
    }
    const payNow = new Date().toISOString();
    toast(`Payment confirmed ✓ Ref: ${response.reference}`);
    showReceiptModal({
      id: ctx.sampleId, patient: ctx.patient, priority: ctx.priority, tests: ctx.tests,
      totalAmount: ctx.totalAmount, amountPaid: ctx.totalAmount, balanceDue: 0,
      paystatus: 'Paid', paymode: 'Paystack', receiptNo: response.reference, paymentDate: payNow,
      paystackRef: response.reference
    });
    clearForm();
  }

  // --------------------------------------------------------------
  //  CLEAR FORM
  // --------------------------------------------------------------
  function clearForm() {
    ['f-name','f-phone','f-hospnum','f-clinician','f-history','f-insurance','f-patient-email','f-area-search'].forEach(id => {
      const el = document.getElementById(id); if (el) el.value = '';
    });
    _linkedPatient = null;
    _pulledLabRequestIds = [];
    const resultsEl = document.getElementById('hospnum-results'); if (resultsEl) resultsEl.style.display = 'none';
    const areaEl = document.getElementById('f-area'); if (areaEl) areaEl.value = '';
    populateAreaSelect(_allAreas);
    document.getElementById('f-name')?.classList.remove('required-empty');
    document.getElementById('f-age').value = '';
    document.getElementById('f-gender').value = 'Male';
    document.getElementById('f-priority').value = 'Routine';
    document.getElementById('f-paymode').value = 'Cash';
    window.handlePaymodeChange?.();
    setDefaultDates();
    tempTests = [];
    window.tempTests = tempTests;
    renderCart();
    document.getElementById('amountPaid').value = '0';
    updateTotal();
  }
  window.clearForm = clearForm;

  // --------------------------------------------------------------
  //  PAYMENT MODE UI
  // --------------------------------------------------------------
  window.handlePaymodeChange = function () {
    const mode = document.getElementById('f-paymode')?.value;
    const isPaystack = mode === 'Paystack';
    document.getElementById('paystackEmailGroup').style.display = isPaystack ? 'block' : 'none';
    document.getElementById('paystackNotice').style.display = isPaystack ? 'block' : 'none';
    document.getElementById('manualPaidGroup').style.display = isPaystack ? 'none' : 'block';
    const lbl = document.getElementById('registerBtnLabel');
    if (lbl) lbl.innerHTML = isPaystack
      ? '<i class="fas fa-lock"></i> Register & Pay via Paystack'
      : '<i class="fas fa-syringe"></i> Register & Print Receipt';
  };

  // --------------------------------------------------------------
  //  BALANCE SETTLEMENT PANEL (with offline queue)
  // --------------------------------------------------------------
  window.toggleSettlePanel = function () {
    const body = document.getElementById('settlePanelBody');
    const chevron = document.getElementById('settlePanelChevron');
    if (!body) return;
    const isHidden = body.style.display === 'none';
    body.style.display = isHidden ? 'block' : 'none';
    chevron.style.transform = isHidden ? 'rotate(180deg)' : 'rotate(0deg)';
  };

  window.lookupSampleBalance = async function () {
    const raw = document.getElementById('settle-sample-id')?.value.trim();
    if (!raw) { toast('Enter a Sample ID', 'warn'); return; }
    const numericId = parseInt(raw.replace(/[^0-9]/g, ''));
    if (!numericId) { toast('Invalid Sample ID format', 'error'); return; }

    const box = document.getElementById('settleResultBox');
    box.style.display = 'block';
    box.innerHTML = `<div style="padding:16px;text-align:center;"><i class="fas fa-spinner fa-spin"></i> Looking up MU-${numericId}…</div>`;

    try {
      const { data, error } = await db.from('samples')
        .select('id,patient,total_amount,amount_paid,balance_due,pay_status,pay_mode,phone')
        .eq('id', numericId).single();
      if (error || !data) throw new Error('Not found');

      if (data.pay_status === 'Paid') {
        box.innerHTML = `<div style="padding:14px;background:#dcfce7;border-radius:14px;">✓ MU-${numericId} — ${esc(data.patient)} — already fully paid.</div>`;
        return;
      }

      const balance = parseFloat(data.balance_due) || 0;
      const total = parseFloat(data.total_amount) || 0;
      const alreadyPaid = parseFloat(data.amount_paid) || 0;

      box.innerHTML = `
        <div style="border:1.5px solid var(--border);border-radius:18px;overflow:hidden;">
          <div style="padding:14px 18px;background:#f8fafb;border-bottom:1px solid var(--border);">
            <div><strong>MU-${numericId} — ${esc(data.patient)}</strong></div>
            <div>Status: <span class="pay-badge ${data.pay_status==='Partial'?'pay-partial':'pay-unpaid'}">${esc(data.pay_status)}</span></div>
          </div>
          <div style="padding:16px 18px;">
            <div style="background:#f0f7f3;border-radius:12px;padding:12px;margin-bottom:14px;">
              <div>Invoice Total: <strong>${total.toFixed(2)} NGN</strong></div>
              <div>Already Paid: <strong>${alreadyPaid.toFixed(2)} NGN</strong></div>
              <div style="border-top:1px solid #c6e2d4;margin-top:6px;padding-top:6px;">Balance Due: <strong>${balance.toFixed(2)} NGN</strong></div>
            </div>
            <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px;" id="settleModeRow">
              <button class="pay-mode-settle-btn active" data-mode="Cash" onclick="setSettleMode(this,'Cash')">💵 Cash</button>
              <button class="pay-mode-settle-btn" data-mode="POS" onclick="setSettleMode(this,'POS')">🏧 POS</button>
              <button class="pay-mode-settle-btn" data-mode="Paystack" onclick="setSettleMode(this,'Paystack')">💳 Paystack</button>
              <button class="pay-mode-settle-btn" data-mode="NHIS" onclick="setSettleMode(this,'NHIS')">🏥 NHIS</button>
            </div>
            <button id="settleConfirmBtn" style="width:100%;padding:12px;background:var(--primary);color:white;border:none;border-radius:14px;"
              onclick="confirmSettlement(${numericId},${balance},${total},'${esc(data.patient)}','${esc(data.phone||'')}')">
              <i class="fas fa-check-circle"></i> Confirm Payment of ${balance.toFixed(2)} NGN
            </button>
          </div>
        </div>`;
    } catch (err) {
      box.innerHTML = `<div style="padding:14px;background:#fee2e2;border-radius:14px;">Error: ${esc(err.message)}</div>`;
    }
  };

  let _settleMode = 'Cash';
  window.setSettleMode = function (btn, mode) {
    _settleMode = mode;
    document.querySelectorAll('.pay-mode-settle-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  };

  window.confirmSettlement = async function (sampleId, balance, total, patient, phone) {
    // ── Double-payment guard ─────────────────────────────────────────────
    // Re-fetch the live pay_status before proceeding. If two receptionists
    // opened the same sample simultaneously, one may have already settled it.
    // Aborting here prevents a duplicate payment record and a second audit entry.
    if (navigator.onLine) {
      const btn = document.getElementById('settleConfirmBtn');
      if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Checking…'; }
      try {
        const { data: liveRow, error: checkErr } = await db
          .from('samples')
          .select('pay_status, balance_due')
          .eq('id', sampleId)
          .single();
        if (!checkErr && liveRow && liveRow.pay_status === 'Paid') {
          document.getElementById('settleResultBox').innerHTML =
            `<div style="padding:14px;background:#dcfce7;border-radius:14px;">
               ✓ MU-${sampleId} — ${esc(patient)} — has already been fully paid.
             </div>`;
          document.getElementById('settle-sample-id').value = '';
          toast('Already paid — no action needed', 'warn');
          return;
        }
        // Use the freshest balance from DB in case it changed since lookup
        if (!checkErr && liveRow && liveRow.balance_due != null) {
          balance = parseFloat(liveRow.balance_due) || balance;
        }
      } catch (e) {
        // Network blip — fall through and attempt settlement normally
        console.warn('[AC] confirmSettlement pre-check failed, proceeding', e);
      } finally {
        const b = document.getElementById('settleConfirmBtn');
        if (b) { b.disabled = false; b.innerHTML = `<i class="fas fa-check-circle"></i> Confirm Payment of ${balance.toFixed(2)} NGN`; }
      }
    }
    // ─────────────────────────────────────────────────────────────────────

    if (_settleMode === 'Paystack') {
      const paystackRef = `MU-${sampleId}-BAL-${Date.now()}`;
      const email = `patient${sampleId}@muujiza-lab.com`;
      window._pendingSettle = { sampleId, balance, total, patient };
      const handler = PaystackPop.setup({
        key: PAYSTACK_PUBLIC_KEY, email: email, amount: Math.round(balance * 100),
        currency: 'NGN', ref: paystackRef,
        metadata: { custom_fields: [
          { display_name: 'Sample ID', variable_name: 'sample_id', value: 'MU-' + sampleId },
          { display_name: 'Patient', variable_name: 'patient_name', value: patient },
          { display_name: 'Type', variable_name: 'type', value: 'Balance Settlement' }
        ] },
        // Same fix as the registration flow above: keep this a plain
        // function, do the async work in markSettlementPaidPaystack.
        callback: function (response) { markSettlementPaidPaystack(sampleId, balance, total, patient, response.reference); },
        onClose: () => toast('Paystack window closed. Balance still outstanding.', 'warn')
      });
      handler.openIframe();
      return;
    }
    markSettlementPaid(sampleId, balance, total, patient, _settleMode, `MANUAL-${Date.now()}`);
  };

  // Paystack settlement only — goes through server-side verification since
  // it's a real Paystack transaction that must be confirmed against
  // Paystack's own records before the balance is cleared in the database.
  async function markSettlementPaidPaystack(sampleId, balance, total, patient, reference) {
    const btn = document.getElementById('settleConfirmBtn');
    if (btn) btn.disabled = true;
    toast(`Payment received, verifying with Paystack…`, 'warn');

    const result = await verifyPaystackPayment({
      reference, sampleId, expectedAmount: balance, purpose: 'settlement', fullTotal: total
    });

    if (!result.ok) {
      toast(`Settlement verification failed: ${result.error}. Balance for MU-${sampleId} remains outstanding. Ref: ${reference}`, 'error');
      if (btn) btn.disabled = false;
      return;
    }

    document.getElementById('settle-sample-id').value = '';
    document.getElementById('settleResultBox').style.display = 'none';
    toast(`✓ MU-${sampleId} balance settled – marked as Paid`);
    if (btn) btn.disabled = false;
  }

  // Manual / cash / offline settlement only. There is no Paystack
  // transaction to verify here — a staff member is directly attesting to
  // having received the payment, so the direct DB write stays trusted, same
  // as the rest of this codebase's cash-handling flows.
  function markSettlementPaid(sampleId, balance, total, patient, mode, ref) {
    const btn = document.getElementById('settleConfirmBtn');
    if (btn) btn.disabled = true;

    // Offline: enqueue settlement
    if (!navigator.onLine) {
      if (typeof window._oqEnqueueSettlement === 'function') {
        window._oqEnqueueSettlement(sampleId, total, mode, ref, patient);
        toast(`Settlement saved offline. Will sync when online.`, 'warn');
      } else {
        toast('Offline queue not available – cannot save settlement', 'error');
      }
      document.getElementById('settle-sample-id').value = '';
      document.getElementById('settleResultBox').style.display = 'none';
      if (btn) btn.disabled = false;
      return;
    }

    const now = new Date().toISOString();
    db.from('samples').update({
      pay_status: 'Paid', amount_paid: total, balance_due: 0,
      pay_mode: mode, receipt_no: ref, payment_date: now
    }).eq('id', sampleId)
    .then(() => addAudit('Balance Settled', sampleId, `Mode: ${mode} | Ref: ${ref} | Balance: ${balance} NGN`))
    .then(() => {
      document.getElementById('settle-sample-id').value = '';
      document.getElementById('settleResultBox').style.display = 'none';
      toast(`✓ MU-${sampleId} balance settled – marked as Paid`);
    })
    .catch(err => { toast('Settlement update failed: ' + err.message, 'error'); if(btn) btn.disabled = false; });
  }

  // --------------------------------------------------------------
  //  REJECTED SAMPLES PANEL (with offline cache)
  // --------------------------------------------------------------
  // Reliable online check — OQ's flag is set synchronously on network events,
  // unlike navigator.onLine which can lag by 1-2 seconds after a drop.
  function _acIsOnline() {
    return typeof window._oqIsOnline !== 'undefined' ? window._oqIsOnline : navigator.onLine;
  }

  // Show cached rejected groups with a stale banner — used both for offline guard
  // and catch fallback so the logic is never duplicated.
  async function _showCachedRejected(container) {
    const cached = (typeof window._oqGetCachedRejectedGroups === 'function')
      ? await window._oqGetCachedRejectedGroups().catch(() => null) : null;
    if (cached && cached.length) {
      rejectedGroups = cached;
      renderRejectedPanel();
      // Prepend stale banner after render (renderRejectedPanel sets innerHTML so do it after)
      const staleDiv = document.createElement('div');
      staleDiv.style.cssText = 'font-size:0.72rem;color:var(--text2);text-align:center;padding:4px 0 8px;';
      staleDiv.innerHTML = '<i class="fas fa-wifi" style="opacity:0.4;margin-right:4px;"></i>Offline — showing last cached data';
      container.prepend(staleDiv);
    } else {
      container.innerHTML = `<div style="text-align:center;padding:20px;color:var(--text2);">
        <i class="fas fa-wifi" style="opacity:0.4;"></i>&nbsp; Offline — no cached data yet.</div>`;
    }
  }

  async function loadRejectedSamples() {
    const container = document.getElementById('rejectedPanelBody');
    if (!container) return;

    // Use OQ's reliable online flag — navigator.onLine can lag after a drop
    if (!_acIsOnline()) {
      await _showCachedRejected(container);
      return;
    }

    container.innerHTML = `<div style="text-align:center; padding:20px; color:var(--text2);"><i class="fas fa-spinner fa-pulse"></i> Loading rejected samples...</div>`;

    try {
      const { data: rejectedTests, error: testErr } = await db
        .from('sample_tests')
        .select('id, sample_id, test_name, status, rejection_reason, done_by, done_at, tech_name')
        .eq('status', 'Rejected');

      if (testErr) throw testErr;

      if (!rejectedTests.length) {
        rejectedGroups = [];
        if (typeof window._oqCacheRejectedGroups === 'function') window._oqCacheRejectedGroups([]);
        container.innerHTML = `<div style="text-align:center; padding:20px; color:var(--green);"><i class="fas fa-check-circle"></i> No rejected tests found.</div>`;
        return;
      }

      const sampleIds = [...new Set(rejectedTests.map(t => t.sample_id))];
      const { data: samplesData, error: sampleErr } = await db
        .from('samples')
        .select('id, patient, age, gender, phone, collection_date, status, receipt_no')
        .in('id', sampleIds);

      if (sampleErr) throw sampleErr;

      const sampleMap = {};
      (samplesData || []).forEach(s => { sampleMap[s.id] = s; });

      const groups = {};
      rejectedTests.forEach(t => {
        if (!groups[t.sample_id]) groups[t.sample_id] = [];
        groups[t.sample_id].push(t);
      });

      rejectedGroups = Object.entries(groups).map(([sid, tests]) => ({
        sample: sampleMap[parseInt(sid)] || { id: parseInt(sid), patient: 'Unknown', age: null, gender: null },
        tests
      }));

      // Always cache after a successful fetch
      if (typeof window._oqCacheRejectedGroups === 'function') {
        window._oqCacheRejectedGroups(rejectedGroups);
      }

      renderRejectedPanel();
    } catch (err) {
      console.error('loadRejectedSamples error:', err);
      // On ANY network failure — always try cache, no online condition needed
      await _showCachedRejected(container);
      if (_acIsOnline()) {
        // Only show error toast if we think we're online (real DB error, not connectivity)
        toast('Failed to load rejected samples — showing cached data', 'warn');
      }
    }
  }

  function renderRejectedPanel() {
    const container = document.getElementById('rejectedPanelBody');
    if (!container) return;
    if (!rejectedGroups.length) {
      container.innerHTML = `<div style="text-align:center; padding:20px; color:var(--green);"><i class="fas fa-check-circle"></i> No rejected samples pending recollection.</div>`;
      return;
    }

    let html = '';
    for (let group of rejectedGroups) {
      const s = group.sample;
      const rcpNo = s.receipt_no || '';
      html += `
        <div class="rejected-item" data-receipt="${esc(rcpNo.toLowerCase())}">
          <div class="rejected-header">
            <div>
              <span style="font-family:monospace; font-weight:700; color:var(--primary);">MU-${s.id}</span>
              ${rcpNo ? `<span style="font-family:monospace; font-size:0.65rem; color:#1d4ed8; background:#eff6ff; border:1px solid #bfdbfe; border-radius:5px; padding:1px 6px; margin-left:8px; vertical-align:middle;" title="Receipt / RCP — searchable"><i class="fas fa-receipt" style="margin-right:2px;font-size:0.58rem;"></i>${esc(rcpNo)}</span>` : ''}
              <span style="font-weight:600; margin-left:10px;">${esc(s.patient || '—')}</span>
              <span style="color:var(--text2); font-size:0.82rem; margin-left:8px;">${s.age ?? '?'}y ${esc(s.gender || '')}</span>
            </div>
            <button class="btn btn-primary btn-sm" onclick="resolveRejectedSample(${s.id})">
              <i class="fas fa-undo"></i> Resolve & Re‑enter
            </button>
          </div>
          <div class="rejected-tests">
            ${group.tests.map(t => `
              <div class="rej-test-row">
                <div><i class="fas fa-vial"></i> ${esc(t.test_name)}</div>
                <div class="rejection-reason"><i class="fas fa-ban"></i> ${esc(t.rejection_reason || 'No reason given')}</div>
              </div>
            `).join('')}
          </div>
        </div>
      `;
    }
    container.innerHTML = html;

    // Re-apply any active search term
    const searchInput = document.getElementById('rejectedSearch');
    if (searchInput && searchInput.value.trim()) {
      filterRejectedPanel(searchInput.value);
    }
  }

  window.filterRejectedPanel = function filterRejectedPanel(query) {
    const term = (query || '').toLowerCase().trim();
    const container = document.getElementById('rejectedPanelBody');
    if (!container) return;

    const items = container.querySelectorAll('.rejected-item');
    let visibleCount = 0;

    items.forEach(item => {
      // Also check data-receipt attribute set during render for RCP number search
      const receipt = (item.dataset.receipt || '').toLowerCase();
      const match = !term || item.textContent.toLowerCase().includes(term) || receipt.includes(term);
      item.style.display = match ? '' : 'none';
      if (match) visibleCount++;
    });

    // Show/update "no results" message
    let noResultRow = container.querySelector('.rej-no-results');
    if (!visibleCount && term) {
      if (!noResultRow) {
        noResultRow = document.createElement('div');
        noResultRow.className = 'rej-no-results';
        noResultRow.style.cssText = 'text-align:center; padding:20px; color:var(--text2); font-size:0.88rem;';
        container.appendChild(noResultRow);
      }
      noResultRow.innerHTML = `<i class="fas fa-search" style="margin-right:6px;"></i> No rejected samples match "<strong>${esc(query)}</strong>"`;
    } else if (noResultRow) {
      noResultRow.remove();
    }
  };

  window.resolveRejectedSample = async function(sampleId) {
    if (!confirm('Resolve this sample? The rejected tests will become available for result entry again.')) return;

    // Immediately remove from UI
    rejectedGroups = rejectedGroups.filter(g => g.sample.id !== sampleId);
    renderRejectedPanel();

    // Offline path
    if (!navigator.onLine) {
      if (typeof window._oqCacheRejectedGroups === 'function') {
        window._oqCacheRejectedGroups(rejectedGroups);
      }
      if (typeof window._oqEnqueueResolveRejected === 'function') {
        window._oqEnqueueResolveRejected(sampleId, currentSession.name || 'Reception');
      } else {
        toast('Offline — resolve queued. Will sync when internet returns.', 'warn');
      }
      return;
    }

    // Online path
    try {
      // Fetch ALL tests for this sample first so we can handle every status correctly,
      // regardless of whether the old result_entry stored 'Rejected' on sample_tests or not.
      const { data: allTests, error: fetchErr } = await db
        .from('sample_tests')
        .select('id, status')
        .eq('sample_id', sampleId);
      if (fetchErr) throw fetchErr;

      // Reset only Rejected tests — clear their rejection fields and result so re-entry is clean.
      // We deliberately do NOT touch tests that are already Ready/Verifying/Released —
      // those are done and must keep their results and status.
      for (const t of (allTests || [])) {
        if (t.status === 'Rejected') {
          await db.from('sample_tests')
            .update({ status: 'Processing', rejection_reason: null, result: '', tech_name: '' })
            .eq('id', t.id);
        }
      }

      // Always reset the sample itself back to Processing so it re-appears in result entry.
      await db.from('samples').update({ status: 'Processing' }).eq('id', sampleId);

      const hasDoneTests = allTests && allTests.some(t => t.status === 'Ready' || t.status === 'Verifying');

      // Restore any Verifying tests back to Ready so result entry auto-sends once the
      // resolved test is re-entered.
      for (const t of (allTests || [])) {
        if (t.status === 'Verifying') {
          await db.from('sample_tests')
            .update({ status: 'Ready' })
            .eq('id', t.id);
        }
      }

      if (hasDoneTests) {
        // Sample had some tests already done — send back to Result Entry (step 4)
        await db.from('coc_events')
          .update({ done: false, active: true, actor_name: currentSession.name, occurred_at: new Date().toISOString() })
          .eq('sample_id', sampleId)
          .eq('step_index', 4);
        await db.from('coc_events')
          .update({ done: false, active: false })
          .eq('sample_id', sampleId)
          .gte('step_index', 5);
      } else {
        // No tests were done yet — push back to Processing (step 3)
        await db.from('coc_events')
          .update({ done: false, active: true, actor_name: currentSession.name, occurred_at: new Date().toISOString() })
          .eq('sample_id', sampleId)
          .eq('step_index', 3);
        await db.from('coc_events')
          .update({ done: false, active: false })
          .eq('sample_id', sampleId)
          .gte('step_index', 4);
      }

      await addAudit('Rejection Resolved', sampleId,
        `Resolved by reception — rejected tests set to Processing${hasDoneTests ? '; previously Done tests preserved as Ready' : ''}`);
      toast(`✓ MU-${sampleId} resolved — now available for result entry`);

      await loadRejectedSamples(); // refresh from DB
    } catch (err) {
      console.error(err);
      toast('Failed to resolve sample: ' + err.message, 'error');
      await loadRejectedSamples();
    }
  };

  // --------------------------------------------------------------
  //  RECEIPT MODAL (online & offline)
  // --------------------------------------------------------------
  function showReceiptModal(sample) {
    const modal = document.getElementById('labelModal');
    const content = document.getElementById('labelContent');
    if (!modal || !content) return;

    // Group tests by unit for organised receipt display
    const receiptByUnit = {};
    (sample.tests || []).forEach(t => {
      const tname = t.test_name || t.test || '';
      const u = t.unit_name || 'General';
      if (!receiptByUnit[u]) receiptByUnit[u] = [];
      receiptByUnit[u].push({ name: tname, price: getTestPrice(tname) });
    });
    const testRows = Object.entries(receiptByUnit).map(([unit, tests]) => `
      <div style="margin-bottom:6px;">
        <div style="font-size:0.72rem;font-weight:700;color:var(--primary,#1a6b5a);text-transform:uppercase;letter-spacing:0.5px;padding:3px 0 2px;border-bottom:1px solid #e5e7eb;margin-bottom:3px;">${esc(unit)}</div>
        ${tests.map(t => `<div style="display:flex;justify-content:space-between;padding:2px 0 2px 8px;border-bottom:1px solid #f3f4f6;">
          <span>${esc(t.name)}</span>
          <span>${t.price.toFixed(2)} NGN</span>
        </div>`).join('')}
      </div>`).join('');

    const payClass = sample.paystatus === 'Paid' ? 'pay-paid' : (sample.paystatus === 'Partial' ? 'pay-partial' : 'pay-unpaid');
    const paystackRefLine = sample.paystackRef ? `<p><strong>Paystack Ref:</strong> ${esc(sample.paystackRef)}</p>` : '';
    const paidBanner = sample.paystatus === 'Paid' ? `<div class="pay-paid" style="padding:8px;border-radius:12px;margin-bottom:12px;">✓ Payment Confirmed</div>` : '';

    content.innerHTML = `
      <div style="text-align:left;">
        <canvas id="receiptBarcode" style="display:block;margin:0 auto 12px;"></canvas>
        <h3 style="color:#1F6E43;">MU'UJIZA DIAGNOSTICS</h3>
        <p>Laboratory Information System</p>
        ${paidBanner}
        <p><strong>Receipt No:</strong> ${esc(sample.receiptNo)}</p>
        <p><strong>Sample ID:</strong> MU-${sample.id}</p>
        ${paystackRefLine}
        <p><strong>Patient:</strong> ${esc(sample.patient)}</p>
        <p><strong>Priority:</strong> ${esc(sample.priority)}</p>
        <div>${testRows}</div>
        <div style="background:#f0f7f3;border-radius:12px;padding:10px;margin:12px 0;">
          <div>Total: ${sample.totalAmount.toFixed(2)} NGN</div>
          <div>Paid: ${sample.amountPaid.toFixed(2)} NGN</div>
          <div>Balance: ${sample.balanceDue.toFixed(2)} NGN</div>
          <div>Status: <span class="pay-badge ${payClass}">${esc(sample.paystatus)}</span></div>
        </div>
        <p>${esc(sample.paymode)} &nbsp;|&nbsp; ${new Date(sample.paymentDate).toLocaleString()}</p>
        <div style="display:flex;gap:10px;">
          <button class="btn btn-primary" onclick="window.print()"><i class="fas fa-print"></i> Print</button>
          <button class="btn btn-secondary" onclick="closeLabelModal()">Close</button>
        </div>
      </div>`;
    modal.style.display = 'flex';
    setTimeout(() => { try { JsBarcode('#receiptBarcode', sample.receiptNo, { format:'CODE128', width:2, height:40, displayValue:false }); } catch(e) {} }, 60);
  }

  function showOfflineReceipt(sample) {
    const modal = document.getElementById('labelModal');
    const content = document.getElementById('labelContent');
    if (!modal || !content) return;

    // Group tests by unit for organised offline receipt display
    const offlineByUnit = {};
    (sample.tests || []).forEach(t => {
      const tname = t.test_name || t.test || '';
      const u = t.unit_name || 'General';
      if (!offlineByUnit[u]) offlineByUnit[u] = [];
      offlineByUnit[u].push({ name: tname, price: getTestPrice(tname) });
    });
    const testRows = Object.entries(offlineByUnit).map(([unit, tests]) => `
      <div style="margin-bottom:6px;">
        <div style="font-size:0.72rem;font-weight:700;color:#1a6b5a;text-transform:uppercase;letter-spacing:0.5px;padding:3px 0 2px;border-bottom:1px solid #e5e7eb;margin-bottom:3px;">${esc(unit)}</div>
        ${tests.map(t => `<div style="display:flex;justify-content:space-between;padding:2px 0 2px 8px;">${esc(t.name)} <strong>${t.price.toFixed(2)} NGN</strong></div>`).join('')}
      </div>`).join('');

    content.innerHTML = `
      <div style="text-align:left;">
        <div style="background:#fffbeb;border:1px solid #fde68a;border-radius:12px;padding:10px;margin-bottom:16px;">
          <i class="fas fa-exclamation-triangle"></i> <strong>Offline Draft</strong><br>
          Will sync and get a real MU-ID when internet returns.
        </div>
        <canvas id="receiptBarcode" style="display:block;margin:0 auto 12px;"></canvas>
        <h3 style="color:#1F6E43;">MU'UJIZA DIAGNOSTICS</h3>
        <p>Offline Registration Receipt</p>
        <div style="background:#f0f4ff;border:1px solid #c7d2fe;border-radius:10px;padding:10px;margin-bottom:14px;">
          <strong>Draft Reference:</strong> <span style="font-family:monospace;">${esc(sample.receiptNo)}</span>
          <button onclick="window._copyOfflineDraftRef()" style="margin-left:8px;">Copy</button>
        </div>
        <p><strong>Patient:</strong> ${esc(sample.patient)}</p>
        <p><strong>Priority:</strong> ${esc(sample.priority)} &nbsp;|&nbsp; <strong>Mode:</strong> ${esc(sample.paymode)}</p>
        <div>${testRows}</div>
        <div style="background:#f0f7f3;border-radius:12px;padding:10px;margin:12px 0;">
          <div>Total: ${sample.totalAmount.toFixed(2)} NGN</div>
          <div>Paid: ${sample.amountPaid.toFixed(2)} NGN</div>
          <div>Balance: ${sample.balanceDue.toFixed(2)} NGN</div>
          <div>Status: ${esc(sample.paystatus)}</div>
        </div>
        <p>Saved: ${new Date(sample.paymentDate).toLocaleString()}</p>
        <div style="display:flex;gap:10px;">
          <button class="btn btn-primary" onclick="window.print()">Print</button>
          <button class="btn btn-secondary" onclick="closeLabelModal()">Close</button>
        </div>
      </div>`;
    modal.style.display = 'flex';
    window._currentOfflineDraftRef = sample.receiptNo;
    setTimeout(() => { try { JsBarcode('#receiptBarcode', sample.receiptNo, { format:'CODE128', width:2, height:40, displayValue:false }); } catch(e) {} }, 60);
  }
  window.showOfflineReceipt = showOfflineReceipt;
  window._copyOfflineDraftRef = function() {
    const ref = window._currentOfflineDraftRef;
    if (!ref) return;
    navigator.clipboard?.writeText(ref).then(() => toast('Draft reference copied')).catch(() => toast('Could not copy'));
  };

  window.closeLabelModal = function () {
    const modal = document.getElementById('labelModal');
    if (modal) modal.style.display = 'none';
  };

  // --------------------------------------------------------------
  //  DEFAULT DATES, CLOCK, EVENT LISTENERS
  // --------------------------------------------------------------
  function setDefaultDates() {
    const today = new Date().toISOString().slice(0, 10);
    if (document.getElementById('f-collDate')) document.getElementById('f-collDate').value = today;
    if (document.getElementById('f-collTime')) document.getElementById('f-collTime').value = new Date().toTimeString().slice(0, 5);
    const due = new Date(); due.setDate(due.getDate() + 1);
    if (document.getElementById('f-due')) document.getElementById('f-due').value = due.toISOString().slice(0, 10);
  }

  function startClock() {
    function tick() { document.getElementById('clockDisplay').innerText = new Date().toLocaleTimeString('en-GB'); }
    tick(); setInterval(tick, 1000);
  }

  // Attach event listeners
  document.getElementById('addTestBtn')?.addEventListener('click', addTest);
  document.getElementById('registerBtn')?.addEventListener('click', () => (window.registerSample || registerSample)());
  document.getElementById('clearBtn')?.addEventListener('click', clearForm);
  document.getElementById('f-unit')?.addEventListener('change', updateTests);
  document.getElementById('amountPaid')?.addEventListener('input', updateTotal);
  document.getElementById('f-name')?.addEventListener('input', () => document.getElementById('f-name')?.classList.remove('required-empty'));
  document.getElementById('f-test')?.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addTest(); } });
  document.getElementById('f-unit')?.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addTest(); } });
  document.getElementById('settle-sample-id')?.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); lookupSampleBalance(); } });
  document.getElementById('labelModal')?.addEventListener('click', e => { if (e.target === document.getElementById('labelModal')) closeLabelModal(); });

  // ── Area / Locality loader ────────────────────────────────────────────────
  let _allAreas = [];

  async function loadAreas() {
    const AREA_CACHE_KEY = 'muujiza_areas_cache';
    // Populate from cache immediately so dropdown is ready before DB responds
    try {
      const cached = localStorage.getItem(AREA_CACHE_KEY);
      if (cached) {
        _allAreas = JSON.parse(cached);
        populateAreaSelect(_allAreas);
      }
    } catch (_) {}

    if (!navigator.onLine && _allAreas.length) return;

    try {
      const { data, error } = await db.from('areas').select('name').order('name');
      if (error) throw error;
      _allAreas = (data || []).map(a => a.name);
      populateAreaSelect(_allAreas);
      try { localStorage.setItem(AREA_CACHE_KEY, JSON.stringify(_allAreas)); } catch(_) {}
    } catch (e) {
      console.warn('Could not load areas:', e.message);
      if (!_allAreas.length) {
        const searchEl = document.getElementById('f-area-search');
        if (searchEl) searchEl.placeholder = '⚠ Area list unavailable';
      }
    }
  }

  function populateAreaSelect(areas) {
    const sel = document.getElementById('f-area');
    if (!sel) return;
    const current = sel.value;
    sel.innerHTML = '<option value="">— Select Area —</option>';
    areas.forEach(a => {
      const opt = document.createElement('option');
      opt.value = a; opt.textContent = a;
      sel.appendChild(opt);
    });
    if (current) sel.value = current;
  }

  window.filterAreaDropdown = function() {
    const q = (document.getElementById('f-area-search')?.value || '').toLowerCase();
    const filtered = q ? _allAreas.filter(a => a.toLowerCase().includes(q)) : _allAreas;
    populateAreaSelect(filtered);
    if (filtered.length === 1) {
      document.getElementById('f-area').value = filtered[0];
      const searchEl = document.getElementById('f-area-search');
      if (searchEl) searchEl.value = '';
      populateAreaSelect(_allAreas);
    }
  };



  loadAreas();

  // UI: online/offline button label
  function updateOfflineButtonLabel() {
    const btn = document.getElementById('registerBtn');
    const label = document.getElementById('registerBtnLabel');
    if (!btn || !label) return;
    if (!navigator.onLine) {
      label.innerHTML = '<i class="fas fa-database"></i> Save Offline Draft';
      btn.title = 'Offline – sample will be saved locally and synced later';
    } else {
      label.innerHTML = '<i class="fas fa-syringe"></i> Register & Print Receipt';
      btn.title = '';
    }
  }
  window.addEventListener('online', updateOfflineButtonLabel);
  window.addEventListener('offline', updateOfflineButtonLabel);
  updateOfflineButtonLabel();

  // Reload rejected samples when connection returns
  window.addEventListener('online', () => {
    setTimeout(async () => {
      loadRejectedSamples();
      // Flush any offline-queued samples (registered while offline) to Supabase
      if (typeof window._oqFlush === 'function') {
        try { await window._oqFlush(); } catch(e) { console.warn('[AC] flush on reconnect failed', e); }
      }
    }, 1500);
  });
  window.addEventListener('offline', () => {
    const container = document.getElementById('rejectedPanelBody');
    if (container) container.innerHTML = `<div style="text-align:center; padding:20px; color:var(--text2);"><i class="fas fa-wifi" style="opacity:0.4;"></i> Offline — rejected samples will reload when connection returns.</div>`;
  });

  // Boot
  setDefaultDates();
  startClock();
  loadTestDefinitions();
  loadRejectedSamples();

  // Display logged-in user
  document.getElementById('userDisplay').innerHTML = `<i class="fas fa-user-circle"></i> ${esc(currentSession.name)} (${esc(currentSession.role)})`;
  // ─── Direct offline save (fallback when offline_queue.js not yet loaded) ────
  // Writes to the same IndexedDB stores that offline_queue.js uses, so data
  // syncs normally once the queue script initialises on result_entry or on reload.
  async function _accessionDirectOfflineSave(sampleRow, testRows, registeredBy, paystatus) {
    const DB_NAME    = 'muujiza_offline';
    const DB_VERSION = 8;
    const idb = await new Promise((res, rej) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = e => {
        const d = e.target.result;
        const stores = {
          'outbox':          { keyPath: 'id', autoIncrement: true },
          'samples_cache':   { keyPath: 'id' },
          'meta':            { keyPath: 'key' },
          'test_definitions':{ keyPath: 'id', autoIncrement: true },
          'rejected_groups': { keyPath: 'key' },
          'pending_samples': { keyPath: 'offline_ref' }
        };
        for (const [name, opts] of Object.entries(stores)) {
          if (!d.objectStoreNames.contains(name)) d.createObjectStore(name, opts);
        }
      };
      req.onsuccess = e => res(e.target.result);
      req.onerror   = e => rej(e.target.error);
    });

    const put = (store, val) => new Promise((res, rej) => {
      const tx = idb.transaction(store, 'readwrite');
      const req = tx.objectStore(store).put(val);
      req.onsuccess = () => res(req.result);
      req.onerror   = () => rej(req.error);
    });

    const offlineRef = sampleRow.receipt_no;
    const now = new Date().toISOString();

    // pending_samples — same format as _oqAddPendingSample in offline_queue.js
    await put('pending_samples', { offline_ref: offlineRef, sample: sampleRow, tests: testRows, queued_at: now });

    // samples_cache — so result_entry shows it immediately offline
    await put('samples_cache', {
      id: `OFFLINE-${offlineRef}`,
      patient: sampleRow.patient, age: sampleRow.age, gender: sampleRow.gender,
      priority: sampleRow.priority, status: sampleRow.status,
      tests: testRows.map(({ sample_type: _st, tube: _tb, ...t }) => ({ ...t, sample_id: null, id: null, result: '', tech_name: '', status: 'Collected' })),
      offline_ref: offlineRef, pay_status: paystatus, pay_mode: sampleRow.pay_mode,
      total_amount: sampleRow.total_amount, amount_paid: sampleRow.amount_paid,
      balance_due: sampleRow.balance_due, collection_date: sampleRow.collection_date,
      collection_time: sampleRow.collection_time, registered_by: registeredBy
    });

    // outbox — replay when offline_queue.js next flushes (same payload format)
    await put('outbox', {
      type: 'registerSample',
      payload: {
        sampleRow: JSON.parse(JSON.stringify(sampleRow)),
        testRows:  JSON.parse(JSON.stringify(testRows)),
        registeredBy, paystatus, isPaystack: false, offlineRef
      },
      queued_at: now, attempts: 0
    });

    console.log('[AC] direct offline save OK —', offlineRef);
  }

})();