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

// ========== LOAD ALL RELEASED SAMPLES + RENDER TABLE ==========
let allSamples = [];

async function loadAndRender() {
  const tbody = document.getElementById('portalTableBody');

  // Offline: serve from cache immediately, skip the network entirely
  if (!navigator.onLine) {
    _portalServeFromCache(tbody);
    return;
  }

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

    // Cache for offline refresh
    if (typeof window._oqCachePortalSamples === 'function') {
      window._oqCachePortalSamples(allSamples).catch(() => {});
    }

    const countEl = document.getElementById('releasedCount');
    if (countEl) countEl.textContent = `${allSamples.length} result${allSamples.length !== 1 ? 's' : ''}`;

    filterTable();
  } catch (err) {
    console.error(err);
    const isNetworkErr = !navigator.onLine || (err?.message || '').match(/fetch|network|failed to fetch/i);
    if (isNetworkErr) {
      _portalServeFromCache(tbody);
    } else {
      if (tbody) tbody.innerHTML = `<tr><td colspan="7" style="padding:30px; text-align:center; color:var(--red-light);"><i class="fas fa-exclamation-circle"></i> Failed to load results. Please refresh.</td></tr>`;
      toast('Failed to load results', 'error');
    }
  }
}

// Internal helper: populate table from IndexedDB cache
async function _portalServeFromCache(tbody) {
  if (typeof window._oqGetCachedPortalSamples !== 'function') {
    if (tbody) tbody.innerHTML = `<tr><td colspan="7" style="padding:30px;text-align:center;color:var(--text2);"><i class="fas fa-wifi" style="opacity:0.4;"></i>&nbsp; Offline — no cached data yet.</td></tr>`;
    return;
  }
  const cached = await window._oqGetCachedPortalSamples().catch(() => null);
  if (cached && cached.samples && cached.samples.length) {
    allSamples = cached.samples;
    filterTable();
    // Stale banner
    const countEl = document.getElementById('releasedCount');
    if (countEl) countEl.textContent = `${allSamples.length} result${allSamples.length !== 1 ? 's' : ''} (cached)`;
    const stale = document.createElement('div');
    stale.style.cssText = 'font-size:0.72rem;color:var(--text2);text-align:center;padding:6px 0;';
    stale.innerHTML = `<i class="fas fa-wifi" style="opacity:0.4;margin-right:4px;"></i>Offline — showing data cached ${_portalFriendlyAge(cached.updated_at)}`;
    const tableWrap = tbody?.closest('.card-body') || tbody?.parentElement;
    if (tableWrap) tableWrap.insertBefore(stale, tableWrap.firstChild);
  } else {
    if (tbody) tbody.innerHTML = `<tr><td colspan="7" style="padding:30px;text-align:center;color:var(--text2);"><i class="fas fa-wifi" style="opacity:0.4;"></i>&nbsp; Offline — no cached data yet. Connect once to enable offline viewing.</td></tr>`;
  }
}

function _portalFriendlyAge(isoStr) {
  if (!isoStr) return 'previously';
  const mins = Math.round((Date.now() - new Date(isoStr)) / 60000);
  if (mins < 2) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  return `${hrs}h ago`;
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
    // Group tests by unit_name for organised display
    const testsByUnit = {};
    (s.tests || []).forEach(t => {
      const u = t.unit_name || 'General';
      if (!testsByUnit[u]) testsByUnit[u] = [];
      testsByUnit[u].push(t.test_name);
    });
    const testList = Object.entries(testsByUnit).map(([unit, names]) =>
      `<div style="margin-bottom:2px;">
        <span style="font-size:0.65rem;font-weight:700;color:var(--primary);text-transform:uppercase;letter-spacing:0.4px;">${esc(unit)}:</span>
        ${names.map(n => `<span style="display:inline-block;background:#f0f6f3;border-radius:6px;padding:1px 6px;font-size:0.7rem;margin:1px;">${esc(n)}</span>`).join('')}
      </div>`
    ).join('');
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
        ${s.area ? `<br><small style="color:var(--primary);"><i class="fas fa-map-marker-alt" style="font-size:0.65rem;"></i> ${esc(s.area)}</small>` : ''}
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
  {key:'uric_female', name:'Uric Acid (Female)', unit:'mmol/L', low:0.16, high:0.43},
  {key:'uric_male',   name:'Uric Acid (Male)',   unit:'mmol/L', low:0.24, high:0.51}
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
  {key:'margins',         name:'Surgical Margins',             unit:'', type:'select', section:'Report',
   options:['Not Applicable','Clear (>1mm)','Close (<1mm)','Involved','Cannot Assess']},
  {key:'lymph_nodes',     name:'Lymph Node Status',            unit:'', type:'text',   section:'Report'},
  {key:'pathologist',     name:'Reporting Pathologist',        unit:'', type:'text',   section:'Report'},
  {key:'comments',        name:'Comments / Recommendation',    unit:'', type:'textarea', section:'Report'}
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
  {key:'pathologist',   name:'Reporting Pathologist',      unit:'', type:'text',   section:'Report'},
  {key:'comments',      name:'Comments / Recommendation',  unit:'', type:'textarea', section:'Report'}
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
            'ASC-US','ASC-H','LSIL (CIN I)','HSIL (CIN II / CIN III)',
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
  {key:'pathologist',   name:'Reporting Pathologist',      unit:'', type:'text',   section:'Report'},
  {key:'comments',      name:'Cytologist Comments',        unit:'', type:'textarea', section:'Report'}
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

// ========== TEST TYPE RESOLUTION (top-level so all functions can access) ==========
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
function isBloodTest(t) {
  let d = null;
  if (t.result && t.result.startsWith('{')) { try { d = JSON.parse(t.result); } catch(e) {} }
  if (resolveTestType(t.test_name, d) === 'complex_blood') return true;
  const nm = (t.test_name || '').toLowerCase();
  if (nm.includes('blood transfusion') || nm.includes('transfusion') ||
      nm.includes('crossmatch') || nm.includes('cross match') || nm.includes('grouping')) return true;
  if (d) {
    if ('transfusion_reason' in d || 'bp_whole_blood' in d ||
        'donor_blood_group' in d || 'xm_ns_result' in d) return true;
  }
  return false;
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
      let _parsedResult = null;
      try { if (t.result && t.result.startsWith('{')) _parsedResult = JSON.parse(t.result); } catch(e) {}
      let testType = resolveTestType(t.test_name, _parsedResult);
      if (testType === 'simple_select') {
        const val = t.result || '—';
        testSections += `
          <table class="param-table">
            <thead><tr><th>Parameter</th><th colspan="3">Result</th></tr></thead>
            <tbody>
              <tr>
                <td style="font-weight:500;">${esc(t.test_name)}</td>
                <td colspan="3">${esc(val)}</td>
              </tr>
            </tbody>
          </table>`;
        return;
      }

      // ── simple_numeric: result is a plain string, look up stored ref range ──
      if (testType === 'simple_numeric') {
        const ref = testDefinitions.refRanges?.[t.test_name];
        const val = t.result || '—';
        let flag = '', cls = '';
        if (ref) {
          const num = parseFloat(val);
          if (!isNaN(num)) {
            if (num > ref.high) { flag = '↑'; cls = 'flag-high'; }
            else if (num < ref.low) { flag = '↓'; cls = 'flag-low'; }
          }
        }
        const unitStr  = ref ? esc(ref.unit) : '—';
        const refRange = ref ? `${ref.low}–${ref.high}` : '—';
        testSections += `
          <table class="param-table">
            <thead><tr><th>Parameter</th><th>Result</th><th>Unit</th><th>Reference</th></tr></thead>
            <tbody>
              <tr>
                <td style="font-weight:500;">${esc(t.test_name)}</td>
                <td class="${cls}">${esc(val)} ${flag}</td>
                <td>${unitStr}</td>
                <td>${refRange}</td>
              </tr>
            </tbody>
          </table>`;
        return;
      }
      // ─────────────────────────────────────────────────────────────────────────

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
          ${s.history ? `<div style="font-size:0.8rem; color:var(--text2);"><strong>Clinical Diagnosis:</strong> ${esc(s.history)}</div>` : ''}
          ${s.tests && s.tests.length ? (() => {
            const byUnit = {};
            s.tests.forEach(t => { const u = t.unit_name || 'General'; if (!byUnit[u]) byUnit[u] = []; byUnit[u].push(t.test_name); });
            return `<div style="margin-top:5px;">
              <span style="font-size:0.75rem; color:var(--text2);"><i class="fas fa-vials" style="color:var(--primary);"></i> Tests:</span>
              ${Object.entries(byUnit).map(([unit, names]) =>
                `<div style="display:flex;flex-wrap:wrap;align-items:center;gap:3px;margin-top:3px;">
                  <span style="font-size:0.68rem;font-weight:700;color:var(--primary);text-transform:uppercase;letter-spacing:0.4px;min-width:fit-content;">${esc(unit)}:</span>
                  ${names.map(n => `<span style="display:inline-block;background:#e8f4ed;color:#1a5c38;border:1px solid #b6ddc8;border-radius:20px;padding:2px 9px;font-size:0.72rem;font-weight:500;">${esc(n)}</span>`).join('')}
                </div>`
              ).join('')}
            </div>`;
          })() : ''}
          ${s.area ? `<div style="font-size:0.8rem; color:var(--text2);"><i class="fas fa-map-marker-alt" style="color:var(--primary);margin-right:3px;"></i>Area: <strong>${esc(s.area)}</strong></div>` : ''}
          ${s.offline_ref ? `<div style="margin-top:4px;"><span style="font-family:var(--mono); font-size:0.68rem; background:#fff9ec; border:1px solid #fde68a; color:#92400e; padding:2px 8px; border-radius:6px; display:inline-block;"><i class="fas fa-link" style="margin-right:3px;"></i>${esc(s.offline_ref)}</span></div>` : ''}
        </div>
        <div style="text-align:right;">
          <span class="badge ${payBadgeClass(s.pay_status)}">${esc(s.pay_status || 'Unpaid')}</span>
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
    return `<table class="param-table"><tbody><tr><td style="font-weight:500;">${esc(testName)}</td><td colspan="3">${val}</td></tr></tbody></tr>`;
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
// ========== AUTHORISING SIGNATURE — removed (no embedded image) ==========

// ========== PDF UNIT HELPER (top-level so collectAutoTableRows can use it) ==========
function pdfUnit(u) {
  if (!u) return '';
  return u
    .replace(/×10⁹/g,  'x10^9')
    .replace(/×10¹²/g, 'x10^12')
    .replace(/×10⁶/g,  'x10^6')
    .replace(/×10³/g,  'x10^3')
    .replace(/×10²/g,  'x10^2')
    .replace(/×10¹/g,  'x10^1')
    .replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹]/g, d => String('⁰¹²³⁴⁵⁶⁷⁸⁹'.indexOf(d)));
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
      pdf.rect(0, 0, PW, 20, 'F');
      pdf.setFont('helvetica', 'bold');
      pdf.setFontSize(10);
      pdf.setTextColor(255,255,255);
      pdf.text("KOFAR AREWA PRIMARY HEALTH CARE HADEJIA LGA", PW / 2, 7, { align: 'center' });
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
      pdf.text("Electronically generated by MU'UJIZA LIS: Medical Laboratory Science Dept.", ML, PH - 6);
      pdf.text(`Page ${p} of ${total}`, PW - MR, PH - 6, { align: 'right' });
    }
  }

  // ── patient info block ──
  let y = 26; // below header bar
  pdf.setFontSize(9);
  pdf.setTextColor(...DARK);

  // Build grouped test string: "Hematology: PCV, ESR  |  Microbiology: Urine MCS"
  const _pdfTestsByUnit = {};
  (s.tests || []).forEach(t => {
    const u = t.unit_name || 'General';
    if (!_pdfTestsByUnit[u]) _pdfTestsByUnit[u] = [];
    _pdfTestsByUnit[u].push(t.test_name);
  });
  const groupedTestStr = Object.entries(_pdfTestsByUnit)
    .map(([u, names]) => `${u}: ${names.join(', ')}`)
    .join('  |  ');

  const infoLines = [
    [`Sample ID: MU-${s.id}${s.offline_ref ? '  [Draft Ref: ' + s.offline_ref + ']' : ''}`,
     `Collected: ${s.collection_date || '—'}`],
    [`Patient: ${s.patient || '—'}  (${s.age ?? '?'}y, ${s.gender || '—'})`,
     `Released: ${s.released_at ? new Date(s.released_at).toLocaleString() : '—'}`],
    [`Payment Status: ${s.pay_status || 'Unpaid'}`,
     s.clinician ? `Clinician: ${s.clinician}` : ''],
    [s.history ? `Clinical Diagnosis: ${s.history}` : '', ''],
    [s.tests && s.tests.length ? `Test(s): ${groupedTestStr}` : '', ''],
    [s.area ? `Area / Locality: ${s.area}` : '', '']
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
  let blockBoundaries = [];
  let semenPageData = null;            // semen test handled separately as a form-style page
  let bloodTransfusionPageData = null; // blood transfusion rendered as BTS-REQ-XM/v1 form page
  let mcsPageData = null;              // urine/stool MCS rendered as a dedicated single-page form
  let histopathPageData = null;        // histopathology biopsy rendered as a dedicated single-page form
  let fnacPageData = null;             // FNAC rendered as a dedicated single-page form
  let papSmearPageData = null;         // PAP smear rendered as a dedicated single-page form
  const groups = groupTestsByUnit(s.tests);


  for (const [unitName, unitTests] of Object.entries(groups)) {
    // Check if all tests in this unit are semen — if so skip the unit header entirely
    const allSemen = unitTests.every(t => {
      let d = null; try { if (t.result?.startsWith('{')) d = JSON.parse(t.result); } catch(e) {}
      return resolveTestType(t.test_name, d) === 'complex_semen';
    });
    if (allSemen) {
      unitTests.forEach(t => {
        try {
          if (t.result && t.result.startsWith('{')) {
            semenPageData = JSON.parse(t.result);
          }
        } catch(e) {}
      });
      continue; // skip adding any rows for this group
    }

    // Check if all tests in this unit are blood transfusion — render as BTS form page
    const allBlood = unitTests.length > 0 && unitTests.every(t => isBloodTest(t));
    if (allBlood) {
      unitTests.forEach(t => {
        try {
          if (t.result && t.result.startsWith('{')) {
            bloodTransfusionPageData = JSON.parse(t.result);
          }
        } catch(e) {}
      });
      continue; // skip adding any rows for this group
    }

    // Check if all tests in this unit are histopath / FNAC / PAP smear — render as dedicated form pages
    const allHistopath = unitTests.every(t => { let d=null; try{if(t.result?.startsWith('{'))d=JSON.parse(t.result);}catch(e){} return resolveTestType(t.test_name,d)==='complex_histopath'; });
    if (allHistopath) { unitTests.forEach(t => { try{if(t.result?.startsWith('{'))histopathPageData=JSON.parse(t.result);}catch(e){} }); continue; }
    const allFNAC = unitTests.every(t => { let d=null; try{if(t.result?.startsWith('{'))d=JSON.parse(t.result);}catch(e){} return resolveTestType(t.test_name,d)==='complex_fnac'; });
    if (allFNAC) { unitTests.forEach(t => { try{if(t.result?.startsWith('{'))fnacPageData=JSON.parse(t.result);}catch(e){} }); continue; }
    const allPAP = unitTests.every(t => { let d=null; try{if(t.result?.startsWith('{'))d=JSON.parse(t.result);}catch(e){} return resolveTestType(t.test_name,d)==='complex_pap_smear'; });
    if (allPAP) { unitTests.forEach(t => { try{if(t.result?.startsWith('{'))papSmearPageData=JSON.parse(t.result);}catch(e){} }); continue; }

    // section header row (spans all 4 cols via didParseCell)
    const unitHeaderIdx = tableBody.length;
    tableBody.push([{ content: unitName, colSpan: 4, styles: { fillColor: GREEN, textColor: [255,255,255], fontStyle: 'bold', fontSize: 8 } }]);

    unitTests.forEach((t, ti) => {
      const blockStart = tableBody.length;
      let _parsedResult = null;
      try { if (t.result && t.result.startsWith('{')) _parsedResult = JSON.parse(t.result); } catch(e) {}
      let testType = resolveTestType(t.test_name, _parsedResult);

      // ── simple_select: plain string result — show value, no unit/ref ──
      if (testType === 'simple_select') {
        tableBody.push([t.test_name, { content: t.result || '—', colSpan: 3 }]);
      } else if (testType === 'simple_numeric') {
        const ref = testDefinitions.refRanges?.[t.test_name];
        const val = t.result || '—';
        let flag = '';
        if (ref) {
          const num = parseFloat(val);
          if (!isNaN(num)) {
            if (num > ref.high) flag = ' ↑';
            else if (num < ref.low) flag = ' ↓';
          }
        }
        tableBody.push([
          t.test_name,
          val + flag,
          ref ? pdfUnit(ref.unit) : '',
          ref ? `${ref.low}–${ref.high}` : '—'
        ]);
      } else if (!t.result || !t.result.startsWith('{')) {
        tableBody.push([t.test_name, t.result || '—', '', '']);
      } else {
        try {
          let data = JSON.parse(t.result);
          if (testType === 'complex_semen') {
            semenPageData = data; // drawn separately as form-style page
          } else if (testType === 'complex_blood' || isBloodTest(t)) {
            bloodTransfusionPageData = data; // drawn separately as BTS-REQ-XM/v1 form page
          } else if (testType === 'complex_urine_mcs' || testType === 'complex_stool_mcs') {
            mcsPageData = { data, testType, testName: t.test_name }; // drawn as dedicated MCS page — no tableBody rows
          } else if (testType === 'complex_histopath') {
            histopathPageData = data;
          } else if (testType === 'complex_fnac') {
            fnacPageData = data;
          } else if (testType === 'complex_pap_smear') {
            papSmearPageData = data;
          } else {
            collectAutoTableRows(tableBody, t.test_name, data, testType, s.age, s.gender);
          }
        } catch(e) {
          tableBody.push([t.test_name, t.result || '—', '', '']);
        }
      }
      const blockEnd = tableBody.length - 1;
      const start = (ti === 0) ? unitHeaderIdx : blockStart;
      blockBoundaries.push({ start, end: blockEnd, isSemen: false });
    });

    // If every test in this unit was captured as blood/semen/MCS (no data rows after
    // the unit header), strip the orphaned unit header row to avoid a dangling green
    // header in the PDF and to keep tableBody.length === 0 when MCS is the only test.
    if (tableBody.length === unitHeaderIdx + 1) {
      tableBody.splice(unitHeaderIdx, 1);
      blockBoundaries = blockBoundaries.filter(b => b.start !== unitHeaderIdx && b.end !== unitHeaderIdx);
    }
  }

  // ── force a page break before any test-block that would otherwise be split,
  //    ensuring each test starts and finishes on the same page.
  //    Exception: complex_semen is intentionally long (2 pages) — it is allowed
  //    to split naturally but still gets pushed to a fresh page if it doesn't
  //    fit on the current one.
  {
    const ROW_H           = 6.5;   // approx mm per autoTable row at fontSize 8 / cellPadding 2.5
    const HEAD_H          = 8;     // column-header row height (Parameter / Result / Unit / Reference)
    const FIRST_PAGE_TOP  = y + HEAD_H;          // first page: table body starts below the header row
    const FIRST_PAGE_BOT  = PH - MB - 16;        // leave room for footer (bottom margin 14 + footer text ~2)
    const LATER_PAGE_TOP  = 24 + HEAD_H;         // later pages: below repeated green header + col-header
    const LATER_PAGE_BOT  = PH - MB - 16;
    const LATER_PAGE_H    = LATER_PAGE_BOT - LATER_PAGE_TOP;

    let cursorY    = FIRST_PAGE_TOP;
    let pageBottom = FIRST_PAGE_BOT;

    // Helper: stamp pageBreak:'always' on the first cell of row `idx`
    function forcePageBreak(idx) {
      const firstCell = tableBody[idx][0];
      if (typeof firstCell !== 'object' || firstCell === null) {
        tableBody[idx][0] = { content: firstCell ?? '', styles: { pageBreak: 'always' } };
      } else {
        firstCell.styles = firstCell.styles || {};
        firstCell.styles.pageBreak = 'always';
      }
    }

    blockBoundaries.forEach(({ start, end, isSemen }) => {
      const blockRows = end - start + 1;
      const blockH    = blockRows * ROW_H;
      const remaining = pageBottom - cursorY;

      if (blockH > remaining) {
        // Block doesn't fit on remaining space — push it to a fresh page
        forcePageBreak(start);
        if (isSemen) {
          // Semen is allowed to overflow across 2 pages — simulate wrapping
          const firstPageUsable = LATER_PAGE_H;
          const rowsOnFirst = Math.floor(firstPageUsable / ROW_H);
          const remainingRows = blockRows - rowsOnFirst;
          cursorY = LATER_PAGE_TOP + (remainingRows * ROW_H);
        } else {
          cursorY = LATER_PAGE_TOP + blockH;
        }
        pageBottom = LATER_PAGE_BOT;
      } else {
        cursorY += blockH;
        // If we've gone past the page bottom (shouldn't normally happen) reset
        if (cursorY > pageBottom) {
          cursorY = LATER_PAGE_TOP;
          pageBottom = LATER_PAGE_BOT;
        }
      }
    });
  }

  if (tableBody.length > 0) {
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
      pdf.text("MU'UJIZA LIS", PW / 2, 7, { align: 'center' });
      pdf.setFontSize(8);
      pdf.text('MEDICAL LABORATORY SCIENCE DEPARTMENT', PW / 2, 13, { align: 'center' });
    }
  }); // end autoTable
  } // end if tableBody.length > 0

  // ── Semen Analysis — draw as physical-form-style page ──
  if (semenPageData) {
    drawSemenFormPage(pdf, semenPageData, s, PW, PH, ML, MR, GREEN, DARK, GRAY, LGRAY, tableBody.length > 0, y);
  }

  // ── Urine / Stool MCS — draw as dedicated single-page form ──
  if (mcsPageData) {
    drawMCSFormPage(pdf, mcsPageData.data, mcsPageData.testType, mcsPageData.testName, s, PW, PH, ML, MR, GREEN, DARK, GRAY, LGRAY, tableBody.length > 0, y);
  }

  // ── Blood Transfusion — draw as BTS-REQ-XM/v1 form-style page ──
  if (bloodTransfusionPageData) {
    drawBloodTransfusionFormPage(pdf, bloodTransfusionPageData, s, PW, PH, ML, MR, GREEN, DARK, GRAY, LGRAY, tableBody.length > 0, y);
  }

  // ── Histopathology — draw as dedicated single-page narrative form ──
  if (histopathPageData) {
    drawHistopathFormPage(pdf, histopathPageData, s, PW, PH, ML, MR, GREEN, DARK, GRAY, LGRAY, tableBody.length > 0 || semenPageData || mcsPageData || bloodTransfusionPageData, y);
  }

  // ── FNAC — draw as dedicated single-page cytology form ──
  if (fnacPageData) {
    drawFNACFormPage(pdf, fnacPageData, s, PW, PH, ML, MR, GREEN, DARK, GRAY, LGRAY, tableBody.length > 0 || semenPageData || mcsPageData || bloodTransfusionPageData || histopathPageData, y);
  }

  // ── PAP Smear — draw as dedicated single-page Bethesda form ──
  if (papSmearPageData) {
    drawPAPSmearFormPage(pdf, papSmearPageData, s, PW, PH, ML, MR, GREEN, DARK, GRAY, LGRAY, tableBody.length > 0 || semenPageData || mcsPageData || bloodTransfusionPageData || histopathPageData || fnacPageData, y);
  }

  // ── Authorising signature block ──
  // Skipped for Blood Transfusion: Section 9 of the BTS-REQ-XM/v1 form already
  // contains the Laboratory Authorisation block (Performed By / Checked By).
  // Also skipped for Histopath/FNAC/PAP: the form page includes the Reporting Pathologist field.
  if (!bloodTransfusionPageData && !histopathPageData && !fnacPageData && !papSmearPageData) {
    const lastPage = pdf.getNumberOfPages();
    pdf.setPage(lastPage);
    let sigY = pdf.lastAutoTable ? pdf.lastAutoTable.finalY + 10 : (y + 10);

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

    // Approval date & time
    const approvalDT = s.released_at
      ? new Date(s.released_at).toLocaleString('en-GB', { day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit', second:'2-digit' })
      : new Date().toLocaleString('en-GB', { day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit', second:'2-digit' });

    pdf.setFont('helvetica', 'italic');
    pdf.setFontSize(8);
    pdf.setTextColor(...GRAY);
    pdf.text(approvalDT, PW - MR, sigY + 6, { align: 'right' });
  }

  addPageChrome();
  pdf.save(`MU${s.id}_${(s.patient || 'patient').replace(/\s/g, '_')}.pdf`);
  await addAudit('PDF Downloaded', s.id, `Report downloaded by ${currentUser ? currentUser.name : 'Unknown'}`);
  toast('PDF downloaded');
}

// ── URINE / STOOL MCS — dedicated single-page form renderer ──
// Renders Physical/Chemical/Macroscopy/Microscopy sections AND up to 15+ antibiotics
// all on one A4 page using compact row heights.
function drawMCSFormPage(pdf, d, testType, testName, s, PW, PH, ML, MR, GREEN, DARK, GRAY, LGRAY, hasOtherTests, startY) {
  const isMCS = testType === 'complex_urine_mcs';
  const MICRO_PARAMS = isMCS ? URINE_MICRO_PARAMS : STOOL_MICRO_PARAMS;
  const sections = isMCS ? ['Physical', 'Chemical', 'Microscopy'] : ['Macroscopy', 'Microscopy'];

  if (hasOtherTests) pdf.addPage();
  const CW  = PW - ML - MR;
  const rowH = 5.0;   // compact row height — fits everything on one page
  const TEAL      = GREEN;
  const TEAL_LITE = [232, 244, 240];
  const BLUE_LITE = [219, 234, 254];
  const HIGH_COL  = [185, 28, 28];
  const LOW_COL   = [59, 130, 246];
  const GREEN_COL = [21, 128, 61];
  const colW1 = 68, colW2 = 46, colW3 = 28, colW4 = CW - colW1 - colW2 - colW3;

  let y = hasOtherTests ? 24 : (startY || 26);

  // ── Section title bar ──
  pdf.setFillColor(...TEAL);
  pdf.rect(ML, y, CW, 6, 'F');
  pdf.setFont('helvetica', 'bold'); pdf.setFontSize(9); pdf.setTextColor(255, 255, 255);
  pdf.text(testName.toUpperCase(), PW / 2, y + 4.2, { align: 'center' });
  y += 7;

  // ── Column header row ──
  pdf.setFillColor(...LGRAY);
  pdf.rect(ML, y, CW, rowH, 'F');
  pdf.setDrawColor(210, 220, 230); pdf.setLineWidth(0.2);
  pdf.rect(ML, y, CW, rowH);
  pdf.setFont('helvetica', 'bold'); pdf.setFontSize(7.5); pdf.setTextColor(...DARK);
  pdf.text('Parameter', ML + 2, y + rowH - 1.5);
  pdf.text('Result',    ML + colW1 + 2, y + rowH - 1.5);
  pdf.text('Unit',      ML + colW1 + colW2 + 2, y + rowH - 1.5);
  pdf.text('Ref',       ML + colW1 + colW2 + colW3 + 2, y + rowH - 1.5);
  y += rowH;

  function drawSectionHeader(label, fillColor) {
    pdf.setFillColor(...fillColor);
    pdf.rect(ML, y, CW, rowH, 'F');
    pdf.setDrawColor(210, 220, 230); pdf.setLineWidth(0.15); pdf.rect(ML, y, CW, rowH);
    pdf.setFont('helvetica', 'bold'); pdf.setFontSize(7); pdf.setTextColor(...DARK);
    pdf.text(label.toUpperCase(), ML + 2, y + rowH - 1.5);
    y += rowH;
  }

  function drawParamRow(name, value, unit, ref, col, rowIndex) {
    const bg = rowIndex % 2 === 0 ? [252, 253, 254] : [255, 255, 255];
    pdf.setFillColor(...bg); pdf.rect(ML, y, CW, rowH, 'F');
    pdf.setDrawColor(210, 220, 230); pdf.setLineWidth(0.15); pdf.rect(ML, y, CW, rowH);
    pdf.setFont('helvetica', 'normal'); pdf.setFontSize(7.5); pdf.setTextColor(...DARK);
    pdf.text(name, ML + 2, y + rowH - 1.5);
    if (col) pdf.setTextColor(...col); else pdf.setTextColor(...DARK);
    pdf.setFont('helvetica', col ? 'bold' : 'normal');
    pdf.text(String(value), ML + colW1 + 2, y + rowH - 1.5);
    pdf.setFont('helvetica', 'normal'); pdf.setTextColor(...DARK);
    pdf.text(String(unit || ''), ML + colW1 + colW2 + 2, y + rowH - 1.5);
    pdf.text(String(ref || '—'), ML + colW1 + colW2 + colW3 + 2, y + rowH - 1.5);
    y += rowH;
  }

  // ── Physical / Chemical / Macroscopy / Microscopy sections ──
  sections.forEach(sec => {
    const params = MICRO_PARAMS.filter(p => p.section === sec);
    const visRows = params.filter(p => {
      const v = d[p.key];
      return v !== undefined && v !== '' && v !== 'None' && v !== 'None seen' && v !== 'Absent' && v !== 'Negative';
    });
    if (!visRows.length) return;
    drawSectionHeader(sec, TEAL_LITE);
    visRows.forEach((p, i) => {
      let v = d[p.key];
      let flag = ''; let col = null;
      if (p.type === 'number' && p.low !== undefined) {
        const n = parseFloat(v);
        if (!isNaN(n)) {
          if (n > p.high) { flag = ' ↑'; col = HIGH_COL; }
          else if (n < p.low) { flag = ' ↓'; col = LOW_COL; }
        }
      }
      const ref = (p.low != null && p.high != null) ? `${p.low}–${p.high}` : '—';
      drawParamRow(p.name, String(v) + flag, p.unit || '', ref, col, i);
    });
  });

  // ── Culture & Sensitivity ──
  drawSectionHeader('Culture & Sensitivity', BLUE_LITE);

  // Organism row
  pdf.setFillColor(235, 245, 255); pdf.rect(ML, y, CW, rowH, 'F');
  pdf.setDrawColor(210, 220, 230); pdf.setLineWidth(0.15); pdf.rect(ML, y, CW, rowH);
  pdf.setFont('helvetica', 'bold'); pdf.setFontSize(7.5); pdf.setTextColor(...DARK);
  pdf.text('Organism:', ML + 2, y + rowH - 1.5);
  pdf.setFont('helvetica', 'italic');
  pdf.text(d.organism || 'No growth / Not specified', ML + 24, y + rowH - 1.5);
  y += rowH;

  if (d.sensitivities && d.sensitivities.length) {
    // Antibiotic sub-header
    pdf.setFillColor(241, 245, 249); pdf.rect(ML, y, CW, rowH, 'F');
    pdf.setDrawColor(210, 220, 230); pdf.setLineWidth(0.15); pdf.rect(ML, y, CW, rowH);
    pdf.setFont('helvetica', 'bold'); pdf.setFontSize(7); pdf.setTextColor(...DARK);
    pdf.text('Antibiotic',      ML + 2,             y + rowH - 1.5);
    pdf.text('Result',          ML + colW1 + 2,      y + rowH - 1.5);
    pdf.text('Interpretation',  ML + colW1 + colW2 + 2, y + rowH - 1.5);
    y += rowH;

    d.sensitivities.forEach((sens, i) => {
      const label = sens.result === 'S' ? 'Sensitive'
                  : sens.result === 'R' ? 'Resistant'
                  : sens.result === 'I' ? 'Intermediate'
                  : sens.result || '—';
      const col = sens.result === 'S' ? GREEN_COL
                : sens.result === 'R' ? HIGH_COL
                : sens.result === 'I' ? [146, 64, 14]
                : [55, 65, 81];
      const bg = i % 2 === 0 ? [252, 253, 254] : [255, 255, 255];
      pdf.setFillColor(...bg); pdf.rect(ML, y, CW, rowH, 'F');
      pdf.setDrawColor(210, 220, 230); pdf.setLineWidth(0.15); pdf.rect(ML, y, CW, rowH);
      pdf.setFont('helvetica', 'normal'); pdf.setFontSize(7.5); pdf.setTextColor(...DARK);
      pdf.text(sens.antibiotic || '—', ML + 2, y + rowH - 1.5);
      pdf.setFont('helvetica', 'bold'); pdf.setTextColor(...col);
      pdf.text(sens.result || '—', ML + colW1 + 2, y + rowH - 1.5);
      pdf.setFont('helvetica', 'normal');
      pdf.text(label, ML + colW1 + colW2 + 2, y + rowH - 1.5);
      pdf.setTextColor(...DARK);
      y += rowH;
    });
  } else {
    pdf.setFillColor(252, 253, 254); pdf.rect(ML, y, CW, rowH, 'F');
    pdf.setDrawColor(210, 220, 230); pdf.setLineWidth(0.15); pdf.rect(ML, y, CW, rowH);
    pdf.setFont('helvetica', 'normal'); pdf.setFontSize(7.5); pdf.setTextColor(107, 114, 128);
    pdf.text('No antibiotic sensitivities recorded.', ML + 2, y + rowH - 1.5);
    y += rowH;
  }
}

// ── HISTOPATHOLOGY — dedicated single-page narrative form renderer ──
function drawHistopathFormPage(pdf, d, s, PW, PH, ML, MR, GREEN, DARK, GRAY, LGRAY, hasOtherTests, startY) {
  function val(key) { const v = d[key]; return (v === undefined || v === null || v === '') ? '—' : String(v); }
  if (hasOtherTests) pdf.addPage();
  const CW = PW - ML - MR;
  let y = hasOtherTests ? 24 : (startY || 26);
  const PURPLE = [109, 40, 217];
  const PURPLE_LIGHT = [243, 232, 255];
  const rowH = 5.5;

  // Title bar
  pdf.setFillColor(...PURPLE);
  pdf.rect(ML, y, CW, 6, 'F');
  pdf.setFont('helvetica', 'bold'); pdf.setFontSize(9); pdf.setTextColor(255,255,255);
  pdf.text('HISTOPATHOLOGY REPORT', PW / 2, y + 4.2, { align: 'center' });
  y += 8;

  // Helper: draw a labelled row
  function drawRow(label, value, yPos, stripe) {
    if (stripe) { pdf.setFillColor(...LGRAY); pdf.rect(ML, yPos, CW, rowH, 'F'); }
    pdf.setFont('helvetica', 'bold'); pdf.setFontSize(7); pdf.setTextColor(...DARK);
    pdf.text(label, ML + 2, yPos + 3.8);
    pdf.setFont('helvetica', 'normal'); pdf.setFontSize(7); pdf.setTextColor(...DARK);
    // wrap long text across remaining width
    const lines = pdf.splitTextToSize(value, CW - 60);
    pdf.text(lines[0] || value, ML + 58, yPos + 3.8);
    return rowH * Math.max(1, lines.length);
  }

  // Section header
  function sectionHeader(title, yPos, color) {
    pdf.setFillColor(...color); pdf.rect(ML, yPos, CW, 5, 'F');
    pdf.setFont('helvetica', 'bold'); pdf.setFontSize(7.5); pdf.setTextColor(...DARK);
    pdf.text(title, ML + 2, yPos + 3.6);
    return 6.5;
  }

  // ── REQUEST DETAILS ──
  y += sectionHeader('REQUEST DETAILS', y, PURPLE_LIGHT);
  const reqKeys = ['specimen_site','clinical_info','nature_specimen','fixative'];
  reqKeys.forEach((k, i) => {
    const p = HISTOPATH_PARAMS.find(x => x.key === k);
    if (!p) return;
    y += drawRow(p.name, val(k), y, i % 2 === 0);
  });
  y += 3;

  // ── PATHOLOGY REPORT ──
  y += sectionHeader('PATHOLOGY REPORT', y, PURPLE_LIGHT);
  const rptKeys = ['macro_desc','micro_desc','special_stains','diagnosis','grade','margins','lymph_nodes','pathologist','comments'];
  rptKeys.forEach((k, i) => {
    const p = HISTOPATH_PARAMS.find(x => x.key === k);
    if (!p) return;
    const v = val(k);
    if (v === '—') return;
    // Textarea fields get multi-line treatment
    if (p.type === 'textarea') {
      y += sectionHeader(p.name.toUpperCase(), y, [232, 244, 240]);
      pdf.setFont('helvetica', 'normal'); pdf.setFontSize(7.5); pdf.setTextColor(...DARK);
      const lines = pdf.splitTextToSize(v, CW - 4);
      lines.forEach(line => {
        pdf.text(line, ML + 2, y + 4);
        y += 5.5;
        if (y > PH - 25) { pdf.addPage(); y = 24; }
      });
      y += 2;
    } else {
      y += drawRow(p.name, v, y, i % 2 === 0);
      if (y > PH - 25) { pdf.addPage(); y = 24; }
    }
  });
}

// ── FNAC — dedicated single-page cytology form renderer ──
function drawFNACFormPage(pdf, d, s, PW, PH, ML, MR, GREEN, DARK, GRAY, LGRAY, hasOtherTests, startY) {
  function val(key) { const v = d[key]; return (v === undefined || v === null || v === '') ? '—' : String(v); }
  if (hasOtherTests) pdf.addPage();
  const CW = PW - ML - MR;
  let y = hasOtherTests ? 24 : (startY || 26);
  const AMBER = [146, 64, 14];
  const AMBER_LIGHT = [254, 249, 195];
  const rowH = 5.5;

  // Title bar
  pdf.setFillColor(...AMBER);
  pdf.rect(ML, y, CW, 6, 'F');
  pdf.setFont('helvetica', 'bold'); pdf.setFontSize(9); pdf.setTextColor(255,255,255);
  pdf.text('FINE NEEDLE ASPIRATION CYTOLOGY (FNAC)', PW / 2, y + 4.2, { align: 'center' });
  y += 8;

  function drawRow(label, value, yPos, stripe) {
    if (stripe) { pdf.setFillColor(...LGRAY); pdf.rect(ML, yPos, CW, rowH, 'F'); }
    pdf.setFont('helvetica', 'bold'); pdf.setFontSize(7); pdf.setTextColor(...DARK);
    pdf.text(label, ML + 2, yPos + 3.8);
    pdf.setFont('helvetica', 'normal'); pdf.setFontSize(7); pdf.setTextColor(...DARK);
    const lines = pdf.splitTextToSize(value, CW - 60);
    pdf.text(lines[0] || value, ML + 58, yPos + 3.8);
    return rowH;
  }

  function sectionHeader(title, yPos, color) {
    pdf.setFillColor(...color); pdf.rect(ML, yPos, CW, 5, 'F');
    pdf.setFont('helvetica', 'bold'); pdf.setFontSize(7.5); pdf.setTextColor(...DARK);
    pdf.text(title, ML + 2, yPos + 3.6);
    return 6.5;
  }

  // ── REQUEST DETAILS ──
  y += sectionHeader('FNAC REQUEST DETAILS', y, AMBER_LIGHT);
  const reqKeys = ['site','laterality','lesion_size','clinical_info'];
  reqKeys.forEach((k, i) => {
    const p = FNAC_PARAMS.find(x => x.key === k);
    if (!p) return;
    y += drawRow(p.name, val(k), y, i % 2 === 0);
  });
  y += 3;

  // ── CYTOLOGY REPORT ──
  y += sectionHeader('CYTOLOGY REPORT', y, AMBER_LIGHT);
  const rptKeys = ['adequacy','stain','cytology','micro_desc','pathologist','comments'];
  rptKeys.forEach((k, i) => {
    const p = FNAC_PARAMS.find(x => x.key === k);
    if (!p) return;
    const v = val(k);
    if (v === '—') return;
    if (p.type === 'textarea') {
      y += sectionHeader(p.name.toUpperCase(), y, [232, 244, 240]);
      pdf.setFont('helvetica', 'normal'); pdf.setFontSize(7.5); pdf.setTextColor(...DARK);
      const lines = pdf.splitTextToSize(v, CW - 4);
      lines.forEach(line => { pdf.text(line, ML + 2, y + 4); y += 5.5; if (y > PH - 25) { pdf.addPage(); y = 24; } });
      y += 2;
    } else {
      // Cytological Diagnosis gets highlighted
      if (k === 'cytology') {
        pdf.setFillColor(254, 249, 195); pdf.rect(ML, y, CW, rowH + 1, 'F');
        pdf.setFont('helvetica', 'bold'); pdf.setFontSize(8); pdf.setTextColor(...AMBER);
        pdf.text('Cytological Diagnosis:', ML + 2, y + 4.2);
        pdf.setFont('helvetica', 'bold'); pdf.setFontSize(8); pdf.setTextColor(...DARK);
        const diagLines = pdf.splitTextToSize(v, CW - 62);
        pdf.text(diagLines[0] || v, ML + 62, y + 4.2);
        y += rowH + 2;
      } else {
        y += drawRow(p.name, v, y, i % 2 === 0);
      }
      if (y > PH - 25) { pdf.addPage(); y = 24; }
    }
  });
}

// ── PAP SMEAR — dedicated single-page Bethesda 2014 form renderer ──
function drawPAPSmearFormPage(pdf, d, s, PW, PH, ML, MR, GREEN, DARK, GRAY, LGRAY, hasOtherTests, startY) {
  function val(key) { const v = d[key]; return (v === undefined || v === null || v === '') ? '—' : String(v); }
  if (hasOtherTests) pdf.addPage();
  const CW = PW - ML - MR;
  let y = hasOtherTests ? 24 : (startY || 26);
  const PINK = [157, 23, 77];
  const PINK_LIGHT = [252, 231, 243];
  const rowH = 5.5;

  // Title bar
  pdf.setFillColor(...PINK);
  pdf.rect(ML, y, CW, 6, 'F');
  pdf.setFont('helvetica', 'bold'); pdf.setFontSize(9); pdf.setTextColor(255,255,255);
  pdf.text('CERVICAL / PAP SMEAR CYTOLOGY REPORT (BETHESDA 2014)', PW / 2, y + 4.2, { align: 'center' });
  y += 8;

  function drawRow(label, value, yPos, stripe) {
    if (stripe) { pdf.setFillColor(...LGRAY); pdf.rect(ML, yPos, CW, rowH, 'F'); }
    pdf.setFont('helvetica', 'bold'); pdf.setFontSize(7); pdf.setTextColor(...DARK);
    pdf.text(label, ML + 2, yPos + 3.8);
    pdf.setFont('helvetica', 'normal'); pdf.setFontSize(7); pdf.setTextColor(...DARK);
    const lines = pdf.splitTextToSize(value, CW - 60);
    pdf.text(lines[0] || value, ML + 58, yPos + 3.8);
    return rowH;
  }

  function sectionHeader(title, yPos, color) {
    pdf.setFillColor(...color); pdf.rect(ML, yPos, CW, 5, 'F');
    pdf.setFont('helvetica', 'bold'); pdf.setFontSize(7.5); pdf.setTextColor(...DARK);
    pdf.text(title, ML + 2, yPos + 3.6);
    return 6.5;
  }

  // ── REQUEST DETAILS ──
  y += sectionHeader('REQUEST DETAILS', y, PINK_LIGHT);
  const reqKeys = ['specimen_type','lmp','clinical_info'];
  reqKeys.forEach((k, i) => {
    const p = PAP_SMEAR_PARAMS.find(x => x.key === k);
    if (!p) return;
    y += drawRow(p.name, val(k), y, i % 2 === 0);
  });
  y += 3;

  // ── CYTOLOGY REPORT ──
  y += sectionHeader('CYTOLOGY REPORT — BETHESDA 2014', y, PINK_LIGHT);
  const rptKeys = ['adequacy','cytology','organisms','hormonal','recommendation','pathologist','comments'];
  rptKeys.forEach((k, i) => {
    const p = PAP_SMEAR_PARAMS.find(x => x.key === k);
    if (!p) return;
    const v = val(k);
    if (v === '—') return;
    if (p.type === 'textarea') {
      y += sectionHeader(p.name.toUpperCase(), y, [232, 244, 240]);
      pdf.setFont('helvetica', 'normal'); pdf.setFontSize(7.5); pdf.setTextColor(...DARK);
      const lines = pdf.splitTextToSize(v, CW - 4);
      lines.forEach(line => { pdf.text(line, ML + 2, y + 4); y += 5.5; if (y > PH - 25) { pdf.addPage(); y = 24; } });
      y += 2;
    } else {
      if (k === 'cytology') {
        // Bethesda category highlighted
        pdf.setFillColor(...PINK_LIGHT); pdf.rect(ML, y, CW, rowH + 1, 'F');
        pdf.setFont('helvetica', 'bold'); pdf.setFontSize(8); pdf.setTextColor(...PINK);
        pdf.text('Bethesda Category:', ML + 2, y + 4.2);
        pdf.setFont('helvetica', 'bold'); pdf.setFontSize(7.5); pdf.setTextColor(...DARK);
        const diagLines = pdf.splitTextToSize(v, CW - 54);
        pdf.text(diagLines[0] || v, ML + 54, y + 4.2);
        y += rowH + 2;
      } else {
        y += drawRow(p.name, v, y, i % 2 === 0);
      }
      if (y > PH - 25) { pdf.addPage(); y = 24; }
    }
  });
}

// ── SEMEN ANALYSIS — physical form-style page renderer ──
function drawSemenFormPage(pdf, d, s, PW, PH, ML, MR, GREEN, DARK, GRAY, LGRAY, hasOtherTests, startY) {
  const paramMap = {};
  SEMEN_PARAMS.forEach(p => { paramMap[p.key] = p; });

  function val(key) {
    const v = d[key];
    return (v === undefined || v === null || v === '') ? '—' : String(v);
  }
  function numFlag(key) {
    const p = paramMap[key]; if (!p) return '';
    const n = parseFloat(d[key]); if (isNaN(n)) return '';
    if (p.high != null && n > p.high) return ' (H)';
    if (p.low  != null && n < p.low)  return ' (L)';
    return '';
  }
  function flagColor(key) {
    const f = numFlag(key);
    if (f.includes('(H)')) return [185, 28, 28];
    if (f.includes('(L)')) return [59, 130, 246];
    return null;
  }
  function ref(key) {
    const p = paramMap[key]; if (!p) return '—';
    if (p.low != null && p.high != null) return `${p.low}–${p.high}`;
    if (p.low != null) return `>=${p.low}`;
    if (p.high != null) return `≤${p.high}`;
    return '—';
  }

  // Helper: draw text with inline superscript (jsPDF built-in fonts can't render Unicode superscripts)
  function drawWithSup(text, supText, afterText, x, yl, normalSize, supSize) {
    pdf.setFontSize(normalSize);
    pdf.text(text, x, yl);
    const w1 = pdf.getTextWidth(text);
    pdf.setFontSize(supSize);
    pdf.text(supText, x + w1, yl - 1.5);
    const w2 = pdf.getTextWidth(supText);
    pdf.setFontSize(normalSize);
    pdf.text(afterText, x + w1 + w2, yl);
    return w1 + w2 + pdf.getTextWidth(afterText);
  }
  if (hasOtherTests) pdf.addPage();
  const CW = PW - ML - MR;
  let y = hasOtherTests ? 24 : (startY || 26);

  // Title
  pdf.setFillColor(...GREEN);
  pdf.rect(ML, y, CW, 6, 'F');
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(9);
  pdf.setTextColor(255, 255, 255);
  pdf.text('SEMINAL FLUID ANALYSIS', PW / 2, y + 4.2, { align: 'center' });
  y += 8.5;

  // ── ROW 1: SEMEN COLLECTION (left) | MACROSCOPY (right) ──
  const colL = ML, colR = ML + CW / 2 + 2, colW = CW / 2 - 2;
  const rowH = 5.5;

  // Section header bands
  pdf.setFillColor(220, 237, 228);
  pdf.rect(colL, y, colW, 5, 'F');
  pdf.rect(colR, y, colW, 5, 'F');
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(7.5);
  pdf.setTextColor(...DARK);
  pdf.text('SEMEN COLLECTION', colL + 2, y + 3.6);
  pdf.text('MACROSCOPY', colR + 2, y + 3.6);
  y += 5;

  // Draw left (collection) and right (macroscopy) rows in parallel
  const collectionRows = [
    ['Time Produced', val('time_produced')],
    ['Time Received', val('time_received')],
    ['Time Analysed', val('time_analysed')],
    ['Abstinence',    val('abstinence')],
  ];
  const macroRows = [
    ['Appearance',  val('appearance')],
    ['Volume',      val('volume') !== '—' ? `${val('volume')} mL  (ref: 1.5–6)` : '—'],
    ['Viscosity',   val('viscosity')],
    ['Consistency', val('consistency')],
    ['Liquefaction',val('liquefaction')],
  ];
  const maxR1 = Math.max(collectionRows.length, macroRows.length);
  for (let i = 0; i < maxR1; i++) {
    const bg = i % 2 === 0 ? [252, 253, 254] : [255, 255, 255];
    pdf.setFillColor(...bg);
    pdf.rect(colL, y, colW, rowH, 'F');
    pdf.rect(colR, y, colW, rowH, 'F');
    pdf.setDrawColor(210, 220, 230); pdf.setLineWidth(0.15);
    pdf.rect(colL, y, colW, rowH);
    pdf.rect(colR, y, colW, rowH);

    pdf.setFont('helvetica', 'normal'); pdf.setFontSize(7.5); pdf.setTextColor(...DARK);
    if (collectionRows[i]) {
      pdf.setFont('helvetica', 'bold');
      pdf.text(collectionRows[i][0] + ':', colL + 2, y + rowH - 2);
      pdf.setFont('helvetica', 'normal');
      pdf.text(collectionRows[i][1], colL + 2 + pdf.getTextWidth(collectionRows[i][0] + ':') + 1, y + rowH - 2);
    }
    if (macroRows[i]) {
      pdf.setFont('helvetica', 'bold');
      pdf.text(macroRows[i][0] + ':', colR + 2, y + rowH - 2);
      pdf.setFont('helvetica', 'normal');
      pdf.text(macroRows[i][1], colR + 2 + pdf.getTextWidth(macroRows[i][0] + ':') + 1, y + rowH - 2);
    }
    y += rowH;
  }
  y += 2;

  // ── ROW 2: MICROSCOPY ── full width, viability left | sperm count right
  pdf.setFillColor(220, 237, 228);
  pdf.rect(ML, y, CW, 5, 'F');
  pdf.setFont('helvetica', 'bold'); pdf.setFontSize(7.5); pdf.setTextColor(...DARK);
  pdf.text('MICROSCOPY', PW / 2, y + 3.6, { align: 'center' });
  y += 5;

  // Viability | Sperm Count side by side
  const spermFlag = numFlag('sperm_count');
  const spermCol  = flagColor('sperm_count');
  const viaFlag   = numFlag('viability');
  const viaCol    = flagColor('viability');

  pdf.setFillColor(...LGRAY); pdf.rect(ML, y, CW, rowH, 'F');
  pdf.setDrawColor(210, 220, 230); pdf.setLineWidth(0.15); pdf.rect(ML, y, CW, rowH);
  // Viability
  pdf.setFont('helvetica', 'bold'); pdf.setFontSize(7.5); pdf.setTextColor(...DARK);
  pdf.text('Viability (%):', colL + 2, y + rowH - 2);
  const viaX = colL + 2 + pdf.getTextWidth('Viability (%):') + 1;
  pdf.setFont('helvetica', 'normal');
  if (viaCol) pdf.setTextColor(...viaCol); else pdf.setTextColor(...DARK);
  pdf.text(`${val('viability')}${viaFlag}  %  (ref: 58–100)`, viaX, y + rowH - 2);
  // Sperm Count
  pdf.setFont('helvetica', 'bold'); pdf.setTextColor(...DARK);
  pdf.text('Sperm Count:', colR + 2, y + rowH - 2);
  const scX = colR + 2 + pdf.getTextWidth('Sperm Count:') + 1;
  pdf.setFont('helvetica', 'normal');
  if (spermCol) pdf.setTextColor(...spermCol); else pdf.setTextColor(...DARK);
  // Draw: "96 ↑  ×10" [superscript 6] "cells/mL  (ref: 15-200)"
  const scValText = `${val('sperm_count')}${spermFlag}  \u00d710`;
  pdf.setFontSize(7.5);
  pdf.text(scValText, scX, y + rowH - 2);
  const scW1 = pdf.getTextWidth(scValText);
  pdf.setFontSize(5.5);
  pdf.text('6', scX + scW1, y + rowH - 3.5);
  const scW2 = pdf.getTextWidth('6');
  pdf.setFontSize(7.5);
  pdf.text(' cells/mL  (ref: 15-200)', scX + scW1 + scW2, y + rowH - 2);
  pdf.setTextColor(...DARK);
  y += rowH + 2;

  // ── ROW 3: MORPHOLOGY (left tall block) | MOTILITY + WET PREP/GRAM'S (right) ──
  const morphKeys = {
    head:   ['morph_microcephalic','morph_macrocephalic','morph_pinhead','morph_pyriform','morph_double_head','morph_acrosomal'],
    tail:   ['morph_tailless','morph_short_tail','morph_long_tail','morph_double_tail','morph_coiled_tail'],
    others: ['morph_cytoplasmic_droplets','morph_midpiece_abnormality','morph_neck_defect','morph_normal'],
  };
  const motilityKeys = ['motility_a','motility_b','motility_c','motility_d'];

  // MORPHOLOGY left header
  pdf.setFillColor(220, 237, 228);
  pdf.rect(colL, y, colW, 5, 'F');
  pdf.setFont('helvetica', 'bold'); pdf.setFontSize(7.5); pdf.setTextColor(...DARK);
  pdf.text('MORPHOLOGY', colL + colW / 2, y + 3.6, { align: 'center' });

  // MOTILITY right header
  pdf.rect(colR, y, colW, 5, 'F');
  pdf.text('MOTILITY', colR + colW / 2, y + 3.6, { align: 'center' });
  y += 5;

  // Draw motility rows on the right
  let rightY = y;
  motilityKeys.forEach((k, i) => {
    const p = paramMap[k];
    const mVal = val(k);
    const mFlag = numFlag(k);
    const mCol = flagColor(k);
    const bg = i % 2 === 0 ? [252, 253, 254] : [255, 255, 255];
    pdf.setFillColor(...bg); pdf.rect(colR, rightY, colW, rowH, 'F');
    pdf.setDrawColor(210, 220, 230); pdf.setLineWidth(0.15); pdf.rect(colR, rightY, colW, rowH);
    pdf.setFont('helvetica', 'normal'); pdf.setFontSize(7); pdf.setTextColor(...DARK);
    // Shorten grade label for space
    const shortName = p.name.replace('Grade A — Progressive Motility', 'Grade A – Progressive')
                           .replace('Grade B — Non-Progressive Motility', 'Grade B – Non-Progressive')
                           .replace('Grade C — Non-Linear Motility', 'Grade C – Non-Linear')
                           .replace('Grade D — Immotile Sperm Cells', 'Grade D – Immotile');
    pdf.text(shortName, colR + 2, rightY + rowH - 2);
    const resultX = colR + colW - 30;
    if (mCol) pdf.setTextColor(...mCol); else pdf.setTextColor(...DARK);
    pdf.setFont('helvetica', mFlag ? 'bold' : 'normal');
    pdf.text(`${mVal}${mFlag}`, resultX, rightY + rowH - 2);
    pdf.setTextColor(100, 100, 100); pdf.setFont('helvetica', 'normal');
    pdf.text('%', resultX + 10, rightY + rowH - 2);
    pdf.setTextColor(...DARK);
    rightY += rowH;
  });

  // Draw morphology rows on the left, starting from same Y as motility
  let morphY = y;
  function drawMorphSub(label, keys) {
    // sub-header
    pdf.setFillColor(235, 245, 238);
    pdf.rect(colL, morphY, colW, 5, 'F');
    pdf.setDrawColor(210, 220, 230); pdf.setLineWidth(0.15); pdf.rect(colL, morphY, colW, 5);
    pdf.setFont('helvetica', 'bold'); pdf.setFontSize(7); pdf.setTextColor(...DARK);
    pdf.text(label, colL + colW / 2, morphY + 3.6, { align: 'center' });
    morphY += 5;
    keys.forEach((k, i) => {
      const p = paramMap[k];
      const mVal = val(k);
      const mFlag = numFlag(k);
      const mCol = flagColor(k);
      const mRef = ref(k);
      const bg = i % 2 === 0 ? [252, 253, 254] : [255, 255, 255];
      pdf.setFillColor(...bg); pdf.rect(colL, morphY, colW, rowH, 'F');
      pdf.setDrawColor(210, 220, 230); pdf.setLineWidth(0.15); pdf.rect(colL, morphY, colW, rowH);
      pdf.setFont('helvetica', 'normal'); pdf.setFontSize(7); pdf.setTextColor(...DARK);
      pdf.text(p.name, colL + 2, morphY + rowH - 2);
      const resultX = colL + colW - 28;
      if (mCol) pdf.setTextColor(...mCol); else pdf.setTextColor(...DARK);
      pdf.setFont('helvetica', mFlag ? 'bold' : 'normal');
      pdf.text(`${mVal}${mFlag}`, resultX, morphY + rowH - 2);
      pdf.setTextColor(100, 100, 100); pdf.setFont('helvetica', 'normal');
      const refStr = mRef !== '—' ? `%  ref:${mRef}` : '%';
      pdf.text(refStr, resultX + 10, morphY + rowH - 2);
      pdf.setTextColor(...DARK);
      morphY += rowH;
    });
  }
  drawMorphSub('HEAD', morphKeys.head);
  drawMorphSub('TAIL', morphKeys.tail);
  drawMorphSub('OTHERS', morphKeys.others);

  // Advance y below whichever column is taller
  y = Math.max(rightY, morphY) + 2;

  // ── WET PREP / GRAM'S STAIN ── full width, two columns (Wet Prep left | Gram's Stain right)
  pdf.setFillColor(220, 237, 228);
  pdf.rect(colL, y, colW, 5, 'F');
  pdf.rect(colR, y, colW, 5, 'F');
  pdf.setFont('helvetica', 'bold'); pdf.setFontSize(7.5); pdf.setTextColor(...DARK);
  pdf.text('WET PREPARATION', colL + colW / 2, y + 3.6, { align: 'center' });
  pdf.text("GRAM'S STAIN", colR + colW / 2, y + 3.6, { align: 'center' });
  y += 5;

  const wetRows = [
    ['Epithelial Cells', val('wp_epithelial_cells'), '/HPF'],
    ['Pus Cells (WBC)',  val('wp_pus_cells'),        '/HPF'],
    ['RBC',             val('wp_rbc'),               '/HPF'],
    ['Parasite / Ova',  val('wp_parasite'),          ''],
    ['Other Findings',  val('wp_other'),             ''],
  ].filter(r => r[1] !== '—');
  if (!wetRows.length) wetRows.push(['Findings', '—', '']);

  const gramVal = val('gram_stain');
  const maxR4 = wetRows.length;

  for (let i = 0; i < maxR4; i++) {
    const bg = i % 2 === 0 ? [252, 253, 254] : [255, 255, 255];
    pdf.setFillColor(...bg);
    pdf.rect(colL, y, colW, rowH, 'F');
    pdf.rect(colR, y, colW, rowH, 'F');
    pdf.setDrawColor(210, 220, 230); pdf.setLineWidth(0.15);
    pdf.rect(colL, y, colW, rowH);
    pdf.rect(colR, y, colW, rowH);
    pdf.setFont('helvetica', 'bold'); pdf.setFontSize(7.5); pdf.setTextColor(...DARK);
    pdf.text(wetRows[i][0] + ':', colL + 2, y + rowH - 2);
    pdf.setFont('helvetica', 'normal');
    const lx = colL + 2 + pdf.getTextWidth(wetRows[i][0] + ':') + 1;
    pdf.text(`${wetRows[i][1]}  ${wetRows[i][2]}`.trim(), lx, y + rowH - 2);
    if (i === 0) {
      pdf.setFont('helvetica', 'bold');
      pdf.text("Gram's Stain:", colR + 2, y + rowH - 2);
      pdf.setFont('helvetica', 'normal');
      pdf.text(gramVal, colR + 2 + pdf.getTextWidth("Gram's Stain:") + 1, y + rowH - 2);
    }
    y += rowH;
  }
  y += 2;

  // ── COMMENTS ── full width
  const commentsVal = val('comments');
  if (commentsVal !== '—') {
    pdf.setFillColor(220, 237, 228);
    pdf.rect(ML, y, CW, 5, 'F');
    pdf.setFont('helvetica', 'bold'); pdf.setFontSize(7.5); pdf.setTextColor(...DARK);
    pdf.text('COMMENTS', ML + 3, y + 3.6);
    y += 5;
    const commentsH = rowH * 1.5;
    pdf.setFillColor(...LGRAY); pdf.rect(ML, y, CW, commentsH, 'F');
    pdf.setDrawColor(210, 220, 230); pdf.setLineWidth(0.15); pdf.rect(ML, y, CW, commentsH);
    pdf.setFont('helvetica', 'normal'); pdf.setFontSize(7.5); pdf.setTextColor(...DARK);
    const lines = pdf.splitTextToSize(commentsVal, CW - 6);
    pdf.text(lines, ML + 3, y + 4);
    y += commentsH + 2;
  }

  // ── CULTURE & SENSITIVITY ── new page
  if (d.organism || (d.sensitivities && d.sensitivities.length)) {
    pdf.addPage();
    let cy = 24;

    pdf.setFillColor(...[30, 64, 175]);
    pdf.rect(ML, cy, CW, 7, 'F');
    pdf.setFont('helvetica', 'bold'); pdf.setFontSize(9.5); pdf.setTextColor(255, 255, 255);
    pdf.text('CULTURE & SENSITIVITY', PW / 2, cy + 5, { align: 'center' });
    cy += 10;

    // Organism
    pdf.setFillColor(219, 234, 254); pdf.rect(ML, cy, CW, rowH, 'F');
    pdf.setDrawColor(180, 200, 230); pdf.setLineWidth(0.2); pdf.rect(ML, cy, CW, rowH);
    pdf.setFont('helvetica', 'bold'); pdf.setFontSize(8); pdf.setTextColor(...DARK);
    pdf.text('Organism:', ML + 3, cy + rowH - 2);
    pdf.setFont('helvetica', 'italic');
    pdf.text(d.organism || 'No growth / Not specified', ML + 30, cy + rowH - 2);
    cy += rowH + 3;

    if (d.sensitivities && d.sensitivities.length) {
      // Header row
      const colW1 = 80, colW2 = 30, colW3 = CW - colW1 - colW2;
      pdf.setFillColor(241, 245, 249); pdf.rect(ML, cy, CW, rowH, 'F');
      pdf.setDrawColor(180, 200, 230); pdf.setLineWidth(0.2); pdf.rect(ML, cy, CW, rowH);
      pdf.setFont('helvetica', 'bold'); pdf.setFontSize(8); pdf.setTextColor(...DARK);
      pdf.text('Antibiotic', ML + 3, cy + rowH - 2);
      pdf.text('Result', ML + colW1 + 3, cy + rowH - 2);
      pdf.text('Interpretation', ML + colW1 + colW2 + 3, cy + rowH - 2);
      cy += rowH;

      d.sensitivities.forEach((sens, i) => {
        const label = sens.result==='S'?'Sensitive':sens.result==='R'?'Resistant':sens.result==='I'?'Intermediate':sens.result||'—';
        const col   = sens.result==='S'?[21,128,61]:sens.result==='R'?[185,28,28]:sens.result==='I'?[146,64,14]:[55,65,81];
        const bg = i % 2 === 0 ? [252, 253, 254] : [255, 255, 255];
        pdf.setFillColor(...bg); pdf.rect(ML, cy, CW, rowH, 'F');
        pdf.setDrawColor(210, 220, 230); pdf.setLineWidth(0.15); pdf.rect(ML, cy, CW, rowH);
        pdf.setFont('helvetica', 'normal'); pdf.setFontSize(8); pdf.setTextColor(...DARK);
        pdf.text(sens.antibiotic || '—', ML + 3, cy + rowH - 2);
        pdf.setFont('helvetica', 'bold'); pdf.setTextColor(...col);
        pdf.text(sens.result || '—', ML + colW1 + 3, cy + rowH - 2);
        pdf.setFont('helvetica', 'normal');
        pdf.text(label, ML + colW1 + colW2 + 3, cy + rowH - 2);
        pdf.setTextColor(...DARK);
        cy += rowH;
      });
    } else {
      pdf.setFontSize(8); pdf.setTextColor(107, 114, 128);
      pdf.text('No antibiotic sensitivities recorded.', ML + 3, cy + 5);
    }
  }
}

// ── BLOOD TRANSFUSION — BTS-REQ-XM/v1 form-style page renderer ──
function drawBloodTransfusionFormPage(pdf, d, s, PW, PH, ML, MR, GREEN, DARK, GRAY, LGRAY, hasOtherTests, startY) {
  function val(key) {
    const v = d[key];
    return (v === undefined || v === null || v === '') ? '—' : String(v);
  }

  if (hasOtherTests) pdf.addPage();
  const CW = PW - ML - MR;
  let y = hasOtherTests ? 24 : (startY || 26);

  const RED       = [185, 28, 28];
  const RED_LIGHT = [254, 242, 242];
  const GRN_LIGHT = [220, 237, 228];
  const rowH      = 5.5;
  const colL      = ML;
  const colR      = ML + CW / 2 + 2;
  const colW      = CW / 2 - 2;

  function isPositive(v) {
    return /^(Reactive|Positive)/i.test(v);
  }

  // ── Section title bar ──
  pdf.setFillColor(...GREEN);
  pdf.rect(ML, y, CW, 6.5, 'F');
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(9);
  pdf.setTextColor(255, 255, 255);
  pdf.text('BLOOD TRANSFUSION REQUEST & COMPATIBILITY REPORT', PW / 2, y + 4.5, { align: 'center' });
  y += 8.5;

  // ── Section 2: CLINICAL REQUEST DETAILS ──
  pdf.setFillColor(...GRN_LIGHT);
  pdf.rect(ML, y, CW, 5, 'F');
  pdf.setFont('helvetica', 'bold'); pdf.setFontSize(7.5); pdf.setTextColor(...DARK);
  pdf.text('2.  CLINICAL REQUEST DETAILS', ML + 3, y + 3.6);
  y += 5;

  // Reason for Transfusion
  pdf.setFillColor(252, 253, 254);
  pdf.rect(ML, y, CW, rowH, 'F');
  pdf.setDrawColor(210, 220, 230); pdf.setLineWidth(0.15); pdf.rect(ML, y, CW, rowH);
  pdf.setFont('helvetica', 'bold'); pdf.setFontSize(7); pdf.setTextColor(...DARK);
  pdf.text('Reason for Transfusion:', ML + 2, y + rowH - 1.8);
  pdf.setFont('helvetica', 'normal');
  pdf.text(val('transfusion_reason'), ML + 2 + pdf.getTextWidth('Reason for Transfusion:') + 2, y + rowH - 1.8);
  y += rowH;

  // Investigations requested row
  pdf.setFillColor(255, 255, 255);
  pdf.rect(ML, y, CW, rowH, 'F');
  pdf.setDrawColor(210, 220, 230); pdf.setLineWidth(0.15); pdf.rect(ML, y, CW, rowH);
  pdf.setFont('helvetica', 'bold'); pdf.setFontSize(7); pdf.setTextColor(...DARK);
  pdf.text('Investigations Requested:', ML + 2, y + rowH - 1.8);
  const invParts = [];
  if (val('inv_hb_electrophoresis') === 'Requested') invParts.push('Hb Electrophoresis');
  if (val('inv_type_screen') === 'Requested')        invParts.push('Type & Screen');
  if (val('inv_full_crossmatch') === 'Requested')    invParts.push('Full Crossmatch');
  pdf.setFont('helvetica', 'normal');
  pdf.text(invParts.length ? invParts.join(', ') : '—', ML + 2 + pdf.getTextWidth('Investigations Requested:') + 2, y + rowH - 1.8);
  y += rowH;

  // HB / PCV results row (two-column)
  pdf.setFillColor(252, 253, 254);
  pdf.rect(colL, y, colW, rowH, 'F');
  pdf.rect(colR, y, colW, rowH, 'F');
  pdf.setDrawColor(210, 220, 230); pdf.setLineWidth(0.15);
  pdf.rect(colL, y, colW, rowH); pdf.rect(colR, y, colW, rowH);
  pdf.setFont('helvetica', 'bold'); pdf.setFontSize(7); pdf.setTextColor(...DARK);
  pdf.text('Result: HB:', colL + 2, y + rowH - 1.8);
  pdf.setFont('helvetica', 'normal');
  const hbVal = val('result_hb') !== '—' ? val('result_hb') + ' g/dL' : '—';
  pdf.text(hbVal, colL + 2 + pdf.getTextWidth('Result: HB:') + 2, y + rowH - 1.8);
  pdf.setFont('helvetica', 'bold');
  pdf.text('PCV:', colR + 2, y + rowH - 1.8);
  pdf.setFont('helvetica', 'normal');
  const pcvVal = val('result_pcv') !== '—' ? val('result_pcv') + ' %' : '—';
  pdf.text(pcvVal, colR + 2 + pdf.getTextWidth('PCV:') + 2, y + rowH - 1.8);
  y += rowH + 3;

  // ── Section 3: BLOOD PRODUCTS REQUIRED ──
  pdf.setFillColor(...GRN_LIGHT);
  pdf.rect(ML, y, CW, 5, 'F');
  pdf.setFont('helvetica', 'bold'); pdf.setFontSize(7.5); pdf.setTextColor(...DARK);
  pdf.text('3.  BLOOD PRODUCTS REQUIRED', ML + 3, y + 3.6);
  y += 5;

  // Checkboxes row 1: Whole Blood | Platelet Concentrate | Cryoprecipitate
  const bp1 = [
    ['Whole Blood',         val('bp_whole_blood')],
    ['Platelet Concentrate',val('bp_platelet_concentrate')],
    ['Cryoprecipitate',     val('bp_cryoprecipitate')],
  ];
  const bp2 = [
    ['Packed Cells',           val('bp_packed_cells')],
    ['Fresh Frozen Plasma (FFP)', val('bp_ffp')],
    ['Retroviral Screening',   val('bp_retroviral_screening')],
  ];
  function drawCheckRow(items, yPos) {
    const itemW = CW / 3;
    items.forEach((item, i) => {
      const x = ML + i * itemW;
      const checked = item[1] === 'Yes';
      if (checked) { pdf.setFillColor(220, 252, 231); } else { pdf.setFillColor(255, 255, 255); }
      pdf.rect(x, yPos, itemW, rowH, 'F');
      pdf.setDrawColor(210,220,230); pdf.setLineWidth(0.15); pdf.rect(x, yPos, itemW, rowH);
      // Draw checkbox square
      pdf.setDrawColor(...DARK); pdf.setLineWidth(0.4);
      pdf.rect(x + 2, yPos + 1.5, 2.5, 2.5);
      if (checked) {
        pdf.setDrawColor(21,128,61); pdf.setLineWidth(0.5);
        pdf.line(x + 2.2, yPos + 2.7, x + 2.8, yPos + 3.6);
        pdf.line(x + 2.8, yPos + 3.6, x + 4.3, yPos + 1.8);
      }
      pdf.setDrawColor(210,220,230); pdf.setLineWidth(0.15);
      pdf.setFont('helvetica', checked ? 'bold' : 'normal');
      pdf.setFontSize(7); pdf.setTextColor(...DARK);
      pdf.text(item[0], x + 6, yPos + rowH - 1.8);
    });
  }
  drawCheckRow(bp1, y); y += rowH;
  drawCheckRow(bp2, y); y += rowH;

  // Units required / donated and date/time rows
  pdf.setFillColor(252, 253, 254);
  pdf.rect(colL, y, colW, rowH, 'F');
  pdf.rect(colR, y, colW, rowH, 'F');
  pdf.setDrawColor(210,220,230); pdf.setLineWidth(0.15);
  pdf.rect(colL, y, colW, rowH); pdf.rect(colR, y, colW, rowH);
  pdf.setFont('helvetica', 'bold'); pdf.setFontSize(7); pdf.setTextColor(...DARK);
  pdf.text('No. of Units Required:', colL + 2, y + rowH - 1.8);
  pdf.setFont('helvetica', 'normal');
  pdf.text(val('units_required'), colL + 2 + pdf.getTextWidth('No. of Units Required:') + 2, y + rowH - 1.8);
  pdf.setFont('helvetica', 'bold');
  pdf.text('No. of Units Donated:', colR + 2, y + rowH - 1.8);
  pdf.setFont('helvetica', 'normal');
  pdf.text(val('units_donated'), colR + 2 + pdf.getTextWidth('No. of Units Donated:') + 2, y + rowH - 1.8);
  y += rowH;

  pdf.setFillColor(255, 255, 255);
  pdf.rect(colL, y, colW, rowH, 'F');
  pdf.rect(colR, y, colW, rowH, 'F');
  pdf.setDrawColor(210,220,230); pdf.setLineWidth(0.15);
  pdf.rect(colL, y, colW, rowH); pdf.rect(colR, y, colW, rowH);
  pdf.setFont('helvetica', 'bold'); pdf.setFontSize(7); pdf.setTextColor(...DARK);
  pdf.text('Date Required:', colL + 2, y + rowH - 1.8);
  pdf.setFont('helvetica', 'normal');
  pdf.text(val('date_required'), colL + 2 + pdf.getTextWidth('Date Required:') + 2, y + rowH - 1.8);
  pdf.setFont('helvetica', 'bold');
  pdf.text('Time Required:', colR + 2, y + rowH - 1.8);
  pdf.setFont('helvetica', 'normal');
  pdf.text(val('time_required'), colR + 2 + pdf.getTextWidth('Time Required:') + 2, y + rowH - 1.8);
  y += rowH + 3;

  // ── Section 5: AUTOLOGOUS BLOOD (IF APPLICABLE) ──
  pdf.setFillColor(...GRN_LIGHT);
  pdf.rect(ML, y, CW, 5, 'F');
  pdf.setFont('helvetica', 'bold'); pdf.setFontSize(7.5); pdf.setTextColor(...DARK);
  pdf.text('5.  AUTOLOGOUS BLOOD (IF APPLICABLE)', ML + 3, y + 3.6);
  y += 5;

  pdf.setFillColor(252, 253, 254);
  pdf.rect(colL, y, colW, rowH, 'F');
  pdf.rect(colR, y, colW, rowH, 'F');
  pdf.setDrawColor(210,220,230); pdf.setLineWidth(0.15);
  pdf.rect(colL, y, colW, rowH); pdf.rect(colR, y, colW, rowH);
  pdf.setFont('helvetica', 'bold'); pdf.setFontSize(7); pdf.setTextColor(...DARK);
  pdf.text('No. of Units to be Collected:', colL + 2, y + rowH - 1.8);
  pdf.setFont('helvetica', 'normal');
  pdf.text(val('autologous_units'), colL + 2 + pdf.getTextWidth('No. of Units to be Collected:') + 2, y + rowH - 1.8);
  pdf.setFont('helvetica', 'bold');
  pdf.text('Type of Surgery:', colR + 2, y + rowH - 1.8);
  pdf.setFont('helvetica', 'normal');
  pdf.text(val('type_of_surgery'), colR + 2 + pdf.getTextWidth('Type of Surgery:') + 2, y + rowH - 1.8);
  y += rowH + 3;

  // ── Section 6: LABORATORY — SEROLOGY & BLOOD GROUPING RESULTS ──
  pdf.setFillColor(...GRN_LIGHT);
  pdf.rect(ML, y, CW, 5, 'F');
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(7.5);
  pdf.setTextColor(...DARK);
  pdf.text('6.  LABORATORY — SEROLOGY & BLOOD GROUPING RESULTS', ML + 3, y + 3.6);
  y += 5;

  // Sub-headers: Patient | Donor
  pdf.setFillColor(235, 245, 238);
  pdf.rect(colL, y, colW, 5, 'F');
  pdf.rect(colR, y, colW, 5, 'F');
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(7.5);
  pdf.setTextColor(...DARK);
  pdf.text('Patient Blood Group & Serological Screening', colL + 2, y + 3.6);
  pdf.text('Donor Blood Group & Serological Screening',   colR + 2, y + 3.6);
  y += 5;

  const patientRows = [
    ['Blood Group', val('patient_blood_group')],
    ['HBsAg',       val('patient_hbsag')],
    ['HCV',         val('patient_hcv')],
    ['RVS',         val('patient_rvs')],
  ];
  const donorRows = [
    ['Blood Group', val('donor_blood_group')],
    ['PCV',         val('donor_pcv') !== '—' ? val('donor_pcv') + ' %' : '—'],
    ['HBsAg',       val('donor_hbsag')],
    ['HCV',         val('donor_hcv')],
    ['VDRL',        val('donor_vdrl')],
    ['RVS',         val('donor_rvs')],
  ];

  const maxSero = Math.max(patientRows.length, donorRows.length);
  for (let i = 0; i < maxSero; i++) {
    const bg = i % 2 === 0 ? [252, 253, 254] : [255, 255, 255];
    pdf.setFillColor(...bg);
    pdf.rect(colL, y, colW, rowH, 'F');
    pdf.rect(colR, y, colW, rowH, 'F');
    pdf.setDrawColor(210, 220, 230); pdf.setLineWidth(0.15);
    pdf.rect(colL, y, colW, rowH);
    pdf.rect(colR, y, colW, rowH);

    if (patientRows[i]) {
      pdf.setFont('helvetica', 'bold'); pdf.setFontSize(7.5); pdf.setTextColor(...DARK);
      pdf.text(patientRows[i][0] + ':', colL + 2, y + rowH - 1.8);
      const result = patientRows[i][1];
      const col = isPositive(result) ? RED : [21, 128, 61];
      pdf.setFont('helvetica', 'normal');
      pdf.setTextColor(...col);
      pdf.text(result, colL + 2 + pdf.getTextWidth(patientRows[i][0] + ':') + 2, y + rowH - 1.8);
      pdf.setTextColor(...DARK);
    }
    if (donorRows[i]) {
      pdf.setFont('helvetica', 'bold'); pdf.setFontSize(7.5); pdf.setTextColor(...DARK);
      pdf.text(donorRows[i][0] + ':', colR + 2, y + rowH - 1.8);
      const result = donorRows[i][1];
      const col = isPositive(result) ? RED : [21, 128, 61];
      pdf.setFont('helvetica', 'normal');
      pdf.setTextColor(...col);
      pdf.text(result, colR + 2 + pdf.getTextWidth(donorRows[i][0] + ':') + 2, y + rowH - 1.8);
      pdf.setTextColor(...DARK);
    }
    y += rowH;
  }
  y += 3;

  // ── Section 7: MAJOR CROSSMATCH ──
  pdf.setFillColor(...GRN_LIGHT);
  pdf.rect(ML, y, CW, 5, 'F');
  pdf.setFont('helvetica', 'bold'); pdf.setFontSize(7.5); pdf.setTextColor(...DARK);
  pdf.text('7.  MAJOR CROSSMATCH', ML + 3, y + 3.6);
  y += 5;

  const phW = 58, resW = 60, remW = CW - phW - resW;
  pdf.setFillColor(235, 245, 238);
  pdf.rect(ML, y, phW, rowH, 'F');
  pdf.rect(ML + phW, y, resW, rowH, 'F');
  pdf.rect(ML + phW + resW, y, remW, rowH, 'F');
  pdf.setFont('helvetica', 'bold'); pdf.setFontSize(7.5); pdf.setTextColor(...DARK);
  pdf.text('Phase',   ML + 2, y + rowH - 1.8);
  pdf.text('Result',  ML + phW + 2, y + rowH - 1.8);
  pdf.text('Remarks', ML + phW + resW + 2, y + rowH - 1.8);
  pdf.setDrawColor(210, 220, 230); pdf.setLineWidth(0.15);
  pdf.rect(ML, y, phW, rowH);
  pdf.rect(ML + phW, y, resW, rowH);
  pdf.rect(ML + phW + resW, y, remW, rowH);
  y += rowH;

  const xmPhases = [
    { label: 'Normal Saline (37\u00b0C)', result: val('xm_ns_result'),  remarks: val('xm_ns_remarks')  },
    { label: 'Bovine Albumin',            result: val('xm_ba_result'),  remarks: val('xm_ba_remarks')  },
    { label: 'AHG (Anti-Human Globulin)', result: val('xm_ahg_result'), remarks: val('xm_ahg_remarks') },
  ];

  xmPhases.forEach((phase, i) => {
    const bg = i % 2 === 0 ? [252, 253, 254] : [255, 255, 255];
    pdf.setFillColor(...bg);
    pdf.rect(ML, y, phW, rowH, 'F');
    pdf.rect(ML + phW, y, resW, rowH, 'F');
    pdf.rect(ML + phW + resW, y, remW, rowH, 'F');
    pdf.setDrawColor(210, 220, 230); pdf.setLineWidth(0.15);
    pdf.rect(ML, y, phW, rowH);
    pdf.rect(ML + phW, y, resW, rowH);
    pdf.rect(ML + phW + resW, y, remW, rowH);

    pdf.setFont('helvetica', 'normal'); pdf.setFontSize(7.5); pdf.setTextColor(...DARK);
    pdf.text(phase.label, ML + 2, y + rowH - 1.8);

    const resCol = /Incompatible/i.test(phase.result) ? RED : [21, 128, 61];
    pdf.setFont('helvetica', 'bold'); pdf.setTextColor(...resCol);
    pdf.text(phase.result, ML + phW + 2, y + rowH - 1.8);

    pdf.setFont('helvetica', 'normal'); pdf.setTextColor(...DARK);
    if (phase.remarks !== '—') pdf.text(phase.remarks, ML + phW + resW + 2, y + rowH - 1.8);
    y += rowH;
  });
  y += 3;

  // ── Section 8: COMPATIBILITY / CROSSMATCH OUTCOME ──
  pdf.setFillColor(...GRN_LIGHT);
  pdf.rect(ML, y, CW, 5, 'F');
  pdf.setFont('helvetica', 'bold'); pdf.setFontSize(7.5); pdf.setTextColor(...DARK);
  pdf.text('8.  COMPATIBILITY / CROSSMATCH OUTCOME', ML + 3, y + 3.6);
  y += 5;

  pdf.setFillColor(...LGRAY);
  pdf.rect(ML, y, CW, rowH, 'F');
  pdf.setDrawColor(210, 220, 230); pdf.setLineWidth(0.15); pdf.rect(ML, y, CW, rowH);
  pdf.setFont('helvetica', 'bold'); pdf.setFontSize(7.5); pdf.setTextColor(...DARK);
  pdf.text('Blood Unit / Bag No.:', ML + 2, y + rowH - 1.8);
  pdf.setFont('helvetica', 'normal');
  pdf.text(val('blood_bag_no'), ML + 2 + pdf.getTextWidth('Blood Unit / Bag No.:') + 2, y + rowH - 1.8);
  y += rowH;

  const xmResult   = val('crossmatch');
  const isCompat   = /Compatible with Patient/i.test(xmResult);
  const xmBg       = isCompat ? [220, 252, 231] : RED_LIGHT;
  const xmTextCol  = isCompat ? [21, 128, 61]   : RED;
  pdf.setFillColor(...xmBg);
  pdf.rect(ML, y, CW, rowH + 1, 'F');
  pdf.setDrawColor(210, 220, 230); pdf.setLineWidth(0.15); pdf.rect(ML, y, CW, rowH + 1);
  pdf.setFont('helvetica', 'bold'); pdf.setFontSize(7.5); pdf.setTextColor(...DARK);
  pdf.text('Grouping & Crossmatch Result:', ML + 2, y + rowH - 1);
  pdf.setTextColor(...xmTextCol);
  pdf.setFontSize(8);
  pdf.text(xmResult.toUpperCase(), ML + 2 + pdf.getTextWidth('Grouping & Crossmatch Result:') + 4, y + rowH - 1);
  y += rowH + 3;

  // Time fields
  const tW = CW / 2;
  pdf.setFillColor(...LGRAY);
  pdf.rect(colL, y, tW, rowH, 'F');
  pdf.rect(colR, y, tW, rowH, 'F');
  pdf.setDrawColor(210,220,230); pdf.setLineWidth(0.15);
  pdf.rect(colL, y, tW, rowH); pdf.rect(colR, y, tW, rowH);
  pdf.setFont('helvetica', 'bold'); pdf.setFontSize(7); pdf.setTextColor(...DARK);
  pdf.text('Time Issued:', ML + 2, y + rowH - 1.8);
  pdf.setFont('helvetica', 'normal');
  pdf.text(val('time_issued'), ML + 2 + pdf.getTextWidth('Time Issued:') + 2, y + rowH - 1.8);
  pdf.setFont('helvetica', 'bold');
  pdf.text('Time Returned:', colR + 2, y + rowH - 1.8);
  pdf.setFont('helvetica', 'normal');
  pdf.text(val('time_returned'), colR + 2 + pdf.getTextWidth('Time Returned:') + 2, y + rowH - 1.8);
  y += rowH;

  pdf.setFillColor(252, 253, 254);
  pdf.rect(ML, y, CW, rowH, 'F');
  pdf.setDrawColor(210,220,230); pdf.setLineWidth(0.15); pdf.rect(ML, y, CW, rowH);
  pdf.setFont('helvetica', 'bold'); pdf.setFontSize(7); pdf.setTextColor(...DARK);
  pdf.text('Time Reissued:', ML + 2, y + rowH - 1.8);
  pdf.setFont('helvetica', 'normal');
  pdf.text(val('time_reissued'), ML + 2 + pdf.getTextWidth('Time Reissued:') + 2, y + rowH - 1.8);
  y += rowH + 3;

  // ── Section 9: LABORATORY AUTHORISATION ──
  pdf.setFillColor(...GRN_LIGHT);
  pdf.rect(ML, y, CW, 5, 'F');
  pdf.setFont('helvetica', 'bold'); pdf.setFontSize(7.5); pdf.setTextColor(...DARK);
  pdf.text('9.  LABORATORY AUTHORISATION', ML + 3, y + 3.6);
  y += 5;

  const sigBoxH = 20;
  pdf.setFillColor(250, 250, 250);
  pdf.rect(colL, y, colW, sigBoxH, 'F');
  pdf.rect(colR, y, colW, sigBoxH, 'F');
  pdf.setDrawColor(210, 220, 230); pdf.setLineWidth(0.15);
  pdf.rect(colL, y, colW, sigBoxH);
  pdf.rect(colR, y, colW, sigBoxH);

  pdf.setFont('helvetica', 'bold'); pdf.setFontSize(7); pdf.setTextColor(...DARK);
  pdf.text('Grouping & Crossmatch Performed By', colL + 2, y + 4);
  pdf.text('Grouping & Crossmatch Checked By (Head of Unit)', colR + 2, y + 4);

  pdf.setFont('helvetica', 'normal'); pdf.setFontSize(7);
  const releasedAt = s.released_at
    ? new Date(s.released_at).toLocaleDateString('en-GB', { day:'2-digit', month:'short', year:'numeric' })
    : new Date().toLocaleDateString('en-GB', { day:'2-digit', month:'short', year:'numeric' });

  pdf.text('Name:',      colL + 2, y + 9);
  pdf.text('Signature:', colL + 2, y + 13);
  pdf.text('Date: ' + releasedAt, colL + 2, y + 18);

  pdf.text('Name:',      colR + 2, y + 9);
  pdf.text('Signature:', colR + 2, y + 13);
  pdf.text('Date:',      colR + 2, y + 18);

  y += sigBoxH + 3;

  pdf.setFont('helvetica', 'italic'); pdf.setFontSize(6.5); pdf.setTextColor(...GRAY);
  pdf.text('Form Ref: BTS-REQ-XM/v1  |  Page 1 of 2', PW / 2, y + 3, { align: 'center' });
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
    body.push([testName, { content: val + flag, styles: col ? { textColor: col, fontStyle: 'bold' } : {} }, pdfUnit(range.unit), `${range.low}–${range.high}`]);
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
    // MCS is rendered as a dedicated single-page form (like semen/blood transfusion).
    // Nothing is added to tableBody — drawMCSFormPage() handles all rendering.
    // Pushing rows here would inflate tableBody.length and wrongly trigger a new
    // page even when MCS is the only test, putting the report on page 2.
    return;
  }

  if (testType === 'complex_histopath' || testType === 'complex_fnac' || testType === 'complex_pap_smear') {
    // Histopath/FNAC/PAP are rendered as dedicated single-page forms.
    // Nothing is added to tableBody — the drawXxxFormPage() functions handle rendering.
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

  if (testType === 'complex_semen') {
    // ── Define section groupings matching the physical form layout ──
    const SEMEN_SECTIONS = [
      {
        label: 'Semen Collection',
        fillColor: [232, 244, 240],
        keys: ['time_produced','time_received','time_analysed','abstinence']
      },
      {
        label: 'Macroscopy',
        fillColor: [232, 244, 240],
        keys: ['appearance','volume','viscosity','consistency','liquefaction']
      },
      {
        label: 'Microscopy',
        fillColor: [232, 244, 240],
        keys: ['sperm_count','viability']
      },
      {
        label: 'Motility',
        fillColor: [232, 244, 240],
        keys: ['motility_a','motility_b','motility_c','motility_d']
      },
      {
        label: 'Morphology — Head',
        fillColor: [240, 248, 240],
        isSubSection: false,
        prependMorphHeader: true,
        keys: ['morph_microcephalic','morph_macrocephalic','morph_pinhead','morph_pyriform','morph_double_head','morph_acrosomal']
      },
      {
        label: 'Morphology — Tail',
        fillColor: [240, 248, 240],
        isSubSection: false,
        keys: ['morph_tailless','morph_short_tail','morph_long_tail','morph_double_tail','morph_coiled_tail']
      },
      {
        label: 'Morphology — Others',
        fillColor: [240, 248, 240],
        isSubSection: false,
        keys: ['morph_cytoplasmic_droplets','morph_midpiece_abnormality','morph_neck_defect','morph_normal']
      },
      {
        label: 'Wet Preparation',
        fillColor: [232, 244, 240],
        keys: ['wp_epithelial_cells','wp_pus_cells','wp_rbc','wp_parasite','wp_other']
      },
      {
        label: "Gram's Stain",
        fillColor: [232, 244, 240],
        keys: ['gram_stain']
      },
      {
        label: 'Comments',
        fillColor: [248, 250, 252],
        keys: ['comments']
      }
    ];

    const paramMap = {};
    SEMEN_PARAMS.forEach(p => { paramMap[p.key] = p; });

    body.push([{ content: testName, colSpan: 4, styles: { fillColor: [31, 110, 67], textColor: [255,255,255], fontStyle: 'bold' } }]);

    SEMEN_SECTIONS.forEach(sec => {
      let secRows = [];
      sec.keys.forEach(k => {
        const p = paramMap[k];
        if (!p) return;
        let val = data[p.key];
        if (val === undefined || val === '') return;
        let flag = ''; let col = null;
        let ref = (p.low != null && p.high != null) ? `${p.low}–${p.high}` : (p.low != null ? `\u2265${p.low}` : p.high != null ? `\u2264${p.high}` : '—');
        let n = parseFloat(val);
        if (!isNaN(n)) {
          if (p.high != null && n > p.high) { flag = ' ↑'; col = HIGH_COLOR; }
          if (p.low  != null && n < p.low)  { flag = ' ↓'; col = LOW_COLOR; }
        }
        secRows.push([p.name, { content: String(val) + flag, styles: col ? { textColor: col, fontStyle: 'bold' } : {} }, p.unit || '', ref]);
      });
      if (!secRows.length) return;
      if (sec.prependMorphHeader) {
        body.push([{ content: 'MORPHOLOGY', colSpan: 4, styles: { fillColor: [200, 230, 210], fontStyle: 'bold', fontSize: 8, textColor: [26,44,62] } }]);
      }
      body.push([{ content: sec.label, colSpan: 4, styles: { fillColor: sec.fillColor, fontStyle: 'bold', fontSize: 7.5, textColor: [26,44,62] } }]);
      secRows.forEach(r => body.push(r));
    });

    // ── Culture & Sensitivity — force a new page ──
    body.push([{
      content: 'CULTURE & SENSITIVITY',
      colSpan: 4,
      styles: { fillColor: [219, 234, 254], fontStyle: 'bold', fontSize: 9, textColor: [30,64,175], pageBreak: 'before' }
    }]);
    body.push(['Organism', { content: data.organism || 'No growth / Not specified', colSpan: 3, styles: { fontStyle: 'italic' } }]);
    if (data.sensitivities && data.sensitivities.length) {
      body.push([
        { content: 'Antibiotic', styles: { fontStyle: 'bold', fillColor: [241,245,249] } },
        { content: 'Result',     styles: { fontStyle: 'bold', fillColor: [241,245,249] } },
        { content: 'Interpretation', colSpan: 2, styles: { fontStyle: 'bold', fillColor: [241,245,249] } }
      ]);
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

  // Standard numeric panels
  let params = [];
  if (testType === 'complex_urinalysis') {
    // Urinalysis: show all params (both Physical/Chemical), skip truly empty values
    body.push([{ content: testName, colSpan: 4, styles: { fillColor: [240, 244, 249], fontStyle: 'bold' } }]);
    for (let p of URINALYSIS_MICRO_PARAMS) {
      let val = data[p.key];
      if (val === undefined || val === null || val === '') continue;
      let flag = ''; let col = null;
      if (p.type === 'number' && p.low != null) {
        let n = parseFloat(val);
        if (!isNaN(n)) {
          if (n > p.high) { flag = ' ↑'; col = [185,28,28]; }
          else if (n < p.low) { flag = ' ↓'; col = [59,130,246]; }
        }
      }
      let ref = (p.low != null && p.high != null) ? `${p.low}–${p.high}` : '—';
      body.push([p.name, { content: String(val) + flag, styles: col ? { textColor: col, fontStyle: 'bold' } : {} }, pdfUnit(p.unit || ''), ref]);
    }
    return;
  }
  if (testType === 'complex_cbc')       params = CBC_PARAMS;
  else if (testType === 'complex_eucr')  params = EUCR_PARAMS;
  else if (testType === 'complex_calcium') params = CALCIUM_PARAMS;
  else if (testType === 'complex_phosphate') params = PHOSPHATE_PARAMS;
  else if (testType === 'complex_uric_acid') params = URIC_ACID_PARAMS;
  else if (testType === 'complex_lft')  params = LFT_PARAMS_FULL;
  else if (testType === 'complex_total_protein') params = TOTAL_PROTEIN_PARAMS;
  else if (testType === 'complex_psa')  params = PSA_PARAMS;
  else if (testType === 'complex_diabetes') params = DIABETES_PARAMS;
  else if (testType === 'complex_rf')      params = RF_PARAMS;
  else if (testType === 'complex_hormone') params = HORMONE_PARAMS;
  else if (testType === 'complex_marry')    params = MARRY_PARAMS;
  else if (testType === 'complex_antenatal') params = ANTENATAL_PARAMS;
  else if (testType === 'complex_blood')     params = BLOOD_TRANSFUSION_PARAMS;
  else if (testType === 'complex_rft')     params = RFT_PARAMS_FULL;
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
    let ref = (p.low != null && p.high != null) ? `${p.low}–${p.high}` : p.low != null ? `≥${p.low}` : p.high != null ? `≤${p.high}` : (p.note || '—');
    let n = parseFloat(val);
    if (!isNaN(n)) {
      if (p.high != null && n > p.high) { flag = ' ↑'; col = HIGH_COLOR; }
      if (p.low  != null && n < p.low)  { flag = ' ↓'; col = LOW_COLOR; }
    }
    body.push([p.name, { content: String(val) + flag, styles: col ? { textColor: col, fontStyle: 'bold' } : {} }, pdfUnit(p.unit), ref]);
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

  // Offline: serve from cache immediately
  if (!navigator.onLine) {
    await _portalServeRejectedFromCache(container);
    return;
  }

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

    // Cache for offline refresh
    if (typeof window._oqCachePortalRejected === 'function') {
      window._oqCachePortalRejected(allRejectedSamples).catch(() => {});
    }

    const badge = document.getElementById('rejectedBadge');
    const countEl = document.getElementById('rejectedCount');
    const total = allRejectedSamples.length;
    if (badge) { badge.textContent = total; badge.style.display = total ? 'inline' : 'none'; }
    if (countEl) countEl.textContent = `${total} sample${total !== 1 ? 's' : ''} with rejected tests`;

    renderRejectedTable(allRejectedSamples);
  } catch(err) {
    console.error(err);
    const isNetworkErr = !navigator.onLine || (err?.message || '').match(/fetch|network|failed to fetch/i);
    if (isNetworkErr) {
      await _portalServeRejectedFromCache(container);
    } else {
      if (container) container.innerHTML = `<div style="text-align:center; padding:30px; color:#b91c1c;"><i class="fas fa-exclamation-circle"></i> Failed to load. Please refresh.</div>`;
    }
  }
}

async function _portalServeRejectedFromCache(container) {
  if (typeof window._oqGetCachedPortalRejected !== 'function') {
    if (container) container.innerHTML = `<div style="text-align:center;padding:30px;color:var(--text2);"><i class="fas fa-wifi" style="opacity:0.4;"></i>&nbsp; Offline — no cached rejected data yet.</div>`;
    return;
  }
  const cached = await window._oqGetCachedPortalRejected().catch(() => null);
  if (cached && cached.groups && cached.groups.length) {
    allRejectedSamples = cached.groups;
    const badge = document.getElementById('rejectedBadge');
    const countEl = document.getElementById('rejectedCount');
    const total = allRejectedSamples.length;
    if (badge) { badge.textContent = total; badge.style.display = total ? 'inline' : 'none'; }
    if (countEl) countEl.textContent = `${total} sample${total !== 1 ? 's' : ''} with rejected tests (cached)`;
    renderRejectedTable(allRejectedSamples);
    if (container) {
      const stale = document.createElement('div');
      stale.style.cssText = 'font-size:0.72rem;color:var(--text2);text-align:center;padding:4px 0 8px;';
      stale.innerHTML = `<i class="fas fa-wifi" style="opacity:0.4;margin-right:4px;"></i>Offline — showing data cached ${_portalFriendlyAge(cached.updated_at)}`;
      container.prepend(stale);
    }
  } else {
    if (container) container.innerHTML = `<div style="text-align:center;padding:30px;color:var(--text2);"><i class="fas fa-wifi" style="opacity:0.4;"></i>&nbsp; Offline — no cached rejected data yet.</div>`;
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
  // Auto-refresh every 60 seconds (skip when offline)
  setInterval(() => { if (navigator.onLine) loadAndRender(); }, 60000);

  // Reload from server when connection is restored
  window.addEventListener('online', () => {
    setTimeout(() => {
      loadAndRender();
      loadRejectedSamples();
      if (typeof window._oqFlush === 'function') window._oqFlush().catch(() => {});
    }, 1500);
  });
  window.addEventListener('offline', () => {
    if (typeof toast === 'function') toast('Offline — showing cached data', 'warn');
  });
})();

// ========== PWA Service Worker ==========
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}