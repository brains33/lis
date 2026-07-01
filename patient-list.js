// ============================================================
// MU'UJIZA RECORDS — patient-list.js
// ============================================================

const SUPABASE_URL      = 'https://npdopywxemtwzvpummsn.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5wZG9weXd4ZW10d3p2cHVtbXNuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk4NzY0MjksImV4cCI6MjA5NTQ1MjQyOX0.Mo5LfGdfSiHL6QHsPOaGkDmeaIRDqZTe8MGwz_6ou1c';

const session = window.recordsSession;
const client = session?.token
  ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { 'x-lis-token': session.token } }
    })
  : window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const userLabel = document.getElementById('userLabel');
if (userLabel && session?.name) userLabel.textContent = session.name;

document.getElementById('logoutBtn')?.addEventListener('click', () => {
  sessionStorage.removeItem('muujiza_records_session');
  window.location.replace('records-login.html');
});

const tbody    = document.getElementById('tbody');
const errorMsg = document.getElementById('errorMsg');
function showError(msg) { errorMsg.textContent = msg; errorMsg.classList.add('show'); }

function escapeHtml(str) {
  if (!str) return '—';
  return String(str).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// ---- Stats ----
async function loadStats() {
  const today = new Date().toISOString().split('T')[0];
  const [{ count: total }, { count: todayCount }] = await Promise.all([
    client.from('patient_registry').select('*', { count: 'exact', head: true }),
    client.from('patient_registry').select('*', { count: 'exact', head: true }).gte('created_at', today)
  ]);
  document.getElementById('totalCount').textContent = total ?? '—';
  document.getElementById('todayCount').textContent = todayCount ?? '—';
}

// ---- Load patients ----
async function loadPatients(q = '') {
  tbody.innerHTML = `<tr><td colspan="8" class="empty">Loading...</td></tr>`;
  errorMsg.classList.remove('show');

  let query = client
    .from('patient_registry')
    .select('id,hospital_number,surname,first_name,middle_name,gender,phone,nin,patient_department,date_of_birth,age,blood_group,genotype,address,patient_type,assigned_doctor,created_at')
    .order('created_at', { ascending: false })
    .limit(100);

  if (q) {
    query = query.or(
      `hospital_number.ilike.%${q}%,surname.ilike.%${q}%,first_name.ilike.%${q}%,phone.ilike.%${q}%,nin.ilike.%${q}%`
    );
  }

  const { data, error } = await query;

  if (error) { showError(error.message); tbody.innerHTML = `<tr><td colspan="8" class="empty">Error loading patients.</td></tr>`; return; }
  if (!data || data.length === 0) { tbody.innerHTML = `<tr><td colspan="8" class="empty">No patients found.</td></tr>`; return; }

  tbody.innerHTML = data.map(p => `
    <tr>
      <td style="font-family:'JetBrains Mono',monospace;font-size:0.8rem;">${escapeHtml(p.hospital_number)}</td>
      <td>${escapeHtml(p.surname)} ${escapeHtml(p.first_name)}</td>
      <td>${escapeHtml(p.gender)}</td>
      <td>${escapeHtml(p.phone)}</td>
      <td style="font-size:0.78rem;">${escapeHtml(p.nin)}</td>
      <td>${escapeHtml(p.patient_department)}</td>
      <td style="font-size:0.78rem;">${p.created_at ? new Date(p.created_at).toLocaleDateString('en-GB') : '—'}</td>
      <td>
        <button class="btn-ghost btn-small print-btn" data-id="${p.id}">🖨 Print</button>
      </td>
    </tr>
  `).join('');

  // store data for print lookup
  window._patientData = data;

  tbody.querySelectorAll('.print-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const record = window._patientData.find(p => p.id === btn.dataset.id);
      if (record) { populatePrintCard(record); window.print(); }
    });
  });
}

document.getElementById('searchBtn').addEventListener('click', () => loadPatients(document.getElementById('searchInput').value.trim()));
document.getElementById('searchInput').addEventListener('keydown', e => { if (e.key === 'Enter') loadPatients(document.getElementById('searchInput').value.trim()); });
document.getElementById('clearBtn').addEventListener('click', () => {
  document.getElementById('searchInput').value = '';
  loadPatients();
});

// ---- Print card ----
function populatePrintCard(d) {
  const nameParts = [d.surname, d.first_name, d.middle_name].filter(Boolean);
  document.getElementById('pc_hospno').textContent  = d.hospital_number || '—';
  document.getElementById('pc_name').textContent    = nameParts.join(' ') || '—';
  document.getElementById('pc_dob').textContent     = d.date_of_birth ? new Date(d.date_of_birth).toLocaleDateString('en-GB') : (d.age ? `Age: ${d.age}` : '—');
  document.getElementById('pc_gender').textContent  = d.gender || '—';
  document.getElementById('pc_nin').textContent     = d.nin || '—';
  document.getElementById('pc_blood').textContent   = d.blood_group || '—';
  document.getElementById('pc_geno').textContent    = d.genotype || '—';
  document.getElementById('pc_phone').textContent   = d.phone || '—';
  document.getElementById('pc_address').textContent = d.address || '—';
  document.getElementById('pc_dept').textContent    = d.patient_department || '—';
  document.getElementById('pc_type').textContent    = d.patient_type || '—';
  document.getElementById('pc_doctor').textContent  = d.assigned_doctor || '—';
  document.getElementById('pc_date').textContent    = new Date(d.created_at).toLocaleDateString('en-GB');
}

// Initial load
loadStats();
loadPatients();
