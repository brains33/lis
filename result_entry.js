// ========== SUPABASE CLIENT ==========
const SUPABASE_URL      = 'https://npdopywxemtwzvpummsn.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5wZG9weXd4ZW10d3p2cHVtbXNuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk4NzY0MjksImV4cCI6MjA5NTQ1MjQyOX0.Mo5LfGdfSiHL6QHsPOaGkDmeaIRDqZTe8MGwz_6ou1c';

// ========== AUTH — checkAuth() and logoutUser() from auth-guard.js ==========
const currentSession = checkAuth(['technologist', 'admin', 'supervisor']);
const currentUser    = currentSession;

// Build token‑authenticated client once – page reloads on login/refresh, so always fresh
window._supabaseClient = window.buildAuthClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const db = window._supabaseClient;
window.db = db; // expose for offline_queue.js

// ========== HELPERS ==========
function esc(str) {
  if (str === null || str === undefined) return '';
  return String(str).replace(/[&<>"']/g, m =>
    ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m]));
}
function toast(msg, type = 'success') {
  let stack = document.getElementById('toastStack');
  if (!stack) return;
  let div = document.createElement('div');
  div.className = `toast ${type}`;
  let icon = type === 'error' ? 'times-circle' : type === 'warn' ? 'exclamation-triangle' : 'check-circle';
  div.innerHTML = `<i class="fas fa-${icon}"></i> `;
  let span = document.createElement('span');
  span.textContent = msg;
  div.appendChild(span);
  stack.appendChild(div);
  setTimeout(() => { div.style.opacity = '0'; setTimeout(() => div.remove(), 300); }, 3500);
}
function startClock() {
  function tick() {
    const clockDisplay = document.getElementById('clockDisplay');
    if (clockDisplay) clockDisplay.innerText = new Date().toLocaleTimeString('en-GB');
  }
  tick(); setInterval(tick, 1000);
}

// ========== AUDIT ==========
async function addAudit(action, sampleId, details) {
  try {
    await db.from('audit_log').insert([{
      ts: new Date().toISOString(),
      user_name: currentUser?.name || 'Unknown',
      user_role: currentUser?.role || 'Unknown',
      action: action,
      sample_id: sampleId,
      details: details || ''
    }]);
  } catch (err) { console.warn('Audit failed', err); }
}

// ========== COC HELPERS ==========
const COC_STEPS = ['Registered','Collected','Received','Processing','Result Entry','Verification','Released'];

async function loadCOCEvents(sampleId) {
  try {
    const { data, error } = await db
      .from('coc_events')
      .select('step_index, done, active')
      .eq('sample_id', sampleId)
      .order('step_index');
    if (error) throw error;
    let cocMap = {};
    data.forEach(e => { cocMap[e.step_index] = { done: e.done, active: e.active }; });
    return cocMap;
  } catch(err) {
    console.warn('[RE] loadCOCEvents offline, using default map');
    return { 0:{done:true,active:false}, 1:{done:true,active:false},
             2:{done:true,active:false}, 3:{done:false,active:true} };
  }
}

async function updateCOCEvent(sampleId, stepIndex, done, active) {
  try {
    const { error } = await db
      .from('coc_events')
      .update({ done, active, actor_name: currentUser?.name || 'Tech', occurred_at: new Date().toISOString() })
      .match({ sample_id: sampleId, step_index: stepIndex });
    if (error) throw error;
  } catch(err) {
    if (typeof _oqEnqueue === 'function') {
      const actorName = currentUser?.name || 'Tech';
      await _oqEnqueue('updateCOCEvent', { sampleId, stepIndex, done, active, actorName });
      console.warn('[RE] updateCOCEvent queued offline');
    } else {
      throw err;
    }
  }
}

// ========== LOAD TEST DEFINITIONS (with ref ranges & select options) ==========
let testDefinitions = { testTypes: {}, refRanges: {}, selectOptions: {} };
async function loadTestDefinitions() {
  try {
    const { data, error } = await db.from('test_definitions').select('*');
    if (error) throw error;
    testDefinitions = { testTypes: {}, refRanges: {}, selectOptions: {} };
    data.forEach(td => {
      if (td.test_type !== 'simple') {
        testDefinitions.testTypes[td.test_name] = td.test_type;
      }
      // Store reference range for simple_numeric
      if (td.test_type === 'simple_numeric' && td.ref_low !== null && td.ref_high !== null) {
        testDefinitions.refRanges[td.test_name] = {
          low: td.ref_low, high: td.ref_high, unit: td.ref_unit || ''
        };
      }
      // Store options for simple_select
      if (td.test_type === 'simple_select' && td.select_options && td.select_options.length) {
        testDefinitions.selectOptions[td.test_name] = td.select_options;
      }
    });
    if (typeof _oqCacheTestDefinitions === 'function') {
      _oqCacheTestDefinitions(data).catch(() => {});
    }
  } catch (err) {
    console.error(err);
    if (typeof _oqGetCachedTestDefinitions === 'function') {
      try {
        const cached = await _oqGetCachedTestDefinitions();
        if (cached && cached.length) {
          testDefinitions = { testTypes: {}, refRanges: {}, selectOptions: {} };
          cached.forEach(td => {
            if (td.test_type && td.test_type !== 'simple')
              testDefinitions.testTypes[td.test_name] = td.test_type;
            if (td.test_type === 'simple_numeric' && td.ref_low !== null && td.ref_high !== null) {
              testDefinitions.refRanges[td.test_name] = {
                low: td.ref_low, high: td.ref_high, unit: td.ref_unit || ''
              };
            }
            if (td.test_type === 'simple_select' && td.select_options && td.select_options.length) {
              testDefinitions.selectOptions[td.test_name] = td.select_options;
            }
          });
          console.log('[RE] loadTestDefinitions: restored from offline cache');
          return;
        }
      } catch(e) {}
    }
    toast('Failed to load test definitions', 'error');
  }
}

// ========== LOAD SAMPLES (clean version, like the check file) ==========
let samples = [];
let currentSample = null;

async function loadSamples() {
  try {
    const { data, error } = await db
      .from('samples')
      .select('*, sample_tests(*)')
      .in('status', ['Collected', 'Processing'])
      .order('id', { ascending: false })
      .limit(200);
    if (error) throw error;

    const safeData = Array.isArray(data) ? data : [];
    let serverSamples = safeData.map(s => ({
      ...s,
      online_ref: `REF-${s.id}`,
      former_offline_ref: s.former_offline_ref || null,
      tests: s.sample_tests || [],
      stype: s.sample_type,
      due: s.due_date,
      paystatus: s.pay_status,
      paymode: s.pay_mode,
      insurance: s.insurance_no,
      collDate: s.collection_date,
      collTime: s.collection_time
    }));

    // Merge any pending offline samples — wait up to 1s for offline_queue.js to init
    let merged = serverSamples;
    if (typeof window._oqMergePendingSamples !== 'function') {
      await new Promise(r => setTimeout(r, 800));
    }
    if (typeof window._oqMergePendingSamples === 'function') {
      merged = await window._oqMergePendingSamples(serverSamples);
    }
    samples = merged;

    // Cache for offline use
    if (typeof _oqCacheSampleList === 'function') {
      await _oqCacheSampleList(samples);
    }
  } catch (err) {
    console.warn('[RE] loadSamples failed – attempting offline cache:', err);
    if (typeof _oqGetCachedSamples === 'function') {
      try {
        let cached = await _oqGetCachedSamples();
        if (typeof window._oqMergePendingSamples === 'function') {
          cached = await window._oqMergePendingSamples(cached);
        }
        samples = cached.filter(s => s.status === 'Processing' || s.status === 'Collected');
        if (samples.length) {
          toast('Offline – showing cached & pending samples', 'warn');
          return;
        }
      } catch(e) {}
    }
    toast('Failed to load samples', 'error');
    samples = [];
  }
}

async function saveSample(sample) {
  if (typeof _oqCacheSample === 'function') _oqCacheSample(sample).catch(() => {});

  // Offline draft — no DB record exists yet, just keep in local cache
  if (typeof sample.id === 'string' && sample.id.startsWith('OFFLINE-')) return;

  try {
    const { error: sampleError } = await db
      .from('samples')
      .update({
        status: sample.status,
        released_at: sample.released_at,
        supervisor_comment: sample.supervisor_comment
      })
      .eq('id', sample.id);
    if (sampleError) throw sampleError;

    for (const test of sample.tests) {
      if (test.id) {
        // Happy path — real DB id known
        const { error: testError } = await db
          .from('sample_tests')
          .update({ result: test.result, tech_name: test.tech,
                    status: test.status, rejection_reason: test.rejection_reason || null })
          .eq('id', test.id);
        if (testError) throw testError;
      } else if (test.test_name) {
        // Fallback — sample synced but this test row's id not yet in cache;
        // match by sample_id + test_name (safe because test names are unique per sample)
        const { error: testError } = await db
          .from('sample_tests')
          .update({ result: test.result, tech_name: test.tech,
                    status: test.status, rejection_reason: test.rejection_reason || null })
          .eq('sample_id', sample.id)
          .eq('test_name', test.test_name);
        if (testError) throw testError;
      }
    }
  } catch(err) {
    if (typeof _oqEnqueue === 'function') {
      await _oqEnqueue('saveSample', { sample: JSON.parse(JSON.stringify(sample)) });
      console.warn('[RE] saveSample queued offline:', err);
    } else {
      throw err;
    }
  }
}

// Expose for offline_queue.js
window.saveSample = saveSample;
window.addAudit = addAudit;
window.updateCOCEvent = updateCOCEvent;
window.loadSamples = loadSamples;
window.renderProcessingSamples = renderProcessingSamples;

// ========== TEST TYPE DETECTION ==========
function getTestType(testName) {
  if (testDefinitions.testTypes[testName]) return testDefinitions.testTypes[testName];
  const n = testName.toLowerCase().trim();
  // Kontagora Clinical Chemistry panels (1-10)
  if (/e\/u\/cr|eucr|e\.u\.cr|electrolytes.*urea|urea.*electrolyte/.test(n)) return 'complex_eucr';
  if (/lipid\s*profile|cholesterol/.test(n)) return 'complex_lipid';
  if (/\bcalcium\b/.test(n) && !/phosphate|bone/.test(n)) return 'complex_calcium';
  if (/inorganic\s*phosphate|phosphate\s*profile/.test(n)) return 'complex_phosphate';
  if (/uric\s*acid/.test(n)) return 'complex_uric_acid';
  if (/liver\s*function|lft\b/.test(n)) return 'complex_lft';
  if (/total\s*protein\b|albumin.*globulin|protein\s*profile/.test(n)) return 'complex_total_protein';
  if (/\bpsa\b|prostate\s*specific/.test(n)) return 'complex_psa';
  if (/diabetes\s*profile|glucose\s*profile/.test(n)) return 'complex_diabetes';
  if (/\brf\b|rheumatoid\s*factor/.test(n)) return 'complex_rf';
  if (/\blh\b|\bfsh\b|testosterone|progesterone|prolactin|hormone\s*profile|reproductive/.test(n)) return 'complex_hormone';
  if (/\bmarry\b|marriage\s*screen|pre.?marital/.test(n)) return 'complex_marry';
  if (/antenatal|ante.?natal|anc\b|booking\s*test/.test(n)) return 'complex_antenatal';
  if (/\bblood\s*transfusion\b|grouping.*cross|crossmatch|cross\s*match/.test(n)) return 'complex_blood';
  if (/renal\s*function|kidney\s*function|rft\b/.test(n)) return 'complex_rft';
  if (/full\s*blood\s*count|complete\s*blood|cbc\b|fbc\b/.test(n)) return 'complex_cbc';
  if (/thyroid|tsh|thyroid\s*function/.test(n)) return 'complex_thyroid';
  if (/coagul|prothrombin|clotting\s*profile|pt\/inr|coag\b/.test(n)) return 'complex_coag';
  if (/widal/.test(n)) return 'complex_widal';
  if (/urine\s*mcs|urine\s*m\/c\/s|urine\s*culture|urinalysis\s*mcs/.test(n)) return 'complex_urine_mcs';
  if (/stool\s*mcs|stool\s*m\/c\/s|stool\s*culture/.test(n)) return 'complex_stool_mcs';
  if (/urinalysis|urine\s*r\/e|u\/a\b|routine\s*urine/.test(n)) return 'complex_urinalysis';
  if (/culture|sensitivity|c\/s\b|cs\b/.test(n) && /stool|faec/.test(n)) return 'complex_stool_cs';
  if (/culture|sensitivity|c\/s\b|cs\b/.test(n)) return 'complex_culture';
  if (/malaria|rdt|thick.*film|blood.*film/.test(n)) return 'complex_malaria';
  if (/genexpert|xpert|tb.*pcr|mtb/.test(n)) return 'complex_tb_genexpert';
  if (/serology|hbsag|hepatitis/.test(n)) return 'complex_serology';
  if (/iron\s*studies|iron\s*profile|serum\s*iron/.test(n)) return 'complex_iron';
  if (/bone\s*profile|calcium\s*profile/.test(n)) return 'complex_bone';
  if (/cardiac|troponin|ckmb/.test(n)) return 'complex_cardiac';
  if (/ogtt|glucose\s*tolerance/.test(n)) return 'complex_ogtt';
  if (/csf|cerebrospinal/.test(n)) return 'complex_csf';
  if (/blood\s*gas|abg\b/.test(n)) return 'complex_abg';
  if (/semen\s*analysis|seminal/.test(n)) return 'complex_semen';
  if (/packed\s*cell|pcv\b|haematocrit/.test(n)) return 'complex_pcv';
  if (/haemoglobin|hemoglobin|\bhb\b/.test(n)) return 'complex_hb';
  if (/esr\b|sedimentation/.test(n)) return 'complex_esr';
  if (/random\s*blood\s*sugar|rbs\b/.test(n)) return 'complex_rbs';
  if (/fasting\s*blood\s*sugar|fbs\b/.test(n)) return 'complex_fbs';
  if (/histopath|biopsy|histology|surgical\s*path|tissue/.test(n)) return 'complex_histopath';
  if (/fnac|fine\s*needle|aspiration\s*cytol/.test(n))              return 'complex_fnac';
  if (/pap\s*smear|cervical\s*cytol|papanicolaou/.test(n))          return 'complex_pap_smear';
  return 'simple';
}

// ========== DYNAMIC REFERENCE RANGE ==========
function getReferenceRange(testName, age, gender) {
  const patientAge = (age && !isNaN(age)) ? parseInt(age) : 30;
  const isMale = (gender === 'Male');
  const isFemale = (gender === 'Female');
  switch (testName) {
    case 'PCV': case 'Packed Cell Volume': case 'Hematocrit': case 'HCT':
      if (isMale) return { low: 40, high: 45, unit: '%' };
      if (isFemale) return { low: 35, high: 40, unit: '%' };
      return { low: 36, high: 46, unit: '%' };
    case 'Hb': case 'Hemoglobin':
      if (isMale) return { low: 13.5, high: 17.5, unit: 'g/dL' };
      if (isFemale) return { low: 12.0, high: 15.5, unit: 'g/dL' };
      return { low: 12.0, high: 15.5, unit: 'g/dL' };
    case 'ESR': case 'Erythrocyte Sedimentation Rate':
      if (isMale) return { low: 0, high: 5, unit: 'mm/hr' };
      if (isFemale) return { low: 0, high: 10, unit: 'mm/hr' };
      return { low: 0, high: 15, unit: 'mm/hr' };
    case 'RBS': case 'Random Blood Sugar':
      return { low: 6.0, high: 9.0, unit: 'mmol/L' };
    case 'FBS': case 'Fasting Blood Sugar':
      return { low: 3.0, high: 6.0, unit: 'mmol/L' };
    default: return null;
  }
}

// ========== PARAMETER DEFINITIONS ==========
// ========== COMPLEX FBC (Kontagora GH form) ==========
// Parameters match the printed FBC request form exactly.
// Gender-specific ranges for HB, PCV, ESR handled in render via note field.
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
const WIDAL_TITERS = [20, 40, 80, 160, 320, 640, 1280];
// ========== KONTAGORA GH CLINICAL CHEMISTRY PANELS ==========
// Panel 1 — E/U/Cr (Electrolytes, Urea, Creatinine)
const EUCR_PARAMS = [
  {key:'sodium',    name:'Sodium (Na⁺)',              unit:'mmol/L', low:136,  high:150},
  {key:'potassium', name:'Potassium (K⁺)',             unit:'mmol/L', low:3.5,  high:5.0},
  {key:'bicarb',    name:'Bicarbonate (HCO₃⁻)',       unit:'mmol/L', low:22,   high:30},
  {key:'chloride',  name:'Chloride (Cl⁻)',             unit:'mmol/L', low:96,   high:108},
  {key:'urea',      name:'Urea',                       unit:'mmol/L', low:2.1,  high:7.0},
  {key:'creat',     name:'Creatinine (Male)',           unit:'mg/dL',  low:0.9,  high:1.50},
  {key:'creat_f',   name:'Creatinine (Female)',         unit:'mg/dL',  low:0.7,  high:1.37}
];

// Panel 6 — LFT (Kontagora exact parameters)
const LFT_PARAMS_FULL = [
  {key:'tbil',  name:'Total Bilirubin',                unit:'mg/dL',  low:0,    high:1.11},
  {key:'dbil',  name:'Direct Bilirubin',               unit:'mg/dL',  low:0,    high:0.023},
  {key:'alp',   name:'Alkaline Phosphatase (Adult)',    unit:'U/L',    low:9,    high:35},
  {key:'alp_c', name:'Alkaline Phosphatase (Children)',unit:'U/L',    low:35,   high:100},
  {key:'ast',   name:'AST (GOT)',                       unit:'U/L',    low:3.5,  high:35},
  {key:'alt',   name:'ALT (GPT)',                       unit:'U/L',    low:2.5,  high:37}
];

// Panel 7 — Total Protein
const TOTAL_PROTEIN_PARAMS = [
  {key:'prot', name:'Total Protein', unit:'g/dL', low:5.8, high:8.2},
  {key:'alb',  name:'Albumin',       unit:'g/dL', low:3.5, high:5.2},
  {key:'glob', name:'Globulin',      unit:'g/dL', low:2.2, high:3.2, calc:true}
];

// Panel 3 — Calcium
const CALCIUM_PARAMS = [
  {key:'calcium', name:'Calcium', unit:'mmol/L', low:2.2, high:2.7}
];

// Panel 4 — Inorganic Phosphate
const PHOSPHATE_PARAMS = [
  {key:'phosphate_adult',    name:'Inorganic Phosphate (Adult)',    unit:'mmol/L', low:0.9, high:1.6},
  {key:'phosphate_children', name:'Inorganic Phosphate (Children)', unit:'mmol/L', low:1.1, high:2.0}
];

// Panel 5 — Uric Acid
const URIC_ACID_PARAMS = [
  {key:'uric_female', name:'Uric Acid (Female)', unit:'mg/dL', low:1.5, high:7.0},
  {key:'uric_male',   name:'Uric Acid (Male)',   unit:'mg/dl', low:1.5, high:7.0}
];

// Panel 8 — PSA Qualitative
const PSA_PARAMS = [
  {key:'psa_qual', name:'PSA (Qualitative)', unit:'', type:'select', options:['Non-reactive','Reactive','Borderline']}
];

// Panel 9 — Diabetes Profile
const DIABETES_PARAMS = [
  {key:'fbs',   name:'FBS (Fasting Blood Sugar)',    unit:'mmol/L', low:3.0, high:6.0},
  {key:'rbs',   name:'RBS (Random Blood Sugar)',      unit:'mmol/L', low:3.0, high:9.0},
  {key:'hpp2',  name:'2HPP (2-Hour Post-Prandial)',  unit:'mmol/L', low:3.0, high:9.0},
  {key:'ogtt',  name:'OGTT',                          unit:'mmol/L', low:3.0, high:7.8},
  {key:'hba1c', name:'HbA1c',                         unit:'%',      low:3.0, high:6.0}
];

// Panel 10 — RF (Rheumatoid Factor)
const RF_PARAMS = [
  {key:'rf', name:'Rheumatoid Factor (RF)', unit:'', type:'select', options:['Negative','Positive','Weakly Positive']}
];

// Hormone Panel — LH, FSH, Testosterone, Progesterone, Prolactin (Kontagora GH form)
const HORMONE_PARAMS = [
  {key:'lh',           name:'LH',           unit:'mIU/mL', low:null, high:null},
  {key:'fsh',          name:'FSH',          unit:'mIU/mL', low:null, high:null},
  {key:'testosterone', name:'Testosterone', unit:'ng/mL',  low:null, high:null},
  {key:'progesterone', name:'Progesterone', unit:'ng/mL',  low:null, high:null},
  {key:'prolactin',    name:'Prolactin',    unit:'ng/mL',  low:null, high:null}
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
  {key:'transfusion_reason',    name:'Reason for Transfusion',            unit:'', type:'text'},
  {key:'inv_hb_electrophoresis',name:'Investigation: Hb Electrophoresis', unit:'', type:'select', options:['Requested','Not Requested']},
  {key:'inv_type_screen',       name:'Investigation: Type & Screen',       unit:'', type:'select', options:['Requested','Not Requested']},
  {key:'inv_full_crossmatch',   name:'Investigation: Full Crossmatch',     unit:'', type:'select', options:['Requested','Not Requested']},
  {key:'result_hb',             name:'Result: HB',                         unit:'g/dL', type:'number', low:null, high:null},
  {key:'result_pcv',            name:'Result: PCV',                        unit:'%',    type:'number', low:null, high:null},

  // ── Section 3: Blood Products Required ──
  {key:'bp_whole_blood',        name:'Blood Product: Whole Blood',         unit:'', type:'select', options:['Yes','No']},
  {key:'bp_packed_cells',       name:'Blood Product: Packed Cells',        unit:'', type:'select', options:['Yes','No']},
  {key:'bp_platelet_concentrate',name:'Blood Product: Platelet Concentrate',unit:'', type:'select', options:['Yes','No']},
  {key:'bp_ffp',                name:'Blood Product: Fresh Frozen Plasma (FFP)', unit:'', type:'select', options:['Yes','No']},
  {key:'bp_cryoprecipitate',    name:'Blood Product: Cryoprecipitate',     unit:'', type:'select', options:['Yes','No']},
  {key:'bp_retroviral_screening',name:'Blood Product: Retroviral Screening',unit:'', type:'select', options:['Yes','No']},
  {key:'units_required',        name:'No. of Units Required',              unit:'', type:'number', low:null, high:null},
  {key:'units_donated',         name:'No. of Units Donated',               unit:'', type:'number', low:null, high:null},
  {key:'date_required',         name:'Date Required',                      unit:'', type:'text'},
  {key:'time_required',         name:'Time Required',                      unit:'', type:'text'},

  // ── Section 5: Autologous Blood (if applicable) ──
  {key:'autologous_units',      name:'Autologous: No. of Units to be Collected', unit:'', type:'number', low:null, high:null},
  {key:'type_of_surgery',       name:'Type of Surgery',                    unit:'', type:'text'},

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
  {key:'xm_ns_result',        name:"Normal Saline (37°C) — Result",   unit:'', type:'select', options:['Compatible','Incompatible','Weakly Incompatible']},
  {key:'xm_ns_remarks',       name:"Normal Saline (37°C) — Remarks",  unit:'', type:'text'},
  {key:'xm_ba_result',        name:"Bovine Albumin — Result",          unit:'', type:'select', options:['Compatible','Incompatible','Weakly Incompatible']},
  {key:'xm_ba_remarks',       name:"Bovine Albumin — Remarks",         unit:'', type:'text'},
  {key:'xm_ahg_result',       name:"AHG (Anti-Human Globulin) — Result",  unit:'', type:'select', options:['Compatible','Incompatible','Weakly Incompatible']},
  {key:'xm_ahg_remarks',      name:"AHG (Anti-Human Globulin) — Remarks", unit:'', type:'text'},

  // ── Section 8: Compatibility / Crossmatch Outcome ──
  {key:'blood_bag_no',        name:'Blood Unit / Bag No.',             unit:'', type:'text'},
  {key:'crossmatch',          name:'Grouping & Crossmatch Result',     unit:'', type:'select', options:['Compatible with Patient','Incompatible with Patient']},

  // ── Issue / Return times ──
  {key:'time_issued',         name:'Time Issued',                      unit:'', type:'text'},
  {key:'time_returned',       name:'Time Returned',                    unit:'', type:'text'},
  {key:'time_reissued',       name:'Time Reissued',                    unit:'', type:'text'}
];

// Backward-compatible RFT (full panel — for 'Renal Function Test' orders)
const RFT_PARAMS_FULL = [
  {key:'sodium',    name:'Sodium (Na⁺)',            unit:'mmol/L', low:136,  high:150},
  {key:'potassium', name:'Potassium (K⁺)',           unit:'mmol/L', low:3.5,  high:5.0},
  {key:'bicarb',    name:'Bicarbonate (HCO₃⁻)',     unit:'mmol/L', low:22,   high:30},
  {key:'chloride',  name:'Chloride (Cl⁻)',           unit:'mmol/L', low:96,   high:108},
  {key:'urea',      name:'Urea',                     unit:'mmol/L', low:2.1,  high:7.0},
  {key:'creat',     name:'Creatinine',               unit:'mg/dL',  low:0.9,  high:1.5},
  {key:'calcium',   name:'Calcium',                  unit:'mmol/L', low:2.2,  high:2.7},
  {key:'phosphate', name:'Inorganic Phosphate',      unit:'mmol/L', low:0.9,  high:1.6}
];
// Thyroid Function Test — Kontagora GH form
const THYROID_PARAMS = [
  {key:'tsh', name:'TSH', unit:'mIU/L',  low:0.3,  high:4.2},
  {key:'t3',  name:'T3',  unit:'nmol/L', low:1.23, high:3.07},
  {key:'t4',  name:'T4',  unit:'nmol/L', low:66,   high:181}
];
// Panel 2 — Lipid Profile (mmol/L — Kontagora form units)
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
  {key:'sperm_count', name:'Sperm Count', unit:'x10⁶ Sperm Cells/mL of Semen', low:15, high:200, type:'number'},
  {key:'viability', name:'Viability (%)', unit:'%', low:58, high:100, type:'number'},

  // Motility
  {key:'motility_a', name:'Grade A — Progressive Motility', unit:'%', low:32, high:100, type:'number'},
  {key:'motility_b', name:'Grade B — Non-Progressive Motility', unit:'%', low:0, high:100, type:'number'},
  {key:'motility_c', name:'Grade C — Non-Linear Motility', unit:'%', low:0, high:100, type:'number'},
  {key:'motility_d', name:'Grade D — Immotile Sperm Cells', unit:'%', low:0, high:100, type:'number'},

  // Morphology — Head defects
  {key:'morph_microcephalic', name:'Microcephalic', unit:'%', low:0, high:100, type:'number'},
  {key:'morph_macrocephalic', name:'Macrocephalic', unit:'%', low:0, high:100, type:'number'},
  {key:'morph_pinhead', name:'Pin Head', unit:'%', low:0, high:100, type:'number'},
  {key:'morph_pyriform', name:'Pyriform', unit:'%', low:0, high:100, type:'number'},
  {key:'morph_double_head', name:'Double Head', unit:'%', low:0, high:100, type:'number'},
  {key:'morph_acrosomal', name:'Acrosomal Condensation', unit:'%', low:0, high:100, type:'number'},

  // Morphology — Tail defects
  {key:'morph_tailless', name:'Tailless', unit:'%', low:0, high:100, type:'number'},
  {key:'morph_short_tail', name:'Short Tail', unit:'%', low:0, high:100, type:'number'},
  {key:'morph_long_tail', name:'Long Tail', unit:'%', low:0, high:100, type:'number'},
  {key:'morph_double_tail', name:'Double Tail', unit:'%', low:0, high:100, type:'number'},
  {key:'morph_coiled_tail', name:'Coiled Tail', unit:'%', low:0, high:100, type:'number'},

  // Morphology — Others
  {key:'morph_cytoplasmic_droplets', name:'Cytoplasmic Droplets', unit:'%', low:0, high:100, type:'number'},
  {key:'morph_midpiece_abnormality', name:'Mid Piece Abnormality', unit:'%', low:0, high:100, type:'number'},
  {key:'morph_neck_defect', name:'Neck Defect', unit:'%', low:0, high:100, type:'number'},
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
  {key:'anti_hbc', name:'Anti-HBc (Total)', type:'select', options:['Non-reactive','Reactive']}
];

// ========== HISTOPATHOLOGY PARAMS ==========
// Biopsy / Surgical Pathology — narrative report capture (Nigerian teaching hospital standard)
const HISTOPATH_PARAMS = [
  // Request side (filled at reception / sample login)
  {key:'specimen_site',   name:'Specimen / Site',              unit:'', type:'text',   section:'Request'},
  {key:'laterality',      name:'Laterality',                   unit:'', type:'select', section:'Request',
   options:['Right','Left','Bilateral','Midline','Not Applicable']},
  {key:'clinical_info',   name:'Clinical History',             unit:'', type:'text',   section:'Request'},
  {key:'nature_specimen', name:'Nature of Specimen',           unit:'', type:'select', section:'Request',
   options:['Incision Biopsy','Excision Biopsy','Core Needle Biopsy',
            'Wide Local Excision','Radical Resection','Endoscopic Biopsy',
            'Curettage','Amputation Specimen','Polypectomy','Other']},
  {key:'fixative',        name:'Fixative Used',                unit:'', type:'select', section:'Request',
   options:['10% Formalin','Formal Saline','Bouin\'s Solution','Fresh (Unfixed)','Other']},
  // Report side (entered from pathologist's typed/dictated report)
  {key:'macro_desc',      name:'Macroscopic Description',      unit:'', type:'textarea', section:'Report'},
  {key:'micro_desc',      name:'Microscopic Description',      unit:'', type:'textarea', section:'Report'},
  {key:'special_stains',  name:'Special Stains',               unit:'', type:'text',   section:'Report'},
  {key:'diagnosis',       name:'Histopathological Diagnosis',  unit:'', type:'textarea', section:'Report'},
  {key:'grade',           name:'Tumour Grade (if applicable)', unit:'', type:'select', section:'Report',
   options:['Not Applicable',
            'Grade I — Well Differentiated',
            'Grade II — Moderately Differentiated',
            'Grade III — Poorly Differentiated',
            'Grade IV — Undifferentiated']},
  {key:'margins',         name:'Surgical Margins — Status',    unit:'', type:'select', section:'Report',
   options:['Not Applicable','Clear (>1mm)','Close (<1mm)','Involved','Cannot Assess']},
  {key:'margin_distance', name:'Closest Margin (specify site & distance)', unit:'', type:'text', section:'Report'},
  {key:'lymph_nodes',     name:'Lymph Node Status',            unit:'', type:'text',   section:'Report'},
  {key:'staging',         name:'Pathologic Staging (pTNM, if applicable)', unit:'', type:'text', section:'Report'},
  {key:'comments',        name:'Comments / Recommendation',   unit:'', type:'textarea', section:'Report'},
  {key:'pathologist',     name:'Reporting Pathologist',        unit:'', type:'text',   section:'Report'}
];

// FNAC — Fine Needle Aspiration Cytology
const FNAC_PARAMS = [
  {key:'site',          name:'Site of Aspiration',         unit:'', type:'text',   section:'Request'},
  {key:'laterality',    name:'Laterality',                 unit:'', type:'select', section:'Request',
   options:['Right','Left','Bilateral','Midline','Not Applicable']},
  {key:'lesion_size',   name:'Lesion Size (cm)',            unit:'cm', type:'number', low:0, high:30, section:'Request'},
  {key:'clinical_info', name:'Clinical Information',        unit:'', type:'text',   section:'Request'},
  {key:'adequacy',      name:'Adequacy of Sample',         unit:'', type:'select', section:'Report',
   options:['Adequate for Diagnosis',
            'Inadequate — Scanty Cellularity',
            'Inadequate — Haemorrhagic',
            'Repeat Aspiration Advised']},
  {key:'stain',         name:'Stain Used',                 unit:'', type:'select', section:'Report',
   options:['Papanicolaou (Pap)','Diff-Quik (DQ)','Both Pap and DQ','H&E','MGG']},
  {key:'cytology',      name:'Cytological Diagnosis',      unit:'', type:'select', section:'Report',
   options:['Benign / Reactive',
            'Inflammatory / Infective — See Comments',
            'Colloid Goitre (Thyroid)',
            'Follicular Neoplasm (Thyroid)',
            'Papillary Thyroid Carcinoma',
            'Reactive Lymphadenopathy',
            'Granulomatous Lymphadenitis (? TB)',
            'Suspicious for Lymphoma',
            'Fibrocystic Disease (Breast)',
            'Fibroadenoma (Breast)',
            'Suspicious for Malignancy',
            'Malignant — See Microscopic Description',
            'Abscess / Necrotic Material',
            'No Diagnostic Material — Repeat']},
  {key:'micro_desc',    name:'Microscopic Description',    unit:'', type:'textarea', section:'Report'},
  {key:'comments',      name:'Comments / Recommendation',  unit:'', type:'textarea', section:'Report'},
  {key:'pathologist',   name:'Reporting Pathologist',      unit:'', type:'text',   section:'Report'}
];

// PAP Smear — Bethesda 2014 system (used in Nigerian government hospitals)
const PAP_SMEAR_PARAMS = [
  {key:'specimen_type', name:'Specimen Type',              unit:'', type:'select', section:'Request',
   options:['Conventional Pap Smear','Liquid-Based Cytology (LBC)',
            'Endocervical Brush','Cervical Scrape + ECS']},
  {key:'lmp',           name:'LMP (Last Menstrual Period)',unit:'', type:'text',   section:'Request'},
  {key:'clinical_info', name:'Clinical Information',       unit:'', type:'text',   section:'Request'},
  {key:'adequacy',      name:'Specimen Adequacy',          unit:'', type:'select', section:'Report',
   options:['Satisfactory for Evaluation',
            'Unsatisfactory — Insufficient Squamous Cells',
            'Unsatisfactory — Obscuring Blood',
            'Unsatisfactory — Obscuring Inflammation',
            'Unsatisfactory — Broken / Unfixed Slide']},
  {key:'cytology',      name:'Cytological Findings (Bethesda)',unit:'', type:'select', section:'Report',
   options:['Negative for Intraepithelial Lesion or Malignancy (NILM)',
            'Atypical cells of unknown significance (ASC-US)',
            'Atypical squamous cells cannot exclude HSIL (ASC-H)',
            'Low-grade squamous intraepithelial lesion LSIL (CIN I)',
            'High-grade squamous intraepithelial lesion HSIL (CIN II / CIN III)',
            'Squamous Cell Carcinoma',
            'Atypical Glandular Cells (AGC)',
            'Adenocarcinoma In Situ (AIS)',
            'Endocervical Adenocarcinoma',
            'Endometrial Cells (patient ≥45 yrs)']},
  {key:'organisms',     name:'Organisms / Infection',      unit:'', type:'select', section:'Report',
   options:['None Identified',
            'Trichomonas vaginalis',
            'Bacterial Vaginosis',
            'Candida spp.',
            'HSV Cytopathic Effect',
            'Actinomyces spp.']},
  {key:'hormonal',      name:'Hormonal Assessment',        unit:'', type:'select', section:'Report',
   options:['Compatible with Age and History',
            'Atrophic Pattern',
            'Estrogenic Effect',
            'Incompatible — See Comments']},
  {key:'recommendation',name:'Recommendation',             unit:'', type:'select', section:'Report',
   options:['Routine Repeat in 3 Years',
            'Repeat in 6 Months',
            'Colposcopy Recommended',
            'Biopsy Recommended',
            'HPV Testing Recommended',
            'Refer to Gynaecologist — Urgent']},
  {key:'comments',      name:'Cytologist Comments',        unit:'', type:'textarea', section:'Report'},
  {key:'pathologist',   name:'Reporting Pathologist',      unit:'', type:'text',   section:'Report'}
];

// ========== MCS MICROSCOPY PARAMS ==========
const URINE_MICRO_PARAMS = [
  {key:'colour',      name:'Colour',             unit:'', section:'Physical', type:'select',
   options:['Yellow','Straw','Clear','Dark Yellow','Red','Brown','Amber','Orange']},
  {key:'appearance',  name:'Appearance',         unit:'', section:'Physical', type:'select',
   options:['Clear','Slightly Turbid','Turbid','Cloudy','Bloody','Frothy']},
  {key:'volume',      name:'Volume',             unit:'mL', section:'Physical', type:'number', low:0, high:3000, step:10},
  {key:'wbc_micro',   name:'WBC (Pus Cells)',   unit:'/HPF', section:'Microscopy', type:'select',
   options:['None seen','1–5','6–10','11–20','21–50','>50','Too numerous to count (TNTC)']},
  {key:'rbc_micro',   name:'RBC',               unit:'/HPF', section:'Microscopy', type:'select',
   options:['None seen','1–2','3–5','6–10','11–20','>20','Too numerous to count (TNTC)']},
  {key:'epithelial',  name:'Epithelial Cells',  unit:'/HPF', section:'Microscopy', type:'select',
   options:['None seen','Squamous — Few','Squamous — Moderate','Squamous — Many',
            'Transitional — Few','Transitional — Moderate','Renal tubular — seen']},
  {key:'casts',       name:'Casts',             unit:'/LPF', section:'Microscopy', type:'select',
   options:['None seen','Hyaline casts','Granular casts (coarse)','Granular casts (fine)',
            'RBC casts','WBC casts','Epithelial cell casts','Waxy casts','Broad casts','Fatty casts','Mixed casts']},
  {key:'crystals',    name:'Crystals',          unit:'',     section:'Microscopy', type:'select',
   options:['None seen','Uric acid','Calcium oxalate (monohydrate)','Calcium oxalate (dihydrate)',
            'Triple phosphate (struvite)','Amorphous phosphates','Amorphous urates',
            'Calcium carbonate','Calcium phosphate','Cystine','Tyrosine','Leucine']},
  {key:'bacteria',    name:'Bacteria',          unit:'',     section:'Microscopy', type:'select',
   options:['None seen','Few','Moderate','Many','Too numerous to count (TNTC)']},
  {key:'yeast',       name:'Yeast Cells',       unit:'',     section:'Microscopy', type:'select',
   options:['None seen','Few','Moderate','Many']},
  {key:'parasite',    name:'Parasite / Ova',    unit:'',     section:'Microscopy', type:'select',
   options:['None seen','Trichomonas vaginalis','Schistosoma haematobium ova','Other — see comments']},
  {key:'mucus',       name:'Mucus Threads',     unit:'',     section:'Microscopy', type:'select',
   options:['None seen','Few','Moderate','Many']},
  {key:'sperm',       name:'Spermatozoa',       unit:'',     section:'Microscopy', type:'select',
   options:['Not seen','Seen (incidental)']},
  {key:'micro_comment',name:'Microscopy Comment',unit:'',    section:'Microscopy', type:'text'}
];

const STOOL_MICRO_PARAMS = [
  {key:'consistency',  name:'Consistency',          unit:'', section:'Macroscopy', type:'select', options:['Formed','Soft','Watery','Loose','Bloody','Mucoid','Fatty']},
  {key:'colour_stool', name:'Colour',               unit:'', section:'Macroscopy', type:'select', options:['Brown','Yellow','Green','Black (Tarry)','Red (Bloody)','Grey/Clay','Pale/Fatty']},
  {key:'blood_stool',  name:'Blood (Macroscopic)',  unit:'', section:'Macroscopy', type:'select', options:['Absent','Present']},
  {key:'mucus_stool',  name:'Mucus (Macroscopic)',  unit:'', section:'Macroscopy', type:'select', options:['Absent','Present']},
  {key:'wbc_stool',    name:'WBC (Pus Cells)',      unit:'/HPF', section:'Microscopy', type:'select', options:['None seen','1–5','6–10','11–20','>20']},
  {key:'rbc_stool',    name:'RBC',                  unit:'/HPF', section:'Microscopy', type:'select', options:['None seen','1–5','6–10','11–20','>20']},
  {key:'fat_globules', name:'Fat Globules',         unit:'',     section:'Microscopy', type:'select', options:['None seen','Few','Moderate','Many']},
  {key:'ova_parasite', name:'Ova / Parasites',      unit:'',     section:'Microscopy', type:'select', options:['None seen','Ascaris lumbricoides ova','Trichuris trichiura ova','Hookworm ova','Strongyloides larvae','Entamoeba histolytica cysts','Entamoeba histolytica trophozoites','Giardia lamblia cysts','Cryptosporidium oocysts','Taenia spp. ova','Enterobius vermicularis ova','Other — see comments']},
  {key:'yeast_stool',  name:'Yeast Cells',          unit:'',     section:'Microscopy', type:'select', options:['None seen','Few','Moderate','Many']},
  {key:'epithelial_stool',name:'Epithelial Cells',  unit:'',     section:'Microscopy', type:'select', options:['None seen','Few','Moderate','Many']},
  {key:'occult_blood', name:'Occult Blood (Chemical)',unit:'',   section:'Microscopy', type:'select', options:['Negative','Positive']},
  {key:'micro_comment_stool',name:'Microscopy Comment',unit:'', section:'Microscopy', type:'text'}
];

function getFlag(val, param) {
  let n = parseFloat(val);
  if (isNaN(n)) return '';
  if (param.high !== null && n > param.high) return 'flag-inp-high';
  if (param.low  !== null && n < param.low)  return 'flag-inp-low';
  return '';
}

// ========== RENDER SAMPLES TABLE ==========
async function renderProcessingSamples() {
  await loadSamples();
  let search = document.getElementById('sampleSearch')?.value.toLowerCase().trim() || '';
  let priority = document.getElementById('priorityFilter')?.value || 'all';

  let ready = samples.filter(s => s.status === 'Processing' || s.status === 'Collected');

  if (search) ready = ready.filter(s =>
    s.id.toString().includes(search) ||
    (s.online_ref && s.online_ref.toLowerCase().includes(search)) ||
    (s.patient || '').toLowerCase().includes(search) ||
    (s.offline_ref || '').toLowerCase().includes(search) ||
    (s.former_offline_ref || '').toLowerCase().includes(search) ||
    (s.receipt_no || '').toLowerCase().includes(search)
  );
  if (priority !== 'all') ready = ready.filter(s => s.priority === priority);

  const priOrder = { STAT: 0, Urgent: 1, Routine: 2 };
  ready.sort((a, b) => (priOrder[a.priority] ?? 2) - (priOrder[b.priority] ?? 2) || b.id - a.id);

  let badge = document.getElementById('sampleCountBadge');
  if (badge) badge.textContent = `(${ready.length})`;

  let tbody = document.getElementById('samplesTable');
  if (!tbody) return;

  if (!ready.length) {
    tbody.innerHTML = `<tr><td colspan="6"><div class="empty-state">No samples ready for result entry.</div></td></tr>`;
    return;
  }

  tbody.innerHTML = ready.map(s => {
    let priCls = s.priority === 'STAT' ? 'badge-stat' : s.priority === 'Urgent' ? 'badge-urgent' : 'badge-routine';
    let staCls = s.status === 'Collected' ? 'badge-collected' : 'badge-processing';
    const readyCount = s.tests.filter(t => t.status === 'Ready').length;
    const rejectedCount = s.tests.filter(t => t.status === 'Rejected').length;
    const totalTests = s.tests.length;
    const actionableTests = totalTests - rejectedCount;
    const allReady = actionableTests > 0 && readyCount === actionableTests;
    let progressNote = '';
    if (rejectedCount > 0 && readyCount < actionableTests) {
      progressNote = ` <small style="color:#b91c1c;">(${rejectedCount} rejected · ${readyCount}/${actionableTests} ready)</small>`;
    } else if (rejectedCount > 0 && allReady) {
      progressNote = ` <small style="color:var(--green-glow);">✓ Ready <span style="color:#b91c1c;">(${rejectedCount} rejected)</span></small>`;
    } else if (totalTests > 1 && readyCount > 0 && !allReady) {
      progressNote = ` <small style="color:var(--yellow-light);">(${readyCount}/${actionableTests} ready)</small>`;
    } else if (allReady && totalTests > 1) {
      progressNote = ` <small style="color:var(--green-glow);">✓ All ready</small>`;
    } else if (s.tests.some(t => t.result && t.result.trim())) {
      progressNote = ` <small style="color:var(--yellow-light);">(draft)</small>`;
    }
    const testList = s.tests.map(t => {
      const icon = t.status === 'Ready' ? '✅' : t.status === 'Rejected' ? '🚫' : t.result && t.result.trim() ? '📝' : '⏳';
      return `${icon} ${esc(t.test_name)}`;
    }).join('<br>');

    return `
      <tr>
        <td style="font-family:monospace; font-weight:600;">
          MU-${s.id}<br>
          <span style="font-size:0.7rem; color:var(--primary);">${esc(s.online_ref)}</span>
          ${s.offline_ref ? `<br><span style="font-size:0.65rem;color:var(--amber);background:var(--amber-l);border:1px solid #fde68a;padding:1px 6px;border-radius:6px;display:inline-block;margin-top:3px;" title="Offline draft — pending sync">${esc(s.offline_ref)}</span>` : ''}
          ${s.former_offline_ref ? `<br><span style="font-size:0.65rem;color:#059669;background:#ecfdf5;border:1px solid #6ee7b7;padding:1px 6px;border-radius:6px;display:inline-block;margin-top:3px;" title="Registered offline — synced. Real ID: MU-${s.id}">✓ ${esc(s.former_offline_ref)}</span>` : ''}
        </td>
        <td><strong>${esc(s.patient)}</strong><br><small style="color:var(--text2);">${s.age ?? '?'}y ${esc(s.gender)}</small></td>
        <td><small>${testList}</small>${progressNote}</td>
        <td><span class="badge ${priCls}">${esc(s.priority)}</span></td>
        <td><span class="badge ${staCls}">${esc(s.status)}</span></td>
        <td><button class="btn btn-primary btn-sm" onclick="openResultModal('${s.id}')"><i class="fas fa-edit"></i> Enter Results</button></td>
      </tr>`;
  }).join('');
}

// ========== CULTURE SENSITIVITY HELPERS ==========
window.addSensitivityRow = function(containerId) {
  const container = document.getElementById(containerId);
  if (!container) return;
  const idx = container.children.length;
  const newRow = document.createElement('div');
  newRow.setAttribute('data-ab-row', '');
  newRow.style.cssText = 'display:flex; gap:8px; align-items:center; margin-bottom:5px;';
  newRow.innerHTML = `
    <input type="text" placeholder="Antibiotic" style="flex:2;" id="${containerId}_ab_${idx}_name">
    <select style="flex:1;" id="${containerId}_ab_${idx}_result">
      <option value="S">S (Sensitive)</option>
      <option value="I">I (Intermediate)</option>
      <option value="R">R (Resistant)</option>
    </select>
    <button type="button" class="btn btn-danger btn-sm" onclick="removeSensitivityRow('${containerId}', this)">✖</button>
  `;
  container.appendChild(newRow);
};

window.removeSensitivityRow = function(containerId, btn) {
  const row = btn.closest('div');
  if (row) row.remove();
};

// ========== OPEN MODAL (full panel generation) ==========
async function openResultModal(id) {
  await loadSamples();
  let sample = samples.find(s => String(s.id) === String(id));
  if (!sample) { toast('Sample not found', 'error'); return; }

  let cocEvents = await loadCOCEvents(sample.id);

  if (sample.status === 'Collected') {
    sample.status = 'Processing';
    await saveSample(sample);
    await updateCOCEvent(sample.id, 2, true, false);
    await updateCOCEvent(sample.id, 3, false, true);
    await addAudit('Started Processing', sample.id, 'Technologist opened result entry & sample received');
    toast(`MU-${sample.id} moved to Processing`, 'success');
    await renderProcessingSamples();
    cocEvents = await loadCOCEvents(sample.id);
  }

  currentSample = JSON.parse(JSON.stringify(sample));
  currentSample.coc = cocEvents;

  const modalTitle = document.getElementById('modalTitle');
  const modalSubtitle = document.getElementById('modalSubtitle');
  const sampleInfo = document.getElementById('sampleInfo');
  const testForms = document.getElementById('testForms');
  const cocTimeline = document.getElementById('cocTimeline');

  if (modalTitle) {
    // Always show a status pill
    const statusPill = currentSample.offline_ref
      ? ` <span style="font-size:0.65rem;font-weight:600;color:var(--amber);background:var(--amber-l);border:1px solid #fde68a;padding:2px 8px;border-radius:20px;vertical-align:middle;" title="Registered offline — pending sync to server">OFFLINE DRAFT</span>`
      : (currentSample.former_offline_ref
          ? ` <span style="font-size:0.65rem;font-weight:600;color:#059669;background:#ecfdf5;border:1px solid #6ee7b7;padding:2px 8px;border-radius:20px;vertical-align:middle;" title="Was registered offline — now synced">✓ SYNCED</span>`
          : '');
    modalTitle.innerHTML = `Results — MU-${currentSample.id} | ${esc(currentSample.patient)}${statusPill}`;
  }
  if (modalSubtitle) modalSubtitle.textContent = `${currentSample.age ?? '?'}y ${currentSample.gender} | ${currentSample.sample_type ?? ''} | Collected: ${currentSample.collection_date ?? ''} | ${currentSample.collection_time ?? ''}`;
  if (sampleInfo) {
    // Always show offline ref if present (either still-offline or already synced).
    // Technologist can cross-reference the receipt slip with the offline ref.
    const offlineRef = currentSample.offline_ref || currentSample.former_offline_ref;
    const offlineRefHtml = offlineRef
      ? ` &nbsp;|&nbsp; <strong>Offline Ref:</strong> <span style="font-family:monospace;font-size:0.82rem;color:#059669;background:#f0fdf4;border:1px solid #bbf7d0;padding:1px 7px;border-radius:6px;" title="Original offline receipt reference">${esc(offlineRef)}</span>`
      : '';
    sampleInfo.innerHTML = `<strong>Clinician:</strong> ${esc(currentSample.clinician || '—')} &nbsp;|&nbsp; <strong>History:</strong> ${esc(currentSample.history || '—')} &nbsp;|&nbsp; <strong>Priority:</strong> ${esc(currentSample.priority)}${offlineRefHtml}`;
  }

  let formsHtml = '';
  currentSample.tests.forEach((test, idx) => {
    let testType = getTestType(test.test_name);
    formsHtml += `<div class="test-block" id="testBlock_${idx}">`;
    formsHtml += `<div class="test-block-title"><i class="fas fa-vial" style="color:var(--primary);margin-right:6px;"></i>${esc(test.test_name)}</div>`;
    formsHtml += `<div class="test-block-body">`;

    if (testType === 'complex_cbc') {
      let data = {};
      try { if (test.result?.startsWith('{')) data = JSON.parse(test.result); } catch(e){}
      const cbcMain  = CBC_PARAMS.slice(0, 12); // HB → Clotting Time
      const cbcDiff  = CBC_PARAMS.slice(12);    // Differential Count
      formsHtml += `<div class="mcs-section-label">🩸 Full Blood Count</div><div class="param-grid">`;
      cbcMain.forEach(p => {
        let val = data[p.key] !== undefined ? data[p.key] : '';
        let flagCls = val !== '' ? getFlag(val, p) : '';
        let noteHtml = p.note ? `<br><span style="color:var(--text3);font-size:0.7rem;">${esc(p.note)}</span>` : '';
        formsHtml += `<div class="param-item">
          <label>${esc(p.name)} <span style="color:var(--text3);font-weight:400;">(${esc(p.unit)}) Ref: ${p.low}–${p.high}</span>${noteHtml}</label>
          <input type="number" step="0.1" id="cbc_${idx}_${p.key}" value="${val}" placeholder="${p.low}–${p.high}" class="${flagCls}">
        </div>`;
      });
      formsHtml += `</div><div class="mcs-section-label">🔬 Differential Count</div><div class="param-grid">`;
      cbcDiff.forEach(p => {
        let val = data[p.key] !== undefined ? data[p.key] : '';
        let flagCls = val !== '' ? getFlag(val, p) : '';
        formsHtml += `<div class="param-item">
          <label>${esc(p.name)} <span style="color:var(--text3);font-weight:400;">(${esc(p.unit)}) Ref: ${p.low}–${p.high}</span></label>
          <input type="number" step="0.1" id="cbc_${idx}_${p.key}" value="${val}" placeholder="${p.low}–${p.high}" class="${flagCls}">
        </div>`;
      });
      formsHtml += `</div><div id="cbcInterp_${idx}" class="interp-box interp-normal">—</div>`;
    }
    else if (testType === 'complex_widal') {
      let w = { o:'—', h:'—', ao:'—', ah:'—', bo:'—', bh:'—', co:'—', ch:'—' };
      try { if (test.result?.startsWith('{')) w = { ...w, ...JSON.parse(test.result) }; } catch(e){}
      const widalOrganisms = [
        { label: 'Salmonella Typhi',       oKey: 'o',  hKey: 'h'  },
        { label: 'Salmonella Paratyphi A', oKey: 'ao', hKey: 'ah' },
        { label: 'Salmonella Paratyphi B', oKey: 'bo', hKey: 'bh' },
        { label: 'Salmonella Paratyphi C', oKey: 'co', hKey: 'ch' }
      ];
      const buildTiterOpts = (fieldKey) => ['—', ...WIDAL_TITERS].map(t =>
        `<option value="${t}" ${String(w[fieldKey]) === String(t) ? 'selected' : ''}>${t === '—' ? '— (not done)' : '1:' + t}</option>`
      ).join('');
      formsHtml += `
        <div style="overflow-x:auto; margin-top:10px;">
          <table style="width:100%; border-collapse:collapse; font-size:0.85rem; border-radius:16px; overflow:hidden; border:1.5px solid #e2edf2;">
            <thead>
              <tr style="background:#e8f4ed; text-align:center;">
                <th style="padding:10px 14px; text-align:left; font-size:0.72rem; text-transform:uppercase; letter-spacing:0.05em; color:#1F6E43; border-right:1px solid #cde5d8;">Organism</th>
                <th style="padding:10px 14px; font-size:0.72rem; text-transform:uppercase; letter-spacing:0.05em; color:#1F6E43; border-right:1px solid #cde5d8;">O Antigen (TO)</th>
                <th style="padding:10px 14px; font-size:0.72rem; text-transform:uppercase; letter-spacing:0.05em; color:#1F6E43;">H Antigen (TH)</th>
              <tr>
            </thead>
            <tbody>
              ${widalOrganisms.map((org, ri) => `
                <tr style="border-top:1px solid #e2edf2; background:${ri % 2 === 1 ? '#f7faf9' : 'white'};">
                  <td style="padding:10px 14px; font-style:italic; font-weight:500; color:#1a2c3e; border-right:1px solid #e2edf2; white-space:nowrap;">${org.label}</td>
                  <td style="padding:8px 14px; text-align:center; border-right:1px solid #e2edf2;">
                    <select id="widal_${idx}_${org.oKey}" style="padding:6px 10px; border-radius:10px; border:1.5px solid #e2edf2; font-size:0.85rem; background:white; min-width:130px;">
                      ${buildTiterOpts(org.oKey)}
                    </select>
                  </td>
                  <td style="padding:8px 14px; text-align:center;">
                    <select id="widal_${idx}_${org.hKey}" style="padding:6px 10px; border-radius:10px; border:1.5px solid #e2edf2; font-size:0.85rem; background:white; min-width:130px;">
                      ${buildTiterOpts(org.hKey)}
                    </select>
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
        <div style="margin-top:7px; font-size:0.72rem; color:var(--text2);">⚠ Titres ≥ 1:160 are significant. Select "— (not done)" if that antigen was not tested.</div>
        <div id="widalInterp_${idx}" class="interp-box interp-normal" style="margin-top:8px;">—</div>`;
    }
    else if (testType === 'complex_lft') {
      let data = {};
      try { if (test.result?.startsWith('{')) data = JSON.parse(test.result); } catch(e){}
      formsHtml += `<div class="param-grid">`;
      LFT_PARAMS_FULL.forEach(p => {
        let val = data[p.key] !== undefined ? data[p.key] : '';
        let flagCls = val !== '' ? getFlag(val, p) : '';
        formsHtml += `<div class="param-item">
          <label>${esc(p.name)} <span style="color:var(--text3);font-weight:400;">(${esc(p.unit)}) Ref: ${p.low}–${p.high}</span></label>
          <input type="number" step="0.1" min="${p.low}" max="${p.high}" id="lft_${idx}_${p.key}" value="${val}" placeholder="${p.low}–${p.high}" class="${flagCls}">
        </div>`;
      });
      formsHtml += `</div><div id="lftInterp_${idx}" class="interp-box interp-normal">—</div>`;
    }
    else if (testType === 'complex_eucr') {
      let data = {};
      try { if (test.result?.startsWith('{')) data = JSON.parse(test.result); } catch(e){}
      formsHtml += `<div class="param-grid">`;
      EUCR_PARAMS.forEach(p => {
        let val = data[p.key] !== undefined ? data[p.key] : '';
        if (p.type === 'select') {
          formsHtml += `<div class="param-item"><label>${esc(p.name)}</label><select id="eucr_${idx}_${p.key}">${p.options.map(opt => `<option value="${esc(opt)}" ${val === opt ? 'selected' : ''}>${esc(opt)}</option>`).join('')}</select></div>`;
        } else {
          let flagCls = val !== '' ? getFlag(val, p) : '';
          let noteHtml = p.note ? ` <span style="color:var(--text3);font-size:0.72rem;">${esc(p.note)}</span>` : '';
          formsHtml += `<div class="param-item">
            <label>${esc(p.name)} <span style="color:var(--text3);font-weight:400;">(${esc(p.unit)}) Ref: ${p.low}–${p.high}</span>${noteHtml}</label>
            <input type="number" step="0.01" min="${p.low}" max="${p.high}" id="eucr_${idx}_${p.key}" value="${val}" placeholder="${p.low}–${p.high}" class="${flagCls}">
          </div>`;
        }
      });
      formsHtml += `</div><div id="eucrInterp_${idx}" class="interp-box interp-normal">—</div>`;
    }
    else if (testType === 'complex_calcium') {
      let data = {};
      try { if (test.result?.startsWith('{')) data = JSON.parse(test.result); } catch(e){}
      formsHtml += `<div class="param-grid">`;
      CALCIUM_PARAMS.forEach(p => {
        let val = data[p.key] !== undefined ? data[p.key] : '';
        if (p.type === 'select') {
          formsHtml += `<div class="param-item"><label>${esc(p.name)}</label><select id="calc_${idx}_${p.key}">${p.options.map(opt => `<option value="${esc(opt)}" ${val === opt ? 'selected' : ''}>${esc(opt)}</option>`).join('')}</select></div>`;
        } else {
          let flagCls = val !== '' ? getFlag(val, p) : '';
          let noteHtml = p.note ? ` <span style="color:var(--text3);font-size:0.72rem;">${esc(p.note)}</span>` : '';
          formsHtml += `<div class="param-item">
            <label>${esc(p.name)} <span style="color:var(--text3);font-weight:400;">(${esc(p.unit)}) Ref: ${p.low}–${p.high}</span>${noteHtml}</label>
            <input type="number" step="0.01" min="${p.low}" max="${p.high}" id="calc_${idx}_${p.key}" value="${val}" placeholder="${p.low}–${p.high}" class="${flagCls}">
          </div>`;
        }
      });
      formsHtml += `</div><div id="calcInterp_${idx}" class="interp-box interp-normal">—</div>`;
    }
    else if (testType === 'complex_phosphate') {
      let data = {};
      try { if (test.result?.startsWith('{')) data = JSON.parse(test.result); } catch(e){}
      formsHtml += `<div class="param-grid">`;
      PHOSPHATE_PARAMS.forEach(p => {
        let val = data[p.key] !== undefined ? data[p.key] : '';
        if (p.type === 'select') {
          formsHtml += `<div class="param-item"><label>${esc(p.name)}</label><select id="phos_${idx}_${p.key}">${p.options.map(opt => `<option value="${esc(opt)}" ${val === opt ? 'selected' : ''}>${esc(opt)}</option>`).join('')}</select></div>`;
        } else {
          let flagCls = val !== '' ? getFlag(val, p) : '';
          let noteHtml = p.note ? ` <span style="color:var(--text3);font-size:0.72rem;">${esc(p.note)}</span>` : '';
          formsHtml += `<div class="param-item">
            <label>${esc(p.name)} <span style="color:var(--text3);font-weight:400;">(${esc(p.unit)}) Ref: ${p.low}–${p.high}</span>${noteHtml}</label>
            <input type="number" step="0.01" min="${p.low}" max="${p.high}" id="phos_${idx}_${p.key}" value="${val}" placeholder="${p.low}–${p.high}" class="${flagCls}">
          </div>`;
        }
      });
      formsHtml += `</div><div id="phosInterp_${idx}" class="interp-box interp-normal">—</div>`;
    }
    else if (testType === 'complex_uric_acid') {
      let data = {};
      try { if (test.result?.startsWith('{')) data = JSON.parse(test.result); } catch(e){}
      formsHtml += `<div class="param-grid">`;
      URIC_ACID_PARAMS.forEach(p => {
        let val = data[p.key] !== undefined ? data[p.key] : '';
        if (p.type === 'select') {
          formsHtml += `<div class="param-item"><label>${esc(p.name)}</label><select id="uric_${idx}_${p.key}">${p.options.map(opt => `<option value="${esc(opt)}" ${val === opt ? 'selected' : ''}>${esc(opt)}</option>`).join('')}</select></div>`;
        } else {
          let flagCls = val !== '' ? getFlag(val, p) : '';
          let noteHtml = p.note ? ` <span style="color:var(--text3);font-size:0.72rem;">${esc(p.note)}</span>` : '';
          formsHtml += `<div class="param-item">
            <label>${esc(p.name)} <span style="color:var(--text3);font-weight:400;">(${esc(p.unit)}) Ref: ${p.low}–${p.high}</span>${noteHtml}</label>
            <input type="number" step="0.01" min="${p.low}" max="${p.high}" id="uric_${idx}_${p.key}" value="${val}" placeholder="${p.low}–${p.high}" class="${flagCls}">
          </div>`;
        }
      });
      formsHtml += `</div><div id="uricInterp_${idx}" class="interp-box interp-normal">—</div>`;
    }
    else if (testType === 'complex_total_protein') {
      let data = {};
      try { if (test.result?.startsWith('{')) data = JSON.parse(test.result); } catch(e){}
      formsHtml += `<div class="param-grid">`;
      TOTAL_PROTEIN_PARAMS.forEach(p => {
        let val = data[p.key] !== undefined ? data[p.key] : '';
        if (p.type === 'select') {
          formsHtml += `<div class="param-item"><label>${esc(p.name)}</label><select id="tp_${idx}_${p.key}">${p.options.map(opt => `<option value="${esc(opt)}" ${val === opt ? 'selected' : ''}>${esc(opt)}</option>`).join('')}</select></div>`;
        } else {
          let flagCls = val !== '' ? getFlag(val, p) : '';
          let noteHtml = p.note ? ` <span style="color:var(--text3);font-size:0.72rem;">${esc(p.note)}</span>` : '';
          formsHtml += `<div class="param-item">
            <label>${esc(p.name)} <span style="color:var(--text3);font-weight:400;">(${esc(p.unit)}) Ref: ${p.low}–${p.high}</span>${noteHtml}</label>
            <input type="number" step="0.01" min="${p.low}" max="${p.high}" id="tp_${idx}_${p.key}" value="${val}" placeholder="${p.low}–${p.high}" class="${flagCls}">
          </div>`;
        }
      });
      formsHtml += `</div><div id="tpInterp_${idx}" class="interp-box interp-normal">—</div>`;
    }
    else if (testType === 'complex_psa') {
      let data = {};
      try { if (test.result?.startsWith('{')) data = JSON.parse(test.result); } catch(e){}
      formsHtml += `<div class="param-grid">`;
      PSA_PARAMS.forEach(p => {
        let val = data[p.key] !== undefined ? data[p.key] : '';
        if (p.type === 'select') {
          formsHtml += `<div class="param-item"><label>${esc(p.name)}</label><select id="psa_${idx}_${p.key}">${p.options.map(opt => `<option value="${esc(opt)}" ${val === opt ? 'selected' : ''}>${esc(opt)}</option>`).join('')}</select></div>`;
        } else {
          let flagCls = val !== '' ? getFlag(val, p) : '';
          let noteHtml = p.note ? ` <span style="color:var(--text3);font-size:0.72rem;">${esc(p.note)}</span>` : '';
          formsHtml += `<div class="param-item">
            <label>${esc(p.name)} <span style="color:var(--text3);font-weight:400;">(${esc(p.unit)}) Ref: ${p.low}–${p.high}</span>${noteHtml}</label>
            <input type="number" step="0.01" min="${p.low}" max="${p.high}" id="psa_${idx}_${p.key}" value="${val}" placeholder="${p.low}–${p.high}" class="${flagCls}">
          </div>`;
        }
      });
      formsHtml += `</div><div id="psaInterp_${idx}" class="interp-box interp-normal">—</div>`;
    }
    else if (testType === 'complex_diabetes') {
      let data = {};
      try { if (test.result?.startsWith('{')) data = JSON.parse(test.result); } catch(e){}
      formsHtml += `<div class="param-grid">`;
      DIABETES_PARAMS.forEach(p => {
        let val = data[p.key] !== undefined ? data[p.key] : '';
        if (p.type === 'select') {
          formsHtml += `<div class="param-item"><label>${esc(p.name)}</label><select id="diab_${idx}_${p.key}">${p.options.map(opt => `<option value="${esc(opt)}" ${val === opt ? 'selected' : ''}>${esc(opt)}</option>`).join('')}</select></div>`;
        } else {
          let flagCls = val !== '' ? getFlag(val, p) : '';
          let noteHtml = p.note ? ` <span style="color:var(--text3);font-size:0.72rem;">${esc(p.note)}</span>` : '';
          formsHtml += `<div class="param-item">
            <label>${esc(p.name)} <span style="color:var(--text3);font-weight:400;">(${esc(p.unit)}) Ref: ${p.low}–${p.high}</span>${noteHtml}</label>
            <input type="number" step="0.01" min="${p.low}" max="${p.high}" id="diab_${idx}_${p.key}" value="${val}" placeholder="${p.low}–${p.high}" class="${flagCls}">
          </div>`;
        }
      });
      formsHtml += `</div><div id="diabInterp_${idx}" class="interp-box interp-normal">—</div>`;
    }
    else if (testType === 'complex_rf') {
      let data = {};
      try { if (test.result?.startsWith('{')) data = JSON.parse(test.result); } catch(e){}
      formsHtml += `<div class="param-grid">`;
      RF_PARAMS.forEach(p => {
        let val = data[p.key] !== undefined ? data[p.key] : '';
        if (p.type === 'select') {
          formsHtml += `<div class="param-item"><label>${esc(p.name)}</label><select id="rf_${idx}_${p.key}">${p.options.map(opt => `<option value="${esc(opt)}" ${val === opt ? 'selected' : ''}>${esc(opt)}</option>`).join('')}</select></div>`;
        } else {
          let flagCls = val !== '' ? getFlag(val, p) : '';
          let noteHtml = p.note ? ` <span style="color:var(--text3);font-size:0.72rem;">${esc(p.note)}</span>` : '';
          formsHtml += `<div class="param-item">
            <label>${esc(p.name)} <span style="color:var(--text3);font-weight:400;">(${esc(p.unit)}) Ref: ${p.low}–${p.high}</span>${noteHtml}</label>
            <input type="number" step="0.01" min="${p.low}" max="${p.high}" id="rf_${idx}_${p.key}" value="${val}" placeholder="${p.low}–${p.high}" class="${flagCls}">
          </div>`;
        }
      });
      formsHtml += `</div><div id="rfInterp_${idx}" class="interp-box interp-normal">—</div>`;
    }
    else if (testType === 'complex_rft') {
      let data = {};
      try { if (test.result?.startsWith('{')) data = JSON.parse(test.result); } catch(e){}
      formsHtml += `<div class="param-grid">`;
      RFT_PARAMS_FULL.forEach(p => {
        let val = data[p.key] !== undefined ? data[p.key] : '';
        let flagCls = val !== '' ? getFlag(val, p) : '';
        formsHtml += `<div class="param-item">
          <label>${esc(p.name)} <span style="color:var(--text3);font-weight:400;">(${esc(p.unit)}) Ref: ${p.low}–${p.high}</span></label>
          <input type="number" step="0.1" min="${p.low}" max="${p.high}" id="rft_${idx}_${p.key}" value="${val}" placeholder="${p.low}–${p.high}" class="${flagCls}">
        </div>`;
      });
      formsHtml += `</div><div id="rftInterp_${idx}" class="interp-box interp-normal">—</div>`;
    }
    else if (testType === 'complex_thyroid') {
      let data = {};
      try { if (test.result?.startsWith('{')) data = JSON.parse(test.result); } catch(e){}
      formsHtml += `<div class="param-grid">`;
      THYROID_PARAMS.forEach(p => {
        let val = data[p.key] !== undefined ? data[p.key] : '';
        let flagCls = val !== '' ? getFlag(val, p) : '';
        formsHtml += `<div class="param-item">
          <label>${esc(p.name)} <span style="color:var(--text3);font-weight:400;">(${esc(p.unit)}) Ref: ${p.low}–${p.high}</span></label>
          <input type="number" step="0.1" min="${p.low}" max="${p.high}" id="thyroid_${idx}_${p.key}" value="${val}" placeholder="${p.low}–${p.high}" class="${flagCls}">
        </div>`;
      });
      formsHtml += `</div><div id="thyroidInterp_${idx}" class="interp-box interp-normal">—</div>`;
    }
    else if (testType === 'complex_hormone') {
      let data = {};
      try { if (test.result?.startsWith('{')) data = JSON.parse(test.result); } catch(e){}
      formsHtml += `<div style="font-size:0.78rem;color:var(--text2);margin-bottom:6px;">⚠ Reference ranges are gender &amp; phase-dependent — see printed report form.</div>`;
      formsHtml += `<div class="param-grid">`;
      HORMONE_PARAMS.forEach(p => {
        let val = data[p.key] !== undefined ? data[p.key] : '';
        formsHtml += `<div class="param-item">
          <label>${esc(p.name)} <span style="color:var(--text3);font-weight:400;">(${esc(p.unit)})</span></label>
          <input type="number" step="0.01" id="hormone_${idx}_${p.key}" value="${val}" placeholder="Enter value">
        </div>`;
      });
      formsHtml += `</div>`;
    }
    else if (testType === 'complex_marry') {
      let data = {};
      try { if (test.result?.startsWith('{')) data = JSON.parse(test.result); } catch(e){}
      formsHtml += `<div class="param-grid">`;
      MARRY_PARAMS.forEach(p => {
        let val = data[p.key] !== undefined ? data[p.key] : '';
        if (p.type === 'select') {
          formsHtml += `<div class="param-item">
            <label>${esc(p.name)}</label>
            <select id="marry_${idx}_${p.key}" class="filter-select">
              <option value="">— Select —</option>
              ${p.options.map(o => `<option value="${esc(o)}"${val===o?' selected':''}>${esc(o)}</option>`).join('')}
            </select>
          </div>`;
        } else {
          formsHtml += `<div class="param-item">
            <label>${esc(p.name)} <span style="color:var(--text3);font-weight:400;">(${esc(p.unit)})</span></label>
            <input type="number" step="0.01" id="marry_${idx}_${p.key}" value="${val}" placeholder="Enter value">
          </div>`;
        }
      });
      formsHtml += `</div>`;
    }
    else if (testType === 'complex_antenatal') {
      let data = {};
      try { if (test.result?.startsWith('{')) data = JSON.parse(test.result); } catch(e){}
      formsHtml += `<div class="param-grid">`;
      ANTENATAL_PARAMS.forEach(p => {
        let val = data[p.key] !== undefined ? data[p.key] : '';
        if (p.type === 'select') {
          formsHtml += `<div class="param-item">
            <label>${esc(p.name)}</label>
            <select id="antenatal_${idx}_${p.key}" class="filter-select">
              <option value="">— Select —</option>
              ${p.options.map(o => `<option value="${esc(o)}"${val===o?' selected':''}>${esc(o)}</option>`).join('')}
            </select>
          </div>`;
        } else {
          let flagCls = val !== '' ? getFlag(val, p) : '';
          formsHtml += `<div class="param-item">
            <label>${esc(p.name)} <span style="color:var(--text3);font-weight:400;">(${esc(p.unit)}) Ref: ${p.low}–${p.high}</span></label>
            <input type="number" step="0.1" id="antenatal_${idx}_${p.key}" value="${val}" placeholder="${p.low}–${p.high}" class="${flagCls}">
          </div>`;
        }
      });
      formsHtml += `</div>`;
    }
    else if (testType === 'complex_blood') {
      let data = {};
      try { if (test.result?.startsWith('{')) data = JSON.parse(test.result); } catch(e){}

      // Helper: render one param as input or select
      const bloodField = (p) => {
        if (!p) return '';
        let val = data[p.key] !== undefined ? data[p.key] : '';
        if (p.type === 'select') {
          return `<div class="param-item">
            <label>${esc(p.name)}</label>
            <select id="blood_${idx}_${p.key}" class="filter-select">
              <option value="">— Select —</option>
              ${p.options.map(o => `<option value="${esc(o)}"${val===o?' selected':''}>${esc(o)}</option>`).join('')}
            </select>
          </div>`;
        } else if (p.type === 'number') {
          return `<div class="param-item">
            <label>${esc(p.name)}${p.unit ? ` (${esc(p.unit)})` : ''}</label>
            <input type="number" step="any" id="blood_${idx}_${p.key}" value="${esc(val)}" placeholder="${esc(p.name)}">
          </div>`;
        } else {
          return `<div class="param-item">
            <label>${esc(p.name)}</label>
            <input type="text" id="blood_${idx}_${p.key}" value="${esc(val)}" placeholder="${esc(p.name)}">
          </div>`;
        }
      };

      // ── Section 2: Clinical Request Details ──
      formsHtml += `<div style="font-size:0.78rem;font-weight:600;color:var(--primary);margin-bottom:6px;padding:4px 0;border-bottom:1px solid var(--border);">📋 Section 2 — Clinical Request Details</div>`;
      formsHtml += `<div class="param-grid">`;
      ['transfusion_reason','inv_hb_electrophoresis','inv_type_screen','inv_full_crossmatch','result_hb','result_pcv']
        .forEach(k => { formsHtml += bloodField(BLOOD_TRANSFUSION_PARAMS.find(x => x.key === k)); });
      formsHtml += `</div>`;

      // ── Section 3: Blood Products Required ──
      formsHtml += `<div style="font-size:0.78rem;font-weight:600;color:var(--primary);margin:10px 0 6px;padding:4px 0;border-bottom:1px solid var(--border);">🩸 Section 3 — Blood Products Required</div>`;
      formsHtml += `<div class="param-grid">`;
      ['bp_whole_blood','bp_packed_cells','bp_platelet_concentrate','bp_ffp','bp_cryoprecipitate','bp_retroviral_screening','units_required','units_donated','date_required','time_required']
        .forEach(k => { formsHtml += bloodField(BLOOD_TRANSFUSION_PARAMS.find(x => x.key === k)); });
      formsHtml += `</div>`;

      // ── Section 5: Autologous Blood ──
      formsHtml += `<div style="font-size:0.78rem;font-weight:600;color:var(--primary);margin:10px 0 6px;padding:4px 0;border-bottom:1px solid var(--border);">🔬 Section 5 — Autologous Blood (if applicable)</div>`;
      formsHtml += `<div class="param-grid">`;
      ['autologous_units','type_of_surgery']
        .forEach(k => { formsHtml += bloodField(BLOOD_TRANSFUSION_PARAMS.find(x => x.key === k)); });
      formsHtml += `</div>`;

      // ── Section 6: Patient Serology ──
      formsHtml += `<div style="font-size:0.78rem;font-weight:600;color:var(--primary);margin:10px 0 6px;padding:4px 0;border-bottom:1px solid var(--border);">🩸 Section 6 — Patient Blood Group &amp; Serology</div>`;
      formsHtml += `<div class="param-grid">`;
      BLOOD_TRANSFUSION_PARAMS.filter(p => p.key.startsWith('patient_')).forEach(p => { formsHtml += bloodField(p); });
      formsHtml += `</div>`;

      // ── Section 6: Donor Serology ──
      formsHtml += `<div style="font-size:0.78rem;font-weight:600;color:var(--primary);margin:10px 0 6px;padding:4px 0;border-bottom:1px solid var(--border);">🩸 Section 6 — Donor Blood Group &amp; Serology</div>`;
      formsHtml += `<div class="param-grid">`;
      BLOOD_TRANSFUSION_PARAMS.filter(p => p.key.startsWith('donor_')).forEach(p => { formsHtml += bloodField(p); });
      formsHtml += `</div>`;

      // ── Section 7: Major Crossmatch ──
      formsHtml += `<div style="font-size:0.78rem;font-weight:600;color:var(--primary);margin:10px 0 6px;padding:4px 0;border-bottom:1px solid var(--border);">🔬 Section 7 — Major Crossmatch</div>`;
      formsHtml += `<div class="param-grid">`;
      ['xm_ns_result','xm_ns_remarks','xm_ba_result','xm_ba_remarks','xm_ahg_result','xm_ahg_remarks']
        .forEach(k => { formsHtml += bloodField(BLOOD_TRANSFUSION_PARAMS.find(x => x.key === k)); });
      formsHtml += `</div>`;

      // ── Section 8: Compatibility Outcome & Times ──
      formsHtml += `<div style="font-size:0.78rem;font-weight:600;color:var(--primary);margin:10px 0 6px;padding:4px 0;border-bottom:1px solid var(--border);">✅ Section 8 — Compatibility Outcome</div>`;
      formsHtml += `<div class="param-grid">`;
      ['blood_bag_no','crossmatch','time_issued','time_returned','time_reissued']
        .forEach(k => { formsHtml += bloodField(BLOOD_TRANSFUSION_PARAMS.find(x => x.key === k)); });
      formsHtml += `</div>`;

      formsHtml += `<div style="font-size:0.75rem;color:var(--text2);margin-top:10px;padding:8px;background:#f8fafb;border-radius:8px;">
        ✍ <strong>Grouping &amp; Crossmatch By:</strong> Name / Sign / Date — to be completed physically on printed form.<br>
        ✍ <strong>Grouping &amp; Crossmatch Checked By:</strong> Head of Unit / Sign / Date — to be completed physically on printed form.
      </div>`;
    }
    else if (testType === 'complex_lipid') {
      let data = {};
      try { if (test.result?.startsWith('{')) data = JSON.parse(test.result); } catch(e){}
      formsHtml += `<div class="param-grid">`;
      LIPID_PARAMS.forEach(p => {
        let val = data[p.key] !== undefined ? data[p.key] : '';
        let flagCls = val !== '' ? getFlag(val, p) : '';
        formsHtml += `<div class="param-item">
          <label>${esc(p.name)} <span style="color:var(--text3);font-weight:400;">(${esc(p.unit)}) Ref: ${p.low}–${p.high}</span></label>
          <input type="number" step="0.1" min="${p.low}" max="${p.high}" id="lipid_${idx}_${p.key}" value="${val}" placeholder="${p.low}–${p.high}" class="${flagCls}">
        </div>`;
      });
      formsHtml += `</div><div id="lipidInterp_${idx}" class="interp-box interp-normal">—</div>`;
    }
    else if (testType === 'complex_coag') {
      let data = {};
      try { if (test.result?.startsWith('{')) data = JSON.parse(test.result); } catch(e){}
      formsHtml += `<div class="param-grid">`;
      COAG_PARAMS.forEach(p => {
        let val = data[p.key] !== undefined ? data[p.key] : '';
        let flagCls = val !== '' ? getFlag(val, p) : '';
        formsHtml += `<div class="param-item">
          <label>${esc(p.name)} <span style="color:var(--text3);font-weight:400;">(${esc(p.unit)}) Ref: ${p.low}–${p.high}</span></label>
          <input type="number" step="0.1" min="${p.low}" max="${p.high}" id="coag_${idx}_${p.key}" value="${val}" placeholder="${p.low}–${p.high}" class="${flagCls}">
        </div>`;
      });
      formsHtml += `</div><div id="coagInterp_${idx}" class="interp-box interp-normal">—</div>`;
    }
    else if (testType === 'complex_culture' || testType === 'complex_stool_cs') {
      let data = {};
      try { if (test.result?.startsWith('{')) data = JSON.parse(test.result); } catch(e){}
      let organism = data.organism || '';
      let sensitivities = data.sensitivities || [];
      let containerId = `sens_${idx}`;
      formsHtml += `
        <div class="param-item">
          <label>Organism</label>
          <input type="text" id="culture_${idx}_organism" value="${esc(organism)}" placeholder="e.g., Escherichia coli, Salmonella spp., Staphylococcus aureus">
        </div>
        <div class="param-item" style="margin-top:8px;">
          <label>Antibiotic Sensitivities (S = Sensitive, I = Intermediate, R = Resistant)</label>
          <div id="${containerId}" style="margin-bottom:8px;">
            ${sensitivities.map((s, sidx) => `
              <div data-ab-row style="display:flex; gap:8px; align-items:center; margin-bottom:5px;">
                <input type="text" placeholder="Antibiotic" value="${esc(s.antibiotic)}" style="flex:2;" id="ab_${idx}_${sidx}_name">
                <select style="flex:1;" id="ab_${idx}_${sidx}_result">
                  <option value="S" ${s.result === 'S' ? 'selected' : ''}>S (Sensitive)</option>
                  <option value="I" ${s.result === 'I' ? 'selected' : ''}>I (Intermediate)</option>
                  <option value="R" ${s.result === 'R' ? 'selected' : ''}>R (Resistant)</option>
                </select>
                <button type="button" class="btn btn-danger btn-sm" onclick="removeSensitivityRow('${containerId}', this)">✖</button>
              </div>
            `).join('')}
          </div>
          <button type="button" class="btn btn-secondary btn-sm" onclick="addSensitivityRow('${containerId}')">+ Add Antibiotic</button>
        </div>
      `;
    }
    else if (testType === 'complex_urinalysis') {
      let data = {};
      try { if (test.result?.startsWith('{')) data = JSON.parse(test.result); } catch(e){}
      formsHtml += `<div class="param-grid">`;
      URINALYSIS_MICRO_PARAMS.forEach(p => {
        let val = data[p.key] !== undefined ? data[p.key] : '';
        if (p.type === 'select') {
          formsHtml += `<div class="param-item"><label>${esc(p.name)}</label><select id="ua_${idx}_${p.key}">${p.options.map(opt => `<option value="${esc(opt)}" ${val === opt ? 'selected' : ''}>${esc(opt)}</option>`).join('')}</select></div>`;
        } else if (p.type === 'number') {
          let flagCls = val !== '' ? getFlag(val, p) : '';
          formsHtml += `<div class="param-item"><label>${esc(p.name)}${p.unit ? ` (${esc(p.unit)})` : ''} Ref: ${p.low}–${p.high}</label><input type="number" step="${p.step||'any'}" min="${p.low!==null?p.low:''}" max="${p.high!==null?p.high:''}" id="ua_${idx}_${p.key}" value="${val}" class="${flagCls}"></div>`;
        } else {
          formsHtml += `<div class="param-item"><label>${esc(p.name)}${p.unit ? ` (${esc(p.unit)})` : ''}</label><input type="text" id="ua_${idx}_${p.key}" value="${esc(val)}"></div>`;
        }
      });
      formsHtml += `</div><div id="uaInterp_${idx}" class="interp-box interp-normal">—</div>`;
    }
    else if (testType === 'complex_iron') {
      let data = {};
      try { if (test.result?.startsWith('{')) data = JSON.parse(test.result); } catch(e){}
      formsHtml += `<div class="param-grid">`;
      IRON_PARAMS.forEach(p => {
        let val = data[p.key] !== undefined ? data[p.key] : '';
        let flagCls = val !== '' ? getFlag(val, p) : '';
        formsHtml += `<div class="param-item"><label>${esc(p.name)} (${esc(p.unit)}) Ref: ${p.low}–${p.high}</label><input type="number" step="0.1" min="${p.low}" max="${p.high}" id="iron_${idx}_${p.key}" value="${val}" class="${flagCls}"></div>`;
      });
      formsHtml += `</div><div id="ironInterp_${idx}" class="interp-box interp-normal">—</div>`;
    }
    else if (testType === 'complex_bone') {
      let data = {};
      try { if (test.result?.startsWith('{')) data = JSON.parse(test.result); } catch(e){}
      formsHtml += `<div class="param-grid">`;
      BONE_PARAMS.forEach(p => {
        let val = data[p.key] !== undefined ? data[p.key] : '';
        let flagCls = val !== '' ? getFlag(val, p) : '';
        formsHtml += `<div class="param-item"><label>${esc(p.name)} (${esc(p.unit)}) Ref: ${p.low}–${p.high}</label><input type="number" step="0.1" min="${p.low}" max="${p.high}" id="bone_${idx}_${p.key}" value="${val}" class="${flagCls}"></div>`;
      });
      formsHtml += `</div><div id="boneInterp_${idx}" class="interp-box interp-normal">—</div>`;
    }
    else if (testType === 'complex_cardiac') {
      let data = {};
      try { if (test.result?.startsWith('{')) data = JSON.parse(test.result); } catch(e){}
      formsHtml += `<div class="param-grid">`;
      CARDIAC_PARAMS.forEach(p => {
        let val = data[p.key] !== undefined ? data[p.key] : '';
        let flagCls = val !== '' ? getFlag(val, p) : '';
        formsHtml += `<div class="param-item"><label>${esc(p.name)} (${esc(p.unit)}) Ref: ${p.low}–${p.high}</label><input type="number" step="0.1" min="${p.low}" max="${p.high}" id="cardiac_${idx}_${p.key}" value="${val}" class="${flagCls}"></div>`;
      });
      formsHtml += `</div><div id="cardiacInterp_${idx}" class="interp-box interp-normal">—</div>`;
    }
    else if (testType === 'complex_ogtt') {
      let data = {};
      try { if (test.result?.startsWith('{')) data = JSON.parse(test.result); } catch(e){}
      formsHtml += `<div class="param-grid">`;
      OGTT_PARAMS.forEach(p => {
        let val = data[p.key] !== undefined ? data[p.key] : '';
        let flagCls = val !== '' ? getFlag(val, p) : '';
        formsHtml += `<div class="param-item"><label>${esc(p.name)} (${esc(p.unit)}) Ref: ${p.low}–${p.high}</label><input type="number" step="1" min="${p.low}" max="${p.high}" id="ogtt_${idx}_${p.key}" value="${val}" class="${flagCls}"></div>`;
      });
      formsHtml += `</div><div id="ogttInterp_${idx}" class="interp-box interp-normal">—</div>`;
    }
    else if (testType === 'complex_malaria') {
      let data = {};
      try { if (test.result?.startsWith('{')) data = JSON.parse(test.result); } catch(e){}
      formsHtml += `<div class="param-grid">`;
      MALARIA_PARAMS.forEach(p => {
        let val = data[p.key] !== undefined ? data[p.key] : '';
        if (p.type === 'select') {
          formsHtml += `<div class="param-item"><label>${esc(p.name)}</label><select id="malaria_${idx}_${p.key}">${p.options.map(opt => `<option value="${esc(opt)}" ${val === opt ? 'selected' : ''}>${esc(opt)}</option>`).join('')}</select></div>`;
        } else {
          let flagCls = val !== '' ? getFlag(val, p) : '';
          formsHtml += `<div class="param-item"><label>${esc(p.name)} (${esc(p.unit)})</label><input type="number" step="1" min="0" id="malaria_${idx}_${p.key}" value="${val}" class="${flagCls}"></div>`;
        }
      });
      formsHtml += `</div><div id="malariaInterp_${idx}" class="interp-box interp-normal">—</div>`;
    }
    else if (testType === 'complex_tb_genexpert') {
      let data = {};
      try { if (test.result?.startsWith('{')) data = JSON.parse(test.result); } catch(e){}
      formsHtml += `<div class="param-grid">`;
      TB_GX_PARAMS.forEach(p => {
        let val = data[p.key] !== undefined ? data[p.key] : '';
        if (p.type === 'select') {
          formsHtml += `<div class="param-item"><label>${esc(p.name)}</label><select id="tb_${idx}_${p.key}">${p.options.map(opt => `<option value="${esc(opt)}" ${val === opt ? 'selected' : ''}>${esc(opt)}</option>`).join('')}</select></div>`;
        } else {
          formsHtml += `<div class="param-item"><label>${esc(p.name)}</label><input type="number" step="0.1" id="tb_${idx}_${p.key}" value="${val}"></div>`;
        }
      });
      formsHtml += `</div><div id="tbInterp_${idx}" class="interp-box interp-normal">—</div>`;
    }
    else if (testType === 'complex_csf') {
      let data = {};
      try { if (test.result?.startsWith('{')) data = JSON.parse(test.result); } catch(e){}
      formsHtml += `<div class="param-grid">`;
      CSF_PARAMS.forEach(p => {
        let val = data[p.key] !== undefined ? data[p.key] : '';
        if (p.type === 'select') {
          formsHtml += `<div class="param-item"><label>${esc(p.name)}</label><select id="csf_${idx}_${p.key}">${p.options.map(opt => `<option value="${esc(opt)}" ${val === opt ? 'selected' : ''}>${esc(opt)}</option>`).join('')}</select></div>`;
        } else {
          let flagCls = val !== '' ? getFlag(val, p) : '';
          formsHtml += `<div class="param-item"><label>${esc(p.name)} (${esc(p.unit)}) Ref: ${p.low}–${p.high}</label><input type="number" step="1" min="0" id="csf_${idx}_${p.key}" value="${val}" class="${flagCls}"></div>`;
        }
      });
      formsHtml += `</div><div id="csfInterp_${idx}" class="interp-box interp-normal">—</div>`;
    }
    else if (testType === 'complex_abg') {
      let data = {};
      try { if (test.result?.startsWith('{')) data = JSON.parse(test.result); } catch(e){}
      formsHtml += `<div class="param-grid">`;
      ABG_PARAMS.forEach(p => {
        let val = data[p.key] !== undefined ? data[p.key] : '';
        let flagCls = val !== '' ? getFlag(val, p) : '';
        formsHtml += `<div class="param-item"><label>${esc(p.name)} (${esc(p.unit)}) Ref: ${p.low}–${p.high}</label><input type="number" step="${p.step||0.01}" min="${p.low}" max="${p.high}" id="abg_${idx}_${p.key}" value="${val}" class="${flagCls}"></div>`;
      });
      formsHtml += `</div><div id="abgInterp_${idx}" class="interp-box interp-normal">—</div>`;
    }
    else if (testType === 'complex_semen') {
      let data = {};
      try { if (test.result?.startsWith('{')) data = JSON.parse(test.result); } catch(e){}
      formsHtml += `<div class="param-grid">`;
      SEMEN_PARAMS.forEach(p => {
        let val = data[p.key] !== undefined ? data[p.key] : '';
        if (p.type === 'select') {
          formsHtml += `<div class="param-item"><label>${esc(p.name)}</label><select id="semen_${idx}_${p.key}">${p.options.map(opt => `<option value="${esc(opt)}" ${val === opt ? 'selected' : ''}>${esc(opt)}</option>`).join('')}</select></div>`;
        } else if (p.type === 'text') {
          if (['time_produced','time_received','time_analysed','abstinence','wp_epithelial_cells','wp_pus_cells','wp_rbc','wp_other','gram_stain'].includes(p.key)) {
            formsHtml += `<div class="param-item"><label>${esc(p.name)}</label><input type="text" id="semen_${idx}_${p.key}" value="${esc(val)}"></div>`;
          } else {
            formsHtml += `<div class="param-item" style="grid-column:span 2"><label>${esc(p.name)}</label><textarea id="semen_${idx}_${p.key}" rows="2" placeholder="e.g. Azoospermia, Teratospermia, Oligospermia…" style="width:100%;resize:vertical;">${esc(val)}</textarea></div>`;
          }
        } else {
          let flagCls = val !== '' ? getFlag(val, p) : '';
          formsHtml += `<div class="param-item"><label>${esc(p.name)} (${esc(p.unit)}) Ref: ${p.low}–${p.high}</label><input type="number" step="${p.step||0.1}" min="${p.low}" max="${p.high}" id="semen_${idx}_${p.key}" value="${val}" class="${flagCls}"></div>`;
        }
      });
      formsHtml += `</div>`;

      // Culture & Sensitivity (organism + antibiotic sensitivities)
      let semenOrganism = data.organism || '';
      let semenSensitivities = data.sensitivities || [];
      let semenSensContainerId = `semen_sens_${idx}`;
      formsHtml += `
        <div class="mcs-section-label">Culture &amp; Sensitivity</div>
        <div class="param-item">
          <label>Organism Grown</label>
          <input type="text" id="semen_${idx}_organism" value="${esc(semenOrganism)}" placeholder="e.g. E. coli, Staphylococcus aureus, No growth after 48h">
        </div>
        <div class="param-item" style="margin-top:8px;">
          <label>Antibiotic Sensitivities</label>
          <div id="${semenSensContainerId}" style="margin-bottom:8px;">
            ${semenSensitivities.map((s, si) => `
              <div data-ab-row style="display:flex;gap:8px;align-items:center;margin-bottom:5px;">
                <input type="text" placeholder="Antibiotic" value="${esc(s.antibiotic)}" style="flex:2;" id="${semenSensContainerId}_ab_${si}_name">
                <select style="flex:1;" id="${semenSensContainerId}_ab_${si}_result">
                  <option value="S" ${s.result==='S'?'selected':''}>S (Sensitive)</option>
                  <option value="I" ${s.result==='I'?'selected':''}>I (Intermediate)</option>
                  <option value="R" ${s.result==='R'?'selected':''}>R (Resistant)</option>
                </select>
                <button type="button" class="btn btn-danger btn-sm" onclick="removeSensitivityRow('${semenSensContainerId}',this)">✖</button>
              </div>`).join('')}
          </div>
          <button type="button" class="btn btn-secondary btn-sm" onclick="addSensitivityRow('${semenSensContainerId}')">+ Add Antibiotic</button>
        </div>`;

      formsHtml += `<div id="semenInterp_${idx}" class="interp-box interp-normal">—</div>`;
    }
    else if (testType === 'complex_serology') {
      let data = {};
      try { if (test.result?.startsWith('{')) data = JSON.parse(test.result); } catch(e){}
      formsHtml += `<div class="param-grid">`;
      SEROLOGY_PARAMS.forEach(p => {
        let val = data[p.key] !== undefined ? data[p.key] : '';
        formsHtml += `<div class="param-item"><label>${esc(p.name)}</label><select id="sero_${idx}_${p.key}">
          ${p.options.map(opt => `<option value="${esc(opt)}" ${val === opt ? 'selected' : ''}>${esc(opt)}</option>`).join('')}
        </select></div>`;
      });
      formsHtml += `</div><div id="seroInterp_${idx}" class="interp-box interp-normal">—</div>`;
    }
    else if (testType === 'complex_urine_mcs') {
      let data = {};
      try { if (test.result?.startsWith('{')) data = JSON.parse(test.result); } catch(e){}
      const sections = ['Physical','Chemical','Microscopy'];
      sections.forEach(sec => {
        const secParams = URINE_MICRO_PARAMS.filter(p => p.section === sec);
        let secIcon = sec === 'Physical' ? '🧪' : sec === 'Chemical' ? '🔬' : '🦠';
        formsHtml += `<div class="mcs-section-label">${secIcon} ${sec}${sec==='Chemical'?' (Dipstick)':sec==='Microscopy'?' Examination':''}</div><div class="param-grid">`;
        secParams.forEach(p => {
          let val = data[p.key] !== undefined ? data[p.key] : '';
          if (p.type === 'select') {
            formsHtml += `<div class="param-item"><label>${esc(p.name)}${p.unit ? ` (${p.unit})` : ''}</label>
              <select id="umcs_${idx}_${p.key}">
                ${p.options.map(opt => `<option value="${esc(opt)}" ${val === opt ? 'selected' : ''}>${esc(opt)}</option>`).join('')}
              </select></div>`;
          } else if (p.type === 'number') {
            let flagCls = val !== '' && p.low !== undefined ? getFlag(val, p) : '';
            formsHtml += `<div class="param-item"><label>${esc(p.name)}${p.unit ? ` (${p.unit})` : ''}${p.low !== undefined ? ` Ref: ${p.low}–${p.high}` : ''}</label>
              <input type="number" step="${p.step||'any'}" id="umcs_${idx}_${p.key}" value="${val}" class="${flagCls}"></div>`;
          } else {
            formsHtml += `<div class="param-item param-item-full"><label>${esc(p.name)}</label>
              <input type="text" id="umcs_${idx}_${p.key}" value="${esc(val)}" placeholder="Any additional microscopy findings…"></div>`;
          }
        });
        formsHtml += `</div>`;
      });
      let organism = data.organism || '';
      let sensitivities = data.sensitivities || [];
      let containerId = `umcs_sens_${idx}`;
      formsHtml += `
        <div class="mcs-section-label">Culture &amp; Sensitivity</div>
        <div class="param-item">
          <label>Organism Grown</label>
          <input type="text" id="umcs_${idx}_organism" value="${esc(organism)}" placeholder="e.g. E. coli, Klebsiella pneumoniae, No growth after 48h">
        </div>
        <div class="param-item" style="margin-top:8px;">
          <label>Antibiotic Sensitivities</label>
          <div id="${containerId}" style="margin-bottom:8px;">
            ${sensitivities.map((s, si) => `
              <div data-ab-row style="display:flex;gap:8px;align-items:center;margin-bottom:5px;">
                <input type="text" placeholder="Antibiotic" value="${esc(s.antibiotic)}" style="flex:2;" id="${containerId}_ab_${si}_name">
                <select style="flex:1;" id="${containerId}_ab_${si}_result">
                  <option value="S" ${s.result==='S'?'selected':''}>S (Sensitive)</option>
                  <option value="I" ${s.result==='I'?'selected':''}>I (Intermediate)</option>
                  <option value="R" ${s.result==='R'?'selected':''}>R (Resistant)</option>
                </select>
                <button type="button" class="btn btn-danger btn-sm" onclick="removeSensitivityRow('${containerId}',this)">✖</button>
              </div>`).join('')}
          </div>
          <button type="button" class="btn btn-secondary btn-sm" onclick="addSensitivityRow('${containerId}')">+ Add Antibiotic</button>
        </div>`;
    }
    else if (testType === 'complex_stool_mcs') {
      let data = {};
      try { if (test.result?.startsWith('{')) data = JSON.parse(test.result); } catch(e){}
      const sections = ['Macroscopy','Microscopy'];
      sections.forEach(sec => {
        const secParams = STOOL_MICRO_PARAMS.filter(p => p.section === sec);
        formsHtml += `<div class="mcs-section-label">${sec}</div><div class="param-grid">`;
        secParams.forEach(p => {
          let val = data[p.key] !== undefined ? data[p.key] : '';
          if (p.type === 'select') {
            formsHtml += `<div class="param-item"><label>${esc(p.name)}</label>
              <select id="smcs_${idx}_${p.key}">
                ${p.options.map(opt => `<option value="${esc(opt)}" ${val === opt ? 'selected' : ''}>${esc(opt)}</option>`).join('')}
              </select></div>`;
          } else {
            formsHtml += `<div class="param-item param-item-full"><label>${esc(p.name)}</label>
              <input type="text" id="smcs_${idx}_${p.key}" value="${esc(val)}" placeholder="Any additional findings…"></div>`;
          }
        });
        formsHtml += `</div>`;
      });
      let organism = data.organism || '';
      let sensitivities = data.sensitivities || [];
      let containerId = `smcs_sens_${idx}`;
      formsHtml += `
        <div class="mcs-section-label">Culture &amp; Sensitivity</div>
        <div class="param-item">
          <label>Organism Grown</label>
          <input type="text" id="smcs_${idx}_organism" value="${esc(organism)}" placeholder="e.g. Salmonella typhi, E. coli, No growth">
        </div>
        <div class="param-item" style="margin-top:8px;">
          <label>Antibiotic Sensitivities</label>
          <div id="${containerId}" style="margin-bottom:8px;">
            ${sensitivities.map((s, si) => `
              <div data-ab-row style="display:flex;gap:8px;align-items:center;margin-bottom:5px;">
                <input type="text" placeholder="Antibiotic" value="${esc(s.antibiotic)}" style="flex:2;" id="${containerId}_ab_${si}_name">
                <select style="flex:1;" id="${containerId}_ab_${si}_result">
                  <option value="S" ${s.result==='S'?'selected':''}>S (Sensitive)</option>
                  <option value="I" ${s.result==='I'?'selected':''}>I (Intermediate)</option>
                  <option value="R" ${s.result==='R'?'selected':''}>R (Resistant)</option>
                </select>
                <button type="button" class="btn btn-danger btn-sm" onclick="removeSensitivityRow('${containerId}',this)">✖</button>
              </div>`).join('')}
          </div>
          <button type="button" class="btn btn-secondary btn-sm" onclick="addSensitivityRow('${containerId}')">+ Add Antibiotic</button>
        </div>`;
    }
    // ── HISTOPATHOLOGY FORMS ─────────────────────────────────────────────────
    else if (testType === 'complex_histopath') {
      let data = {};
      try { if (test.result?.startsWith('{')) data = JSON.parse(test.result); } catch(e){}
      const hpSections = ['Request','Report'];
      hpSections.forEach(sec => {
        const secLabel = sec === 'Request' ? '📋 Request Details' : '🔬 Pathologist\'s Report';
        formsHtml += `<div class="mcs-section-label">${secLabel}</div><div class="param-grid">`;
        HISTOPATH_PARAMS.filter(p => p.section === sec).forEach(p => {
          let val = data[p.key] !== undefined ? data[p.key] : '';
          if (p.type === 'select') {
            formsHtml += `<div class="param-item"><label>${esc(p.name)}</label>
              <select id="hp_${idx}_${p.key}">
                ${p.options.map(opt => `<option value="${esc(opt)}" ${val===opt?'selected':''}>${esc(opt)}</option>`).join('')}
              </select></div>`;
          } else if (p.type === 'textarea') {
            formsHtml += `<div class="param-item param-item-full"><label>${esc(p.name)}${p.key==='diagnosis'||p.key==='clinical_info'?' <span style="color:#b91c1c;font-size:0.72rem;">(required)</span>':''}</label>
              <textarea id="hp_${idx}_${p.key}" rows="3" style="width:100%;resize:vertical;" placeholder="${p.key==='macro_desc'?'Describe gross appearance, dimensions, colour, consistency…':p.key==='micro_desc'?'Describe microscopic findings, cell types, patterns…':p.key==='diagnosis'?'Enter the final histopathological diagnosis…':'Enter comments or recommendations…'}">${esc(val)}</textarea></div>`;
          } else {
            formsHtml += `<div class="param-item"><label>${esc(p.name)}</label>
              <input type="text" id="hp_${idx}_${p.key}" value="${esc(val)}" placeholder="${p.key==='pathologist'?'Full name and qualifications':p.key==='lymph_nodes'?'e.g. 0/12 nodes positive':p.key==='margin_distance'?'e.g. Posterior margin, 4mm':p.key==='staging'?'e.g. pT2 N0 Mx':''}"></div>`;
          }
        });
        formsHtml += `</div>`;
      });
    }
    else if (testType === 'complex_fnac') {
      let data = {};
      try { if (test.result?.startsWith('{')) data = JSON.parse(test.result); } catch(e){}
      const fnacSections = ['Request','Report'];
      fnacSections.forEach(sec => {
        const secLabel = sec === 'Request' ? '📋 Request Details' : '🔬 Cytological Report';
        formsHtml += `<div class="mcs-section-label">${secLabel}</div><div class="param-grid">`;
        FNAC_PARAMS.filter(p => p.section === sec).forEach(p => {
          let val = data[p.key] !== undefined ? data[p.key] : '';
          if (p.type === 'select') {
            formsHtml += `<div class="param-item"><label>${esc(p.name)}</label>
              <select id="fnac_${idx}_${p.key}">
                ${p.options.map(opt => `<option value="${esc(opt)}" ${val===opt?'selected':''}>${esc(opt)}</option>`).join('')}
              </select></div>`;
          } else if (p.type === 'textarea') {
            formsHtml += `<div class="param-item param-item-full"><label>${esc(p.name)}</label>
              <textarea id="fnac_${idx}_${p.key}" rows="3" style="width:100%;resize:vertical;" placeholder="${p.key==='micro_desc'?'Describe cellular morphology and findings…':'Enter comments…'}">${esc(val)}</textarea></div>`;
          } else if (p.type === 'number') {
            let flagCls = val !== '' ? getFlag(val, p) : '';
            formsHtml += `<div class="param-item"><label>${esc(p.name)} ${p.unit ? `(${p.unit})` : ''}</label>
              <input type="number" step="0.1" id="fnac_${idx}_${p.key}" value="${val}" class="${flagCls}"></div>`;
          } else {
            formsHtml += `<div class="param-item"><label>${esc(p.name)}</label>
              <input type="text" id="fnac_${idx}_${p.key}" value="${esc(val)}" placeholder="${p.key==='site'?'e.g. Right thyroid lobe, Left breast mass':p.key==='pathologist'?'Full name and qualifications':''}"></div>`;
          }
        });
        formsHtml += `</div>`;
      });
    }
    else if (testType === 'complex_pap_smear') {
      let data = {};
      try { if (test.result?.startsWith('{')) data = JSON.parse(test.result); } catch(e){}
      const papSections = ['Request','Report'];
      papSections.forEach(sec => {
        const secLabel = sec === 'Request' ? '📋 Request Details' : '🔬 Cytological Report (Bethesda 2014)';
        formsHtml += `<div class="mcs-section-label">${secLabel}</div><div class="param-grid">`;
        PAP_SMEAR_PARAMS.filter(p => p.section === sec).forEach(p => {
          let val = data[p.key] !== undefined ? data[p.key] : '';
          if (p.type === 'select') {
            formsHtml += `<div class="param-item"><label>${esc(p.name)}</label>
              <select id="pap_${idx}_${p.key}">
                ${p.options.map(opt => `<option value="${esc(opt)}" ${val===opt?'selected':''}>${esc(opt)}</option>`).join('')}
              </select></div>`;
          } else if (p.type === 'textarea') {
            formsHtml += `<div class="param-item param-item-full"><label>${esc(p.name)}</label>
              <textarea id="pap_${idx}_${p.key}" rows="3" style="width:100%;resize:vertical;" placeholder="Enter additional comments…">${esc(val)}</textarea></div>`;
          } else {
            formsHtml += `<div class="param-item"><label>${esc(p.name)}</label>
              <input type="text" id="pap_${idx}_${p.key}" value="${esc(val)}" placeholder="${p.key==='lmp'?'e.g. 01/06/2026 or Unknown':p.key==='pathologist'?'Full name and qualifications':p.key==='clinical_info'?'e.g. Post-coital bleeding, routine screening':''}"></div>`;
          }
        });
        formsHtml += `</div>`;
      });
    }
    // ── END HISTOPATHOLOGY FORMS ──────────────────────────────────────────────
    else if (testType === 'complex_pcv' || testType === 'complex_hb' || testType === 'complex_esr' ||
             testType === 'complex_rbs' || testType === 'complex_fbs') {
      let val = test.result || '';
      let range = testDefinitions.refRanges[test.test_name];
      let label = 'Result (numeric)';
      if (range) {
        label = `Result (numeric) – Ref: ${range.low}–${range.high} ${range.unit}`;
      }
      formsHtml += `<div class="param-item">
        <label>${label}</label>
        <input type="number" step="any" id="textResult_${idx}" value="${esc(val)}" class="form-input">
      </div>`;
    }
    else if (testType === 'simple_select') {
      let options = testDefinitions.selectOptions[test.test_name] || ['Negative', 'Positive', 'Non‑reactive', 'Reactive', 'Not detected', 'Detected'];
      let val = test.result || '';
      formsHtml += `<div class="param-item">
        <label>Result</label>
        <select id="textResult_${idx}">
          ${options.map(opt => `<option value="${esc(opt)}" ${val === opt ? 'selected' : ''}>${esc(opt)}</option>`).join('')}
        </select>
      </div>`;
    }
    else {
      formsHtml += `<textarea id="textResult_${idx}" class="form-textarea" placeholder="Enter result…">${esc(test.result || '')}</textarea>`;
    }

    const isAlreadyReady = test.status === 'Ready';
    const isRejected = test.status === 'Rejected';
    const isOtherTechReady = isAlreadyReady && test.tech && test.tech !== (currentUser?.name || '');
    formsHtml += `</div>`; // close .test-block-body

    if (isRejected) {
      formsHtml += `
        <div class="test-done-row" id="doneRow_${idx}" style="background:#fff0f0; border:1.5px solid #fca5a5; border-radius:10px; padding:10px 14px; display:flex; align-items:center; justify-content:space-between; gap:10px;">
          <div style="color:#b91c1c; font-weight:700; font-size:0.85rem;">
            <i class="fas fa-ban"></i> Test Rejected
            ${test.rejection_reason ? `<span style="font-weight:400; margin-left:8px; font-size:0.78rem;">— ${esc(test.rejection_reason)}</span>` : ''}
          </div>
          <button type="button" class="btn btn-secondary btn-sm" onclick="resolveTestRejection(${idx})" style="font-size:0.75rem;">
            <i class="fas fa-undo"></i> Resolve & Re-enter
          </button>
        </div>`;
    } else {
      formsHtml += `
        <div class="test-done-row" id="doneRow_${idx}" style="display:flex; align-items:center; gap:8px;">
          ${isOtherTechReady
            ? `<div class="test-done-locked"><i class="fas fa-check-circle"></i> Entered by ${esc(test.tech)}</div>`
            : `<button
                type="button"
                class="test-done-btn ${isAlreadyReady ? 'is-done' : ''}"
                id="doneBtn_${idx}"
                onclick="toggleTestDone(${idx})"
              >
                <i class="fas ${isAlreadyReady ? 'fa-check-circle' : 'fa-circle'}"></i>
                <span>${isAlreadyReady ? 'Done ✓' : 'Mark as Done'}</span>
              </button>`
          }
          <button type="button" class="btn btn-sm" style="background:#fff0f0; color:#b91c1c; border:1.5px solid #fca5a5; font-size:0.75rem; padding:6px 12px; border-radius:8px;" onclick="openTestRejectModal(${idx})">
            <i class="fas fa-ban"></i> Reject Test
          </button>
        </div>`;
    }
    formsHtml += `</div>`; // close .test-block
  });
  if (testForms) testForms.innerHTML = formsHtml;

  // Auto‑save debouncers — 800 ms so results persist before Done/Reject toggles
  let _autoSaveTimer = null;
  function _triggerAutoSave() {
    clearTimeout(_autoSaveTimer);
    _autoSaveTimer = setTimeout(async () => {
      if (!currentSample) return;
      collectResultsFromForms();
      try { await saveSample(currentSample); showAutoSaveIndicator(); } catch(e) { /* silent */ }
    }, 800);
  }
  testForms.addEventListener('input', _triggerAutoSave);
  testForms.addEventListener('change', _triggerAutoSave);

  // Expose a flush helper so confirmTestReject / toggleTestDone can force-save
  // any pending typed results before changing test state.
  window._flushAutoSave = async function() {
    clearTimeout(_autoSaveTimer);
    if (!currentSample) return;
    collectResultsFromForms();
    try { await saveSample(currentSample); showAutoSaveIndicator(); } catch(e) {}
  };

  let cocHtml = COC_STEPS.map((step, i) => {
    let stepData = currentSample.coc[i] || { done: false, active: false };
    let done = stepData.done;
    let active = stepData.active;
    return `<div class="coc-event"><div class="coc-dot ${done ? 'done' : active ? 'active' : ''}">${done ? '✓' : active ? '⏳' : ''}</div><div class="coc-info">${step}</div></div>`;
  }).join('');
  if (cocTimeline) cocTimeline.innerHTML = cocHtml;

  document.getElementById('resultModal').style.display = 'flex';
  renderReadinessBar();

  const actionableOnOpen = currentSample.tests.filter(t => t.status !== 'Rejected');
  const allAlreadyReady = actionableOnOpen.length > 0 && actionableOnOpen.every(t => t.status === 'Ready');
  const sendBtn = document.getElementById('sendVerifyBtn');
  if (sendBtn) sendBtn.style.display = allAlreadyReady ? 'inline-flex' : 'none';
}

// ========== AUTO-SAVE INDICATOR ==========
function showAutoSaveIndicator() {
  let ind = document.getElementById('autoSaveInd');
  if (!ind) return;
  ind.textContent = '✓ Auto-saved';
  ind.style.opacity = '1';
  setTimeout(() => { ind.style.opacity = '0'; }, 2000);
}

// ========== PER-TEST DONE TOGGLE ==========
window.toggleTestDone = async function(idx) {
  if (!currentSample) return;
  const test = currentSample.tests[idx];
  if (!test) return;

  const btn  = document.getElementById(`doneBtn_${idx}`);
  const techName = currentUser?.name || currentUser?.username || currentUser?.id || 'Unknown Tech';

  const isDone = test.status === 'Ready' && (test.tech === techName || test.tech === 'Unknown Tech');

  if (isDone) {
    test.status = 'Processing';
    btn.classList.remove('is-done');
    btn.innerHTML = `<i class="fas fa-circle"></i><span>Mark as Done</span>`;
    collectSingleTestResult(idx);
    test.tech = techName;
    try {
      await saveSample(currentSample);
      showAutoSaveIndicator();
    } catch(e) { toast('Save failed', 'error'); return; }
    renderReadinessBar();
    return;
  }

  collectSingleTestResult(idx);
  const result = test.result;
  const isEmpty = !result || result.trim() === '' || result === '{}';
  if (isEmpty) {
    toast(`Enter results for ${test.test_name} first`, 'error');
    return;
  }

  test.tech   = techName;
  test.status = 'Ready';
  btn.classList.add('is-done');
  btn.innerHTML = `<i class="fas fa-check-circle"></i><span>Done ✓</span>`;

  try {
    await saveSample(currentSample);
    showAutoSaveIndicator();
    toast(`${test.test_name} marked done ✓`);
  } catch(e) {
    toast('Save failed — result not marked', 'error');
    test.status = 'Processing';
    btn.classList.remove('is-done');
    btn.innerHTML = `<i class="fas fa-circle"></i><span>Mark as Done</span>`;
    return;
  }

  renderReadinessBar();

  const techName2 = currentUser?.name || currentUser?.username || currentUser?.id || 'Unknown Tech';
  if (!test.done_by) test.done_by = techName2;
  if (!test.done_at) test.done_at = new Date().toISOString();

  const actionableTests = currentSample.tests.filter(t => t.status !== 'Rejected');
  const allActionableDone = actionableTests.length > 0 && actionableTests.every(t => t.status === 'Ready');

  if (allActionableDone) {
    const rejectedTests = currentSample.tests.filter(t => t.status === 'Rejected');
    const rejNote = rejectedTests.length
      ? ` (${rejectedTests.length} rejected test${rejectedTests.length > 1 ? 's' : ''} excluded)`
      : '';
    toast(`All actionable tests done — sending for verification…${rejNote}`, 'info');
    await addAudit('Tests Marked Ready', currentSample.id,
      `${techName2} toggled Done on ${test.test_name} — all actionable tests Ready, auto-sending${rejNote}`);
    setTimeout(() => sendToVerify(), 600);
    return;
  }

  const myTests = currentSample.tests.filter(t =>
    t.status !== 'Rejected' &&
    (!t.tech || t.tech === techName2 || t.tech === 'Unknown Tech')
  );
  const allMyDone = myTests.length > 0 && myTests.every(t => t.status === 'Ready');

  if (allMyDone && myTests.length < actionableTests.length) {
    const pendingTests = actionableTests.filter(t => t.status !== 'Ready');
    toast(`Your tests marked ready ✓ — waiting for: ${pendingTests.map(t => t.test_name).join(', ')}`, 'info');
    await addAudit('Tests Marked Ready', currentSample.id,
      `${techName2} completed their tests: ${myTests.map(t => t.test_name).join(', ')}`);
    renderReadinessBar();
  }
};

// ========== COLLECT SINGLE TEST RESULT ==========
function collectSingleTestResult(idx) {
  if (!currentSample) return;
  const test = currentSample.tests[idx];
  if (!test) return;
  const testType = getTestType(test.test_name);

  if (testType === 'complex_cbc') {
    let data = {};
    CBC_PARAMS.forEach(p => { let inp = document.getElementById(`cbc_${idx}_${p.key}`); if (inp && inp.value !== '') data[p.key] = parseFloat(inp.value); });
    test.result = JSON.stringify(data);
  } else if (testType === 'complex_widal') {
    const widalKeys = ['o','h','ao','ah','bo','bh','co','ch'];
    let data = {};
    widalKeys.forEach(k => { let v = document.getElementById(`widal_${idx}_${k}`)?.value; data[k] = (v && v !== '—') ? parseInt(v) : '—'; });
    test.result = JSON.stringify(data);
  } else if (testType === 'complex_lft') {
    let data = {};
    LFT_PARAMS_FULL.forEach(p => { let inp = document.getElementById(`lft_${idx}_${p.key}`); if (inp && inp.value !== '') data[p.key] = parseFloat(inp.value); });
    test.result = JSON.stringify(data);
  } else if (testType === 'complex_eucr') {
    let data = {};
    EUCR_PARAMS.forEach(p => {
      let inp = document.getElementById(`eucr_${idx}_${p.key}`);
      if (inp) data[p.key] = (p.type === 'number' || !p.type) ? (inp.value !== '' ? parseFloat(inp.value) : '') : inp.value;
    });
    test.result = JSON.stringify(data);
  } else if (testType === 'complex_calcium') {
    let data = {};
    CALCIUM_PARAMS.forEach(p => {
      let inp = document.getElementById(`calc_${idx}_${p.key}`);
      if (inp) data[p.key] = (p.type === 'number' || !p.type) ? (inp.value !== '' ? parseFloat(inp.value) : '') : inp.value;
    });
    test.result = JSON.stringify(data);
  } else if (testType === 'complex_phosphate') {
    let data = {};
    PHOSPHATE_PARAMS.forEach(p => {
      let inp = document.getElementById(`phos_${idx}_${p.key}`);
      if (inp) data[p.key] = (p.type === 'number' || !p.type) ? (inp.value !== '' ? parseFloat(inp.value) : '') : inp.value;
    });
    test.result = JSON.stringify(data);
  } else if (testType === 'complex_uric_acid') {
    let data = {};
    URIC_ACID_PARAMS.forEach(p => {
      let inp = document.getElementById(`uric_${idx}_${p.key}`);
      if (inp) data[p.key] = (p.type === 'number' || !p.type) ? (inp.value !== '' ? parseFloat(inp.value) : '') : inp.value;
    });
    test.result = JSON.stringify(data);
  } else if (testType === 'complex_total_protein') {
    let data = {};
    TOTAL_PROTEIN_PARAMS.forEach(p => {
      let inp = document.getElementById(`tp_${idx}_${p.key}`);
      if (inp) data[p.key] = (p.type === 'number' || !p.type) ? (inp.value !== '' ? parseFloat(inp.value) : '') : inp.value;
    });
    test.result = JSON.stringify(data);
  } else if (testType === 'complex_psa') {
    let data = {};
    PSA_PARAMS.forEach(p => {
      let inp = document.getElementById(`psa_${idx}_${p.key}`);
      if (inp) data[p.key] = (p.type === 'number' || !p.type) ? (inp.value !== '' ? parseFloat(inp.value) : '') : inp.value;
    });
    test.result = JSON.stringify(data);
  } else if (testType === 'complex_diabetes') {
    let data = {};
    DIABETES_PARAMS.forEach(p => {
      let inp = document.getElementById(`diab_${idx}_${p.key}`);
      if (inp) data[p.key] = (p.type === 'number' || !p.type) ? (inp.value !== '' ? parseFloat(inp.value) : '') : inp.value;
    });
    test.result = JSON.stringify(data);
  } else if (testType === 'complex_rf') {
    let data = {};
    RF_PARAMS.forEach(p => {
      let inp = document.getElementById(`rf_${idx}_${p.key}`);
      if (inp) data[p.key] = (p.type === 'number' || !p.type) ? (inp.value !== '' ? parseFloat(inp.value) : '') : inp.value;
    });
    test.result = JSON.stringify(data);
  } else if (testType === 'complex_rft') {
    let data = {};
    RFT_PARAMS_FULL.forEach(p => { let inp = document.getElementById(`rft_${idx}_${p.key}`); if (inp && inp.value !== '') data[p.key] = parseFloat(inp.value); });
    test.result = JSON.stringify(data);
  } else if (testType === 'complex_thyroid') {
    let data = {};
    THYROID_PARAMS.forEach(p => { let inp = document.getElementById(`thyroid_${idx}_${p.key}`); if (inp && inp.value !== '') data[p.key] = parseFloat(inp.value); });
    test.result = JSON.stringify(data);
  } else if (testType === 'complex_hormone') {
    let data = {};
    HORMONE_PARAMS.forEach(p => { let inp = document.getElementById(`hormone_${idx}_${p.key}`); if (inp && inp.value !== '') data[p.key] = parseFloat(inp.value); });
    test.result = JSON.stringify(data);
  } else if (testType === 'complex_marry') {
    let data = {};
    MARRY_PARAMS.forEach(p => { let inp = document.getElementById(`marry_${idx}_${p.key}`); if (inp && inp.value !== '') data[p.key] = inp.value; });
    test.result = JSON.stringify(data);
  } else if (testType === 'complex_antenatal') {
    let data = {};
    ANTENATAL_PARAMS.forEach(p => {
      let inp = document.getElementById(`antenatal_${idx}_${p.key}`);
      if (inp && inp.value !== '') data[p.key] = (p.type === 'select') ? inp.value : parseFloat(inp.value);
    });
    test.result = JSON.stringify(data);
  } else if (testType === 'complex_blood') {
    let data = {};
    BLOOD_TRANSFUSION_PARAMS.forEach(p => {
      let inp = document.getElementById(`blood_${idx}_${p.key}`);
      if (inp && inp.value !== '') data[p.key] = inp.value;
    });
    test.result = JSON.stringify(data);
  } else if (testType === 'complex_lipid') {
    let data = {};
    LIPID_PARAMS.forEach(p => { let inp = document.getElementById(`lipid_${idx}_${p.key}`); if (inp && inp.value !== '') data[p.key] = parseFloat(inp.value); });
    test.result = JSON.stringify(data);
  } else if (testType === 'complex_coag') {
    let data = {};
    COAG_PARAMS.forEach(p => { let inp = document.getElementById(`coag_${idx}_${p.key}`); if (inp && inp.value !== '') data[p.key] = parseFloat(inp.value); });
    test.result = JSON.stringify(data);
  } else if (testType === 'complex_culture' || testType === 'complex_stool_cs') {
    let organism = document.getElementById(`culture_${idx}_organism`)?.value || '';
    let sensitivities = [];
    let container = document.getElementById(`sens_${idx}`);
    if (container) {
      container.querySelectorAll('div[data-ab-row]').forEach(row => {
        let n = row.querySelector('input[type="text"]'), s = row.querySelector('select');
        if (n && s && n.value.trim()) sensitivities.push({ antibiotic: n.value.trim(), result: s.value });
      });
    }
    test.result = JSON.stringify({ organism, sensitivities });
  } else if (testType === 'complex_urine_mcs') {
    let data = {};
    URINE_MICRO_PARAMS.forEach(p => { let inp = document.getElementById(`umcs_${idx}_${p.key}`); if (inp) data[p.key] = p.type === 'number' ? (inp.value !== '' ? parseFloat(inp.value) : '') : inp.value; });
    data.organism = document.getElementById(`umcs_${idx}_organism`)?.value || '';
    let s2 = []; let c2 = document.getElementById(`umcs_sens_${idx}`);
    if (c2) c2.querySelectorAll('div[data-ab-row]').forEach(row => { let n = row.querySelector('input[type="text"]'), s = row.querySelector('select'); if (n && s && n.value.trim()) s2.push({ antibiotic: n.value.trim(), result: s.value }); });
    data.sensitivities = s2;
    test.result = JSON.stringify(data);
  } else if (testType === 'complex_stool_mcs') {
    let data = {};
    STOOL_MICRO_PARAMS.forEach(p => { let inp = document.getElementById(`smcs_${idx}_${p.key}`); if (inp) data[p.key] = inp.value; });
    data.organism = document.getElementById(`smcs_${idx}_organism`)?.value || '';
    let s3 = []; let c3 = document.getElementById(`smcs_sens_${idx}`);
    if (c3) c3.querySelectorAll('div[data-ab-row]').forEach(row => { let n = row.querySelector('input[type="text"]'), s = row.querySelector('select'); if (n && s && n.value.trim()) s3.push({ antibiotic: n.value.trim(), result: s.value }); });
    data.sensitivities = s3;
    test.result = JSON.stringify(data);
  } else if (testType === 'complex_urinalysis') {
    let data = {};
    URINALYSIS_MICRO_PARAMS.forEach(p => { let inp = document.getElementById(`ua_${idx}_${p.key}`); if (inp) data[p.key] = inp.value; });
    test.result = JSON.stringify(data);
  } else if (testType === 'complex_iron') {
    let data = {};
    IRON_PARAMS.forEach(p => { let inp = document.getElementById(`iron_${idx}_${p.key}`); if (inp && inp.value !== '') data[p.key] = parseFloat(inp.value); });
    test.result = JSON.stringify(data);
  } else if (testType === 'complex_bone') {
    let data = {};
    BONE_PARAMS.forEach(p => { let inp = document.getElementById(`bone_${idx}_${p.key}`); if (inp && inp.value !== '') data[p.key] = parseFloat(inp.value); });
    test.result = JSON.stringify(data);
  } else if (testType === 'complex_cardiac') {
    let data = {};
    CARDIAC_PARAMS.forEach(p => { let inp = document.getElementById(`cardiac_${idx}_${p.key}`); if (inp && inp.value !== '') data[p.key] = parseFloat(inp.value); });
    test.result = JSON.stringify(data);
  } else if (testType === 'complex_ogtt') {
    let data = {};
    OGTT_PARAMS.forEach(p => { let inp = document.getElementById(`ogtt_${idx}_${p.key}`); if (inp && inp.value !== '') data[p.key] = parseFloat(inp.value); });
    test.result = JSON.stringify(data);
  } else if (testType === 'complex_malaria') {
    let data = {};
    MALARIA_PARAMS.forEach(p => { let inp = document.getElementById(`malaria_${idx}_${p.key}`); if (inp) data[p.key] = p.type === 'number' ? parseFloat(inp.value) : inp.value; });
    test.result = JSON.stringify(data);
  } else if (testType === 'complex_tb_genexpert') {
    let data = {};
    TB_GX_PARAMS.forEach(p => { let inp = document.getElementById(`tb_${idx}_${p.key}`); if (inp) data[p.key] = inp.value; });
    test.result = JSON.stringify(data);
  } else if (testType === 'complex_csf') {
    let data = {};
    CSF_PARAMS.forEach(p => { let inp = document.getElementById(`csf_${idx}_${p.key}`); if (inp) data[p.key] = p.type === 'number' ? parseFloat(inp.value) : inp.value; });
    test.result = JSON.stringify(data);
  } else if (testType === 'complex_abg') {
    let data = {};
    ABG_PARAMS.forEach(p => { let inp = document.getElementById(`abg_${idx}_${p.key}`); if (inp && inp.value !== '') data[p.key] = parseFloat(inp.value); });
    test.result = JSON.stringify(data);
  } else if (testType === 'complex_semen') {
    let data = {};
    SEMEN_PARAMS.forEach(p => { let inp = document.getElementById(`semen_${idx}_${p.key}`); if (inp) data[p.key] = p.type === 'number' ? parseFloat(inp.value) : inp.value; });
    data.organism = document.getElementById(`semen_${idx}_organism`)?.value || '';
    let semenSens = []; let semenSensC = document.getElementById(`semen_sens_${idx}`);
    if (semenSensC) semenSensC.querySelectorAll('div[data-ab-row]').forEach(row => { let n = row.querySelector('input[type="text"]'), s = row.querySelector('select'); if (n && s && n.value.trim()) semenSens.push({ antibiotic: n.value.trim(), result: s.value }); });
    data.sensitivities = semenSens;
    test.result = JSON.stringify(data);
  } else if (testType === 'complex_serology') {
    let data = {};
    SEROLOGY_PARAMS.forEach(p => { let inp = document.getElementById(`sero_${idx}_${p.key}`); if (inp) data[p.key] = inp.value; });
    test.result = JSON.stringify(data);
  } else if (testType === 'complex_histopath') {
    let data = {};
    HISTOPATH_PARAMS.forEach(p => { let inp = document.getElementById(`hp_${idx}_${p.key}`); if (inp) data[p.key] = inp.value; });
    test.result = JSON.stringify(data);
  } else if (testType === 'complex_fnac') {
    let data = {};
    FNAC_PARAMS.forEach(p => { let inp = document.getElementById(`fnac_${idx}_${p.key}`); if (inp) data[p.key] = p.type === 'number' ? (inp.value !== '' ? parseFloat(inp.value) : '') : inp.value; });
    test.result = JSON.stringify(data);
  } else if (testType === 'complex_pap_smear') {
    let data = {};
    PAP_SMEAR_PARAMS.forEach(p => { let inp = document.getElementById(`pap_${idx}_${p.key}`); if (inp) data[p.key] = inp.value; });
    test.result = JSON.stringify(data);
  } else if (testType === 'complex_pcv' || testType === 'complex_hb' || testType === 'complex_esr' ||
             testType === 'complex_rbs' || testType === 'complex_fbs') {
    let inp = document.getElementById(`textResult_${idx}`);
    if (inp) test.result = inp.value;
  } else if (testType === 'simple_numeric' || testType === 'simple_select') {
    let ta = document.getElementById(`textResult_${idx}`);
    if (ta) test.result = ta.value;
  }
  else {
    let ta = document.getElementById(`textResult_${idx}`);
    if (ta) test.result = ta.value;
  }
  if (test.status !== 'Ready') {
    test.tech = currentUser?.name || currentUser?.username || currentUser?.id || 'Unknown Tech';
  }
}

// ========== COLLECT RESULTS FROM FORMS ==========
function collectResultsFromForms() {
  if (!currentSample) return;
  currentSample.tests.forEach((test, idx) => {
    let testType = getTestType(test.test_name);
    if (testType === 'complex_cbc') {
      let data = {};
      CBC_PARAMS.forEach(p => { let inp = document.getElementById(`cbc_${idx}_${p.key}`); if (inp && inp.value !== '') data[p.key] = parseFloat(inp.value); });
      test.result = JSON.stringify(data);
    } else if (testType === 'complex_widal') {
      const widalKeys = ['o','h','ao','ah','bo','bh','co','ch'];
      let data = {};
      widalKeys.forEach(k => { let val = document.getElementById(`widal_${idx}_${k}`)?.value; data[k] = (val && val !== '—') ? parseInt(val) : '—'; });
      test.result = JSON.stringify(data);
    } else if (testType === 'complex_lft') {
      let data = {};
      LFT_PARAMS_FULL.forEach(p => { let inp = document.getElementById(`lft_${idx}_${p.key}`); if (inp && inp.value !== '') data[p.key] = parseFloat(inp.value); });
      test.result = JSON.stringify(data);
    } else if (testType === 'complex_eucr') {
      let data = {};
      EUCR_PARAMS.forEach(p => {
        let inp = document.getElementById(`eucr_${idx}_${p.key}`);
        if (inp) data[p.key] = (p.type === 'number' || !p.type) ? (inp.value !== '' ? parseFloat(inp.value) : '') : inp.value;
      });
      test.result = JSON.stringify(data);
    } else if (testType === 'complex_calcium') {
      let data = {};
      CALCIUM_PARAMS.forEach(p => {
        let inp = document.getElementById(`calc_${idx}_${p.key}`);
        if (inp) data[p.key] = (p.type === 'number' || !p.type) ? (inp.value !== '' ? parseFloat(inp.value) : '') : inp.value;
      });
      test.result = JSON.stringify(data);
    } else if (testType === 'complex_phosphate') {
      let data = {};
      PHOSPHATE_PARAMS.forEach(p => {
        let inp = document.getElementById(`phos_${idx}_${p.key}`);
        if (inp) data[p.key] = (p.type === 'number' || !p.type) ? (inp.value !== '' ? parseFloat(inp.value) : '') : inp.value;
      });
      test.result = JSON.stringify(data);
    } else if (testType === 'complex_uric_acid') {
      let data = {};
      URIC_ACID_PARAMS.forEach(p => {
        let inp = document.getElementById(`uric_${idx}_${p.key}`);
        if (inp) data[p.key] = (p.type === 'number' || !p.type) ? (inp.value !== '' ? parseFloat(inp.value) : '') : inp.value;
      });
      test.result = JSON.stringify(data);
    } else if (testType === 'complex_total_protein') {
      let data = {};
      TOTAL_PROTEIN_PARAMS.forEach(p => {
        let inp = document.getElementById(`tp_${idx}_${p.key}`);
        if (inp) data[p.key] = (p.type === 'number' || !p.type) ? (inp.value !== '' ? parseFloat(inp.value) : '') : inp.value;
      });
      test.result = JSON.stringify(data);
    } else if (testType === 'complex_psa') {
      let data = {};
      PSA_PARAMS.forEach(p => {
        let inp = document.getElementById(`psa_${idx}_${p.key}`);
        if (inp) data[p.key] = (p.type === 'number' || !p.type) ? (inp.value !== '' ? parseFloat(inp.value) : '') : inp.value;
      });
      test.result = JSON.stringify(data);
    } else if (testType === 'complex_diabetes') {
      let data = {};
      DIABETES_PARAMS.forEach(p => {
        let inp = document.getElementById(`diab_${idx}_${p.key}`);
        if (inp) data[p.key] = (p.type === 'number' || !p.type) ? (inp.value !== '' ? parseFloat(inp.value) : '') : inp.value;
      });
      test.result = JSON.stringify(data);
    } else if (testType === 'complex_rf') {
      let data = {};
      RF_PARAMS.forEach(p => {
        let inp = document.getElementById(`rf_${idx}_${p.key}`);
        if (inp) data[p.key] = (p.type === 'number' || !p.type) ? (inp.value !== '' ? parseFloat(inp.value) : '') : inp.value;
      });
      test.result = JSON.stringify(data);

    } else if (testType === 'complex_rft') {
      let data = {};
      RFT_PARAMS_FULL.forEach(p => { let inp = document.getElementById(`rft_${idx}_${p.key}`); if (inp && inp.value !== '') data[p.key] = parseFloat(inp.value); });
      test.result = JSON.stringify(data);
    } else if (testType === 'complex_thyroid') {
      let data = {};
      THYROID_PARAMS.forEach(p => { let inp = document.getElementById(`thyroid_${idx}_${p.key}`); if (inp && inp.value !== '') data[p.key] = parseFloat(inp.value); });
      test.result = JSON.stringify(data);
    } else if (testType === 'complex_hormone') {
      let data = {};
      HORMONE_PARAMS.forEach(p => { let inp = document.getElementById(`hormone_${idx}_${p.key}`); if (inp && inp.value !== '') data[p.key] = parseFloat(inp.value); });
      test.result = JSON.stringify(data);
    } else if (testType === 'complex_marry') {
      let data = {};
      MARRY_PARAMS.forEach(p => { let inp = document.getElementById(`marry_${idx}_${p.key}`); if (inp && inp.value !== '') data[p.key] = inp.value; });
      test.result = JSON.stringify(data);
    } else if (testType === 'complex_antenatal') {
      let data = {};
      ANTENATAL_PARAMS.forEach(p => {
        let inp = document.getElementById(`antenatal_${idx}_${p.key}`);
        if (inp && inp.value !== '') data[p.key] = (p.type === 'select') ? inp.value : parseFloat(inp.value);
      });
      test.result = JSON.stringify(data);
    } else if (testType === 'complex_blood') {
      let data = {};
      BLOOD_TRANSFUSION_PARAMS.forEach(p => {
        let inp = document.getElementById(`blood_${idx}_${p.key}`);
        if (inp && inp.value !== '') data[p.key] = inp.value;
      });
      test.result = JSON.stringify(data);
    } else if (testType === 'complex_lipid') {
      let data = {};
      LIPID_PARAMS.forEach(p => { let inp = document.getElementById(`lipid_${idx}_${p.key}`); if (inp && inp.value !== '') data[p.key] = parseFloat(inp.value); });
      test.result = JSON.stringify(data);
    } else if (testType === 'complex_coag') {
      let data = {};
      COAG_PARAMS.forEach(p => { let inp = document.getElementById(`coag_${idx}_${p.key}`); if (inp && inp.value !== '') data[p.key] = parseFloat(inp.value); });
      test.result = JSON.stringify(data);
    } else if (testType === 'complex_culture' || testType === 'complex_stool_cs') {
      let organism = document.getElementById(`culture_${idx}_organism`)?.value || '';
      let sensitivities = [];
      let container = document.getElementById(`sens_${idx}`);
      if (container) {
        container.querySelectorAll('div[data-ab-row]').forEach(row => {
          let nameInput = row.querySelector('input[type="text"]');
          let select = row.querySelector('select');
          if (nameInput && select && nameInput.value.trim()) {
            sensitivities.push({ antibiotic: nameInput.value.trim(), result: select.value });
          }
        });
      }
      test.result = JSON.stringify({ organism, sensitivities });
    } else if (testType === 'complex_urine_mcs') {
      let data = {};
      URINE_MICRO_PARAMS.forEach(p => { let inp = document.getElementById(`umcs_${idx}_${p.key}`); if (inp) data[p.key] = p.type === 'number' ? (inp.value !== '' ? parseFloat(inp.value) : '') : inp.value; });
      data.organism = document.getElementById(`umcs_${idx}_organism`)?.value || '';
      let sensitivities = [];
      let container = document.getElementById(`umcs_sens_${idx}`);
      if (container) {
        container.querySelectorAll('div[data-ab-row]').forEach(row => {
          let nameInput = row.querySelector('input[type="text"]');
          let select = row.querySelector('select');
          if (nameInput && select && nameInput.value.trim()) {
            sensitivities.push({ antibiotic: nameInput.value.trim(), result: select.value });
          }
        });
      }
      data.sensitivities = sensitivities;
      test.result = JSON.stringify(data);
    } else if (testType === 'complex_stool_mcs') {
      let data = {};
      STOOL_MICRO_PARAMS.forEach(p => { let inp = document.getElementById(`smcs_${idx}_${p.key}`); if (inp) data[p.key] = inp.value; });
      data.organism = document.getElementById(`smcs_${idx}_organism`)?.value || '';
      let sensitivities = [];
      let container = document.getElementById(`smcs_sens_${idx}`);
      if (container) {
        container.querySelectorAll('div[data-ab-row]').forEach(row => {
          let nameInput = row.querySelector('input[type="text"]');
          let select = row.querySelector('select');
          if (nameInput && select && nameInput.value.trim()) {
            sensitivities.push({ antibiotic: nameInput.value.trim(), result: select.value });
          }
        });
      }
      data.sensitivities = sensitivities;
      test.result = JSON.stringify(data);
    } else if (testType === 'complex_urinalysis') {
      let data = {};
      URINALYSIS_MICRO_PARAMS.forEach(p => { let inp = document.getElementById(`ua_${idx}_${p.key}`); if (inp) data[p.key] = inp.value; });
      test.result = JSON.stringify(data);
    } else if (testType === 'complex_iron') {
      let data = {};
      IRON_PARAMS.forEach(p => { let inp = document.getElementById(`iron_${idx}_${p.key}`); if (inp && inp.value !== '') data[p.key] = parseFloat(inp.value); });
      test.result = JSON.stringify(data);
    } else if (testType === 'complex_bone') {
      let data = {};
      BONE_PARAMS.forEach(p => { let inp = document.getElementById(`bone_${idx}_${p.key}`); if (inp && inp.value !== '') data[p.key] = parseFloat(inp.value); });
      test.result = JSON.stringify(data);
    } else if (testType === 'complex_cardiac') {
      let data = {};
      CARDIAC_PARAMS.forEach(p => { let inp = document.getElementById(`cardiac_${idx}_${p.key}`); if (inp && inp.value !== '') data[p.key] = parseFloat(inp.value); });
      test.result = JSON.stringify(data);
    } else if (testType === 'complex_ogtt') {
      let data = {};
      OGTT_PARAMS.forEach(p => { let inp = document.getElementById(`ogtt_${idx}_${p.key}`); if (inp && inp.value !== '') data[p.key] = parseFloat(inp.value); });
      test.result = JSON.stringify(data);
    } else if (testType === 'complex_malaria') {
      let data = {};
      MALARIA_PARAMS.forEach(p => { let inp = document.getElementById(`malaria_${idx}_${p.key}`); if (inp) data[p.key] = p.type === 'number' ? parseFloat(inp.value) : inp.value; });
      test.result = JSON.stringify(data);
    } else if (testType === 'complex_tb_genexpert') {
      let data = {};
      TB_GX_PARAMS.forEach(p => { let inp = document.getElementById(`tb_${idx}_${p.key}`); if (inp) data[p.key] = inp.value; });
      test.result = JSON.stringify(data);
    } else if (testType === 'complex_csf') {
      let data = {};
      CSF_PARAMS.forEach(p => { let inp = document.getElementById(`csf_${idx}_${p.key}`); if (inp) data[p.key] = p.type === 'number' ? parseFloat(inp.value) : inp.value; });
      test.result = JSON.stringify(data);
    } else if (testType === 'complex_abg') {
      let data = {};
      ABG_PARAMS.forEach(p => { let inp = document.getElementById(`abg_${idx}_${p.key}`); if (inp && inp.value !== '') data[p.key] = parseFloat(inp.value); });
      test.result = JSON.stringify(data);
    } else if (testType === 'complex_semen') {
      let data = {};
      SEMEN_PARAMS.forEach(p => { let inp = document.getElementById(`semen_${idx}_${p.key}`); if (inp) data[p.key] = p.type === 'number' ? parseFloat(inp.value) : inp.value; });
      data.organism = document.getElementById(`semen_${idx}_organism`)?.value || '';
      let semenSensitivities = [];
      let semenSensContainer = document.getElementById(`semen_sens_${idx}`);
      if (semenSensContainer) {
        semenSensContainer.querySelectorAll('div[data-ab-row]').forEach(row => {
          let nameInput = row.querySelector('input[type="text"]');
          let select = row.querySelector('select');
          if (nameInput && select && nameInput.value.trim()) {
            semenSensitivities.push({ antibiotic: nameInput.value.trim(), result: select.value });
          }
        });
      }
      data.sensitivities = semenSensitivities;
      test.result = JSON.stringify(data);
    } else if (testType === 'complex_serology') {
      let data = {};
      SEROLOGY_PARAMS.forEach(p => { let inp = document.getElementById(`sero_${idx}_${p.key}`); if (inp) data[p.key] = inp.value; });
      test.result = JSON.stringify(data);
    } else if (testType === 'complex_histopath') {
      let data = {};
      HISTOPATH_PARAMS.forEach(p => { let inp = document.getElementById(`hp_${idx}_${p.key}`); if (inp) data[p.key] = inp.value; });
      test.result = JSON.stringify(data);
    } else if (testType === 'complex_fnac') {
      let data = {};
      FNAC_PARAMS.forEach(p => { let inp = document.getElementById(`fnac_${idx}_${p.key}`); if (inp) data[p.key] = p.type === 'number' ? (inp.value !== '' ? parseFloat(inp.value) : '') : inp.value; });
      test.result = JSON.stringify(data);
    } else if (testType === 'complex_pap_smear') {
      let data = {};
      PAP_SMEAR_PARAMS.forEach(p => { let inp = document.getElementById(`pap_${idx}_${p.key}`); if (inp) data[p.key] = inp.value; });
      test.result = JSON.stringify(data);
    } else if (testType === 'complex_pcv' || testType === 'complex_hb' || testType === 'complex_esr' ||
               testType === 'complex_rbs' || testType === 'complex_fbs') {
      let inp = document.getElementById(`textResult_${idx}`);
      if (inp) test.result = inp.value;
    } else {
      let ta = document.getElementById(`textResult_${idx}`);
      if (ta) test.result = ta.value;
    }
    if (test.status !== 'Ready') {
      test.tech   = currentUser?.name || currentUser?.username || currentUser?.id || 'Unknown Tech';
      test.status = 'Processing';
    }
  });
}

// ========== SAVE DRAFT & SEND TO VERIFY ==========
async function saveDraft() {
  if (!currentSample) return;
  collectResultsFromForms();
  const techName = currentUser?.name || currentUser?.username || currentUser?.id || 'Unknown Tech';
  for (let test of currentSample.tests) {
    if (!test.tech || test.tech === 'Unknown') test.tech = techName;
  }
  await saveSample(currentSample);
  await addAudit('Draft Saved', currentSample.id, `Draft saved by ${techName}`);
  toast('Draft saved ✓');
}

async function markMyTestsReady() {
  if (!currentSample) return;
  collectResultsFromForms();

  const techName = currentUser?.name || currentUser?.username || currentUser?.id || 'Unknown Tech';

  const myTests = currentSample.tests.filter(t =>
    t.status !== 'Ready' &&
    t.status !== 'Rejected' &&
    (!t.tech || t.tech === techName || t.tech === 'Unknown Tech')
  );

  if (!myTests.length) {
    toast('Your tests are already marked ready', 'warn');
    return;
  }

  // Only check completeness for non-rejected actionable tests
  const incomplete = myTests.filter(t =>
    t.status !== 'Rejected' &&
    (!t.result || t.result.trim() === '' || t.result === '{}')
  );
  if (incomplete.length) {
    toast(`Please complete: ${incomplete.map(t => t.test_name).join(', ')}`, 'error');
    return;
  }

  for (let test of myTests) {
    test.tech    = techName;
    test.done_by = techName;
    test.done_at = test.done_at || new Date().toISOString();
    test.status  = 'Ready';
  }

  await saveSample(currentSample);
  await addAudit('Tests Marked Ready', currentSample.id, `${techName} marked ready: ${myTests.map(t => t.test_name).join(', ')}`);
  toast(`Your tests marked ready ✓`);

  // Check in-memory state first (already up to date from the loop above)
  const actionableTests = currentSample.tests.filter(t => t.status !== 'Rejected');
  const allReady = actionableTests.every(t => t.status === 'Ready') && actionableTests.length > 0;

  if (allReady) {
    await sendToVerify();
  } else {
    renderReadinessBar();
    const remaining = currentSample.tests.filter(t => t.status !== 'Ready' && t.status !== 'Rejected').map(t => t.test_name);
    if (remaining.length) toast(`Waiting for: ${remaining.join(', ')}`, 'warn');
  }
}

function renderReadinessBar() {
  const bar = document.getElementById('readinessBar');
  if (!bar || !currentSample) return;

  const total = currentSample.tests.length;
  const ready = currentSample.tests.filter(t => t.status === 'Ready').length;
  const rejected = currentSample.tests.filter(t => t.status === 'Rejected').length;
  const actionable = total - rejected;

  if (total <= 1 && rejected === 0) { bar.style.display = 'none'; return; }

  const pct = actionable > 0 ? Math.round((ready / actionable) * 100) : 100;
  const items = currentSample.tests.map(t => {
    const icon = t.status === 'Ready' ? '✅' : t.status === 'Rejected' ? '🚫' : '⏳';
    const techLabel = t.tech && t.tech !== 'Unknown Tech' ? ` <span style="color:var(--muted)">(${esc(t.tech)})</span>` : '';
    const rejLabel = t.status === 'Rejected' && t.rejection_reason
      ? ` <span style="color:#b91c1c;font-size:0.7rem;">— ${esc(t.rejection_reason)}</span>` : '';
    return `<span style="margin-right:12px;">${icon} ${esc(t.test_name)}${techLabel}${rejLabel}</span>`;
  }).join('');

  bar.style.display = 'block';
  bar.innerHTML = `
    <div style="background:#f0f4f9; border-radius:12px; padding:10px 14px;">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
        <strong style="color:var(--primary);"><i class="fas fa-tasks"></i> Unit Progress</strong>
        <span style="font-weight:600;">${ready}/${actionable} actionable tests ready${rejected ? ` · ${rejected} rejected` : ''}</span>
      </div>
      <div style="background:#dde4ee; border-radius:40px; height:6px; margin-bottom:8px;">
        <div style="background:var(--primary); width:${pct}%; height:100%; border-radius:40px;"></div>
      </div>
      <div style="display:flex; flex-wrap:wrap; gap:4px;">${items}</div>
    </div>`;

  const sendBtn = document.getElementById('sendVerifyBtn');
  if (sendBtn) {
    const allActionableDone = actionable > 0 && ready === actionable;
    sendBtn.style.display = allActionableDone ? 'inline-flex' : 'none';
  }
}

async function sendToVerify() {
  if (!currentSample) return;

  const techName = currentUser?.name || currentUser?.username || currentUser?.id || 'Unknown Tech';

  const actionableTests = currentSample.tests.filter(t => t.status !== 'Rejected');
  const allActionableDone = actionableTests.length > 0 && actionableTests.every(t => t.status === 'Ready');

  if (!allActionableDone) {
    toast('Complete all non-rejected tests before sending to verification', 'error');
    return;
  }

  const rejectedTests = currentSample.tests.filter(t => t.status === 'Rejected');
  const rejectedNote = rejectedTests.length
    ? ` (${rejectedTests.length} test(s) rejected: ${rejectedTests.map(t => t.test_name).join(', ')})`
    : '';

  currentSample.status = 'Verifying';
  for (let test of currentSample.tests) {
    if (test.status !== 'Rejected') test.status = 'Verifying';
  }

  // Both online and offline samples go through the same path below.
  // saveSample / updateCOCEvent / addAudit are all patched by offline_queue.js
  // to queue automatically when offline or when sample id is still OFFLINE-.
  await saveSample(currentSample);

  // Update COC: mark Result Entry done, Verification active.
  // Try update first; if 0 rows affected (step doesn't exist), insert it.
  const now = new Date().toISOString();
  const actor = techName;
  const sid = currentSample.id;

  async function _cocEnsureStep(stepIndex, stepName, done, active, actorName) {
    const { data, error } = await db.from('coc_events')
      .update({ done, active, actor_name: actorName, occurred_at: now })
      .match({ sample_id: sid, step_index: stepIndex })
      .select('id');
    if (error || !data || data.length === 0) {
      // Row missing — insert it
      await db.from('coc_events')
        .insert({ sample_id: sid, step_index: stepIndex, step_name: stepName,
                  done, active, actor_name: actorName, occurred_at: now })
        .catch(() => {}); // ignore if duplicate race
    }
  }

  // Mark all prior steps done (they should already be, but ensure they exist)
  await _cocEnsureStep(3, 'Processing',   true,  false, actor).catch(() => {});
  await _cocEnsureStep(4, 'Result Entry', true,  false, actor).catch(() => {});
  await _cocEnsureStep(5, 'Verification', false, true,  null ).catch(() => {});

  await addAudit('Sent to Verify', currentSample.id, `Actionable tests complete — sent by ${techName}${rejectedNote}`);
  toast(`MU-${currentSample.id} sent to verification ✓${rejectedNote ? ' — with rejected test(s)' : ''}`);
  closeModal();
  await renderProcessingSamples();
}

function closeModal() {
  const resultModal = document.getElementById('resultModal');
  if (resultModal) resultModal.style.display = 'none';
  currentSample = null;
}

// ========== PDF GENERATION ==========
// PDF generation is handled exclusively in management1.js (supervisor view).
// Result entry is for data capture only — no PDF output from this page.

// ========== REJECT SAMPLE ==========
function openRejectModal() {
  if (!currentSample) return;
  const modal = document.getElementById('rejectModal');
  const labelEl = document.getElementById('rejectModalSampleId');
  const input = document.getElementById('rejectionReasonInput');
  if (!modal) return;
  if (labelEl) labelEl.textContent = `MU-${currentSample.id} — ${currentSample.patient}`;
  if (input) input.value = '';
  modal.style.display = 'flex';
  setTimeout(() => input && input.focus(), 80);
}
window.closeRejectModal = function() {
  const modal = document.getElementById('rejectModal');
  if (modal) modal.style.display = 'none';
};
window.confirmReject = async function() {
  const input = document.getElementById('rejectionReasonInput');
  const reason = (input?.value || '').trim();
  if (!reason) {
    input && (input.style.borderColor = '#dc2626');
    input && input.focus();
    toast('Please enter a rejection reason', 'error');
    return;
  }
  if (!currentSample) return;

  const btn = document.querySelector('#rejectModal button[onclick="confirmReject()"]');
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Rejecting…'; }

  // Detect offline sample (id is null or starts with 'OFFLINE-')
  const isOfflineSample = !currentSample.id ||
    (typeof currentSample.id === 'string' && currentSample.id.startsWith('OFFLINE-'));

  try {
    if (isOfflineSample) {
      // Queue the whole-sample rejection — the sample hasn't synced to DB yet,
      // so we cannot pass the OFFLINE-xxx string as a DB integer id.
      if (typeof _oqEnqueue === 'function') {
        await _oqEnqueue('rejectSample', {
          sampleId: currentSample.id,
          reason,
          userName: currentUser?.name || 'Technologist',
          userRole: currentUser?.role || 'technologist'
        });
      }
      // Update local state so the UI reflects the rejection immediately
      currentSample.status = 'Rejected';
      currentSample.rejection_reason = reason;
      if (typeof _oqCacheSample === 'function') _oqCacheSample(currentSample).catch(() => {});
    } else {
      const { error } = await db
        .from('samples')
        .update({ status: 'Rejected', rejection_reason: reason })
        .eq('id', currentSample.id);
      if (error) throw error;

      // Also mark all tests as Rejected so they appear in the accession rejection panel
      await db.from('sample_tests')
        .update({ status: 'Rejected', rejection_reason: reason })
        .eq('sample_id', currentSample.id);

      try {
        await db.from('sample_timeline').insert([{
          sample_id: currentSample.id,
          event_type: 'Sample Rejected',
          event_description: reason,
          performed_by: currentUser?.name || 'Technologist',
          performed_role: currentUser?.role || 'technologist',
          created_at: new Date().toISOString()
        }]);
      } catch(e) { console.warn('[RE] timeline insert failed', e); }

      await addAudit('Sample Rejected', currentSample.id, reason);
    }

    toast(`MU-${currentSample.id} rejected — ${reason}`, 'warn');
    window.closeRejectModal();
    closeModal();
    await renderProcessingSamples();
  } catch(err) {
    toast('Rejection failed: ' + (err.message || err), 'error');
    console.error('[RE] rejectSample error', err);
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-ban"></i> Confirm Rejection'; }
  }
};

// ========== PER-TEST REJECT / RESOLVE ==========
const TEST_REJECT_REASONS = [
  'Sample clotted',
  'Haemolysed sample',
  'Insufficient volume',
  'Wrong container / tube',
  'Sample leaked / contaminated',
  'Unlabelled sample',
  'Sample too old / delayed',
  'Other (see note)'
];

window.openTestRejectModal = function(idx) {
  if (!currentSample) return;
  const test = currentSample.tests[idx];
  if (!test) return;

  let existing = document.getElementById('testRejectModal');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'testRejectModal';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.55);display:flex;align-items:center;justify-content:center;z-index:9999;';
  overlay.innerHTML = `
    <div style="background:#fff;border-radius:20px;max-width:420px;width:94%;padding:28px 24px;box-shadow:0 20px 60px rgba(0,0,0,0.2);">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:18px;">
        <h3 style="font-size:1rem;color:#b91c1c;"><i class="fas fa-ban"></i> Reject Test</h3>
        <button onclick="document.getElementById('testRejectModal').remove()" style="background:none;border:none;font-size:1.3rem;cursor:pointer;color:#6b7280;">✕</button>
      </div>
      <p style="font-size:0.82rem;color:#374151;margin-bottom:14px;">
        Rejecting: <strong>${esc(test.test_name)}</strong> on sample <strong>MU-${currentSample.id}</strong><br>
        <span style="color:#6b7280;">Other tests on this sample will continue normally.</span>
      </p>
      <label style="font-size:0.72rem;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:#6b7280;display:block;margin-bottom:8px;">Rejection Reason</label>
      <div style="display:flex;flex-direction:column;gap:6px;margin-bottom:12px;">
        ${TEST_REJECT_REASONS.map(r => `
          <button type="button" class="test-reject-reason-btn" onclick="selectTestRejectReason(this, '${esc(r)}')"
            style="text-align:left;padding:8px 12px;border:1.5px solid #e5e7eb;border-radius:10px;background:#f9fafb;cursor:pointer;font-size:0.82rem;transition:all .15s;">
            ${esc(r)}
          </button>`).join('')}
      </div>
      <input type="text" id="testRejectCustomReason" placeholder="Or type a custom reason…"
        style="width:100%;padding:10px 14px;border:1.5px solid #e5e7eb;border-radius:10px;font-size:0.85rem;margin-bottom:14px;outline:none;"
        oninput="document.querySelectorAll('.test-reject-reason-btn').forEach(b=>b.style.background='#f9fafb')">
      <div style="display:flex;gap:10px;justify-content:flex-end;">
        <button onclick="document.getElementById('testRejectModal').remove()" style="padding:9px 18px;border:1.5px solid #e5e7eb;border-radius:10px;background:#fff;cursor:pointer;font-size:0.85rem;">Cancel</button>
        <button onclick="confirmTestReject(${idx})" style="padding:9px 18px;border:none;border-radius:10px;background:#b91c1c;color:#fff;font-weight:700;cursor:pointer;font-size:0.85rem;">
          <i class="fas fa-ban"></i> Confirm Rejection
        </button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
};

window.selectTestRejectReason = function(btn, reason) {
  document.querySelectorAll('.test-reject-reason-btn').forEach(b => {
    b.style.background = '#f9fafb'; b.style.borderColor = '#e5e7eb'; b.style.color = '#374151';
  });
  btn.style.background = '#fff0f0'; btn.style.borderColor = '#fca5a5'; btn.style.color = '#b91c1c';
  const customInput = document.getElementById('testRejectCustomReason');
  if (customInput) customInput.value = reason;
};

window.confirmTestReject = async function(idx) {
  if (!currentSample) return;
  const test = currentSample.tests[idx];
  if (!test) return;

  const input = document.getElementById('testRejectCustomReason');
  const reason = (input?.value || '').trim();
  if (!reason) {
    if (input) { input.style.borderColor = '#dc2626'; input.focus(); }
    toast('Please enter or select a rejection reason', 'error');
    return;
  }

  // Flush any pending auto-save so all other tests' typed results are persisted
  // before we change this test's state (prevents overwriting on next save).
  if (typeof window._flushAutoSave === 'function') await window._flushAutoSave();

  test.status = 'Rejected';
  test.rejection_reason = reason;

  // Detect offline sample: id is null or starts with 'OFFLINE-'
  const isOfflineSample = !test.id || (typeof currentSample.id === 'string' && currentSample.id.startsWith('OFFLINE-'));

  try {
    if (isOfflineSample) {
      // Queue the rejection — test.id is null so we can't hit the DB yet
      if (typeof _oqEnqueue === 'function') {
        await _oqEnqueue('rejectTest', {
          sampleId: currentSample.id,
          testName: test.test_name,
          reason,
          userName: currentUser?.name || 'Technologist',
          userRole: currentUser?.role || 'technologist'
        });
      }
      // Update the local cache so UI reflects the rejection immediately
      if (typeof _oqCacheSample === 'function') _oqCacheSample(currentSample).catch(() => {});
    } else {
      const { error } = await db.from('sample_tests')
        .update({ status: 'Rejected', rejection_reason: reason })
        .eq('id', test.id);
      if (error) throw error;

      Promise.resolve(db.from('sample_timeline').insert([{
        sample_id: currentSample.id,
        event_type: 'Test Rejected',
        event_description: `${test.test_name}: ${reason}`,
        performed_by: currentUser?.name || 'Technologist',
        performed_role: currentUser?.role || 'technologist',
        created_at: new Date().toISOString()
      }])).catch(() => {});
    }

    // Always persist the full sample state immediately after rejection —
    // this ensures the cache reflects the rejection so that when the modal
    // re-opens (or after resolve) the test statuses are correct.
    collectResultsFromForms();
    if (typeof _oqCacheSample === 'function') _oqCacheSample(currentSample).catch(() => {});

    await addAudit('Test Rejected', currentSample.id, `${test.test_name} rejected: ${reason}`);
    toast(`${test.test_name} rejected — ${reason}`, 'warn');
    document.getElementById('testRejectModal')?.remove();

    const doneRow = document.getElementById(`doneRow_${idx}`);
    if (doneRow) {
      doneRow.style.cssText = 'background:#fff0f0;border:1.5px solid #fca5a5;border-radius:10px;padding:10px 14px;display:flex;align-items:center;justify-content:space-between;gap:10px;';
      doneRow.innerHTML = `
        <div style="color:#b91c1c;font-weight:700;font-size:0.85rem;">
          <i class="fas fa-ban"></i> Test Rejected
          <span style="font-weight:400;margin-left:8px;font-size:0.78rem;">— ${esc(reason)}</span>
        </div>
        <button type="button" class="btn btn-secondary btn-sm" onclick="resolveTestRejection(${idx})" style="font-size:0.75rem;">
          <i class="fas fa-undo"></i> Resolve & Re-enter
        </button>`;
    }

    renderReadinessBar();

    const actionable = currentSample.tests.filter(t => t.status !== 'Rejected');
    const allDone = actionable.length > 0 && actionable.every(t => t.status === 'Ready');
    const sendBtn = document.getElementById('sendVerifyBtn');
    if (sendBtn) sendBtn.style.display = allDone ? 'inline-flex' : 'none';

  } catch(err) {
    toast('Rejection failed: ' + (err.message || err), 'error');
  }
};

window.resolveTestRejection = async function(idx) {
  if (!currentSample) return;
  const test = currentSample.tests[idx];
  if (!test) return;

  if (!confirm(`Resolve rejection for "${test.test_name}"?\nThis will allow result entry again. Make sure a new sample has been collected.`)) return;

  test.status = 'Processing';
  test.rejection_reason = null;
  test.result = '';

  // If the sample was already sent to Verifying (because other tests were done),
  // pull it back to Processing so it reappears in result entry.
  const wasVerifying = currentSample.status === 'Verifying';
  if (wasVerifying) {
    currentSample.status = 'Processing';
    // Restore Verifying tests back to Ready so they keep their done status
    for (const t of currentSample.tests) {
      if (t.status === 'Verifying') t.status = 'Ready';
    }
  }

  const isOfflineSample = !test.id || (typeof currentSample.id === 'string' && currentSample.id.startsWith('OFFLINE-'));

  try {
    if (isOfflineSample) {
      if (typeof _oqEnqueue === 'function') {
        await _oqEnqueue('resolveTestRejection', {
          sampleId: currentSample.id,
          testName: test.test_name,
          userName: currentUser?.name || 'Technologist',
          userRole: currentUser?.role || 'technologist'
        });
      }
      if (typeof _oqCacheSample === 'function') _oqCacheSample(currentSample).catch(() => {});
    } else {
      // Clear the rejected test — wipe result/tech so re-entry is clean and
      // refresh won't bounce the status back to Rejected.
      const { error } = await db.from('sample_tests')
        .update({ status: 'Processing', rejection_reason: null, result: '', tech_name: '' })
        .eq('id', test.id);
      if (error) throw error;

      // If we pulled back from Verifying, restore the other tests to Ready in DB
      // and reset sample status + COC step
      if (wasVerifying) {
        for (const t of currentSample.tests) {
          if (t.status === 'Ready' && t.id) {
            await db.from('sample_tests')
              .update({ status: 'Ready' })
              .eq('id', t.id);
          }
        }
        await db.from('samples')
          .update({ status: 'Processing' })
          .eq('id', currentSample.id);
        // Reset COC: Result Entry step active, Verification step cleared
        await db.from('coc_events')
          .update({ done: false, active: true })
          .match({ sample_id: currentSample.id, step_index: 4 });
        await db.from('coc_events')
          .update({ done: false, active: false })
          .match({ sample_id: currentSample.id, step_index: 5 });
      } else {
        // Even if not from Verifying, persist the sample row update (status stays Processing)
        // so DB is consistent and a page refresh doesn't show stale state.
        await db.from('samples')
          .update({ status: 'Processing' })
          .eq('id', currentSample.id);
      }
    }

    await addAudit('Test Rejection Resolved', currentSample.id, `${test.test_name} — rejection cleared`);
    toast(`${test.test_name} restored for result entry ✓`);

    const doneRow = document.getElementById(`doneRow_${idx}`);
    if (doneRow) {
      doneRow.style.cssText = 'display:flex; align-items:center; gap:8px;';
      doneRow.innerHTML = `
        <button
          type="button"
          class="test-done-btn"
          id="doneBtn_${idx}"
          onclick="toggleTestDone(${idx})"
        >
          <i class="fas fa-circle"></i>
          <span>Mark as Done</span>
        </button>
        <button type="button" class="btn btn-sm" style="background:#fff0f0; color:#b91c1c; border:1.5px solid #fca5a5; font-size:0.75rem; padding:6px 12px; border-radius:8px;" onclick="openTestRejectModal(${idx})">
          <i class="fas fa-ban"></i> Reject Test
        </button>`;
    }

    // Only re-enable and clear inputs for the resolved (previously rejected) test.
    // Do NOT touch other tests' inputs, results, or Done button states.
    const testBlock = document.getElementById(`testBlock_${idx}`);
    if (testBlock) {
      testBlock.querySelectorAll('input, textarea, select').forEach(el => {
        el.disabled = false;
        el.style.opacity = '';
        el.style.pointerEvents = '';
      });
      // Clear only this test's result fields (needs re-collection from new sample)
      testBlock.querySelectorAll('input[type="number"], input[type="text"], textarea').forEach(el => {
        el.value = '';
        el.classList.remove('flag-inp-high', 'flag-inp-low');
      });
      testBlock.querySelectorAll('select').forEach(el => { el.selectedIndex = 0; });
    }

    // Restore Done ✓ button state for any tests that are already Ready
    currentSample.tests.forEach((t, i) => {
      if (i === idx) return; // skip the just-resolved test
      const btn = document.getElementById(`doneBtn_${i}`);
      if (!btn) return;
      if (t.status === 'Ready') {
        btn.classList.add('is-done');
        btn.innerHTML = `<i class="fas fa-check-circle"></i><span>Done ✓</span>`;
      }
    });

    renderReadinessBar();

    const actionable = currentSample.tests.filter(t => t.status !== 'Rejected');
    const alreadyReadyCount = actionable.filter(t => t.status === 'Ready').length;
    const totalActionable = actionable.length;
    if (alreadyReadyCount === totalActionable - 1) {
      toast(`Enter result for ${test.test_name} and mark Done to auto-send`, 'info');
    }

  } catch(err) {
    test.status = 'Rejected';
    toast('Resolve failed: ' + (err.message || err), 'error');
  }
};

// ========== EVENT LISTENERS ==========
document.getElementById('closeModalBtn')?.addEventListener('click', closeModal);
document.getElementById('closeModalBtn2')?.addEventListener('click', closeModal);
document.getElementById('saveDraftBtn')?.addEventListener('click', saveDraft);
document.getElementById('markReadyBtn')?.addEventListener('click', markMyTestsReady);
document.getElementById('sendVerifyBtn')?.addEventListener('click', sendToVerify);
document.getElementById('rejectSampleBtn')?.addEventListener('click', openRejectModal);
document.getElementById('resultModal')?.addEventListener('click', e => { if (e.target === document.getElementById('resultModal')) closeModal(); });
document.getElementById('sampleSearch')?.addEventListener('input', renderProcessingSamples);
document.getElementById('priorityFilter')?.addEventListener('change', renderProcessingSamples);
document.getElementById('refreshBtn')?.addEventListener('click', async () => { toast('Refreshing...', 'info'); await renderProcessingSamples(); toast('Samples refreshed', 'success'); });
document.addEventListener('keydown', e => {
  if (!currentSample) return;
  if (e.key === 'Escape') closeModal();
  if (e.ctrlKey && e.key === 's') { e.preventDefault(); saveDraft(); }
  if (e.ctrlKey && e.key === 'Enter') sendToVerify();
});

// ========== INIT (simple, reliable) ==========
(async function init() {
  if (!currentUser) {
    window.location.href = 'index.html';
    return;
  }

  await loadTestDefinitions();
  await renderProcessingSamples();
  startClock();

  const userName = currentUser?.name || currentUser?.username || currentUser?.email || currentUser?.id || 'Technologist';
  const userDisplay = document.getElementById('userDisplay');
  if (userDisplay) {
    userDisplay.innerHTML = `<i class="fas fa-user-circle"></i> ${esc(userName)} (${esc(currentUser?.role || 'user')})`;
  }

  const logoutBtn = document.getElementById('logoutBtn');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', async () => {
      if (typeof window.logoutUser === 'function') {
        await window.logoutUser();
      } else if (typeof logoutUser === 'function') {
        await logoutUser();
      } else {
        localStorage.clear();
        sessionStorage.clear();
        window.location.href = 'index.html';
      }
    });
  }
})();

// ── 15-second background refresh ─────────────────────────────────────────
// Guard flag prevents a second interval tick from firing a concurrent
// loadSamples() call if the previous one is still in flight on a slow connection.
let _autoRefreshRunning = false;
setInterval(async () => {
  if (!navigator.onLine) return;
  if (_autoRefreshRunning) return; // previous refresh still in flight — skip
  if (!currentSample && document.getElementById('resultModal')?.style.display !== 'flex') {
    _autoRefreshRunning = true;
    try {
      await renderProcessingSamples();
    } finally {
      _autoRefreshRunning = false;
    }
  }
}, 15000);