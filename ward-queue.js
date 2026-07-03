// ============================================================
// MU'UJIZA Ward/IPD — ward-queue.js  (Nurse chart view)
// Reads from: admissions, wards, beds, doctor_orders, nursing_notes,
//             mar, vitals
// Writes via RPCs: assign_bed, record_nursing_vitals, add_nursing_note,
//                   record_mar_dose  (see ward_schema.sql)
// ============================================================
const SUPABASE_URL      = 'https://npdopywxemtwzvpummsn.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5wZG9weXd4ZW10d3p2cHVtbXNuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk4NzY0MjksImV4cCI6MjA5NTQ1MjQyOX0.Mo5LfGdfSiHL6QHsPOaGkDmeaIRDqZTe8MGwz_6ou1c';
const SESSION_KEY = 'muujiza_ward_session';

// Prefer window.wardSession if a ward-auth-guard.js (same pattern as
// opd-auth-guard.js) has already set it. Fall back to reading the
// session directly so this page still works standalone until that
// guard file exists — swap this block out once it does.
let session = window.wardSession;
if(!session){
  try{ session = JSON.parse(sessionStorage.getItem(SESSION_KEY)||'null'); }catch{ session = null; }
  if(!session || !session.token || Date.now() > session.expiresAt || session.role !== 'ward_nurse'){
    window.location.replace('ward-login.html');
    throw new Error('No valid ward_nurse session.');
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
function nv(id){ const v=document.getElementById(id)?.value?.trim(); return v===''||v===undefined?null:Number(v); }
function sv(id){ const v=document.getElementById(id)?.value?.trim(); return v===''?null:v; }
function fmtTime(ts){ return ts ? new Date(ts).toLocaleString('en-NG',{dateStyle:'medium',timeStyle:'short'}) : '—'; }

// Adult-only reference ranges for the ward vitals chip flagging.
// (Ward patients skew adult; if pediatric wards are added later,
// port the age-band logic from opd-queue.js's VITAL_FIELD_MAP.)
const ADULT_RANGES = {
  bp_sys:[90,140], bp_dia:[60,90], temp:[35.5,37.8], pulse:[50,120], rr:[10,24], spo2:[94,101]
};
function flagValue(value, param){
  if(value==null||isNaN(value)) return null;
  const r = ADULT_RANGES[param];
  if(!r) return null;
  if(value>r[1]) return 'high';
  if(value<r[0]) return 'low';
  return 'normal';
}

// ============================================================
// STATE
// ============================================================
let wards = [];          // {id, ward_name}
let beds = [];           // {id, ward_id, bed_number, status}
let pendingAdmissions = [];
let activeAdmissions  = [];
let selectedAdmission = null;
let selectedOrders    = [];  // cached for MAR "from order" dropdown

// ============================================================
// LOAD WARDS + BEDS (cached, used for filters / assign-bed / stats)
// ============================================================
async function loadWardsAndBeds(){
  const [{data: wData, error: wErr}, {data: bData, error: bErr}] = await Promise.all([
    client.from('wards').select('id,ward_name').eq('is_active',true).order('ward_name'),
    client.from('beds').select('id,ward_id,bed_number,status').order('bed_number')
  ]);
  if(wErr){ showError(wErr.message); return; }
  if(bErr){ showError(bErr.message); return; }
  wards = wData||[];
  beds  = bData||[];

  const wf = document.getElementById('wardFilter');
  const current = wf.value;
  wf.innerHTML = '<option value="">All wards</option>' +
    wards.map(w=>`<option value="${w.id}">${esc(w.ward_name)}</option>`).join('');
  wf.value = current;

  const free = beds.filter(b=>b.status==='available').length;
  const occ  = beds.filter(b=>b.status==='occupied').length;
  document.getElementById('s_beds_free').textContent = free;
  document.getElementById('s_beds_occ').textContent  = occ;
}

function wardName(id){ return wards.find(w=>w.id===id)?.ward_name || '—'; }
function bedsForWard(wardId, statusFilter){
  return beds.filter(b=>b.ward_id===wardId && (!statusFilter || b.status===statusFilter));
}

// ============================================================
// LOAD ADMISSIONS
// ============================================================
async function loadAdmissions(){
  const { data, error } = await client.from('admissions')
    .select('id,hospital_number,ward_id,bed_id,admitting_doctor,admission_diagnosis,allergy_note,status,admitted_at,created_at,beds(bed_number)')
    .in('status',['pending_bed','admitted'])
    .order('created_at',{ascending:true});

  if(error){ showError(error.message); return; }

  pendingAdmissions = (data||[]).filter(a=>a.status==='pending_bed');
  activeAdmissions  = (data||[]).filter(a=>a.status==='admitted');

  document.getElementById('s_admitted').textContent = activeAdmissions.length;
  document.getElementById('s_pending').textContent  = pendingAdmissions.length;

  renderPending();
  renderActive();
}

function renderPending(){
  const list = document.getElementById('pendingList');
  document.getElementById('pendingCount').textContent = pendingAdmissions.length;

  if(pendingAdmissions.length===0){ list.innerHTML = `<div class="empty">No patients awaiting a bed</div>`; return; }

  list.innerHTML = pendingAdmissions.map(a => {
    const availBeds = bedsForWard(a.ward_id,'available');
    return `
    <div class="pending-item" data-id="${a.id}">
      <div class="qi-top">
        <span class="qi-hospno">${esc(a.hospital_number)}</span>
        <span class="qi-bed">${esc(wardName(a.ward_id))}</span>
      </div>
      <div class="qi-dx">${esc(a.admission_diagnosis)}</div>
      <div class="qi-doc">Dr. ${esc(a.admitting_doctor)}</div>
      <div class="assign-row">
        <select data-bedselect="${a.id}" ${availBeds.length===0?'disabled':''}>
          ${availBeds.length===0 ? '<option>No free beds in this ward</option>' :
            availBeds.map(b=>`<option value="${b.id}">${esc(b.bed_number)}</option>`).join('')}
        </select>
        <button class="btn-primary btn-sm" data-assign="${a.id}" ${availBeds.length===0?'disabled':''}>Assign</button>
      </div>
    </div>`;
  }).join('');

  list.querySelectorAll('[data-assign]').forEach(btn=>{
    btn.addEventListener('click', () => assignBed(btn.dataset.assign));
  });
}

async function assignBed(admissionId){
  clearMsgs();
  const sel = document.querySelector(`[data-bedselect="${admissionId}"]`);
  const bedId = sel?.value;
  if(!bedId){ showError('Select a bed first.'); return; }

  try{
    const { data, error } = await client.rpc('assign_bed', {
      p_token: session.token, p_admission_id: admissionId, p_bed_id: bedId
    });
    if(error) throw error;
    const r = Array.isArray(data)?data[0]:data;
    if(!r?.success) throw new Error(r?.message || 'Failed to assign bed.');
    showSuccess('✅ Bed assigned.');
    await loadWardsAndBeds();
    await loadAdmissions();
  }catch(err){ showError(err.message||'Failed to assign bed.'); }
}

function renderActive(){
  const filter = document.getElementById('queueFilter').value.toLowerCase();
  const wardFilterId = document.getElementById('wardFilter').value;
  const list = document.getElementById('activeList');

  const items = activeAdmissions.filter(a =>
    (!wardFilterId || a.ward_id===wardFilterId) &&
    (!filter || a.hospital_number.toLowerCase().includes(filter) || (a.beds?.bed_number||'').toLowerCase().includes(filter))
  );

  document.getElementById('activeCount').textContent = items.length;

  if(items.length===0){ list.innerHTML = `<div class="empty">No admitted patients</div>`; return; }

  list.innerHTML = items.map(a => `
    <div class="queue-item ${selectedAdmission?.id===a.id?'selected':''}" data-id="${a.id}">
      <div class="qi-top">
        <span class="qi-hospno">${esc(a.hospital_number)}</span>
        <span class="qi-bed">${esc(wardName(a.ward_id))} · ${esc(a.beds?.bed_number)}</span>
      </div>
      <div class="qi-dx">${esc(a.admission_diagnosis)}</div>
      <div class="qi-doc">Dr. ${esc(a.admitting_doctor)} &nbsp;|&nbsp; since ${fmtTime(a.admitted_at)}</div>
    </div>`).join('');

  list.querySelectorAll('.queue-item').forEach(el=>{
    el.addEventListener('click', () => {
      const a = activeAdmissions.find(x=>x.id===el.dataset.id);
      if(a) selectAdmission(a);
    });
  });
}

document.getElementById('queueFilter').addEventListener('input', renderActive);
document.getElementById('wardFilter').addEventListener('change', renderActive);

// ============================================================
// SELECT ADMISSION -> load chart
// ============================================================
async function selectAdmission(a){
  selectedAdmission = a;
  clearMsgs();
  document.getElementById('placeholder').style.display = 'none';
  document.getElementById('detailPanel').classList.add('show');
  renderActive();

  document.getElementById('patientBanner').innerHTML = `
    <div class="name">${esc(a.hospital_number)}</div>
    <div class="meta">${esc(wardName(a.ward_id))} · Bed ${esc(a.beds?.bed_number)} &nbsp;|&nbsp; Dr. ${esc(a.admitting_doctor)} &nbsp;|&nbsp; Admitted ${fmtTime(a.admitted_at)}</div>
    <div class="meta">🔍 ${esc(a.admission_diagnosis)}</div>
    ${a.allergy_note ? `<div class="allergy-warning show">⚠️ <b>Known allergy:</b> ${esc(a.allergy_note)}</div>` : ''}
  `;

  resetVitalsForm();
  resetNoteForm();
  resetMarForm();
  switchTab('orders');

  await Promise.all([loadOrders(a.id), loadVitalsHistory(a.id), loadNotes(a.id), loadMar(a.id)]);
}

// ============================================================
// TABS
// ============================================================
document.querySelectorAll('.tab-btn').forEach(btn=>{
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});
function switchTab(tab){
  document.querySelectorAll('.tab-btn').forEach(b=>b.classList.toggle('active', b.dataset.tab===tab));
  document.querySelectorAll('.tab-pane').forEach(p=>p.classList.toggle('active', p.id===`pane-${tab}`));
}

// ============================================================
// DOCTOR ORDERS (read-only, latest first)
// ============================================================
async function loadOrders(admissionId){
  const { data, error } = await client.from('doctor_orders')
    .select('id,doctor,order_text,order_type,status,created_at')
    .eq('admission_id', admissionId)
    .order('created_at',{ascending:false});

  const list = document.getElementById('ordersList');
  if(error){ list.innerHTML = `<div class="empty">${esc(error.message)}</div>`; return; }

  selectedOrders = (data||[]).filter(o=>o.status==='active' && o.order_type==='medication');
  const mOrderSel = document.getElementById('m_order');
  mOrderSel.innerHTML = '<option value="">— Not linked to an order —</option>' +
    selectedOrders.map(o=>`<option value="${o.id}">${esc(o.order_text.slice(0,60))}</option>`).join('');

  if(!data || data.length===0){ list.innerHTML = `<div class="empty">No orders yet.</div>`; return; }

  list.innerHTML = data.map(o => `
    <div class="order-item">
      <div class="item-top">
        <span><span class="type-badge">${esc(o.order_type)}</span> Dr. ${esc(o.doctor)}</span>
        <span>${fmtTime(o.created_at)}</span>
      </div>
      <div>${esc(o.order_text)}${o.status==='discontinued'?' <i style="color:var(--error)">(discontinued)</i>':''}</div>
    </div>`).join('');
}

// ============================================================
// VITALS
// ============================================================
async function loadVitalsHistory(admissionId){
  const { data, error } = await client.from('vitals')
    .select('*').eq('admission_id', admissionId)
    .order('recorded_at',{ascending:false}).limit(1);

  const hist = document.getElementById('vitalsHistory');
  if(error || !data || data.length===0){
    hist.innerHTML = `<div class="empty" style="grid-column:1/-1;">No vitals recorded yet.</div>`;
    return;
  }
  const v = data[0];
  function chip(label, value, unit, param){
    if(value==null) return '';
    const flag = flagValue(value, param);
    const cls = flag==='high'?'flag-high':flag==='low'?'flag-low':'';
    return `<div class="vital-chip ${cls}"><div class="vc-label">${label}</div><div class="vc-value">${value}</div><div class="unit">${unit}</div></div>`;
  }
  const bp = (v.bp_systolic!=null && v.bp_diastolic!=null) ?
    `<div class="vital-chip ${flagValue(v.bp_systolic,'bp_sys')==='high'||flagValue(v.bp_diastolic,'bp_dia')==='high'?'flag-high':''}">
       <div class="vc-label">BP</div><div class="vc-value">${v.bp_systolic}/${v.bp_diastolic}</div><div class="unit">mmHg</div></div>` : '';
  hist.innerHTML = [
    bp,
    chip('Temp', v.temperature, '°C', 'temp'),
    chip('Pulse', v.pulse, 'bpm', 'pulse'),
    chip('RR', v.respiratory_rate, '/min', 'rr'),
    chip('SPO2', v.spo2, '%', 'spo2'),
    chip('Weight', v.weight, 'kg', null),
    v.pain_score!=null ? `<div class="vital-chip ${v.pain_score>=7?'flag-high':''}"><div class="vc-label">Pain</div><div class="vc-value">${v.pain_score}/10</div></div>` : ''
  ].join('') || `<div class="empty" style="grid-column:1/-1;">No vitals recorded yet.</div>`;
}

document.getElementById('saveVitalsBtn').addEventListener('click', async () => {
  clearMsgs();
  if(!selectedAdmission) return showError('No patient selected.');
  const btn = document.getElementById('saveVitalsBtn');
  btn.disabled = true; btn.textContent = 'Saving...';

  try{
    const { data, error } = await client.rpc('record_nursing_vitals', {
      p_token: session.token,
      p_admission_id: selectedAdmission.id,
      p_bp_systolic: nv('v_bp_sys'),
      p_bp_diastolic: nv('v_bp_dia'),
      p_temperature: nv('v_temp'),
      p_pulse: nv('v_pulse'),
      p_respiratory_rate: nv('v_rr'),
      p_spo2: nv('v_spo2'),
      p_weight: nv('v_weight'),
      p_pain_score: nv('v_pain'),
      p_nurse_note: sv('v_note')
    });
    if(error) throw error;
    const r = Array.isArray(data)?data[0]:data;
    if(!r?.success) throw new Error(r?.message || 'Failed to save vitals.');
    showSuccess('✅ Vitals recorded.');
    resetVitalsForm();
    await loadVitalsHistory(selectedAdmission.id);
  }catch(err){ showError(err.message||'Failed to save vitals.'); }
  finally{ btn.disabled=false; btn.textContent='Save Vitals'; }
});

document.getElementById('clearVitalsBtn').addEventListener('click', resetVitalsForm);
function resetVitalsForm(){
  ['v_bp_sys','v_bp_dia','v_temp','v_pulse','v_rr','v_spo2','v_weight','v_pain','v_note'].forEach(id=>{
    const el = document.getElementById(id); if(el) el.value='';
  });
}

// ============================================================
// NURSING NOTES
// ============================================================
async function loadNotes(admissionId){
  const { data, error } = await client.from('nursing_notes')
    .select('id,nurse,note,shift,created_at')
    .eq('admission_id', admissionId)
    .order('created_at',{ascending:false});

  const list = document.getElementById('notesList');
  if(error){ list.innerHTML = `<div class="empty">${esc(error.message)}</div>`; return; }
  if(!data || data.length===0){ list.innerHTML = `<div class="empty">No notes yet.</div>`; return; }

  list.innerHTML = data.map(n => `
    <div class="note-item">
      <div class="item-top">
        <span>${esc(n.nurse)} · ${esc(n.shift)} shift</span>
        <span>${fmtTime(n.created_at)}</span>
      </div>
      <div>${esc(n.note)}</div>
    </div>`).join('');
}

document.getElementById('saveNoteBtn').addEventListener('click', async () => {
  clearMsgs();
  if(!selectedAdmission) return showError('No patient selected.');
  const note = sv('n_text');
  if(!note) return showError('Enter a note before saving.');

  const btn = document.getElementById('saveNoteBtn');
  btn.disabled = true; btn.textContent = 'Saving...';
  try{
    const { data, error } = await client.rpc('add_nursing_note', {
      p_token: session.token, p_admission_id: selectedAdmission.id,
      p_note: note, p_shift: sv('n_shift')
    });
    if(error) throw error;
    const r = Array.isArray(data)?data[0]:data;
    if(!r?.success) throw new Error(r?.message || 'Failed to save note.');
    showSuccess('✅ Note added.');
    resetNoteForm();
    await loadNotes(selectedAdmission.id);
  }catch(err){ showError(err.message||'Failed to save note.'); }
  finally{ btn.disabled=false; btn.textContent='Add Note'; }
});
function resetNoteForm(){ const t=document.getElementById('n_text'); if(t) t.value=''; }

// ============================================================
// MAR
// ============================================================
async function loadMar(admissionId){
  const { data, error } = await client.from('mar')
    .select('id,drug,dose,route,scheduled_time,given_time,given_by,status')
    .eq('admission_id', admissionId)
    .order('scheduled_time',{ascending:true});

  const list = document.getElementById('marList');
  if(error){ list.innerHTML = `<div class="empty">${esc(error.message)}</div>`; return; }
  if(!data || data.length===0){ list.innerHTML = `<div class="empty">No medications charted yet.</div>`; return; }

  list.innerHTML = data.map(m => `
    <div class="mar-item" data-id="${m.id}">
      <div class="item-top">
        <span>${esc(m.drug)} ${esc(m.dose)} ${m.route?'· '+esc(m.route):''}</span>
        <span class="status-badge ${m.status}">${m.status.toUpperCase()}</span>
      </div>
      <div style="color:var(--muted);font-size:0.74rem;">Scheduled: ${fmtTime(m.scheduled_time)}${m.given_time?` · Given: ${fmtTime(m.given_time)} by ${esc(m.given_by)}`:''}</div>
      ${m.status==='pending' ? `
        <div class="btn-row" style="justify-content:flex-start;margin-top:6px;">
          <button class="btn-success btn-sm" data-mark="given" data-id="${m.id}">✓ Given</button>
          <button class="btn-warn btn-sm" data-mark="missed" data-id="${m.id}">Missed</button>
          <button class="btn-ghost btn-sm" data-mark="refused" data-id="${m.id}">Refused</button>
        </div>` : ''}
    </div>`).join('');

  list.querySelectorAll('[data-mark]').forEach(btn=>{
    btn.addEventListener('click', () => markMar(btn.dataset.id, btn.dataset.mark));
  });
}

async function markMar(marId, status){
  clearMsgs();
  try{
    const { data, error } = await client.rpc('record_mar_dose', {
      p_token: session.token,
      p_admission_id: selectedAdmission.id,
      p_doctor_order_id: null,
      p_mar_id: marId,
      p_status: status
    });
    if(error) throw error;
    const r = Array.isArray(data)?data[0]:data;
    if(!r?.success) throw new Error(r?.message || 'Failed to update MAR.');
    showSuccess(`✅ Marked ${status}.`);
    await loadMar(selectedAdmission.id);
  }catch(err){ showError(err.message||'Failed to update MAR.'); }
}

document.getElementById('addMarBtn').addEventListener('click', async () => {
  clearMsgs();
  if(!selectedAdmission) return showError('No patient selected.');
  const drug = sv('m_drug'), dose = sv('m_dose'), time = sv('m_time');
  if(!drug) return showError('Enter the drug name.');
  if(!dose) return showError('Enter the dose.');
  if(!time) return showError('Set a scheduled time.');

  const btn = document.getElementById('addMarBtn');
  btn.disabled = true; btn.textContent = 'Charting...';
  try{
    const { data, error } = await client.rpc('record_mar_dose', {
      p_token: session.token,
      p_admission_id: selectedAdmission.id,
      p_doctor_order_id: sv('m_order'),
      p_mar_id: null,
      p_drug: drug,
      p_dose: dose,
      p_route: sv('m_route'),
      p_scheduled_time: new Date(time).toISOString(),
      p_status: 'pending'
    });
    if(error) throw error;
    const r = Array.isArray(data)?data[0]:data;
    if(!r?.success) throw new Error(r?.message || 'Failed to chart dose.');
    showSuccess('✅ Dose charted.');
    resetMarForm();
    await loadMar(selectedAdmission.id);
  }catch(err){ showError(err.message||'Failed to chart dose.'); }
  finally{ btn.disabled=false; btn.textContent='Chart Dose'; }
});
function resetMarForm(){
  ['m_drug','m_dose','m_route','m_time'].forEach(id=>{ const el=document.getElementById(id); if(el) el.value=''; });
  const sel = document.getElementById('m_order'); if(sel) sel.value='';
}

// ============================================================
// INIT
// ============================================================
async function refreshAll(){
  await loadWardsAndBeds();
  await loadAdmissions();
  if(selectedAdmission){
    // keep chart in sync without losing form input the nurse is mid-typing
    await Promise.all([loadOrders(selectedAdmission.id), loadVitalsHistory(selectedAdmission.id),
      loadNotes(selectedAdmission.id), loadMar(selectedAdmission.id)]);
  }
}
refreshAll();
setInterval(refreshAll, 30000);
