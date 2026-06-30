// ============================================================
// MU'UJIZA RECORDS — record-admin.js
// Patient search/edit + staff account creation (records_officer /
// records_admin), via the records session token. Independent of
// the lab's admin tooling entirely.
// ============================================================

const SUPABASE_URL      = 'https://npdopywxemtwzvpummsn.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5wZG9weXd4ZW10d3p2cHVtbXNuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk4NzY0MjksImV4cCI6MjA5NTQ1MjQyOX0.Mo5LfGdfSiHL6QHsPOaGkDmeaIRDqZTe8MGwz_6ou1c';

const session = window.recordsSession;

const client = session?.token
  ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { 'x-lis-token': session.token } }
    })
  : window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

document.getElementById('logoutBtn')?.addEventListener('click', () => {
  sessionStorage.removeItem('muujiza_records_session');
  window.location.replace('records-login.html');
});

// ---------- Tabs ----------
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`panel-${btn.dataset.tab}`).classList.add('active');
    clearMsgs();
    if (btn.dataset.tab === 'staff') loadStaff();
  });
});

const errorMsg   = document.getElementById('errorMsg');
const successMsg = document.getElementById('successMsg');
function showError(msg)   { successMsg.classList.remove('show'); errorMsg.textContent = msg; errorMsg.classList.add('show'); }
function showSuccess(msg) { errorMsg.classList.remove('show'); successMsg.textContent = msg; successMsg.classList.add('show'); }
function clearMsgs()      { errorMsg.classList.remove('show'); successMsg.classList.remove('show'); }

// ============================================================
// PATIENTS
// ============================================================
const patientTbody = document.getElementById('patientTbody');

async function searchPatients() {
  clearMsgs();
  const q = document.getElementById('patientSearch').value.trim();
  patientTbody.innerHTML = `<tr><td colspan="7" class="empty">Searching...</td></tr>`;

  let query = client
    .from('patient_registry')
    .select('id,hospital_number,surname,first_name,gender,phone,patient_department,created_at')
    .order('created_at', { ascending: false })
    .limit(50);

  if (q) {
    query = query.or(
      `hospital_number.ilike.%${q}%,surname.ilike.%${q}%,first_name.ilike.%${q}%,phone.ilike.%${q}%`
    );
  }

  const { data, error } = await query;

  if (error) {
    patientTbody.innerHTML = `<tr><td colspan="7" class="empty">Error loading patients</td></tr>`;
    showError(error.message);
    console.error('searchPatients error:', error);
    return;
  }

  console.log('searchPatients result:', data, '| session role:', session?.role, '| token present:', !!session?.token);

  if (!data || data.length === 0) {
    patientTbody.innerHTML = `<tr><td colspan="7" class="empty">No patients found</td></tr>`;
    return;
  }

  patientTbody.innerHTML = data.map(p => `
    <tr data-id="${p.id}">
      <td>${escapeHtml(p.hospital_number)}</td>
      <td>${escapeHtml(p.surname)} ${escapeHtml(p.first_name)}</td>
      <td>${escapeHtml(p.gender || '—')}</td>
      <td>${escapeHtml(p.phone || '—')}</td>
      <td>${escapeHtml(p.patient_department || '—')}</td>
      <td>${p.created_at ? new Date(p.created_at).toLocaleDateString() : '—'}</td>
      <td><button class="btn-ghost btn-small edit-btn" data-id="${p.id}">Edit</button></td>
    </tr>
  `).join('');

  patientTbody.querySelectorAll('.edit-btn').forEach(btn => {
    btn.addEventListener('click', () => openEditModal(btn.dataset.id));
  });
}

document.getElementById('searchBtn').addEventListener('click', searchPatients);
document.getElementById('patientSearch').addEventListener('keydown', e => { if (e.key === 'Enter') searchPatients(); });
document.getElementById('clearSearchBtn').addEventListener('click', () => {
  document.getElementById('patientSearch').value = '';
  patientTbody.innerHTML = `<tr><td colspan="7" class="empty">Search to view patients</td></tr>`;
});

// ---------- Edit modal ----------
const editModalBg = document.getElementById('editModalBg');
let editingId = null;

async function openEditModal(id) {
  clearMsgs();
  const { data, error } = await client
    .from('patient_registry')
    .select('*')
    .eq('id', id)
    .single();

  if (error || !data) { showError('Could not load patient record.'); return; }

  editingId = id;
  document.getElementById('e_surname').value = data.surname || '';
  document.getElementById('e_first_name').value = data.first_name || '';
  document.getElementById('e_phone').value = data.phone || '';
  document.getElementById('e_whatsapp_number').value = data.whatsapp_number || '';
  document.getElementById('e_address').value = data.address || '';
  document.getElementById('e_patient_department').value = data.patient_department || '';
  document.getElementById('e_assigned_doctor').value = data.assigned_doctor || '';
  editModalBg.classList.add('show');
}

document.getElementById('cancelEditBtn').addEventListener('click', () => {
  editModalBg.classList.remove('show');
  editingId = null;
});

document.getElementById('saveEditBtn').addEventListener('click', async () => {
  if (!editingId) return;
  clearMsgs();

  const updates = {
    surname:             document.getElementById('e_surname').value.trim(),
    first_name:          document.getElementById('e_first_name').value.trim(),
    phone:               document.getElementById('e_phone').value.trim() || null,
    whatsapp_number:     document.getElementById('e_whatsapp_number').value.trim() || null,
    address:             document.getElementById('e_address').value.trim() || null,
    patient_department:  document.getElementById('e_patient_department').value.trim() || null,
    assigned_doctor:     document.getElementById('e_assigned_doctor').value.trim() || null
  };

  const { error } = await client
    .from('patient_registry')
    .update(updates)
    .eq('id', editingId);

  if (error) { showError(error.message); return; }

  editModalBg.classList.remove('show');
  editingId = null;
  showSuccess('Patient updated successfully.');
  searchPatients();
});

// ============================================================
// STAFF ACCOUNTS
// ============================================================
const staffTbody = document.getElementById('staffTbody');

async function loadStaff() {
  staffTbody.innerHTML = `<tr><td colspan="5" class="empty">Loading...</td></tr>`;

  const { data, error } = await client
    .from('admins')
    .select('username,role,is_active,created_at')
    .in('role', ['records_officer', 'records_admin'])
    .order('created_at', { ascending: false });

  if (error) {
    staffTbody.innerHTML = `<tr><td colspan="5" class="empty">Error loading staff</td></tr>`;
    return;
  }

  if (!data || data.length === 0) {
    staffTbody.innerHTML = `<tr><td colspan="5" class="empty">No staff accounts yet</td></tr>`;
    return;
  }

  staffTbody.innerHTML = data.map(u => `
    <tr>
      <td>${escapeHtml(u.username)}</td>
      <td>${u.role === 'records_admin' ? 'Records Admin' : 'Records Officer'}</td>
      <td><span class="badge ${u.is_active ? 'active' : 'inactive'}">${u.is_active ? 'Active' : 'Inactive'}</span></td>
      <td>${u.created_at ? new Date(u.created_at).toLocaleDateString() : '—'}</td>
      <td>
        <button class="btn-ghost btn-small toggle-status-btn"
                data-username="${escapeHtml(u.username)}"
                data-active="${u.is_active}">
          ${u.is_active ? 'Deactivate' : 'Activate'}
        </button>
      </td>
    </tr>
  `).join('');

  staffTbody.querySelectorAll('.toggle-status-btn').forEach(btn => {
    btn.addEventListener('click', () => toggleStaffStatus(btn.dataset.username, btn.dataset.active === 'true'));
  });
}

async function toggleStaffStatus(username, currentlyActive) {
  clearMsgs();
  const newStatus = !currentlyActive;

  try {
    const { data, error } = await client.rpc('toggle_records_user_status', {
      p_token:    session?.token || null,
      p_username: username,
      p_active:   newStatus
    });

    if (error) throw error;

    const result = Array.isArray(data) ? data[0] : data;
    if (!result?.success) throw new Error(result?.message || 'Failed to update status.');

    showSuccess(result.message || 'Status updated.');
    loadStaff();

  } catch (err) {
    showError(err.message || 'Failed to update status.');
  }
}

document.getElementById('createUserBtn').addEventListener('click', async () => {
  clearMsgs();
  const username = document.getElementById('newUsername').value.trim();
  const password = document.getElementById('newPassword').value;
  const role     = document.getElementById('newRole').value;

  if (!username || username.length < 3) return showError('Username must be at least 3 characters.');
  if (!password || password.length < 6) return showError('Password must be at least 6 characters.');

  const btn = document.getElementById('createUserBtn');
  btn.disabled = true;
  btn.textContent = 'Creating...';

  try {
    const { data, error } = await client.rpc('create_records_user', {
      p_token:    session?.token || null,
      p_username: username,
      p_password: password,
      p_role:     role
    });

    if (error) throw error;

    const result = Array.isArray(data) ? data[0] : data;
    if (!result?.success) throw new Error(result?.message || 'Failed to create user.');

    showSuccess(result.message || 'User created successfully.');
    document.getElementById('newUsername').value = '';
    document.getElementById('newPassword').value = '';
    loadStaff();

  } catch (err) {
    showError(err.message || 'Failed to create user.');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Create Account';
  }
});

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// Initial load
searchPatients();
