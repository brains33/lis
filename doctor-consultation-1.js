// ============================================================
// MU'UJIZA HMS — doctor-consultation.js
// Reads from: opd_visits, vitals, patient_registry, consultations
// Writes to:  consultations, lab_requests, lab_request_tests
// Calls RPC:  submit_consultation (atomic)
// Reuses nurse's exact age-based vital flagging (read-only display)
// ============================================================

const SUPABASE_URL      = 'https://npdopywxemtwzvpummsn.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5wZG9weXd4ZW10d3p2cHVtbXNuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk4NzY0MjksImV4cCI6MjA5NTQ1MjQyOX0.Mo5LfGdfSiHL6QHsPOaGkDmeaIRDqZTe8MGwz_6ou1c';

const session = window.doctorSession;
const client  = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  global: { headers: { 'x-lis-token': session.token } }
});

document.getElementById('userLabel').textContent = `Dr. ${session.name||session.username}`;

// ============================================================
// FACILITY MODE — hospital-wide switch between Federal/OPD style
// (nurses execute doctor orders only) and General Hospital style
// (ward nurses can admit/prescribe/discharge independently).
// ============================================================
async function loadFacilityMode(){
  const { data, error } = await client.from('hospital_settings').select('facility_mode').eq('id',1).single();
  const sel = document.getElementById('facilityModeSelect');
  if(error || !data){ console.error('[DC] load facility mode failed', error); return; }
  sel.value = data.facility_mode;
}

document.getElementById('facilityModeSelect').addEventListener('change', async (e)=>{
  const newMode = e.target.value;
  const label = newMode === 'general' ? 'General Hospital' : 'Federal / OPD';
  if(!confirm(`Switch the whole hospital to "${label}" mode?\n\nThis changes what ward nurses are allowed to do, hospital-wide, immediately.`)){
    loadFacilityMode(); // revert dropdown to actual saved value
    return;
  }
  const { data, error } = await client.rpc('set_facility_mode', { p_token: session.token, p_mode: newMode });
  if(error){ alert('Failed to change mode: '+error.message); loadFacilityMode(); return; }
  const r = Array.isArray(data)?data[0]:data;
  if(!r?.success){ alert(r?.message||'Failed to change mode.'); loadFacilityMode(); return; }
  alert(r.message);
});

loadFacilityMode();


document.getElementById('logoutBtn').addEventListener('click', () => {
  sessionStorage.removeItem('muujiza_doctor_session');
  window.location.replace('doctor-login.html');
});

const errorMsg   = document.getElementById('errorMsg');
const successMsg = document.getElementById('successMsg');
function showError(m)   { successMsg.classList.remove('show'); errorMsg.textContent=m; errorMsg.classList.add('show'); }
function showSuccess(m) { errorMsg.classList.remove('show'); successMsg.textContent=m; successMsg.classList.add('show'); }
function clearMsgs()    { errorMsg.classList.remove('show'); successMsg.classList.remove('show'); }
function esc(s){ if(!s) return '—'; return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function sv(id){ const v=document.getElementById(id)?.value?.trim(); return v===''||v===undefined?null:v; }

// ============================================================
// AGE-BASED VITAL FLAGGING — same logic as nurse module (read-only)
// ============================================================
const AGE_BANDS = [
  { maxYears:1/12,  pulse:[90,190], rr:[25,65], bp_sys:[55,95],  bp_dia:[30,60] },
  { maxYears:1,     pulse:[90,170], rr:[25,60], bp_sys:[65,105], bp_dia:[40,65] },
  { maxYears:3,     pulse:[80,160], rr:[20,40], bp_sys:[80,110], bp_dia:[45,70] },
  { maxYears:6,     pulse:[75,150], rr:[18,30], bp_sys:[80,115], bp_dia:[50,75] },
  { maxYears:12,    pulse:[65,130], rr:[16,26], bp_sys:[85,120], bp_dia:[55,80] },
  { maxYears:18,    pulse:[60,110], rr:[12,22], bp_sys:[90,130], bp_dia:[60,85] },
  { maxYears:Infinity, pulse:[50,120], rr:[10,24], bp_sys:[90,140], bp_dia:[60,90] }
];
const UNIV = { temp:[35.5,37.8], spo2:[94,101], rbs:[70,200] };

function getAgeYears(patient){
  if(patient?.date_of_birth) return (Date.now()-new Date(patient.date_of_birth))/(365.25*86400000);
  if(patient?.age!=null) return Number(patient.age);
  return null;
}
function getBand(a){ if(a==null||isNaN(a)) return AGE_BANDS[AGE_BANDS.length-1]; return AGE_BANDS.find(b=>a<b.maxYears)||AGE_BANDS[AGE_BANDS.length-1]; }
function getRange(param,a){ if(UNIV[param]) return UNIV[param]; return getBand(a)[param]||null; }
function flagValue(val,param,ageYears){
  if(val==null) return null;
  if(param==='muac'){
    if(ageYears==null||ageYears<0.5||ageYears>5) return null;
    if(val<11.5) return 'high'; if(val<12.5) return 'low'; return 'normal';
  }
  const r=getRange(param,ageYears); if(!r) return null;
  if(val>r[1]) return 'high'; if(val<r[0]) return 'low'; return 'normal';
}

// ============================================================
// STATE
// ============================================================
let selectedVisit    = null;
let selectedPatient  = null;
let currentVitals    = null;
let selectedTests    = [];   // { id: "unit||test", name: test_name, unit_name } for lab
let selectedTests2   = [];   // for lab_and_discharge
let selectedTests3   = [];   // for admit_and_lab
let allTestDefs      = [];
let allWards         = [];
let selectedAction   = null;

// ============================================================
// QUEUE
// ============================================================
async function loadQueue(){
  // NOTE: no visit_date filter here on purpose. A patient sent for lab tests
  // (status stays 'with_doctor') must remain visible regardless of which day
  // they were originally registered — otherwise they silently vanish from
  // the queue the moment the date rolls over, even though nothing about
  // their status changed. visit_date is still stored for reporting/history,
  // just not used to gate who's currently waiting.
  const { data, error } = await client.from('opd_visits')
    .select(`id,hospital_number,status,triage_category,chief_complaint,assigned_doctor,queued_at,
             patient_registry(id,surname,first_name,gender,date_of_birth,age,blood_group,genotype,phone,address,occupation,state_of_origin,nin)`)
    .eq('status','with_doctor')
    .order('queued_at',{ascending:true});

  if(error){ console.error(error); return; }
  renderQueue(data||[]);
  updateStats(data||[]);
}

function renderQueue(visits){
  const filter = document.getElementById('queueFilter').value.toLowerCase();
  const list   = document.getElementById('queueList');
  const items  = visits.filter(v=>{
    const p=v.patient_registry;
    const name=`${p?.surname||''} ${p?.first_name||''}`.toLowerCase();
    return !filter||name.includes(filter)||v.hospital_number.toLowerCase().includes(filter);
  });
  if(items.length===0){ list.innerHTML=`<div class="empty-queue">No patients waiting</div>`; return; }
  list.innerHTML = items.map(v=>{
    const p=v.patient_registry;
    const name=p?`${p.surname} ${p.first_name}`:'Unknown';
    const t=v.triage_category||'';
    const age=p?.date_of_birth?`${Math.floor((Date.now()-new Date(p.date_of_birth))/(365.25*86400000))}y`:(p?.age?`${p.age}y`:'');
    const time=v.queued_at?new Date(v.queued_at).toLocaleTimeString('en-NG',{hour:'2-digit',minute:'2-digit'}):'';
    return `<div class="queue-item ${t} ${selectedVisit?.id===v.id?'selected':''}" data-id="${v.id}">
      <div class="qi-name">${t?`<span class="triage-dot ${t}"></span>`:''}${esc(name)}</div>
      <div class="qi-meta">
        <span>${esc(v.hospital_number)}</span>
        ${age?`<span>${age}</span>`:''}
        ${p?.gender?`<span>${p.gender}</span>`:''}
        <span>⏰${time}</span>
      </div>
    </div>`;
  }).join('');
  list.querySelectorAll('.queue-item').forEach(el=>{
    el.addEventListener('click',()=>{
      const v=items.find(x=>x.id===el.dataset.id);
      if(v) selectVisit(v);
    });
  });
}

async function updateStats(visits){
  const today=new Date().toISOString().split('T')[0];
  const [{ count:done },{count:emrg}] = await Promise.all([
    client.from('opd_visits').select('*',{count:'exact',head:true}).eq('visit_date',today).eq('status','done'),
    client.from('opd_visits').select('*',{count:'exact',head:true}).eq('visit_date',today).in('status',['with_doctor','queued','vitals_taken']).eq('triage_category','emergency')
  ]);
  document.getElementById('s_waiting').textContent    = visits.length;
  document.getElementById('s_done_today').textContent = done??0;
  document.getElementById('s_emrg').textContent       = emrg??0;
}

document.getElementById('queueFilter').addEventListener('input', loadQueue);

// ---- Recall / doctor-initiated queue add -------------------------------
// Single entry point for a doctor adding someone to their own queue:
// - patient already has an open visit today  -> reactivated (recalled)
// - patient has no visit today               -> a fresh 'with_doctor' visit
//   is created, skipping the nurse triage/vitals step
// Both cases are handled server-side by doctor_queue_patient so this stays
// a one-click action regardless of which situation applies.
const recallBtn  = document.getElementById('recallBtn');
const recallInp  = document.getElementById('recallHospNo');
const recallMsg  = document.getElementById('recallMsg');

function showRecallMsg(text, ok){
  recallMsg.textContent = text;
  recallMsg.style.display = 'block';
  recallMsg.style.color = ok ? 'var(--green,#2e7d32)' : 'var(--error,#c62828)';
  setTimeout(()=>{ recallMsg.style.display='none'; }, 4000);
}

async function handleRecall(){
  const hospNo = recallInp.value.trim();
  if(!hospNo){ showRecallMsg('Enter a hospital number.', false); return; }

  recallBtn.disabled = true;
  recallBtn.textContent = 'Adding...';
  try{
    const { data, error } = await client.rpc('doctor_queue_patient', {
      p_token: session.token,
      p_hospital_number: hospNo
    });
    if(error) throw error;
    const r = Array.isArray(data) ? data[0] : data;
    if(!r?.success){ showRecallMsg(r?.message || 'Could not add patient.', false); return; }

    showRecallMsg(r.message || 'Patient added to your queue.', true);
    recallInp.value = '';
    await loadQueue();
  }catch(err){
    console.error('doctor_queue_patient failed:', err);
    showRecallMsg(err.message || 'Failed to add patient.', false);
  }finally{
    recallBtn.disabled = false;
    recallBtn.textContent = '+ Add to Queue';
  }
}

recallBtn.addEventListener('click', handleRecall);
recallInp.addEventListener('keydown', e=>{ if(e.key==='Enter') handleRecall(); });

// ============================================================
// SELECT VISIT — load vitals, demographics, history
// ============================================================
async function selectVisit(v){
  selectedVisit   = v;
  selectedPatient = v.patient_registry;
  clearMsgs();
  resetForm();
  document.getElementById('placeholder').style.display    = 'none';
  document.getElementById('consultContent').classList.add('show');
  switchTab('summary');
  renderPatientHeader(v);
  await loadVitals(v);
  renderDemographics(v);
  loadHistory(v.hospital_number);
  loadLabResults(v.hospital_number);
  loadTestDefs();
  // Pre-fill complaint from nurse
  if(v.chief_complaint) document.getElementById('c_complaint').value = v.chief_complaint;
  loadQueue(); // re-render to show selected
}

function renderPatientHeader(v){
  const p=v.patient_registry;
  const name=p?`${p.surname} ${p.first_name}${p.middle_name?' '+p.middle_name:''}`:'Unknown';
  const age=p?.date_of_birth?`${Math.floor((Date.now()-new Date(p.date_of_birth))/(365.25*86400000))} years`:(p?.age?`${p.age} years`:'');
  const t=v.triage_category;
  const tColor={'emergency':'var(--error)','urgent':'var(--warn)','routine':'var(--green)'}[t]||'var(--muted)';
  document.getElementById('patientHeader').innerHTML = `
    <div class="ph-name">${esc(name)} ${t?`<span style="font-size:0.72rem;background:rgba(255,255,255,0.06);border:1px solid ${tColor};color:${tColor};border-radius:8px;padding:2px 8px;margin-left:6px;">${t.toUpperCase()}</span>`:''}</div>
    <div class="ph-meta">
      <span class="ph-hospno">${esc(v.hospital_number)}</span>
      ${p?.gender?`<span>${p.gender}</span>`:''}
      ${age?`<span>${age}</span>`:''}
      ${p?.blood_group?`<span>BG: ${p.blood_group}</span>`:''}
      ${p?.genotype?`<span>GT: ${p.genotype}</span>`:''}
      <span style="color:var(--warn)">Chief: ${esc(v.chief_complaint)}</span>
    </div>`;
}

async function loadVitals(v){
  const { data, error } = await client.from('vitals')
    .select('*').eq('visit_id',v.id).order('recorded_at',{ascending:false}).limit(1);
  if(error||!data||data.length===0){
    document.getElementById('vitalsGrid').innerHTML=`<div style="color:var(--muted);font-size:0.82rem;grid-column:1/-1;">No vitals recorded yet for this visit.</div>`;
    currentVitals=null; return;
  }
  currentVitals=data[0];
  renderVitals(currentVitals, v.patient_registry);
}

function renderVitals(vit, patient){
  const age    = getAgeYears(patient);
  const banner = document.getElementById('abnormalBanner');
  const grid   = document.getElementById('vitalsGrid');
  const abnormal = [];

  function chip(label, value, unit, param){
    if(value==null) return '';
    const flag = flagValue(value, param, age);
    if(flag==='high'||flag==='low') abnormal.push(`${label} ${flag.toUpperCase()}`);
    const cls = flag==='high'?'flag-high':flag==='low'?'flag-low':'';
    const badge = (flag==='high'||flag==='low')
      ? `<span class="vc-flag ${flag}">${flag.toUpperCase()}</span>` : '';
    return `<div class="vital-chip ${cls}">
      <div class="vc-label">${label}</div>
      <div class="vc-value">${value}${badge}</div>
      <div class="vc-unit">${unit}</div>
    </div>`;
  }

  const bpVal = (vit.bp_systolic!=null&&vit.bp_diastolic!=null)
    ? `${vit.bp_systolic}/${vit.bp_diastolic}` : null;
  const bpFlag = flagValue(vit.bp_systolic,'bp_sys',age);

  grid.innerHTML = [
    bpVal ? `<div class="vital-chip ${bpFlag==='high'?'flag-high':bpFlag==='low'?'flag-low':''}">
      <div class="vc-label">Blood Pressure</div>
      <div class="vc-value">${bpVal}${bpFlag&&bpFlag!=='normal'?`<span class="vc-flag ${bpFlag}">${bpFlag.toUpperCase()}</span>`:''}</div>
      <div class="vc-unit">mmHg</div></div>` : '',
    chip('Temperature',  vit.temperature,     '°C',    'temp'),
    chip('Pulse',        vit.pulse,            'bpm',   'pulse'),
    chip('Resp. Rate',   vit.respiratory_rate, '/min',  'rr'),
    chip('SPO2',         vit.spo2,             '%',     'spo2'),
    chip('Weight',       vit.weight,           'kg',    null),
    chip('Height',       vit.height,           'cm',    null),
    chip('BMI',          vit.bmi,              '',      null),
    chip('RBS',          vit.rbs,              'mg/dL', 'rbs'),
    chip('MUAC',         vit.muac,             'cm',    'muac'),
    vit.pain_score!=null ? `<div class="vital-chip ${vit.pain_score>=7?'flag-high':''}">
      <div class="vc-label">Pain Score</div>
      <div class="vc-value">${vit.pain_score}/10${vit.pain_score>=7?'<span class="vc-flag high">SEVERE</span>':''}</div>
      </div>` : ''
  ].join('');

  if(abnormal.length>0){
    banner.classList.add('show');
    banner.innerHTML=`⚠️ <b>${abnormal.length} abnormal parameter${abnormal.length>1?'s':''}:</b> ${abnormal.join(', ')}.`;
  } else { banner.classList.remove('show'); }

  // Nurse note
  document.getElementById('nurseNotes').innerHTML = vit.nurse_note
    ? `<div style="background:var(--field);border-radius:8px;padding:10px 13px;">${esc(vit.nurse_note)}</div>`
    : `<div style="color:var(--muted);font-size:0.82rem;">No nurse note recorded.</div>`;

  // Allergy from nurse
  if(vit.allergy_note) document.getElementById('c_allergy').value = vit.allergy_note;
}

function renderDemographics(v){
  const p=v.patient_registry;
  if(!p){ document.getElementById('demoGrid').innerHTML='<div style="color:var(--muted);">No demographics available.</div>'; return; }
  const age=p.date_of_birth?`${Math.floor((Date.now()-new Date(p.date_of_birth))/(365.25*86400000))} years`:(p.age?`${p.age} years`:'—');
  const items=[
    ['Full Name',`${p.surname} ${p.first_name}${p.middle_name?' '+p.middle_name:''}`],
    ['Hospital No.',v.hospital_number],['Gender',p.gender],['Age',age],
    ['NIN / National ID',p.nin],['Blood Group',p.blood_group],['Genotype',p.genotype],
    ['Phone',p.phone],['State of Origin',p.state_of_origin],['Occupation',p.occupation],
    ['Address',p.address]
  ].filter(([,v])=>v);
  document.getElementById('demoGrid').innerHTML = items.map(([l,v])=>`
    <div class="info-row"><div class="lbl">${l}</div><div>${esc(String(v))}</div></div>`).join('');
}

async function loadHistory(hospNum){
  const { data } = await client.from('consultations')
    .select('*').eq('hospital_number',hospNum)
    .order('created_at',{ascending:false}).limit(10);
  const list = document.getElementById('historyList');
  if(!data||data.length===0){ list.innerHTML=`<div style="color:var(--muted);font-size:0.84rem;">No previous consultations found.</div>`; return; }
  list.innerHTML = data.map(c=>`
    <div class="past-consult">
      <div class="pc-head">
        <span>${c.created_at?new Date(c.created_at).toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'}):''}</span>
        <span>Dr. ${esc(c.doctor_name)}</span>
        <span style="color:var(--purple)">${(c.action_type||'').replace('_',' ')}</span>
      </div>
      <div class="pc-diagnosis">🔍 ${esc(c.diagnosis)}</div>
      ${c.presenting_complaint?`<div style="color:var(--muted);">Complaint: ${esc(c.presenting_complaint)}</div>`:''}
      ${c.prescription?`<div style="margin-top:4px;">💊 ${esc(c.prescription)}</div>`:''}
      ${c.refer_to?`<div style="margin-top:4px;">↗️ Referred to: ${esc(c.refer_to)}</div>`:''}
      ${c.admit_ward?`<div style="margin-top:4px;">🛏️ Admitted: ${esc(c.admit_ward)}</div>`:''}
      ${Array.isArray(c.lab_test_names)&&c.lab_test_names.length?`<div style="margin-top:4px;">🧪 Labs ordered: ${c.lab_test_names.map(esc).join(', ')}</div>`:''}
    </div>`).join('');
}

// ============================================================
// LAB RESULTS — bridges accession/pending_portal back to the doctor.
// Samples are linked to this patient via hospital_number (set at
// accession registration). We show anything not yet released as
// "in progress" and anything released as viewable/downloadable.
// ============================================================
async function loadLabResults(hospNum){
  const list = document.getElementById('labResultsList');
  const badge = document.getElementById('labResultsBadge');
  if(!hospNum){
    list.innerHTML = `<div style="color:var(--muted);font-size:0.84rem;">No hospital number on this visit.</div>`;
    badge.style.display='none';
    return;
  }

  const { data, error } = await client
    .from('samples')
    .select('id, status, priority, collection_date, sample_tests(test_name, unit_name, status, result, result_json)')
    .eq('hospital_number', hospNum)
    .order('id', {ascending:false})
    .limit(20);

  if(error){
    list.innerHTML = `<div style="color:var(--error);font-size:0.84rem;">Could not load lab results.</div>`;
    console.error('[DC] loadLabResults error', error);
    badge.style.display='none';
    return;
  }

  if(!data || data.length===0){
    list.innerHTML = `<div style="color:var(--muted);font-size:0.84rem;">No lab samples found for this patient yet.</div>`;
    badge.style.display='none';
    return;
  }

  const readyCount = data.filter(s=>s.status==='Result Released').length;
  if(readyCount>0){
    badge.textContent = readyCount;
    badge.style.display='inline-block';
  } else {
    badge.style.display='none';
  }

  list.innerHTML = data.map(s=>{
    const isReady = s.status==='Result Released';
    const statusColor = isReady ? 'var(--green)' : (s.status==='Verifying' ? 'var(--warn)' : 'var(--muted)');
    const testNames = (s.sample_tests||[]).map(t=>t.test_name).join(', ') || '—';
    return `
    <div class="past-consult" style="border-left:3px solid ${statusColor};">
      <div class="pc-head">
        <span>MU-${s.id}</span>
        <span>${s.collection_date?new Date(s.collection_date).toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'}):''}</span>
        <span style="color:${statusColor};font-weight:700;">${esc(s.status||'—')}</span>
      </div>
      <div style="margin-top:4px;">🧪 ${esc(testNames)}</div>
      ${isReady
        ? `<div style="margin-top:8px;">
             <button class="btn-view-result" data-sample-id="${s.id}" style="background:var(--purple);color:#1a0040;border:none;border-radius:6px;padding:6px 12px;font-weight:700;font-size:0.8rem;cursor:pointer;">
               View / Print Result
             </button>
           </div>`
        : `<div style="color:var(--muted);font-size:0.8rem;margin-top:4px;">Still in progress — check back once released.</div>`}
    </div>`;
  }).join('');

  list.querySelectorAll('.btn-view-result').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const sample = data.find(s => s.id === parseInt(btn.dataset.sampleId,10));
      if(sample) renderResultModal(sample);
    });
  });
}

// ============================================================
// FULL RESULTS RENDERING ENGINE — ported verbatim from
// pending_portal.js so doctors see the exact same clean,
// sectioned, reference-range-flagged layout patients/lab staff
// see there (all ~30 panel types), before the doctor ever needs
// to download/print anything.
// ============================================================

// testDefinitions mirrors pending_portal.js's global: test_type,
// unit, and (for simple_numeric) stored reference range per test
// name, loaded once in loadTestDefs() below.
let testDefinitions = { testTypes: {}, testUnits: {}, refRanges: {} };

function getReferenceRange(testName, age, gender) {
  const patientAge = (age && !isNaN(age)) ? parseInt(age) : 30;
  const isMale = (gender === 'Male');
  const isFemale = (gender === 'Female');

  switch (testName) {
    case 'PCV':
    case 'Packed Cell Volume':
    case 'Hematocrit':
    case 'HCT':
      if (isMale) return { low: 40, high: 54, unit: '%' };
      if (isFemale) return { low: 36, high: 46, unit: '%' };
      return { low: 36, high: 46, unit: '%' };
    case 'Hb':
    case 'Hemoglobin':
      if (isMale) return { low: 13.5, high: 17.5, unit: 'g/dL' };
      if (isFemale) return { low: 12.0, high: 15.5, unit: 'g/dL' };
      return { low: 12.0, high: 15.5, unit: 'g/dL' };
    case 'ESR':
    case 'Erythrocyte Sedimentation Rate':
      if (isMale) return { low: 0, high: 5, unit: 'mm/hr' };
      if (isFemale) return { low: 0, high: 10, unit: 'mm/hr' };
      return { low: 0, high: 15, unit: 'mm/hr' };
    case 'RBS':
    case 'Random Blood Sugar':
      return { low: 6.0, high: 9.0, unit: 'mmol/L' };
    case 'FBS':
    case 'Fasting Blood Sugar':
      return { low: 3.0, high: 6.0, unit: 'mmol/L' };
    default:
      return null;
  }
}

const CBC_PARAMS = [
  // Main indices
  {key:'hb',           name:'HB (Haemoglobin)',      unit:'g/dL',       low:11.5, high:15.5, note:'F: 11.5–15.5 | M: 13.5–18.0 g/dL'},
  {key:'pcv',          name:'PCV',                   unit:'%',          low:35,   high:54,   note:'M: 40–54% | F: 35–45%'},
  {key:'twbc',         name:'TWBC',                  unit:'×10⁹/L',     low:4.0,  high:11.0},
  {key:'rbc',          name:'RBC',                   unit:'×10¹²/L',    low:4.5,  high:5.5},
  {key:'mcv',          name:'MCV',                   unit:'fL',         low:76,   high:98},
  {key:'mch',          name:'MCH',                   unit:'pg',         low:27,   high:31},
  {key:'mchc',         name:'MCHC',                  unit:'g/dL',       low:31,   high:36},
  {key:'plt',          name:'Platelets (PLC)',        unit:'×10⁹/L',     low:150,  high:400},
  {key:'retics',       name:'Retics',                unit:'%',          low:0.2,  high:2.0},
  {key:'esr',          name:'ESR',                   unit:'mm/Hr',      low:0,    high:10,   note:'M: 0–5 | F: 0–10 mm/Hr'},
  {key:'bleeding_time',name:'Bleeding Time',         unit:'min',        low:0,    high:11},
  {key:'clotting_time',name:'Clotting Time',         unit:'min',        low:5,    high:11},
  // Differential Count
  {key:'neut',         name:'Neutrophils',           unit:'%',          low:40,   high:75},
  {key:'lymph',        name:'Lymphocytes',           unit:'%',          low:20,   high:45},
  {key:'eo',           name:'Eosinophils',           unit:'%',          low:1,    high:6},
  {key:'baso',         name:'Basophils',             unit:'%',          low:0,    high:2},
  {key:'mono',         name:'Monocytes',             unit:'%',          low:2,    high:10}
];
// Kontagora Clinical Chemistry Panels
const EUCR_PARAMS = [
  {key:'sodium',    name:'Sodium (Na+)',              unit:'mmol/L', low:136,  high:150},
  {key:'potassium', name:'Potassium (K+)',             unit:'mmol/L', low:3.5,  high:5.0},
  {key:'bicarb',    name:'Bicarbonate (HCO3-)',        unit:'mmol/L', low:22,   high:30},
  {key:'chloride',  name:'Chloride (Cl-)',             unit:'mmol/L', low:96,   high:108},
  {key:'urea',      name:'Urea',                           unit:'mmol/L', low:2.1,  high:7.0},
  {key:'creat',     name:'Creatinine (Male)',               unit:'mg/dL',  low:0.9,  high:1.50},
  {key:'creat_f',   name:'Creatinine (Female)',             unit:'mg/dL',  low:0.7,  high:1.37}
];
const CALCIUM_PARAMS = [
  {key:'calcium', name:'Calcium', unit:'mmol/L', low:2.2, high:2.7}
];
const PHOSPHATE_PARAMS = [
  {key:'phosphate_adult',    name:'Inorganic Phosphate (Adult)',    unit:'mmol/L', low:0.9, high:1.6},
  {key:'phosphate_children', name:'Inorganic Phosphate (Children)', unit:'mmol/L', low:1.1, high:2.0}
];
const URIC_ACID_PARAMS = [
  {key:'uric_female', name:'Uric Acid (Female)', unit:'mg/dL', low:1.5, high:7.0},
  {key:'uric_male',   name:'Uric Acid (Male)',   unit:'mmol/L', low:1.5, high:7.0}
];
const LFT_PARAMS_FULL = [
  {key:'tbil',  name:'Total Bilirubin',                  unit:'mg/dL', low:0,   high:1.11},
  {key:'dbil',  name:'Direct Bilirubin',                 unit:'mg/dL', low:0,   high:0.023},
  {key:'alp',   name:'Alkaline Phosphatase (Adult)',      unit:'U/L',   low:9,   high:35},
  {key:'alp_c', name:'Alkaline Phosphatase (Children)',   unit:'U/L',   low:35,  high:100},
  {key:'ast',   name:'AST (GOT)',                         unit:'U/L',   low:3.5, high:35},
  {key:'alt',   name:'ALT (GPT)',                         unit:'U/L',   low:2.5, high:37}
];
const TOTAL_PROTEIN_PARAMS = [
  {key:'prot', name:'Total Protein', unit:'g/dL', low:5.8, high:8.2},
  {key:'alb',  name:'Albumin',       unit:'g/dL', low:3.5, high:5.2},
  {key:'glob', name:'Globulin',      unit:'g/dL', low:2.2, high:3.2, calc:true}
];
const PSA_PARAMS = [
  {key:'psa_qual', name:'PSA (Qualitative)', unit:'', type:'select', options:['Non-reactive','Reactive','Borderline']}
];
const DIABETES_PARAMS = [
  {key:'fbs',   name:'FBS (Fasting Blood Sugar)',    unit:'mmol/L', low:3.0, high:6.0},
  {key:'rbs',   name:'RBS (Random Blood Sugar)',      unit:'mmol/L', low:3.0, high:9.0},
  {key:'hpp2',  name:'2HPP (2-Hour Post-Prandial)',  unit:'mmol/L', low:3.0, high:9.0},
  {key:'ogtt',  name:'OGTT',                          unit:'mmol/L', low:3.0, high:7.8},
  {key:'hba1c', name:'HbA1c',                         unit:'%',      low:3.0, high:6.0}
];
const RF_PARAMS = [
  {key:'rf', name:'Rheumatoid Factor (RF)', unit:'', type:'select', options:['Negative','Positive','Weakly Positive']}
];
// Hormone Panel — LH, FSH, Testosterone, Progesterone, Prolactin (Kontagora GH form)
const HORMONE_PARAMS = [
  {key:'lh',           name:'LH',           unit:'mIU/mL', low:null, high:null,
   note:'M: 1.70–8.60 | F Follicular: 2.95–13.65 | Ovulation: 13.65–95.75 | Luteal: 1.25–11.00 | Menopause: 8.24–55.23'},
  {key:'fsh',          name:'FSH',          unit:'mIU/mL', low:null, high:null,
   note:'M: 1.70–8.60 | F Follicular: 4.46–12.43 | Ovulation: 4.88–20.96 | Luteal: 1.96–7.70 | Menopause: 22.70–1300.00'},
  {key:'testosterone', name:'Testosterone', unit:'ng/mL',  low:null, high:null,
   note:'M: 0.2–1.5 | F 19–39yr: 2.64–9.16 | 40–59yr: 1.96–8.59 | 60+yr: 1.96–8.59'},
  {key:'progesterone', name:'Progesterone', unit:'ng/Ml',  low:null, high:null,
   note:'M: 3.45–17.42 | F Follicular: 0.2–2.0 | Ovulation: 0.7–3.5 | Luteal: 3.0–30 | Menopause: 0.1–0.9 | Preg 9–12wk: 17.5–31.5 | Preg >12wk: 25.0–51.0'},
  {key:'prolactin',    name:'Prolactin',    unit:'ng/mL',  low:null, high:null,
   note:'M: 3.45–17.42 | F: 4.60–25.07'}
];
// Marry Panel — HBsAg, HCV, RVS, SHCG, Hb Genotype, Blood Group
const MARRY_PARAMS = [
  {key:'hbsag',       name:'HBsAg',        unit:'', type:'select', options:['Non-Reactive','Reactive']},
  {key:'hcv',         name:'HCV',          unit:'', type:'select', options:['Non-Reactive','Reactive']},
  {key:'rvs',         name:'RVS',          unit:'', type:'select', options:['Non-Reactive','Reactive']},
  {key:'shcg',        name:'SHCG',         unit:'', type:'select', options:['Negative','Positive']},
  {key:'hb_genotype', name:'Hb Genotype',  unit:'', type:'select', options:['AA','AS','SS','AC','SC','CC']},
  {key:'blood_group', name:'Blood Group',  unit:'', type:'select', options:['A RH-D Positive','A RH-D Negative','B RH-D Positive','B RH-D Negative','AB RH-D Positive','AB RH-D Negative','O RH-D Positive','O RH-D Negative']}
];
// Antenatal Panel — PCV, Hb Genotype, Blood Group, Protein, Glucose, HBsAg, HCV
const ANTENATAL_PARAMS = [
  {key:'pcv',         name:'PCV',              unit:'%',  low:33, high:47},
  {key:'hb_genotype', name:'Hb Genotype',      unit:'', type:'select', options:['AA','AS','SS','AC','SC','CC']},
  {key:'blood_group', name:'Blood Group',       unit:'', type:'select', options:['A RH-D Positive','A RH-D Negative','B RH-D Positive','B RH-D Negative','AB RH-D Positive','AB RH-D Negative','O RH-D Positive','O RH-D Negative']},
  {key:'protein',     name:'Protein (Urine)',   unit:'', type:'select', options:['Negative','Trace','1+','2+','3+','4+']},
  {key:'glucose',     name:'Glucose (Urine)',   unit:'', type:'select', options:['Negative','Trace','1+','2+','3+','4+']},
  {key:'hbsag',       name:'HBsAg',             unit:'', type:'select', options:['Non-Reactive','Reactive']},
  {key:'hcv',         name:'HCV',               unit:'', type:'select', options:['Non-Reactive','Reactive']}
];
// Blood Transfusion — Grouping & Crossmatch
// Matches BTS-REQ-XM/v1 form exactly (Sections 2, 3, 5, 6, 7, 8)
const BLOOD_TRANSFUSION_PARAMS = [
  // ── Section 2: Clinical Request Details ──
  {key:'transfusion_reason',     name:'Reason for Transfusion',                    unit:'', type:'text'},
  {key:'inv_hb_electrophoresis', name:'Investigation: Hb Electrophoresis',         unit:'', type:'select', options:['Requested','Not Requested']},
  {key:'inv_type_screen',        name:'Investigation: Type & Screen',              unit:'', type:'select', options:['Requested','Not Requested']},
  {key:'inv_full_crossmatch',    name:'Investigation: Full Crossmatch',            unit:'', type:'select', options:['Requested','Not Requested']},
  {key:'result_hb',              name:'Result: HB',                                unit:'g/dL', type:'number', low:null, high:null},
  {key:'result_pcv',             name:'Result: PCV',                               unit:'%',    type:'number', low:null, high:null},

  // ── Section 3: Blood Products Required ──
  {key:'bp_whole_blood',         name:'Blood Product: Whole Blood',                unit:'', type:'select', options:['Yes','No']},
  {key:'bp_packed_cells',        name:'Blood Product: Packed Cells',               unit:'', type:'select', options:['Yes','No']},
  {key:'bp_platelet_concentrate',name:'Blood Product: Platelet Concentrate',       unit:'', type:'select', options:['Yes','No']},
  {key:'bp_ffp',                 name:'Blood Product: Fresh Frozen Plasma (FFP)', unit:'', type:'select', options:['Yes','No']},
  {key:'bp_cryoprecipitate',     name:'Blood Product: Cryoprecipitate',            unit:'', type:'select', options:['Yes','No']},
  {key:'bp_retroviral_screening',name:'Blood Product: Retroviral Screening',       unit:'', type:'select', options:['Yes','No']},
  {key:'units_required',         name:'No. of Units Required',                     unit:'', type:'number', low:null, high:null},
  {key:'units_donated',          name:'No. of Units Donated',                      unit:'', type:'number', low:null, high:null},
  {key:'date_required',          name:'Date Required',                             unit:'', type:'text'},
  {key:'time_required',          name:'Time Required',                             unit:'', type:'text'},

  // ── Section 5: Autologous Blood (if applicable) ──
  {key:'autologous_units',       name:'Autologous: No. of Units to be Collected',  unit:'', type:'number', low:null, high:null},
  {key:'type_of_surgery',        name:'Type of Surgery',                           unit:'', type:'text'},

  // ── Section 6: Patient Blood Group & Serological Screening ──
  {key:'patient_blood_group', name:"Patient Blood Group",     unit:'', type:'select', options:['A Rhesus "D" Positive','A Rhesus "D" Negative','B Rhesus "D" Positive','B Rhesus "D" Negative','AB Rhesus "D" Positive','AB Rhesus "D" Negative','O Rhesus "D" Positive','O Rhesus "D" Negative']},
  {key:'patient_hbsag',       name:"Patient HBsAg",           unit:'', type:'select', options:['Non-Reactive','Reactive']},
  {key:'patient_hcv',         name:"Patient HCV",             unit:'', type:'select', options:['Non-Reactive','Reactive']},
  {key:'patient_rvs',         name:"Patient RVS",             unit:'', type:'select', options:['Non-Reactive','Reactive']},

  // ── Section 6: Donor Blood Group & Serological Screening ──
  {key:'donor_blood_group',   name:"Donor Blood Group",       unit:'', type:'select', options:['A Rhesus "D" Positive','A Rhesus "D" Negative','B Rhesus "D" Positive','B Rhesus "D" Negative','AB Rhesus "D" Positive','AB Rhesus "D" Negative','O Rhesus "D" Positive','O Rhesus "D" Negative']},
  {key:'donor_pcv',           name:"Donor PCV",               unit:'%', type:'number', low:35, high:54},
  {key:'donor_hbsag',         name:"Donor HBsAg",             unit:'', type:'select', options:['Non-Reactive','Reactive']},
  {key:'donor_hcv',           name:"Donor HCV",               unit:'', type:'select', options:['Non-Reactive','Reactive']},
  {key:'donor_vdrl',          name:"Donor VDRL",              unit:'', type:'select', options:['Negative','Positive']},
  {key:'donor_rvs',           name:"Donor RVS",               unit:'', type:'select', options:['Non-Reactive','Reactive']},

  // ── Section 7: Major Crossmatch (Phase / Result / Remarks) ──
  {key:'xm_ns_result',        name:"Normal Saline (37\u00b0C) \u2014 Result",      unit:'', type:'select', options:['Compatible','Incompatible','Weakly Incompatible']},
  {key:'xm_ns_remarks',       name:"Normal Saline (37\u00b0C) \u2014 Remarks",     unit:'', type:'text'},
  {key:'xm_ba_result',        name:"Bovine Albumin \u2014 Result",                  unit:'', type:'select', options:['Compatible','Incompatible','Weakly Incompatible']},
  {key:'xm_ba_remarks',       name:"Bovine Albumin \u2014 Remarks",                 unit:'', type:'text'},
  {key:'xm_ahg_result',       name:"AHG (Anti-Human Globulin) \u2014 Result",      unit:'', type:'select', options:['Compatible','Incompatible','Weakly Incompatible']},
  {key:'xm_ahg_remarks',      name:"AHG (Anti-Human Globulin) \u2014 Remarks",     unit:'', type:'text'},

  // ── Section 8: Compatibility / Crossmatch Outcome ──
  {key:'blood_bag_no',        name:'Blood Unit / Bag No.',                          unit:'', type:'text'},
  {key:'crossmatch',          name:'Grouping & Crossmatch Result',                  unit:'', type:'select', options:['Compatible with Patient','Incompatible with Patient']},

  // ── Issue / Return times ──
  {key:'time_issued',         name:'Time Issued',                                   unit:'', type:'text'},
  {key:'time_returned',       name:'Time Returned',                                 unit:'', type:'text'},
  {key:'time_reissued',       name:'Time Reissued',                                 unit:'', type:'text'}
];
const RFT_PARAMS_FULL = [
  {key:'sodium',    name:'Sodium (Na+)',              unit:'mmol/L', low:136,  high:150},
  {key:'potassium', name:'Potassium (K+)',             unit:'mmol/L', low:3.5,  high:5.0},
  {key:'bicarb',    name:'Bicarbonate (HCO3-)',        unit:'mmol/L', low:22,   high:30},
  {key:'chloride',  name:'Chloride (Cl-)',             unit:'mmol/L', low:96,   high:108},
  {key:'urea',      name:'Urea',                         unit:'mmol/L', low:2.1,  high:7.0},
  {key:'creat',     name:'Creatinine',                   unit:'mg/dL',  low:0.9,  high:1.5},
  {key:'calcium',   name:'Calcium',                      unit:'mmol/L', low:2.2,  high:2.7},
  {key:'phosphate', name:'Inorganic Phosphate',          unit:'mmol/L', low:0.9,  high:1.6}
];
// Thyroid Function Test — Kontagora GH form
const THYROID_PARAMS = [
  {key:'tsh', name:'TSH', unit:'mIU/L',  low:0.3,  high:4.2},
  {key:'t3',  name:'T3',  unit:'nmol/L', low:1.23, high:3.07},
  {key:'t4',  name:'T4',  unit:'nmol/L', low:66,   high:181}
];
const LIPID_PARAMS = [
  {key:'chol', name:'Total Cholesterol', unit:'mmol/L', low:2.5,  high:6.0},
  {key:'hdl',  name:'HDL-C',            unit:'mmol/L', low:0.91, high:1.43},
  {key:'ldl',  name:'LDL-C',            unit:'mmol/L', low:1.8,  high:4.4},
  {key:'tg',   name:'Triglycerides',    unit:'mmol/L', low:1.8,  high:2.2},
  {key:'vldl', name:'VLDL',            unit:'mmol/L', low:0.2,  high:0.8, calc:true},
  {key:'ratio',name:'Total/HDL Ratio',  unit:'',       low:0,    high:5,   calc:true}
];
const COAG_PARAMS = [
  {key:'pt', name:'Prothrombin Time', unit:'sec', low:11, high:13.5},
  {key:'inr', name:'INR', unit:'', low:0.8, high:1.2},
  {key:'aptt', name:'APTT', unit:'sec', low:25, high:35},
  {key:'tt', name:'Thrombin Time', unit:'sec', low:14, high:21},
  {key:'fibrinogen', name:'Fibrinogen', unit:'mg/dL', low:200, high:400},
  {key:'bleeding_time', name:'Bleeding Time (Ivy)', unit:'min', low:1, high:9},
  {key:'clotting_time', name:'Clotting Time (Lee‑White)', unit:'min', low:5, high:10},
  {key:'d_dimer', name:'D‑Dimer', unit:'µg/mL', low:0, high:0.5}
];
const URINALYSIS_MICRO_PARAMS = [
  {key:'colour', name:'Colour', unit:'', type:'select', options:['Yellow','Straw','Clear','Dark Yellow','Red','Brown']},
  {key:'appearance', name:'Appearance', unit:'', type:'select', options:['Clear','Turbid','Cloudy']},
  {key:'ph', name:'pH', unit:'', low:5.0, high:8.0, type:'number', step:0.5},
  {key:'sg', name:'Specific Gravity', unit:'', low:1.005, high:1.030, type:'number', step:0.001},
  {key:'protein', name:'Protein', unit:'', type:'select', options:['Negative','Trace','+','++','+++']},
  {key:'glucose', name:'Glucose', unit:'', type:'select', options:['Negative','Trace','+','++','+++']},
  {key:'ketones', name:'Ketones', unit:'', type:'select', options:['Negative','Trace','+','++','+++']},
  {key:'blood', name:'Blood', unit:'', type:'select', options:['Negative','Trace','+','++','+++']},
  {key:'bilirubin', name:'Bilirubin', unit:'', type:'select', options:['Negative','+','++']},
  {key:'urobilinogen', name:'Urobilinogen', unit:'mg/dL', low:0.1, high:1.0, type:'number', step:0.1},
  {key:'ascorbic_acid', name:'Ascorbic Acid', unit:'', type:'select', options:['Negative','Positive']},
  {key:'nitrite', name:'Nitrite', unit:'', type:'select', options:['Negative','Positive']},
  {key:'leuko', name:'Leukocyte Esterase', unit:'', type:'select', options:['Negative','Trace','+','++','+++']}
];
const IRON_PARAMS = [
  {key:'iron', name:'Serum Iron', unit:'µg/dL', low:50, high:150},
  {key:'tibc', name:'TIBC', unit:'µg/dL', low:250, high:400},
  {key:'uibc', name:'UIBC', unit:'µg/dL', low:150, high:300},
  {key:'transferrinSat', name:'Transferrin Saturation', unit:'%', low:20, high:50},
  {key:'ferritin', name:'Ferritin', unit:'ng/mL', low:20, high:300}
];
const BONE_PARAMS = [
  {key:'calcium', name:'Calcium', unit:'mg/dL', low:8.5, high:10.2},
  {key:'phosphate', name:'Phosphate', unit:'mg/dL', low:2.5, high:4.5},
  {key:'alkaline_phosphatase', name:'ALP', unit:'U/L', low:30, high:120},
  {key:'albumin', name:'Albumin', unit:'g/dL', low:3.5, high:5.0},
  {key:'magnesium', name:'Magnesium', unit:'mg/dL', low:1.7, high:2.2},
  {key:'vitaminD', name:'Vitamin D (25-OH)', unit:'ng/mL', low:30, high:80}
];
const CARDIAC_PARAMS = [
  {key:'ckmb', name:'CK-MB', unit:'U/L', low:0, high:25},
  {key:'troponinI', name:'Troponin I', unit:'ng/mL', low:0, high:0.04},
  {key:'troponinT', name:'Troponin T', unit:'ng/mL', low:0, high:0.01},
  {key:'ldh', name:'LDH', unit:'U/L', low:100, high:200},
  {key:'ast_cardiac', name:'AST', unit:'U/L', low:10, high:35}
];
const OGTT_PARAMS = [
  {key:'fasting', name:'Fasting', unit:'mg/dL', low:70, high:100},
  {key:'one_hour', name:'1 Hour', unit:'mg/dL', low:0, high:180},
  {key:'two_hour', name:'2 Hours', unit:'mg/dL', low:0, high:140},
  {key:'three_hour', name:'3 Hours', unit:'mg/dL', low:0, high:120}
];
const MALARIA_PARAMS = [
  {key:'species', name:'Species', type:'select', options:['Plasmodium falciparum','Plasmodium vivax','Plasmodium ovale','Plasmodium malariae','Mixed infection','None']},
  {key:'stage', name:'Stage', type:'select', options:['Ring','Trophozoite','Schizont','Gametocyte','Not applicable']},
  {key:'density', name:'Parasite Density', unit:'parasites/µL', type:'number', low:0, high:1000000}
];
const TB_GX_PARAMS = [
  {key:'mtb_detected', name:'MTB Detected', type:'select', options:['Detected','Not detected','Invalid']},
  {key:'rif_resistance', name:'Rifampicin Resistance', type:'select', options:['Detected','Not detected','Invalid']},
  {key:'probeA_ct', name:'Probe A Ct', unit:'', type:'number'},
  {key:'probeB_ct', name:'Probe B Ct', unit:'', type:'number'},
  {key:'probeC_ct', name:'Probe C Ct', unit:'', type:'number'},
  {key:'probeD_ct', name:'Probe D Ct', unit:'', type:'number'},
  {key:'probeE_ct', name:'Probe E Ct', unit:'', type:'number'}
];
const CSF_PARAMS = [
  {key:'appearance', name:'Appearance', type:'select', options:['Clear','Cloudy','Xanthochromic','Bloody']},
  {key:'wbc', name:'WBC', unit:'/mm³', low:0, high:5, type:'number'},
  {key:'rbc', name:'RBC', unit:'/mm³', low:0, high:0, type:'number'},
  {key:'protein', name:'Protein', unit:'mg/dL', low:15, high:45, type:'number'},
  {key:'glucose', name:'Glucose', unit:'mg/dL', low:40, high:80, type:'number'},
  {key:'gram_stain', name:'Gram Stain', type:'select', options:['No organisms seen','Gram positive cocci','Gram negative rods','Fungi','Other']},
  {key:'india_ink', name:'India Ink', type:'select', options:['Negative','Positive']},
  {key:'crypto_ag', name:'Cryptococcal Antigen', type:'select', options:['Negative','Positive']}
];
const ABG_PARAMS = [
  {key:'ph', name:'pH', unit:'', low:7.35, high:7.45, type:'number', step:0.01},
  {key:'pco2', name:'pCO2', unit:'mmHg', low:35, high:45, type:'number'},
  {key:'po2', name:'pO2', unit:'mmHg', low:80, high:100, type:'number'},
  {key:'hco3', name:'HCO3', unit:'mmol/L', low:22, high:26, type:'number'},
  {key:'base_excess', name:'Base Excess', unit:'mmol/L', low:-2, high:2, type:'number'},
  {key:'o2sat', name:'O2 Saturation', unit:'%', low:95, high:100, type:'number'},
  {key:'lactate', name:'Lactate', unit:'mmol/L', low:0.5, high:2.0, type:'number'}
];
const SEMEN_PARAMS = [
  // Semen Collection
  {key:'time_produced', name:'Time Produced', type:'text'},
  {key:'time_received', name:'Time Received', type:'text'},
  {key:'time_analysed', name:'Time Analysed', type:'text'},
  {key:'abstinence', name:'Abstinence', type:'text'},

  // Macroscopy
  {key:'appearance', name:'Appearance', type:'select', options:['Greyish-Opalescent','Yellowish','Reddish/Bloody','Clear','Brownish']},
  {key:'volume', name:'Volume', unit:'mL', low:1.5, high:6.0, type:'number', step:0.1},
  {key:'viscosity', name:'Viscosity', type:'select', options:['Normal','High','Low']},
  {key:'consistency', name:'Consistency', type:'select', options:['Normal','Watery','Thick']},
  {key:'liquefaction', name:'Liquefaction', type:'select', options:['Normal (<60 min)','Delayed (>60 min)','Incomplete']},

  // Microscopy — counts & vitality
  {key:'sperm_count', name:'Sperm Count', unit:'\u00d710\u2076/mL', low:15, high:200, type:'number'},
  {key:'viability', name:'Viability (%)', unit:'%', low:58, high:100, type:'number'},

  // Motility
  {key:'motility_a', name:'Grade A — Progressive Motility', unit:'%', low:32, high:null, type:'number'},
  {key:'motility_b', name:'Grade B — Non-Progressive Motility', unit:'%', low:null, high:null, type:'number'},
  {key:'motility_c', name:'Grade C — Non-Linear Motility', unit:'%', low:null, high:null, type:'number'},
  {key:'motility_d', name:'Grade D — Immotile Sperm Cells', unit:'%', low:null, high:null, type:'number'},

  // Morphology — Head defects
  {key:'morph_microcephalic', name:'Microcephalic', unit:'%', low:null, high:null, type:'number'},
  {key:'morph_macrocephalic', name:'Macrocephalic', unit:'%', low:null, high:null, type:'number'},
  {key:'morph_pinhead', name:'Pin Head', unit:'%', low:null, high:null, type:'number'},
  {key:'morph_pyriform', name:'Pyriform', unit:'%', low:null, high:null, type:'number'},
  {key:'morph_double_head', name:'Double Head', unit:'%', low:null, high:null, type:'number'},
  {key:'morph_acrosomal', name:'Acrosomal Condensation', unit:'%', low:null, high:null, type:'number'},

  // Morphology — Tail defects
  {key:'morph_tailless', name:'Tailless', unit:'%', low:null, high:null, type:'number'},
  {key:'morph_short_tail', name:'Short Tail', unit:'%', low:null, high:null, type:'number'},
  {key:'morph_long_tail', name:'Long Tail', unit:'%', low:null, high:null, type:'number'},
  {key:'morph_double_tail', name:'Double Tail', unit:'%', low:null, high:null, type:'number'},
  {key:'morph_coiled_tail', name:'Coiled Tail', unit:'%', low:null, high:null, type:'number'},

  // Morphology — Others
  {key:'morph_cytoplasmic_droplets', name:'Cytoplasmic Droplets', unit:'%', low:null, high:null, type:'number'},
  {key:'morph_midpiece_abnormality', name:'Mid Piece Abnormality', unit:'%', low:null, high:null, type:'number'},
  {key:'morph_neck_defect', name:'Neck Defect', unit:'%', low:null, high:null, type:'number'},
  {key:'morph_normal', name:'Normal Morphology', unit:'%', low:4, high:14, type:'number'},

  // Wet Preparation / Gram's Stain
  // Wet Preparation (urine microscopy style)
  {key:'wp_epithelial_cells', name:'Epithelial Cells', unit:'/HPF', type:'text'},
  {key:'wp_pus_cells', name:'Pus Cells (WBC)', unit:'/HPF', type:'text'},
  {key:'wp_rbc', name:'RBC', unit:'/HPF', type:'text'},
  {key:'wp_parasite', name:'Parasite / Ova', type:'select', options:['None seen','Trichomonas vaginalis','Other — see comments']},
  {key:'wp_other', name:'Other Findings', type:'text'},

  // Gram's Stain
  {key:'gram_stain', name:'Gram\'s Stain', type:'text'},

  // Comments
  {key:'comments', name:'Comments', type:'text'}
];
const SEROLOGY_PARAMS = [
  {key:'hbsag', name:'HBsAg', type:'select', options:['Non-reactive','Reactive']},
  {key:'anti_hbs', name:'Anti-HBs', type:'select', options:['Non-reactive','Reactive']},
  {key:'hbeag', name:'HBeAg', type:'select', options:['Non-reactive','Reactive']},
  {key:'anti_hbe', name:'Anti-HBe', type:'select', options:['Non-reactive','Reactive']},
  {key:'anti_hbc', name:'Anti-HBc (Total)', type:'select', options:['Non-reactive','Reactive']},
];

// ── HISTOPATHOLOGY (Biopsy / Surgical Pathology) ──
const HISTOPATH_PARAMS = [
  {key:'specimen_site',   name:'Specimen / Site',              unit:'', type:'text',   section:'Request'},
  {key:'laterality',      name:'Laterality',                   unit:'', type:'select', section:'Request',
   options:['Right','Left','Bilateral','Midline','Not Applicable']},
  {key:'clinical_info',   name:'Clinical History',             unit:'', type:'text',   section:'Request'},
  {key:'nature_specimen', name:'Nature of Specimen',           unit:'', type:'select', section:'Request',
   options:['Incision Biopsy','Excision Biopsy','Core Needle Biopsy',
            'Wide Local Excision','Radical Resection','Endoscopic Biopsy',
            'Curettage','Amputation Specimen','Polypectomy','Other']},
  {key:'fixative',        name:'Fixative Used',                unit:'', type:'select', section:'Request',
   options:["10% Formalin","Formal Saline","Bouin's Solution","Fresh (Unfixed)","Other"]},
  {key:'macro_desc',      name:'Macroscopic Description',      unit:'', type:'textarea', section:'Report'},
  {key:'micro_desc',      name:'Microscopic Description',      unit:'', type:'textarea', section:'Report'},
  {key:'special_stains',  name:'Special Stains',               unit:'', type:'text',   section:'Report'},
  {key:'diagnosis',       name:'Histopathological Diagnosis',  unit:'', type:'textarea', section:'Report'},
  {key:'grade',           name:'Tumour Grade (if applicable)', unit:'', type:'select', section:'Report',
   options:['Not Applicable','Grade I — Well Differentiated','Grade II — Moderately Differentiated',
            'Grade III — Poorly Differentiated','Grade IV — Undifferentiated']},
  {key:'margins',         name:'Surgical Margins — Status',    unit:'', type:'select', section:'Report',
   options:['Not Applicable','Clear (>1mm)','Close (<1mm)','Involved','Cannot Assess']},
  {key:'margin_distance', name:'Closest Margin (specify site & distance)', unit:'', type:'text', section:'Report'},
  {key:'lymph_nodes',     name:'Lymph Node Status',            unit:'', type:'text',   section:'Report'},
  {key:'staging',         name:'Pathologic Staging (pTNM, if applicable)', unit:'', type:'text', section:'Report'},
  {key:'comments',        name:'Comments / Recommendation',    unit:'', type:'textarea', section:'Report'},
  {key:'pathologist',     name:'Reporting Pathologist',        unit:'', type:'text',   section:'Report'}
];

// ── FNAC — Fine Needle Aspiration Cytology ──
const FNAC_PARAMS = [
  {key:'site',          name:'Site of Aspiration',         unit:'', type:'text',   section:'Request'},
  {key:'laterality',    name:'Laterality',                 unit:'', type:'select', section:'Request',
   options:['Right','Left','Bilateral','Midline','Not Applicable']},
  {key:'lesion_size',   name:'Lesion Size (cm)',            unit:'cm', type:'number', low:0, high:30, section:'Request'},
  {key:'clinical_info', name:'Clinical Information',        unit:'', type:'text',   section:'Request'},
  {key:'adequacy',      name:'Adequacy of Sample',         unit:'', type:'select', section:'Report',
   options:['Adequate for Diagnosis','Inadequate — Scanty Cellularity',
            'Inadequate — Haemorrhagic','Repeat Aspiration Advised']},
  {key:'stain',         name:'Stain Used',                 unit:'', type:'select', section:'Report',
   options:['Papanicolaou (Pap)','Diff-Quik (DQ)','Both Pap and DQ','H&E','MGG']},
  {key:'cytology',      name:'Cytological Diagnosis',      unit:'', type:'select', section:'Report',
   options:['Benign / Reactive','Inflammatory / Infective — See Comments',
            'Colloid Goitre (Thyroid)','Follicular Neoplasm (Thyroid)',
            'Papillary Thyroid Carcinoma','Reactive Lymphadenopathy',
            'Granulomatous Lymphadenitis (? TB)','Suspicious for Lymphoma',
            'Fibrocystic Disease (Breast)','Fibroadenoma (Breast)',
            'Suspicious for Malignancy','Malignant — See Microscopic Description',
            'Abscess / Necrotic Material','No Diagnostic Material — Repeat']},
  {key:'micro_desc',    name:'Microscopic Description',    unit:'', type:'textarea', section:'Report'},
  {key:'comments',      name:'Comments / Recommendation',  unit:'', type:'textarea', section:'Report'},
  {key:'pathologist',   name:'Reporting Pathologist',      unit:'', type:'text',   section:'Report'}
];

// ── PAP Smear — Bethesda 2014 system ──
const PAP_SMEAR_PARAMS = [
  {key:'specimen_type', name:'Specimen Type',              unit:'', type:'select', section:'Request',
   options:['Conventional Pap Smear','Liquid-Based Cytology (LBC)',
            'Endocervical Brush','Cervical Scrape + ECS']},
  {key:'lmp',           name:'LMP (Last Menstrual Period)',unit:'', type:'text',   section:'Request'},
  {key:'clinical_info', name:'Clinical Information',       unit:'', type:'text',   section:'Request'},
  {key:'adequacy',      name:'Specimen Adequacy',          unit:'', type:'select', section:'Report',
   options:['Satisfactory for Evaluation','Unsatisfactory — Insufficient Squamous Cells',
            'Unsatisfactory — Obscuring Blood','Unsatisfactory — Obscuring Inflammation',
            'Unsatisfactory — Broken / Unfixed Slide']},
  {key:'cytology',      name:'Cytological Findings (Bethesda)', unit:'', type:'select', section:'Report',
   options:['Negative for Intraepithelial Lesion or Malignancy (NILM)',
            'Atypical cells of unknown significance (ASC-US)',
            'Atypical squamous cells cannot exclude HSIL (ASC-H)',
            'Low-grade squamous intraepithelial lesion LSIL (CIN I)',
            'High-grade squamous intraepithelial lesion HSIL (CIN II / CIN III)',
            'Squamous Cell Carcinoma','Atypical Glandular Cells (AGC)',
            'Adenocarcinoma In Situ (AIS)','Endocervical Adenocarcinoma',
            'Endometrial Cells (patient ≥45 yrs)']},
  {key:'organisms',     name:'Organisms / Infection',      unit:'', type:'select', section:'Report',
   options:['None Identified','Trichomonas vaginalis','Bacterial Vaginosis',
            'Candida spp.','HSV Cytopathic Effect','Actinomyces spp.']},
  {key:'hormonal',      name:'Hormonal Assessment',        unit:'', type:'select', section:'Report',
   options:['Compatible with Age and History','Atrophic Pattern',
            'Estrogenic Effect','Incompatible — See Comments']},
  {key:'recommendation',name:'Recommendation',             unit:'', type:'select', section:'Report',
   options:['Routine Repeat in 3 Years','Repeat in 6 Months',
            'Colposcopy Recommended','Biopsy Recommended',
            'HPV Testing Recommended','Refer to Gynaecologist — Urgent']},
  {key:'comments',      name:'Cytologist Comments',        unit:'', type:'textarea', section:'Report'},
  {key:'pathologist',   name:'Reporting Pathologist',      unit:'', type:'text',   section:'Report'}
];

const URINE_MICRO_PARAMS = [
  {key:'colour',      name:'Colour',             unit:'', section:'Physical',  type:'select', options:['Yellow','Straw','Clear','Dark Yellow','Red','Brown']},
  {key:'appearance',  name:'Appearance',          unit:'', section:'Physical',  type:'select', options:['Clear','Turbid','Cloudy']},
  {key:'ph',          name:'pH',                  unit:'', section:'Chemical',  type:'number', low:5.0, high:8.0},
  {key:'sg',          name:'Specific Gravity',    unit:'', section:'Chemical',  type:'number', low:1.005, high:1.030},
  {key:'protein',     name:'Protein',             unit:'', section:'Chemical',  type:'select', options:['Negative','Trace','+','++','+++']},
  {key:'glucose',     name:'Glucose',             unit:'', section:'Chemical',  type:'select', options:['Negative','Trace','+','++','+++']},
  {key:'ketones',     name:'Ketones',             unit:'', section:'Chemical',  type:'select', options:['Negative','Trace','+','++','+++']},
  {key:'blood',       name:'Blood',               unit:'', section:'Chemical',  type:'select', options:['Negative','Trace','+','++','+++']},
  {key:'bilirubin',   name:'Bilirubin',           unit:'', section:'Chemical',  type:'select', options:['Negative','+','++']},
  {key:'urobilinogen',name:'Urobilinogen',        unit:'mg/dL', section:'Chemical', type:'number', low:0.1, high:1.0},
  {key:'nitrite',     name:'Nitrite',             unit:'', section:'Chemical',  type:'select', options:['Negative','Positive']},
  {key:'leuko',       name:'Leukocyte Esterase',  unit:'', section:'Chemical',  type:'select', options:['Negative','Trace','+','++','+++']},
  {key:'wbc_micro',   name:'WBC (Pus Cells)',     unit:'/HPF', section:'Microscopy', type:'select', options:['None','1-5','6-10','11-20','21-50','>50']},
  {key:'rbc_micro',   name:'RBC',                 unit:'/HPF', section:'Microscopy', type:'select', options:['None','1-2','3-5','6-10','>10']},
  {key:'epithelial',  name:'Epithelial Cells',    unit:'/HPF', section:'Microscopy', type:'select', options:['None','Few','Moderate','Many']},
  {key:'casts',       name:'Casts',               unit:'/LPF', section:'Microscopy', type:'select', options:['None','Hyaline','Granular','Waxy','RBC','WBC']},
  {key:'crystals',    name:'Crystals',            unit:'',     section:'Microscopy', type:'select', options:['None','Amorphous urates','Amorphous phosphates','Calcium oxalate','Uric acid','Cystine']},
  {key:'bacteria',    name:'Bacteria',            unit:'',     section:'Microscopy', type:'select', options:['None','Few','Moderate','Many']},
  {key:'yeast',       name:'Yeast Cells',         unit:'',     section:'Microscopy', type:'select', options:['None','Few','Moderate','Many']},
  {key:'parasite',    name:'Parasite / Ova',      unit:'',     section:'Microscopy', type:'select', options:['None','Trichomonas vaginalis','Schistosoma haematobium','Others']},
  {key:'mucus',       name:'Mucus Threads',       unit:'',     section:'Microscopy', type:'select', options:['None','Few','Moderate','Many']},
  {key:'micro_comment',name:'Microscopy Comment', unit:'',     section:'Microscopy', type:'text'}
];
const STOOL_MICRO_PARAMS = [
  {key:'consistency',  name:'Consistency',          unit:'', section:'Macroscopy', type:'select', options:['Formed','Soft','Loose','Watery','Mucoid','Bloody']},
  {key:'colour_stool', name:'Colour',               unit:'', section:'Macroscopy', type:'select', options:['Brown','Yellow','Green','Black','Pale','Red']},
  {key:'blood_stool',  name:'Blood (Macroscopic)',  unit:'', section:'Macroscopy', type:'select', options:['None','Present']},
  {key:'mucus_stool',  name:'Mucus (Macroscopic)',  unit:'', section:'Macroscopy', type:'select', options:['None','Present']},
  {key:'wbc_stool',    name:'WBC (Pus Cells)',      unit:'/HPF', section:'Microscopy', type:'select', options:['None','1-5','6-10','11-20','>20']},
  {key:'rbc_stool',    name:'RBC',                  unit:'/HPF', section:'Microscopy', type:'select', options:['None','1-2','3-5','6-10','>10']},
  {key:'fat_globules', name:'Fat Globules',         unit:'',     section:'Microscopy', type:'select', options:['None','Few','Moderate','Many']},
  {key:'ova_parasite', name:'Ova / Parasites',      unit:'',     section:'Microscopy', type:'select', options:['None','Entamoeba histolytica','Giardia lamblia','Ascaris lumbricoides','Hookworm','Taenia spp.','Schistosoma mansoni','Other']},
  {key:'yeast_stool',  name:'Yeast Cells',          unit:'',     section:'Microscopy', type:'select', options:['None','Few','Moderate','Many']},
  {key:'epithelial_stool',name:'Epithelial Cells',  unit:'',     section:'Microscopy', type:'select', options:['None','Few','Moderate','Many']},
  {key:'occult_blood', name:'Occult Blood (Chemical)',unit:'',   section:'Microscopy', type:'select', options:['Negative','Positive']},
  {key:'micro_comment_stool',name:'Microscopy Comment',unit:'', section:'Microscopy', type:'text'}
];

function getFlag(val, param) {
  let n = parseFloat(val);
  if (isNaN(n)) return '';
  if (param.high !== null && n > param.high) return '↑';
  if (param.low  !== null && n < param.low)  return '↓';
  return '';
}

function resolveTestType(testName, resultJson) {
  const fromDef = testDefinitions.testTypes[testName] || '';
  // Return simple types immediately — they don't need name/key sniffing
  if (fromDef === 'simple_numeric' || fromDef === 'simple_select') return fromDef;
  // Only trust fromDef if it's a known complex type; otherwise fall through to name/key sniffing
  const KNOWN_COMPLEX = ['complex_cbc','complex_eucr','complex_calcium','complex_phosphate','complex_uric_acid',
    'complex_lft','complex_total_protein','complex_psa','complex_diabetes','complex_rf','complex_hormone',
    'complex_marry','complex_antenatal','complex_blood','complex_rft','complex_thyroid','complex_lipid',
    'complex_coag','complex_urinalysis','complex_iron','complex_bone','complex_cardiac','complex_ogtt',
    'complex_csf','complex_abg','complex_semen','complex_culture','complex_stool_cs','complex_urine_mcs',
    'complex_stool_mcs','complex_malaria','complex_widal','complex_serology','complex_tb_genexpert',
    'complex_pcv','complex_hb','complex_esr','complex_rbs','complex_fbs',
    'complex_histopath','complex_fnac','complex_pap_smear'];
  if (fromDef && KNOWN_COMPLEX.includes(fromDef)) return fromDef;
  const n = (testName || '').toLowerCase();
  // Hard-coded name patterns (always reliable)
  if (/\bblood\s*transfusion\b|grouping.*cross|crossmatch|cross\s*match/.test(n)) return 'complex_blood';
  if (/semen\s*analysis|seminal/.test(n)) return 'complex_semen';
  if (/\bfull\s*blood\s*count\b|complete\s*blood\s*count|\bfbc\b|\bcbc\b/.test(n)) return 'complex_cbc';
  if (/\burinalysis\b|\burine\s*analysis\b/.test(n)) return 'complex_urinalysis';
  if (/\bantenatal\b|\bantinatal\b/.test(n)) return 'complex_antenatal';
  if (/\bpremarital\b|\bpre-marital\b|\bmarry\b/.test(n)) return 'complex_marry';
  if (/\bhormone\b|\bhormonal\b/.test(n)) return 'complex_hormone';
  if (/\bthyroid\b/.test(n)) return 'complex_thyroid';
  if (/\blipid\b/.test(n)) return 'complex_lipid';
  if (/\bliver\s*function\b|\blft\b/.test(n)) return 'complex_lft';
  if (/\brenal\s*function\b|\brft\b/.test(n)) return 'complex_rft';
  if (/\be\/u\/cr\b|\beucr\b|\belectrolyte\b/.test(n)) return 'complex_eucr';
  if (/\btotal\s*protein\b/.test(n)) return 'complex_total_protein';
  if (/\buric\s*acid\b/.test(n)) return 'complex_uric_acid';
  if (/\binorganic\s*phosphate\b|\bphosphate\b/.test(n)) return 'complex_phosphate';
  if (/\bcalcium\b/.test(n)) return 'complex_calcium';
  if (/\bcoagulation\b|\bcoag\b/.test(n)) return 'complex_coag';
  if (/\bdiabetes\b/.test(n)) return 'complex_diabetes';
  if (/\bcardiac\b/.test(n)) return 'complex_cardiac';
  if (/\bone\s*profile\b|\bbone\b/.test(n)) return 'complex_bone';
  if (/\biron\s*studies\b|\biron\s*profile\b/.test(n)) return 'complex_iron';
  if (/\bogtt\b/.test(n)) return 'complex_ogtt';
  if (/\bcsf\b/.test(n)) return 'complex_csf';
  if (/\barterial\s*blood\s*gas\b|\babg\b/.test(n)) return 'complex_abg';
  if (/\burine\s*mcs\b|\bgeneral\s*mcs\b/.test(n)) return 'complex_urine_mcs';
  if (/\bstool\s*mcs\b/.test(n)) return 'complex_stool_mcs';
  if (/\bmalaria\s*microscopy\b/.test(n)) return 'complex_malaria';
  if (/\bwidal\b/.test(n)) return 'complex_widal';
  if (/\bserology\b|\bhbv\s*profile\b|\bhepatitis\b/.test(n)) return 'complex_serology';
  if (/\bculture\b/.test(n)) return 'complex_culture';
  if (/\btb\s*genexpert\b|\bgenexpert\b/.test(n)) return 'complex_tb_genexpert';
  if (/histopath|biopsy|histology|surgical\s*path|tissue/.test(n)) return 'complex_histopath';
  if (/fnac|fine\s*needle|aspiration\s*cytol/.test(n)) return 'complex_fnac';
  if (/pap\s*smear|cervical\s*cytol|papanicolaou/.test(n)) return 'complex_pap_smear';

  // Last resort: sniff JSON keys to identify the param set
  if (resultJson && typeof resultJson === 'object') {
    const keys = Object.keys(resultJson);
    if (keys.some(k => ['transfusion_reason','bp_whole_blood','donor_blood_group','xm_ns_result'].includes(k))) return 'complex_blood';
    if (keys.some(k => ['time_produced','sperm_count','motility_a','morph_normal'].includes(k))) return 'complex_semen';
    if (keys.some(k => ['hb','pcv','twbc','rbc','neut','lymph'].includes(k))) return 'complex_cbc';
    if (keys.some(k => ['colour','leuko','urobilinogen'].includes(k))) return 'complex_urinalysis';
    if (keys.some(k => ['lh','fsh','testosterone','prolactin'].includes(k))) return 'complex_hormone';
    if (keys.some(k => ['tsh','t3','t4'].includes(k))) return 'complex_thyroid';
    if (keys.some(k => ['chol','hdl','ldl','tg','vldl'].includes(k))) return 'complex_lipid';
    if (keys.some(k => ['tbil','dbil','alp','ast','alt'].includes(k))) return 'complex_lft';
    if (keys.some(k => ['sodium','potassium','bicarb','urea','creat'].includes(k))) return 'complex_eucr';
    if (keys.some(k => ['prot','alb','glob'].includes(k))) return 'complex_total_protein';
    if (keys.some(k => ['uric_female','uric_male'].includes(k))) return 'complex_uric_acid';
    if (keys.some(k => ['phosphate_adult','phosphate_children'].includes(k))) return 'complex_phosphate';
    if (keys.some(k => ['calcium'].includes(k)) && keys.length === 1) return 'complex_calcium';
    if (keys.some(k => ['fbs','rbs','hpp2','ogtt','hba1c'].includes(k))) return 'complex_diabetes';
    if (keys.some(k => ['pt','inr','aptt','fibrinogen'].includes(k))) return 'complex_coag';
    if (keys.some(k => ['ckmb','troponinI','troponinT'].includes(k))) return 'complex_cardiac';
    if (keys.some(k => ['alkaline_phosphatase','vitaminD'].includes(k))) return 'complex_bone';
    if (keys.some(k => ['iron','tibc','ferritin'].includes(k))) return 'complex_iron';
    if (keys.some(k => ['fasting','one_hour','two_hour'].includes(k))) return 'complex_ogtt';
    if (keys.some(k => ['ph','pco2','po2','base_excess'].includes(k))) return 'complex_abg';
    if (keys.some(k => ['hbsag','hcv','hb_genotype','blood_group','pcv'].includes(k)) &&
        keys.some(k => ['hb_genotype'].includes(k))) return 'complex_antenatal';
    if (keys.some(k => ['hbsag','hcv','hb_genotype','rvs'].includes(k)) &&
        !keys.some(k => k === 'pcv')) return 'complex_marry';
    if (keys.some(k => ['hbsag','anti_hbs','hbeag'].includes(k))) return 'complex_serology';
    if (keys.some(k => ['organism','sensitivities'].includes(k))) return 'complex_culture';
    if (keys.some(k => ['mtb_detected','rif_resistance'].includes(k))) return 'complex_tb_genexpert';
    if (keys.some(k => ['species','stage','density'].includes(k))) return 'complex_malaria';
    if (keys.some(k => ['o','h','ao','ah'].includes(k))) return 'complex_widal';
    if (keys.some(k => ['macro_desc','micro_desc','diagnosis','nature_specimen'].includes(k))) return 'complex_histopath';
    if (keys.some(k => ['site','laterality','cytology','adequacy'].includes(k)) && keys.some(k => ['stain','lesion_size'].includes(k))) return 'complex_fnac';
    if (keys.some(k => ['specimen_type','lmp','organisms','recommendation'].includes(k))) return 'complex_pap_smear';
  }
  return '';
}

function buildParamTable(testName, data, testType, age, gender) {
  // Dynamic single‑parameter tests
  const dynamicTests = ['complex_pcv', 'complex_hb', 'complex_esr', 'complex_rbs', 'complex_fbs'];
  if (dynamicTests.includes(testType)) {
    let key = testType.split('_')[1];
    let val = data[key];
    if (val === undefined) val = '';
    let range = getReferenceRange(testName, age, gender);
    if (!range) range = { low: 0, high: 100, unit: '' };
    let flag = '';
    let num = parseFloat(val);
    if (!isNaN(num)) {
      if (num > range.high) flag = '↑';
      else if (num < range.low) flag = '↓';
    }
    let cls = flag === '↑' ? 'flag-high' : flag === '↓' ? 'flag-low' : '';
    return `
      <table class="param-table">
        <thead><tr><th>Parameter</th><th>Result</th><th>Unit</th><th>Reference</th></tr></thead>
        <tbody>
           <tr><td style="font-weight:500;">${esc(testName)}</td>
              <td class="${cls}">${val} ${flag}</td>
              <td>${esc(range.unit)}</td>
              <td>${range.low}–${range.high}</td>
           </tr>
        </tbody>
      </table>`;
  }

  // Culture & Sensitivity (general)
  if (testType === 'complex_culture' || testType === 'complex_stool_cs') {
    let organism = data.organism || 'Not specified';
    let sensRows = (data.sensitivities || []).map(s => {
      const label  = s.result === 'S' ? 'Sensitive' : s.result === 'R' ? 'Resistant' : s.result === 'I' ? 'Intermediate' : s.result || '—';
      const colour = s.result === 'S' ? '#15803d'   : s.result === 'R' ? '#b91c1c'   : s.result === 'I' ? '#92400e'      : '#374151';
      const bg     = s.result === 'S' ? '#dcfce7'   : s.result === 'R' ? '#fee2e2'   : s.result === 'I' ? '#fef3c7'      : '#f3f4f6';
      return `<tr>
         <td>${esc(s.antibiotic)}</td>
        <td style="font-weight:700; color:${colour};">${esc(s.result)}</td>
        <td><span style="display:inline-block; padding:2px 10px; border-radius:20px; background:${bg}; color:${colour}; font-size:0.78rem; font-weight:600;">${label}</span></td>
        <td></td>
       </tr>`;
    }).join('');
    return `
      <div style="margin-bottom:12px;">
        <strong>${esc(testName)}</strong>
        <table class="param-table">
          <thead><tr><th>Organism</th><th colspan="3"><em>${esc(organism)}</em></th></tr></thead>
          <tbody>
            ${sensRows
              ? `<tr style="background:#f0f0f0;"><th>Antibiotic</th><th>Result</th><th>Interpretation</th><th></th></tr>${sensRows}`
              : `<tr><td colspan="4" style="color:#6b7280;">No antibiotic sensitivities recorded.</td></tr>`}
          </tbody>
        </table>
      </div>`;
  }

  // Urine MCS or Stool MCS
  if (testType === 'complex_urine_mcs' || testType === 'complex_stool_mcs') {
    const isMCS = testType === 'complex_urine_mcs';
    const MICRO_PARAMS = isMCS ? URINE_MICRO_PARAMS : STOOL_MICRO_PARAMS;
    const sections = isMCS ? ['Physical','Chemical','Microscopy'] : ['Macroscopy','Microscopy'];
    let html = `<div style="margin-bottom:4px;"><strong>${esc(testName)}</strong></div>`;
    sections.forEach(sec => {
      const secParams = MICRO_PARAMS.filter(p => p.section === sec);
      const secRows = secParams.map(p => {
        let v = data[p.key];
        if (v === undefined || v === '' || v === 'None' || v === 'None seen' || v === 'Absent' || v === 'Negative') return '';
        let flag = ''; let cls = '';
        if (p.type === 'number' && p.low !== undefined) {
          let n = parseFloat(v);
          if (!isNaN(n)) { if (n > p.high) { flag = '↑'; cls = 'flag-high'; } else if (n < p.low) { flag = '↓'; cls = 'flag-low'; } }
        }
        return `<tr><td>${esc(p.name)}</td><td class="${cls}">${esc(v)} ${flag}</td><td>${esc(p.unit||'')}</td><td>—</td></tr>`;
      }).filter(Boolean).join('');
      if (!secRows) return;
      html += `<table class="param-table">
        <thead><tr><th colspan="4" style="background:#dbeafe; text-align:left; font-size:0.7rem; text-transform:uppercase; letter-spacing:1px;">${sec}</th></tr>
        <tr><th>Parameter</th><th>Result</th><th>Unit</th><th>Ref</th></tr></thead>
        <tbody>${secRows}</tbody>
      </table>`;
    });
    // C&S section
    const sensRows = (data.sensitivities || []).map(s => {
      const label  = s.result==='S'?'Sensitive':s.result==='R'?'Resistant':s.result==='I'?'Intermediate':s.result||'—';
      const colour = s.result==='S'?'#15803d':s.result==='R'?'#b91c1c':s.result==='I'?'#92400e':'#374151';
      const bg     = s.result==='S'?'#dcfce7':s.result==='R'?'#fee2e2':s.result==='I'?'#fef3c7':'#f3f4f6';
      return `<tr><td>${esc(s.antibiotic)}</td><td style="font-weight:700;color:${colour};">${esc(s.result)}</td>
        <td><span style="display:inline-block;padding:2px 10px;border-radius:20px;background:${bg};color:${colour};font-size:0.78rem;font-weight:600;">${label}</span></td><td></td></tr>`;
    }).join('');
    html += `<table class="param-table">
      <thead>
        <tr><th colspan="4" style="background:#dbeafe; text-align:left; font-size:0.7rem; text-transform:uppercase; letter-spacing:1px;">Culture &amp; Sensitivity</th></tr>
        <tr><th>Organism</th><th colspan="3" style="font-style:italic; font-weight:400;">${esc(data.organism || 'No growth / Not specified')}</th></tr>
        ${sensRows ? '<tr style="background:#f0f0f0;"><th>Antibiotic</th><th>Result</th><th>Interpretation</th><th></th></tr>' : ''}
      </thead>
      <tbody>${sensRows || '<tr><td colspan="4" style="color:#6b7280;">No antibiotic sensitivities recorded.</td></tr>'}</tbody>
    </table>`;
    return html;
  }

  // Widal
  if (testType === 'complex_widal') {
    const rows = [
      { organism: 'Salmonella Typhi',       o: data.o  ?? '—', h: data.h  ?? '—' },
      { organism: 'Salmonella Paratyphi A', o: data.ao ?? '—', h: data.ah ?? '—' },
      { organism: 'Salmonella Paratyphi B', o: data.bo ?? '—', h: data.bh ?? '—' },
      { organism: 'Salmonella Paratyphi C', o: data.co ?? '—', h: data.ch ?? '—' }
    ];
    let tableRows = '';
    for (let r of rows) {
      const oFlag    = (parseInt(r.o) >= 160) ? ' ↑' : '';
      const hFlag    = (parseInt(r.h) >= 160) ? ' ↑' : '';
      const oDisplay = r.o !== '—' ? `1:${r.o}${oFlag}` : '—';
      const hDisplay = r.h !== '—' ? `1:${r.h}${hFlag}` : '—';
      const oColour  = oFlag ? '#b91c1c' : 'inherit';
      const hColour  = hFlag ? '#b91c1c' : 'inherit';
      tableRows += `<tr>
        <td style="font-style:italic; font-weight:500; width:45%;">${r.organism}</td>
        <td style="text-align:center; width:27.5%; font-weight:${oFlag ? '700' : '400'}; color:${oColour};">${oDisplay}</td>
        <td style="text-align:center; width:27.5%; font-weight:${hFlag ? '700' : '400'}; color:${hColour};">${hDisplay}</td>
       </tr>`;
    }
    return `
      <table class="param-table" style="width:100%; table-layout:fixed; border-collapse:collapse;">
        <colgroup><col style="width:45%;"><col style="width:27.5%;"><col style="width:27.5%;"></colgroup>
        <thead><tr><th style="text-align:left; padding:8px 10px;">Organism</th><th style="text-align:center; padding:8px 10px;">O Antigen (TO)</th><th style="text-align:center; padding:8px 10px;">H Antigen (TH)</th></tr></thead>
        <tbody>${tableRows}</tbody>
      </table>`;
  }

  // Malaria
  if (testType === 'complex_malaria') {
    let rows = '';
    if (data.species) rows += `<tr><td>Species</td><td colspan="3">${esc(data.species)}</td></tr>`;
    if (data.stage) rows += `<tr><td>Stage</td><td colspan="3">${esc(data.stage)}</td></tr>`;
    if (data.density !== undefined) rows += `<tr><td>Parasite Density</td><td colspan="3">${esc(data.density)} parasites/µL</td></tr>`;
    return `<table class="param-table"><tbody>${rows}</tbody></table>`;
  }

  // TB GeneXpert
  if (testType === 'complex_tb_genexpert') {
    let rows = '';
    if (data.mtb_detected) rows += `<tr><td>MTB Detected</td><td colspan="3">${esc(data.mtb_detected)}</td></tr>`;
    if (data.rif_resistance) rows += `<tr><td>Rifampicin Resistance</td><td colspan="3">${esc(data.rif_resistance)}</td></tr>`;
    for (let probe of ['probeA_ct','probeB_ct','probeC_ct','probeD_ct','probeE_ct']) {
      if (data[probe] !== undefined) rows += `<tr><td>${probe.replace('_ct',' Probe Ct')}</td><td colspan="3">${esc(data[probe])}</td></tr>`;
    }
    return `<table class="param-table"><tbody>${rows}</tbody></table>`;
  }

  // Serology
  if (testType === 'complex_serology') {
    let rows = '';
    for (let p of SEROLOGY_PARAMS) {
      if (data[p.key] !== undefined) rows += `<tr><td>${esc(p.name)}</td><td colspan="3">${esc(data[p.key])}</td></tr>`;
    }
    return `<table class="param-table"><tbody>${rows}</tbody></table>`;
  }

  // Histopathology
  if (testType === 'complex_histopath') {
    const sections = ['Request', 'Report'];
    let html = '';
    sections.forEach(sec => {
      const secParams = HISTOPATH_PARAMS.filter(p => p.section === sec);
      let secRows = '';
      secParams.forEach(p => {
        let v = data[p.key];
        if (v === undefined || v === null || v === '') return;
        secRows += `<tr><td style="font-weight:500;width:38%;">${esc(p.name)}</td><td colspan="3" style="white-space:pre-wrap;">${esc(v)}</td></tr>`;
      });
      if (!secRows) return;
      html += `<table class="param-table">
        <thead><tr><th colspan="4" style="background:#f3e8ff;text-align:left;font-size:0.7rem;text-transform:uppercase;letter-spacing:1px;color:#6b21a8;">${sec === 'Request' ? 'Request Details' : 'Pathology Report'}</th></tr></thead>
        <tbody>${secRows}</tbody>
      </table>`;
    });
    return html || `<table class="param-table"><tbody><tr><td colspan="4" style="color:#6b7280;">No histopathology data recorded.</td></tr></tbody></table>`;
  }

  // FNAC
  if (testType === 'complex_fnac') {
    const sections = ['Request', 'Report'];
    let html = '';
    sections.forEach(sec => {
      const secParams = FNAC_PARAMS.filter(p => p.section === sec);
      let secRows = '';
      secParams.forEach(p => {
        let v = data[p.key];
        if (v === undefined || v === null || v === '') return;
        let flag = ''; let cls = '';
        if (p.type === 'number' && p.low !== undefined) {
          let n = parseFloat(v);
          if (!isNaN(n)) { if (n > p.high) { flag = '↑'; cls = 'flag-high'; } else if (n < p.low) { flag = '↓'; cls = 'flag-low'; } }
        }
        secRows += `<tr><td style="font-weight:500;width:38%;">${esc(p.name)}</td><td class="${cls}" colspan="3" style="white-space:pre-wrap;">${esc(String(v))} ${flag}</td></tr>`;
      });
      if (!secRows) return;
      html += `<table class="param-table">
        <thead><tr><th colspan="4" style="background:#fef9c3;text-align:left;font-size:0.7rem;text-transform:uppercase;letter-spacing:1px;color:#854d0e;">${sec === 'Request' ? 'FNAC Request Details' : 'Cytology Report'}</th></tr></thead>
        <tbody>${secRows}</tbody>
      </table>`;
    });
    return html || `<table class="param-table"><tbody><tr><td colspan="4" style="color:#6b7280;">No FNAC data recorded.</td></tr></tbody></table>`;
  }

  // PAP Smear
  if (testType === 'complex_pap_smear') {
    const sections = ['Request', 'Report'];
    let html = '';
    sections.forEach(sec => {
      const secParams = PAP_SMEAR_PARAMS.filter(p => p.section === sec);
      let secRows = '';
      secParams.forEach(p => {
        let v = data[p.key];
        if (v === undefined || v === null || v === '') return;
        secRows += `<tr><td style="font-weight:500;width:38%;">${esc(p.name)}</td><td colspan="3" style="white-space:pre-wrap;">${esc(String(v))}</td></tr>`;
      });
      if (!secRows) return;
      html += `<table class="param-table">
        <thead><tr><th colspan="4" style="background:#fce7f3;text-align:left;font-size:0.7rem;text-transform:uppercase;letter-spacing:1px;color:#9d174d;">${sec === 'Request' ? 'Request Details' : 'PAP Smear Report (Bethesda)'}</th></tr></thead>
        <tbody>${secRows}</tbody>
      </table>`;
    });
    return html || `<table class="param-table"><tbody><tr><td colspan="4" style="color:#6b7280;">No PAP smear data recorded.</td></tr></tbody></table>`;
  }

  // Semen Analysis (with Culture & Sensitivity on separate visual section)
  if (testType === 'complex_semen') {
    // Section definitions matching the physical form
    const SEMEN_HTML_SECTIONS = [
      { label: 'Semen Collection', keys: ['time_produced','time_received','time_analysed','abstinence'] },
      { label: 'Macroscopy',       keys: ['appearance','volume','viscosity','consistency','liquefaction'] },
      { label: 'Microscopy',       keys: ['sperm_count','viability'] },
      { label: 'Motility',         keys: ['motility_a','motility_b','motility_c','motility_d'] },
      { label: 'Morphology — Head', keys: ['morph_microcephalic','morph_macrocephalic','morph_pinhead','morph_pyriform','morph_double_head','morph_acrosomal'] },
      { label: 'Morphology — Tail', keys: ['morph_tailless','morph_short_tail','morph_long_tail','morph_double_tail','morph_coiled_tail'] },
      { label: 'Morphology — Others', keys: ['morph_cytoplasmic_droplets','morph_midpiece_abnormality','morph_neck_defect','morph_normal'] },
      { label: 'Wet Preparation',  keys: ['wp_epithelial_cells','wp_pus_cells','wp_rbc','wp_parasite','wp_other'] },
      { label: "Gram's Stain",     keys: ['gram_stain'] },
      { label: 'Comments',         keys: ['comments'] }
    ];
    const paramMap = {};
    SEMEN_PARAMS.forEach(p => { paramMap[p.key] = p; });

    let html = `<table class="param-table"><thead><tr><th>Parameter</th><th>Result</th><th>Unit</th><th>Reference</th></tr></thead><tbody>`;

    SEMEN_HTML_SECTIONS.forEach(sec => {
      let secRows = '';
      sec.keys.forEach(k => {
        const p = paramMap[k];
        if (!p) return;
        let val = data[p.key];
        if (val === undefined || val === '') return;
        let displayVal = val;
        let flag = '';
        let unit = p.unit || '';
        let ref = (p.low != null && p.high != null) ? `${p.low}–${p.high}` : (p.low != null ? `\u2265${p.low}` : p.high != null ? `\u2264${p.high}` : '—');
        if (p.type === 'number' || !p.type) {
          let n = parseFloat(val);
          if (!isNaN(n)) {
            if (p.high != null && n > p.high) flag = '↑';
            if (p.low  != null && n < p.low)  flag = '↓';
            displayVal = flag ? `${n} ${flag}` : String(n);
          }
        }
        let cls = flag === '↑' ? 'flag-high' : flag === '↓' ? 'flag-low' : '';
        secRows += `<tr><td>${esc(p.name)}</td><td class="${cls}">${esc(displayVal)}</td><td>${esc(unit)}</td><td>${esc(ref)}</td></tr>`;
      });
      if (!secRows) return;
      html += `<tr><td colspan="4" style="background:#e8f4ed;font-weight:700;font-size:0.72rem;text-transform:uppercase;letter-spacing:.5px;padding:5px 10px;color:#1a5c38;">${esc(sec.label)}</td></tr>`;
      html += secRows;
    });

    html += `</tbody></table>`;

    // C&S section — visually separated, styled as a distinct block
    const sensRows = (data.sensitivities || []).map(s => {
      const label  = s.result==='S'?'Sensitive':s.result==='R'?'Resistant':s.result==='I'?'Intermediate':s.result||'—';
      const colour = s.result==='S'?'#15803d':s.result==='R'?'#b91c1c':s.result==='I'?'#92400e':'#374151';
      const bg     = s.result==='S'?'#dcfce7':s.result==='R'?'#fee2e2':s.result==='I'?'#fef3c7':'#f3f4f6';
      return `<tr>
        <td>${esc(s.antibiotic)}</td>
        <td style="font-weight:700;color:${colour};">${esc(s.result)}</td>
        <td><span style="display:inline-block;padding:2px 10px;border-radius:20px;background:${bg};color:${colour};font-size:0.78rem;font-weight:600;">${label}</span></td>
        <td></td>
      </tr>`;
    }).join('');

    html += `
      <div style="margin-top:18px;border-top:2px solid #1d4ed8;padding-top:10px;">
        <div style="font-weight:700;font-size:0.85rem;text-transform:uppercase;letter-spacing:.5px;color:#1d4ed8;margin-bottom:8px;">
          <i class="fas fa-flask"></i> Culture &amp; Sensitivity
        </div>
        <table class="param-table">
          <thead>
            <tr><th colspan="4" style="background:#dbeafe;text-align:left;font-size:0.7rem;text-transform:uppercase;letter-spacing:1px;color:#1e40af;">Culture &amp; Sensitivity Results</th></tr>
            <tr><th>Organism</th><th colspan="3" style="font-style:italic;font-weight:400;">${esc(data.organism || 'No growth / Not specified')}</th></tr>
            ${sensRows ? '<tr style="background:#f0f0f0;"><th>Antibiotic</th><th>Result</th><th>Interpretation</th><th></th></tr>' : ''}
          </thead>
          <tbody>${sensRows || '<tr><td colspan="4" style="color:#6b7280;">No antibiotic sensitivities recorded.</td></tr>'}</tbody>
        </table>
      </div>`;

    return html;
  }

  // ===== NEW: Simple Numeric (with stored reference range) =====
  if (testType === 'simple_numeric') {
    let val = typeof data === 'string' ? data : (data.result !== undefined ? data.result : '');
    let range = testDefinitions.refRanges?.[testName];
    if (range) {
      let num = parseFloat(val);
      let flag = !isNaN(num) ? (num > range.high ? '↑' : num < range.low ? '↓' : '') : '';
      let cls = flag === '↑' ? 'flag-high' : flag === '↓' ? 'flag-low' : '';
      return `
        <table class="param-table">
          <thead><tr><th>Parameter</th><th>Result</th><th>Unit</th><th>Reference</th></tr></thead>
          <tbody>
            <tr>
              <td style="font-weight:500;">${esc(testName)}</td>
              <td class="${cls}">${val} ${flag}</td>
              <td>${esc(range.unit)}</td>
              <td>${range.low}–${range.high}</td>
            </tr>
          </tbody>
        </table>`;
    } else {
      return `<table class="param-table"><tbody><tr><td style="font-weight:500;">${esc(testName)}</td><td colspan="3">${val}</td></tr></tbody></table>`;
    }
  }

  // ===== NEW: Simple Select – just show the selected value =====
  if (testType === 'simple_select') {
    let val = typeof data === 'string' ? data : (data.result !== undefined ? data.result : '');
    return `<table class="param-table"><tbody><tr><td style="font-weight:500;">${esc(testName)}</td><td colspan="3">${val}</td></tr></tbody></table>`;
  }

  // Standard numeric panels
  let params = [];
  if (testType === 'complex_cbc') params = CBC_PARAMS;
  else if (testType === 'complex_eucr') params = EUCR_PARAMS;
  else if (testType === 'complex_calcium') params = CALCIUM_PARAMS;
  else if (testType === 'complex_phosphate') params = PHOSPHATE_PARAMS;
  else if (testType === 'complex_uric_acid') params = URIC_ACID_PARAMS;
  else if (testType === 'complex_lft') params = LFT_PARAMS_FULL;
  else if (testType === 'complex_total_protein') params = TOTAL_PROTEIN_PARAMS;
  else if (testType === 'complex_psa') params = PSA_PARAMS;
  else if (testType === 'complex_diabetes') params = DIABETES_PARAMS;
  else if (testType === 'complex_rf') params = RF_PARAMS;
  else if (testType === 'complex_hormone') params = HORMONE_PARAMS;
  else if (testType === 'complex_marry') params = MARRY_PARAMS;
  else if (testType === 'complex_antenatal') params = ANTENATAL_PARAMS;
  else if (testType === 'complex_blood') params = BLOOD_TRANSFUSION_PARAMS;
  else if (testType === 'complex_rft') params = RFT_PARAMS_FULL;
  else if (testType === 'complex_thyroid') params = THYROID_PARAMS;
  else if (testType === 'complex_lipid') params = LIPID_PARAMS;
  else if (testType === 'complex_coag') params = COAG_PARAMS;
  else if (testType === 'complex_urinalysis') params = URINALYSIS_MICRO_PARAMS;
  else if (testType === 'complex_iron') params = IRON_PARAMS;
  else if (testType === 'complex_bone') params = BONE_PARAMS;
  else if (testType === 'complex_cardiac') params = CARDIAC_PARAMS;
  else if (testType === 'complex_ogtt') params = OGTT_PARAMS;
  else if (testType === 'complex_csf') params = CSF_PARAMS;
  else if (testType === 'complex_abg') params = ABG_PARAMS;
  else if (testType === 'complex_semen') params = SEMEN_PARAMS;

  if (!params.length) {
    let rows = Object.entries(data).map(([k, v]) => `<tr><td colspan="2">${esc(k)}: ${esc(String(v))}</td><td colspan="2"></td></tr>`).join('');
    return `<table class="param-table"><tbody>${rows}</tbody></table>`;
  }

  let rows = '';
  for (let p of params) {
    let val = data[p.key];
    if (val === undefined || val === '') continue;
    let displayVal = val;
    let flag = '';
    let unit = p.unit || '';
    let ref = (p.low != null && p.high != null) ? `${p.low}–${p.high}` : (p.low != null ? `≥${p.low}` : p.high != null ? `≤${p.high}` : (p.note || '—'));
    if (p.type === 'number' || !p.type) {
      let n = parseFloat(val);
      if (!isNaN(n)) {
        if (p.high != null && n > p.high) flag = '↑';
        if (p.low != null && n < p.low) flag = '↓';
        displayVal = flag ? `${n} ${flag}` : String(n);
      }
    }
    let cls = flag === '↑' ? 'flag-high' : flag === '↓' ? 'flag-low' : '';
    rows += `<tr>
       <td>${esc(p.name)}</td>
      <td class="${cls}">${esc(displayVal)}</td>
      <td>${esc(unit)}</td>
      <td>${esc(ref)}</td>
     </tr>`;
  }
  return `<table class="param-table"><thead><tr><th>Parameter</th><th>Result</th><th>Unit</th><th>Reference</th></tr></thead><tbody>${rows}</tbody></table>`;
}


function groupTestsByUnitDC(tests){
  const groups = {};
  (tests||[]).forEach(t=>{
    const unit = t.unit_name || testDefinitions.testUnits[t.test_name] || 'General';
    if(!groups[unit]) groups[unit]=[];
    groups[unit].push(t);
  });
  return groups;
}

// Renders one test's result exactly the way pending_portal.js's
// buildResultCard() does — simple_select/simple_numeric shortcuts,
// dynamic single-parameter panels (PCV/Hb/ESR/RBS/FBS), full JSON
// panels via buildParamTable(), or a plain result row as a last resort.
function renderTestResultBlock(t, age, gender){
  let parsedResult = null;
  const raw = (t.result!=null && String(t.result).trim().startsWith('{')) ? t.result
            : (t.result_json ? (typeof t.result_json==='string'?t.result_json:JSON.stringify(t.result_json)) : null);
  if(raw){
    try { parsedResult = JSON.parse(raw); } catch(e){}
  }
  const testType = resolveTestType(t.test_name, parsedResult);

  if(testType === 'simple_select'){
    const val = t.result || '—';
    return `<table class="param-table">
      <thead><tr><th>Parameter</th><th colspan="3">Result</th></tr></thead>
      <tbody><tr><td style="font-weight:500;">${esc(t.test_name)}</td><td colspan="3">${esc(val)}</td></tr></tbody>
    </table>`;
  }

  if(testType === 'simple_numeric'){
    const ref = testDefinitions.refRanges?.[t.test_name];
    const val = t.result || '—';
    let flag='', cls='';
    if(ref){
      const num = parseFloat(val);
      if(!isNaN(num)){
        if(num > ref.high){ flag='↑'; cls='flag-high'; }
        else if(num < ref.low){ flag='↓'; cls='flag-low'; }
      }
    }
    const unitStr  = ref ? esc(ref.unit) : '—';
    const refRange = ref ? `${ref.low}–${ref.high}` : '—';
    return `<table class="param-table">
      <thead><tr><th>Parameter</th><th>Result</th><th>Unit</th><th>Reference</th></tr></thead>
      <tbody><tr>
        <td style="font-weight:500;">${esc(t.test_name)}</td>
        <td class="${cls}">${esc(val)} ${flag}</td>
        <td>${unitStr}</td>
        <td>${refRange}</td>
      </tr></tbody>
    </table>`;
  }

  if(['complex_pcv','complex_hb','complex_esr','complex_rbs','complex_fbs'].includes(testType)){
    return buildParamTable(t.test_name, { [testType.split('_')[1]]: t.result || '' }, testType, age, gender);
  }

  if(!parsedResult){
    return `<table class="param-table">
      <thead><tr><th>Parameter</th><th>Result</th><th>Unit</th><th>Reference</th></tr></thead>
      <tbody><tr><td style="font-weight:500;">${esc(t.test_name)}</td><td>${esc(t.result || '—')}</td><td>—</td><td>—</td></tr></tbody>
    </table>`;
  }

  try {
    return buildParamTable(t.test_name, parsedResult, testType, age, gender);
  } catch(e){
    console.error('[DC] buildParamTable failed for', t.test_name, e);
    return `<div><strong>${esc(t.test_name)}</strong><br>${esc(t.result)}</div>`;
  }
}

function renderResultModal(sample){
  let modal = document.getElementById('drResultModal');
  if(!modal){
    modal = document.createElement('div');
    modal.id = 'drResultModal';
    modal.style.cssText = 'display:none;position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:1000;align-items:center;justify-content:center;padding:20px;';
    document.body.appendChild(modal);
  }

  const age    = getAgeYears(selectedPatient);
  const gender = selectedPatient?.gender;

  const groups = groupTestsByUnitDC(sample.sample_tests);
  const sections = Object.entries(groups).map(([unitName, unitTests])=>{
    const blocks = unitTests.map(t=>renderTestResultBlock(t, age, gender)).join('');
    return `<div class="unit-group"><div class="unit-title">${esc(unitName)}</div>${blocks}</div>`;
  }).join('');

  modal.innerHTML = `
    <div style="background:var(--card,#1a1a2e);border-radius:12px;max-width:680px;width:100%;max-height:85vh;overflow-y:auto;padding:20px;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">
        <h3 style="margin:0;">MU-${sample.id} — Results</h3>
        <button id="drResultModalClose" style="background:none;border:none;color:var(--muted);font-size:1.4rem;cursor:pointer;">&times;</button>
      </div>
      ${sections || '<div style="color:var(--muted);font-size:0.84rem;">No test detail available.</div>'}
      <div style="margin-top:14px;color:var(--muted);font-size:0.78rem;">
        For the fully formatted, printable lab report (with barcode and signatures), ask lab reception for a printed copy of MU-${sample.id}.
      </div>
    </div>`;

  modal.style.display = 'flex';
  document.getElementById('drResultModalClose').onclick = () => modal.style.display = 'none';
  modal.onclick = (e) => { if(e.target === modal) modal.style.display = 'none'; };
}



document.querySelectorAll('.ctab').forEach(btn=>{
  btn.addEventListener('click',()=>switchTab(btn.dataset.tab));
});
function switchTab(tab){
  document.querySelectorAll('.ctab').forEach(b=>b.classList.toggle('active',b.dataset.tab===tab));
  document.querySelectorAll('.cpanel').forEach(p=>p.classList.toggle('active',p.id===`cpanel-${tab}`));
}

// ============================================================
// ACTION SELECTOR
// ============================================================
document.querySelectorAll('.action-btn').forEach(btn=>{
  btn.addEventListener('click',()=>{
    document.querySelectorAll('.action-btn').forEach(b=>b.classList.remove('selected'));
    document.querySelectorAll('.action-fields').forEach(f=>f.classList.remove('show'));
    btn.classList.add('selected');
    selectedAction = btn.dataset.action;
    const fieldEl = document.getElementById(`fields_${selectedAction}`);
    if(fieldEl) fieldEl.classList.add('show');
    // Bed occupancy changes constantly through a shift — refresh live counts
    // right when the doctor is about to pick a ward, not just once at page load.
    if(selectedAction==='admit' || selectedAction==='admit_and_lab') refreshBedAvailability();
  });
});

// ============================================================
// TEST DEFINITIONS (from existing LIS test_definitions table)
// ============================================================
// Mirrors accession.js's populateUnits() / updateTests() / addTest() flow
// exactly: flat rows -> grouped into testDefinitionsByUnit[unit_name] =
// [test_names] -> Unit select populated from Object.keys() -> Test select
// repopulated from testDefinitionsByUnit[selectedUnit] on unit change ->
// addTest() reads both selects and pushes {id, name, unit_name} into the
// group's cart array (same natural key accession uses for its cart dedup).
let testDefinitionsByUnit = {};

// suffix -> which group this control set belongs to: '' = lab_request,
// '2' = lab_and_discharge, '3' = admit_and_lab (same three arrays as before)
const TEST_GROUPS = [
  { suf:'',  arr:()=>selectedTests  },
  { suf:'2', arr:()=>selectedTests2 },
  { suf:'3', arr:()=>selectedTests3 }
];

async function loadTestDefs(){
  if(allTestDefs.length>0) return; // already loaded
  let { data, error } = await client.from('test_definitions')
    .select('unit_name,test_name,price_ngn,sample_type,tube,test_type,ref_low,ref_high,ref_unit')
    .order('unit_name',{ascending:true})
    .order('test_name',{ascending:true});
  // Defensive fallback: if this LIS instance's test_definitions table
  // doesn't have the ref_low/ref_high/ref_unit columns (used only for the
  // simple_numeric reference-range display), retry without them instead
  // of failing test-list loading entirely.
  if(error && /column .*(ref_low|ref_high|ref_unit)/i.test(error.message||'')){
    console.warn('[DC] test_definitions missing ref range columns, retrying without them:', error.message);
    ({ data, error } = await client.from('test_definitions')
      .select('unit_name,test_name,price_ngn,sample_type,tube,test_type')
      .order('unit_name',{ascending:true})
      .order('test_name',{ascending:true}));
  }
  if(error){
    console.error('loadTestDefs failed:', error);
    showError('Failed to load test list — ' + error.message);
    // Degrade gracefully instead of leaving selects stuck on "Loading
    // units...": show each group's "no tests" notice and disable Add.
    allTestDefs = [];
    testDefinitionsByUnit = {};
    TEST_GROUPS.forEach(g=>populateUnits(g.suf));
    return;
  }
  allTestDefs = data||[];
  testDefinitionsByUnit = {};
  // Results-rendering engine's lookup maps (test_type, unit, stored ref
  // range) — same shape pending_portal.js's loadTestDefinitions() builds,
  // used by resolveTestType()/buildParamTable() in renderResultModal().
  testDefinitions = { testTypes: {}, testUnits: {}, refRanges: {} };
  allTestDefs.forEach(t=>{
    if(!testDefinitionsByUnit[t.unit_name]) testDefinitionsByUnit[t.unit_name]=[];
    // Skip unit placeholder rows (inserted by management1.addUnit() so an
    // empty unit still shows up in unit lists) — same filter management1.js
    // applies in its loadTestDefinitions(). accession.js is missing this
    // filter too, but doctor-consultation should not inherit that gap.
    if(t.test_name === '__unit_placeholder__' || t.test_name.startsWith('__unit__')) return;
    testDefinitionsByUnit[t.unit_name].push(t.test_name);
    testDefinitions.testUnits[t.test_name] = t.unit_name || 'Other';
    if(t.test_type && t.test_type !== 'simple') testDefinitions.testTypes[t.test_name] = t.test_type;
    if(t.test_type === 'simple_numeric' && t.ref_low != null && t.ref_high != null){
      testDefinitions.refRanges[t.test_name] = { low: t.ref_low, high: t.ref_high, unit: t.ref_unit || '' };
    }
  });
  TEST_GROUPS.forEach(g=>populateUnits(g.suf));
}

// Fills the Unit select for a group, same as accession's populateUnits()
function populateUnits(suf){
  const units   = Object.keys(testDefinitionsByUnit);
  const unitSel = document.getElementById(`c_unit${suf}`);
  const addBtn  = document.getElementById(`addTestBtn${suf}`);
  const notice  = document.getElementById(`noTestsNotice${suf}`);
  if(!units.length){
    if(unitSel) unitSel.innerHTML = '<option value="">No units found</option>';
    if(addBtn) addBtn.disabled = true;
    if(notice) notice.style.display = 'block';
    return;
  }
  if(notice) notice.style.display = 'none';
  if(addBtn) addBtn.disabled = false;
  if(unitSel) unitSel.innerHTML = units.map(u=>`<option value="${esc(u)}">${esc(u)}</option>`).join('');
  updateTests(suf);
}

// Cascades the Test select to match the currently selected Unit, same as
// accession's updateTests()
function updateTests(suf){
  const unit  = document.getElementById(`c_unit${suf}`)?.value;
  const tests = testDefinitionsByUnit[unit] || [];
  const testSel = document.getElementById(`c_test${suf}`);
  if(testSel) testSel.innerHTML = tests.map(t=>`<option value="${esc(t)}">${esc(t)}</option>`).join('');
}

// Reads both selects, dedupes against the group's cart, and pushes — same
// shape/behaviour as accession's addTest()
function addTestForGroup(suf, arr, containerId){
  const unit = document.getElementById(`c_unit${suf}`)?.value;
  const test = document.getElementById(`c_test${suf}`)?.value;
  if(!unit || !test) return;
  const key = `${unit}||${test}`;
  if(arr.some(s=>s.id===key)){ showError('Test already added'); return; }
  arr.push({ id:key, name:test, unit_name:unit });
  renderSelectedTags(arr, containerId);
}

function renderSelectedTags(arr, containerId){
  const el = document.getElementById(containerId);
  if(!el) return;
  if(!arr.length){
    el.innerHTML = '<span style="color:var(--muted);font-size:0.8rem;">No tests added yet.</span>';
    return;
  }
  el.innerHTML = arr.map(t=>`
    <div class="test-tag">${t.unit_name?`${esc(t.unit_name)}: `:''}${esc(t.name)}
      <button data-key="${esc(t.id)}" title="Remove">✕</button>
    </div>`).join('');
  el.querySelectorAll('button').forEach(btn=>{
    btn.addEventListener('click',()=>{
      const key = btn.dataset.key;
      const idx = arr.findIndex(s=>s.id===key);
      if(idx>-1) arr.splice(idx,1);
      renderSelectedTags(arr, containerId);
    });
  });
}

// ============================================================
// WARDS (real wards table — feeds admit_patient() ward_id)
// ============================================================
async function loadWards(){
  if(allWards.length>0){ populateWardSelects(); return; }
  const { data, error } = await client.from('wards')
    .select('id,ward_name,department')
    .eq('is_active', true)
    .order('ward_name',{ascending:true});
  if(error){
    console.error(error);
    ['c_ward','c_ward3'].forEach(id=>{ const sel=document.getElementById(id); if(sel) sel.innerHTML='<option value="">Failed to load wards</option>'; });
    return;
  }
  allWards = data||[];
  populateWardSelects();
  refreshBedAvailability();
}

// Live bed counts, pulled straight from the `beds` table rather than the
// static wards.bed_count column (which is only set on ward creation / bed
// add and never recalculated — it drifts from reality as beds are
// occupied/freed/deactivated). Bug found 2026-07-04: doctors were picking
// a ward with zero visibility into whether any bed was actually free.
let bedAvailabilityByWard = {}; // ward_id -> {total, free}
async function refreshBedAvailability(){
  const { data, error } = await client.from('beds').select('ward_id,status');
  if(error){ console.error('refreshBedAvailability failed:', error); return; }
  const map = {};
  (data||[]).forEach(b=>{
    if(!map[b.ward_id]) map[b.ward_id] = {total:0, free:0};
    map[b.ward_id].total++;
    if(b.status==='available') map[b.ward_id].free++;
  });
  bedAvailabilityByWard = map;
  populateWardSelects();
}

function populateWardSelects(){
  const opts = allWards.length===0
    ? '<option value="">No active wards found</option>'
    : '<option value="">Select ward...</option>' +
      allWards.map(w=>{
        const avail = bedAvailabilityByWard[w.id];
        const bedLabel = avail ? ` (${avail.free}/${avail.total} beds free)` : '';
        const full = avail && avail.free===0;
        return `<option value="${w.id}"${full?' style="color:#ff6b6b;"':''}>${esc(w.ward_name)}${w.department?` — ${esc(w.department)}`:''}${bedLabel}${full?' — FULL':''}</option>`;
      }).join('');
  ['c_ward','c_ward3'].forEach(id=>{ const sel=document.getElementById(id); if(sel) sel.innerHTML=opts; });
}

[
  ['', selectedTests, 'selectedTests'],
  ['2', selectedTests2, 'selectedTests2'],
  ['3', selectedTests3, 'selectedTests3']
].forEach(([suf, arr, containerId])=>{
  document.getElementById(`c_unit${suf}`)?.addEventListener('change', ()=>updateTests(suf));
  document.getElementById(`addTestBtn${suf}`)?.addEventListener('click', ()=>addTestForGroup(suf, arr, containerId));
  document.getElementById(`c_test${suf}`)?.addEventListener('keydown', e=>{ if(e.key==='Enter'){ e.preventDefault(); addTestForGroup(suf, arr, containerId); } });
  renderSelectedTags(arr, containerId); // shows "No tests added yet." on load
});

// ============================================================
// DRUG PICKER — searchable dropdown against drug_inventory, replaces
// free-text prescriptions with a structured pick + dose/frequency/
// duration list. Serializes into the hidden textarea the existing
// submit logic already reads from, so submit_consultation is unchanged.
// ============================================================
let allDrugs = [];
let drugLoadError = null;
const rxPickerResets = [];
async function loadDrugInventory(){
  if(allDrugs.length>0) return;
  const { data, error } = await client.from('drug_inventory')
    .select('id,drug_name,generic_name,category,dosage_form,strength,unit,quantity_in_stock,is_active')
    .eq('is_active', true)
    .order('drug_name');
  if(error){
    console.error('loadDrugInventory failed:', error);
    drugLoadError = error.message || 'Failed to load drug list.';
    allDrugs=[];
    return;
  }
  drugLoadError = null;
  allDrugs = data||[];
}

function initRxPicker(picker){
  const categorySel = picker.querySelector('.rx-category');
  const medtypeSel = picker.querySelector('.rx-medtype');
  const drugSel = picker.querySelector('.rx-drug-select');
  const quickSearch = picker.querySelector('.rx-drug-quicksearch');
  const doseInput = picker.querySelector('.rx-dose');
  const freqInput = picker.querySelector('.rx-frequency');
  const durInput = picker.querySelector('.rx-duration');
  const addBtn = picker.querySelector('.rx-add-btn');
  const emptyNotice = picker.querySelector('.rx-empty-notice');
  const listEl = picker.querySelector('.rx-selected-list');
  const suffix = picker.dataset.suffix;
  const hiddenField = document.getElementById(`c_prescription${suffix}`);

  let rxItems = []; // { drugName, dose, frequency, duration }

  function currentFiltered(){
    const cat = categorySel.value;
    const type = medtypeSel.value;
    const q = quickSearch.value.trim().toLowerCase();
    return allDrugs.filter(d =>
      (!cat || d.category === cat) &&
      (!type || d.dosage_form === type) &&
      (!q || d.drug_name.toLowerCase().includes(q) || (d.generic_name||'').toLowerCase().includes(q))
    );
  }

  function populateCategoryAndType(){
    if(allDrugs.length===0){
      emptyNotice.textContent = drugLoadError
        ? `⚠️ Could not load drug list: ${drugLoadError}`
        : 'No drugs found in pharmacy inventory — contact pharmacy admin.';
      emptyNotice.style.display='block';
      return;
    }
    emptyNotice.style.display='none';
    const cats = [...new Set(allDrugs.map(d=>d.category).filter(Boolean))].sort();
    const types = [...new Set(allDrugs.map(d=>d.dosage_form).filter(Boolean))].sort();
    categorySel.innerHTML = '<option value="">All Categories</option>' + cats.map(c=>`<option value="${esc(c)}">${esc(c)}</option>`).join('');
    medtypeSel.innerHTML = '<option value="">All Types</option>' + types.map(t=>`<option value="${esc(t)}">${esc(t)}</option>`).join('');
    populateDrugSelect();
  }

  function populateDrugSelect(){
    const filtered = currentFiltered();
    if(filtered.length===0){
      drugSel.innerHTML = '<option value="">No drugs match filter</option>';
      addBtn.disabled = true;
      return;
    }
    drugSel.innerHTML = '<option value="">Select drug...</option>' + filtered.map(d=>{
      const low = d.quantity_in_stock<=0;
      return `<option value="${d.id}"${low?' disabled':''}>${esc(d.drug_name)}${d.strength?' — '+esc(d.strength):''}${low?' (OUT OF STOCK)':''}</option>`;
    }).join('');
    addBtn.disabled = true;
  }

  categorySel.addEventListener('change', populateDrugSelect);
  medtypeSel.addEventListener('change', populateDrugSelect);
  quickSearch.addEventListener('input', populateDrugSelect);
  drugSel.addEventListener('change', ()=>{
    const drug = allDrugs.find(d=>String(d.id)===drugSel.value);
    addBtn.disabled = !drug;
    if(drug && drug.strength && !doseInput.value) doseInput.value = drug.strength;
  });

  addBtn.addEventListener('click', ()=>{
    const drug = allDrugs.find(d=>String(d.id)===drugSel.value);
    if(!drug) return;
    rxItems.push({
      drugName: `${drug.drug_name}${drug.strength?' '+drug.strength:''}`,
      dose: doseInput.value.trim(),
      frequency: freqInput.value.trim(),
      duration: durInput.value.trim()
    });
    drugSel.value=''; doseInput.value=''; freqInput.value=''; durInput.value='';
    addBtn.disabled=true;
    renderRxList();
  });

  function renderRxList(){
    if(rxItems.length===0){
      listEl.innerHTML = '<span style="color:var(--muted);font-size:0.8rem;">No drugs added yet.</span>';
    } else {
      listEl.innerHTML = rxItems.map((item,i)=>{
        const parts = [item.dose, item.frequency, item.duration].filter(Boolean).join(' · ');
        return `<div class="test-tag">${esc(item.drugName)}${parts?` (${esc(parts)})`:''}
          <button data-idx="${i}" title="Remove">✕</button></div>`;
      }).join('');
      listEl.querySelectorAll('button').forEach(btn=>{
        btn.addEventListener('click',()=>{
          rxItems.splice(parseInt(btn.dataset.idx),1);
          renderRxList();
        });
      });
    }
    hiddenField.value = rxItems.map(item=>{
      const parts = [item.dose, item.frequency, item.duration].filter(Boolean).join(' ');
      return parts ? `${item.drugName} ${parts}` : item.drugName;
    }).join('\n');
  }
  renderRxList();

  rxPickerResets.push(()=>{
    rxItems.length = 0;
    doseInput.value=''; freqInput.value=''; durInput.value=''; quickSearch.value='';
    drugSel.value=''; addBtn.disabled=true;
    renderRxList();
  });

  // Populate immediately if drugs are already loaded, else wait for load to finish
  if(allDrugs.length>0) populateCategoryAndType();
  else loadDrugInventory().then(populateCategoryAndType);
}

document.querySelectorAll('.rx-picker').forEach(initRxPicker);
loadDrugInventory();

// ============================================================
// LAB REQUEST SLIP — printable PDF, mirrors accession's unit grouping
// but with NO prices. Patient carries this to the lab window instead
// of the system pushing the order electronically.
// ============================================================
function generateLabRequestSlip(tests, meta){
  if(!tests || tests.length===0) return;
  if(!window.jspdf || !window.jspdf.jsPDF){ console.error('jsPDF not loaded'); return; }
  const { jsPDF } = window.jspdf;
  const doc   = new jsPDF({ unit:'mm', format:'a5' });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  let y = 14;

  function checkPage(minSpace){
    if(y > pageH - minSpace){ doc.addPage(); y = 14; }
  }

  doc.setFont('helvetica','bold'); doc.setFontSize(13);
  doc.text("MU'UJIZA DIAGNOSTICS", pageW/2, y, { align:'center' }); y+=6;
  doc.setFont('helvetica','normal'); doc.setFontSize(9);
  doc.text('Laboratory Request Slip', pageW/2, y, { align:'center' }); y+=3;
  doc.setDrawColor(180); doc.line(10,y,pageW-10,y); y+=6;

  doc.setFontSize(9.5);
  function row(label, value){
    checkPage(20);
    doc.setFont('helvetica','bold'); doc.text(`${label}:`, 10, y);
    doc.setFont('helvetica','normal');
    const lines = doc.splitTextToSize(String(value||'—'), pageW-42);
    doc.text(lines, 40, y);
    y += 5*lines.length;
  }
  row('Patient', meta.patientName);
  row('Sex', meta.gender);
  row('Hospital No.', meta.hospitalNumber);
  row('Diagnosis / Impression', meta.diagnosis);
  row('Ordering Doctor', meta.doctorName);
  row('Urgency', (meta.urgency||'routine').toUpperCase());
  row('Date', meta.date);

  y += 2;
  doc.setDrawColor(180); doc.line(10,y,pageW-10,y); y+=6;

  doc.setFont('helvetica','bold'); doc.setFontSize(10.5);
  doc.text('Tests Requested', 10, y); y+=6;

  // Group by unit — same grouping accession uses, minus pricing
  const byUnit = {};
  tests.forEach(t=>{
    const u = t.unit_name || 'General';
    if(!byUnit[u]) byUnit[u]=[];
    byUnit[u].push(t.name);
  });

  doc.setFontSize(9.5);
  Object.entries(byUnit).forEach(([unit, names])=>{
    checkPage(15);
    doc.setFont('helvetica','bold');
    doc.text(unit.toUpperCase(), 10, y); y+=5;
    doc.setFont('helvetica','normal');
    names.forEach(n=>{
      checkPage(10);
      const lines = doc.splitTextToSize(`•  ${n}`, pageW-24);
      doc.text(lines, 14, y);
      y += 5*lines.length;
    });
    y+=1;
  });

  y += 3;
  checkPage(20);
  doc.setDrawColor(180); doc.line(10,y,pageW-10,y); y+=6;
  doc.setFont('helvetica','italic'); doc.setFontSize(8);
  doc.text('Present this slip at the laboratory reception window.', 10, y); y+=4;
  doc.text('No fees are shown here — payment is processed at accession.', 10, y);

  const safeHosp = String(meta.hospitalNumber||'patient').replace(/[^a-zA-Z0-9-]/g,'');
  doc.save(`lab-request-${safeHosp}-${new Date().toISOString().slice(0,10)}.pdf`);
}

// ============================================================
// SUBMIT CONSULTATION
// ============================================================
document.getElementById('submitConsultBtn').addEventListener('click', async()=>{
  clearMsgs();
  if(!selectedVisit)     return showError('No patient selected.');
  if(!sv('c_complaint')) return showError('Presenting complaint is required.');
  if(!sv('c_diagnosis')) return showError('Diagnosis / clinical impression is required.');
  if(!selectedAction)    return showError('Please select a plan (action).');

  // Action-specific validation
  if(selectedAction==='admit' && !sv('c_ward'))             return showError('Ward is required for admission.');
  if(selectedAction==='admit_and_lab' && !sv('c_ward3'))    return showError('Ward is required for admission.');
  if(selectedAction==='refer' && !sv('c_refer_to'))         return showError('Specify where to refer.');
  if((selectedAction==='lab_request'||selectedAction==='lab_and_discharge') && selectedTests.length===0 && selectedTests2.length===0)
    return showError('Select at least one lab test.');
  if(selectedAction==='admit_and_lab' && selectedTests3.length===0)
    return showError('Select at least one lab test.');

  const btn=document.getElementById('submitConsultBtn');
  btn.disabled=true; btn.textContent='Submitting...';

  // Determine which test/urgency/notes set to use for this action
  let testsToSend, labUrgency, labNotes;
  if(selectedAction==='lab_and_discharge'){
    testsToSend = selectedTests2; labUrgency = sv('c_lab_urgency2'); labNotes = sv('c_lab_notes2');
  } else if(selectedAction==='admit_and_lab'){
    testsToSend = selectedTests3; labUrgency = sv('c_lab_urgency3'); labNotes = sv('c_lab_notes3');
  } else {
    testsToSend = selectedTests; labUrgency = sv('c_lab_urgency'); labNotes = sv('c_lab_notes');
  }

  const prescription =
    selectedAction==='lab_request'       ? sv('c_prescription1') :
    selectedAction==='lab_and_discharge' ? sv('c_prescription2') :
    selectedAction==='admit_and_lab'     ? sv('c_prescription3') :
    selectedAction==='admit'             ? sv('c_prescription4') :
    sv('c_prescription');

  // Admission fields — admit_and_lab uses the suffix-3 fields, admit uses the original ones
  const admitWardId  = selectedAction==='admit_and_lab' ? sv('c_ward3')        : sv('c_ward');
  const admitDiag    = selectedAction==='admit_and_lab' ? sv('c_admit_diag3') : sv('c_admit_diag');
  const admitOrders  = selectedAction==='admit_and_lab' ? sv('c_admit_orders3') : sv('c_admit_orders');

  // Admit/Admit+Lab now have their own structured prescription (drug picker),
  // so the free-text admission orders go into "instructions" instead of being
  // smuggled into p_prescription as before.
  const instructions =
    selectedAction==='lab_request'       ? sv('c_instructions1') :
    selectedAction==='lab_and_discharge' ? sv('c_instructions2') :
    (selectedAction==='admit'||selectedAction==='admit_and_lab') ? admitOrders :
    sv('c_instructions');

  try{
    const { data, error } = await client.rpc('submit_consultation',{
      p_token:                session.token,
      p_visit_id:             selectedVisit.id,
      p_presenting_complaint: sv('c_complaint'),
      p_history_of_illness:   sv('c_hpi'),
      p_past_medical_history: sv('c_pmh'),
      p_current_medications:  sv('c_meds'),
      p_allergy_note:         sv('c_allergy'),
      p_general_examination:  sv('c_gen_exam'),
      p_systemic_examination: sv('c_sys_exam'),
      p_diagnosis:            sv('c_diagnosis'),
      p_icd10_code:           sv('c_icd10'),
      p_action_type:          selectedAction,
      p_prescription:         prescription || null,
      p_instructions:         instructions,
      p_admit_ward:           allWards.find(w=>w.id===admitWardId)?.ward_name || admitWardId,
      p_admit_diagnosis:      admitDiag,
      p_refer_to:             sv('c_refer_to'),
      p_refer_reason:         sv('c_refer_reason'),
      p_doctor_note:          sv('c_doctor_note'),
      p_lab_urgency:          labUrgency||'routine',
      p_lab_clinical_notes:   labNotes,
      p_lab_test_ids:         null, // test_definitions has no real id column in this schema (see note below)
      p_lab_test_names:       testsToSend.length>0 ? testsToSend.map(t=>t.name) : null
    });

    if(error) throw error;
    const r=Array.isArray(data)?data[0]:data;
    if(!r?.success) throw new Error(r?.message||'Failed to submit.');

    // Printable lab request slip (no prices) — patient carries this to the
    // lab window instead of the system pushing the order there electronically.
    if(['lab_request','lab_and_discharge','admit_and_lab'].includes(selectedAction) && testsToSend.length>0){
      try{
        const p = selectedPatient;
        generateLabRequestSlip(testsToSend, {
          patientName:     p?`${p.surname||''} ${p.first_name||''}`.trim():'Unknown',
          gender:          p?.gender,
          hospitalNumber:  selectedVisit.hospital_number,
          diagnosis:       sv('c_diagnosis'),
          doctorName:      session.name||session.username,
          urgency:         labUrgency,
          date:            new Date().toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'})
        });
      }catch(pdfErr){ console.error('Lab request slip PDF failed:', pdfErr); }
    }

    let actionLabel={
      opd_discharge:'Patient discharged.',
      lab_request:'Lab tests ordered. Patient retained pending results.',
      lab_and_discharge:'Lab tests ordered and patient discharged.',
      admit:'Patient admitted to ward.',
      admit_and_lab:'Patient admitted to ward and lab tests ordered.',
      refer:'Referral issued.',
      observation:'Patient placed under observation.'
    }[selectedAction]||'Consultation submitted.';

    // Consultation is saved at this point regardless of what happens below.
    // For 'admit', now actually create the admission (real wards/beds row) —
    // second call, same two-call pattern used elsewhere in the system.
    if(selectedAction==='admit'||selectedAction==='admit_and_lab'){
      const labSuffix = selectedAction==='admit_and_lab' ? ' Lab tests were still saved to this consultation.' : '';
      if(!selectedPatient?.id){
        showSuccess(`✅ Consultation saved, but admission was NOT created — patient record has no linked patient_registry id. Please admit this patient manually via the ward module.${labSuffix}`);
        resetForm(); selectedVisit=null; selectedPatient=null;
        document.getElementById('placeholder').style.display='flex';
        document.getElementById('consultContent').classList.remove('show');
        await loadQueue();
        return;
      }
      try{
        const { data: admitData, error: admitError } = await client.rpc('admit_patient',{
          p_token:                session.token,
          p_consultation_id:      r.consultation_id,
          p_hospital_number:      selectedVisit.hospital_number,
          p_patient_id:           selectedPatient.id,
          p_ward_id:              admitWardId,
          p_admitting_doctor:     session.name||session.username,
          p_admission_diagnosis:  admitDiag || sv('c_diagnosis'),
          p_allergy_note:         sv('c_allergy')
        });
        if(admitError) throw admitError;
        const ar=Array.isArray(admitData)?admitData[0]:admitData;
        if(!ar?.success){
          showSuccess(`✅ Consultation saved, but admission failed: ${ar?.message||'unknown error'}. Please admit this patient manually via the ward module (consultation ID: ${r.consultation_id}).${labSuffix}`);
          resetForm(); selectedVisit=null; selectedPatient=null;
          document.getElementById('placeholder').style.display='flex';
          document.getElementById('consultContent').classList.remove('show');
          await loadQueue();
          return;
        }
        const labNote = selectedAction==='admit_and_lab' ? ' Lab tests ordered.' : '';
        actionLabel = ar.bed_assigned
          ? `Patient admitted to ward — bed assigned.${labNote}`
          : `Patient admitted — no bed free yet, queued as pending bed assignment.${labNote}`;
      }catch(admitErr){
        showSuccess(`✅ Consultation saved, but admission failed: ${admitErr.message||admitErr}. Please admit this patient manually via the ward module (consultation ID: ${r.consultation_id}).${labSuffix}`);
        resetForm(); selectedVisit=null; selectedPatient=null;
        document.getElementById('placeholder').style.display='flex';
        document.getElementById('consultContent').classList.remove('show');
        await loadQueue();
        return;
      }
    }

    showSuccess(`✅ ${actionLabel} Consultation saved.`);
    resetForm();
    selectedVisit=null;
    selectedPatient=null;
    document.getElementById('placeholder').style.display='flex';
    document.getElementById('consultContent').classList.remove('show');
    await loadQueue();

  }catch(err){
    showError(err.message||'Failed to submit consultation.');
  }finally{
    btn.disabled=false; btn.textContent='Submit Consultation';
  }
});

function resetForm(){
  ['c_complaint','c_hpi','c_pmh','c_meds','c_allergy','c_gen_exam','c_sys_exam',
   'c_diagnosis','c_icd10','c_prescription','c_instructions','c_ward','c_admit_diag',
   'c_admit_orders','c_refer_to','c_refer_reason','c_doctor_note','c_prescription2',
   'c_instructions2','c_lab_notes','c_lab_notes2','c_doctor_note',
   'c_ward3','c_admit_diag3','c_admit_orders3','c_lab_urgency3','c_lab_notes3',
   'c_prescription3','c_prescription4','c_prescription1','c_instructions1']
    .forEach(id=>{ const el=document.getElementById(id); if(el) el.value=''; });
  rxPickerResets.forEach(fn=>fn());
  document.querySelectorAll('.action-btn').forEach(b=>b.classList.remove('selected'));
  document.querySelectorAll('.action-fields').forEach(f=>f.classList.remove('show'));
  selectedAction=null;
  selectedTests.length=0; selectedTests2.length=0; selectedTests3.length=0;
  document.getElementById('selectedTests').innerHTML='';
  document.getElementById('selectedTests2').innerHTML='';
  document.getElementById('selectedTests3').innerHTML='';
  document.getElementById('vitalsGrid').innerHTML='';
  document.getElementById('demoGrid').innerHTML='';
  document.getElementById('nurseNotes').innerHTML='';
  document.getElementById('abnormalBanner').classList.remove('show');
  document.getElementById('historyList').innerHTML='';
}

document.getElementById('clearConsultBtn').addEventListener('click',()=>{ clearMsgs(); resetForm(); if(selectedVisit){ loadVitals(selectedVisit); renderDemographics(selectedVisit); } });

// Init
loadQueue();
loadWards();
setInterval(loadQueue, 30000);

// ============================================================
// WARD ROUNDS — lets the doctor see currently admitted patients
// and discharge them, freeing the bed. This is the missing half of
// the discharge workflow: ward-queue.js (nurse) can only discharge
// when facility_mode='general'; in 'federal' mode nobody could
// discharge an admitted patient at all, so beds stayed blocked
// indefinitely. This closes that gap for both modes — a doctor can
// always discharge, regardless of facility mode.
// ============================================================
let wardRoundsAdmissions = [];
let selectedAdmission    = null;
let queueMode = 'opd'; // 'opd' | 'ward'

document.querySelectorAll('.qmode-btn').forEach(btn=>{
  btn.addEventListener('click', () => switchQueueMode(btn.dataset.qmode));
});

function switchQueueMode(mode){
  queueMode = mode;
  document.querySelectorAll('.qmode-btn').forEach(b=>b.classList.toggle('active', b.dataset.qmode===mode));
  document.getElementById('queueList').style.display      = mode==='opd'  ? '' : 'none';
  document.getElementById('wardRoundsList').style.display = mode==='ward' ? '' : 'none';

  // Hide whichever right-side panel doesn't belong to this mode, and show
  // the correct empty-state placeholder if nothing's selected yet.
  document.getElementById('consultContent').classList.remove('show');
  document.getElementById('wardRoundDetail').style.display = 'none';
  if(mode==='opd'){
    document.getElementById('wardRoundPlaceholder').style.display = 'none';
    document.getElementById('placeholder').style.display = selectedVisit ? 'none' : 'flex';
    if(selectedVisit) document.getElementById('consultContent').classList.add('show');
  } else {
    document.getElementById('placeholder').style.display = 'none';
    document.getElementById('wardRoundPlaceholder').style.display = selectedAdmission ? 'none' : 'flex';
    if(selectedAdmission) document.getElementById('wardRoundDetail').style.display = 'block';
    loadWardRounds();
  }
}

let wardRoundsPatientById = {};
function wrWardName(id){ return allWards.find(w=>w.id===id)?.ward_name || '—'; }

async function loadWardRounds(){
  // NOTE: only `beds(bed_number)` is embedded here — that's the one
  // relationship that actually works as a PostgREST embed in this schema.
  // `wards` and `patient_registry` are NOT fetched as embeds (there's no
  // usable FK path for PostgREST to auto-join them, same reason
  // ward-queue.js fetches patient_registry as its own separate query and
  // resolves ward names from a locally-loaded wards list instead of
  // embedding). Embedding them here silently failed the whole query.
  const { data, error } = await client.from('admissions')
    .select('id,patient_id,hospital_number,ward_id,bed_id,admitting_doctor,admission_diagnosis,allergy_note,status,admitted_at,beds(bed_number)')
    .eq('status','admitted')
    .order('admitted_at',{ascending:true});

  if(error){
    console.error('[DC] loadWardRounds failed', error);
    document.getElementById('wardRoundsList').innerHTML =
      `<div class="empty-queue" style="color:var(--error);">Failed to load ward rounds — ${esc(error.message)}</div>`;
    return;
  }
  wardRoundsAdmissions = data || [];

  // Batch-fetch patient demographics separately, same as ward-queue.js's
  // per-admission patient_registry fetch, just batched for the list view.
  const patientIds = [...new Set(wardRoundsAdmissions.map(a=>a.patient_id).filter(Boolean))];
  wardRoundsPatientById = {};
  if(patientIds.length){
    const { data: patients, error: pErr } = await client.from('patient_registry')
      .select('id,surname,first_name,middle_name,gender,date_of_birth,age')
      .in('id', patientIds);
    if(pErr) console.error('[DC] ward rounds patient lookup failed', pErr);
    else (patients||[]).forEach(p=>{ wardRoundsPatientById[p.id] = p; });
  }

  document.getElementById('wardRoundsCount').textContent = wardRoundsAdmissions.length;
  renderWardRoundsList();
}

function renderWardRoundsList(){
  const filter = document.getElementById('queueFilter').value.toLowerCase();
  const list = document.getElementById('wardRoundsList');
  const items = wardRoundsAdmissions.filter(a=>{
    const p = wardRoundsPatientById[a.patient_id];
    const name = `${p?.surname||''} ${p?.first_name||''}`.toLowerCase();
    return !filter || name.includes(filter) || a.hospital_number.toLowerCase().includes(filter);
  });

  if(items.length===0){ list.innerHTML = `<div class="empty-queue">No admitted patients</div>`; return; }

  list.innerHTML = items.map(a=>{
    const p = wardRoundsPatientById[a.patient_id];
    const name = p ? [p.surname,p.first_name].filter(Boolean).join(' ') : a.hospital_number;
    const age = p?.date_of_birth ? `${Math.floor((Date.now()-new Date(p.date_of_birth))/(365.25*86400000))}y` : (p?.age?`${p.age}y`:'');
    return `<div class="queue-item ${selectedAdmission?.id===a.id?'selected':''}" data-id="${a.id}">
      <div class="qi-name">${esc(name)}</div>
      <div class="qi-meta">
        <span>${esc(a.hospital_number)}</span>
        ${age?`<span>${age}</span>`:''}
        <span>🛏️ ${esc(wrWardName(a.ward_id))} · ${esc(a.beds?.bed_number)}</span>
      </div>
    </div>`;
  }).join('');

  list.querySelectorAll('.queue-item').forEach(el=>{
    el.addEventListener('click', () => {
      const a = items.find(x=>x.id===el.dataset.id);
      if(a) selectWardRound(a);
    });
  });
}

async function selectWardRound(a){
  selectedAdmission = a;
  clearWrMsgs();
  renderWardRoundsList();

  document.getElementById('wardRoundPlaceholder').style.display = 'none';
  document.getElementById('wardRoundDetail').style.display = 'block';

  const p = wardRoundsPatientById[a.patient_id];
  const name = p ? [p.surname,p.first_name].filter(Boolean).join(' ') : a.hospital_number;
  const age = p?.date_of_birth ? `${Math.floor((Date.now()-new Date(p.date_of_birth))/(365.25*86400000))}y` : (p?.age?`${p.age}y`:'—');
  document.getElementById('wrPatientHeader').innerHTML = `
    <div style="font-size:1.1rem;font-weight:700;">${esc(name)} — ${esc(a.hospital_number)}</div>
    <div style="font-size:0.82rem;color:var(--muted);margin-top:3px;">
      ${p?.gender||'—'} &nbsp;|&nbsp; ${age} &nbsp;|&nbsp;
      🛏️ ${esc(wrWardName(a.ward_id))} · Bed ${esc(a.beds?.bed_number)} &nbsp;|&nbsp;
      Admitting Dr: ${esc(a.admitting_doctor)}
    </div>
    <div style="font-size:0.82rem;margin-top:6px;">🔍 ${esc(a.admission_diagnosis)}</div>
    ${a.allergy_note ? `<div style="margin-top:8px;background:rgba(255,107,107,0.1);border:1px solid var(--error);color:var(--error);border-radius:8px;padding:8px 10px;font-size:0.8rem;">⚠️ Known allergy: ${esc(a.allergy_note)}</div>` : ''}
  `;

  document.getElementById('wr_discharge_summary').value = '';

  const ordersList = document.getElementById('wrOrdersList');
  ordersList.innerHTML = 'Loading orders...';
  const { data, error } = await client.from('doctor_orders')
    .select('order_type,order_text,status,created_at')
    .eq('admission_id', a.id)
    .order('created_at',{ascending:false});
  if(error || !data || data.length===0){ ordersList.innerHTML = `<div style="color:var(--muted);">No orders charted yet.</div>`; return; }
  ordersList.innerHTML = data.map(o=>`
    <div style="background:var(--field,#1e2538);border:1px solid var(--border);border-radius:8px;padding:8px 10px;margin-bottom:6px;">
      <div style="font-size:0.7rem;color:var(--muted);text-transform:uppercase;">${esc(o.order_type)} · ${new Date(o.created_at).toLocaleString('en-NG',{dateStyle:'medium',timeStyle:'short'})}</div>
      <div>${esc(o.order_text)}${o.status==='discontinued'?' <i style="color:var(--error)">(discontinued)</i>':''}</div>
    </div>`).join('');
}

function clearWrMsgs(){
  document.getElementById('wrErrorMsg').classList.remove('show');
  document.getElementById('wrSuccessMsg').classList.remove('show');
}
function wrShowError(m){ clearWrMsgs(); const el=document.getElementById('wrErrorMsg'); el.textContent=m; el.classList.add('show'); }
function wrShowSuccess(m){ clearWrMsgs(); const el=document.getElementById('wrSuccessMsg'); el.textContent=m; el.classList.add('show'); }

document.getElementById('wrDischargeBtn').addEventListener('click', async () => {
  if(!selectedAdmission) return;
  if(!confirm(`Discharge ${selectedAdmission.hospital_number}? This frees Bed ${selectedAdmission.beds?.bed_number||''} and ends the admission.`)) return;

  const btn = document.getElementById('wrDischargeBtn');
  btn.disabled = true; btn.textContent = 'Discharging...';
  try{
    const { data, error } = await client.rpc('ward_nurse_action', {
      p_token:              session.token,
      p_admission_id:       selectedAdmission.id,
      p_action_type:        'discharge',
      p_discharge_summary:  document.getElementById('wr_discharge_summary').value.trim() || null
    });
    if(error) throw error;
    const r = Array.isArray(data) ? data[0] : data;
    if(!r?.success) throw new Error(r?.message || 'Discharge failed.');

    wrShowSuccess(`✅ ${r.message || 'Patient discharged. Bed freed.'}`);
    selectedAdmission = null;
    document.getElementById('wardRoundDetail').style.display = 'none';
    document.getElementById('wardRoundPlaceholder').style.display = 'flex';
    await loadWardRounds();
  }catch(err){
    wrShowError(err.message || 'Discharge failed.');
  }finally{
    btn.disabled = false; btn.textContent = '🏠 Discharge & Free Bed';
  }
});

// Ward Rounds list should also respond to the same filter box as OPD queue
document.getElementById('queueFilter').addEventListener('input', () => {
  if(queueMode==='ward') renderWardRoundsList();
});
