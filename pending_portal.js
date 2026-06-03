const SUPABASE_URL      = 'https://npdopywxemtwzvpummsn.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5wZG9weXd4ZW10d3p2cHVtbXNuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk4NzY0MjksImV4cCI6MjA5NTQ1MjQyOX0.Mo5LfGdfSiHL6QHsPOaGkDmeaIRDqZTe8MGwz_6ou1c';

// checkAuth() and logoutUser() come from auth-guard.js
const currentSession = checkAuth(['patient', 'admin', 'supervisor', 'technologist', 'reception']);
const currentUser = currentSession;

// Build token-authenticated client — injects x-lis-token on every request
window._supabaseClient = window.buildAuthClient(SUPABASE_URL, SUPABASE_ANON_KEY);

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
  let icon = type === 'error' ? 'times-circle' : 'exclamation-circle';
  div.innerHTML = `<i class="fas fa-${icon}"></i> `;
  let span = document.createElement('span');
  span.textContent = msg;
  div.appendChild(span);
  stack.appendChild(div);
  setTimeout(() => { div.style.opacity = '0'; setTimeout(() => div.remove(), 300); }, 3500);
}
function payBadgeClass(paystatus) {
  if (paystatus === 'Paid')    return 'badge-paid';
  if (paystatus === 'Partial') return 'badge-partial';
  return 'badge-unpaid';
}
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

const db = window._supabaseClient;

// ========== LOAD DATA ==========
let samples = [];
let testDefinitions = { testTypes: {}, testUnits: {}, refRanges: {}, selectOptions: {} };

async function loadTestDefinitions() {
  try {
    const { data, error } = await db.from('test_definitions').select('*');
    if (error) throw error;
    testDefinitions = { testTypes: {}, testUnits: {}, refRanges: {}, selectOptions: {} };
    data.forEach(td => {
      testDefinitions.testUnits[td.test_name] = td.unit_name || 'Other';
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
  } catch (err) {
    console.error(err);
    toast('Failed to load test definitions', 'error');
  }
}

// loadSamples removed — portalSearch queries DB directly with filters

// ========== DYNAMIC REFERENCE RANGE HELPER ==========
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
      if (isMale) return { low: 0, high: 10, unit: 'mm/hr' };
      if (isFemale) return { low: 0, high: 20, unit: 'mm/hr' };
      return { low: 0, high: 15, unit: 'mm/hr' };
    case 'RBS':
    case 'Random Blood Sugar':
      return { low: 70, high: 140, unit: 'mg/dL' };
    case 'FBS':
    case 'Fasting Blood Sugar':
      return { low: 70, high: 100, unit: 'mg/dL' };
    default:
      return null;
  }
}

// ========== LOAD ALL RELEASED SAMPLES + RENDER TABLE ==========
let allSamples = [];

async function loadAndRender() {
  const tbody = document.getElementById('portalTableBody');
  if (tbody) tbody.innerHTML = `<table><td colspan="7" style="padding:40px; text-align:center; color:var(--text2);"><i class="fas fa-spinner fa-spin"></i> Loading…</td></tr>`;

  try {
    const { data, error } = await db
      .from('samples')
      .select('*, sample_tests(*)')
      .eq('status', 'Result Released')
      .order('id', { ascending: false });
    if (error) throw error;

    allSamples = (data || []).map(s => ({
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

    const countEl = document.getElementById('releasedCount');
    if (countEl) countEl.textContent = `${allSamples.length} result${allSamples.length !== 1 ? 's' : ''}`;

    filterTable();
  } catch (err) {
    console.error(err);
    if (tbody) tbody.innerHTML = `<tr><td colspan="7" style="padding:30px; text-align:center; color:var(--red-light);"><i class="fas fa-exclamation-circle"></i> Failed to load results. Please refresh.</td></tr>`;
    toast('Failed to load results', 'error');
  }
}

function filterTable() {
  const q = (document.getElementById('portalSearch')?.value || '').toLowerCase().trim();
  const filtered = q
    ? allSamples.filter(s =>
        s.id.toString().includes(q) ||
        (s.patient || '').toLowerCase().includes(q) ||
        (s.phone || '').toLowerCase().includes(q) ||
        (s.offline_ref || '').toLowerCase().includes(q) ||
        (s.receipt_no || '').toLowerCase().includes(q) ||
        (s.tests || []).some(t => t.test_name?.toLowerCase().includes(q))
      )
    : allSamples;

  const tbody = document.getElementById('portalTableBody');
  if (!tbody) return;

  const countEl = document.getElementById('releasedCount');
  if (countEl) countEl.textContent = q
    ? `${filtered.length} of ${allSamples.length} result${allSamples.length !== 1 ? 's' : ''}`
    : `${allSamples.length} result${allSamples.length !== 1 ? 's' : ''}`;

  if (!filtered.length) {
    tbody.innerHTML = `<tr><td colspan="7" style="padding:40px; text-align:center; color:var(--text2);">
      <i class="fas fa-search" style="font-size:1.5rem; opacity:0.3; display:block; margin-bottom:8px;"></i>
      No results found${q ? ` for "<strong>${esc(q)}</strong>"` : ''}.</td></tr>`;
    return;
  }

  tbody.innerHTML = filtered.map(s => {
    const paycts = s.paystatus === 'Paid' ? 'badge-paid' : s.paystatus === 'Partial' ? 'badge-partial' : 'badge-unpaid';
    const relDate = s.released_at ? new Date(s.released_at).toLocaleDateString('en-GB', { day:'2-digit', month:'short', year:'numeric' }) : '—';
    const testList = (s.tests || []).map(t => `<span style="display:inline-block; background:#f0f6f3; border-radius:6px; padding:1px 6px; font-size:0.7rem; margin:1px;">${esc(t.test_name)}</span>`).join('');
    return `<tr style="border-bottom:1px solid var(--border); cursor:pointer; transition:background 0.15s;"
              onmouseover="this.style.background='#f8fafb'" onmouseout="this.style.background=''"
              onclick="expandResult(${s.id})">
      <td style="padding:10px 14px;">
        <span style="font-family:monospace; font-weight:700; color:var(--primary);">MU-${s.id}</span>
        ${s.receipt_no ? `<br><span style="font-family:monospace; font-size:0.62rem; color:#1d4ed8; background:#eff6ff; border:1px solid #bfdbfe; border-radius:4px; padding:1px 5px; display:inline-block; margin-top:2px;" title="Receipt / RCP number — use this to search"><i class="fas fa-receipt" style="margin-right:2px;font-size:0.6rem;"></i>${esc(s.receipt_no)}</span>` : ''}
        ${s.offline_ref ? `<br><span style="font-family:monospace; font-size:0.62rem; color:#92400e; background:#fff9ec; border:1px solid #fde68a; border-radius:4px; padding:1px 5px; display:inline-block; margin-top:2px;" title="Offline Draft Ref"><i class="fas fa-link" style="margin-right:2px;font-size:0.6rem;"></i>${esc(s.offline_ref)}</span>` : ''}
       </td>
      <td style="padding:10px 14px;">
        <strong>${esc(s.patient)}</strong><br>
        <small style="color:var(--text2);">${s.age ?? '?'}y ${esc(s.gender)}</small>
       </td>
      <td style="padding:10px 14px;">${testList}</td>
      <td style="padding:10px 14px; color:var(--text2); font-size:0.8rem;">${esc(s.collDate || '—')}</td>
      <td style="padding:10px 14px; color:var(--text2); font-size:0.8rem;">${relDate}</td>
      <td style="padding:10px 14px;"><span class="badge ${paycts}">${esc(s.paystatus || '—')}</span></td>
      <td style="padding:10px 14px; white-space:nowrap;">
        <button class="btn btn-primary btn-sm" onclick="event.stopPropagation(); expandResult(${s.id})">
          <i class="fas fa-eye"></i> View
        </button>
        <button class="btn btn-secondary btn-sm" onclick="event.stopPropagation(); generatePDF(${s.id})">
          <i class="fas fa-file-pdf"></i>
        </button>
       </td>
     </tr>`;
  }).join('');
}

// ========== EXPAND RESULT ROW → DETAIL CARD ==========
let currentExpandedId = null;

function expandResult(id) {
  const s = allSamples.find(x => x.id === id);
  if (!s) return;

  const detail = document.getElementById('portalResultDetail');
  if (!detail) return;

  // Toggle: clicking same row again collapses
  if (currentExpandedId === id && detail.style.display !== 'none') {
    detail.style.display = 'none';
    currentExpandedId = null;
    return;
  }

  currentExpandedId = id;
  detail.style.display = 'block';
  detail.innerHTML = `
    <div class="card" style="margin-top:0; border-top:3px solid var(--primary);">
      <div class="card-header" style="justify-content:space-between;">
        <span><i class="fas fa-microscope"></i> Result Detail — MU-${s.id} · ${esc(s.patient)}</span>
        <button class="btn btn-secondary btn-sm" onclick="closeDetail()"><i class="fas fa-times"></i> Close</button>
      </div>
      <div class="card-body">
        ${buildResultCard(s)}
      </div>
    </div>`;

  detail.scrollIntoView({ behavior: 'smooth', block: 'start' });
  addAudit('Portal Result Viewed', s.id, `Viewed by ${currentUser?.name || 'Unknown'}`);
}

function closeDetail() {
  const detail = document.getElementById('portalResultDetail');
  if (detail) detail.style.display = 'none';
  currentExpandedId = null;
}

// ========== STATUS TRACKING HELPER ==========
function getStatusInfo(status) {
  const steps = [
    { key: 'Registered',    label: 'Registered',   icon: 'fa-clipboard-list' },
    { key: 'Collected',     label: 'Collected',    icon: 'fa-syringe' },
    { key: 'Processing',    label: 'Processing',   icon: 'fa-microscope' },
    { key: 'Verifying',     label: 'Verification', icon: 'fa-check-double' },
    { key: 'Result Released', label: 'Released',   icon: 'fa-file-pdf' }
  ];
  let currentStepIndex = 0;
  if (status === 'Collected') currentStepIndex = 1;
  else if (status === 'Processing') currentStepIndex = 2;
  else if (status === 'Verifying') currentStepIndex = 3;
  else if (status === 'Result Released') currentStepIndex = 4;
  let statusText = '';
  let statusClass = '';
  switch (status) {
    case 'Collected': statusText = 'Sample Collected'; statusClass = 'status-collected'; break;
    case 'Processing': statusText = 'Processing in Lab'; statusClass = 'status-processing'; break;
    case 'Verifying': statusText = 'Under Verification'; statusClass = 'status-verifying'; break;
    case 'Result Released': statusText = 'Results Ready'; statusClass = 'status-released'; break;
    default: statusText = status || 'Registered'; statusClass = 'status-collected';
  }
  return { steps, currentStepIndex, statusText, statusClass };
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
  {key:'anti_hbc', name:'Anti-HBc (Total)', type:'select', options:['Non-reactive','Reactive']},
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

// ========== GROUP TESTS BY UNIT ==========
function groupTestsByUnit(tests) {
  const groups = {};
  tests.forEach(test => {
    const unit = testDefinitions.testUnits[test.test_name] || 'General';
    if (!groups[unit]) groups[unit] = [];
    groups[unit].push(test);
  });
  return groups;
}

// ========== BUILD RESULT CARD (with progress tracker) ==========
function buildResultCard(s) {
  const groups = groupTestsByUnit(s.tests);
  let testSections = '';
  for (const [unitName, unitTests] of Object.entries(groups)) {
    testSections += `<div class="unit-group"><div class="unit-title">${esc(unitName)}</div>`;
    unitTests.forEach(t => {
      let testType = testDefinitions.testTypes[t.test_name] || '';
      if (!t.result || !t.result.startsWith('{')) {
        testSections += `
          <table class="param-table">
            <thead><tr><th>Parameter</th><th>Result</th><th>Unit</th><th>Reference</th></tr></thead>
            <tbody>
               <tr><td style="font-weight:500;">${esc(t.test_name)}</td><td>${esc(t.result || '—')}</td><td>—</td><td>—</td></tr>
            </tbody>
          </table>`;
      } else {
        try {
          let data = JSON.parse(t.result);
          testSections += buildParamTable(t.test_name, data, testType, s.age, s.gender);
        } catch(e) {
          testSections += `<div><strong>${esc(t.test_name)}</strong><br>${esc(t.result)}</div>`;
        }
      }
    });
    testSections += `</div>`;
  }

  const { steps, currentStepIndex, statusText, statusClass } = getStatusInfo(s.status);
  const stepsHtml = steps.map((step, idx) => {
    let stepState = '';
    if (idx < currentStepIndex) stepState = 'completed';
    else if (idx === currentStepIndex) stepState = 'active';
    return `<div class="step ${stepState}">
      <div class="step-icon"><i class="fas ${step.icon}"></i></div>
      <div class="step-label">${step.label}</div>
    </div>`;
  }).join('');

  return `
    <div class="result-block">
      <div class="result-block-head">
        <div>
          <div style="font-weight:700;">MU-${s.id} — ${esc(s.patient)}</div>
          <div style="font-size:0.8rem; color:var(--text2); margin-top:2px;">
            ${s.age ?? '?'}y ${esc(s.gender)}
            &nbsp;|&nbsp; Collected: ${s.collection_date}
            &nbsp;|&nbsp; Released: ${s.released_at ? new Date(s.released_at).toLocaleString() : '—'}
          </div>
          ${s.clinician ? `<div style="font-size:0.8rem; color:var(--text2);">Clinician: ${esc(s.clinician)}</div>` : ''}
          ${s.offline_ref ? `<div style="margin-top:4px;"><span style="font-family:var(--mono); font-size:0.68rem; background:#fff9ec; border:1px solid #fde68a; color:#92400e; padding:2px 8px; border-radius:6px; display:inline-block;"><i class="fas fa-link" style="margin-right:3px;"></i>${esc(s.offline_ref)}</span></div>` : ''}
        </div>
        <div style="text-align:right;">
          <span class="badge ${payBadgeClass(s.pay_status)}">${esc(s.pay_status)}</span><br>
          <small style="color:var(--text2);">Paid: ${(s.amount_paid || 0).toFixed(2)} NGN | Balance: ${(s.balance_due || 0).toFixed(2)} NGN</small>
        </div>
      </div>
      <div class="result-block-body">
        <!-- Progress Tracker -->
        <div class="progress-tracker">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
            <span style="font-weight:600; font-size:0.8rem;">Sample Progress</span>
            <span class="status-badge ${statusClass}">${statusText}</span>
          </div>
          <div class="progress-steps">${stepsHtml}</div>
          <div style="font-size:0.7rem; color:var(--text2); margin-top:10px; text-align:center;">
            ${s.status === 'Result Released' ? 'Your results are ready for download.' : 'Your sample is being processed. You will be notified when results are ready.'}
          </div>
        </div>
        ${testSections}
        <div style="margin-top:14px; display:flex; gap:10px; flex-wrap:wrap;">
          <button class="btn btn-primary btn-sm" onclick="generatePDF(${s.id})">
            <i class="fas fa-file-pdf"></i> Download PDF
          </button>
        </div>
      </div>
    </div>`;
}

// ========== BUILD PARAM TABLE (handles culture sensitivities, urine/stool MCS, etc.) ==========
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
      </tr>`;
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
      <tbody>${sensRows || '<tr><td colspan="4" style="color:#6b7280;">No antibiotic sensitivities recorded.</td></td>'}</tbody>
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
       </td>`;
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
    return `<table class="param-table"><tbody>${rows}</tbody><td>`;
  }

  // Serology
  if (testType === 'complex_serology') {
    let rows = '';
    for (let p of SEROLOGY_PARAMS) {
      if (data[p.key] !== undefined) rows += `<tr><td>${esc(p.name)}</td><td colspan="3">${esc(data[p.key])}</td></tr>`;
    }
    return `<table class="param-table"><tbody>${rows}</tbody></table>`;
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
    return `<table class="param-table"><tbody><tr><td style="font-weight:500;">${esc(testName)}</td><td colspan="3">${val}</td></tr></tbody></tr>`;
  }

  // Standard numeric panels
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
    let ref = (p.low !== null && p.high !== null) ? `${p.low}–${p.high}` : (p.low !== null ? `≥${p.low}` : p.high !== null ? `≤${p.high}` : '—');
    if (p.type === 'number' || !p.type) {
      let n = parseFloat(val);
      if (!isNaN(n)) {
        if (p.high !== null && n > p.high) flag = '↑';
        if (p.low !== null && n < p.low) flag = '↓';
        displayVal = `${n} ${flag}`;
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
// ========== PDF GENERATION — native jsPDF (no html2canvas, clean page breaks) ==========
async function generatePDF(id) {
  let s = (typeof allSamples !== 'undefined' ? allSamples : samples || []).find(x => x.id === id);
  if (!s) { toast('Sample not found', 'error'); return; }

  const { jsPDF } = window.jspdf;
  const pdf = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });
  const PW = 210, PH = 297, ML = 14, MR = 14, MT = 14, MB = 14;
  const CW = PW - ML - MR; // usable content width = 182 mm
  const GREEN = [31, 110, 67];
  const DARK  = [26, 44, 62];
  const GRAY  = [90, 126, 148];
  const LGRAY = [240, 244, 249];

  // ── helper: add repeating header/footer on every page ──
  function addPageChrome() {
    const total = pdf.getNumberOfPages();
    for (let p = 1; p <= total; p++) {
      pdf.setPage(p);
      // header bar
      pdf.setFillColor(...GREEN);
      pdf.rect(0, 0, PW, 18, 'F');
      pdf.setFont('helvetica', 'bold');
      pdf.setFontSize(13);
      pdf.setTextColor(255,255,255);
      pdf.text("MU'UJIZA DIAGNOSTICS", PW / 2, 10, { align: 'center' });
      pdf.setFontSize(7);
      pdf.setFont('helvetica', 'normal');
      pdf.text('Accredited Laboratory · ISO 15189', PW / 2, 15, { align: 'center' });
      // footer
      pdf.setDrawColor(...GREEN);
      pdf.setLineWidth(0.3);
      pdf.line(ML, PH - 10, PW - MR, PH - 10);
      pdf.setFontSize(7);
      pdf.setTextColor(...GRAY);
      pdf.text('Electronically generated by MU\'UJIZA DIAGNOSTICS LIS', ML, PH - 6);
      pdf.text(`Page ${p} of ${total}`, PW - MR, PH - 6, { align: 'right' });
    }
  }

  // ── patient info block ──
  let y = 24; // below header bar
  pdf.setFontSize(9);
  pdf.setTextColor(...DARK);

  const infoLines = [
    [`Sample ID: MU-${s.id}${s.offline_ref ? '  [Draft Ref: ' + s.offline_ref + ']' : ''}`,
     `Collected: ${s.collection_date || '—'}`],
    [`Patient: ${s.patient || '—'}  (${s.age ?? '?'}y, ${s.gender || '—'})`,
     `Released: ${s.released_at ? new Date(s.released_at).toLocaleString() : '—'}`],
    [`Payment: ${s.pay_status || '—'}  |  Paid: ${(s.amount_paid || 0).toFixed(2)} NGN  |  Balance: ${(s.balance_due || 0).toFixed(2)} NGN`,
     s.clinician ? `Clinician: ${s.clinician}` : '']
  ];
  if (s.supervisor_comment) {
    infoLines.push([`Supervisor Note: ${s.supervisor_comment}`, '']);
  }

  pdf.setFillColor(...LGRAY);
  pdf.roundedRect(ML, y, CW, infoLines.length * 6 + 6, 2, 2, 'F');
  y += 5;
  infoLines.forEach(([left, right]) => {
    pdf.setFont('helvetica', 'bold');
    const boldParts = left.match(/^([^:]+:)(.*)/);
    if (boldParts) {
      pdf.text(boldParts[1], ML + 3, y);
      pdf.setFont('helvetica', 'normal');
      pdf.text(boldParts[2], ML + 3 + pdf.getTextWidth(boldParts[1]), y);
    } else {
      pdf.setFont('helvetica', 'normal');
      pdf.text(left, ML + 3, y);
    }
    if (right) {
      pdf.setFont('helvetica', 'normal');
      pdf.text(right, PW - MR - 3, y, { align: 'right' });
    }
    y += 6;
  });
  y += 4;

  // ── build autoTable rows ──
  const tableBody = [];
  const groups = groupTestsByUnit(s.tests);

  for (const [unitName, unitTests] of Object.entries(groups)) {
    // section header row (spans all 4 cols via didParseCell)
    tableBody.push([{ content: unitName, colSpan: 4, styles: { fillColor: GREEN, textColor: [255,255,255], fontStyle: 'bold', fontSize: 8 } }]);

    for (let t of unitTests) {
      let testType = testDefinitions.testTypes[t.test_name] || '';
      if (!t.result || !t.result.startsWith('{')) {
        tableBody.push([t.test_name, t.result || '—', '', '']);
      } else {
        try {
          let data = JSON.parse(t.result);
          collectAutoTableRows(tableBody, t.test_name, data, testType, s.age, s.gender);
        } catch(e) {
          tableBody.push([t.test_name, t.result || '—', '', '']);
        }
      }
    }
  }

  pdf.autoTable({
    startY: y,
    head: [[
      { content: 'Parameter', styles: { fillColor: LGRAY, textColor: DARK, fontStyle: 'bold' } },
      { content: 'Result',    styles: { fillColor: LGRAY, textColor: DARK, fontStyle: 'bold' } },
      { content: 'Unit',      styles: { fillColor: LGRAY, textColor: DARK, fontStyle: 'bold' } },
      { content: 'Reference', styles: { fillColor: LGRAY, textColor: DARK, fontStyle: 'bold' } }
    ]],
    body: tableBody,
    margin: { left: ML, right: MR, top: 22, bottom: 16 },
    theme: 'grid',
    styles: { fontSize: 8, cellPadding: 2.5, textColor: DARK, lineColor: [210,220,230], lineWidth: 0.2 },
    columnStyles: {
      0: { cellWidth: 64 },
      1: { cellWidth: 46 },
      2: { cellWidth: 32 },
      3: { cellWidth: 40 }
    },
    didParseCell: function(data) {
      // Colour HIGH/LOW flags
      if (data.section === 'body' && data.column.index === 1) {
        const txt = String(data.cell.raw || '');
        if (txt.includes('↑')) data.cell.styles.textColor = [185, 28, 28];
        if (txt.includes('↓')) data.cell.styles.textColor = [59, 130, 246];
      }
      // Alternate row tint for regular rows
      if (data.section === 'body' && data.row.index % 2 === 0) {
        if (!data.cell.styles.fillColor || data.cell.styles.fillColor === 'transparent') {
          // only tint rows that aren't already styled
          if (!(data.cell.raw && typeof data.cell.raw === 'object' && data.cell.raw.styles && data.cell.raw.styles.fillColor)) {
            data.cell.styles.fillColor = [252, 253, 254];
          }
        }
      }
    },
    didDrawPage: function() {
      // re-draw green header strip on each new page (autoTable fires this after each page)
      pdf.setFillColor(...GREEN);
      pdf.rect(0, 0, PW, 18, 'F');
      pdf.setFont('helvetica', 'bold');
      pdf.setFontSize(13);
      pdf.setTextColor(255,255,255);
      pdf.text("MU'UJIZA DIAGNOSTICS", PW / 2, 10, { align: 'center' });
      pdf.setFontSize(7);
      pdf.setFont('helvetica', 'normal');
      pdf.text('Accredited Laboratory · ISO 15189', PW / 2, 15, { align: 'center' });
    }
  });

  addPageChrome();
  pdf.save(`MU${s.id}_${(s.patient || 'patient').replace(/\s/g, '_')}.pdf`);
  await addAudit('PDF Downloaded', s.id, `Report downloaded by ${currentUser ? currentUser.name : 'Unknown'}`);
  toast('PDF downloaded');
}

// ── collect rows for autoTable (mirrors generatePDFRows logic) ──
function collectAutoTableRows(body, testName, data, testType, age, gender) {
  const HIGH_COLOR = [185, 28, 28];
  const LOW_COLOR  = [59, 130, 246];

  const dynamicTests = ['complex_pcv', 'complex_hb', 'complex_esr', 'complex_rbs', 'complex_fbs'];
  if (dynamicTests.includes(testType)) {
    let key = testType.split('_')[1];
    let val = data[key] !== undefined ? data[key] : '';
    let range = getReferenceRange(testName, age, gender) || { low: 0, high: 100, unit: '' };
    let flag = ''; let col = null;
    let num = parseFloat(val);
    if (!isNaN(num)) {
      if (num > range.high) { flag = ' ↑'; col = HIGH_COLOR; }
      else if (num < range.low) { flag = ' ↓'; col = LOW_COLOR; }
    }
    body.push([testName, { content: val + flag, styles: col ? { textColor: col, fontStyle: 'bold' } : {} }, range.unit, `${range.low}–${range.high}`]);
    return;
  }

  if (testType === 'complex_widal') {
    body.push([{ content: 'Widal Test', colSpan: 4, styles: { fillColor: [232, 244, 240], fontStyle: 'bold' } }]);
    body.push(['Organism', 'O Antigen (TO)', 'H Antigen (TH)', '']);
    const widalRows = [
      { org: 'S. Typhi',       o: data.o, h: data.h },
      { org: 'S. Paratyphi A', o: data.ao, h: data.ah },
      { org: 'S. Paratyphi B', o: data.bo, h: data.bh },
      { org: 'S. Paratyphi C', o: data.co, h: data.ch }
    ];
    widalRows.forEach(r => {
      const oFlag = parseInt(r.o) >= 160 ? ' ↑' : '';
      const hFlag = parseInt(r.h) >= 160 ? ' ↑' : '';
      const oTxt = r.o !== undefined && r.o !== null ? `1:${r.o}${oFlag}` : '—';
      const hTxt = r.h !== undefined && r.h !== null ? `1:${r.h}${hFlag}` : '—';
      body.push([
        { content: r.org, styles: { fontStyle: 'italic' } },
        { content: oTxt, styles: oFlag ? { textColor: HIGH_COLOR, fontStyle: 'bold' } : {} },
        { content: hTxt, styles: hFlag ? { textColor: HIGH_COLOR, fontStyle: 'bold' } : {} },
        ''
      ]);
    });
    return;
  }

  if (testType === 'complex_culture' || testType === 'complex_stool_cs') {
    body.push([{ content: testName, colSpan: 4, styles: { fillColor: [232, 244, 240], fontStyle: 'bold' } }]);
    body.push(['Organism', { content: data.organism || 'Not specified', colSpan: 3, styles: { fontStyle: 'italic' } }]);
    if (data.sensitivities && data.sensitivities.length) {
      body.push([{ content: 'Antibiotic', styles: { fontStyle: 'bold' } }, { content: 'Result', styles: { fontStyle: 'bold' } }, { content: 'Interpretation', colSpan: 2, styles: { fontStyle: 'bold' } }]);
      data.sensitivities.forEach(s => {
        const label  = s.result === 'S' ? 'Sensitive' : s.result === 'R' ? 'Resistant' : s.result === 'I' ? 'Intermediate' : s.result || '—';
        const col    = s.result === 'S' ? [21,128,61] : s.result === 'R' ? HIGH_COLOR : s.result === 'I' ? [146,64,14] : [55,65,81];
        body.push([s.antibiotic, { content: s.result || '—', styles: { textColor: col, fontStyle: 'bold' } }, { content: label, colSpan: 2, styles: { textColor: col } }]);
      });
    } else {
      body.push([{ content: 'No antibiotic sensitivities recorded.', colSpan: 4, styles: { textColor: [107,114,128] } }]);
    }
    return;
  }

  if (testType === 'complex_urine_mcs' || testType === 'complex_stool_mcs') {
    const isMCS = testType === 'complex_urine_mcs';
    const MICRO_PARAMS = isMCS ? URINE_MICRO_PARAMS : STOOL_MICRO_PARAMS;
    const sections = isMCS ? ['Physical','Chemical','Microscopy'] : ['Macroscopy','Microscopy'];
    body.push([{ content: testName, colSpan: 4, styles: { fillColor: [219, 234, 254], fontStyle: 'bold' } }]);
    sections.forEach(sec => {
      let secRows = [];
      MICRO_PARAMS.filter(p => p.section === sec).forEach(p => {
        let v = data[p.key];
        if (v === undefined || v === '' || v === 'None' || v === 'None seen' || v === 'Absent' || v === 'Negative') return;
        let flag = ''; let col = null;
        if (p.type === 'number' && p.low !== undefined) {
          let n = parseFloat(v);
          if (!isNaN(n)) { if (n > p.high) { flag = ' ↑'; col = HIGH_COLOR; } else if (n < p.low) { flag = ' ↓'; col = LOW_COLOR; } }
        }
        secRows.push([p.name, { content: v + flag, styles: col ? { textColor: col, fontStyle: 'bold' } : {} }, p.unit || '', '—']);
      });
      if (!secRows.length) return;
      body.push([{ content: sec, colSpan: 4, styles: { fillColor: [239, 246, 255], fontStyle: 'bold', fontSize: 7 } }]);
      secRows.forEach(r => body.push(r));
    });
    // C&S
    body.push([{ content: 'Culture & Sensitivity', colSpan: 4, styles: { fillColor: [239, 246, 255], fontStyle: 'bold', fontSize: 7 } }]);
    body.push(['Organism', { content: data.organism || 'No growth / Not specified', colSpan: 3, styles: { fontStyle: 'italic' } }]);
    if (data.sensitivities && data.sensitivities.length) {
      data.sensitivities.forEach(s => {
        const label = s.result==='S'?'Sensitive':s.result==='R'?'Resistant':s.result==='I'?'Intermediate':s.result||'—';
        const col   = s.result==='S'?[21,128,61]:s.result==='R'?HIGH_COLOR:s.result==='I'?[146,64,14]:[55,65,81];
        body.push([s.antibiotic, { content: s.result||'—', styles: { textColor: col, fontStyle: 'bold' } }, { content: label, colSpan: 2, styles: { textColor: col } }]);
      });
    } else {
      body.push([{ content: 'No antibiotic sensitivities recorded.', colSpan: 4, styles: { textColor: [107,114,128] } }]);
    }
    return;
  }

  if (testType === 'complex_malaria') {
    body.push([{ content: testName, colSpan: 4, styles: { fillColor: [232, 244, 240], fontStyle: 'bold' } }]);
    if (data.species)  body.push(['Species', { content: data.species, colSpan: 3 }]);
    if (data.stage)    body.push(['Stage',   { content: data.stage, colSpan: 3 }]);
    if (data.density !== undefined) body.push(['Parasite Density', { content: data.density + ' parasites/µL', colSpan: 3 }]);
    return;
  }

  if (testType === 'complex_tb_genexpert') {
    body.push([{ content: testName, colSpan: 4, styles: { fillColor: [232, 244, 240], fontStyle: 'bold' } }]);
    if (data.mtb_detected) body.push(['MTB Detected', { content: data.mtb_detected, colSpan: 3 }]);
    if (data.rif_resistance) body.push(['Rifampicin Resistance', { content: data.rif_resistance, colSpan: 3 }]);
    for (let probe of ['probeA_ct','probeB_ct','probeC_ct','probeD_ct','probeE_ct']) {
      if (data[probe] !== undefined) body.push([probe.replace('_ct',' Probe Ct'), { content: data[probe], colSpan: 3 }]);
    }
    return;
  }

  if (testType === 'complex_serology') {
    body.push([{ content: testName, colSpan: 4, styles: { fillColor: [232, 244, 240], fontStyle: 'bold' } }]);
    for (let p of SEROLOGY_PARAMS) {
      if (data[p.key] !== undefined) body.push([p.name, { content: data[p.key], colSpan: 3 }]);
    }
    return;
  }

  // Standard numeric panels
  let params = [];
  if (testType === 'complex_cbc')       params = CBC_PARAMS;
  else if (testType === 'complex_lft')  params = LFT_PARAMS_FULL;
  else if (testType === 'complex_rft')  params = RFT_PARAMS_FULL;
  else if (testType === 'complex_thyroid') params = THYROID_PARAMS;
  else if (testType === 'complex_lipid')   params = LIPID_PARAMS;
  else if (testType === 'complex_coag')    params = COAG_PARAMS;
  else if (testType === 'complex_urinalysis') params = URINALYSIS_MICRO_PARAMS;
  else if (testType === 'complex_iron')    params = IRON_PARAMS;
  else if (testType === 'complex_bone')    params = BONE_PARAMS;
  else if (testType === 'complex_cardiac') params = CARDIAC_PARAMS;
  else if (testType === 'complex_ogtt')    params = OGTT_PARAMS;
  else if (testType === 'complex_csf')     params = CSF_PARAMS;
  else if (testType === 'complex_abg')     params = ABG_PARAMS;
  else if (testType === 'complex_semen')   params = SEMEN_PARAMS;

  if (!params.length) {
    body.push([{ content: testName, colSpan: 4, styles: { fillColor: [240, 244, 249], fontStyle: 'bold' } }]);
    Object.entries(data).forEach(([k, v]) => body.push([k, { content: String(v), colSpan: 3 }]));
    return;
  }

  body.push([{ content: testName, colSpan: 4, styles: { fillColor: [240, 244, 249], fontStyle: 'bold' } }]);
  for (let p of params) {
    let val = data[p.key];
    if (val === undefined || val === '') continue;
    let flag = ''; let col = null;
    let ref = (p.low !== null && p.high !== null) ? `${p.low}–${p.high}` : p.low !== null ? `≥${p.low}` : p.high !== null ? `≤${p.high}` : '—';
    let n = parseFloat(val);
    if (!isNaN(n)) {
      if (p.high !== null && n > p.high) { flag = ' ↑'; col = HIGH_COLOR; }
      if (p.low  !== null && n < p.low)  { flag = ' ↓'; col = LOW_COLOR; }
    }
    body.push([p.name, { content: String(val) + flag, styles: col ? { textColor: col, fontStyle: 'bold' } : {} }, p.unit || '', ref]);
  }
}

// ========== CLOCK ==========
function startClock() {
  function tick() {
    const clockDisplay = document.getElementById('clockDisplay');
    if (clockDisplay) clockDisplay.innerText = new Date().toLocaleTimeString('en-GB');
  }
  tick(); setInterval(tick, 1000);
}

// ========== INIT ==========
// ========== PORTAL TAB SWITCHING ==========
let _currentPortalTab = 'released';

function switchPortalTab(tab) {
  _currentPortalTab = tab;
  const releasedEl = document.getElementById('portalTabReleased');
  const rejectedEl = document.getElementById('portalTabRejected');
  const relBtn = document.getElementById('tabReleasedBtn');
  const rejBtn = document.getElementById('tabRejectedBtn');

  if (tab === 'released') {
    if (releasedEl) releasedEl.style.display = '';
    if (rejectedEl) rejectedEl.style.display = 'none';
    if (relBtn) { relBtn.style.background = 'var(--primary)'; relBtn.style.color = '#fff'; }
    if (rejBtn) { rejBtn.style.background = '#f8fafb'; rejBtn.style.color = 'var(--text2)'; }
  } else {
    if (releasedEl) releasedEl.style.display = 'none';
    if (rejectedEl) rejectedEl.style.display = '';
    if (relBtn) { relBtn.style.background = '#f8fafb'; relBtn.style.color = 'var(--text2)'; }
    if (rejBtn) { rejBtn.style.background = '#b91c1c'; rejBtn.style.color = '#fff'; }
    loadRejectedSamples();
  }
}

// ========== REJECTED TESTS TAB ==========
let allRejectedSamples = [];

async function loadRejectedSamples() {
  const container = document.getElementById('rejectedTableBody');
  if (container) container.innerHTML = `<div style="text-align:center; padding:40px; color:var(--text2);"><i class="fas fa-spinner fa-spin"></i> Loading…</div>`;

  try {
    // Fetch samples that have at least one rejected test
    const { data, error } = await db
      .from('sample_tests')
      .select('id, sample_id, test_name, status, rejection_reason, samples(id, patient, age, gender, phone, collection_date, status)')
      .eq('status', 'Rejected')
      .order('sample_id', { ascending: false });

    if (error) throw error;

    // Group by sample
    const bySample = {};
    (data || []).forEach(t => {
      const sid = t.sample_id;
      if (!bySample[sid]) {
        bySample[sid] = {
          sample: t.samples,
          rejectedTests: []
        };
      }
      byPhoto[sid].rejectedTests.push(t);
    });
    // fix typo in code above
    Object.keys(byPhoto || {}).forEach(k => { byPhoto[k] = byPhoto[k]; }); // noop guard

    allRejectedSamples = Object.values(bySample);

    const badge = document.getElementById('rejectedBadge');
    const countEl = document.getElementById('rejectedCount');
    const total = allRejectedSamples.length;
    if (badge) { badge.textContent = total; badge.style.display = total ? 'inline' : 'none'; }
    if (countEl) countEl.textContent = `${total} sample${total !== 1 ? 's' : ''} with rejected tests`;

    renderRejectedTable(allRejectedSamples);
  } catch(err) {
    console.error(err);
    if (container) container.innerHTML = `<div style="text-align:center; padding:30px; color:var(--red-light);"><i class="fas fa-exclamation-circle"></i> Failed to load. Please refresh.</div>`;
  }
}

// Fix the typo — use byPhoto consistently
async function loadRejectedSamples() {
  const container = document.getElementById('rejectedTableBody');
  if (container) container.innerHTML = `<div style="text-align:center; padding:40px; color:var(--text2);"><i class="fas fa-spinner fa-spin"></i> Loading…</div>`;

  try {
    const { data, error } = await db
      .from('sample_tests')
      .select('id, sample_id, test_name, status, rejection_reason')
      .eq('status', 'Rejected')
      .order('sample_id', { ascending: false });
    if (error) throw error;

    // Get unique sample IDs then fetch sample info
    const sampleIds = [...new Set((data || []).map(t => t.sample_id))];
    let samplesInfo = {};
    if (sampleIds.length) {
      const { data: sData } = await db
        .from('samples')
        .select('id, patient, age, gender, phone, collection_date, status')
        .in('id', sampleIds);
      (sData || []).forEach(s => { samplesInfo[s.id] = s; });
    }

    // Group rejected tests by sample
    const byGroup = {};
    (data || []).forEach(t => {
      if (!byGroup[t.sample_id]) byGroup[t.sample_id] = { sample: samplesInfo[t.sample_id] || { id: t.sample_id }, rejectedTests: [] };
      byGroup[t.sample_id].rejectedTests.push(t);
    });

    allRejectedSamples = Object.values(byGroup);

    const badge = document.getElementById('rejectedBadge');
    const countEl = document.getElementById('rejectedCount');
    const total = allRejectedSamples.length;
    if (badge) { badge.textContent = total; badge.style.display = total ? 'inline' : 'none'; }
    if (countEl) countEl.textContent = `${total} sample${total !== 1 ? 's' : ''} with rejected tests`;

    renderRejectedTable(allRejectedSamples);
  } catch(err) {
    console.error(err);
    if (container) container.innerHTML = `<div style="text-align:center; padding:30px; color:#b91c1c;"><i class="fas fa-exclamation-circle"></i> Failed to load. Please refresh.</div>`;
  }
}

function renderRejectedTable(groups) {
  const container = document.getElementById('rejectedTableBody');
  if (!container) return;
  if (!groups.length) {
    container.innerHTML = `<div style="text-align:center; padding:40px; color:var(--text2);"><i class="fas fa-check-circle" style="font-size:2rem; opacity:0.3; display:block; margin-bottom:12px;"></i>No rejected tests found</div>`;
    return;
  }
  container.innerHTML = groups.map(g => {
    const s = g.sample || {};
    const sampleStatus = s.status || '—';
    const statusColour = sampleStatus === 'Result Released' ? '#15803d' : '#c47b2e';
    return `
      <div style="border:1.5px solid #fca5a5; border-radius:14px; padding:16px; margin-bottom:14px; background:#fff;">
        <div style="display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:8px; margin-bottom:12px;">
          <div>
            <span style="font-family:monospace; font-weight:700; font-size:1rem; color:var(--primary);">MU-${s.id}</span>
            <span style="font-weight:600; margin-left:10px;">${esc(s.patient || '—')}</span>
            <span style="color:var(--text2); font-size:0.82rem; margin-left:8px;">${s.age ?? '?'}y ${esc(s.gender || '')}</span>
          </div>
          <div style="font-size:0.75rem; color:${statusColour}; font-weight:600; background:#f8fafb; border-radius:20px; padding:3px 12px; border:1px solid #e5e7eb;">
            Sample: ${esc(sampleStatus)}
          </div>
        </div>
        <div style="font-size:0.78rem; color:var(--text2); margin-bottom:10px;">
          <i class="fas fa-calendar"></i> Collected: ${esc(s.collection_date || '—')} &nbsp;|&nbsp;
          <i class="fas fa-phone"></i> ${esc(s.phone || '—')}
        </div>
        <div style="font-weight:700; font-size:0.78rem; text-transform:uppercase; letter-spacing:.5px; color:#b91c1c; margin-bottom:8px;">
          <i class="fas fa-ban"></i> Rejected Test${g.rejectedTests.length > 1 ? 's' : ''}
        </div>
        ${g.rejectedTests.map(t => `
          <div style="display:flex; align-items:center; gap:10px; padding:8px 12px; background:#fff0f0; border-radius:10px; margin-bottom:6px; border:1px solid #fde8e8;">
            <i class="fas fa-vial" style="color:#b91c1c;"></i>
            <span style="font-weight:600; font-size:0.85rem;">${esc(t.test_name)}</span>
            <span style="flex:1; font-size:0.78rem; color:#b91c1c;">Reason: ${esc(t.rejection_reason || 'Not specified')}</span>
          </div>`).join('')}
        <div style="margin-top:10px; background:#fff7ed; border-radius:8px; padding:8px 12px; font-size:0.78rem; color:#92400e;">
          <i class="fas fa-info-circle"></i> Please return to the laboratory with a fresh sample for the rejected test(s) above. Your other results (if any) are unaffected.
        </div>
      </div>`;
  }).join('');
}

function filterRejectedTable() {
  const q = (document.getElementById('rejectedSearch')?.value || '').toLowerCase().trim();
  if (!q) { renderRejectedTable(allRejectedSamples); return; }
  const filtered = allRejectedSamples.filter(g => {
    const s = g.sample || {};
    return String(s.id).includes(q) ||
      (s.patient || '').toLowerCase().includes(q) ||
      (s.phone || '').includes(q);
  });
  renderRejectedTable(filtered);
}

(async function init() {
  console.log('Initializing Patient Portal...');
  await loadTestDefinitions();
  await loadAndRender();
  startClock();
  document.getElementById('userDisplay').innerHTML = `<i class="fas fa-user-circle"></i> ${esc(currentUser.name)} (${esc(currentUser.role)})`;
  document.getElementById('logoutBtn').addEventListener('click', logoutUser);
  // Load rejected count for badge on init
  loadRejectedSamples().catch(() => {});
  // Auto-refresh every 60 seconds
  setInterval(loadAndRender, 60000);
})();

// ========== PWA Service Worker ==========
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}