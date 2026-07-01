const SUPABASE_URL      = 'https://npdopywxemtwzvpummsn.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5wZG9weXd4ZW10d3p2cHVtbXNuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk4NzY0MjksImV4cCI6MjA5NTQ1MjQyOX0.Mo5LfGdfSiHL6QHsPOaGkDmeaIRDqZTe8MGwz_6ou1c';

const session = window.opdSession;
const client  = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  global: { headers: { 'x-lis-token': session.token } }
});

document.getElementById('userLabel').textContent = session.name || session.username;
document.getElementById('logoutBtn').addEventListener('click', () => {
  sessionStorage.removeItem('muujiza_opd_session'); window.location.replace('opd-login.html');
});

const errorMsg   = document.getElementById('errorMsg');
const successMsg = document.getElementById('successMsg');
function showError(m)  { successMsg.classList.remove('show'); errorMsg.textContent=m; errorMsg.classList.add('show'); }
function showSuccess(m){ errorMsg.classList.remove('show'); successMsg.textContent=m; successMsg.classList.add('show'); }
function clearMsgs()   { errorMsg.classList.remove('show'); successMsg.classList.remove('show'); }
function esc(s){ if(!s)return'—'; return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

// Tabs
document.querySelectorAll('.tab-btn').forEach(btn=>{
  btn.addEventListener('click',()=>{
    document.querySelectorAll('.tab-btn').forEach(b=>b.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(p=>p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`panel-${btn.dataset.tab}`).classList.add('active');
    clearMsgs();
    if(btn.dataset.tab==='staff') loadStaff();
  });
});

// Set today's date as default
document.getElementById('visitDate').value = new Date().toISOString().split('T')[0];

// ---- Visit history ----
async function searchVisits(){
  clearMsgs();
  const date = document.getElementById('visitDate').value;
  const q    = document.getElementById('visitSearch').value.trim();
  const tbody = document.getElementById('visitsTbody');
  tbody.innerHTML = `<tr><td colspan="8" class="empty">Loading...</td></tr>`;

  let query = client.from('opd_visits')
    .select(`id,hospital_number,status,triage_category,chief_complaint,seen_by_nurse,assigned_doctor,queued_at,visit_date,
             patient_registry(surname,first_name)`)
    .order('queued_at',{ascending:false}).limit(100);

  if(date) query = query.eq('visit_date',date);
  if(q)    query = query.or(`hospital_number.ilike.%${q}%`);

  const { data, error } = await query;
  if(error){ showError(error.message); tbody.innerHTML=`<tr><td colspan="8" class="empty">Error</td></tr>`; return; }
  if(!data||data.length===0){ tbody.innerHTML=`<tr><td colspan="8" class="empty">No visits found</td></tr>`; return; }

  tbody.innerHTML = data.map(v=>{
    const p = v.patient_registry;
    const name = p?`${p.surname} ${p.first_name}`:'—';
    const t = v.triage_category||'';
    return `<tr>
      <td style="font-family:'JetBrains Mono',monospace;font-size:0.78rem;">${esc(v.hospital_number)}</td>
      <td>${esc(name)}</td>
      <td>${t?`<span class="triage-badge ${t}">${t}</span>`:'—'}</td>
      <td><span class="status-badge ${v.status}">${v.status.replace('_',' ')}</span></td>
      <td>${esc(v.chief_complaint)}</td>
      <td>${esc(v.seen_by_nurse)}</td>
      <td>${esc(v.assigned_doctor)}</td>
      <td style="font-size:0.76rem;">${v.queued_at?new Date(v.queued_at).toLocaleTimeString('en-NG',{hour:'2-digit',minute:'2-digit'}):''}</td>
    </tr>`;
  }).join('');
}

document.getElementById('searchVisitsBtn').addEventListener('click', searchVisits);
document.getElementById('clearVisitsBtn').addEventListener('click', ()=>{
  document.getElementById('visitSearch').value='';
  document.getElementById('visitDate').value=new Date().toISOString().split('T')[0];
  searchVisits();
});

// ---- Staff ----
async function loadStaff(){
  const tbody = document.getElementById('staffTbody');
  tbody.innerHTML=`<tr><td colspan="5" class="empty">Loading...</td></tr>`;
  const { data, error } = await client.from('admins')
    .select('username,role,is_active,created_at')
    .in('role',['opd_nurse','opd_admin']).order('created_at',{ascending:false});
  if(error){ tbody.innerHTML=`<tr><td colspan="5" class="empty">Error loading staff</td></tr>`; return; }
  if(!data||data.length===0){ tbody.innerHTML=`<tr><td colspan="5" class="empty">No OPD staff yet</td></tr>`; return; }
  tbody.innerHTML = data.map(u=>`<tr>
    <td>${esc(u.username)}</td>
    <td>${u.role==='opd_admin'?'OPD Admin':'OPD Nurse'}</td>
    <td><span style="color:${u.is_active?'#3ddc97':'#ff6b6b'}">${u.is_active?'Active':'Inactive'}</span></td>
    <td style="font-size:0.76rem;">${u.created_at?new Date(u.created_at).toLocaleDateString():''}</td>
    <td><button class="btn-ghost btn-small toggle-btn" data-username="${esc(u.username)}" data-active="${u.is_active}">
      ${u.is_active?'Deactivate':'Activate'}</button></td>
  </tr>`).join('');

  tbody.querySelectorAll('.toggle-btn').forEach(btn=>{
    btn.addEventListener('click',async()=>{
      clearMsgs();
      const { data:d, error:e } = await client.rpc('toggle_records_user_status',{
        p_token:session.token, p_username:btn.dataset.username, p_active:btn.dataset.active==='true'?false:true
      });
      if(e){ showError(e.message); return; }
      const r=Array.isArray(d)?d[0]:d;
      if(!r?.success){ showError(r?.message||'Failed'); return; }
      showSuccess(r.message); loadStaff();
    });
  });
}

document.getElementById('createUserBtn').addEventListener('click', async()=>{
  clearMsgs();
  const username = document.getElementById('newUsername').value.trim();
  const password = document.getElementById('newPassword').value;
  const role     = document.getElementById('newRole').value;
  if(!username||username.length<3) return showError('Username must be at least 3 characters.');
  if(!password||password.length<6) return showError('Password must be at least 6 characters.');

  const btn = document.getElementById('createUserBtn');
  btn.disabled=true; btn.textContent='Creating...';
  try{
    const { data, error } = await client.rpc('create_records_user',{
      p_token:session.token, p_username:username, p_password:password, p_role:role
    });
    if(error) throw error;
    const r=Array.isArray(data)?data[0]:data;
    if(!r?.success) throw new Error(r?.message||'Failed.');
    showSuccess(r.message);
    document.getElementById('newUsername').value='';
    document.getElementById('newPassword').value='';
    loadStaff();
  }catch(err){ showError(err.message||'Failed.'); }
  finally{ btn.disabled=false; btn.textContent='Create Account'; }
});

// Init
searchVisits();
