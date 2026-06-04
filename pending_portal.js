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
  // Standard physical
  {key:'volume', name:'Volume', unit:'mL', low:1.5, high:6.0, type:'number', step:0.1},
  {key:'liquefaction', name:'Liquefaction Time', type:'select', options:['Normal (<60 min)','Delayed (>60 min)']},
  {key:'viscosity', name:'Viscosity', type:'select', options:['Normal','High']},
  {key:'ph', name:'pH', unit:'', low:7.2, high:8.0, type:'number', step:0.1},

  // Microscopic
  {key:'count', name:'Sperm Concentration', unit:'million/mL', low:15, high:200, type:'number'},
  {key:'total_count', name:'Total Sperm Count', unit:'million/ejaculate', low:39, high:500, type:'number'},
  {key:'progressive_motility', name:'Progressive Motility (PR)', unit:'%', low:32, high:100, type:'number'},
  {key:'non_progressive_motility', name:'Non-Progressive Motility (NP)', unit:'%', low:0, high:100, type:'number'},
  {key:'immotile', name:'Immotile (IM)', unit:'%', low:0, high:100, type:'number'},
  {key:'vitality', name:'Sperm Vitality (live)', unit:'%', low:58, high:100, type:'number'},
  {key:'morphology_normal', name:'Normal Morphology (Kruger)', unit:'%', low:4, high:14, type:'number'},
  {key:'morphology_strict', name:'Strict Morphology (Tygerberg)', unit:'%', low:4, high:14, type:'number'},
  {key:'agglutination', name:'Agglutination', type:'select', options:['None','Mild','Moderate','Severe']},
  {key:'round_cells', name:'Round Cells', unit:'x10⁶/mL', low:0, high:5, type:'number'},
  {key:'wbc', name:'WBC (Peroxidase positive)', unit:'x10⁶/mL', low:0, high:1, type:'number'},

  // Advanced (optional)
  {key:'mar_test', name:'MAR Test (IgG)', unit:'% bound', low:0, high:10, type:'number'},
  {key:'dna_fragmentation', name:'Sperm DNA Fragmentation', unit:'%', low:0, high:15, type:'number'},
  {key:'fructose', name:'Seminal Fructose', unit:'µmol/ejaculate', low:13, high:35, type:'number'},

  // Comments
  {key:'comments', name:'Microscopy Comments', type:'text'}
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
    let ref = (p.low != null && p.high != null) ? `${p.low}–${p.high}` : (p.low != null ? `≥${p.low}` : p.high != null ? `≤${p.high}` : '—');
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
// ========== AUTHORISING SIGNATURE (embedded PNG, transparent background) ==========
const AUTHORISING_SIGNATURE_B64 = 'data:image/png;base64,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';
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
      pdf.rect(0, 0, PW, 20, 'F');
      pdf.setFont('helvetica', 'bold');
      pdf.setFontSize(10);
      pdf.setTextColor(255,255,255);
      pdf.text('GENERAL HOSPITAL KONTAGORA', PW / 2, 7, { align: 'center' });
      pdf.setFontSize(8);
      pdf.text('MEDICAL LABORATORY SCIENCE DEPARTMENT', PW / 2, 13, { align: 'center' });
      // Niger State logo left side
      pdf.setFillColor(0, 153, 204);
      pdf.rect(2, 1, 16, 18, 'F');
      pdf.setFontSize(5);
      pdf.setFont('helvetica', 'bold');
      pdf.setTextColor(255,255,255);
      pdf.text('NIGER', 10, 9, { align: 'center' });
      pdf.text('STATE', 10, 15, { align: 'center' });
      // Microscope/MLS logo right side
      pdf.setFillColor(31, 110, 67);
      pdf.rect(PW - 18, 1, 16, 18, 'F');
      pdf.setFontSize(5);
      pdf.setFont('helvetica', 'bold');
      pdf.setTextColor(255,255,255);
      pdf.text('MED.', PW - 10, 10, { align: 'center' });
      pdf.text('LAB.', PW - 10, 16, { align: 'center' });
      // footer
      pdf.setDrawColor(...GREEN);
      pdf.setLineWidth(0.3);
      pdf.line(ML, PH - 10, PW - MR, PH - 10);
      pdf.setFontSize(7);
      pdf.setTextColor(...GRAY);
      pdf.text('Electronically generated by General Hospital Kontagora - Medical Laboratory Science Dept.', ML, PH - 6);
      pdf.text(`Page ${p} of ${total}`, PW - MR, PH - 6, { align: 'right' });
    }
  }

  // ── patient info block ──
  let y = 26; // below header bar
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
    margin: { left: ML, right: MR, top: 24, bottom: 16 },
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
      pdf.rect(0, 0, PW, 20, 'F');
      pdf.setFont('helvetica', 'bold');
      pdf.setFontSize(10);
      pdf.setTextColor(255,255,255);
      pdf.text('GENERAL HOSPITAL KONTAGORA', PW / 2, 7, { align: 'center' });
      pdf.setFontSize(8);
      pdf.text('MEDICAL LABORATORY SCIENCE DEPARTMENT', PW / 2, 13, { align: 'center' });
    }
  });

  // ── Authorising signature block ──
  const lastPage = pdf.getNumberOfPages();
  pdf.setPage(lastPage);
  let sigY = pdf.lastAutoTable ? pdf.lastAutoTable.finalY + 10 : 200;

  // If too close to footer, add a new page
  if (sigY > PH - 50) {
    pdf.addPage();
    sigY = 30;
  }

  // Separator line
  pdf.setDrawColor(...GREEN);
  pdf.setLineWidth(0.4);
  pdf.line(ML, sigY, PW - MR, sigY);
  sigY += 5;

  // Signature image (right side)
  const sigW = 45, sigH = 22;
  const sigX = PW - MR - sigW;
  try {
    pdf.addImage(AUTHORISING_SIGNATURE_B64, 'PNG', sigX, sigY, sigW, sigH);
  } catch(e) { /* skip if image fails */ }

  // Approval date & time — vertically centred next to the signature
  const approvalDT = s.released_at
    ? new Date(s.released_at).toLocaleString('en-GB', { day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit', second:'2-digit' })
    : new Date().toLocaleString('en-GB', { day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit', second:'2-digit' });

  pdf.setFont('helvetica', 'italic');
  pdf.setFontSize(8);
  pdf.setTextColor(...GRAY);
  pdf.text(approvalDT, sigX - 4, sigY + sigH / 2, { align: 'right', baseline: 'middle' });

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
    let ref = (p.low != null && p.high != null) ? `${p.low}–${p.high}` : p.low != null ? `≥${p.low}` : p.high != null ? `≤${p.high}` : '—';
    let n = parseFloat(val);
    if (!isNaN(n)) {
      if (p.high != null && n > p.high) { flag = ' ↑'; col = HIGH_COLOR; }
      if (p.low  != null && n < p.low)  { flag = ' ↓'; col = LOW_COLOR; }
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