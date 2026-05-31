
// ========== SUPABASE CLIENT ==========
const SUPABASE_URL      = 'https://npdopywxemtwzvpummsn.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5wZG9weXd4ZW10d3p2cHVtbXNuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk4NzY0MjksImV4cCI6MjA5NTQ1MjQyOX0.Mo5LfGdfSiHL6QHsPOaGkDmeaIRDqZTe8MGwz_6ou1c';

// ========== AUTH — checkAuth() and logoutUser() from auth-guard.js ==========
const currentSession = checkAuth(['technologist', 'admin', 'supervisor']);
const currentUser    = currentSession;

// Build token-authenticated client — injects x-lis-token on every request
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

// ========== AUDIT (FIXED: use 'db') ==========
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
    // Offline: return a sensible default so the modal still opens
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
    // Queue for sync when back online
    if (typeof _oqEnqueue === 'function') {
      const actorName = currentUser?.name || 'Tech';
      await _oqEnqueue('updateCOCEvent', { sampleId, stepIndex, done, active, actorName });
      console.warn('[RE] updateCOCEvent queued offline');
    } else {
      throw err;
    }
  }
}

// ========== LOAD TEST DEFINITIONS ==========
let testDefinitions = { testTypes: {} };
async function loadTestDefinitions() {
  try {
    const { data, error } = await db.from('test_definitions').select('*');
    if (error) throw error;
    testDefinitions.testTypes = {};
    data.forEach(td => {
      if (td.test_type !== 'simple') {
        testDefinitions.testTypes[td.test_name] = td.test_type;
      }
    });
    // Cache raw data for offline use (offline_queue.js reads this)
    if (typeof _oqCacheTestDefinitions === 'function') {
      _oqCacheTestDefinitions(data).catch(() => {});
    }
  } catch (err) {
    console.error(err);
    // Offline fallback — try to restore from IDB cache
    if (typeof _oqGetCachedTestDefinitions === 'function') {
      try {
        const cached = await _oqGetCachedTestDefinitions();
        if (cached && cached.length) {
          testDefinitions.testTypes = {};
          cached.forEach(td => {
            if (td.test_type && td.test_type !== 'simple')
              testDefinitions.testTypes[td.test_name] = td.test_type;
          });
          console.log('[RE] loadTestDefinitions: restored from offline cache');
          return; // silent success
        }
      } catch(e) {}
    }
    toast('Failed to load test definitions', 'error');
  }
}

// ========== LOAD SAMPLES ==========
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
    samples = data.map(s => ({
      ...s,
      tests: s.sample_tests || [],
      stype: s.sample_type,
      due: s.due_date,
      paystatus: s.pay_status,
      paymode: s.pay_mode,
      insurance: s.insurance_no,
      collDate: s.collection_date,
      collTime: s.collection_time
    }));
    // Warm the offline cache every successful load
    if (typeof _oqMergeSampleList === 'function') _oqMergeSampleList(samples).catch(() => {});
  } catch (err) {
    console.warn('[RE] loadSamples failed — attempting offline cache:', err);
    // Fall back to IndexedDB cache (offline_queue.js must be loaded first)
    if (typeof _oqGetCachedSamples === 'function') {
      try {
        const cached = await _oqGetCachedSamples();
        samples = cached.filter(s => s.status === 'Processing' || s.status === 'Collected');
        if (samples.length) {
          toast('Offline — showing cached samples', 'warn');
          return;
        }
      } catch(e) {}
    }
    toast('Failed to load samples', 'error');
    samples = [];
  }
}

async function saveSample(sample) {
  // Always update local cache first so offline edits survive
  if (typeof _oqCacheSample === 'function') _oqCacheSample(sample).catch(() => {});

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
      const { error: testError } = await db
        .from('sample_tests')
        .update({
          result: test.result,
          tech_name: test.tech,
          status: test.status
        })
        .eq('id', test.id);
      if (testError) throw testError;
    }
  } catch(err) {
    // Queue for sync when back online
    if (typeof _oqEnqueue === 'function') {
      await _oqEnqueue('saveSample', { sample: JSON.parse(JSON.stringify(sample)) });
      console.warn('[RE] saveSample queued offline:', err);
    } else {
      throw err; // No offline queue — let caller handle
    }
  }
}

function getTestType(testName) {
  // 1. Exact match from DB first
  if (testDefinitions.testTypes[testName]) return testDefinitions.testTypes[testName];

  // 2. Normalise fallback — covers name mismatches between accession & test_definitions
  const n = testName.toLowerCase().trim();
  if (/liver\s*function|lft\b/.test(n))                         return 'complex_lft';
  if (/renal\s*function|kidney\s*function|rft\b/.test(n))       return 'complex_rft';
  if (/full\s*blood\s*count|complete\s*blood|cbc\b|fbc\b/.test(n)) return 'complex_cbc';
  if (/thyroid|tsh|thyroid\s*function/.test(n))                 return 'complex_thyroid';
  if (/lipid\s*profile|cholesterol/.test(n))                    return 'complex_lipid';
  if (/coagul|prothrombin|clotting\s*profile|pt\/inr|coag\b/.test(n)) return 'complex_coag';
  if (/widal/.test(n))                                          return 'complex_widal';
  if (/urine\s*mcs|urine\s*m\/c\/s|urine\s*culture|urinalysis\s*mcs/.test(n)) return 'complex_urine_mcs';
  if (/stool\s*mcs|stool\s*m\/c\/s|stool\s*culture/.test(n))   return 'complex_stool_mcs';
  if (/urinalysis|urine\s*r\/e|u\/a\b|routine\s*urine/.test(n)) return 'complex_urinalysis';
  if (/culture|sensitivity|c\/s\b|cs\b/.test(n) && /stool|faec/.test(n)) return 'complex_stool_cs';
  if (/culture|sensitivity|c\/s\b|cs\b/.test(n))                return 'complex_culture';
  if (/malaria|rdt|thick.*film|blood.*film/.test(n))            return 'complex_malaria';
  if (/genexpert|xpert|tb.*pcr|mtb/.test(n))                   return 'complex_tb_genexpert';
  if (/serology|hbsag|hepatitis/.test(n))                      return 'complex_serology';
  if (/iron\s*studies|iron\s*profile|serum\s*iron/.test(n))    return 'complex_iron';
  if (/bone\s*profile|calcium\s*profile/.test(n))              return 'complex_bone';
  if (/cardiac|troponin|ckmb/.test(n))                         return 'complex_cardiac';
  if (/ogtt|glucose\s*tolerance/.test(n))                      return 'complex_ogtt';
  if (/csf|cerebrospinal/.test(n))                             return 'complex_csf';
  if (/blood\s*gas|abg\b/.test(n))                             return 'complex_abg';
  if (/semen\s*analysis|seminal/.test(n))                      return 'complex_semen';
  if (/packed\s*cell|pcv\b|haematocrit/.test(n))               return 'complex_pcv';
  if (/haemoglobin|hemoglobin|\bhb\b/.test(n))                 return 'complex_hb';
  if (/esr\b|sedimentation/.test(n))                           return 'complex_esr';
  if (/random\s*blood\s*sugar|rbs\b/.test(n))                  return 'complex_rbs';
  if (/fasting\s*blood\s*sugar|fbs\b/.test(n))                 return 'complex_fbs';

  return 'simple';
}

// ========== DYNAMIC REFERENCE RANGE ==========
function getReferenceRange(testName, age, gender) {
  const patientAge = (age && !isNaN(age)) ? parseInt(age) : 30;
  const isMale = (gender === 'Male');
  const isFemale = (gender === 'Female');
  switch (testName) {
    case 'PCV': case 'Packed Cell Volume': case 'Hematocrit': case 'HCT':
      if (isMale) return { low: 40, high: 54, unit: '%' };
      if (isFemale) return { low: 36, high: 46, unit: '%' };
      return { low: 36, high: 46, unit: '%' };
    case 'Hb': case 'Hemoglobin':
      if (isMale) return { low: 13.5, high: 17.5, unit: 'g/dL' };
      if (isFemale) return { low: 12.0, high: 15.5, unit: 'g/dL' };
      return { low: 12.0, high: 15.5, unit: 'g/dL' };
    case 'ESR': case 'Erythrocyte Sedimentation Rate':
      if (isMale) return { low: 0, high: 10, unit: 'mm/hr' };
      if (isFemale) return { low: 0, high: 20, unit: 'mm/hr' };
      return { low: 0, high: 15, unit: 'mm/hr' };
    case 'RBS': case 'Random Blood Sugar':
      return { low: 70, high: 140, unit: 'mg/dL' };
    case 'FBS': case 'Fasting Blood Sugar':
      return { low: 70, high: 100, unit: 'mg/dL' };
    default: return null;
  }
}

// ========== PARAMETER DEFINITIONS ==========
const CBC_PARAMS = [
  {key:'wbc',  name:'WBC',         unit:'×10³/µL', low:4.0,   high:11.0},
  {key:'rbc',  name:'RBC',         unit:'×10⁶/µL', low:4.2,   high:5.8 },
  {key:'hb',   name:'Hemoglobin',  unit:'g/dL',    low:12.0,  high:16.0},
  {key:'hct',  name:'Hematocrit',  unit:'%',       low:36,    high:46  },
  {key:'mcv',  name:'MCV',         unit:'fL',      low:80,    high:100 },
  {key:'mch',  name:'MCH',         unit:'pg',      low:27,    high:32  },
  {key:'mchc', name:'MCHC',        unit:'g/dL',    low:32,    high:36  },
  {key:'plt',  name:'Platelets',   unit:'×10³/µL', low:150,   high:450 },
  {key:'neut', name:'Neutrophils', unit:'%',       low:40,    high:70  },
  {key:'lymph',name:'Lymphocytes', unit:'%',       low:20,    high:45  },
  {key:'mono', name:'Monocytes',   unit:'%',       low:2,     high:8   },
  {key:'eo',   name:'Eosinophils', unit:'%',       low:0,     high:6   },
  {key:'baso', name:'Basophils',   unit:'%',       low:0,     high:2   }
];
const WIDAL_TITERS = [20, 40, 80, 160, 320, 640, 1280];
const LFT_PARAMS_FULL = [
  {key:'alt', name:'ALT', unit:'U/L', low:10, high:40},
  {key:'ast', name:'AST', unit:'U/L', low:10, high:35},
  {key:'alp', name:'ALP', unit:'U/L', low:30, high:120},
  {key:'ggt', name:'GGT', unit:'U/L', low:8, high:61},
  {key:'tbil', name:'Total Bilirubin', unit:'mg/dL', low:0.3, high:1.2},
  {key:'dbil', name:'Direct Bilirubin', unit:'mg/dL', low:0.0, high:0.3},
  {key:'prot', name:'Total Protein', unit:'g/dL', low:6.0, high:8.0},
  {key:'alb', name:'Albumin', unit:'g/dL', low:3.5, high:5.0},
  {key:'glob', name:'Globulin', unit:'g/dL', low:2.0, high:3.5, calc:true},
  {key:'agRatio', name:'A/G Ratio', unit:'', low:1.0, high:2.5, calc:true}
];
const RFT_PARAMS_FULL = [
  {key:'urea', name:'Urea', unit:'mg/dL', low:10, high:50},
  {key:'creat', name:'Creatinine', unit:'mg/dL', low:0.6, high:1.2},
  {key:'sodium', name:'Sodium', unit:'mmol/L', low:135, high:145},
  {key:'potassium', name:'Potassium', unit:'mmol/L', low:3.5, high:5.1},
  {key:'chloride', name:'Chloride', unit:'mmol/L', low:98, high:107},
  {key:'bicarb', name:'Bicarbonate (HCO3)', unit:'mmol/L', low:22, high:29},
  {key:'calcium', name:'Calcium', unit:'mg/dL', low:8.5, high:10.2},
  {key:'phosphate', name:'Phosphate', unit:'mg/dL', low:2.5, high:4.5},
  {key:'magnesium', name:'Magnesium', unit:'mg/dL', low:1.7, high:2.2}
];
const THYROID_PARAMS = [
  {key:'tsh', name:'TSH', unit:'µIU/mL', low:0.4, high:4.0},
  {key:'ft3', name:'Free T3', unit:'pg/mL', low:2.3, high:4.2},
  {key:'ft4', name:'Free T4', unit:'ng/dL', low:0.8, high:1.8}
];
const LIPID_PARAMS = [
  {key:'chol', name:'Total Cholesterol', unit:'mg/dL', low:125, high:200},
  {key:'hdl', name:'HDL Cholesterol', unit:'mg/dL', low:40, high:60},
  {key:'ldl', name:'LDL Cholesterol', unit:'mg/dL', low:0, high:130},
  {key:'tg', name:'Triglycerides', unit:'mg/dL', low:0, high:150},
  {key:'vldl', name:'VLDL', unit:'mg/dL', low:5, high:40, calc:true},
  {key:'ratio', name:'Total/HDL Ratio', unit:'', low:0, high:5, calc:true}
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
  {key:'nitrite', name:'Nitrite', unit:'', type:'select', options:['Negative','Positive']},
  {key:'leuko', name:'Leukocyte Esterase', unit:'', type:'select', options:['Negative','Trace','+','++','+++']},
  {key:'wbc', name:'WBC', unit:'/HPF', low:0, high:5, type:'number'},
  {key:'rbc', name:'RBC', unit:'/HPF', low:0, high:2, type:'number'},
  {key:'epithelial', name:'Epithelial Cells', unit:'/HPF', type:'text'},
  {key:'casts', name:'Casts', unit:'/LPF', type:'text'},
  {key:'crystals', name:'Crystals', unit:'', type:'text'},
  {key:'bacteria', name:'Bacteria', unit:'', type:'select', options:['None','Few','Moderate','Many']},
  {key:'yeast', name:'Yeast', unit:'', type:'select', options:['None','Few','Moderate','Many']}
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
  {key:'volume', name:'Volume', unit:'mL', low:1.5, high:6.0, type:'number', step:0.1},
  {key:'count', name:'Sperm Count', unit:'million/mL', low:15, high:200, type:'number'},
  {key:'motility', name:'Motility', unit:'%', low:40, high:100, type:'number'},
  {key:'morphology', name:'Normal Morphology', unit:'%', low:4, high:100, type:'number'},
  {key:'ph', name:'pH', unit:'', low:7.2, high:8.0, type:'number', step:0.1},
  {key:'viscosity', name:'Viscosity', type:'select', options:['Normal','High']},
  {key:'wbc', name:'WBC', unit:'million/mL', low:0, high:1, type:'number'}
];
const SEROLOGY_PARAMS = [
  {key:'hbsag', name:'HBsAg', type:'select', options:['Non-reactive','Reactive']},
  {key:'anti_hbs', name:'Anti-HBs', type:'select', options:['Non-reactive','Reactive']},
  {key:'hbeag', name:'HBeAg', type:'select', options:['Non-reactive','Reactive']},
  {key:'anti_hbe', name:'Anti-HBe', type:'select', options:['Non-reactive','Reactive']},
  {key:'anti_hbc', name:'Anti-HBc (Total)', type:'select', options:['Non-reactive','Reactive']}
];

// ========== MCS MICROSCOPY PARAMS ==========
// Used by complex_urine_mcs and complex_stool_mcs
// Microscopy section is shown FIRST, then organism + C&S below it.

const URINE_MICRO_PARAMS = [
  // ── PHYSICAL ──────────────────────────────────────────────────────────
  {key:'colour',      name:'Colour',             unit:'', section:'Physical', type:'select',
   options:['Yellow','Straw','Clear','Dark Yellow','Red','Brown','Amber','Orange']},
  {key:'appearance',  name:'Appearance',         unit:'', section:'Physical', type:'select',
   options:['Clear','Slightly Turbid','Turbid','Cloudy','Bloody','Frothy']},
  {key:'volume',      name:'Volume',             unit:'mL', section:'Physical', type:'number', low:0, high:3000, step:10},

  

  // ── MICROSCOPY ────────────────────────────────────────────────────────
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
   options:['None seen','Trichomonas vaginalis',
            'Schistosoma haematobium ova','Other — see comments']},
  {key:'mucus',       name:'Mucus Threads',     unit:'',     section:'Microscopy', type:'select',
   options:['None seen','Few','Moderate','Many']},
  {key:'sperm',       name:'Spermatozoa',       unit:'',     section:'Microscopy', type:'select',
   options:['Not seen','Seen (incidental)']},
  {key:'micro_comment',name:'Microscopy Comment',unit:'',    section:'Microscopy', type:'text'}
];

const STOOL_MICRO_PARAMS = [
  // Macroscopy
  {key:'consistency',  name:'Consistency',          unit:'', section:'Macroscopy', type:'select', options:['Formed','Soft','Watery','Loose','Bloody','Mucoid','Fatty']},
  {key:'colour_stool', name:'Colour',               unit:'', section:'Macroscopy', type:'select', options:['Brown','Yellow','Green','Black (Tarry)','Red (Bloody)','Grey/Clay','Pale/Fatty']},
  {key:'blood_stool',  name:'Blood (Macroscopic)',  unit:'', section:'Macroscopy', type:'select', options:['Absent','Present']},
  {key:'mucus_stool',  name:'Mucus (Macroscopic)',  unit:'', section:'Macroscopy', type:'select', options:['Absent','Present']},
  // Microscopy
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
    (s.patient || '').toLowerCase().includes(search) ||
    (s.offline_ref  || '').toLowerCase().includes(search) ||
    (s.receipt_no   || '').toLowerCase().includes(search)
  );
  if (priority !== 'all') ready = ready.filter(s => s.priority === priority);

  const priOrder = { STAT:0, Urgent:1, Routine:2 };
  ready.sort((a, b) => (priOrder[a.priority] ?? 2) - (priOrder[b.priority] ?? 2) || b.id - a.id);

  let badge = document.getElementById('sampleCountBadge');
  if (badge) badge.textContent = `(${ready.length})`;

  let tbody = document.getElementById('samplesTable');
  if (!tbody) return;
  if (!ready.length) {
    tbody.innerHTML = `<tr><td colspan="6"><div class="empty-state"><i class="fas fa-microscope" style="font-size:2rem;opacity:0.3;display:block;margin-bottom:12px;"></i>No samples ready for result entry. Register new samples in Accession.</div></td></tr>`;
    return;
  }

  tbody.innerHTML = ready.map(s => {
    let priCls = s.priority === 'STAT' ? 'badge-stat' : s.priority === 'Urgent' ? 'badge-urgent' : 'badge-routine';
    let staCls = s.status === 'Collected' ? 'badge-collected' : 'badge-processing';
    const readyCount = s.tests.filter(t => t.status === 'Ready').length;
    const totalTests = s.tests.length;
    const allReady = totalTests > 0 && readyCount === totalTests;
    let progressNote = '';
    if (totalTests > 1 && readyCount > 0 && !allReady) {
      progressNote = ` <small style="color:var(--yellow-light);">(${readyCount}/${totalTests} ready)</small>`;
    } else if (allReady && totalTests > 1) {
      progressNote = ` <small style="color:var(--green-glow);">✓ All ready</small>`;
    } else if (s.tests.some(t => t.result && t.result.trim())) {
      progressNote = ` <small style="color:var(--yellow-light);">(draft)</small>`;
    }
    const testList = s.tests.map(t => {
      const icon = t.status === 'Ready' ? '✅' : t.result && t.result.trim() ? '📝' : '⏳';
      return `${icon} ${esc(t.test_name)}`;
    }).join('<br>');
    return `<tr>
      <td style="font-family:monospace; font-weight:600;">MU-${s.id}${s.offline_ref ? `<br><span style="font-family:monospace;font-size:0.65rem;color:var(--amber);background:var(--amber-l);border:1px solid #fde68a;padding:1px 6px;border-radius:6px;display:inline-block;margin-top:3px;" title="Offline draft ref">${esc(s.offline_ref)}</span>` : ''}</td>
      <td><strong>${esc(s.patient)}</strong><br><small style="color:var(--text2);">${s.age ?? '?'}y ${esc(s.gender)}</small></td>
      <td><small>${testList}</small>${progressNote}</td>
      <td><span class="badge ${priCls}">${esc(s.priority)}</span></td>
      <td><span class="badge ${staCls}">${esc(s.status)}</span></td>
      <td><button class="btn btn-primary btn-sm" onclick="openResultModal(${s.id})"><i class="fas fa-edit"></i> Enter Results</button></td>
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
  let sample = samples.find(s => s.id === id);
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

  if (modalTitle) modalTitle.innerHTML = `Results — MU-${currentSample.id} | ${esc(currentSample.patient)}`;
  if (modalSubtitle) modalSubtitle.textContent = `${currentSample.age ?? '?'}y ${currentSample.gender} | ${currentSample.sample_type ?? ''} | Collected: ${currentSample.collection_date ?? ''} | ${currentSample.collection_time ?? ''}`;
  if (sampleInfo) sampleInfo.innerHTML = `<strong>Clinician:</strong> ${esc(currentSample.clinician || '—')} &nbsp;|&nbsp; <strong>History:</strong> ${esc(currentSample.history || '—')} &nbsp;|&nbsp; <strong>Priority:</strong> ${esc(currentSample.priority)}`;

  let formsHtml = '';
  currentSample.tests.forEach((test, idx) => {
    let testType = getTestType(test.test_name);
    formsHtml += `<div class="test-block" id="testBlock_${idx}">`;
    formsHtml += `<div class="test-block-title"><i class="fas fa-vial" style="color:var(--primary);margin-right:6px;"></i>${esc(test.test_name)}</div>`;
    formsHtml += `<div class="test-block-body">`;

    if (testType === 'complex_cbc') {
      let data = {};
      try { if (test.result?.startsWith('{')) data = JSON.parse(test.result); } catch(e){}
      formsHtml += `<div class="param-grid">`;
      CBC_PARAMS.forEach(p => {
        let val = data[p.key] !== undefined ? data[p.key] : '';
        let flagCls = val !== '' ? getFlag(val, p) : '';
        formsHtml += `<div class="param-item">
          <label>${esc(p.name)} <span style="color:var(--text3);font-weight:400;">(${esc(p.unit)}) Ref: ${p.low}–${p.high}</span></label>
          <input type="number" step="0.1" min="${p.low}" max="${p.high}" id="cbc_${idx}_${p.key}" value="${val}" placeholder="${p.low}–${p.high}" class="${flagCls}">
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
              </tr>
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
        } else {
          let flagCls = val !== '' ? getFlag(val, p) : '';
          formsHtml += `<div class="param-item"><label>${esc(p.name)} (${esc(p.unit)}) Ref: ${p.low}–${p.high}</label><input type="number" step="${p.step||0.1}" min="${p.low}" max="${p.high}" id="semen_${idx}_${p.key}" value="${val}" class="${flagCls}"></div>`;
        }
      });
      formsHtml += `</div><div id="semenInterp_${idx}" class="interp-box interp-normal">—</div>`;
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
      // Culture section
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
      // Culture section
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
    else if (testType === 'complex_pcv' || testType === 'complex_hb' || testType === 'complex_esr' ||
             testType === 'complex_rbs' || testType === 'complex_fbs') {
      let key = testType.split('_')[1];
      let data = {};
      try { if (test.result?.startsWith('{')) data = JSON.parse(test.result); } catch(e){}
      let val = data[key] !== undefined ? data[key] : '';
      let range = getReferenceRange(test.test_name, currentSample.age, currentSample.gender);
      if (!range) range = { low: 0, high: 100, unit: '' };
      let flagCls = val !== '' ? getFlag(val, { low: range.low, high: range.high }) : '';
      formsHtml += `<div class="param-item">
        <label>${esc(test.test_name)} (${esc(range.unit)}) Ref: ${range.low}–${range.high}</label>
        <input type="number" step="0.1" min="${range.low}" max="${range.high}" id="${key}_${idx}" value="${val}" class="${flagCls}">
      </div>`;
    }
    else {
      formsHtml += `<textarea id="textResult_${idx}" class="form-textarea" placeholder="Enter result…">${esc(test.result || '')}</textarea>`;
    }
    // ── Per-test "Done" toggle button ──────────────────────
    const isAlreadyReady = test.status === 'Ready';
    const isOtherTechReady = isAlreadyReady && test.tech && test.tech !== (currentUser?.name || '');
    formsHtml += `</div>`; // close .test-block-body
    formsHtml += `
      <div class="test-done-row" id="doneRow_${idx}">
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
      </div>`;
    formsHtml += `</div>`; // close .test-block
  });
  if (testForms) testForms.innerHTML = formsHtml;

  // ── Auto-save on input (debounced 2 s) ─────────────────
  let _autoSaveTimer = null;
  testForms.addEventListener('input', () => {
    clearTimeout(_autoSaveTimer);
    _autoSaveTimer = setTimeout(async () => {
      if (!currentSample) return;
      collectResultsFromForms();
      try {
        await saveSample(currentSample);
        showAutoSaveIndicator();
      } catch(e) { /* silent */ }
    }, 2000);
  });
  // Also fire on select change (select doesn't bubble 'input' in all browsers)
  testForms.addEventListener('change', () => {
    clearTimeout(_autoSaveTimer);
    _autoSaveTimer = setTimeout(async () => {
      if (!currentSample) return;
      collectResultsFromForms();
      try { await saveSample(currentSample); showAutoSaveIndicator(); } catch(e) {}
    }, 1500);
  });

  let cocHtml = COC_STEPS.map((step, i) => {
    let stepData = currentSample.coc[i] || { done: false, active: false };
    let done = stepData.done;
    let active = stepData.active;
    return `<div class="coc-event"><div class="coc-dot ${done ? 'done' : active ? 'active' : ''}">${done ? '✓' : active ? '⏳' : ''}</div><div class="coc-info">${step}</div></div>`;
  }).join('');
  if (cocTimeline) cocTimeline.innerHTML = cocHtml;

  document.getElementById('resultModal').style.display = 'flex';

  // Show live progress bar immediately so any tech can see what's already done
  renderReadinessBar();

  // If all tests are already marked Ready (re-opened sample), surface the Send button
  const allAlreadyReady = currentSample.tests.length > 0 && currentSample.tests.every(t => t.status === 'Ready');
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

  // If already done by this tech — allow un-marking
  const isDone = test.status === 'Ready' && (test.tech === techName || test.tech === 'Unknown Tech');

  if (isDone) {
    // Un-mark
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

  // Collect + validate this test's result
  collectSingleTestResult(idx);
  const result = test.result;
  const isEmpty = !result || result.trim() === '' || result === '{}';
  if (isEmpty) {
    toast(`Enter results for ${test.test_name} first`, 'error');
    return;
  }

  // Mark done
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

  // Check if ALL tests belonging to this tech are now Done
  const techName2 = currentUser?.name || currentUser?.username || currentUser?.id || 'Unknown Tech';
  const myTests   = currentSample.tests.filter(t =>
    !t.tech || t.tech === techName2 || t.tech === 'Unknown Tech'
  );
  const allMyDone = myTests.length > 0 && myTests.every(t => t.status === 'Ready');

  if (allMyDone) {
    // Stamp done_by / done_at on any test that doesn't have it yet
    for (const t of myTests) {
      if (!t.done_by) t.done_by = techName2;
      if (!t.done_at) t.done_at = new Date().toISOString();
    }

    const allSampleDone = currentSample.tests.every(t => t.status === 'Ready');

    if (allSampleDone) {
      // Every tech is done — auto mark ready AND send to verify
      toast('All tests done — sending for verification…', 'info');
      await addAudit('Tests Marked Ready', currentSample.id,
        `${techName2} marked ready via done toggle: ${myTests.map(t => t.test_name).join(', ')}`);
      setTimeout(() => sendToVerify(), 600);
    } else {
      // This tech finished their share — mark ready, wait for others
      toast('Your tests marked ready ✓ — waiting for other technologists', 'info');
      await addAudit('Tests Marked Ready', currentSample.id,
        `${techName2} marked ready via done toggle: ${myTests.map(t => t.test_name).join(', ')}`);
      renderReadinessBar();
    }
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
  } else if (testType === 'complex_rft') {
    let data = {};
    RFT_PARAMS_FULL.forEach(p => { let inp = document.getElementById(`rft_${idx}_${p.key}`); if (inp && inp.value !== '') data[p.key] = parseFloat(inp.value); });
    test.result = JSON.stringify(data);
  } else if (testType === 'complex_thyroid') {
    let data = {};
    THYROID_PARAMS.forEach(p => { let inp = document.getElementById(`thyroid_${idx}_${p.key}`); if (inp && inp.value !== '') data[p.key] = parseFloat(inp.value); });
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
    test.result = JSON.stringify(data);
  } else if (testType === 'complex_serology') {
    let data = {};
    SEROLOGY_PARAMS.forEach(p => { let inp = document.getElementById(`sero_${idx}_${p.key}`); if (inp) data[p.key] = inp.value; });
    test.result = JSON.stringify(data);
  } else if (testType === 'complex_pcv' || testType === 'complex_hb' || testType === 'complex_esr' ||
             testType === 'complex_rbs' || testType === 'complex_fbs') {
    let key = testType.split('_')[1];
    let inp = document.getElementById(`${key}_${idx}`);
    let data = {};
    if (inp && inp.value !== '') data[key] = parseFloat(inp.value);
    test.result = JSON.stringify(data);
  } else {
    let ta = document.getElementById(`textResult_${idx}`);
    if (ta) test.result = ta.value;
  }
  // Only stamp tech if this test is not already marked Ready by someone else
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
      widalKeys.forEach(k => {
        let val = document.getElementById(`widal_${idx}_${k}`)?.value;
        data[k] = (val && val !== '—') ? parseInt(val) : '—';
      });
      test.result = JSON.stringify(data);
    } else if (testType === 'complex_lft') {
      let data = {};
      LFT_PARAMS_FULL.forEach(p => { let inp = document.getElementById(`lft_${idx}_${p.key}`); if (inp && inp.value !== '') data[p.key] = parseFloat(inp.value); });
      test.result = JSON.stringify(data);
    } else if (testType === 'complex_rft') {
      let data = {};
      RFT_PARAMS_FULL.forEach(p => { let inp = document.getElementById(`rft_${idx}_${p.key}`); if (inp && inp.value !== '') data[p.key] = parseFloat(inp.value); });
      test.result = JSON.stringify(data);
    } else if (testType === 'complex_thyroid') {
      let data = {};
      THYROID_PARAMS.forEach(p => { let inp = document.getElementById(`thyroid_${idx}_${p.key}`); if (inp && inp.value !== '') data[p.key] = parseFloat(inp.value); });
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
        let rows = container.querySelectorAll('div[data-ab-row]');
        rows.forEach(row => {
          let nameInput = row.querySelector('input[type="text"]');
          let select = row.querySelector('select');
          if (nameInput && select && nameInput.value.trim()) {
            sensitivities.push({
              antibiotic: nameInput.value.trim(),
              result: select.value
            });
          }
        });
      }
      test.result = JSON.stringify({ organism, sensitivities });
    } else if (testType === 'complex_urine_mcs') {
      let data = {};
      URINE_MICRO_PARAMS.forEach(p => {
        let inp = document.getElementById(`umcs_${idx}_${p.key}`);
        if (inp) data[p.key] = p.type === 'number' ? (inp.value !== '' ? parseFloat(inp.value) : '') : inp.value;
      });
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
      STOOL_MICRO_PARAMS.forEach(p => {
        let inp = document.getElementById(`smcs_${idx}_${p.key}`);
        if (inp) data[p.key] = inp.value;
      });
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
      test.result = JSON.stringify(data);
    } else if (testType === 'complex_serology') {
      let data = {};
      SEROLOGY_PARAMS.forEach(p => { let inp = document.getElementById(`sero_${idx}_${p.key}`); if (inp) data[p.key] = inp.value; });
      test.result = JSON.stringify(data);
    } else if (testType === 'complex_pcv' || testType === 'complex_hb' || testType === 'complex_esr' ||
               testType === 'complex_rbs' || testType === 'complex_fbs') {
      let key = testType.split('_')[1];
      let inp = document.getElementById(`${key}_${idx}`);
      let data = {};
      if (inp && inp.value !== '') data[key] = parseFloat(inp.value);
      test.result = JSON.stringify(data);
    } else {
      let ta = document.getElementById(`textResult_${idx}`);
      if (ta) test.result = ta.value;
    }
    // Only stamp tech/status if this test is NOT already marked Ready by someone else.
    // Preserves the original entrant when multiple techs share a sample.
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
  // Ensure tech name is stamped on all tests even on draft save
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

  // Only work on tests that are NOT already marked Ready by another technologist
  const myTests = currentSample.tests.filter(t =>
    t.status !== 'Ready' &&
    (!t.tech || t.tech === techName || t.tech === 'Unknown Tech')
  );

  if (!myTests.length) {
    toast('Your tests are already marked ready', 'warn');
    return;
  }

  const incomplete = myTests.filter(t => !t.result || t.result.trim() === '' || t.result === '{}');
  if (incomplete.length) {
    toast(`Please complete: ${incomplete.map(t => t.test_name).join(', ')}`, 'error');
    return;
  }

  for (let test of myTests) {
    test.tech    = techName;
    test.done_by = techName;
    test.done_at = test.done_at || new Date().toISOString(); // keep original if already set
    test.status  = 'Ready';
  }

  await saveSample(currentSample);
  await addAudit('Tests Marked Ready', currentSample.id, `${techName} marked ready: ${myTests.map(t => t.test_name).join(', ')}`);
  toast(`Your tests marked ready ✓`);

  await loadSamples();
  const fresh = samples.find(s => s.id === currentSample.id);
  // Offline: fresh may not be in filtered list — keep currentSample as-is
  if (fresh) currentSample.tests = fresh.tests;

  const allReady = currentSample.tests.every(t => t.status === 'Ready');
  if (allReady) {
    await sendToVerify();
  } else {
    renderReadinessBar();
    const remaining = currentSample.tests.filter(t => t.status !== 'Ready').map(t => t.test_name);
    toast(`Waiting for: ${remaining.join(', ')}`, 'warn');
  }
}

function renderReadinessBar() {
  const bar = document.getElementById('readinessBar');
  if (!bar || !currentSample) return;

  const total = currentSample.tests.length;
  const ready = currentSample.tests.filter(t => t.status === 'Ready').length;

  if (total <= 1) { bar.style.display = 'none'; return; }

  const pct = Math.round((ready / total) * 100);
  const items = currentSample.tests.map(t => {
    const icon = t.status === 'Ready' ? '✅' : '⏳';
    const techLabel = t.tech && t.tech !== 'Unknown Tech' ? ` <span style="color:var(--muted)">(${esc(t.tech)})</span>` : '';
    return `<span style="margin-right:12px;">${icon} ${esc(t.test_name)}${techLabel}</span>`;
  }).join('');

  bar.style.display = 'block';
  bar.innerHTML = `
    <div style="background:#f0f4f9; border-radius:12px; padding:10px 14px;">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
        <strong style="color:var(--primary);"><i class="fas fa-tasks"></i> Unit Progress</strong>
        <span style="font-weight:600;">${ready}/${total} tests ready</span>
      </div>
      <div style="background:#dde4ee; border-radius:40px; height:6px; margin-bottom:8px;">
        <div style="background:var(--primary); width:${pct}%; height:100%; border-radius:40px;"></div>
      </div>
      <div style="display:flex; flex-wrap:wrap; gap:4px;">${items}</div>
    </div>`;

  // Keep Send button visible only when everything is ready
  const sendBtn = document.getElementById('sendVerifyBtn');
  if (sendBtn) sendBtn.style.display = (ready === total) ? 'inline-flex' : 'none';
}

async function sendToVerify() {
  if (!currentSample) return;
  const techName = currentUser?.name || currentUser?.username || currentUser?.id || 'Unknown Tech';
  currentSample.status = 'Verifying';
  for (let test of currentSample.tests) {
    test.status = 'Verifying';
  }
  await saveSample(currentSample);
  await updateCOCEvent(currentSample.id, 4, true, false);
  await updateCOCEvent(currentSample.id, 5, false, true);
  await addAudit('Sent to Verify', currentSample.id, `All units complete — sent by ${techName}`);
  toast(`MU-${currentSample.id} sent to verification ✓`);
  closeModal();
  await renderProcessingSamples();
}

function closeModal() {
  const resultModal = document.getElementById('resultModal');
  if (resultModal) resultModal.style.display = 'none';
  currentSample = null;
}

// ========== PDF GENERATION ==========
async function generatePDF(id) {
  let s = samples.find(x => x.id === id);
  if (!s) return;
  let wrap = document.createElement('div');
  wrap.style.cssText = 'position:fixed; left:-9999px; top:0; width:800px; background:white; padding:30px; font-family:Arial; font-size:12px;';
  let rows = '';
  for (let t of s.tests) {
    let testType = testDefinitions.testTypes[t.test_name] || '';
    if (t.result && t.result.startsWith('{') && testType) {
      try {
        let data = JSON.parse(t.result);
        rows += generatePDFRows(t.test_name, data, testType, s.age, s.gender);
      } catch(e) { rows += `<tr><td colspan="4">${esc(t.test_name)}: ${esc(t.result)}</td></tr>`; }
    } else {
      rows += `<tr><td colspan="4">${esc(t.test_name)}: ${esc(t.result || '—')}</td></tr>`;
    }
  }
  wrap.innerHTML = `<div style="text-align:center; margin-bottom:20px; border-bottom:2px solid #1F6E43; padding-bottom:16px;"><h1 style="color:#1F6E43;">MU'UJIZA DIAGNOSTICS</h1><p style="font-size:11px;">Accredited Laboratory · ISO 15189</p></div>
    <div style="margin-bottom:16px;"><p><strong>Sample ID:</strong> MU-${s.id}</p><p><strong>Patient:</strong> ${esc(s.patient)} (${s.age ?? '?'}y, ${esc(s.gender)})</p>
    <p><strong>Collected:</strong> ${s.collection_date} | <strong>Released:</strong> ${s.released_at ? new Date(s.released_at).toLocaleString() : '—'}</p>
    <p><strong>Payment:</strong> ${s.pay_status} | Paid: ${(s.amount_paid || 0).toFixed(2)} NGN | Balance: ${(s.balance_due || 0).toFixed(2)} NGN</p>${s.supervisor_comment ? `<p><strong>Supervisor Note:</strong> ${esc(s.supervisor_comment)}</p>` : ''}</div>
    <table border="1" style="border-collapse:collapse; width:100%;"><thead><tr><th>Parameter</th><th>Result</th><th>Unit</th><th>Reference</th></tr></thead><tbody>${rows}</tbody></table>
    <div style="margin-top:20px; text-align:center; font-size:9px;">Electronically generated by MU'UJIZA DIAGNOSTICS LIS</div>`;
  document.body.appendChild(wrap);
  const { jsPDF } = window.jspdf;
  let pdf = new jsPDF('p', 'mm', 'a4');
  await html2canvas(wrap, { scale: 2 }).then(canvas => {
    let img = canvas.toDataURL('image/png');
    let w = 190, h = (canvas.height * w) / canvas.width;
    pdf.addImage(img, 'PNG', 10, 10, w, h);
    pdf.save(`MU${s.id}_${(s.patient || 'patient').replace(/\s/g, '_')}.pdf`);
  });
  document.body.removeChild(wrap);
  await addAudit('PDF Downloaded', s.id, `Report downloaded by ${currentUser ? currentUser.name : 'Unknown'}`);
  toast('PDF downloaded');
}

function generatePDFRows(testName, data, testType, age, gender) {
  let header = `<tr style="background:#f0f0f0;"><td colspan="4" style="padding:7px; font-weight:bold;">${esc(testName)}</td></tr>`;
  if (testType === 'complex_widal') {
    const widalRows = [
      { organism: 'Salmonella Typhi',       o: data.o  ?? '—', h: data.h  ?? '—' },
      { organism: 'Salmonella Paratyphi A', o: data.ao ?? '—', h: data.ah ?? '—' },
      { organism: 'Salmonella Paratyphi B', o: data.bo ?? '—', h: data.bh ?? '—' },
      { organism: 'Salmonella Paratyphi C', o: data.co ?? '—', h: data.ch ?? '—' }
    ];
    let tableRows = '';
    for (let r of widalRows) {
      const oFlag = (r.o !== '—' && parseInt(r.o) >= 160) ? ' ↑' : '';
      const hFlag = (r.h !== '—' && parseInt(r.h) >= 160) ? ' ↑' : '';
      const oDisplay = r.o !== '—' ? `1:${r.o}${oFlag}` : '—';
      const hDisplay = r.h !== '—' ? `1:${r.h}${hFlag}` : '—';
      tableRows += `<tr>
        <td style="padding:5px; font-style:italic;">${r.organism}</td>
        <td style="padding:5px;${oFlag ? 'font-weight:bold; color:#b91c1c;' : ''}">${oDisplay}</td>
        <td style="padding:5px;${hFlag ? 'font-weight:bold; color:#b91c1c;' : ''}">${hDisplay}</td>
        <td></td>
      </tr>`;
    }
    return `<tr style="background:#f0f0f0;"><td colspan="4" style="font-weight:bold; padding:7px;">Widal Agglutination Test</td></tr>
            <tr><td colspan="4" style="padding:4px;">
              <table style="width:100%; border-collapse:collapse; font-size:11px;">
                <thead><tr style="background:#e8f4ed;"><th style="padding:5px; text-align:left;">Organism</th><th style="padding:5px;">O Antigen (TO)</th><th style="padding:5px;">H Antigen (TH)</th><th></th></tr></thead>
                <tbody>${tableRows}</tbody>
              </table>
            </td></tr>`;
  }
  if (testType === 'complex_culture' || testType === 'complex_stool_cs') {
    let organism = data.organism || 'Not specified';
    let sensRows = (data.sensitivities || []).map(s => `<tr><td style="padding:5px;">${esc(s.antibiotic)}</td><td class="${s.result === 'R' ? 'flag-high' : s.result === 'S' ? 'flag-low' : ''}">${esc(s.result)}</td><td></td><td></td></tr>`).join('');
    return header + `<tr><td colspan="4"><strong>Organism:</strong> ${esc(organism)}</td></tr>` + (sensRows ? `<tr><th>Antibiotic</th><th>Sensitivity</th><th></th><th></th></tr>${sensRows}` : '');
  }
  if (testType === 'complex_urine_mcs') {
    let rows = `<tr style="background:#dbeafe;"><td colspan="4" style="font-weight:bold; padding:6px;">PHYSICAL EXAMINATION</td></tr>`;
    URINE_MICRO_PARAMS.filter(p => p.section === 'Physical').forEach(p => {
      let v = data[p.key]; if (v === undefined || v === '') return;
      rows += `<tr><td style="padding:5px;">${esc(p.name)}</td><td colspan="3">${esc(v)}</td></tr>`;
    });
    rows += `<tr style="background:#dbeafe;"><td colspan="4" style="font-weight:bold; padding:6px;">CHEMICAL EXAMINATION (DIPSTICK)</td></tr>`;
    URINE_MICRO_PARAMS.filter(p => p.section === 'Chemical').forEach(p => {
      let v = data[p.key]; if (v === undefined || v === '') return;
      let flag = (p.low !== undefined) ? (parseFloat(v) > p.high ? '↑' : parseFloat(v) < p.low ? '↓' : '') : '';
      let ref = (p.low !== undefined) ? `${p.low}–${p.high}` : '—';
      rows += `<tr><td style="padding:5px;">${esc(p.name)}</td><td style="padding:5px;${flag?'font-weight:bold;color:#b91c1c;':''}">${esc(v)} ${flag}</td><td>${esc(p.unit||'')}</td><td>${ref}</td></tr>`;
    });
    rows += `<tr style="background:#dbeafe;"><td colspan="4" style="font-weight:bold; padding:6px;">MICROSCOPY</td></tr>`;
    URINE_MICRO_PARAMS.filter(p => p.section === 'Microscopy').forEach(p => {
      let v = data[p.key]; if (v === undefined || v === '' || v === 'None seen') return;
      rows += `<tr><td style="padding:5px;">${esc(p.name)}</td><td colspan="2" style="padding:5px;">${esc(v)}</td><td style="padding:5px;">${esc(p.unit||'')}</td></tr>`;
    });
    rows += `<tr style="background:#dbeafe;"><td colspan="4" style="font-weight:bold; padding:6px;">CULTURE &amp; SENSITIVITY</td></tr>`;
    rows += `<tr><td style="padding:5px;">Organism</td><td colspan="3" style="padding:5px; font-style:italic;">${esc(data.organism || 'No growth / Not specified')}</td></tr>`;
    if (data.sensitivities && data.sensitivities.length) {
      rows += `<tr style="background:#f0f0f0;"><th style="padding:5px;">Antibiotic</th><th style="padding:5px;">Result</th><th colspan="2" style="padding:5px;">Interpretation</th></tr>`;
      data.sensitivities.forEach(s => {
        const label  = s.result==='S'?'Sensitive':s.result==='R'?'Resistant':s.result==='I'?'Intermediate':s.result||'—';
        const colour = s.result==='S'?'#15803d':s.result==='R'?'#b91c1c':s.result==='I'?'#92400e':'#374151';
        rows += `<tr><td style="padding:5px;">${esc(s.antibiotic)}</td><td style="padding:5px;font-weight:bold;color:${colour};">${esc(s.result)}</td><td colspan="2" style="padding:5px;color:${colour};">${label}</td></tr>`;
      });
    } else {
      rows += `<tr><td colspan="4" style="padding:5px;color:#6b7280;">No antibiotic sensitivities recorded.</td></tr>`;
    }
    return header + rows;
  }
  if (testType === 'complex_stool_mcs') {
    let rows = `<tr style="background:#fef9c3;"><td colspan="4" style="font-weight:bold; padding:6px;">MACROSCOPY</td></tr>`;
    STOOL_MICRO_PARAMS.filter(p => p.section === 'Macroscopy').forEach(p => {
      let v = data[p.key]; if (v === undefined || v === '') return;
      rows += `<tr><td style="padding:5px;">${esc(p.name)}</td><td colspan="3">${esc(v)}</td></tr>`;
    });
    rows += `<tr style="background:#fef9c3;"><td colspan="4" style="font-weight:bold; padding:6px;">MICROSCOPY</td></tr>`;
    STOOL_MICRO_PARAMS.filter(p => p.section === 'Microscopy').forEach(p => {
      let v = data[p.key]; if (v === undefined || v === '' || v === 'None seen' || v === 'Absent' || v === 'Negative') return;
      rows += `<tr><td style="padding:5px;">${esc(p.name)}</td><td colspan="3" style="padding:5px;">${esc(v)}</td></tr>`;
    });
    rows += `<tr style="background:#fef9c3;"><td colspan="4" style="font-weight:bold; padding:6px;">CULTURE &amp; SENSITIVITY</td></tr>`;
    rows += `<tr><td style="padding:5px;">Organism</td><td colspan="3" style="padding:5px; font-style:italic;">${esc(data.organism || 'No growth / Not specified')}</td></tr>`;
    if (data.sensitivities && data.sensitivities.length) {
      rows += `<tr style="background:#f0f0f0;"><th style="padding:5px;">Antibiotic</th><th style="padding:5px;">Result</th><th colspan="2" style="padding:5px;">Interpretation</th></tr>`;
      data.sensitivities.forEach(s => {
        const label  = s.result==='S'?'Sensitive':s.result==='R'?'Resistant':s.result==='I'?'Intermediate':s.result||'—';
        const colour = s.result==='S'?'#15803d':s.result==='R'?'#b91c1c':s.result==='I'?'#92400e':'#374151';
        rows += `<tr><td style="padding:5px;">${esc(s.antibiotic)}</td><td style="padding:5px;font-weight:bold;color:${colour};">${esc(s.result)}</td><td colspan="2" style="padding:5px;color:${colour};">${label}</td></tr>`;
      });
    } else {
      rows += `<tr><td colspan="4" style="padding:5px;color:#6b7280;">No antibiotic sensitivities recorded.</td></tr>`;
    }
    return header + rows;
  }
  if (testType === 'complex_malaria') {
    let rows = '';
    if (data.species) rows += `<tr><td>Species</td><td colspan="3">${esc(data.species)}</td></tr>`;
    if (data.stage) rows += `<tr><td>Stage</td><td colspan="3">${esc(data.stage)}</td></tr>`;
    if (data.density !== undefined) rows += `<tr><td>Parasite Density</td><td colspan="3">${esc(data.density)} parasites/µL</td></tr>`;
    return header + rows;
  }
  if (testType === 'complex_tb_genexpert') {
    let rows = '';
    if (data.mtb_detected) rows += `<tr><td>MTB Detected</td><td colspan="3">${esc(data.mtb_detected)}</td></tr>`;
    if (data.rif_resistance) rows += `<tr><td>Rifampicin Resistance</td><td colspan="3">${esc(data.rif_resistance)}</td></tr>`;
    for (let probe of ['probeA_ct','probeB_ct','probeC_ct','probeD_ct','probeE_ct']) {
      if (data[probe] !== undefined) rows += `<tr><td>${probe.replace('_ct',' Probe Ct')}</td><td colspan="3">${esc(data[probe])}</td></tr>`;
    }
    return header + rows;
  }
  if (testType === 'complex_serology') {
    let rows = '';
    for (let p of SEROLOGY_PARAMS) {
      if (data[p.key] !== undefined) rows += `<tr><td>${esc(p.name)}</td><td colspan="3">${esc(data[p.key])}</td></tr>`;
    }
    return header + rows;
  }
  if (testType === 'complex_pcv' || testType === 'complex_hb' || testType === 'complex_esr' ||
      testType === 'complex_rbs' || testType === 'complex_fbs') {
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
    return `<tr style="background:#f0f0f0;"><td colspan="4" style="font-weight:bold;">${esc(testName)}</td></tr>
            <tr><td>Value</td><td>${val} ${flag}</td><td>${esc(range.unit)}</td><td>${range.low}–${range.high}</td></tr>`;
  }
  // Standard panels
  let params = [];
  if (testType === 'complex_cbc') params = CBC_PARAMS;
  else if (testType === 'complex_lft') params = LFT_PARAMS_FULL;
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
  if (!params.length) return header + `<tr><td colspan="4">${esc(JSON.stringify(data))}</td></tr>`;
  let rows = params.filter(p => data[p.key] !== undefined).map(p => {
    let val = data[p.key];
    let flag = '';
    let n = parseFloat(val);
    if (!isNaN(n)) {
      if (p.high !== null && n > p.high) flag = '↑';
      if (p.low !== null && n < p.low) flag = '↓';
    }
    let ref = (p.low !== null && p.high !== null) ? `${p.low}–${p.high}` : (p.low !== null ? `≥${p.low}` : p.high !== null ? `≤${p.high}` : '—');
    return `<tr><td style="padding:5px;">${esc(p.name)}</td><td style="padding:5px;${flag?'font-weight:bold;':''}">${val} ${flag}</td><td style="padding:5px;">${esc(p.unit)}</td><td style="padding:5px;">${esc(ref)}</td></tr>`;
  }).join('');
  return header + rows;
}

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

  try {
    // Update status + rejection reason in DB
    const { error } = await db
      .from('samples')
      .update({ status: 'Rejected', rejection_reason: reason })
      .eq('id', currentSample.id);
    if (error) throw error;

    // Log to sample_timeline (best-effort)
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

    // Audit log
    await addAudit('Sample Rejected', currentSample.id, reason);

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

// ========== INIT ==========
(async function init() {
  await loadTestDefinitions();
  await renderProcessingSamples();
  startClock();
  document.getElementById('userDisplay').innerHTML = `<i class="fas fa-user-circle"></i> ${esc(currentUser.name)} (${esc(currentUser.role)})`;
  document.getElementById('logoutBtn').addEventListener('click', logoutUser);
})();

setInterval(async () => {
  // Skip auto-refresh when offline — cached data is already shown
  if (!navigator.onLine) return;
  if (!currentSample && document.getElementById('resultModal')?.style.display !== 'flex') {
    await renderProcessingSamples();
  }
}, 15000);
