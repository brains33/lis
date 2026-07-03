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
  const today = new Date().toISOString().split('T')[0];
  const { data, error } = await client.from('opd_visits')
    .select(`id,hospital_number,status,triage_category,chief_complaint,assigned_doctor,queued_at,
             patient_registry(id,surname,first_name,gender,date_of_birth,age,blood_group,genotype,phone,address,occupation,state_of_origin,nin)`)
    .eq('visit_date', today)
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

function renderResultModal(sample){
  let modal = document.getElementById('drResultModal');
  if(!modal){
    modal = document.createElement('div');
    modal.id = 'drResultModal';
    modal.style.cssText = 'display:none;position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:1000;align-items:center;justify-content:center;padding:20px;';
    document.body.appendChild(modal);
  }

  const rows = (sample.sample_tests||[]).map(t=>{
    let display = t.result || '—';
    // result_json holds structured panels (e.g. multi-parameter hormonal assays);
    // fall back to flat key: value listing if present
    if(t.result_json){
      try {
        const parsed = typeof t.result_json === 'string' ? JSON.parse(t.result_json) : t.result_json;
        if(parsed && typeof parsed === 'object'){
          display = Object.entries(parsed).map(([k,v])=>`${esc(k)}: ${esc(String(v))}`).join('<br>');
        }
      } catch(e){ /* leave as plain result text */ }
    }
    return `<tr>
      <td style="padding:8px;border-bottom:1px solid var(--border);">${esc(t.test_name)}</td>
      <td style="padding:8px;border-bottom:1px solid var(--border);color:var(--muted);">${esc(t.unit_name||'')}</td>
      <td style="padding:8px;border-bottom:1px solid var(--border);">${display}</td>
    </tr>`;
  }).join('');

  modal.innerHTML = `
    <div style="background:var(--card,#1a1a2e);border-radius:12px;max-width:600px;width:100%;max-height:80vh;overflow-y:auto;padding:20px;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">
        <h3 style="margin:0;">MU-${sample.id} — Results</h3>
        <button id="drResultModalClose" style="background:none;border:none;color:var(--muted);font-size:1.4rem;cursor:pointer;">&times;</button>
      </div>
      <table style="width:100%;border-collapse:collapse;font-size:0.85rem;">
        <thead>
          <tr style="text-align:left;color:var(--muted);font-size:0.75rem;text-transform:uppercase;">
            <th style="padding:8px;">Test</th><th style="padding:8px;">Unit</th><th style="padding:8px;">Result</th>
          </tr>
        </thead>
        <tbody>${rows || '<tr><td colspan="3" style="padding:8px;color:var(--muted);">No test detail available.</td></tr>'}</tbody>
      </table>
      <div style="margin-top:14px;color:var(--muted);font-size:0.78rem;">
        For the fully formatted, printable lab report (with reference ranges), ask lab reception for a printed copy of MU-${sample.id}.
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
  const { data, error } = await client.from('test_definitions')
    .select('unit_name,test_name,price_ngn,sample_type,tube,test_type')
    .order('unit_name',{ascending:true})
    .order('test_name',{ascending:true});
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
  allTestDefs.forEach(t=>{
    if(!testDefinitionsByUnit[t.unit_name]) testDefinitionsByUnit[t.unit_name]=[];
    // Skip unit placeholder rows (inserted by management1.addUnit() so an
    // empty unit still shows up in unit lists) — same filter management1.js
    // applies in its loadTestDefinitions(). accession.js is missing this
    // filter too, but doctor-consultation should not inherit that gap.
    if(t.test_name === '__unit_placeholder__' || t.test_name.startsWith('__unit__')) return;
    testDefinitionsByUnit[t.unit_name].push(t.test_name);
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
    .select('id,ward_name,department,bed_count')
    .eq('is_active', true)
    .order('ward_name',{ascending:true});
  if(error){
    console.error(error);
    ['c_ward','c_ward3'].forEach(id=>{ const sel=document.getElementById(id); if(sel) sel.innerHTML='<option value="">Failed to load wards</option>'; });
    return;
  }
  allWards = data||[];
  populateWardSelects();
}
function populateWardSelects(){
  const opts = allWards.length===0
    ? '<option value="">No active wards found</option>'
    : '<option value="">Select ward...</option>' +
      allWards.map(w=>`<option value="${w.id}">${esc(w.ward_name)}${w.department?` — ${esc(w.department)}`:''}</option>`).join('');
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

  const prescription = selectedAction==='lab_and_discharge' ? sv('c_prescription2') : sv('c_prescription');
  const instructions  = selectedAction==='lab_and_discharge' ? sv('c_instructions2') : sv('c_instructions');

  // Admission fields — admit_and_lab uses the suffix-3 fields, admit uses the original ones
  const admitWardId  = selectedAction==='admit_and_lab' ? sv('c_ward3')        : sv('c_ward');
  const admitDiag    = selectedAction==='admit_and_lab' ? sv('c_admit_diag3') : sv('c_admit_diag');
  const admitOrders  = selectedAction==='admit_and_lab' ? sv('c_admit_orders3') : sv('c_admit_orders');

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
      p_prescription:         prescription || ((selectedAction==='admit'||selectedAction==='admit_and_lab')?admitOrders:null),
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
   'c_ward3','c_admit_diag3','c_admit_orders3','c_lab_urgency3','c_lab_notes3']
    .forEach(id=>{ const el=document.getElementById(id); if(el) el.value=''; });
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
