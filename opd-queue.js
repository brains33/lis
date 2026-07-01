// ============================================================
// MU'UJIZA OPD — opd-queue.js  (Nurse dashboard)
// ============================================================
const SUPABASE_URL      = 'https://npdopywxemtwzvpummsn.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5wZG9weXd4ZW10d3p2cHVtbXNuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk4NzY0MjksImV4cCI6MjA5NTQ1MjQyOX0.Mo5LfGdfSiHL6QHsPOaGkDmeaIRDqZTe8MGwz_6ou1c';

const session = window.opdSession;
const client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  global: { headers: { 'x-lis-token': session.token } }
});

document.getElementById('userLabel').textContent = session.name || session.username;
document.getElementById('logoutBtn').addEventListener('click', () => {
  sessionStorage.removeItem('muujiza_opd_session');
  window.location.replace('opd-login.html');
});

const errorMsg   = document.getElementById('errorMsg');
const successMsg = document.getElementById('successMsg');
function showError(m)  { successMsg.classList.remove('show'); errorMsg.textContent=m; errorMsg.classList.add('show'); }
function showSuccess(m){ errorMsg.classList.remove('show'); successMsg.textContent=m; successMsg.classList.add('show'); }
function clearMsgs()   { errorMsg.classList.remove('show'); successMsg.classList.remove('show'); }

function esc(s){ if(!s) return '—'; return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function nv(id){ const v=document.getElementById(id)?.value?.trim(); return v===''||v===undefined?null:Number(v); }
function sv(id){ const v=document.getElementById(id)?.value?.trim(); return v===''?null:v; }

// ---- Load queue ----
let allVisits = [];
let selectedVisit = null;

async function loadQueue() {
  const today = new Date().toISOString().split('T')[0];
  const { data, error } = await client
    .from('opd_visits')
    .select(`
      id, hospital_number, visit_date, status, triage_category,
      chief_complaint, queued_by, seen_by_nurse, assigned_doctor,
      department, queued_at, vitals_taken_at,
      patient_registry(surname, first_name, gender, date_of_birth, age, blood_group, genotype)
    `)
    .eq('visit_date', today)
    .in('status', ['queued','vitals_taken','with_doctor'])
    .order('queued_at', { ascending: true });

  if (error) { showError(error.message); return; }
  allVisits = data || [];
  renderQueue();
  updateStats();
}

async function updateStats() {
  const today = new Date().toISOString().split('T')[0];
  const [{ count: queued }, { count: vitals }, { count: done }, { count: emergency }] = await Promise.all([
    client.from('opd_visits').select('*',{count:'exact',head:true}).eq('visit_date',today).eq('status','queued'),
    client.from('opd_visits').select('*',{count:'exact',head:true}).eq('visit_date',today).eq('status','vitals_taken'),
    client.from('opd_visits').select('*',{count:'exact',head:true}).eq('visit_date',today).eq('status','done'),
    client.from('opd_visits').select('*',{count:'exact',head:true}).eq('visit_date',today).eq('triage_category','emergency').neq('status','done')
  ]);
  document.getElementById('s_queued').textContent    = queued ?? 0;
  document.getElementById('s_vitals').textContent    = vitals ?? 0;
  document.getElementById('s_done').textContent      = done ?? 0;
  document.getElementById('s_emergency').textContent = emergency ?? 0;
}

function renderQueue() {
  const filter = document.getElementById('queueFilter').value.toLowerCase();
  const statusF = document.getElementById('statusFilter').value;
  const list = document.getElementById('queueList');

  let items = allVisits.filter(v => {
    const p = v.patient_registry;
    const name = `${p?.surname||''} ${p?.first_name||''}`.toLowerCase();
    const matchText = !filter || name.includes(filter) || v.hospital_number.toLowerCase().includes(filter);
    const matchStatus = !statusF || v.status === statusF;
    return matchText && matchStatus;
  });

  // Sort: emergency first, then urgent, then routine, then by time
  const tOrder = { emergency: 0, urgent: 1, routine: 2 };
  items.sort((a,b) => {
    const ta = tOrder[a.triage_category] ?? 3;
    const tb = tOrder[b.triage_category] ?? 3;
    if (ta !== tb) return ta - tb;
    return new Date(a.queued_at) - new Date(b.queued_at);
  });

  document.getElementById('queueCount').textContent = items.length;

  if (items.length === 0) {
    list.innerHTML = `<div class="empty">No patients in queue</div>`;
    return;
  }

  list.innerHTML = items.map(v => {
    const p = v.patient_registry;
    const name = p ? `${p.surname} ${p.first_name}` : 'Unknown';
    const triage = v.triage_category || 'queued';
    const age = p?.date_of_birth ? `${Math.floor((Date.now()-new Date(p.date_of_birth))/(365.25*86400000))}y` : (p?.age ? `${p.age}y` : '');
    const time = v.queued_at ? new Date(v.queued_at).toLocaleTimeString('en-NG',{hour:'2-digit',minute:'2-digit'}) : '';
    return `
      <div class="queue-item ${triage} ${selectedVisit?.id===v.id?'selected':''}" data-id="${v.id}">
        <div class="qi-top">
          <span class="qi-name">${esc(name)}</span>
          <span class="qi-hospno">${esc(v.hospital_number)}</span>
        </div>
        <div class="qi-bottom">
          <span class="triage-badge ${triage}">${triage==='queued'?'⏳ Waiting':triage}</span>
          <span class="status-badge ${v.status}">${v.status.replace('_',' ')}</span>
          ${age ? `<span>${age}</span>` : ''}
          ${p?.gender ? `<span>${p.gender}</span>` : ''}
          <span>⏰ ${time}</span>
        </div>
      </div>`;
  }).join('');

  list.querySelectorAll('.queue-item').forEach(el => {
    el.addEventListener('click', () => {
      const v = allVisits.find(x => x.id === el.dataset.id);
      if (v) selectVisit(v);
    });
  });
}

function selectVisit(v) {
  selectedVisit = v;
  renderQueue(); // re-render to show selected state
  showVitalsForm(v);
}

function showVitalsForm(v) {
  const p = v.patient_registry;
  const name = p ? `${p.surname} ${p.first_name}` : 'Unknown';
  const age = p?.date_of_birth ? `${Math.floor((Date.now()-new Date(p.date_of_birth))/(365.25*86400000))} years` : (p?.age ? `${p.age} years` : '');
  document.getElementById('patientBanner').innerHTML = `
    <div class="name">${esc(name)}</div>
    <div class="meta">
      ${esc(v.hospital_number)} &nbsp;|&nbsp;
      ${p?.gender||'—'} &nbsp;|&nbsp; ${age}
      ${p?.blood_group ? ` &nbsp;|&nbsp; BG: ${p.blood_group}` : ''}
      ${p?.genotype    ? ` &nbsp;|&nbsp; GT: ${p.genotype}`    : ''}
    </div>`;
  document.getElementById('vitalsPlaceholder').style.display = 'none';
  const form = document.getElementById('vitalsForm');
  form.classList.add('show');

  // Pre-fill existing values if vitals already taken
  const sendBtn = document.getElementById('sendDoctorBtn');
  if (v.status === 'vitals_taken') {
    sendBtn.style.display = 'inline-block';
    sendBtn.onclick = () => advanceStatus(v.id, 'with_doctor');
  } else {
    sendBtn.style.display = 'none';
  }

  // Pre-fill triage + complaint if set
  if (v.triage_category) document.getElementById('v_triage').value = v.triage_category;
  if (v.chief_complaint)  document.getElementById('v_complaint').value = v.chief_complaint;
  if (v.assigned_doctor)  document.getElementById('v_doctor').value = v.assigned_doctor;
}

// ---- Add to queue ----
document.getElementById('addToQueueBtn').addEventListener('click', async () => {
  clearMsgs();
  const hospNum = document.getElementById('queueHospNum').value.trim().toUpperCase();
  if (!hospNum) return showError('Enter a hospital number.');

  const { data, error } = await client.rpc('queue_patient_opd', {
    p_token:           session.token,
    p_hospital_number: hospNum
  });

  if (error) { showError(error.message); return; }
  const result = Array.isArray(data) ? data[0] : data;
  if (!result?.success) { showError(result?.message || 'Failed to queue patient.'); return; }

  showSuccess(result.message);
  document.getElementById('queueHospNum').value = '';
  await loadQueue();
});

document.getElementById('queueHospNum').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('addToQueueBtn').click();
});

// ---- Save vitals ----
document.getElementById('saveVitalsBtn').addEventListener('click', async () => {
  clearMsgs();
  if (!selectedVisit) return showError('No patient selected.');
  if (!sv('v_triage'))    return showError('Please select a triage category.');
  if (!sv('v_complaint')) return showError('Chief complaint is required.');

  const btn = document.getElementById('saveVitalsBtn');
  btn.disabled = true; btn.textContent = 'Saving...';

  try {
    const { data, error } = await client.rpc('save_vitals', {
      p_token:            session.token,
      p_visit_id:         selectedVisit.id,
      p_bp_systolic:      nv('v_bp_sys'),
      p_bp_diastolic:     nv('v_bp_dia'),
      p_temperature:      nv('v_temp'),
      p_pulse:            nv('v_pulse'),
      p_respiratory_rate: nv('v_rr'),
      p_spo2:             nv('v_spo2'),
      p_weight:           nv('v_weight'),
      p_height:           nv('v_height'),
      p_rbs:              nv('v_rbs'),
      p_muac:             nv('v_muac'),
      p_chief_complaint:  sv('v_complaint'),
      p_triage_category:  sv('v_triage'),
      p_pain_score:       nv('v_pain') !== null ? parseInt(nv('v_pain')) : null,
      p_allergy_note:     sv('v_allergy'),
      p_nurse_note:       sv('v_nurse_note'),
      p_assigned_doctor:  sv('v_doctor')
    });

    if (error) throw error;
    const result = Array.isArray(data) ? data[0] : data;
    if (!result?.success) throw new Error(result?.message || 'Failed to save.');

    showSuccess('✅ Vitals saved. Patient status updated to "Vitals Taken".');
    document.getElementById('sendDoctorBtn').style.display = 'inline-block';
    document.getElementById('sendDoctorBtn').onclick = () => advanceStatus(selectedVisit.id, 'with_doctor');
    await loadQueue();

  } catch(err) {
    showError(err.message || 'Failed to save vitals.');
  } finally {
    btn.disabled = false; btn.textContent = 'Save Vitals';
  }
});

async function advanceStatus(visitId, status) {
  clearMsgs();
  const { data, error } = await client.rpc('advance_visit_status', {
    p_token: session.token, p_visit_id: visitId, p_status: status
  });
  if (error) { showError(error.message); return; }
  const result = Array.isArray(data) ? data[0] : data;
  if (!result?.success) { showError(result?.message||'Failed.'); return; }
  showSuccess(status === 'with_doctor' ? '✅ Patient sent to doctor.' : '✅ Visit marked as done.');
  selectedVisit = null;
  document.getElementById('vitalsPlaceholder').style.display = 'flex';
  document.getElementById('vitalsForm').classList.remove('show');
  await loadQueue();
}

document.getElementById('clearVitalsBtn').addEventListener('click', () => {
  ['v_bp_sys','v_bp_dia','v_temp','v_pulse','v_rr','v_spo2','v_weight',
   'v_height','v_rbs','v_muac','v_pain','v_doctor','v_complaint','v_allergy','v_nurse_note']
    .forEach(id => { const el=document.getElementById(id); if(el) el.value=''; });
  document.getElementById('v_triage').value = '';
});

document.getElementById('queueFilter').addEventListener('input', renderQueue);
document.getElementById('statusFilter').addEventListener('change', renderQueue);

// Auto-refresh every 30 seconds
loadQueue();
setInterval(loadQueue, 30000);
