// ============================================================
// MU'UJIZA Ward/IPD — ward-admin.js  (ward_admin dashboard)
// Reads from: wards, beds, admissions, staff_accounts
// Writes via RPCs: create_ward, add_beds_to_ward, set_bed_status
//                  (see ward_schema.sql), + create_staff_account /
//                  set_staff_status (see ⚠️ ASSUMPTION note below)
// ============================================================
const SUPABASE_URL      = 'https://npdopywxemtwzvpummsn.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5wZG9weXd4ZW10d3p2cHVtbXNuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk4NzY0MjksImV4cCI6MjA5NTQ1MjQyOX0.Mo5LfGdfSiHL6QHsPOaGkDmeaIRDqZTe8MGwz_6ou1c';
const SESSION_KEY = 'muujiza_ward_session';

// Staff tab mirrors pharmacy-admin.js exactly: create_ward_user /
// list_ward_staff / toggle_records_user_status (see ward_module_schema.sql §6).

let session = window.wardSession;
if(!session){
  try{ session = JSON.parse(sessionStorage.getItem(SESSION_KEY)||'null'); }catch{ session = null; }
  if(!session || !session.token || Date.now() > session.expiresAt || session.role !== 'ward_admin'){
    window.location.replace('ward-login.html');
    throw new Error('No valid ward_admin session.');
  }
}

const client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  global: { headers: { 'x-lis-token': session.token } }
});

document.getElementById('userLabel').textContent = session.name || session.username;
document.getElementById('logoutBtn').addEventListener('click', () => {
  sessionStorage.removeItem(SESSION_KEY);
  window.location.replace('ward-login.html');
});

const errorMsg   = document.getElementById('errorMsg');
const successMsg = document.getElementById('successMsg');
function showError(m)  { successMsg.classList.remove('show'); errorMsg.textContent=m; errorMsg.classList.add('show'); }
function showSuccess(m){ errorMsg.classList.remove('show'); successMsg.textContent=m; successMsg.classList.add('show'); }
function clearMsgs()   { errorMsg.classList.remove('show'); successMsg.classList.remove('show'); }
function esc(s){ if(s==null||s==='') return '—'; return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function sv(id){ const v=document.getElementById(id)?.value?.trim(); return v===''?null:v; }
function fmtTime(ts){ return ts ? new Date(ts).toLocaleString('en-NG',{dateStyle:'medium',timeStyle:'short'}) : '—'; }
function fmtDate(ts){ return ts ? new Date(ts).toLocaleDateString('en-NG',{dateStyle:'medium'}) : '—'; }

// ============================================================
// TABS
// ============================================================
document.querySelectorAll('.tab-btn').forEach(btn=>{
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b=>b.classList.toggle('active', b===btn));
    document.querySelectorAll('.panel').forEach(p=>p.classList.toggle('active', p.id===`panel-${btn.dataset.tab}`));
    clearMsgs();
  });
});

// ============================================================
// WARDS & BEDS
// ============================================================
let wardsCache = [];
let bedsCache  = [];
let openWardId = null;

async function loadWards(){
  const [{data: wData, error: wErr}, {data: bData, error: bErr}] = await Promise.all([
    client.from('wards').select('id,ward_name,department,is_active,created_at').order('ward_name'),
    client.from('beds').select('id,ward_id,bed_number,status').order('bed_number')
  ]);
  if(wErr){ showError(wErr.message); return; }
  if(bErr){ showError(bErr.message); return; }
  wardsCache = wData||[];
  bedsCache  = bData||[];
  renderWards();
}

function bedsFor(wardId){ return bedsCache.filter(b=>b.ward_id===wardId); }

function renderWards(){
  const list = document.getElementById('wardsList');
  if(wardsCache.length===0){ list.innerHTML = `<div class="empty">No wards created yet.</div>`; return; }

  list.innerHTML = wardsCache.map(w => {
    const beds = bedsFor(w.id);
    const avail = beds.filter(b=>b.status==='available').length;
    const occ   = beds.filter(b=>b.status==='occupied').length;
    const maint = beds.filter(b=>b.status==='maintenance').length;
    const isOpen = openWardId===w.id;
    return `
    <div class="ward-card">
      <div class="ward-head" data-toggle="${w.id}">
        <div><span class="ward-name">${esc(w.ward_name)}</span><span class="ward-dept">${esc(w.department)}</span></div>
        <div class="bed-tally">
          <span><b>${beds.length}</b> total</span>
          <span style="color:var(--green)"><b>${avail}</b> free</span>
          <span style="color:var(--warn)"><b>${occ}</b> occupied</span>
          ${maint>0?`<span style="color:var(--error)"><b>${maint}</b> maint.</span>`:''}
        </div>
      </div>
      <div class="ward-body ${isOpen?'open':''}" id="wardbody-${w.id}">
        <div class="bed-grid">
          ${beds.length===0 ? '<div class="empty">No beds yet.</div>' : beds.map(b => `
            <div class="bed-chip">
              <div class="bn">${esc(b.bed_number)}</div>
              <select data-bedstatus="${b.id}">
                <option value="available" ${b.status==='available'?'selected':''}>Available</option>
                <option value="occupied" ${b.status==='occupied'?'selected':''}>Occupied</option>
                <option value="maintenance" ${b.status==='maintenance'?'selected':''}>Maintenance</option>
              </select>
            </div>`).join('')}
        </div>
        <div class="add-beds-row">
          <div class="field"><label>Add more beds</label><input type="number" min="1" value="1" data-addcount="${w.id}"></div>
          <button class="btn-primary btn-small" data-addbeds="${w.id}">+ Add Beds</button>
        </div>
      </div>
    </div>`;
  }).join('');

  list.querySelectorAll('[data-toggle]').forEach(el=>{
    el.addEventListener('click', () => {
      const id = el.dataset.toggle;
      openWardId = openWardId===id ? null : id;
      renderWards();
    });
  });
  list.querySelectorAll('[data-bedstatus]').forEach(sel=>{
    sel.addEventListener('change', () => setBedStatus(sel.dataset.bedstatus, sel.value));
  });
  list.querySelectorAll('[data-addbeds]').forEach(btn=>{
    btn.addEventListener('click', () => addBeds(btn.dataset.addbeds));
  });
}

document.getElementById('createWardBtn').addEventListener('click', async () => {
  clearMsgs();
  const name = sv('newWardName');
  if(!name) return showError('Ward name is required.');
  const dept = sv('newWardDept');
  const bedCount = parseInt(document.getElementById('newWardBeds').value)||0;

  const btn = document.getElementById('createWardBtn');
  btn.disabled = true; btn.textContent = 'Creating...';
  try{
    const { data, error } = await client.rpc('create_ward', {
      p_token: session.token, p_ward_name: name, p_department: dept, p_bed_count: 0
    });
    if(error) throw error;
    const r = Array.isArray(data)?data[0]:data;
    if(!r?.success) throw new Error(r?.message || 'Failed to create ward.');

    if(bedCount>0){
      const { data: bData, error: bErr } = await client.rpc('add_beds_to_ward', {
        p_token: session.token, p_ward_id: r.ward_id, p_count: bedCount
      });
      if(bErr) throw bErr;
      const br = Array.isArray(bData)?bData[0]:bData;
      if(!br?.success) throw new Error(br?.message || 'Ward created but beds failed to add.');
    }

    showSuccess(`✅ Ward "${name}" created${bedCount>0?` with ${bedCount} bed(s)`:''}.`);
    document.getElementById('newWardName').value='';
    document.getElementById('newWardDept').value='';
    document.getElementById('newWardBeds').value='0';
    await loadWards();
  }catch(err){ showError(err.message||'Failed to create ward.'); }
  finally{ btn.disabled=false; btn.textContent='Create Ward'; }
});

async function addBeds(wardId){
  clearMsgs();
  const input = document.querySelector(`[data-addcount="${wardId}"]`);
  const count = parseInt(input?.value)||0;
  if(count<=0) return showError('Enter a number of beds greater than zero.');

  try{
    const { data, error } = await client.rpc('add_beds_to_ward', {
      p_token: session.token, p_ward_id: wardId, p_count: count
    });
    if(error) throw error;
    const r = Array.isArray(data)?data[0]:data;
    if(!r?.success) throw new Error(r?.message || 'Failed to add beds.');
    showSuccess(`✅ ${r.message}`);
    openWardId = wardId;
    await loadWards();
  }catch(err){ showError(err.message||'Failed to add beds.'); }
}

async function setBedStatus(bedId, status){
  clearMsgs();
  try{
    const { data, error } = await client.rpc('set_bed_status', {
      p_token: session.token, p_bed_id: bedId, p_status: status
    });
    if(error) throw error;
    const r = Array.isArray(data)?data[0]:data;
    if(!r?.success) throw new Error(r?.message || 'Failed to update bed.');
    showSuccess('✅ Bed status updated.');
    await loadWards();
  }catch(err){ showError(err.message||'Failed to update bed.'); }
}

// ============================================================
// ADMISSION HISTORY
// ============================================================
async function loadAdmissionHistory(){
  let q = client.from('admissions')
    .select('id,hospital_number,admitting_doctor,admission_diagnosis,status,admitted_at,discharged_at,wards(ward_name),beds(bed_number)')
    .order('created_at',{ascending:false})
    .limit(100);

  const hospNum = sv('admSearch');
  const status  = sv('admStatusFilter');
  if(hospNum) q = q.ilike('hospital_number', `%${hospNum}%`);
  if(status)  q = q.eq('status', status);

  const { data, error } = await q;
  const tbody = document.getElementById('admTbody');
  if(error){ tbody.innerHTML = `<tr><td colspan="8" class="empty">${esc(error.message)}</td></tr>`; return; }
  if(!data || data.length===0){ tbody.innerHTML = `<tr><td colspan="8" class="empty">No admissions found.</td></tr>`; return; }

  tbody.innerHTML = data.map(a => `
    <tr>
      <td>${esc(a.hospital_number)}</td>
      <td>${esc(a.wards?.ward_name)}</td>
      <td>${esc(a.beds?.bed_number)}</td>
      <td>${esc(a.admitting_doctor)}</td>
      <td>${esc(a.admission_diagnosis)}</td>
      <td><span class="status-badge ${a.status}">${a.status.replace('_',' ').toUpperCase()}</span></td>
      <td>${fmtTime(a.admitted_at)}</td>
      <td>${fmtTime(a.discharged_at)}</td>
    </tr>`).join('');
}

document.getElementById('searchAdmBtn').addEventListener('click', loadAdmissionHistory);
document.getElementById('admSearch').addEventListener('keydown', e=>{ if(e.key==='Enter') loadAdmissionHistory(); });
document.getElementById('clearAdmBtn').addEventListener('click', () => {
  document.getElementById('admSearch').value='';
  document.getElementById('admStatusFilter').value='';
  loadAdmissionHistory();
});

// ============================================================
// STAFF ACCOUNTS
// ============================================================
async function loadStaff(){
  const tbody = document.getElementById('staffTbody');
  tbody.innerHTML = `<tr><td colspan="5" class="empty">Loading...</td></tr>`;
  const { data, error } = await client.rpc('list_ward_staff', { p_token: session.token });
  if(error){ tbody.innerHTML = `<tr><td colspan="5" class="empty">${esc(error.message)}</td></tr>`; return; }
  if(!data || data.length===0){ tbody.innerHTML = `<tr><td colspan="5" class="empty">No ward staff accounts yet.</td></tr>`; return; }

  tbody.innerHTML = data.map(s => `
    <tr>
      <td>${esc(s.username)}</td>
      <td>${s.role==='ward_admin'?'Ward Admin':'Ward Nurse'}</td>
      <td><span class="status-badge ${s.is_active?'active':'disabled'}">${s.is_active?'ACTIVE':'INACTIVE'}</span></td>
      <td>${fmtDate(s.created_at)}</td>
      <td><button class="btn-ghost btn-small" data-toggleuser="${esc(s.username)}" data-active="${s.is_active}">
        ${s.is_active ? 'Deactivate' : 'Activate'}
      </button></td>
    </tr>`).join('');

  tbody.querySelectorAll('[data-toggleuser]').forEach(btn=>{
    btn.addEventListener('click', () => toggleStaffStatus(btn.dataset.toggleuser, btn.dataset.active==='true'));
  });
}

document.getElementById('createUserBtn').addEventListener('click', async () => {
  clearMsgs();
  const username = sv('newUsername');
  const password = sv('newPassword');
  const role     = sv('newRole');
  if(!username || username.length<3) return showError('Username must be at least 3 characters.');
  if(!password || password.length<6) return showError('Password must be at least 6 characters.');

  const btn = document.getElementById('createUserBtn');
  btn.disabled = true; btn.textContent = 'Creating...';
  try{
    const { data, error } = await client.rpc('create_ward_user', {
      p_token: session.token, p_username: username, p_password: password, p_role: role
    });
    if(error) throw error;
    const r = Array.isArray(data)?data[0]:data;
    if(!r?.success) throw new Error(r?.message || 'Failed to create account.');
    showSuccess(`✅ ${r.message}`);
    document.getElementById('newUsername').value='';
    document.getElementById('newPassword').value='';
    await loadStaff();
  }catch(err){ showError(err.message||'Failed to create account.'); }
  finally{ btn.disabled=false; btn.textContent='Create Account'; }
});

async function toggleStaffStatus(username, currentlyActive){
  clearMsgs();
  try{
    const { data, error } = await client.rpc('toggle_ward_user_status', {
      p_token: session.token, p_username: username, p_active: !currentlyActive
    });
    if(error) throw error;
    const r = Array.isArray(data)?data[0]:data;
    if(!r?.success) throw new Error(r?.message || 'Failed to update account.');
    showSuccess(`✅ ${r.message}`);
    await loadStaff();
  }catch(err){ showError(err.message||'Failed to update account.'); }
}

// ============================================================
// INIT
// ============================================================
loadWards();
loadAdmissionHistory();
loadStaff();
