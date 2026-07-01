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
let previousVitals = null; // cached previous visit vitals for the selected patient

// ============================================================
// Age-based vital reference ranges (attention thresholds, not
// "ideal" ranges — set wide enough to avoid flagging normal
// variation, tight enough to catch what a nurse should act on).
// Values outside [low, high] are flagged HIGH/LOW.
// ============================================================
const AGE_BANDS = [
  // maxYears is the upper bound (exclusive) for this band
  { name: 'neonate',    maxYears: 1/12, pulse:[90,190], rr:[25,65], bp_sys:[55,95],  bp_dia:[30,60] },
  { name: 'infant',     maxYears: 1,    pulse:[90,170], rr:[25,60], bp_sys:[65,105], bp_dia:[40,65] },
  { name: 'toddler',    maxYears: 3,    pulse:[80,160], rr:[20,40], bp_sys:[80,110], bp_dia:[45,70] },
  { name: 'preschool',  maxYears: 6,    pulse:[75,150], rr:[18,30], bp_sys:[80,115], bp_dia:[50,75] },
  { name: 'schoolage',  maxYears: 12,   pulse:[65,130], rr:[16,26], bp_sys:[85,120], bp_dia:[55,80] },
  { name: 'adolescent', maxYears: 18,   pulse:[60,110], rr:[12,22], bp_sys:[90,130], bp_dia:[60,85] },
  { name: 'adult',      maxYears: Infinity, pulse:[50,120], rr:[10,24], bp_sys:[90,140], bp_dia:[60,90] }
];
// Params with the same threshold across all ages
const UNIVERSAL_RANGES = {
  temp: [35.5, 37.8],   // °C — below = hypothermia, above = fever
  spo2: [94, 101],      // % — only low bound matters clinically
  rbs:  [70, 200]        // mg/dL random glucose — rough triage-level flag
};

function getAgeYears(v) {
  const p = v?.patient_registry;
  if (p?.date_of_birth) return (Date.now() - new Date(p.date_of_birth)) / (365.25 * 86400000);
  if (p?.age != null) return Number(p.age);
  return null; // unknown age -> fall back to adult ranges
}

function getBand(ageYears) {
  if (ageYears == null || isNaN(ageYears)) return AGE_BANDS[AGE_BANDS.length - 1]; // default adult
  return AGE_BANDS.find(b => ageYears < b.maxYears) || AGE_BANDS[AGE_BANDS.length - 1];
}

function getRange(param, ageYears) {
  if (UNIVERSAL_RANGES[param]) return UNIVERSAL_RANGES[param];
  const band = getBand(ageYears);
  return band[param] || null;
}

// MUAC only meaningfully screens malnutrition for ~6-59 months
function checkMuac(value, ageYears) {
  if (ageYears == null || ageYears < 0.5 || ageYears > 5) return null; // not applicable
  if (value < 11.5) return 'high';   // severe acute malnutrition -> urgent
  if (value < 12.5) return 'low';    // moderate risk
  return 'normal';
}

// Fields wired to reference-range flagging: input id -> {param, label}
const VITAL_FIELD_MAP = {
  v_bp_sys: { param: 'bp_sys', label: 'BP Systolic' },
  v_bp_dia: { param: 'bp_dia', label: 'BP Diastolic' },
  v_temp:   { param: 'temp',   label: 'Temperature' },
  v_pulse:  { param: 'pulse',  label: 'Pulse' },
  v_rr:     { param: 'rr',     label: 'Respiratory Rate' },
  v_spo2:   { param: 'spo2',   label: 'SPO2' },
  v_rbs:    { param: 'rbs',    label: 'RBS' },
  v_muac:   { param: 'muac',   label: 'MUAC' }
};

function evaluateField(inputId) {
  const cfg = VITAL_FIELD_MAP[inputId];
  if (!cfg) return null;
  const raw = document.getElementById(inputId)?.value?.trim();
  if (raw === '' || raw === undefined) return null;
  const value = Number(raw);
  if (isNaN(value)) return null;
  const ageYears = selectedVisit ? getAgeYears(selectedVisit) : null;

  if (cfg.param === 'muac') return checkMuac(value, ageYears);

  const range = getRange(cfg.param, ageYears);
  if (!range) return null;
  if (value > range[1]) return 'high';
  if (value < range[0]) return 'low';
  return 'normal';
}

function applyFieldFlag(inputId) {
  const wrap  = document.getElementById(`fld_${inputId}`);
  const badge = document.getElementById(`flag_${inputId}`);
  if (!wrap || !badge) return null;

  const result = evaluateField(inputId);
  wrap.classList.remove('flag-high', 'flag-low');
  badge.classList.remove('show', 'high', 'low');
  badge.textContent = '';

  if (result === 'high') {
    wrap.classList.add('flag-high');
    badge.classList.add('show', 'high');
    badge.textContent = 'HIGH';
  } else if (result === 'low') {
    wrap.classList.add('flag-low');
    badge.classList.add('show', 'low');
    badge.textContent = 'LOW';
  }
  return result;
}

// Pain score flagging (subjective, but severe pain matters for triage)
function applyPainFlag() {
  const wrap  = document.getElementById('fld_v_pain');
  const badge = document.getElementById('flag_v_pain');
  const raw = document.getElementById('v_pain')?.value?.trim();
  wrap.classList.remove('flag-high');
  badge.classList.remove('show', 'high');
  badge.textContent = '';
  if (raw === '' || raw === undefined) return null;
  const value = Number(raw);
  if (isNaN(value)) return null;
  if (value >= 7) {
    wrap.classList.add('flag-high');
    badge.classList.add('show', 'high');
    badge.textContent = 'SEVERE';
    return 'high';
  }
  return 'normal';
}

function updateTrendArrow(inputId) {
  const el = document.getElementById(`trend_${inputId}`);
  if (!el) return;
  el.textContent = '';
  el.classList.remove('up', 'down');
  if (!previousVitals) return;
  const dbKey = { v_bp_sys:'bp_systolic', v_bp_dia:'bp_diastolic', v_temp:'temperature', v_pulse:'pulse',
                  v_rr:'respiratory_rate', v_spo2:'spo2', v_rbs:'rbs', v_muac:'muac', v_weight:'weight' }[inputId];
  if (!dbKey || previousVitals[dbKey] == null) return;
  const raw = document.getElementById(inputId)?.value?.trim();
  if (raw === '' || raw === undefined) return;
  const newVal = Number(raw);
  const oldVal = Number(previousVitals[dbKey]);
  if (isNaN(newVal) || isNaN(oldVal) || newVal === oldVal) return;
  if (newVal > oldVal) { el.textContent = `↑ was ${oldVal}`; el.classList.add('up'); }
  else { el.textContent = `↓ was ${oldVal}`; el.classList.add('down'); }
}

function refreshAbnormalBanner() {
  const banner = document.getElementById('abnormalBanner');
  const abnormal = [];
  Object.keys(VITAL_FIELD_MAP).forEach(id => {
    const r = evaluateField(id);
    if (r === 'high' || r === 'low') abnormal.push(`${VITAL_FIELD_MAP[id].label} ${r.toUpperCase()}`);
  });
  const pain = applyPainFlag();
  if (pain === 'high') abnormal.push('Pain Score SEVERE');

  if (abnormal.length === 0) {
    banner.classList.remove('show');
    banner.innerHTML = '';
    return;
  }
  const suggestion = abnormal.length >= 2 ? 'Emergency' : 'Urgent';
  banner.classList.add('show');
  banner.innerHTML = `⚠️ <b>${abnormal.length} abnormal parameter${abnormal.length>1?'s':''}:</b> ${abnormal.join(', ')}.
    <span class="sugg">Consider triage: ${suggestion}</span> (nurse judgment applies — age-adjusted reference ranges used).`;
}

function evaluateAllVitals() {
  Object.keys(VITAL_FIELD_MAP).forEach(id => {
    applyFieldFlag(id);
    updateTrendArrow(id);
  });
  updateTrendArrow('v_weight');
  refreshAbnormalBanner();
}

// Wire live flagging on input
Object.keys(VITAL_FIELD_MAP).forEach(id => {
  const el = document.getElementById(id);
  if (el) el.addEventListener('input', evaluateAllVitals);
});
const painEl = document.getElementById('v_pain');
if (painEl) painEl.addEventListener('input', refreshAbnormalBanner);
const weightEl = document.getElementById('v_weight');
if (weightEl) weightEl.addEventListener('input', () => updateTrendArrow('v_weight'));

function resetVitalFlags() {
  Object.keys(VITAL_FIELD_MAP).forEach(id => {
    document.getElementById(`fld_${id}`)?.classList.remove('flag-high', 'flag-low');
    const badge = document.getElementById(`flag_${id}`);
    if (badge) { badge.classList.remove('show','high','low'); badge.textContent=''; }
    const trend = document.getElementById(`trend_${id}`);
    if (trend) { trend.textContent=''; trend.classList.remove('up','down'); }
  });
  document.getElementById('fld_v_pain')?.classList.remove('flag-high');
  const painBadge = document.getElementById('flag_v_pain');
  if (painBadge) { painBadge.classList.remove('show','high'); painBadge.textContent=''; }
  const weightTrend = document.getElementById('trend_v_weight');
  if (weightTrend) { weightTrend.textContent=''; weightTrend.classList.remove('up','down'); }
  document.getElementById('abnormalBanner').classList.remove('show');
  document.getElementById('abnormalBanner').innerHTML = '';
  document.getElementById('prevVitalsPanel').classList.remove('show');
  document.getElementById('prevVitalsPanel').innerHTML = '';
  previousVitals = null;
}

// ---- Previous vitals lookup ----
async function loadPreviousVitals(v) {
  const panel = document.getElementById('prevVitalsPanel');
  panel.classList.add('show');
  panel.innerHTML = `<div class="pv-title">🕓 Previous Vitals</div>Loading...`;

  const { data, error } = await client
    .from('opd_visits')
    .select('visit_date, vitals_taken_at, bp_systolic, bp_diastolic, temperature, pulse, respiratory_rate, spo2, weight, height, rbs, muac, pain_score')
    .eq('hospital_number', v.hospital_number)
    .not('vitals_taken_at', 'is', null)
    .neq('id', v.id)
    .order('vitals_taken_at', { ascending: false })
    .limit(1);

  if (error) {
    panel.innerHTML = `<div class="pv-title">🕓 Previous Vitals</div>Could not load previous vitals: ${esc(error.message)}`;
    previousVitals = null;
    return;
  }
  if (!data || data.length === 0) {
    panel.innerHTML = `<div class="pv-title">🕓 Previous Vitals</div>No prior recorded vitals for this patient.`;
    previousVitals = null;
    return;
  }

  previousVitals = data[0];
  const d = previousVitals;
  const dateStr = d.vitals_taken_at ? new Date(d.vitals_taken_at).toLocaleString('en-NG', {dateStyle:'medium', timeStyle:'short'}) : (d.visit_date || '—');
  const row = (label, val, unit) => val==null ? '' : `<div>${label}: <b style="color:var(--text)">${val}${unit||''}</b></div>`;
  panel.innerHTML = `
    <div class="pv-title">🕓 Previous Vitals — ${esc(dateStr)}</div>
    <div class="pv-grid">
      ${row('BP', (d.bp_systolic!=null && d.bp_diastolic!=null) ? `${d.bp_systolic}/${d.bp_diastolic}` : null, ' mmHg')}
      ${row('Temp', d.temperature, '°C')}
      ${row('Pulse', d.pulse, ' bpm')}
      ${row('RR', d.respiratory_rate, '/min')}
      ${row('SPO2', d.spo2, '%')}
      ${row('Weight', d.weight, 'kg')}
      ${row('RBS', d.rbs, ' mg/dL')}
      ${row('MUAC', d.muac, 'cm')}
    </div>`;

  // Re-evaluate trend arrows now that previous data is available
  evaluateAllVitals();
}

document.getElementById('prevVitalsBtn').addEventListener('click', () => {
  if (!selectedVisit) return;
  loadPreviousVitals(selectedVisit);
});

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
  resetVitalFlags(); // clear stale flags/previous-vitals from the last patient
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
  resetVitalFlags();
});

document.getElementById('queueFilter').addEventListener('input', renderQueue);
document.getElementById('statusFilter').addEventListener('change', renderQueue);

// Auto-refresh every 30 seconds
loadQueue();
setInterval(loadQueue, 30000);
