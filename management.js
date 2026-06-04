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
  // Fetching 1000 released samples + their tests each time gets expensive fast.
  // Cache the raw dataset for 5 minutes; filters and deep-dives run on the
  // cached copy so the DB is only hit when the data is actually stale.
  let _analyticsCache       = null;   // array of mapped sample objects
  let _analyticsCacheTime   = 0;      // Date.now() when cache was filled
  const _ANALYTICS_TTL_MS   = 5 * 60 * 1000; // 5 minutes

  function _analyticsCacheValid() {
    return _analyticsCache !== null && (Date.now() - _analyticsCacheTime) < _ANALYTICS_TTL_MS;
  }
  function _analyticsCacheInvalidate() {
    _analyticsCache     = null;
    _analyticsCacheTime = 0;
  }
  // Expose so the "Refresh" button (if added later) can bust it from outside
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

  // ── Reference ranges (gender/age aware) ──────────────────────────────────
  function _refRange(testName, age, gender) {
    const isMale   = gender === 'Male';
    const isFemale = gender === 'Female';
    switch (testName) {
      case 'PCV': case 'Packed Cell Volume': case 'Hematocrit': case 'HCT':
        return isMale ? {low:40,high:54,unit:'%'} : {low:36,high:46,unit:'%'};
      case 'Hb': case 'Hemoglobin':
        return isMale ? {low:13.5,high:17.5,unit:'g/dL'} : {low:12.0,high:15.5,unit:'g/dL'};
      case 'ESR': case 'Erythrocyte Sedimentation Rate':
        return isMale ? {low:0,high:10,unit:'mm/hr'} : {low:0,high:20,unit:'mm/hr'};
      case 'RBS': case 'Random Blood Sugar':  return {low:70,high:140,unit:'mg/dL'};
      case 'FBS': case 'Fasting Blood Sugar': return {low:70,high:100,unit:'mg/dL'};
      default: return null;
    }
  }

  // ── Parameter definitions for numeric panel tests ─────────────────────────
  const PARAM_DEFS = {
    complex_cbc: [
      {key:'wbc', name:'WBC', unit:'×10³/µL', low:4.0, high:11.0},
      {key:'rbc', name:'RBC', unit:'×10⁶/µL', low:4.2, high:5.8},
      {key:'hb',  name:'Hemoglobin', unit:'g/dL', low:12.0, high:16.0},
      {key:'hct', name:'Hematocrit', unit:'%', low:36, high:46},
      {key:'mcv', name:'MCV', unit:'fL', low:80, high:100},
      {key:'mch', name:'MCH', unit:'pg', low:27, high:32},
      {key:'mchc',name:'MCHC', unit:'g/dL', low:32, high:36},
      {key:'plt', name:'Platelets', unit:'×10³/µL', low:150, high:450},
      {key:'neut',name:'Neutrophils', unit:'%', low:40, high:70},
      {key:'lymph',name:'Lymphocytes', unit:'%', low:20, high:45},
    ],
    complex_lft: [
      {key:'alt', name:'ALT', unit:'U/L', low:10, high:40},
      {key:'ast', name:'AST', unit:'U/L', low:10, high:35},
      {key:'alp', name:'ALP', unit:'U/L', low:30, high:120},
      {key:'tbil',name:'Total Bilirubin', unit:'mg/dL', low:0.3, high:1.2},
      {key:'prot',name:'Total Protein', unit:'g/dL', low:6.0, high:8.0},
      {key:'alb', name:'Albumin', unit:'g/dL', low:3.5, high:5.0},
    ],
    complex_rft: [
      {key:'urea',     name:'Urea', unit:'mg/dL', low:10, high:50},
      {key:'creat',    name:'Creatinine', unit:'mg/dL', low:0.6, high:1.2},
      {key:'sodium',   name:'Sodium', unit:'mmol/L', low:135, high:145},
      {key:'potassium',name:'Potassium', unit:'mmol/L', low:3.5, high:5.1},
      {key:'chloride', name:'Chloride', unit:'mmol/L', low:98, high:107},
    ],
    complex_thyroid: [
      {key:'tsh', name:'TSH', unit:'µIU/mL', low:0.4, high:4.0},
      {key:'ft3', name:'Free T3', unit:'pg/mL', low:2.3, high:4.2},
      {key:'ft4', name:'Free T4', unit:'ng/dL', low:0.8, high:1.8},
    ],
    complex_lipid: [
      {key:'chol',name:'Total Cholesterol', unit:'mg/dL', low:125, high:200},
      {key:'hdl', name:'HDL', unit:'mg/dL', low:40, high:60},
      {key:'ldl', name:'LDL', unit:'mg/dL', low:0, high:130},
      {key:'tg',  name:'Triglycerides', unit:'mg/dL', low:0, high:150},
    ],
    complex_coag: [
      {key:'pt',  name:'PT', unit:'sec', low:11, high:13.5},
      {key:'inr', name:'INR', unit:'', low:0.8, high:1.2},
      {key:'aptt',name:'APTT', unit:'sec', low:25, high:35},
    ],
    complex_iron: [
      {key:'iron',          name:'Serum Iron', unit:'µg/dL', low:50, high:150},
      {key:'tibc',          name:'TIBC', unit:'µg/dL', low:250, high:400},
      {key:'transferrinSat',name:'Transferrin Sat', unit:'%', low:20, high:50},
      {key:'ferritin',      name:'Ferritin', unit:'ng/mL', low:20, high:300},
    ],
    complex_cardiac: [
      {key:'ckmb',      name:'CK-MB', unit:'U/L', low:0, high:25},
      {key:'troponinI', name:'Troponin I', unit:'ng/mL', low:0, high:0.04},
      {key:'ldh',       name:'LDH', unit:'U/L', low:100, high:200},
    ],
    complex_ogtt: [
      {key:'fasting',   name:'Fasting', unit:'mg/dL', low:70, high:100},
      {key:'one_hour',  name:'1 Hour', unit:'mg/dL', low:0, high:180},
      {key:'two_hour',  name:'2 Hours', unit:'mg/dL', low:0, high:140},
    ],
  };

  // ── Resolve test type: live DB first, then fallback pattern matching ───────
  function _testType(name) {
    if (_testDefs.testTypes[name]) return _testDefs.testTypes[name];
    const n = (name || '').toLowerCase().trim();
    if (/full\s*blood|complete\s*blood|cbc|fbc/.test(n))          return 'complex_cbc';
    if (/liver\s*function|lft/.test(n))                           return 'complex_lft';
    if (/renal\s*function|rft|kidney/.test(n))                    return 'complex_rft';
    if (/thyroid|tsh/.test(n))                                    return 'complex_thyroid';
    if (/lipid|cholesterol/.test(n))                              return 'complex_lipid';
    if (/coagul|prothrombin|pt\/inr|coag/.test(n))               return 'complex_coag';
    if (/iron\s*stud|iron\s*prof|serum\s*iron/.test(n))          return 'complex_iron';
    if (/cardiac|troponin|ckmb/.test(n))                         return 'complex_cardiac';
    if (/ogtt|glucose\s*tolerance/.test(n))                      return 'complex_ogtt';
    if (/packed\s*cell|pcv/.test(n))                             return 'complex_pcv';
    if (/haemoglobin|hemoglobin|\bhb\b/.test(n))                 return 'complex_hb';
    if (/esr|sedimentation/.test(n))                             return 'complex_esr';
    if (/random\s*blood\s*sugar|rbs/.test(n))                    return 'complex_rbs';
    if (/fasting\s*blood\s*sugar|fbs/.test(n))                   return 'complex_fbs';
    return 'simple';
  }

  // ── Extract numeric data points from a result JSON ───────────────────────
  function _extractNumerics(testName, resultJson, age, gender) {
    if (!resultJson || !resultJson.startsWith('{')) return [];
    let d;
    try { d = JSON.parse(resultJson); } catch(e) { return []; }
    const tt  = _testType(testName);
    const out = [];

    // Single-value tests
    const single = { complex_pcv:'pcv', complex_hb:'hb', complex_esr:'esr', complex_rbs:'rbs', complex_fbs:'fbs' };
    if (single[tt]) {
      const key = tt.split('_')[1];
      const val = parseFloat(d[key]);
      if (!isNaN(val)) {
        const rr = _refRange(testName, age, gender) || {low:0,high:100,unit:''};
        out.push({ param: testName, key, val, unit: rr.unit, low: rr.low, high: rr.high });
      }
      return out;
    }

    // Multi-param panels
    const params = PARAM_DEFS[tt] || [];
    params.forEach(p => {
      const val = parseFloat(d[p.key]);
      if (!isNaN(val)) out.push({ param: p.name, key: p.key, val, unit: p.unit, low: p.low, high: p.high });
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

    // Fetch released samples with their tests — use cache when fresh
    let samples = [];
    try {
      if (_analyticsCacheValid()) {
        // Cache hit — re-use existing dataset, skip DB round-trip
        samples = _analyticsCache;
      } else {
        // Cache miss or expired — fetch from DB and store
        const { data, error } = await _db
          .from('samples')
          .select('id,patient,age,gender,collection_date,status,sample_tests(id,test_name,status,result)')
          .eq('status', 'Result Released')
          .order('id', { ascending: false })
          .limit(1000);
        if (error) throw error;
        samples = (data || []).map(s => ({
          ...s,
          collDate: s.collection_date,
          tests: s.sample_tests || []
        }));
        _analyticsCache     = samples;
        _analyticsCacheTime = Date.now();
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
    const testFilt   = document.getElementById('analyticsTestSelect')?.value || '';

    // Apply filters (demographic + unit)
    let filtered = withResults.filter(s => {
      if (dateFrom && (s.collDate || '') < dateFrom) return false;
      if (dateTo   && (s.collDate || '') > dateTo)   return false;
      if (genderFilt !== 'all' && s.gender !== genderFilt) return false;
      const a = parseInt(s.age);
      if (!isNaN(a) && (a < ageMin || a > ageMax)) return false;
      // Unit filter: keep sample only if it has at least one test from that unit
      if (unitFilt) {
        const unitTests = new Set(_testDefs.units[unitFilt] || []);
        const hasUnitTest = (s.tests || []).some(t => unitTests.has(t.test_name) && t.status !== 'Rejected' && t.result);
        if (!hasUnitTest) return false;
      }
      return true;
    });

    // When unit filter is active, only count tests from that unit
    function _testsForUnit(s) {
      if (!unitFilt) return (s.tests || []).filter(t => t.status !== 'Rejected');
      const unitTests = new Set(_testDefs.units[unitFilt] || []);
      return (s.tests || []).filter(t => unitTests.has(t.test_name) && t.status !== 'Rejected');
    }

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
    const totalTests = filtered.reduce((sum, s) => sum + _testsForUnit(s).length, 0);

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
    filtered.forEach(s => _testsForUnit(s).forEach(t => {
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

        // Outliers table
        const outliers = p.vals.filter(x=>x.val>p.high||x.val<p.low)
          .sort((a,b)=>Math.abs(b.val-(b.val>p.high?p.high:p.low))-Math.abs(a.val-(a.val>p.high?p.high:p.low)))
          .slice(0,5);
        const outlierRowsHtml = outliers.map(x => {
          const flag = x.val > p.high ? '↑ HIGH' : '↓ LOW';
          const col  = x.val > p.high ? '#b91c1c' : '#2563eb';
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
            <div class="analytics-inner-title">Notable Outliers (top 5)</div>
            <div style="border:1px solid var(--border);border-radius:10px;overflow:hidden;overflow-x:auto;">
              <table class="analytics-age-table">
                <thead><tr><th>Sample</th><th>Patient</th><th>Demographics</th><th>Value</th><th>Date</th></tr></thead>
                <tbody>${outlierRowsHtml}</tbody>
              </table>
            </div>
          </div>` : ''}
        </div>`;
      }).join('');

      // ── Qualitative deep dive (if no numeric params found) ────────────────
      if (!paramCards) {
        // Collect all key-value pairs from the result JSON for this test
        const qualMap = {}; // { paramKey: { name, values: { val: count } } }
        const QUAL_PARAM_NAMES = {
          // Serology
          hbsag:'HBsAg', anti_hbs:'Anti-HBs', hbeag:'HBeAg', anti_hbe:'Anti-HBe', anti_hbc:'Anti-HBc',
          // Malaria
          species:'Species', stage:'Stage',
          // Widal
          o:'S.Typhi O', h:'S.Typhi H', ao:'S.Paratyphi A (O)', ah:'S.Paratyphi A (H)',
          bo:'S.Paratyphi B (O)', bh:'S.Paratyphi B (H)',
          // TB GeneXpert
          mtb_detected:'MTB Detected', rif_resistance:'Rifampicin Resistance',
          // Culture
          organism:'Organism Isolated',
          // Urinalysis / MCS
          colour:'Colour', appearance:'Appearance', protein:'Protein', glucose:'Glucose',
          ketones:'Ketones', blood:'Blood', bilirubin:'Bilirubin', nitrite:'Nitrite',
          leuko:'Leukocyte Esterase', bacteria:'Bacteria', yeast:'Yeast',
          gram_stain:'Gram Stain', india_ink:'India Ink', crypto_ag:'Cryptococcal Ag',
          // Stool
          consistency:'Consistency', colour_stool:'Colour', blood_stool:'Blood (Macroscopic)',
          mucus_stool:'Mucus', wbc_stool:'WBC (Pus Cells)', rbc_stool:'RBC',
          fat_globules:'Fat Globules', ova_parasite:'Ova/Parasites', yeast_stool:'Yeast',
          occult_blood:'Occult Blood',
          // Semen
          viscosity:'Viscosity',
          // CSF
          gram_stain_csf:'Gram Stain',
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
            // Skip pure numbers (those are handled in quantitative section)
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
          // Colour palette for frequency bars
          const BAR_COLOURS = ['#10b981','#3b82f6','#f59e0b','#ef4444','#8b5cf6','#ec4899','#14b8a6','#f97316'];
          // Decide if a value is a positive/reactive finding
          const POSITIVE_VALUES = new Set([
            'reactive','positive','detected','present','seen','growth','seen (incidental)',
            '+','++','+++','trace','few','moderate','many','turbid','cloudy','bloody',
            'watery','loose','gram positive cocci','gram negative rods','fungi','other'
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
            // Frequency count of unique text results
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
    // We need samples already cached; re-render if data is already showing
    const content = document.getElementById('analyticsContent');
    if (content && !content.querySelector('.analytics-empty')) {
      window.renderAnalytics();
    }
  });

})();
