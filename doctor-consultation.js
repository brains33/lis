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
let selectedTests    = [];   // { id, name } for lab
let selectedTests2   = [];   // for lab_and_discharge
let allTestDefs      = [];
let selectedAction   = null;

// ============================================================
// QUEUE
// ============================================================
async function loadQueue(){
  const today = new Date().toISOString().split('T')[0];
  const { data, error } = await client.from('opd_visits')
    .select(`id,hospital_number,status,triage_category,chief_complaint,assigned_doctor,queued_at,
             patient_registry(surname,first_name,gender,date_of_birth,age,blood_group,genotype,phone,address,occupation,state_of_origin,nin)`)
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
    </div>`).join('');
}

// ============================================================
// TAB SWITCHING
// ============================================================
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
async function loadTestDefs(){
  if(allTestDefs.length>0) return; // already loaded
  const { data } = await client.from('test_definitions')
    .select('id,name,area_id,areas(name)')
    .order('name',{ascending:true});
  allTestDefs = data||[];
  renderTestList('testList','testSearch',selectedTests,'selectedTests');
  renderTestList('testList2','testSearch2',selectedTests2,'selectedTests2');
}

function renderTestList(listId, searchId, selectedArr, selectedContainerId){
  const search = document.getElementById(searchId)?.value?.toLowerCase()||'';
  const list   = document.getElementById(listId);
  const filtered = allTestDefs.filter(t=>!search||t.name.toLowerCase().includes(search));
  if(filtered.length===0){ list.innerHTML=`<div style="padding:10px;color:var(--muted);font-size:0.82rem;">No tests found.</div>`; return; }
  list.innerHTML = filtered.map(t=>{
    const checked = selectedArr.some(s=>s.id===t.id);
    const area    = t.areas?.name||'';
    return `<div class="test-item">
      <input type="checkbox" data-id="${t.id}" data-name="${esc(t.name)}" ${checked?'checked':''}>
      <span>${esc(t.name)}</span>${area?`<span style="color:var(--muted);font-size:0.72rem;margin-left:auto;">${esc(area)}</span>`:''}
    </div>`;
  }).join('');

  list.querySelectorAll('input[type=checkbox]').forEach(cb=>{
    cb.addEventListener('change',()=>{
      const id=parseInt(cb.dataset.id), name=cb.dataset.name;
      if(cb.checked){
        if(!selectedArr.some(s=>s.id===id)) selectedArr.push({id,name});
      } else {
        const idx=selectedArr.findIndex(s=>s.id===id);
        if(idx>-1) selectedArr.splice(idx,1);
      }
      renderSelectedTags(selectedArr, selectedContainerId, listId, searchId);
    });
  });
}

function renderSelectedTags(arr, containerId, listId, searchId){
  const el=document.getElementById(containerId);
  el.innerHTML = arr.map(t=>`
    <div class="test-tag">${esc(t.name)}
      <button data-id="${t.id}" title="Remove">✕</button>
    </div>`).join('');
  el.querySelectorAll('button').forEach(btn=>{
    btn.addEventListener('click',()=>{
      const id=parseInt(btn.dataset.id);
      const idx=arr.findIndex(s=>s.id===id);
      if(idx>-1) arr.splice(idx,1);
      renderSelectedTags(arr, containerId, listId, searchId);
      renderTestList(listId, searchId, arr, containerId);
    });
  });
}

['testSearch','testSearch2'].forEach((id,i)=>{
  document.getElementById(id)?.addEventListener('input',()=>{
    if(i===0) renderTestList('testList','testSearch',selectedTests,'selectedTests');
    else      renderTestList('testList2','testSearch2',selectedTests2,'selectedTests2');
  });
});

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
  if(selectedAction==='admit' && !sv('c_ward'))     return showError('Ward is required for admission.');
  if(selectedAction==='refer' && !sv('c_refer_to')) return showError('Specify where to refer.');
  if((selectedAction==='lab_request'||selectedAction==='lab_and_discharge') && selectedTests.length===0 && selectedTests2.length===0)
    return showError('Select at least one lab test.');

  const btn=document.getElementById('submitConsultBtn');
  btn.disabled=true; btn.textContent='Submitting...';

  // Determine which test array to use
  const testsToSend = selectedAction==='lab_and_discharge' ? selectedTests2 : selectedTests;
  const labUrgency  = selectedAction==='lab_and_discharge' ? sv('c_lab_urgency2') : sv('c_lab_urgency');
  const labNotes    = selectedAction==='lab_and_discharge' ? sv('c_lab_notes2')   : sv('c_lab_notes');
  const prescription   = selectedAction==='lab_and_discharge' ? sv('c_prescription2') : sv('c_prescription');
  const instructions   = selectedAction==='lab_and_discharge' ? sv('c_instructions2') : sv('c_instructions');
  const admitOrders    = sv('c_admit_orders');

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
      p_prescription:         prescription || (selectedAction==='admit'?admitOrders:null),
      p_instructions:         instructions,
      p_admit_ward:           sv('c_ward'),
      p_admit_diagnosis:      sv('c_admit_diag'),
      p_refer_to:             sv('c_refer_to'),
      p_refer_reason:         sv('c_refer_reason'),
      p_doctor_note:          sv('c_doctor_note'),
      p_lab_urgency:          labUrgency||'routine',
      p_lab_clinical_notes:   labNotes,
      p_lab_test_ids:         testsToSend.length>0 ? testsToSend.map(t=>t.id) : null,
      p_lab_test_names:       testsToSend.length>0 ? testsToSend.map(t=>t.name) : null
    });

    if(error) throw error;
    const r=Array.isArray(data)?data[0]:data;
    if(!r?.success) throw new Error(r?.message||'Failed to submit.');

    const actionLabel={
      opd_discharge:'Patient discharged.',
      lab_request:'Lab tests ordered. Patient retained pending results.',
      lab_and_discharge:'Lab tests ordered and patient discharged.',
      admit:'Patient admitted to ward.',
      refer:'Referral issued.',
      observation:'Patient placed under observation.'
    }[selectedAction]||'Consultation submitted.';

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
   'c_instructions2','c_lab_notes','c_lab_notes2','c_doctor_note']
    .forEach(id=>{ const el=document.getElementById(id); if(el) el.value=''; });
  document.querySelectorAll('.action-btn').forEach(b=>b.classList.remove('selected'));
  document.querySelectorAll('.action-fields').forEach(f=>f.classList.remove('show'));
  selectedAction=null;
  selectedTests=[]; selectedTests2=[];
  document.getElementById('selectedTests').innerHTML='';
  document.getElementById('selectedTests2').innerHTML='';
  document.getElementById('vitalsGrid').innerHTML='';
  document.getElementById('demoGrid').innerHTML='';
  document.getElementById('nurseNotes').innerHTML='';
  document.getElementById('abnormalBanner').classList.remove('show');
  document.getElementById('historyList').innerHTML='';
}

document.getElementById('clearConsultBtn').addEventListener('click',()=>{ clearMsgs(); resetForm(); if(selectedVisit){ loadVitals(selectedVisit); renderDemographics(selectedVisit); } });

// Init
loadQueue();
setInterval(loadQueue, 30000);
