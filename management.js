(async function () {
  // db and currentSession are set up by the inline <script> in management.html
  const db = window._supabaseClient;
  const currentSession = window.currentSession || window._currentSession;
  // Show current session info
  document.getElementById('sessionRole').textContent = currentSession.role.toUpperCase();
  document.getElementById('sessionName').textContent = currentSession.name;

  let allUsers = [];
  let editingUserId = null;

  // Helper functions
  function escHtml(str) {
    return (str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
  function showToast(msg, type = '') {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.className = `toast show ${type}`;
    setTimeout(() => t.classList.remove('show'), 3500);
  }
  function showModalError(msg) {
    const el = document.getElementById('modalError');
    el.textContent = msg;
    el.classList.add('show');
  }
  function hideModalError() {
    document.getElementById('modalError').classList.remove('show');
  }

  // Load users
  async function loadUsers() {
    const tbody = document.getElementById('userTableBody');
    tbody.innerHTML = `<tr class="loading-row"><td colspan="6"><span class="spinner-inline"></span>Loading users…</td></tr>`;
    const { data, error } = await db.from('admins').select('id, username, role, is_active, created_at').order('created_at', { ascending: false });
    if (error) {
      showToast('Failed to load users: ' + error.message, 'error');
      tbody.innerHTML = `<tr><td colspan="6"><div class="empty-state"><div class="icon">⚠️</div>${escHtml(error.message)}</div></td></tr>`;
      return;
    }
    allUsers = data || [];
    updateStats(allUsers);
    renderTable(allUsers);
  }

  function updateStats(users) {
    document.getElementById('statTotal').textContent = users.length;
    document.getElementById('statActive').textContent = users.filter(u => u.is_active !== false).length;
    document.getElementById('statAdmins').textContent = users.filter(u => u.role === 'admin').length;
    document.getElementById('statPatients').textContent = users.filter(u => u.role === 'patient').length;
  }

  function renderTable(users) {
    const tbody = document.getElementById('userTableBody');
    if (!users.length) {
      tbody.innerHTML = `<tr><td colspan="6"><div class="empty-state"><div class="icon">👥</div>No users found.</div></td></tr>`;
      return;
    }
    tbody.innerHTML = users.map(u => {
      const active = u.is_active !== false;
      const created = u.created_at ? new Date(u.created_at).toLocaleDateString('en-GB', { day:'2-digit', month:'short', year:'numeric' }) : '—';
      const rolePill = `<span class="role-pill role-${escHtml(u.role)}">${escHtml(u.role)}</span>`;
      const statusDot = `<span class="status-dot status-${active ? 'active' : 'inactive'}"></span>${active ? 'Active' : 'Inactive'}`;
      return `<tr><td><strong>${escHtml(u.username)}</strong></td><td><span class="mono">${escHtml(u.username)}</span></td><td>${rolePill}</td><td style="font-size:.8rem">${statusDot}</td><td style="font-size:.78rem;color:var(--muted)">${created}</td><td><div class="action-btns"><button class="icon-btn" title="Edit" onclick="openEditModal('${u.id}')">✏️</button><button class="icon-btn" title="Toggle active" onclick="toggleActive('${u.id}', ${active})">${active ? '🔒' : '🔓'}</button><button class="icon-btn danger" title="Delete" onclick="deleteUser('${u.id}', '${escHtml(u.username)}')">🗑️</button></div></td></tr>`;
    }).join('');
  }

  function getFiltered() {
    const q = document.getElementById('searchInput').value.trim().toLowerCase();
    const role = document.getElementById('roleFilter').value;
    return allUsers.filter(u => (!q || u.username?.toLowerCase().includes(q)) && (!role || u.role === role));
  }

  document.getElementById('searchInput').addEventListener('input', () => renderTable(getFiltered()));
  document.getElementById('roleFilter').addEventListener('change', () => renderTable(getFiltered()));

  function getPasswordStrength(pw) {
    if (!pw || pw.length < 6) return 'weak';
    let score = 0;
    if (pw.length >= 8) score++;
    if (/[A-Z]/.test(pw)) score++;
    if (/[0-9]/.test(pw)) score++;
    if (/[^A-Za-z0-9]/.test(pw)) score++;
    return ['weak','fair','good','strong'][Math.min(score, 3)];
  }
  document.getElementById('mPassword').addEventListener('input', function () {
    const wrap = document.getElementById('pwStrength');
    wrap.className = 'pw-strength';
    if (this.value) wrap.classList.add('strength-' + getPasswordStrength(this.value));
  });

  window.openAddModal = function () {
    editingUserId = null;
    document.getElementById('modalTitle').textContent = 'Add New User';
    document.getElementById('saveUserBtn').textContent = 'Create User';
    document.getElementById('pwLabel').textContent = 'Password';
    document.getElementById('mUsername').value = '';
    document.getElementById('mRole').value = '';
    document.getElementById('mPassword').value = '';
    document.getElementById('mUsername').disabled = false;
    document.getElementById('pwField').style.display = 'block';
    hideModalError();
    document.getElementById('userModal').classList.add('open');
    document.getElementById('mUsername').focus();
  };

  window.openEditModal = function (userId) {
    const u = allUsers.find(x => x.id === userId);
    if (!u) return;
    editingUserId = userId;
    document.getElementById('modalTitle').textContent = 'Edit User';
    document.getElementById('saveUserBtn').textContent = 'Save Changes';
    document.getElementById('pwLabel').textContent = 'New Password (leave blank to keep)';
    document.getElementById('mUsername').value = u.username || '';
    document.getElementById('mRole').value = u.role || '';
    document.getElementById('mPassword').value = '';
    document.getElementById('mUsername').disabled = true;
    document.getElementById('pwField').style.display = 'block';
    hideModalError();
    document.getElementById('userModal').classList.add('open');
    document.getElementById('mUsername').focus();
  };

  window.closeModal = function () {
    document.getElementById('userModal').classList.remove('open');
    editingUserId = null;
  };
  document.getElementById('userModal').addEventListener('click', e => {
    if (e.target === document.getElementById('userModal')) closeModal();
  });

  document.getElementById('saveUserBtn').addEventListener('click', saveUser);

  async function saveUser() {
    const username = document.getElementById('mUsername').value.trim().toLowerCase();
    const role = document.getElementById('mRole').value;
    const password = document.getElementById('mPassword').value;
    if (!role) return showModalError('Please select a role.');
    if (!editingUserId) {
      if (!username) return showModalError('Username is required.');
      if (!/^[a-z0-9._-]+$/.test(username)) return showModalError('Username may only contain letters, numbers, . _ -');
      if (!password) return showModalError('Password is required for new users.');
      if (password.length < 8) return showModalError('Password must be at least 8 characters.');
      if (getPasswordStrength(password) === 'weak') return showModalError('Password is too weak. Add uppercase, numbers, or symbols.');
    }
    const btn = document.getElementById('saveUserBtn');
    btn.disabled = true;
    btn.textContent = 'Saving…';
    hideModalError();
    try {
      if (editingUserId) {
        const updates = { role };
        if (password) {
          if (password.length < 8) throw new Error('Password must be at least 8 characters.');
          const { error: updateError } = await db.rpc('update_user_password', { user_id: editingUserId, new_password: password });
          if (updateError) throw new Error('Password update failed: ' + updateError.message);
        }
        const { error: updateRoleError } = await db.from('admins').update(updates).eq('id', editingUserId);
        if (updateRoleError) throw new Error('Role update failed: ' + updateRoleError.message);
        showToast('User updated successfully.', 'success');
      } else {
        const { data: existing } = await db.from('admins').select('id').eq('username', username).maybeSingle();
        if (existing) throw new Error('Username already taken. Choose a different one.');
        const { error: createError } = await db.rpc('create_user', { p_username: username, p_password: password, p_role: role, p_is_active: true });
        if (createError) throw new Error('Create failed: ' + createError.message);
        showToast(`User "${username}" created successfully.`, 'success');
      }
      closeModal();
      await loadUsers();
    } catch (err) {
      showModalError(err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = editingUserId ? 'Save Changes' : 'Create User';
    }
  }

  window.toggleActive = async function (userId, currentlyActive) {
    const newState = !currentlyActive;
    const { error } = await db.from('admins').update({ is_active: newState }).eq('id', userId);
    if (error) { showToast('Failed to update status.', 'error'); return; }
    showToast(`User ${newState ? 'activated' : 'deactivated'}.`, 'success');
    await loadUsers();
  };

  window.deleteUser = async function (userId, name) {
    if (!confirm(`Delete user "${name}"? This cannot be undone.`)) return;
    const { error } = await db.from('admins').delete().eq('id', userId);
    if (error) { showToast('Delete failed: ' + error.message, 'error'); return; }
    showToast(`User "${name}" deleted.`, 'success');
    await loadUsers();
  };

  document.getElementById('addUserBtn').addEventListener('click', () => window.openAddModal());

  // ========== SAMPLE TRACKING ==========
  let allSamples = [];

  async function loadSamplesForTracking() {
    try {
      const { data, error } = await db.from('samples').select('id, patient, age, gender, priority, status, released_at, collection_date').order('id', { ascending: false }).limit(500);
      if (error) throw error;
      allSamples = data || [];
    } catch (err) {
      console.error(err);
      showToast('Failed to load samples', 'error');
      allSamples = [];
    }
  }

  function getStatusBadgeClass(status) {
    switch(status) {
      case 'Collected': return 'status-collected';
      case 'Processing': return 'status-processing';
      case 'Verifying': return 'status-verifying';
      case 'Result Released': return 'status-released';
      default: return 'status-registered';
    }
  }

  function getStatusDisplay(status) {
    return status === 'Result Released' ? 'Released' : status;
  }

  function renderProgressSteps(sample) {
    const steps = ['Registered', 'Collected', 'Processing', 'Verification', 'Released'];
    let currentStepIndex = 0;
    const status = sample.status;
    if (status === 'Collected') currentStepIndex = 1;
    else if (status === 'Processing') currentStepIndex = 2;
    else if (status === 'Verifying') currentStepIndex = 3;
    else if (status === 'Result Released') currentStepIndex = 4;
    
    let html = `<div class="progress-steps-mini">`;
    steps.forEach((step, idx) => {
      let stepState = '';
      if (idx < currentStepIndex) stepState = 'completed';
      else if (idx === currentStepIndex) stepState = 'active';
      html += `<div class="step-mini ${stepState}"><span class="step-dot"></span><span class="step-label">${step}</span></div>`;
      if (idx < steps.length - 1) html += `<span class="step-arrow"><i class="fas fa-chevron-right"></i></span>`;
    });
    html += `</div>`;
    return html;
  }

  async function renderTrackingTable() {
    await loadSamplesForTracking();
    const search = document.getElementById('trackSearch').value.toLowerCase();
    const filterStatus = document.getElementById('trackStatusFilter').value;
    
    let filtered = allSamples.filter(s => {
      if (search && !s.id.toString().includes(search) && !s.patient.toLowerCase().includes(search)) return false;
      if (filterStatus !== 'all' && s.status !== filterStatus) return false;
      return true;
    });
    
    const statusCounts = { Registered:0, Collected:0, Processing:0, Verifying:0, 'Result Released':0 };
    allSamples.forEach(s => {
      if (statusCounts[s.status] !== undefined) statusCounts[s.status]++;
      else statusCounts.Registered++;
    });
    document.getElementById('trackTotal').textContent = allSamples.length;
    document.getElementById('trackRegistered').textContent = statusCounts.Registered || 0;
    document.getElementById('trackCollected').textContent = statusCounts.Collected || 0;
    document.getElementById('trackProcessing').textContent = statusCounts.Processing || 0;
    document.getElementById('trackVerifying').textContent = statusCounts.Verifying || 0;
    document.getElementById('trackReleased').textContent = statusCounts['Result Released'] || 0;

    const tbody = document.getElementById('trackTableBody');
    if (!tbody) return;
    if (!filtered.length) {
      tbody.innerHTML = `<tr><td colspan="6"><div class="empty-state"><div class="icon">📋</div>No samples match your filters.</div></td></tr>`;
      return;
    }
    tbody.innerHTML = filtered.map(s => {
      const statusClass = getStatusBadgeClass(s.status);
      const statusDisplay = getStatusDisplay(s.status);
      const progressHtml = renderProgressSteps(s);
      const releasedAt = s.released_at ? new Date(s.released_at).toLocaleString() : (s.status === 'Result Released' ? '—' : '—');
      let priorityClass = s.priority === 'STAT' ? 'badge-stat' : s.priority === 'Urgent' ? 'badge-urgent' : 'badge-routine';
      return `<tr>
        <td style="font-family:monospace; font-weight:600;">MU-${s.id}</td>
        <td><strong>${escHtml(s.patient)}</strong><br><small>${s.age || '?'}y</small></td>
        <td><span class="badge ${priorityClass}">${escHtml(s.priority)}</span></td>
        <td><span class="status-badge-sm ${statusClass}">${statusDisplay}</span></td>
        <td style="min-width:260px;">${progressHtml}</td>
        <td style="font-size:.75rem;">${releasedAt}</td>
      </tr>`;
    }).join('');
  }

  if (document.getElementById('trackSearch')) {
    document.getElementById('trackSearch').addEventListener('input', renderTrackingTable);
  }
  if (document.getElementById('trackStatusFilter')) {
    document.getElementById('trackStatusFilter').addEventListener('change', renderTrackingTable);
  }
  if (document.getElementById('trackRefreshBtn')) {
    document.getElementById('trackRefreshBtn').addEventListener('click', renderTrackingTable);
  }

  // ========== AUDIT TRAIL ==========
  let allAuditEntries = [];
  async function loadAuditLog() {
    const tbody = document.getElementById('auditTableBody');
    const countEl = document.getElementById('auditCount');
    if (!tbody) return;
    tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;padding:32px;"><span class="spinner-inline"></span>Loading…</td></tr>`;
    if (countEl) countEl.textContent = '';
    try {
      const { data, error } = await db.from('audit_log').select('ts,user_name,user_role,action,sample_id,details').order('ts', { ascending: false }).limit(500);
      if (error) throw error;
      allAuditEntries = data || [];
      renderAuditTable();
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;padding:32px;color:var(--red);">⚠️ Failed to load audit log: ${escHtml(err.message)}</td><tr>`;
    }
  }
  
  function renderAuditTable() {
    const tbody = document.getElementById('auditTableBody');
    const countEl = document.getElementById('auditCount');
    if (!tbody) return;
    const search = (document.getElementById('auditSearch')?.value || '').toLowerCase();
    const action = document.getElementById('auditActionFilter')?.value || '';
    const role = document.getElementById('auditRoleFilter')?.value || '';
    let filtered = allAuditEntries.filter(e => {
      if (action && !(e.action || '').includes(action)) return false;
      if (role && e.user_role !== role) return false;
      if (search) {
        const hay = [e.user_name, e.user_role, e.action, e.sample_id, e.details].map(x => (x || '').toString().toLowerCase()).join(' ');
        if (!hay.includes(search)) return false;
      }
      return true;
    });
    if (countEl) countEl.textContent = `${filtered.length} record${filtered.length !== 1 ? 's' : ''}`;
    if (!filtered.length) {
      tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;padding:32px;">No audit records match your filters.</td></tr>`;
      return;
    }
    tbody.innerHTML = filtered.map(e => {
      const ts = e.ts ? new Date(e.ts).toLocaleString('en-GB', { day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit', second:'2-digit' }) : '—';
      const roleTag = e.user_role ? `<span class="audit-role-tag">${escHtml(e.user_role)}</span>` : '';
      const sampleCell = e.sample_id ? `<span class="audit-sample">MU-${escHtml(String(e.sample_id))}</span>` : '—';
      return `<tr><td class="audit-ts">${ts}</td><td class="audit-user"><strong>${escHtml(e.user_name || '—')}</strong>${roleTag}</td><td class="audit-action">${escHtml(e.action || '—')}</td><td>${sampleCell}</td><td class="audit-details">${escHtml(e.details || '')}</td></tr>`;
    }).join('');
  }

  if (document.getElementById('auditSearch')) {
    document.getElementById('auditSearch').addEventListener('input', renderAuditTable);
  }
  if (document.getElementById('auditActionFilter')) {
    document.getElementById('auditActionFilter').addEventListener('change', renderAuditTable);
  }
  if (document.getElementById('auditRoleFilter')) {
    document.getElementById('auditRoleFilter').addEventListener('change', renderAuditTable);
  }
  if (document.getElementById('auditRefreshBtn')) {
    document.getElementById('auditRefreshBtn').addEventListener('click', loadAuditLog);
  }

  // Tab switching
  document.querySelectorAll('.page-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.page-tab').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      const panel = document.getElementById('tab-' + btn.dataset.tab);
      if (panel) panel.classList.add('active');
      if (btn.dataset.tab === 'audit') loadAuditLog();
      if (btn.dataset.tab === 'tracking') renderTrackingTable();
      if (btn.dataset.tab === 'analytics') window.renderAnalytics();
    });
  });

  // Initial load — only load the active tab (users) on startup
  // Tracking and audit load on-demand when their tabs are clicked
  await loadUsers();
})();

// ========== PWA Service Worker ==========
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// ═══════════════════════════════════════════════════════════════════════════
// §  SHARED CSV UTILITY FUNCTIONS
//    Available globally for all tab export buttons.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * _csvCell(value) — escapes a single cell value per RFC 4180.
 * Wraps in double-quotes if the value contains comma, quote, or newline.
 */
function _csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  // Always quote so Excel/SPSS/Stata open cleanly without auto-type coercion
  return '"' + s.replace(/"/g, '""') + '"';
}

/**
 * _downloadCsv(filename, rows)
 * rows: array of arrays. Each inner array is one row; values are auto-escaped.
 * Prepends UTF-8 BOM so Excel opens with correct encoding (critical for
 * names with diacritics, Arabic, or Swahili characters).
 */
function _downloadCsv(filename, rows) {
  const BOM = '\uFEFF';
  const csv = BOM + rows.map(r => (r || []).map(_csvCell).join(',')).join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * _csvDate() — compact ISO-style timestamp for filenames: 20250617_1432
 */
function _csvDate() {
  const d = new Date();
  const pad = n => String(n).padStart(2,'0');
  return `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
}

// ═══════════════════════════════════════════════════════════════════════════
// §  CLINICAL ANALYTICS MODULE
//    Reads released samples + test_definitions from Supabase.
//    Unit filter and test selector are populated live from the DB.
// ═══════════════════════════════════════════════════════════════════════════

(function () {
  const _db = window._supabaseClient;

  // ── Live test definitions loaded from test_definitions table ─────────────
  // Structure: { units: { unitName: [testName, ...] }, testTypes: { testName: 'complex_xxx' } }
  let _testDefs = { units: {}, testTypes: {} };
  let _testDefsLoaded = false;

  // ── Analytics dataset cache ───────────────────────────────────────────────
  // renderAnalytics() is called on every filter change and tab click.
  // Fetching released samples + their tests each time gets expensive fast.
  // Cache the raw dataset for 5 minutes; filters and deep-dives run on the
  // cached copy so the DB is only hit when the data is actually stale.
  // The cache also stores the date-filter fingerprint it was built with,
  // since date filters are pushed to the DB query — changing them must
  // invalidate the cache even within the TTL window.
  let _analyticsCache       = null;   // array of mapped sample objects
  let _analyticsCacheTime   = 0;      // Date.now() when cache was filled
  let _analyticsCacheFP     = '';     // date-filter fingerprint baked into cache
  const _ANALYTICS_TTL_MS   = 5 * 60 * 1000; // 5 minutes

  function _analyticsCacheValid(dateFrom, dateTo) {
    const fp = `${dateFrom||''}|${dateTo||''}`;
    return _analyticsCache !== null
      && (Date.now() - _analyticsCacheTime) < _ANALYTICS_TTL_MS
      && _analyticsCacheFP === fp;
  }
  function _analyticsCacheInvalidate() {
    _analyticsCache     = null;
    _analyticsCacheTime = 0;
    _analyticsCacheFP   = '';
  }
  // Expose so the "Refresh" button can bust it from outside
  window._analyticsInvalidateCache = _analyticsCacheInvalidate;
  // ─────────────────────────────────────────────────────────────────────────

  async function _loadTestDefs() {
    if (_testDefsLoaded) return;
    try {
      const { data, error } = await _db.from('test_definitions').select('test_name, unit_name, test_type');
      if (error) throw error;
      _testDefs = { units: {}, testTypes: {} };
      (data || []).forEach(td => {
        if (td.test_name === '__unit_placeholder__') {
          if (!_testDefs.units[td.unit_name]) _testDefs.units[td.unit_name] = [];
          return;
        }
        if (!_testDefs.units[td.unit_name]) _testDefs.units[td.unit_name] = [];
        _testDefs.units[td.unit_name].push(td.test_name);
        if (td.test_type && td.test_type !== 'simple') _testDefs.testTypes[td.test_name] = td.test_type;
      });
      _testDefsLoaded = true;
    } catch (e) {
      console.warn('Analytics: failed to load test_definitions', e);
    }
  }

  // ── Populate Unit filter from loaded test_definitions ────────────────────
  function _populateUnitFilter() {
    const sel = document.getElementById('analyticsUnitFilter');
    if (!sel) return;
    const prev = sel.value;
    sel.innerHTML = '<option value="">All Units</option>';
    Object.keys(_testDefs.units).sort().forEach(u => {
      const o = document.createElement('option');
      o.value = u; o.textContent = u;
      sel.appendChild(o);
    });
    if (prev) sel.value = prev;
  }

  async function _populateAreaFilter() {
    const sel = document.getElementById('analyticsAreaFilter');
    if (!sel) return;
    const prev = sel.value;
    try {
      const { data } = await _db.from('areas').select('name').order('name');
      sel.innerHTML = '<option value="">All Areas</option>';
      (data || []).forEach(a => {
        const o = document.createElement('option');
        o.value = a.name; o.textContent = a.name;
        sel.appendChild(o);
      });
      if (prev) sel.value = prev;
    } catch(e) { console.warn('Could not load areas for filter', e); }
  }

  // ── Reference ranges (gender/age aware) ──────────────────────────────────
  // Used for single-value tests (PCV, Hb, ESR, RBS, FBS) where the range
  // must be resolved dynamically per patient rather than from a fixed PARAM_DEF.
  function _refRange(testName, age, gender) {
    const isMale   = gender === 'Male';
    const isFemale = gender === 'Female';
    switch (testName) {
      case 'PCV': case 'Packed Cell Volume': case 'Hematocrit': case 'HCT':
        return isMale ? {low:40, high:54, unit:'%'} : {low:36, high:46, unit:'%'};
      case 'Hb': case 'Haemoglobin': case 'Hemoglobin':
        return isMale ? {low:13.5, high:17.5, unit:'g/dL'} : {low:12.0, high:15.5, unit:'g/dL'};
      case 'ESR': case 'Erythrocyte Sedimentation Rate':
        return isMale ? {low:0, high:10, unit:'mm/hr'} : {low:0, high:20, unit:'mm/hr'};
      case 'RBS': case 'Random Blood Sugar':  return {low:70, high:140, unit:'mg/dL'};
      case 'FBS': case 'Fasting Blood Sugar': return {low:70, high:100, unit:'mg/dL'};
      default: return null;
    }
  }

  // ── Parameter definitions for numeric panel tests ─────────────────────────
  // Keys and units are kept in sync with pending_portal.js param definitions.
  // Gender-aware ranges on CBC (Hb, HCT) are applied at extraction time.
  const PARAM_DEFS = {

    // ── Full Blood Count ──────────────────────────────────────────────────
    complex_cbc: [
      {key:'wbc',   name:'WBC',         unit:'×10³/µL', low:4.0,  high:11.0},
      {key:'rbc',   name:'RBC',         unit:'×10⁶/µL', low:4.2,  high:5.8},
      {key:'hb',    name:'Haemoglobin', unit:'g/dL',    low:12.0, high:16.0},  // gender-override applied in _extractNumerics
      {key:'hct',   name:'Haematocrit', unit:'%',       low:36,   high:46},    // gender-override applied in _extractNumerics
      {key:'mcv',   name:'MCV',         unit:'fL',      low:80,   high:100},
      {key:'mch',   name:'MCH',         unit:'pg',      low:27,   high:32},
      {key:'mchc',  name:'MCHC',        unit:'g/dL',    low:32,   high:36},
      {key:'plt',   name:'Platelets',   unit:'×10³/µL', low:150,  high:450},
      {key:'neut',  name:'Neutrophils', unit:'%',       low:40,   high:70},
      {key:'lymph', name:'Lymphocytes', unit:'%',       low:20,   high:45},
      {key:'mono',  name:'Monocytes',   unit:'%',       low:2,    high:10},
      {key:'eos',   name:'Eosinophils', unit:'%',       low:1,    high:6},
      {key:'baso',  name:'Basophils',   unit:'%',       low:0,    high:1},
    ],

    // ── Liver Function Test ───────────────────────────────────────────────
    // Keys match pending_portal.js LFT_PARAMS exactly
    complex_lft: [
      {key:'alt',   name:'ALT',             unit:'U/L',   low:10,  high:40},
      {key:'ast',   name:'AST',             unit:'U/L',   low:10,  high:35},
      {key:'alp',   name:'ALP',             unit:'U/L',   low:30,  high:120},
      {key:'ggt',   name:'GGT',             unit:'U/L',   low:7,   high:50},
      {key:'tbil',  name:'Total Bilirubin', unit:'mg/dL', low:0.3, high:1.2},
      {key:'dbil',  name:'Direct Bilirubin',unit:'mg/dL', low:0.0, high:0.3},
      {key:'ibil',  name:'Indirect Bilirubin',unit:'mg/dL',low:0.2,high:0.9},
      {key:'prot',  name:'Total Protein',   unit:'g/dL',  low:6.0, high:8.0},
      {key:'alb',   name:'Albumin',         unit:'g/dL',  low:3.5, high:5.0},
      {key:'glob',  name:'Globulin',        unit:'g/dL',  low:2.0, high:3.5},
    ],

    // ── Renal Function Test ───────────────────────────────────────────────
    // Keys and units match pending_portal.js RFT_PARAMS_FULL exactly (mmol/L)
    complex_rft: [
      {key:'sodium',    name:'Sodium (Na+)',           unit:'mmol/L', low:136,  high:150},
      {key:'potassium', name:'Potassium (K+)',          unit:'mmol/L', low:3.5,  high:5.0},
      {key:'bicarb',    name:'Bicarbonate (HCO3-)',     unit:'mmol/L', low:22,   high:30},
      {key:'chloride',  name:'Chloride (Cl-)',          unit:'mmol/L', low:96,   high:108},
      {key:'urea',      name:'Urea',                    unit:'mmol/L', low:2.1,  high:7.0},
      {key:'creat',     name:'Creatinine',              unit:'mg/dL',  low:0.9,  high:1.5},
      {key:'calcium',   name:'Calcium',                 unit:'mmol/L', low:2.2,  high:2.7},
      {key:'phosphate', name:'Inorganic Phosphate',     unit:'mmol/L', low:0.9,  high:1.6},
    ],

    // ── Thyroid Function Test ─────────────────────────────────────────────
    // Keys match pending_portal.js THYROID_PARAMS (t3/t4, NOT ft3/ft4)
    complex_thyroid: [
      {key:'tsh', name:'TSH', unit:'mIU/L',  low:0.3,  high:4.2},
      {key:'t3',  name:'T3',  unit:'nmol/L', low:1.23, high:3.07},
      {key:'t4',  name:'T4',  unit:'nmol/L', low:66,   high:181},
    ],

    // ── Lipid Profile ─────────────────────────────────────────────────────
    // Keys match pending_portal.js LIPID_PARAMS (mmol/L)
    complex_lipid: [
      {key:'chol',  name:'Total Cholesterol', unit:'mmol/L', low:2.5,  high:6.0},
      {key:'hdl',   name:'HDL-C',             unit:'mmol/L', low:0.91, high:1.43},
      {key:'ldl',   name:'LDL-C',             unit:'mmol/L', low:1.8,  high:4.4},
      {key:'tg',    name:'Triglycerides',      unit:'mmol/L', low:1.8,  high:2.2},
      {key:'vldl',  name:'VLDL',              unit:'mmol/L', low:0.2,  high:0.8},
      {key:'ratio', name:'Total/HDL Ratio',    unit:'',       low:0,    high:5},
    ],

    // ── Coagulation Profile ───────────────────────────────────────────────
    // Expanded to match pending_portal.js COAG_PARAMS
    complex_coag: [
      {key:'pt',            name:'Prothrombin Time',              unit:'sec',   low:11,  high:13.5},
      {key:'inr',           name:'INR',                           unit:'',      low:0.8, high:1.2},
      {key:'aptt',          name:'APTT',                          unit:'sec',   low:25,  high:35},
      {key:'tt',            name:'Thrombin Time',                 unit:'sec',   low:14,  high:21},
      {key:'fibrinogen',    name:'Fibrinogen',                    unit:'mg/dL', low:200, high:400},
      {key:'bleeding_time', name:'Bleeding Time (Ivy)',           unit:'min',   low:1,   high:9},
      {key:'clotting_time', name:'Clotting Time (Lee-White)',     unit:'min',   low:5,   high:10},
      {key:'d_dimer',       name:'D-Dimer',                       unit:'µg/mL', low:0,   high:0.5},
    ],

    // ── Iron Studies ──────────────────────────────────────────────────────
    // Expanded to match pending_portal.js IRON_PARAMS (added UIBC)
    complex_iron: [
      {key:'iron',          name:'Serum Iron',           unit:'µg/dL', low:50,  high:150},
      {key:'tibc',          name:'TIBC',                 unit:'µg/dL', low:250, high:400},
      {key:'uibc',          name:'UIBC',                 unit:'µg/dL', low:150, high:300},
      {key:'transferrinSat',name:'Transferrin Saturation',unit:'%',    low:20,  high:50},
      {key:'ferritin',      name:'Ferritin',             unit:'ng/mL', low:20,  high:300},
    ],

    // ── Cardiac Markers ───────────────────────────────────────────────────
    // Expanded to match pending_portal.js CARDIAC_PARAMS (added TropT, AST)
    complex_cardiac: [
      {key:'ckmb',       name:'CK-MB',       unit:'U/L',   low:0,   high:25},
      {key:'troponinI',  name:'Troponin I',  unit:'ng/mL', low:0,   high:0.04},
      {key:'troponinT',  name:'Troponin T',  unit:'ng/mL', low:0,   high:0.01},
      {key:'ldh',        name:'LDH',         unit:'U/L',   low:100, high:200},
      {key:'ast_cardiac',name:'AST',         unit:'U/L',   low:10,  high:35},
    ],

    // ── OGTT ─────────────────────────────────────────────────────────────
    // Expanded to match pending_portal.js OGTT_PARAMS (added 3-hour point)
    complex_ogtt: [
      {key:'fasting',    name:'Fasting',  unit:'mg/dL', low:70, high:100},
      {key:'one_hour',   name:'1 Hour',   unit:'mg/dL', low:0,  high:180},
      {key:'two_hour',   name:'2 Hours',  unit:'mg/dL', low:0,  high:140},
      {key:'three_hour', name:'3 Hours',  unit:'mg/dL', low:0,  high:120},
    ],

    // ── Diabetes Panel ────────────────────────────────────────────────────
    // NEW — matches pending_portal.js DIABETES_PARAMS exactly
    complex_diabetes: [
      {key:'fbs',   name:'FBS (Fasting Blood Sugar)',   unit:'mmol/L', low:3.0, high:6.0},
      {key:'rbs',   name:'RBS (Random Blood Sugar)',     unit:'mmol/L', low:3.0, high:9.0},
      {key:'hpp2',  name:'2HPP (2-Hour Post-Prandial)', unit:'mmol/L', low:3.0, high:9.0},
      {key:'ogtt',  name:'OGTT',                         unit:'mmol/L', low:3.0, high:7.8},
      {key:'hba1c', name:'HbA1c',                        unit:'%',      low:3.0, high:6.0},
    ],

    // ── Bone Profile ─────────────────────────────────────────────────────
    // NEW — matches pending_portal.js BONE_PARAMS exactly
    complex_bone: [
      {key:'calcium',             name:'Calcium',         unit:'mg/dL', low:8.5, high:10.2},
      {key:'phosphate',           name:'Phosphate',       unit:'mg/dL', low:2.5, high:4.5},
      {key:'alkaline_phosphatase',name:'ALP',             unit:'U/L',   low:30,  high:120},
      {key:'albumin',             name:'Albumin',         unit:'g/dL',  low:3.5, high:5.0},
      {key:'magnesium',           name:'Magnesium',       unit:'mg/dL', low:1.7, high:2.2},
      {key:'vitaminD',            name:'Vitamin D (25-OH)',unit:'ng/mL',low:30,  high:80},
    ],

    // ── Arterial Blood Gas ────────────────────────────────────────────────
    // NEW — matches pending_portal.js ABG_PARAMS exactly
    complex_abg: [
      {key:'ph',          name:'pH',            unit:'',      low:7.35, high:7.45},
      {key:'pco2',        name:'pCO2',          unit:'mmHg',  low:35,   high:45},
      {key:'po2',         name:'pO2',           unit:'mmHg',  low:80,   high:100},
      {key:'hco3',        name:'HCO3',          unit:'mmol/L',low:22,   high:26},
      {key:'base_excess', name:'Base Excess',   unit:'mmol/L',low:-2,   high:2},
      {key:'o2sat',       name:'O2 Saturation', unit:'%',     low:95,   high:100},
      {key:'lactate',     name:'Lactate',       unit:'mmol/L',low:0.5,  high:2.0},
    ],

    // ── Hormone Panel ─────────────────────────────────────────────────────
    // NEW — matches pending_portal.js HORMONE_PARAMS.
    // Ranges are context-dependent (cycle phase, sex); using broad numeric
    // bounds here so values are still extracted and statistically analysed.
    // The deep-dive outlier/histogram views remain useful even without tight ranges.
    complex_hormone: [
      {key:'lh',           name:'LH',           unit:'mIU/mL', low:1.7,  high:95.75},
      {key:'fsh',          name:'FSH',           unit:'mIU/mL', low:1.7,  high:1300},
      {key:'testosterone', name:'Testosterone',  unit:'ng/mL',  low:0.2,  high:9.16},
      {key:'progesterone', name:'Progesterone',  unit:'ng/mL',  low:0.1,  high:51.0},
      {key:'prolactin',    name:'Prolactin',     unit:'ng/mL',  low:3.45, high:25.07},
    ],

    // ── Total Protein ─────────────────────────────────────────────────────
    // NEW — matches pending_portal.js TOTAL_PROTEIN_PARAMS (prot/alb/glob keys)
    complex_total_protein: [
      {key:'prot', name:'Total Protein', unit:'g/dL', low:6.0, high:8.0},
      {key:'alb',  name:'Albumin',       unit:'g/dL', low:3.5, high:5.0},
      {key:'glob', name:'Globulin',      unit:'g/dL', low:2.0, high:3.5},
    ],

    // ── CSF Analysis (numeric params only) ────────────────────────────────
    // Qualitative fields (appearance, gram stain etc.) handled by qualitative path
    complex_csf: [
      {key:'wbc',     name:'WBC',     unit:'/mm³',  low:0,  high:5},
      {key:'rbc',     name:'RBC',     unit:'/mm³',  low:0,  high:0},
      {key:'protein', name:'Protein', unit:'mg/dL', low:15, high:45},
      {key:'glucose', name:'Glucose', unit:'mg/dL', low:40, high:80},
    ],

    // ── Semen Analysis (numeric params only) ──────────────────────────────
    // Qualitative fields (appearance, viscosity etc.) handled by qualitative path
    complex_semen: [
      {key:'volume',    name:'Volume',                     unit:'mL', low:1.5, high:6.0},
      {key:'sperm_count',name:'Sperm Count',               unit:'×10⁶/mL', low:15, high:200},
      {key:'viability', name:'Viability',                  unit:'%',  low:58, high:100},
      {key:'motility_a',name:'Grade A — Progressive Motility', unit:'%', low:32, high:100},
      {key:'motility_b',name:'Grade B — Non-Progressive Motility', unit:'%', low:0, high:100},
      {key:'motility_c',name:'Grade C — Non-Linear Motility',     unit:'%', low:0, high:100},
      {key:'motility_d',name:'Grade D — Immotile',               unit:'%', low:0, high:100},
      {key:'morph_normal',name:'Normal Morphology',              unit:'%', low:4, high:100},
    ],

    // ── Malaria Microscopy (parasite density — numeric only) ──────────────
    complex_malaria: [
      {key:'density', name:'Parasite Density', unit:'parasites/µL', low:0, high:1000000},
    ],

    // ── Urinalysis (numeric params only) ──────────────────────────────────
    // Qualitative dipstick fields handled by qualitative path
    complex_urinalysis: [
      {key:'ph',          name:'pH',              unit:'',    low:5.0,  high:8.0},
      {key:'sg',          name:'Specific Gravity', unit:'',   low:1.005, high:1.030},
      {key:'urobilinogen',name:'Urobilinogen',     unit:'mg/dL', low:0.1, high:1.0},
    ],

    // ── E/U/Cr (Electrolytes, Urea, Creatinine) ────────────────────────────
    // NEW — matches pending_portal.js EUCR_PARAMS exactly (creat/creat_f split)
    complex_eucr: [
      {key:'sodium',    name:'Sodium (Na+)',          unit:'mmol/L', low:136,  high:150},
      {key:'potassium', name:'Potassium (K+)',         unit:'mmol/L', low:3.5,  high:5.0},
      {key:'bicarb',    name:'Bicarbonate (HCO3-)',    unit:'mmol/L', low:22,   high:30},
      {key:'chloride',  name:'Chloride (Cl-)',         unit:'mmol/L', low:96,   high:108},
      {key:'urea',      name:'Urea',                   unit:'mmol/L', low:2.1,  high:7.0},
      {key:'creat',     name:'Creatinine (Male)',      unit:'mg/dL',  low:0.9,  high:1.50},
      {key:'creat_f',   name:'Creatinine (Female)',    unit:'mg/dL',  low:0.7,  high:1.37},
    ],

    // ── Calcium (standalone) ───────────────────────────────────────────────
    // NEW — matches pending_portal.js CALCIUM_PARAMS exactly
    complex_calcium: [
      {key:'calcium', name:'Calcium', unit:'mmol/L', low:2.2, high:2.7},
    ],

    // ── Inorganic Phosphate (standalone) ───────────────────────────────────
    // NEW — matches pending_portal.js PHOSPHATE_PARAMS exactly (adult/children split)
    complex_phosphate: [
      {key:'phosphate_adult',    name:'Inorganic Phosphate (Adult)',    unit:'mmol/L', low:0.9, high:1.6},
      {key:'phosphate_children', name:'Inorganic Phosphate (Children)', unit:'mmol/L', low:1.1, high:2.0},
    ],

    // ── Uric Acid (standalone) ──────────────────────────────────────────────
    // NEW — matches pending_portal.js URIC_ACID_PARAMS exactly (gender split)
    complex_uric_acid: [
      {key:'uric_female', name:'Uric Acid (Female)', unit:'md/dL', low:1.5, high:7.0},
      {key:'uric_male',   name:'Uric Acid (Male)',   unit:'mg/dL', low:1.5, high:7.0},
    ],

    // ── Widal Test (titers — numeric, but flagged via 1:160+ cutoff) ────────
    // NEW — keys match pending_portal.js widal renderer (o/h/ao/ah/bo/bh)
    // Previously fell through to qualitative path, which discards pure
    // numeric values, so Widal results never displayed in the deep dive.
    complex_widal: [
      {key:'o',  name:'S.Typhi O',         unit:'titer', low:0, high:80},
      {key:'h',  name:'S.Typhi H',         unit:'titer', low:0, high:80},
      {key:'ao', name:'S.Paratyphi A (O)', unit:'titer', low:0, high:80},
      {key:'ah', name:'S.Paratyphi A (H)', unit:'titer', low:0, high:80},
      {key:'bo', name:'S.Paratyphi B (O)', unit:'titer', low:0, high:80},
      {key:'bh', name:'S.Paratyphi B (H)', unit:'titer', low:0, high:80},
      {key:'co', name:'S.Paratyphi C (O)', unit:'titer', low:0, high:80},
      {key:'ch', name:'S.Paratyphi C (H)', unit:'titer', low:0, high:80},
    ],

  };

  // ── Resolve test type: live DB first, then fallback pattern matching ───────
  // Patterns kept in sync with pending_portal.js resolveTestType() function.
  function _testType(name) {
    // 1. DB-sourced type takes priority
    if (_testDefs.testTypes[name]) return _testDefs.testTypes[name];

    const n = (name || '').toLowerCase().trim();

    // 2. Named panel patterns
    if (/full\s*blood|complete\s*blood|cbc|fbc/.test(n))              return 'complex_cbc';
    if (/liver\s*function|lft/.test(n))                               return 'complex_lft';
    if (/\be\/u\/cr\b|\beucr\b|\belectrolyte/.test(n))               return 'complex_eucr';
    if (/\buric\s*acid\b/.test(n))                                    return 'complex_uric_acid';
    if (/\binorganic\s*phosphate\b|\bphosphate\b/.test(n))           return 'complex_phosphate';
    if (/\bcalcium\b/.test(n))                                        return 'complex_calcium';
    if (/renal\s*function|rft|kidney/.test(n))                        return 'complex_rft';
    if (/thyroid|tsh/.test(n))                                        return 'complex_thyroid';
    if (/lipid|cholesterol/.test(n))                                  return 'complex_lipid';
    if (/coagul|prothrombin|pt\/inr|coag/.test(n))                   return 'complex_coag';
    if (/iron\s*stud|iron\s*prof|serum\s*iron/.test(n))              return 'complex_iron';
    if (/cardiac|troponin|ckmb/.test(n))                              return 'complex_cardiac';
    if (/ogtt|glucose\s*tolerance/.test(n))                           return 'complex_ogtt';
    if (/\bdiabetes\b/.test(n))                                       return 'complex_diabetes';
    if (/\bone\s*profile\b|\bbone\b/.test(n))                        return 'complex_bone';
    if (/arterial\s*blood\s*gas|\babg\b/.test(n))                    return 'complex_abg';
    if (/\bhormone\b|\bhormonal\b/.test(n))                          return 'complex_hormone';
    if (/\btotal\s*protein\b/.test(n))                               return 'complex_total_protein';
    if (/\bcsf\b/.test(n))                                           return 'complex_csf';
    if (/semen\s*analysis|seminal/.test(n))                          return 'complex_semen';
    if (/\bmalaria\s*microscopy\b/.test(n))                          return 'complex_malaria';
    if (/\burinalysis\b|\burine\s*analysis\b/.test(n))               return 'complex_urinalysis';
    if (/\bwidal\b/.test(n))                                         return 'complex_widal';
    if (/\bserology\b|\bhbv\s*profile\b|\bhepatitis\b/.test(n))     return 'complex_serology';
    if (/\bculture\b/.test(n))                                       return 'complex_culture';
    if (/\btb\s*genexpert\b|\bgenexpert\b/.test(n))                 return 'complex_tb_genexpert';
    if (/packed\s*cell|pcv/.test(n))                                 return 'complex_pcv';
    if (/haemoglobin|hemoglobin|\bhb\b/.test(n))                    return 'complex_hb';
    if (/esr|sedimentation/.test(n))                                 return 'complex_esr';
    if (/random\s*blood\s*sugar|rbs/.test(n))                       return 'complex_rbs';
    if (/fasting\s*blood\s*sugar|fbs/.test(n))                      return 'complex_fbs';

    return 'simple';
  }

  // ── Extract numeric data points from a result JSON ───────────────────────
  function _extractNumerics(testName, resultJson, age, gender) {
    if (!resultJson || !resultJson.startsWith('{')) return [];
    let d;
    try { d = JSON.parse(resultJson); } catch(e) { return []; }
    const tt  = _testType(testName);
    const out = [];

    // Single-value tests — gender/age-aware range from _refRange()
    const single = { complex_pcv:'pcv', complex_hb:'hb', complex_esr:'esr', complex_rbs:'rbs', complex_fbs:'fbs' };
    if (single[tt]) {
      const key = single[tt];
      const val = parseFloat(d[key]);
      if (!isNaN(val)) {
        const rr = _refRange(testName, age, gender) || {low:0, high:100, unit:''};
        out.push({ param: testName, key, val, unit: rr.unit, low: rr.low, high: rr.high });
      }
      return out;
    }

    // Multi-param panels
    const params = PARAM_DEFS[tt] || [];
    params.forEach(p => {
      const val = parseFloat(d[p.key]);
      if (!isNaN(val)) {
        // Gender-aware overrides for CBC Hb and HCT
        let low = p.low, high = p.high;
        if (tt === 'complex_cbc' && p.key === 'hb') {
          low  = gender === 'Male' ? 13.5 : 12.0;
          high = gender === 'Male' ? 17.5 : 15.5;
        }
        if (tt === 'complex_cbc' && p.key === 'hct') {
          low  = gender === 'Male' ? 40 : 36;
          high = gender === 'Male' ? 54 : 46;
        }
        out.push({ param: p.name, key: p.key, val, unit: p.unit, low, high });
      }
    });
    return out;
  }

  // ── Age bucketing ─────────────────────────────────────────────────────────
  function _ageGroup(age) {
    const a = parseInt(age);
    if (isNaN(a) || a < 0) return 'Unknown';
    if (a < 5)  return '0–4';
    if (a < 13) return '5–12';
    if (a < 18) return '13–17';
    if (a < 30) return '18–29';
    if (a < 45) return '30–44';
    if (a < 60) return '45–59';
    if (a < 75) return '60–74';
    return '75+';
  }

  // Returns the relevant tests for a sample, filtered by unit if active.
  // unitFilt passed explicitly so this works both inside renderAnalytics
  // and in the export handler which lives at the same IIFE scope level.
  function _testsForUnit(s, unitFilt) {
    if (!unitFilt) return (s.tests || []).filter(t => t.status !== 'Rejected');
    const unitTests = new Set(_testDefs.units[unitFilt] || []);
    return (s.tests || []).filter(t => unitTests.has(t.test_name) && t.status !== 'Rejected');
  }

  function esc(s) {
    return (s == null ? '' : String(s)).replace(/[&<>"']/g, m =>
      ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
  }

  // ── Populate test selector grouped by unit ────────────────────────────────
  function _populateTestSelect(samples) {
    // Build set of test names that have actual released results
    const withResults = new Set();
    samples.forEach(s => (s.tests || []).forEach(t => {
      if (t.result && t.result.trim() && t.status !== 'Rejected') withResults.add(t.test_name);
    }));

    const sel = document.getElementById('analyticsTestSelect');
    if (!sel) return;
    const prev = sel.value;
    const unitFilt = document.getElementById('analyticsUnitFilter')?.value || '';

    sel.innerHTML = '<option value="">— Select a test for deep dive —</option>';

    // If we have unit definitions from DB, group by unit
    const unitKeys = Object.keys(_testDefs.units).sort();
    if (unitKeys.length) {
      unitKeys.forEach(unitName => {
        if (unitFilt && unitName !== unitFilt) return;
        const testsInUnit = (_testDefs.units[unitName] || [])
          .filter(t => withResults.has(t))
          .sort();
        if (!testsInUnit.length) return;
        const grp = document.createElement('optgroup');
        grp.label = unitName;
        testsInUnit.forEach(t => {
          const o = document.createElement('option');
          o.value = t; o.textContent = t;
          grp.appendChild(o);
        });
        sel.appendChild(grp);
      });
      // Also include any tests with results that aren't in any unit definition
      const allDefinedTests = new Set(unitKeys.flatMap(u => _testDefs.units[u] || []));
      const ungrouped = [...withResults].filter(t => !allDefinedTests.has(t)).sort();
      if (ungrouped.length && !unitFilt) {
        const grp = document.createElement('optgroup');
        grp.label = 'Other';
        ungrouped.forEach(t => {
          const o = document.createElement('option'); o.value = t; o.textContent = t; grp.appendChild(o);
        });
        sel.appendChild(grp);
      }
    } else {
      // Fallback: flat list if test_definitions not loaded
      [...withResults].sort().forEach(n => {
        const o = document.createElement('option');
        o.value = n; o.textContent = n;
        sel.appendChild(o);
      });
    }

    if (prev && [...sel.options].some(o => o.value === prev)) sel.value = prev;
  }

  // ── MAIN RENDERER ─────────────────────────────────────────────────────────
  window.renderAnalytics = async function () {
    const wrap = document.getElementById('analyticsContent');
    if (!wrap) return;

    wrap.innerHTML = `<div class="analytics-empty"><div style="font-size:2rem;margin-bottom:10px;">⏳</div><div style="color:var(--muted);font-size:.85rem;">Loading data…</div></div>`;

    // Load test_definitions from DB first (populates unit filter + test type resolver)
    await _loadTestDefs();
    _populateUnitFilter();
    await _populateAreaFilter();

    // Fetch released samples with their tests — use cache when fresh.
    // We paginate in batches of 1000 so the full dataset is always fetched
    // regardless of total volume, not just the most recent 1000 rows.
    // Date filters are pushed server-side so a researcher filtering
    // "January 2024" never silently fetches the wrong rows.
    let samples = [];
    try {
      if (_analyticsCacheValid(dateFrom, dateTo)) {
        samples = _analyticsCache;
      } else {
        // Read date filters now so they can be applied at DB level
        const dateFrom = document.getElementById('analyticsDateFrom')?.value || '';
        const dateTo   = document.getElementById('analyticsDateTo')?.value   || '';

        const PAGE = 1000;
        let page = 0, done = false;
        const allRows = [];

        while (!done) {
          let q = _db
            .from('samples')
            .select('id,patient,age,gender,area,collection_date,status,sample_tests(id,test_name,status,result)')
            .eq('status', 'Result Released')
            .order('id', { ascending: false })
            .range(page * PAGE, (page + 1) * PAGE - 1);

          if (dateFrom) q = q.gte('collection_date', dateFrom);
          if (dateTo)   q = q.lte('collection_date', dateTo);

          const { data, error } = await q;
          if (error) throw error;

          allRows.push(...(data || []));
          if (!data || data.length < PAGE) done = true;
          else page++;
        }

        samples = allRows.map(s => ({
          ...s,
          collDate: s.collection_date,
          tests: s.sample_tests || []
        }));
        _analyticsCache     = samples;
        _analyticsCacheTime = Date.now();
        _analyticsCacheFP   = `${dateFrom||''}|${dateTo||''}`;
      }
    } catch (err) {
      wrap.innerHTML = `<div class="analytics-empty" style="color:var(--red);">⚠️ Failed to load data: ${esc(err.message)}</div>`;
      return;
    }

    // Filter samples that have at least one result
    const withResults = samples.filter(s =>
      (s.tests || []).some(t => t.result && t.result.trim() && t.status !== 'Rejected')
    );

    _populateTestSelect(withResults);

    // Read filter values
    const dateFrom   = document.getElementById('analyticsDateFrom')?.value  || '';
    const dateTo     = document.getElementById('analyticsDateTo')?.value    || '';
    const genderFilt = document.getElementById('analyticsGender')?.value    || 'all';
    const ageMin     = parseInt(document.getElementById('analyticsAgeMin')?.value)  || 0;
    const ageMax     = parseInt(document.getElementById('analyticsAgeMax')?.value)  || 999;
    const unitFilt   = document.getElementById('analyticsUnitFilter')?.value || '';
    const areaFilt   = document.getElementById('analyticsAreaFilter')?.value || '';
    const testFilt   = document.getElementById('analyticsTestSelect')?.value || '';

    // Apply filters (demographic + unit + area)
    let filtered = withResults.filter(s => {
      if (dateFrom && (s.collDate || '') < dateFrom) return false;
      if (dateTo   && (s.collDate || '') > dateTo)   return false;
      if (genderFilt !== 'all' && s.gender !== genderFilt) return false;
      const a = parseInt(s.age);
      if (!isNaN(a) && (a < ageMin || a > ageMax)) return false;
      if (areaFilt && (s.area || '') !== areaFilt) return false;
      // Unit filter: keep sample only if it has at least one test from that unit
      if (unitFilt) {
        const unitTests = new Set(_testDefs.units[unitFilt] || []);
        const hasUnitTest = (s.tests || []).some(t => unitTests.has(t.test_name) && t.status !== 'Rejected' && t.result);
        if (!hasUnitTest) return false;
      }
      return true;
    });

    // When unit filter is active, only count tests from that unit
    // (_testsForUnit is defined at module level below for shared use)

    if (!filtered.length) {
      wrap.innerHTML = `<div class="analytics-empty">
        <div style="font-size:2rem;margin-bottom:10px;">🔍</div>
        <div style="font-weight:600;margin-bottom:6px;">No results found</div>
        <div style="font-size:.82rem;color:var(--muted);">No released results match your filters. Try widening the date range or demographic filters.</div>
      </div>`;
      return;
    }

    // ── Summary stats ──────────────────────────────────────────────────────
    const gCount  = { Male:0, Female:0, Other:0 };
    const ageBkts = {};
    filtered.forEach(s => {
      const g = s.gender === 'Male' ? 'Male' : s.gender === 'Female' ? 'Female' : 'Other';
      gCount[g]++;
      const b = _ageGroup(s.age);
      ageBkts[b] = (ageBkts[b] || 0) + 1;
    });
    const totalTests = filtered.reduce((sum, s) => sum + _testsForUnit(s, unitFilt).length, 0);

    const unitLabel = unitFilt ? ` · Unit: ${esc(unitFilt)}` : '';
    const summaryHtml = `
      <div class="analytics-summary-strip">
        <div class="analytics-summary-card"><div class="val">${filtered.length}</div><div class="lbl">Patients</div></div>
        <div class="analytics-summary-card"><div class="val" style="color:#2563eb;">${gCount.Male}</div><div class="lbl">Male</div></div>
        <div class="analytics-summary-card"><div class="val" style="color:#db2777;">${gCount.Female}</div><div class="lbl">Female</div></div>
        <div class="analytics-summary-card"><div class="val">${totalTests}</div><div class="lbl">Tests${unitLabel}</div></div>
      </div>`;

    // ── Gender donut (CSS conic-gradient) ──────────────────────────────────
    const mPct = Math.round((gCount.Male   / filtered.length) * 100);
    const fPct = Math.round((gCount.Female / filtered.length) * 100);
    const oPct = 100 - mPct - fPct;
    const donutStyle = `background:conic-gradient(#2563eb 0% ${mPct}%, #db2777 ${mPct}% ${mPct+fPct}%, #94a3b8 ${mPct+fPct}% 100%);width:90px;height:90px;border-radius:50%;margin:0 auto 10px;`;

    // ── Age bar chart ──────────────────────────────────────────────────────
    const ageOrder = ['0–4','5–12','13–17','18–29','30–44','45–59','60–74','75+','Unknown'];
    const ageMax2  = Math.max(...Object.values(ageBkts), 1);
    const ageBarsHtml = ageOrder.filter(g => ageBkts[g]).map(g => {
      const pct = Math.round((ageBkts[g] / ageMax2) * 100);
      return `<div class="analytics-bar-row">
        <span style="width:50px;font-size:.72rem;color:var(--muted);">${g}</span>
        <div class="analytics-bar-track"><div class="analytics-bar-fill" style="width:${pct}%;background:var(--green);"></div></div>
        <span style="font-size:.75rem;font-weight:700;color:var(--green);min-width:22px;">${ageBkts[g]}</span>
      </div>`;
    }).join('');

    const chartsHtml = `
      <div class="analytics-charts-row">
        <div class="analytics-chart-card">
          <div class="analytics-section-title">Gender Distribution</div>
          <div style="${donutStyle}"></div>
          <div style="display:flex;justify-content:center;gap:16px;font-size:.75rem;flex-wrap:wrap;">
            <span><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:#2563eb;margin-right:4px;"></span>Male ${mPct}%</span>
            <span><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:#db2777;margin-right:4px;"></span>Female ${fPct}%</span>
            ${oPct > 0 ? `<span><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:#94a3b8;margin-right:4px;"></span>Other ${oPct}%</span>` : ''}
          </div>
        </div>
        <div class="analytics-chart-card">
          <div class="analytics-section-title">Age Group Distribution</div>
          ${ageBarsHtml || '<div style="color:var(--muted);font-size:.8rem;">No age data.</div>'}
        </div>
      </div>`;

    // ── Most-requested tests ───────────────────────────────────────────────
    const testFreq = {};
    filtered.forEach(s => _testsForUnit(s, unitFilt).forEach(t => {
      testFreq[t.test_name] = (testFreq[t.test_name] || 0) + 1;
    }));
    const topTests = Object.entries(testFreq).sort((a,b) => b[1]-a[1]).slice(0, 12);
    const maxFreq  = topTests[0]?.[1] || 1;

    const testFreqHtml = `
      <div class="analytics-chart-card" style="margin-bottom:20px;">
        <div class="analytics-section-title">Most Requested Tests <span style="font-size:.65rem;font-weight:400;">(click to deep-dive)</span></div>
        ${topTests.map(([name, cnt]) => `
          <div class="analytics-test-bar" onclick="document.getElementById('analyticsTestSelect').value=${JSON.stringify(name)};window.renderAnalytics();">
            <div class="analytics-test-bar-name" title="${esc(name)}">${esc(name)}</div>
            <div class="analytics-test-bar-track"><div class="analytics-test-bar-fill" style="width:${Math.round((cnt/maxFreq)*100)}%;"></div></div>
            <div class="analytics-test-bar-count">${cnt}</div>
          </div>`).join('')}
      </div>`;

    // ── Abnormality rates overview ─────────────────────────────────────────
    const abnRates = {};
    filtered.forEach(s => {
      (s.tests || []).forEach(t => {
        if (t.status === 'Rejected' || !t.result) return;
        const nums = _extractNumerics(t.test_name, t.result, s.age, s.gender);
        if (!nums.length) return;
        if (!abnRates[t.test_name]) abnRates[t.test_name] = { abn: 0, total: 0 };
        nums.forEach(n => {
          abnRates[t.test_name].total++;
          if (n.val > n.high || n.val < n.low) abnRates[t.test_name].abn++;
        });
      });
    });
    const abnEntries = Object.entries(abnRates).filter(([,v]) => v.total > 0)
      .sort((a,b) => (b[1].abn/b[1].total) - (a[1].abn/a[1].total)).slice(0, 10);

    let abnHtml = '';
    if (abnEntries.length) {
      abnHtml = `<div class="analytics-chart-card" style="margin-bottom:20px;">
        <div class="analytics-section-title">Abnormality Rate by Test (numeric results only)</div>
        ${abnEntries.map(([name, v]) => {
          const pct = Math.round((v.abn / v.total) * 100);
          const col  = pct > 30 ? '#b91c1c' : pct > 10 ? '#d97706' : '#15803d';
          const bg   = pct > 30 ? '#fee2e2' : pct > 10 ? '#fef3c7' : '#dcfce7';
          return `<div style="display:flex;align-items:center;gap:10px;padding:4px 0;">
            <div style="width:180px;font-size:.78rem;color:var(--slate);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${esc(name)}">${esc(name)}</div>
            <div style="flex:1;background:#e5e7eb;border-radius:20px;height:10px;overflow:hidden;">
              <div style="height:100%;background:${col};border-radius:20px;width:${pct}%;"></div>
            </div>
            <span class="analytics-abn-pill" style="background:${bg};color:${col};">${pct}%</span>
            <span style="font-size:.68rem;color:var(--muted);">${v.abn}/${v.total}</span>
          </div>`;
        }).join('')}
      </div>`;
    }

    // ── Per-test deep dive ─────────────────────────────────────────────────
    let deepDiveHtml = '';
    if (testFilt) {
      const paramMap = {};
      filtered.forEach(s => {
        const t = (s.tests || []).find(x => x.test_name === testFilt && x.status !== 'Rejected' && x.result);
        if (!t) return;
        _extractNumerics(testFilt, t.result, s.age, s.gender).forEach(n => {
          if (!paramMap[n.key]) paramMap[n.key] = { name: n.param, unit: n.unit, low: n.low, high: n.high, vals: [], abn: 0, normal: 0 };
          paramMap[n.key].vals.push({ val: n.val, age: parseInt(s.age)||0, gender: s.gender, patient: s.patient, id: s.id, date: s.collDate });
          if (n.val > n.high || n.val < n.low) paramMap[n.key].abn++;
          else paramMap[n.key].normal++;
        });
      });

      const paramCards = Object.values(paramMap).map(p => {
        if (!p.vals.length) return '';
        const vals   = p.vals.map(x => x.val);
        const n      = vals.length;
        const mean   = vals.reduce((a,b)=>a+b,0) / n;
        const sorted = [...vals].sort((a,b)=>a-b);
        const median = sorted.length % 2 === 0
          ? (sorted[n/2-1]+sorted[n/2])/2 : sorted[Math.floor(n/2)];
        const sd     = Math.sqrt(vals.reduce((a,b)=>a+(b-mean)**2,0)/n);
        const minV   = Math.min(...vals);
        const maxV   = Math.max(...vals);
        const pctAbn = Math.round((p.abn/n)*100);

        // Gender split
        const mVals = p.vals.filter(x=>x.gender==='Male').map(x=>x.val);
        const fVals = p.vals.filter(x=>x.gender==='Female').map(x=>x.val);
        const mMean = mVals.length ? (mVals.reduce((a,b)=>a+b,0)/mVals.length).toFixed(2) : '—';
        const fMean = fVals.length ? (fVals.reduce((a,b)=>a+b,0)/fVals.length).toFixed(2) : '—';

        // Histogram
        const bins   = 8;
        const range  = maxV - minV || 1;
        const bSize  = range / bins;
        const bCnts  = Array(bins).fill(0);
        vals.forEach(v => { const i = Math.min(Math.floor((v-minV)/bSize), bins-1); bCnts[i]++; });
        const bMax   = Math.max(...bCnts, 1);
        const histHtml = bCnts.map((cnt, i) => {
          const label = (minV + i * bSize).toFixed(1);
          const h     = Math.round((cnt/bMax)*70);
          const inRef = (minV + i * bSize) >= p.low && (minV + i * bSize) <= p.high;
          return `<div class="analytics-hist-col">
            <div class="h-cnt">${cnt||''}</div>
            <div class="h-bar" style="height:${h}px;background:${inRef?'#10b981':'#f87171'};"></div>
            <div class="h-lbl">${label}</div>
          </div>`;
        }).join('');

        // Age group table
        const ageGrpMap = {};
        p.vals.forEach(x => {
          const g = _ageGroup(x.age);
          if (!ageGrpMap[g]) ageGrpMap[g] = [];
          ageGrpMap[g].push(x.val);
        });
        const ageRowsHtml = Object.entries(ageGrpMap).map(([grp, vs]) => {
          const gm  = (vs.reduce((a,b)=>a+b,0)/vs.length).toFixed(2);
          const ga  = vs.filter(v=>v>p.high||v<p.low).length;
          const gp  = Math.round((ga/vs.length)*100);
          const col = gp>30?'#b91c1c':gp>10?'#d97706':'#15803d';
          return `<tr>
            <td>${esc(grp)}</td>
            <td style="text-align:center;">${vs.length}</td>
            <td style="text-align:center;">${gm} ${esc(p.unit)}</td>
            <td style="text-align:center;font-weight:600;color:${col};">${gp}%</td>
          </tr>`;
        }).join('');

        // Results table — every patient result for this parameter, normal and abnormal,
        // sorted with the most abnormal (largest deviation) first
        const outliers = [...p.vals]
          .sort((a,b) => {
            const da = a.val>p.high ? a.val-p.high : a.val<p.low ? p.low-a.val : 0;
            const db = b.val>p.high ? b.val-p.high : b.val<p.low ? p.low-b.val : 0;
            return db - da;
          });
        const outlierRowsHtml = outliers.map(x => {
          const isHigh = x.val > p.high, isLow = x.val < p.low;
          const flag = isHigh ? '↑ HIGH' : isLow ? '↓ LOW' : 'Normal';
          const col  = isHigh ? '#b91c1c' : isLow ? '#2563eb' : '#15803d';
          return `<tr>
            <td style="font-family:monospace;font-size:.75rem;">MU-${x.id}</td>
            <td style="font-size:.78rem;">${esc(x.patient)}</td>
            <td style="font-size:.75rem;">${esc(x.gender)}, ${x.age}y</td>
            <td style="font-weight:700;color:${col};font-size:.78rem;">${x.val} <small>${flag}</small></td>
            <td style="font-size:.72rem;color:var(--muted);">${x.date||'—'}</td>
          </tr>`;
        }).join('');

        return `<div class="analytics-param-card">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:8px;margin-bottom:14px;">
            <div>
              <div style="font-weight:700;font-size:.95rem;color:var(--green);">${esc(p.name)}</div>
              <div style="font-size:.72rem;color:var(--muted);">Ref: ${p.low}–${p.high} ${esc(p.unit)} &nbsp;·&nbsp; n = ${n}</div>
            </div>
            <div style="display:flex;gap:6px;flex-wrap:wrap;">
              <span class="analytics-abn-pill" style="background:#dcfce7;color:#15803d;">${100-pctAbn}% Normal</span>
              ${pctAbn>0?`<span class="analytics-abn-pill" style="background:#fee2e2;color:#b91c1c;">${pctAbn}% Abnormal</span>`:''}
            </div>
          </div>

          <div class="analytics-stat-chips">
            ${[['Mean',mean.toFixed(2),''],['Median',median.toFixed(2),''],['SD',sd.toFixed(2),''],
               ['Min',minV.toFixed(2),minV<p.low?'color:#2563eb':''],
               ['Max',maxV.toFixed(2),maxV>p.high?'color:#b91c1c':'']].map(([l,v,s])=>
              `<div class="analytics-stat-chip">
                <div class="chip-val" style="${s||'color:var(--green)'}">${v}</div>
                <div class="chip-lbl">${l} ${esc(p.unit)}</div>
              </div>`).join('')}
          </div>

          <div class="analytics-two-col">
            <div class="analytics-inner-card">
              <div class="analytics-inner-title">Mean by Gender</div>
              ${[['Male','#2563eb',mMean,mVals.length],['Female','#db2777',fMean,fVals.length]].map(([g,c,m,cnt])=>`
                <div class="analytics-bar-row">
                  <span style="width:52px;font-size:.78rem;color:${c};font-weight:600;">${g}</span>
                  <div class="analytics-bar-track">
                    <div class="analytics-bar-fill" style="width:${cnt?Math.min(100,(parseFloat(m)/(p.high*1.5))*100):0}%;background:${c};"></div>
                  </div>
                  <span style="font-size:.78rem;font-weight:700;min-width:70px;text-align:right;">${m} ${esc(p.unit)}</span>
                </div>`).join('')}
              <div style="font-size:.65rem;color:var(--muted);margin-top:6px;">Ref: ${p.low}–${p.high} ${esc(p.unit)}</div>
            </div>
            <div class="analytics-inner-card">
              <div class="analytics-inner-title">Distribution <span style="font-weight:400;font-size:.6rem;">🟢 in range &nbsp; 🔴 out</span></div>
              <div class="analytics-hist-wrap">${histHtml}</div>
            </div>
          </div>

          ${ageRowsHtml ? `
          <div style="margin-bottom:12px;">
            <div class="analytics-inner-title">By Age Group</div>
            <div style="border:1px solid var(--border);border-radius:10px;overflow:hidden;">
              <table class="analytics-age-table">
                <thead><tr><th>Age Group</th><th>n</th><th>Mean</th><th>% Abnormal</th></tr></thead>
                <tbody>${ageRowsHtml}</tbody>
              </table>
            </div>
          </div>` : ''}

          ${outlierRowsHtml ? `
          <div>
            <div class="analytics-inner-title">All Results (${outliers.length})</div>
            <div style="border:1px solid var(--border);border-radius:10px;overflow:hidden;overflow-x:auto;max-height:340px;overflow-y:auto;">
              <table class="analytics-age-table">
                <thead><tr style="position:sticky;top:0;background:#fff;z-index:1;"><th>Sample</th><th>Patient</th><th>Demographics</th><th>Value</th><th>Date</th></tr></thead>
                <tbody>${outlierRowsHtml}</tbody>
              </table>
            </div>
          </div>` : ''}
        </div>`;
      }).join('');

      // ── Qualitative deep dive (if no numeric params found) ────────────────
      if (!paramCards) {
        const qualMap = {};
        const QUAL_PARAM_NAMES = {
          // Serology
          hbsag:'HBsAg', anti_hbs:'Anti-HBs', hbeag:'HBeAg', anti_hbe:'Anti-HBe', anti_hbc:'Anti-HBc',
          hcv:'HCV', rvs:'RVS (HIV)', shcg:'SHCG (Pregnancy)',
          // Blood group / genotype
          hb_genotype:'Hb Genotype', blood_group:'Blood Group',
          // Malaria
          species:'Species', stage:'Stage',
          // Widal
          o:'S.Typhi O', h:'S.Typhi H', ao:'S.Paratyphi A (O)', ah:'S.Paratyphi A (H)',
          bo:'S.Paratyphi B (O)', bh:'S.Paratyphi B (H)',
          // TB GeneXpert
          mtb_detected:'MTB Detected', rif_resistance:'Rifampicin Resistance',
          // Culture
          organism:'Organism Isolated',
          // Rheumatoid Factor
          rf:'Rheumatoid Factor',
          // Urinalysis / MCS
          colour:'Colour', appearance:'Appearance', protein:'Protein', glucose:'Glucose',
          ketones:'Ketones', blood:'Blood', bilirubin:'Bilirubin', nitrite:'Nitrite',
          leuko:'Leukocyte Esterase', ascorbic_acid:'Ascorbic Acid',
          bacteria:'Bacteria', yeast:'Yeast',
          gram_stain:'Gram Stain', india_ink:'India Ink', crypto_ag:'Cryptococcal Ag',
          // Stool
          consistency:'Consistency', colour_stool:'Colour', blood_stool:'Blood (Macroscopic)',
          mucus_stool:'Mucus', wbc_stool:'WBC (Pus Cells)', rbc_stool:'RBC',
          fat_globules:'Fat Globules', ova_parasite:'Ova/Parasites', yeast_stool:'Yeast',
          occult_blood:'Occult Blood', micro_comment_stool:'Microscopy Comment',
          // Semen qualitative
          viscosity:'Viscosity', liquefaction:'Liquefaction',
          // CSF qualitative
          gram_stain_csf:'Gram Stain', india_ink_csf:'India Ink',
          // Wet prep
          wp_parasite:'Parasite / Ova',
          // Blood transfusion
          crossmatch:'Crossmatch Result', patient_blood_group:'Patient Blood Group',
          donor_blood_group:'Donor Blood Group',
        };

        filtered.forEach(s => {
          const t = (s.tests || []).find(x => x.test_name === testFilt && x.status !== 'Rejected' && x.result);
          if (!t) return;
          let d;
          try {
            d = t.result && t.result.startsWith('{') ? JSON.parse(t.result) : { result: t.result };
          } catch(e) {
            d = { result: t.result };
          }
          Object.entries(d).forEach(([k, v]) => {
            if (v === null || v === undefined || v === '' || typeof v === 'object') return;
            const strVal = String(v).trim();
            if (!strVal) return;
            const numV = parseFloat(strVal);
            // Skip pure numbers (handled in quantitative section)
            if (!isNaN(numV) && String(numV) === strVal) return;
            // Skip probe Ct values, timestamps, long text
            if (strVal.length > 60) return;
            if (/^\d{4}-\d{2}-\d{2}/.test(strVal)) return;
            const name = QUAL_PARAM_NAMES[k] || k.replace(/_/g,' ').replace(/\b\w/g,c=>c.toUpperCase());
            if (!qualMap[k]) qualMap[k] = { name, values: {} };
            qualMap[k].values[strVal] = (qualMap[k].values[strVal] || 0) + 1;
          });
        });

        const qualEntries = Object.values(qualMap).filter(p => Object.keys(p.values).length > 0);

        if (qualEntries.length) {
          const BAR_COLOURS = ['#10b981','#3b82f6','#f59e0b','#ef4444','#8b5cf6','#ec4899','#14b8a6','#f97316'];
          const POSITIVE_VALUES = new Set([
            'reactive','positive','detected','present','seen','growth','seen (incidental)',
            '+','++','+++','trace','few','moderate','many','turbid','cloudy','bloody',
            'watery','loose','gram positive cocci','gram negative rods','fungi','other',
            'incompatible','weakly incompatible',
          ]);

          const qualCards = qualEntries.map(p => {
            const total = Object.values(p.values).reduce((a,b)=>a+b,0);
            const sorted = Object.entries(p.values).sort((a,b)=>b[1]-a[1]);
            const maxCnt = sorted[0]?.[1] || 1;

            const barsHtml = sorted.map(([val, cnt], i) => {
              const pct = Math.round((cnt/total)*100);
              const barW = Math.round((cnt/maxCnt)*100);
              const isPositive = POSITIVE_VALUES.has(val.toLowerCase());
              const col = isPositive ? BAR_COLOURS[i % BAR_COLOURS.length] : '#94a3b8';
              return `<div style="display:flex;align-items:center;gap:10px;padding:5px 0;border-bottom:1px solid #f1f5f9;">
                <div style="min-width:140px;max-width:200px;font-size:.78rem;color:var(--slate);font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${esc(val)}">${esc(val)}</div>
                <div style="flex:1;background:#f1f5f9;border-radius:20px;height:12px;overflow:hidden;min-width:60px;">
                  <div style="height:100%;background:${col};border-radius:20px;width:${barW}%;transition:width .3s;"></div>
                </div>
                <span style="font-size:.78rem;font-weight:700;min-width:28px;text-align:right;color:var(--slate);">${cnt}</span>
                <span style="font-size:.72rem;color:var(--muted);min-width:38px;text-align:right;">${pct}%</span>
              </div>`;
            }).join('');

            return `<div class="analytics-param-card">
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;flex-wrap:wrap;gap:6px;">
                <div>
                  <div style="font-weight:700;font-size:.95rem;color:var(--green);">${esc(p.name)}</div>
                  <div style="font-size:.72rem;color:var(--muted);">n = ${total} &nbsp;·&nbsp; ${sorted.length} distinct value${sorted.length>1?'s':''}</div>
                </div>
                <span class="analytics-abn-pill" style="background:#dbeafe;color:#1d4ed8;">${sorted[0]?.[0] ? `Most common: ${esc(sorted[0][0])}` : ''}</span>
              </div>
              ${barsHtml}
            </div>`;
          }).join('');

          deepDiveHtml = `<div style="margin-bottom:8px;">
            <div style="font-size:.95rem;font-weight:700;color:var(--slate);margin-bottom:6px;">📌 Deep Dive: ${esc(testFilt)}</div>
            <div style="font-size:.78rem;color:var(--muted);margin-bottom:14px;padding:8px 12px;background:#f0fdf4;border-radius:10px;border:1px solid #bbf7d0;">
              📊 This is a <strong>qualitative test</strong> — results are displayed as value frequency counts across all ${filtered.length} filtered patients.
            </div>
            ${qualCards}
          </div>`;
        } else {
          // Truly unstructured plain-text results
          const textResults = [];
          filtered.forEach(s => {
            const t = (s.tests || []).find(x => x.test_name === testFilt && x.status !== 'Rejected' && x.result);
            if (t && t.result && !t.result.startsWith('{')) textResults.push({ val: t.result.trim(), patient: s.patient, id: s.id, date: s.collDate, gender: s.gender, age: s.age });
          });

          if (textResults.length) {
            const freq = {};
            textResults.forEach(r => { freq[r.val] = (freq[r.val]||0)+1; });
            const sorted = Object.entries(freq).sort((a,b)=>b[1]-a[1]);
            const totalT = textResults.length;
            const freqRows = sorted.map(([val,cnt]) => {
              const pct = Math.round((cnt/totalT)*100);
              return `<div style="display:flex;align-items:center;gap:10px;padding:5px 0;border-bottom:1px solid #f1f5f9;">
                <div style="min-width:160px;font-size:.8rem;color:var(--slate);font-weight:500;">${esc(val)}</div>
                <div style="flex:1;background:#f1f5f9;border-radius:20px;height:12px;overflow:hidden;">
                  <div style="height:100%;background:#10b981;border-radius:20px;width:${Math.round((cnt/sorted[0][1])*100)}%;"></div>
                </div>
                <span style="font-size:.78rem;font-weight:700;min-width:28px;">${cnt}</span>
                <span style="font-size:.72rem;color:var(--muted);">${pct}%</span>
              </div>`;
            }).join('');

            deepDiveHtml = `<div style="margin-bottom:8px;">
              <div style="font-size:.95rem;font-weight:700;color:var(--slate);margin-bottom:6px;">📌 Deep Dive: ${esc(testFilt)}</div>
              <div style="font-size:.78rem;color:var(--muted);margin-bottom:14px;padding:8px 12px;background:#f0fdf4;border-radius:10px;border:1px solid #bbf7d0;">
                📊 <strong>Simple text result</strong> — showing frequency of each reported value across ${totalT} patient${totalT>1?'s':''}.
              </div>
              <div class="analytics-param-card">
                <div style="font-weight:700;font-size:.9rem;color:var(--green);margin-bottom:12px;">Result Frequency</div>
                ${freqRows}
              </div>
            </div>`;
          } else {
            deepDiveHtml = `<div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:14px;padding:16px 18px;margin-bottom:20px;color:#166534;font-size:.82rem;">
              ℹ️ No result data found for <strong>${esc(testFilt)}</strong> within the current filters.
             </div>`;
          }
        }
      } else {
        deepDiveHtml = `<div style="margin-bottom:8px;"><div style="font-size:.95rem;font-weight:700;color:var(--slate);margin-bottom:14px;">📌 Deep Dive: ${esc(testFilt)}</div>${paramCards}</div>`;
      }
    }

    wrap.innerHTML = summaryHtml + chartsHtml + testFreqHtml + abnHtml + deepDiveHtml;
  };

  // ── Clear button ──────────────────────────────────────────────────────────
  document.getElementById('analyticsClearBtn')?.addEventListener('click', () => {
    ['analyticsDateFrom','analyticsDateTo','analyticsAgeMin','analyticsAgeMax'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
    const gSel = document.getElementById('analyticsGender');
    if (gSel) gSel.value = 'all';
    const uSel = document.getElementById('analyticsUnitFilter');
    if (uSel) { uSel.value = ''; }
    const tSel = document.getElementById('analyticsTestSelect');
    if (tSel) tSel.value = '';
    // Clearing filters reuses the cache — same data, different view
    window.renderAnalytics();
  });

  // ── Refresh button — busts the dataset cache and re-fetches from DB ───────
  // Injected next to the clear button if not already present in the HTML.
  // Supervisors use this after new results are released to see them immediately
  // without waiting for the 5-minute TTL to expire naturally.
  (function _injectRefreshBtn() {
    if (document.getElementById('analyticsRefreshBtn')) return;
    const clearBtn = document.getElementById('analyticsClearBtn');
    if (!clearBtn) return;
    const refreshBtn = document.createElement('button');
    refreshBtn.id        = 'analyticsRefreshBtn';
    refreshBtn.className = clearBtn.className;
    refreshBtn.style.cssText = 'margin-left:8px;';
    refreshBtn.innerHTML = '<i class="fas fa-sync-alt"></i> Refresh Data';
    refreshBtn.title     = 'Re-fetch released results from the database (cache expires every 5 min)';
    clearBtn.insertAdjacentElement('afterend', refreshBtn);
  })();

  document.getElementById('analyticsRefreshBtn')?.addEventListener('click', () => {
    _analyticsCacheInvalidate();
    window.renderAnalytics();
  });

  // ── Unit filter change re-populates test selector without full re-render ──
  document.getElementById('analyticsUnitFilter')?.addEventListener('change', () => {
    const content = document.getElementById('analyticsContent');
    if (content && !content.querySelector('.analytics-empty')) {
      window.renderAnalytics();
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // §  CLINICAL ANALYTICS — CSV EXPORT
  //
  //  PURPOSE: Research-grade, wide-format export for use in SPSS, Stata, R,
  //  Excel, Epi Info, DHIS2, WHO/UNICEF survey tools, and MoH reporting.
  //
  //  FORMAT: One row = one patient sample.
  //  Columns:
  //    Block A  — identifiers & demographics
  //    Block B  — sample metadata (date, priority, area, unit)
  //    Block C  — one column per numeric parameter across ALL panel tests
  //               found in the filtered dataset (e.g. WBC, Hb, ALT, TSH …)
  //               Value = actual numeric result; blank = not ordered / rejected
  //    Block D  — one column per qualitative parameter found in the dataset
  //               (HBsAg, Blood Group, Malaria species …)
  //    Block E  — flag columns: "<param>_FLAG" = HIGH / LOW / NORMAL / blank
  //    Block F  — meta: export timestamp, filter summary, app name
  //
  //  Why wide format?
  //    - SPSS, Stata, R need one variable per column (not long/tidy).
  //    - Allows immediate cross-tabulation, regression, survival analysis.
  //    - WHO/UNICEF data templates are wide-format.
  //    - MoH aggregate tools (Epi Info, DHIS2 import) expect flat rows.
  // ═══════════════════════════════════════════════════════════════════════════

  document.getElementById('exportAnalyticsBtn')?.addEventListener('click', async () => {
    let samples = _analyticsCache;
    if (!samples || !samples.length) {
      window._showAnalyticsToast?.('Run analytics first, then export.');
      return;
    }

    // ── Mirror filter state from renderAnalytics ──────────────────────────
    const dateFrom   = document.getElementById('analyticsDateFrom')?.value  || '';
    const dateTo     = document.getElementById('analyticsDateTo')?.value    || '';
    const genderFilt = document.getElementById('analyticsGender')?.value    || 'all';
    const ageMin     = parseInt(document.getElementById('analyticsAgeMin')?.value)  || 0;
    const ageMax     = parseInt(document.getElementById('analyticsAgeMax')?.value)  || 999;
    const unitFilt   = document.getElementById('analyticsUnitFilter')?.value || '';
    const areaFilt   = document.getElementById('analyticsAreaFilter')?.value || '';
    const testFilt   = document.getElementById('analyticsTestSelect')?.value || '';

    const withResults = samples.filter(s =>
      (s.tests || []).some(t => t.result && t.result.trim() && t.status !== 'Rejected')
    );
    let filtered = withResults.filter(s => {
      if (dateFrom && (s.collDate || '') < dateFrom) return false;
      if (dateTo   && (s.collDate || '') > dateTo)   return false;
      if (genderFilt !== 'all' && s.gender !== genderFilt) return false;
      const a = parseInt(s.age);
      if (!isNaN(a) && (a < ageMin || a > ageMax)) return false;
      if (areaFilt && (s.area || '') !== areaFilt) return false;
      if (unitFilt) {
        const unitTests = new Set(_testDefs.units[unitFilt] || []);
        if (!(s.tests || []).some(t => unitTests.has(t.test_name) && t.status !== 'Rejected' && t.result)) return false;
      }
      if (testFilt) {
        if (!(s.tests || []).some(t => t.test_name === testFilt && t.status !== 'Rejected' && t.result)) return false;
      }
      return true;
    });

    if (!filtered.length) { alert('No data to export with current filters.'); return; }

    // ── Qualitative display names ─────────────────────────────────────────
    const QUAL_DISPLAY = {
      hbsag:'HBsAg', anti_hbs:'Anti-HBs', hbeag:'HBeAg', anti_hbe:'Anti-HBe',
      anti_hbc:'Anti-HBc', hcv:'HCV', rvs:'RVS (HIV)', shcg:'SHCG (Pregnancy)',
      hb_genotype:'Hb Genotype', blood_group:'Blood Group', species:'Malaria Species',
      stage:'Malaria Stage', o:'Widal S.Typhi O', h:'Widal S.Typhi H',
      ao:'Widal S.Paratyphi A(O)', ah:'Widal S.Paratyphi A(H)',
      bo:'Widal S.Paratyphi B(O)', bh:'Widal S.Paratyphi B(H)',
      co:'Widal S.Paratyphi C(O)', ch:'Widal S.Paratyphi C(H)',
      mtb_detected:'TB MTB Detected', rif_resistance:'TB Rifampicin Resistance',
      organism:'Culture Organism', rf:'Rheumatoid Factor',
      colour:'Urine Colour', appearance:'Urine Appearance', protein:'Urine Protein',
      glucose:'Urine Glucose', ketones:'Urine Ketones', blood:'Urine Blood',
      bilirubin:'Urine Bilirubin', nitrite:'Urine Nitrite',
      leuko:'Urine Leukocyte Esterase', bacteria:'Urine Bacteria',
      consistency:'Stool Consistency', colour_stool:'Stool Colour',
      ova_parasite:'Stool Ova/Parasites', occult_blood:'Stool Occult Blood',
      crossmatch:'Crossmatch Result', patient_blood_group:'Patient Blood Group',
      donor_blood_group:'Donor Blood Group',
    };

    // ── Compute all analytics data ────────────────────────────────────────
    const n = filtered.length;

    // Gender
    const gCount = { Male: 0, Female: 0, Other: 0 };
    filtered.forEach(s => { const g = s.gender || 'Other'; gCount[g in gCount ? g : 'Other']++; });

    // Age groups
    const ageOrder = ['0–4','5–12','13–17','18–29','30–44','45–59','60–74','75+'];
    const ageBkts  = {}; ageOrder.forEach(g => ageBkts[g] = 0);
    filtered.forEach(s => { const g = _ageGroup(parseInt(s.age)); if (g in ageBkts) ageBkts[g]++; });

    // Monthly trend
    const monthMap = {};
    filtered.forEach(s => {
      const d = (s.collDate || '').slice(0, 7); // YYYY-MM
      if (d) monthMap[d] = (monthMap[d] || 0) + 1;
    });
    const monthLabels = Object.keys(monthMap).sort();
    const monthVals   = monthLabels.map(m => monthMap[m]);

    // Test frequency
    const testFreq = {};
    filtered.forEach(s => _testsForUnit(s, unitFilt).forEach(t => {
      testFreq[t.test_name] = (testFreq[t.test_name] || 0) + 1;
    }));
    const topTests = Object.entries(testFreq).sort((a,b) => b[1]-a[1]).slice(0, 12);

    // Area distribution
    const areaFreq = {};
    filtered.forEach(s => { const a = s.area || 'Unknown'; areaFreq[a] = (areaFreq[a] || 0) + 1; });
    const topAreas = Object.entries(areaFreq).sort((a,b) => b[1]-a[1]).slice(0, 10);

    // Numeric parameters: stats + abnormality
    const numParamMap = {};
    filtered.forEach(s => {
      (s.tests || []).forEach(t => {
        if (t.status === 'Rejected' || !t.result) return;
        if (testFilt && t.test_name !== testFilt) return;
        _extractNumerics(t.test_name, t.result, s.age, s.gender).forEach(nv => {
          if (!numParamMap[nv.param]) numParamMap[nv.param] = { name: nv.param, unit: nv.unit, low: nv.low, high: nv.high, vals: [], abn: 0, normal: 0, mVals: [], fVals: [] };
          const pm = numParamMap[nv.param];
          pm.vals.push(nv.val);
          if (nv.val > nv.high || nv.val < nv.low) pm.abn++; else pm.normal++;
          if (s.gender === 'Male') pm.mVals.push(nv.val); else if (s.gender === 'Female') pm.fVals.push(nv.val);
        });
      });
    });

    // Qualitative distributions
    const qualDistMap = {};
    filtered.forEach(s => {
      (s.tests || []).forEach(t => {
        if (t.status === 'Rejected' || !t.result || !t.result.startsWith('{')) return;
        if (testFilt && t.test_name !== testFilt) return;
        let d; try { d = JSON.parse(t.result); } catch(e) { return; }
        Object.entries(d).forEach(([k, v]) => {
          if (!v || typeof v === 'object') return;
          const sv = String(v).trim();
          if (!sv || sv.length > 80 || /^\d{4}-\d{2}-\d{2}/.test(sv) || (!isNaN(parseFloat(sv)) && String(parseFloat(sv)) === sv)) return;
          const label = QUAL_DISPLAY[k] || k.replace(/_/g,' ').replace(/\b\w/g, c => c.toUpperCase());
          if (!qualDistMap[label]) qualDistMap[label] = {};
          qualDistMap[label][sv] = (qualDistMap[label][sv] || 0) + 1;
        });
      });
    });

    // Abnormality rate per test (sorted by rate desc)
    const abnRates = Object.entries(numParamMap)
      .filter(([,p]) => p.vals.length > 0)
      .map(([name, p]) => ({ name, pct: Math.round((p.abn / p.vals.length) * 100), abn: p.abn, total: p.vals.length }))
      .sort((a,b) => b.pct - a.pct).slice(0, 15);

    // ── Build histogram bins for a parameter ─────────────────────────────
    function buildHistogram(vals, low, high) {
      const bins = 8;
      const minV = Math.min(...vals), maxV = Math.max(...vals);
      const range = maxV - minV || 1;
      const bSize = range / bins;
      const counts = Array(bins).fill(0);
      const colors = [];
      vals.forEach(v => { const i = Math.min(Math.floor((v - minV) / bSize), bins - 1); counts[i]++; });
      for (let i = 0; i < bins; i++) {
        const midpoint = minV + (i + 0.5) * bSize;
        colors.push(midpoint >= low && midpoint <= high ? 'rgba(16,185,129,0.75)' : 'rgba(248,113,113,0.75)');
      }
      const labels = Array.from({length: bins}, (_, i) => (minV + i * bSize).toFixed(1));
      return { labels, counts, colors };
    }

    // ── Filter description ────────────────────────────────────────────────
    const filterDesc = [
      dateFrom || dateTo ? `Date: ${dateFrom || '*'} → ${dateTo || '*'}` : null,
      genderFilt !== 'all' ? `Gender: ${genderFilt}` : null,
      (ageMin > 0 || ageMax < 999) ? `Age: ${ageMin}–${ageMax} yrs` : null,
      unitFilt ? `Unit: ${unitFilt}` : null,
      areaFilt ? `Area: ${areaFilt}` : null,
      testFilt ? `Test: ${testFilt}` : null,
    ].filter(Boolean).join('  ·  ') || 'All released results — no filters applied';

    const exportedBy = `${(window._currentSession||{}).name || '—'} (${(window._currentSession||{}).role || '—'})`;
    const exportDate = new Date().toLocaleString('en-GB', { dateStyle: 'full', timeStyle: 'medium' });

    // ── Build chart JSON payloads (serialised for inline <script>) ────────
    const chartsData = {
      gender: {
        type: 'doughnut',
        data: {
          labels: ['Male', 'Female', 'Other'].filter(g => gCount[g] > 0),
          datasets: [{ data: ['Male','Female','Other'].filter(g => gCount[g] > 0).map(g => gCount[g]), backgroundColor: ['#2563eb','#db2777','#94a3b8'], borderWidth: 2, borderColor: '#fff' }]
        },
        options: { plugins: { legend: { position: 'bottom' }, title: { display: true, text: `Gender Distribution  (n = ${n})`, font: { size: 14, weight: 'bold' } } }, cutout: '60%' }
      },
      age: {
        type: 'bar',
        data: { labels: ageOrder.filter(g => ageBkts[g] > 0), datasets: [{ label: 'Patients', data: ageOrder.filter(g => ageBkts[g] > 0).map(g => ageBkts[g]), backgroundColor: '#0891b2', borderRadius: 6 }] },
        options: { plugins: { legend: { display: false }, title: { display: true, text: 'Age Group Distribution', font: { size: 14, weight: 'bold' } } }, scales: { y: { beginAtZero: true, ticks: { stepSize: 1 } } } }
      },
      trend: monthLabels.length > 1 ? {
        type: 'line',
        data: { labels: monthLabels, datasets: [{ label: 'Samples Released', data: monthVals, borderColor: '#7c3aed', backgroundColor: 'rgba(124,58,237,0.08)', fill: true, tension: 0.35, pointRadius: 4 }] },
        options: { plugins: { legend: { display: false }, title: { display: true, text: 'Monthly Sample Volume Trend', font: { size: 14, weight: 'bold' } } }, scales: { y: { beginAtZero: true } } }
      } : null,
      topTests: {
        type: 'bar',
        data: { labels: topTests.map(([name]) => name), datasets: [{ label: 'Requests', data: topTests.map(([,cnt]) => cnt), backgroundColor: '#059669', borderRadius: 4 }] },
        options: { indexAxis: 'y', plugins: { legend: { display: false }, title: { display: true, text: 'Most Requested Tests (Top 12)', font: { size: 14, weight: 'bold' } } }, scales: { x: { beginAtZero: true } } }
      },
      areas: topAreas.length > 1 ? {
        type: 'bar',
        data: { labels: topAreas.map(([a]) => a), datasets: [{ label: 'Samples', data: topAreas.map(([,c]) => c), backgroundColor: '#d97706', borderRadius: 4 }] },
        options: { indexAxis: 'y', plugins: { legend: { display: false }, title: { display: true, text: 'Sample Origin by Area / Clinic', font: { size: 14, weight: 'bold' } } }, scales: { x: { beginAtZero: true } } }
      } : null,
      abnormality: abnRates.length ? {
        type: 'bar',
        data: {
          labels: abnRates.map(r => r.name),
          datasets: [{
            label: '% Abnormal',
            data: abnRates.map(r => r.pct),
            backgroundColor: abnRates.map(r => r.pct > 30 ? '#b91c1c' : r.pct > 10 ? '#d97706' : '#15803d'),
            borderRadius: 4
          }]
        },
        options: { indexAxis: 'y', plugins: { legend: { display: false }, title: { display: true, text: 'Abnormality Rate by Test Parameter (%)', font: { size: 14, weight: 'bold' } } }, scales: { x: { beginAtZero: true, max: 100 } } }
      } : null,
    };

    // Per-parameter histograms + normal/abnormal donuts
    const paramCharts = Object.values(numParamMap).filter(p => p.vals.length >= 3).map(p => {
      const hist = buildHistogram(p.vals, p.low, p.high);
      const mean = (p.vals.reduce((a,b)=>a+b,0)/p.vals.length).toFixed(2);
      const mMean = p.mVals.length ? (p.mVals.reduce((a,b)=>a+b,0)/p.mVals.length).toFixed(2) : null;
      const fMean = p.fVals.length ? (p.fVals.reduce((a,b)=>a+b,0)/p.fVals.length).toFixed(2) : null;
      const pctAbn = Math.round((p.abn / p.vals.length) * 100);
      return {
        name: p.name, unit: p.unit, low: p.low, high: p.high, total: p.vals.length,
        mean, pctAbn, mMean, fMean,
        histConfig: {
          type: 'bar',
          data: { labels: hist.labels, datasets: [{ label: 'Count', data: hist.counts, backgroundColor: hist.colors, borderRadius: 3 }] },
          options: { plugins: { legend: { display: false }, title: { display: true, text: `${p.name} Distribution (Ref: ${p.low}–${p.high} ${p.unit})`, font: { size: 12 } } }, scales: { y: { beginAtZero: true, ticks: { stepSize: 1 } } } }
        },
        donutConfig: {
          type: 'doughnut',
          data: { labels: ['Normal', 'Abnormal'], datasets: [{ data: [p.normal, p.abn], backgroundColor: ['#10b981','#f87171'], borderWidth: 2, borderColor: '#fff' }] },
          options: { plugins: { legend: { position: 'bottom' }, title: { display: true, text: 'Normal vs Abnormal', font: { size: 12 } } }, cutout: '55%' }
        },
        genderConfig: (mMean && fMean) ? {
          type: 'bar',
          data: { labels: ['Male', 'Female'], datasets: [{ label: `Mean ${p.unit}`, data: [parseFloat(mMean), parseFloat(fMean)], backgroundColor: ['#2563eb','#db2777'], borderRadius: 6 }] },
          options: { plugins: { legend: { display: false }, title: { display: true, text: 'Mean by Gender', font: { size: 12 } } }, scales: { y: { beginAtZero: false } } }
        } : null
      };
    });

    // Qualitative charts
    const qualCharts = Object.entries(qualDistMap)
      .filter(([,d]) => Object.keys(d).length >= 2 && Object.keys(d).length <= 12)
      .slice(0, 16)
      .map(([label, dist]) => {
        const entries = Object.entries(dist).sort((a,b) => b[1]-a[1]);
        const PALETTE = ['#2563eb','#db2777','#059669','#d97706','#7c3aed','#0891b2','#b91c1c','#15803d','#94a3b8','#f59e0b','#6366f1','#ec4899'];
        return {
          label,
          config: {
            type: entries.length <= 5 ? 'doughnut' : 'bar',
            data: {
              labels: entries.map(([k]) => k),
              datasets: [{
                data: entries.map(([,v]) => v),
                backgroundColor: entries.map((_, i) => PALETTE[i % PALETTE.length]),
                borderWidth: 2, borderColor: '#fff', borderRadius: 4
              }]
            },
            options: {
              indexAxis: entries.length > 5 ? 'y' : undefined,
              plugins: {
                legend: { position: entries.length <= 5 ? 'bottom' : 'none', display: entries.length <= 5 },
                title: { display: true, text: label, font: { size: 13, weight: 'bold' } }
              },
              cutout: entries.length <= 5 ? '50%' : undefined,
              scales: entries.length > 5 ? { x: { beginAtZero: true } } : undefined
            }
          }
        };
      });

    // Reference range table rows
    const refTableRows = Object.values(numParamMap).map(p =>
      `<tr><td>${p.name}</td><td>${p.unit||'—'}</td><td>${p.low}</td><td>${p.high}</td><td>${p.vals.length}</td><td style="color:${p.abn/p.vals.length>0.3?'#b91c1c':p.abn/p.vals.length>0.1?'#d97706':'#15803d'};font-weight:600;">${Math.round((p.abn/p.vals.length)*100)}%</td></tr>`
    ).join('');

    // ── Generate self-contained HTML report ───────────────────────────────
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>MU'UJIZA LIS — Clinical Analytics Report</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"><\/script>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Segoe UI', Arial, sans-serif; background: #f8fafc; color: #1e293b; font-size: 14px; }
  .cover { background: linear-gradient(135deg, #0f4c81 0%, #1e3a5f 100%); color: #fff; padding: 48px 40px 36px; }
  .cover h1 { font-size: 1.8rem; font-weight: 800; letter-spacing: -0.5px; margin-bottom: 4px; }
  .cover h2 { font-size: 1.1rem; font-weight: 400; opacity: .8; margin-bottom: 24px; }
  .cover-meta { display: flex; flex-wrap: wrap; gap: 24px; margin-top: 20px; }
  .cover-meta-item { background: rgba(255,255,255,.1); border-radius: 10px; padding: 12px 18px; }
  .cover-meta-item .label { font-size: .7rem; opacity: .65; text-transform: uppercase; letter-spacing: .5px; }
  .cover-meta-item .value { font-size: 1.05rem; font-weight: 700; margin-top: 2px; }
  .filter-bar { background: #e0f2fe; border-left: 4px solid #0891b2; margin: 24px 32px 0; padding: 12px 18px; border-radius: 8px; font-size: .82rem; color: #0c4a6e; }
  .section { padding: 28px 32px 0; }
  .section-title { font-size: 1rem; font-weight: 700; color: #0f4c81; border-bottom: 2px solid #e2e8f0; padding-bottom: 8px; margin-bottom: 20px; letter-spacing: .2px; }
  .charts-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 20px; margin-bottom: 24px; }
  .chart-card { background: #fff; border-radius: 14px; padding: 20px; box-shadow: 0 1px 4px rgba(0,0,0,.07); }
  .chart-card canvas { max-height: 300px; }
  .param-card { background: #fff; border-radius: 14px; padding: 20px; box-shadow: 0 1px 4px rgba(0,0,0,.07); margin-bottom: 20px; }
  .param-title { font-size: .95rem; font-weight: 700; color: #059669; margin-bottom: 4px; }
  .param-stats { display: flex; gap: 10px; flex-wrap: wrap; margin: 10px 0 16px; }
  .stat-chip { background: #f1f5f9; border-radius: 8px; padding: 6px 12px; font-size: .78rem; }
  .stat-chip strong { display: block; font-size: 1rem; color: #0f4c81; }
  .param-charts-row { display: grid; grid-template-columns: 2fr 1fr; gap: 16px; }
  .param-charts-row-3 { display: grid; grid-template-columns: 2fr 1fr 1fr; gap: 16px; }
  @media (max-width: 640px) { .param-charts-row, .param-charts-row-3 { grid-template-columns: 1fr; } }
  .ref-table { width: 100%; border-collapse: collapse; font-size: .82rem; margin-bottom: 32px; }
  .ref-table th { background: #0f4c81; color: #fff; padding: 8px 12px; text-align: left; }
  .ref-table td { padding: 7px 12px; border-bottom: 1px solid #e2e8f0; }
  .ref-table tr:nth-child(even) td { background: #f8fafc; }
  .footer { background: #1e293b; color: rgba(255,255,255,.5); text-align: center; padding: 20px; font-size: .75rem; margin-top: 32px; }
  .pill { display: inline-block; padding: 2px 10px; border-radius: 20px; font-size: .75rem; font-weight: 600; }
  .pill-normal { background: #dcfce7; color: #15803d; }
  .pill-warn   { background: #fef3c7; color: #92400e; }
  .pill-danger { background: #fee2e2; color: #b91c1c; }
  @media print {
    .cover { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .chart-card, .param-card { page-break-inside: avoid; }
    .section { page-break-before: auto; }
  }
</style>
</head>
<body>

<!-- ═══ COVER ═══════════════════════════════════════════════════════════ -->
<div class="cover">
  <div style="font-size:.75rem;opacity:.6;margin-bottom:6px;letter-spacing:1px;">MU'UJIZA LABORATORY INFORMATION SYSTEM</div>
  <h1>Clinical Analytics Report</h1>
  <h2>Research & Epidemiological Summary</h2>
  <div class="cover-meta">
    <div class="cover-meta-item"><div class="label">Total Patients</div><div class="value">${n.toLocaleString()}</div></div>
    <div class="cover-meta-item"><div class="label">Numeric Parameters</div><div class="value">${Object.keys(numParamMap).length}</div></div>
    <div class="cover-meta-item"><div class="label">Qualitative Parameters</div><div class="value">${Object.keys(qualDistMap).length}</div></div>
    <div class="cover-meta-item"><div class="label">Generated</div><div class="value" style="font-size:.85rem;">${exportDate}</div></div>
    <div class="cover-meta-item"><div class="label">Exported by</div><div class="value" style="font-size:.85rem;">${exportedBy}</div></div>
  </div>
</div>
<div class="filter-bar">🔍 <strong>Active Filters:</strong> ${filterDesc}</div>

<!-- ═══ SECTION 1: OVERVIEW ══════════════════════════════════════════════ -->
<div class="section">
  <div class="section-title">1. Population Overview</div>
  <div class="charts-grid">
    <div class="chart-card"><canvas id="c_gender"></canvas></div>
    <div class="chart-card"><canvas id="c_age"></canvas></div>
    ${chartsData.trend ? `<div class="chart-card" style="grid-column:1/-1"><canvas id="c_trend"></canvas></div>` : ''}
  </div>
</div>

<!-- ═══ SECTION 2: TEST DEMAND & AREA ═══════════════════════════════════ -->
<div class="section">
  <div class="section-title">2. Test Demand & Sample Origin</div>
  <div class="charts-grid">
    <div class="chart-card"><canvas id="c_topTests"></canvas></div>
    ${chartsData.areas ? `<div class="chart-card"><canvas id="c_areas"></canvas></div>` : ''}
  </div>
</div>

<!-- ═══ SECTION 3: ABNORMALITY RATES ════════════════════════════════════ -->
${chartsData.abnormality ? `
<div class="section">
  <div class="section-title">3. Abnormality Rates by Parameter</div>
  <div class="chart-card"><canvas id="c_abnormality" style="max-height:420px;"></canvas></div>
</div>` : ''}

<!-- ═══ SECTION 4: QUALITATIVE FINDINGS ═════════════════════════════════ -->
${qualCharts.length ? `
<div class="section">
  <div class="section-title">4. Qualitative Test Findings</div>
  <div class="charts-grid">
    ${qualCharts.map((qc, i) => `<div class="chart-card"><canvas id="c_qual_${i}"></canvas></div>`).join('')}
  </div>
</div>` : ''}

<!-- ═══ SECTION 5: PER-PARAMETER DEEP DIVE ══════════════════════════════ -->
${paramCharts.length ? `
<div class="section">
  <div class="section-title">5. Numeric Parameter Analysis</div>
  ${paramCharts.map((p, i) => `
  <div class="param-card">
    <div class="param-title">${p.name} <span style="font-weight:400;color:#64748b;font-size:.8rem;">(${p.unit}) · n = ${p.total}</span>
      &nbsp;<span class="pill ${p.pctAbn > 30 ? 'pill-danger' : p.pctAbn > 10 ? 'pill-warn' : 'pill-normal'}">${p.pctAbn}% Abnormal</span>
    </div>
    <div class="param-stats">
      <div class="stat-chip"><strong>${p.mean}</strong>Mean (${p.unit})</div>
      <div class="stat-chip"><strong>${p.low}–${p.high}</strong>Reference</div>
      ${p.mMean ? `<div class="stat-chip"><strong style="color:#2563eb;">${p.mMean}</strong>Male Mean</div>` : ''}
      ${p.fMean ? `<div class="stat-chip"><strong style="color:#db2777;">${p.fMean}</strong>Female Mean</div>` : ''}
    </div>
    <div class="${p.genderConfig ? 'param-charts-row-3' : 'param-charts-row'}">
      <canvas id="c_hist_${i}"></canvas>
      <canvas id="c_donut_${i}"></canvas>
      ${p.genderConfig ? `<canvas id="c_gender_${i}"></canvas>` : ''}
    </div>
  </div>`).join('')}
</div>` : ''}

<!-- ═══ SECTION 6: REFERENCE RANGES ════════════════════════════════════ -->
${refTableRows ? `
<div class="section">
  <div class="section-title">6. Reference Ranges & Abnormality Summary</div>
  <table class="ref-table">
    <thead><tr><th>Parameter</th><th>Unit</th><th>Lower Limit</th><th>Upper Limit</th><th>n</th><th>% Abnormal</th></tr></thead>
    <tbody>${refTableRows}</tbody>
  </table>
</div>` : ''}

<div class="footer">
  MU'UJIZA Laboratory Information System &nbsp;·&nbsp; Generated ${exportDate} &nbsp;·&nbsp; ${exportedBy}<br>
  <span style="font-size:.7rem;opacity:.7;">This report is generated from verified released laboratory results. For clinical use, verify individual patient records in the LIS.</span>
</div>

<script>
(function() {
  const C = ${JSON.stringify(chartsData)};
  const P = ${JSON.stringify(paramCharts)};
  const Q = ${JSON.stringify(qualCharts)};

  function make(id, cfg) {
    const el = document.getElementById(id);
    if (el && cfg) new Chart(el, cfg);
  }

  make('c_gender',      C.gender);
  make('c_age',         C.age);
  make('c_trend',       C.trend);
  make('c_topTests',    C.topTests);
  make('c_areas',       C.areas);
  make('c_abnormality', C.abnormality);

  Q.forEach((q, i) => make('c_qual_' + i, q.config));
  P.forEach((p, i) => {
    make('c_hist_'   + i, p.histConfig);
    make('c_donut_'  + i, p.donutConfig);
    if (p.genderConfig) make('c_gender_' + i, p.genderConfig);
  });
})();
<\/script>
</body>
</html>`;

    // ── Download as .html file ────────────────────────────────────────────
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `muujiza_analytics_report_${_csvDate()}.html`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 2000);

    const msg = `Report generated: ${n} patients · ${Object.keys(numParamMap).length} numeric + ${Object.keys(qualDistMap).length} qualitative parameters. Open the downloaded .html file, then File → Print → Save as PDF.`;
    (typeof showToast === 'function') ? showToast(msg, 'success') : alert(msg);
  });

})();
