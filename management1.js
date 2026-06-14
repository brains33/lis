// ========== SUPABASE CLIENT ==========
const SUPABASE_URL      = 'https://npdopywxemtwzvpummsn.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5wZG9weXd4ZW10d3p2cHVtbXNuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk4NzY0MjksImV4cCI6MjA5NTQ1MjQyOX0.Mo5LfGdfSiHL6QHsPOaGkDmeaIRDqZTe8MGwz_6ou1c';

// ========== SESSION AUTH (checkAuth / logoutUser provided by auth-guard.js) ==========
const currentSession = checkAuth(['supervisor', 'admin']);
const currentUser = currentSession; // rest of page uses currentUser

// Build token-authenticated client — injects x-lis-token on every request
window._supabaseClient = window.buildAuthClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const db = window._supabaseClient;

// ========== GLOBALS ==========
let samples = [];
let qcHistory = [];
let currentVerifySample = null;
let testDefinitions = { units: {}, testPrices: {}, testTypes: {} };

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
function payBadge(paystatus) {
  let cls = paystatus === 'Paid' ? 'badge-paid' : paystatus === 'Partial' ? 'badge-partial' : 'badge-unpaid';
  return `<span class="badge ${cls}">${esc(paystatus)}</span>`;
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

// ========== LOAD TEST DEFINITIONS ==========
async function loadTestDefinitions() {
  try {
    const { data, error } = await db.from('test_definitions').select('*');
    if (error) throw error;
    // Include refRanges and selectOptions in the global object
    testDefinitions = { units: {}, testPrices: {}, testTypes: {}, refRanges: {}, selectOptions: {}, sampleTypes: {}, tubes: {} };
    data.forEach(td => {
      if (td.test_name === '__unit_placeholder__') {
        if (!testDefinitions.units[td.unit_name]) testDefinitions.units[td.unit_name] = [];
        return;
      }
      if (!testDefinitions.units[td.unit_name]) testDefinitions.units[td.unit_name] = [];
      testDefinitions.units[td.unit_name].push(td.test_name);
      testDefinitions.testPrices[td.test_name] = td.price_ngn;
      if (td.test_type !== 'simple') testDefinitions.testTypes[td.test_name] = td.test_type;
      if (td.sample_type) testDefinitions.sampleTypes[td.test_name] = td.sample_type;
      if (td.tube) testDefinitions.tubes[td.test_name] = td.tube;
      
      // Load reference range for simple_numeric
      if (td.test_type === 'simple_numeric' && td.ref_low !== null && td.ref_high !== null) {
        testDefinitions.refRanges[td.test_name] = {
          low: td.ref_low,
          high: td.ref_high,
          unit: td.ref_unit || ''
        };
      }
      // Load select options for simple_select
      if (td.test_type === 'simple_select' && td.select_options && td.select_options.length) {
        testDefinitions.selectOptions[td.test_name] = td.select_options;
      }
    });
    console.log('Test definitions loaded');
  } catch (err) {
    console.error(err);
    toast('Failed to load test definitions', 'error');
  }
}
// ========== LOAD SAMPLES ==========
async function loadSamples() {
  try {
    const { data, error } = await db
      .from('samples')
      .select('*, sample_tests(id,test_name,status,result,result_data,price_ngn,tech_name,done_by,done_at)')
      .order('id', { ascending: false })
      .limit(500);
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
      collTime: s.collection_time,
      totalAmount: s.total_amount,
      amountPaid: s.amount_paid,
      balanceDue: s.balance_due,
      releasedAt: s.released_at
    }));
  } catch (err) {
    console.error(err);
    toast('Failed to load samples', 'error');
    samples = [];
  }
}
async function saveSample(sample) {
  const { error } = await db
    .from('samples')
    .update({
      patient: sample.patient,
      age: sample.age,
      gender: sample.gender,
      phone: sample.phone,
      nid: sample.nid,
      clinician: sample.clinician,
      history: sample.history,
      priority: sample.priority,
      sample_type: sample.stype,
      tube: sample.tube,
      collection_date: sample.collDate,
      collection_time: sample.collTime,
      due_date: sample.due,
      pay_mode: sample.paymode,
      pay_status: sample.paystatus,
      insurance_no: sample.insurance,
      status: sample.status,
      total_amount: sample.totalAmount,
      amount_paid: sample.amountPaid,
      balance_due: sample.balanceDue,
      receipt_no: sample.receiptNo,
      payment_date: sample.paymentDate,
      released_at: sample.releasedAt,
      supervisor_comment: sample.supervisorComment
    })
    .eq('id', sample.id);
  if (error) throw error;
}
async function deleteSampleFromServer(id) {
  await db.from('sample_tests').delete().eq('sample_id', id);
  const { error } = await db.from('samples').delete().eq('id', id);
  if (error) throw error;
}

// ========== QC ==========
async function loadQC() {
  try {
    const { data, error } = await db.from('qc_runs').select('*').order('run_at', { ascending: false });
    if (error) throw error;
    qcHistory = data.map(q => ({ ts: q.run_at, results: q.results }));
  } catch (err) { qcHistory = []; }
}
async function saveQC(qcData) {
  const { error } = await db.from('qc_runs').insert([{
    run_at: new Date().toISOString(),
    run_by: currentUser?.name || 'Unknown',
    all_pass: qcData.results.every(r => r.pass),
    results: qcData.results
  }]);
  if (error) throw error;
}
async function runQC() {
  const controls = [
    { name:'CBC Control L1', target:{wbc:6.0, hb:12.0, plt:200}, tolerance:0.1 },
    { name:'CBC Control L2', target:{wbc:10.0, hb:15.0, plt:350}, tolerance:0.1 },
    { name:'Chemistry Control', target:{glucose:5.5, creatinine:88}, tolerance:0.1 }
  ];
  let results = controls.map(c => {
    let pass = true, details = [];
    for (let [param, target] of Object.entries(c.target)) {
      let measured = +(target * (1 + (Math.random() - 0.5) * c.tolerance * 2)).toFixed(2);
      let pct = Math.abs((measured - target) / target * 100);
      let ok = pct < 10;
      if (!ok) pass = false;
      details.push({ param, target, measured, pct: pct.toFixed(1), ok });
    }
    return { name: c.name, pass, details };
  });
  await saveQC({ results });
  await addAudit('QC Run', null, `${results.filter(r => !r.pass).length} control(s) failed.`);
  await loadQC();
  renderQC();
}
async function renderQC() {
  await loadQC();
  let latest = qcHistory[0];
  const qcBody = document.getElementById('qcBody');
  const qcLog = document.getElementById('qcLog');
  if (!qcBody || !qcLog) return;
  if (!latest) {
    qcBody.innerHTML = '<p style="color:var(--text2);">Click "Run QC" to begin.</p>';
    qcLog.innerHTML = '<p style="color:var(--text2);">No QC runs yet.</p>';
    return;
  }
  let html = `<p style="color:var(--text2); margin-bottom:12px;">Run at ${new Date(latest.ts).toLocaleString()}</p>`;
  latest.results.forEach(res => {
    html += `<div style="margin-bottom:16px;">
      <strong>${esc(res.name)}</strong> <span class="${res.pass ? 'qc-pass' : 'qc-fail'}">${res.pass ? '✓ PASS' : '✗ FAIL'}</span>
      <div class="qc-grid">${res.details.map(d =>
        `<div class="qc-card">
          <div style="font-size:0.75rem;color:var(--text2);">${esc(d.param)}</div>
          <div style="font-size:1.3rem;font-weight:700;" class="${d.ok ? 'qc-pass' : 'qc-fail'}">${d.measured}</div>
          <div style="font-size:0.78rem;">Target: ${d.target}</div>
          <div style="font-size:0.78rem;">CV: ${d.pct}%</div>
        </div>`).join('')}
      </div></div>`;
  });
  qcBody.innerHTML = html;
  let logHtml = qcHistory.slice(0, 10).map(r => {
    let allPass = r.results.every(x => x.pass);
    return `<div style="padding:6px 0; border-bottom:1px solid var(--border); display:flex; gap:10px; align-items:center;">
      <span style="font-family:monospace; font-size:0.78rem;">${new Date(r.ts).toLocaleString()}</span>
      <span class="${allPass ? 'qc-pass' : 'qc-fail'}">${allPass ? '✓ All Pass' : '✗ Failures'}</span>
      <small style="color:var(--text2);">${r.results.map(x => `${esc(x.name)}: ${x.pass ? '✓' : '✗'}`).join(' | ')}</small>
    </div>`;
  }).join('');
  qcLog.innerHTML = logHtml || '<p style="color:var(--text2);">No runs logged.</p>';
}

// ========== ADMIN (Test Definitions) ==========
async function renderUnitsList() {
  let container = document.getElementById('unitsList');
  if (!container) return;
  if (!Object.keys(testDefinitions.units).length) {
    container.innerHTML = '<p style="color:var(--text2);">No units yet. Add one above.</p>';
    return;
  }
  let html = '';
  for (let [unit, tests] of Object.entries(testDefinitions.units)) {
    let unitId = unit.replace(/[^a-z0-9]/gi, '_');
    html += `<div style="margin-bottom:20px; border:1.5px solid #ffe4b5; border-radius:20px; padding:16px; background:#fffdf7;">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
        <strong>${esc(unit)}</strong>
        <button class="btn btn-danger btn-sm" onclick="deleteUnit('${esc(unit)}')">Delete Unit</button>
      </div>
      <div style="display:grid; grid-template-columns:repeat(auto-fill,minmax(280px,1fr)); gap:8px; margin-bottom:12px;">
        ${tests.filter(t => t !== '__unit_placeholder__').map(test => {
          let testId = test.replace(/[^a-z0-9]/gi, '_');
          // Show stored range or options if they exist
          let extraInfo = '';
          if (testDefinitions.refRanges && testDefinitions.refRanges[test]) {
            const r = testDefinitions.refRanges[test];
            extraInfo = `<span style="font-size:0.7rem; color:var(--green); display:block;">📊 ${r.low}–${r.high} ${r.unit}</span>`;
          } else if (testDefinitions.selectOptions && testDefinitions.selectOptions[test]) {
            const opts = testDefinitions.selectOptions[test].join(', ');
            extraInfo = `<span style="font-size:0.7rem; color:var(--green); display:block;">📋 ${opts.substring(0, 40)}${opts.length > 40 ? '…' : ''}</span>`;
          }
          return `<div style="display:flex; align-items:center; gap:6px; justify-content:space-between; background:#f9f4e8; border-radius:10px; padding:8px 10px;">
            <div style="flex:1;">
              <span style="font-size:0.85rem;">${esc(test)}</span>
              ${extraInfo}
              ${testDefinitions.sampleTypes && testDefinitions.sampleTypes[test] ? `<span style="font-size:0.68rem;color:var(--primary);display:block;">🧪 ${esc(testDefinitions.sampleTypes[test])} · ${esc(testDefinitions.tubes[test] || '—')}</span>` : ''}
            </div>
            <div style="display:flex;gap:4px;align-items:center;">
              <input type="number" step="0.01" style="width:90px; padding:4px 8px; border-radius:8px; border:1px solid var(--border); font-size:0.8rem;" id="price_${testId}" value="${testDefinitions.testPrices[test] || 0}">
              <button class="btn btn-secondary btn-sm" style="padding:3px 8px;" onclick="updateTestPrice('${esc(test)}', document.getElementById('price_${testId}').value)">Save</button>
              <button class="btn btn-danger btn-sm" style="padding:3px 8px;" onclick="deleteTest('${esc(unit)}', '${esc(test)}')">×</button>
            </div>
          </div>`;
        }).join('')}
      </div>
      <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:flex-end;">
        <input type="text" id="newTest_${unitId}" placeholder="New test name" class="form-input" style="flex:2; min-width:160px;">
        <select id="testType_${unitId}" class="filter-select" style="flex:1; min-width:140px;">
          <option value="simple">Simple Text</option>
          <option value="simple_numeric">Simple Numeric (single value)</option>
          <option value="simple_select">Simple Select (dropdown)</option>
          <option value="complex_cbc">Complex (CBC)</option>
          <option value="complex_widal">Complex (Widal)</option>
          <option value="complex_lft">Complex (LFT)</option>
          <option value="complex_rft">Complex (RFT)</option>
          <option value="complex_thyroid">Complex (Thyroid)</option>
          <option value="complex_lipid">Complex (Lipid Profile)</option>
          <option value="complex_coag">Complex (Coagulation)</option>
          <option value="complex_culture">Culture & Sensitivity</option>
          <option value="complex_urine_mcs">Urine MCS (Micro + Culture + Sensitivity)</option>
          <option value="complex_stool_mcs">Stool MCS (Macro + Micro + Culture + Sensitivity)</option>
          <option value="complex_urinalysis">Complex (Urinalysis)</option>
          <option value="complex_iron">Complex (Iron Profile)</option>
          <option value="complex_bone">Complex (Bone Profile)</option>
          <option value="complex_cardiac">Complex (Cardiac Markers)</option>
          <option value="complex_ogtt">Complex (OGTT)</option>
          <option value="complex_malaria">Complex (Malaria Microscopy)</option>
          <option value="complex_tb_genexpert">Complex (TB GeneXpert)</option>
          <option value="complex_stool_cs">Stool Culture & Sensitivity</option>
          <option value="complex_csf">Complex (CSF Analysis)</option>
          <option value="complex_abg">Complex (ABG)</option>
          <option value="complex_semen">Complex (Semen Analysis)</option>
          <option value="complex_serology">Complex (Serology Panel)</option>
          <option value="complex_pcv">Complex (PCV) – gender based</option>
          <option value="complex_hb">Complex (Hb) – gender based</option>
          <option value="complex_esr">Complex (ESR) – gender based</option>
          <option value="complex_rbs">Complex (RBS)</option>
          <option value="complex_fbs">Complex (FBS)</option>
          <option value="complex_eucr">Complex (E/U/Cr – EUCR)</option>
          <option value="complex_calcium">Complex (Calcium)</option>
          <option value="complex_phosphate">Complex (Inorganic Phosphate)</option>
          <option value="complex_uric_acid">Complex (Uric Acid)</option>
          <option value="complex_total_protein">Complex (Total Protein)</option>
          <option value="complex_psa">Complex (PSA Qualitative)</option>
          <option value="complex_diabetes">Complex (Diabetes Profile)</option>
          <option value="complex_rf">Complex (RF)</option>
          <option value="complex_hormone">Complex (Hormone Panel – LH/FSH/Testosterone/Progesterone/Prolactin)</option>
          <option value="complex_marry">Complex (Marry Screen – HBsAg/HCV/RVS/SHCG/Genotype/Blood Group)</option>
          <option value="complex_antenatal">Complex (Antenatal – PCV/Genotype/Blood Group/Protein/Glucose/HBsAg/HCV)</option>
          <option value="complex_blood">Complex (Blood Transfusion – Grouping &amp; Crossmatch)</option>
        </select>
        <!-- Range fields (visible for simple_numeric) -->
        <div id="rangeFields_${unitId}" style="display:none; gap:6px; align-items:center;">
          <input type="number" step="any" id="refLow_${unitId}" placeholder="Low" style="width:70px;" class="form-input">
          <span>–</span>
          <input type="number" step="any" id="refHigh_${unitId}" placeholder="High" style="width:70px;" class="form-input">
          <input type="text" id="refUnit_${unitId}" placeholder="Unit (e.g. mg/dL)" style="width:100px;" class="form-input">
        </div>
        <!-- Options field (visible for simple_select) -->
        <div id="optionsFields_${unitId}" style="display:none;">
          <input type="text" id="selectOptions_${unitId}" placeholder="Options (comma separated)" style="width:200px;" class="form-input">
        </div>
        <!-- Sample Type & Tube fields -->
        <input type="text" id="sampleType_${unitId}" placeholder="Sample Type (e.g. Urine)" class="form-input" style="flex:1; min-width:140px;">
        <input type="text" id="tube_${unitId}" placeholder="Tube/Container (e.g. Universal)" class="form-input" style="flex:1; min-width:140px;">
        <button class="btn btn-primary btn-sm" onclick="addTestToUnit('${esc(unit)}', 
          document.getElementById('newTest_${unitId}').value,
          document.getElementById('testType_${unitId}').value,
          document.getElementById('refLow_${unitId}')?.value,
          document.getElementById('refHigh_${unitId}')?.value,
          document.getElementById('refUnit_${unitId}')?.value,
          document.getElementById('selectOptions_${unitId}')?.value,
          document.getElementById('sampleType_${unitId}')?.value,
          document.getElementById('tube_${unitId}')?.value
        )">Add Test</button>
      </div>
    </div>`;
  }
  container.innerHTML = html;

  // Attach event listeners to show/hide range/options fields
  for (let [unit, tests] of Object.entries(testDefinitions.units)) {
    let unitId = unit.replace(/[^a-z0-9]/gi, '_');
    let typeSelect = document.getElementById(`testType_${unitId}`);
    let rangeDiv = document.getElementById(`rangeFields_${unitId}`);
    let optionsDiv = document.getElementById(`optionsFields_${unitId}`);
    if (typeSelect && rangeDiv && optionsDiv) {
      function toggleFields() {
        let val = typeSelect.value;
        rangeDiv.style.display = (val === 'simple_numeric') ? 'inline-flex' : 'none';
        optionsDiv.style.display = (val === 'simple_select') ? 'inline-block' : 'none';
      }
      typeSelect.addEventListener('change', toggleFields);
      toggleFields();
    }
  }
}
async function addUnit() {
  let unitName = document.getElementById('newUnitName')?.value.trim();
  if (!unitName) { toast('Unit name required', 'error'); return; }
  if (testDefinitions.units[unitName]) { toast('Unit already exists', 'error'); return; }

  const { error } = await db.from('test_definitions').insert([{
    unit_name: unitName,
    test_name: '__unit_placeholder__',
    test_type: 'simple',
    price_ngn: 0
  }]);
  if (error) { toast('Failed to create unit: ' + error.message, 'error'); return; }

  // Update local cache — no DB re-fetch needed
  testDefinitions.units[unitName] = [];
  renderUnitsList();
  const input = document.getElementById('newUnitName');
  if (input) input.value = '';
  toast(`Unit "${unitName}" added`);
}

async function deleteUnit(unit) {
  if (!confirm(`Delete unit "${unit}" and all its tests?`)) return;
  try {
    const { error } = await db.from('test_definitions').delete().eq('unit_name', unit);
    if (error) throw error;

    // Update local cache — remove unit and clean up price/type maps
    const tests = testDefinitions.units[unit] || [];
    tests.forEach(t => {
      delete testDefinitions.testPrices[t];
      delete testDefinitions.testTypes[t];
    });
    delete testDefinitions.units[unit];

    renderUnitsList();
    toast(`Unit "${unit}" deleted`, 'warn');
  } catch(err) { toast("Delete failed: " + err.message, "error"); }
}

async function addTestToUnit(unit, testName, testType, refLow, refHigh, refUnit, selectOptionsRaw, sampleType, tube) {
  testName = (testName || '').trim();
  if (!testName) { toast('Test name required', 'error'); return; }

  // Check local cache first — same unit
  if ((testDefinitions.units[unit] || []).includes(testName)) {
    toast('Test already exists in this unit', 'error'); return;
  }

  // Check all other units — DB has a global unique constraint on test_name
  const existingUnit = Object.entries(testDefinitions.units).find(
    ([u, tests]) => u !== unit && tests.includes(testName)
  );
  if (existingUnit) {
    toast(`"${testName}" already exists in unit "${existingUnit[0]}". Test names must be unique across all units.`, 'error');
    return;
  }

  let selectOptions = null;
  if (testType === 'simple_select' && selectOptionsRaw) {
    selectOptions = selectOptionsRaw.split(',').map(s => s.trim()).filter(s => s);
    if (!selectOptions.length) { toast('Please enter at least one option', 'error'); return; }
  }

  const insertData = {
    unit_name: unit,
    test_name: testName,
    test_type: testType,
    price_ngn: 0,
    ref_low: (testType === 'simple_numeric' && refLow) ? parseFloat(refLow) : null,
    ref_high: (testType === 'simple_numeric' && refHigh) ? parseFloat(refHigh) : null,
    ref_unit: (testType === 'simple_numeric' && refUnit) ? refUnit : null,
    select_options: selectOptions,
    sample_type: sampleType ? sampleType.trim() : null,
    tube: tube ? tube.trim() : null
  };

  const { error } = await db.from('test_definitions').insert(insertData);
  if (error) {
    if (error.code === '23505') {
      toast(`"${testName}" already exists in another unit. Use a unique name.`, 'error');
    } else {
      toast('Failed to add test: ' + error.message, 'error');
    }
    return;
  }

  // Update local cache
  if (!testDefinitions.units[unit]) testDefinitions.units[unit] = [];
  testDefinitions.units[unit].push(testName);
  testDefinitions.testPrices[testName] = 0;
  if (testType !== 'simple') testDefinitions.testTypes[testName] = testType;
  if (testType === 'simple_numeric' && refLow && refHigh) {
    if (!testDefinitions.refRanges) testDefinitions.refRanges = {};
    testDefinitions.refRanges[testName] = { low: parseFloat(refLow), high: parseFloat(refHigh), unit: refUnit || '' };
  }
  if (testType === 'simple_select' && selectOptions) {
    if (!testDefinitions.selectOptions) testDefinitions.selectOptions = {};
    testDefinitions.selectOptions[testName] = selectOptions;
  }

  renderUnitsList();

  // Clear input fields
  const unitId = unit.replace(/[^a-z0-9]/gi, '_');
  const inputEl = document.getElementById('newTest_' + unitId);
  if (inputEl) inputEl.value = '';
  const rangeLow = document.getElementById('refLow_' + unitId);
  if (rangeLow) rangeLow.value = '';
  const rangeHigh = document.getElementById('refHigh_' + unitId);
  if (rangeHigh) rangeHigh.value = '';
  const rangeUnit = document.getElementById('refUnit_' + unitId);
  if (rangeUnit) rangeUnit.value = '';
  const selectOpts = document.getElementById('selectOptions_' + unitId);
  if (selectOpts) selectOpts.value = '';

  toast(`Test "${testName}" added to ${unit}`);
}
async function deleteTest(unit, test) {
  if (!confirm(`Delete test "${test}"?`)) return;
  try {
    const { error } = await db.from('test_definitions')
      .delete()
      .eq('unit_name', unit)
      .eq('test_name', test);
    if (error) throw error;

    // Update local cache — no DB re-fetch needed
    testDefinitions.units[unit] = (testDefinitions.units[unit] || []).filter(t => t !== test);
    delete testDefinitions.testPrices[test];
    delete testDefinitions.testTypes[test];

    renderUnitsList();
    toast(`Test "${test}" deleted`, 'warn');
  } catch(err) { toast("Delete failed: " + err.message, "error"); }
}

async function updateTestPrice(test, price) {
  let p = parseFloat(price);
  if (isNaN(p) || p < 0) p = 0;
  try {
    const { error } = await db.from('test_definitions')
      .update({ price_ngn: p })
      .eq('test_name', test);
    if (error) throw error;

    // Update local cache — no DB re-fetch needed
    testDefinitions.testPrices[test] = p;
    toast(`Price for "${test}" saved — ${p.toLocaleString()} NGN`);
  } catch(err) { toast("Update failed: " + err.message, "error"); }
}

// ========== EXPANDED PARAMETER DEFINITIONS (FULL) ==========
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
// Panel 1 — E/U/Cr
const EUCR_PARAMS = [
  {key:'sodium',    name:'Sodium (Na⁺)',              unit:'mmol/L', low:136,  high:150},
  {key:'potassium', name:'Potassium (K⁺)',             unit:'mmol/L', low:3.5,  high:5.0},
  {key:'bicarb',    name:'Bicarbonate (HCO₃⁻)',  unit:'mmol/L', low:22,   high:30},
  {key:'chloride',  name:'Chloride (Cl⁻)',             unit:'mmol/L', low:96,   high:108},
  {key:'urea',      name:'Urea',                           unit:'mmol/L', low:2.1,  high:7.0},
  {key:'creat',     name:'Creatinine (Male)',               unit:'mg/dL',  low:0.9,  high:1.50},
  {key:'creat_f',   name:'Creatinine (Female)',             unit:'mg/dL',  low:0.7,  high:1.37}
];
// Panel 2 — Lipid Profile (mmol/L)
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
  {key:'uric_female', name:'Uric Acid (Female)', unit:'mmol/L', low:0.16, high:0.43},
  {key:'uric_male',   name:'Uric Acid (Male)',   unit:'mmol/L', low:0.24, high:0.51}
];
// Panel 6 — LFT (Kontagora)
const LFT_PARAMS_FULL = [
  {key:'tbil',  name:'Total Bilirubin',                  unit:'mg/dL', low:0,   high:1.11},
  {key:'dbil',  name:'Direct Bilirubin',                 unit:'mg/dL', low:0,   high:0.023},
  {key:'alp',   name:'Alkaline Phosphatase (Adult)',      unit:'U/L',   low:9,   high:35},
  {key:'alp_c', name:'Alkaline Phosphatase (Children)',   unit:'U/L',   low:35,  high:100},
  {key:'ast',   name:'AST (GOT)',                         unit:'U/L',   low:3.5, high:35},
  {key:'alt',   name:'ALT (GPT)',                         unit:'U/L',   low:2.5, high:37}
];
// Panel 7 — Total Protein
const TOTAL_PROTEIN_PARAMS = [
  {key:'prot', name:'Total Protein', unit:'g/dL', low:5.8, high:8.2},
  {key:'alb',  name:'Albumin',       unit:'g/dL', low:3.5, high:5.2},
  {key:'glob', name:'Globulin',      unit:'g/dL', low:2.2, high:3.2, calc:true}
];
// Panel 8 — PSA
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
// Panel 10 — RF
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
  {key:'hbsag',      name:'HBsAg',        unit:'', type:'select', options:['Non-Reactive','Reactive']},
  {key:'hcv',        name:'HCV',          unit:'', type:'select', options:['Non-Reactive','Reactive']},
  {key:'rvs',        name:'RVS',          unit:'', type:'select', options:['Non-Reactive','Reactive']},
  {key:'shcg',       name:'SHCG',         unit:'', type:'select', options:['Negative','Positive']},
  {key:'hb_genotype',name:'Hb Genotype',  unit:'', type:'select', options:['AA','AS','SS','AC','SC','CC']},
  {key:'blood_group', name:'Blood Group', unit:'', type:'select', options:['A RH-D Positive','A RH-D Negative','B RH-D Positive','B RH-D Negative','AB RH-D Positive','AB RH-D Negative','O RH-D Positive','O RH-D Negative']}
];
// Antenatal Panel — PCV, Hb Genotype, Blood Group, Protein, Glucose, HBsAg, HCV
const ANTENATAL_PARAMS = [
  {key:'pcv',         name:'PCV',          unit:'%',  low:33, high:47},
  {key:'hb_genotype', name:'Hb Genotype',  unit:'', type:'select', options:['AA','AS','SS','AC','SC','CC']},
  {key:'blood_group', name:'Blood Group',  unit:'', type:'select', options:['A RH-D Positive','A RH-D Negative','B RH-D Positive','B RH-D Negative','AB RH-D Positive','AB RH-D Negative','O RH-D Positive','O RH-D Negative']},
  {key:'protein',     name:'Protein (Urine)',  unit:'', type:'select', options:['Negative','Trace','1+','2+','3+','4+']},
  {key:'glucose',     name:'Glucose (Urine)',  unit:'', type:'select', options:['Negative','Trace','1+','2+','3+','4+']},
  {key:'hbsag',       name:'HBsAg',        unit:'', type:'select', options:['Non-Reactive','Reactive']},
  {key:'hcv',         name:'HCV',          unit:'', type:'select', options:['Non-Reactive','Reactive']}
];
// Blood Transfusion — Grouping & Crossmatch form
const BLOOD_TRANSFUSION_PARAMS = [
  {key:'patient_blood_group', name:"Patient's Blood Group",   unit:'', type:'select', options:['A RH-D Positive','A RH-D Negative','B RH-D Positive','B RH-D Negative','AB RH-D Positive','AB RH-D Negative','O RH-D Positive','O RH-D Negative']},
  {key:'patient_hbsag',       name:"Patient HBsAg",           unit:'', type:'select', options:['Non-Reactive','Reactive']},
  {key:'patient_hcv',         name:"Patient HCV",             unit:'', type:'select', options:['Non-Reactive','Reactive']},
  {key:'patient_rvs',         name:"Patient RVS",             unit:'', type:'select', options:['Non-Reactive','Reactive']},
  {key:'donor_blood_group',   name:"Donor's Blood Group",     unit:'', type:'select', options:['A RH-D Positive','A RH-D Negative','B RH-D Positive','B RH-D Negative','AB RH-D Positive','AB RH-D Negative','O RH-D Positive','O RH-D Negative']},
  {key:'donor_hbsag',         name:"Donor HBsAg",             unit:'', type:'select', options:['Non-Reactive','Reactive']},
  {key:'donor_hcv',           name:"Donor HCV",               unit:'', type:'select', options:['Non-Reactive','Reactive']},
  {key:'donor_vdrl',          name:"Donor VDRL",              unit:'', type:'select', options:['Negative','Positive']},
  {key:'donor_rvs',           name:"Donor RVS",               unit:'', type:'select', options:['Non-Reactive','Reactive']},
  {key:'blood_no',            name:'Blood No.',                unit:'', type:'text'},
  {key:'crossmatch',          name:'Crossmatch Compatibility', unit:'', type:'select', options:['Compatible','Incompatible']},
  {key:'time_issued',         name:'Time Issued',              unit:'', type:'text'},
  {key:'time_return',         name:'Time Return',              unit:'', type:'text'},
  {key:'time_reissued',       name:'Time Reissued',            unit:'', type:'text'}
];
const RFT_PARAMS_FULL = [
  {key:'sodium',    name:'Sodium (Na⁺)',          unit:'mmol/L', low:136,  high:150},
  {key:'potassium', name:'Potassium (K⁺)',         unit:'mmol/L', low:3.5,  high:5.0},
  {key:'bicarb',    name:'Bicarbonate (HCO₃⁻)',unit:'mmol/L',low:22,   high:30},
  {key:'chloride',  name:'Chloride (Cl⁻)',         unit:'mmol/L', low:96,   high:108},
  {key:'urea',      name:'Urea',                       unit:'mmol/L', low:2.1,  high:7.0},
  {key:'creat',     name:'Creatinine',                 unit:'mg/dL',  low:0.9,  high:1.5},
  {key:'calcium',   name:'Calcium',                    unit:'mmol/L', low:2.2,  high:2.7},
  {key:'phosphate', name:'Inorganic Phosphate',        unit:'mmol/L', low:0.9,  high:1.6}
];
// Thyroid Function Test — Kontagora GH form
const THYROID_PARAMS = [
  {key:'tsh', name:'TSH', unit:'mIU/L',  low:0.3,  high:4.2},
  {key:'t3',  name:'T3',  unit:'nmol/L', low:1.23, high:3.07},
  {key:'t4',  name:'T4',  unit:'nmol/L', low:66,   high:181}
];
// Panel 2 — Lipid Profile (mmol/L — Kontagora form)
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
  {key:'anti_hbc', name:'Anti-HBc (Total)', type:'select', options:['Non-reactive','Reactive']},
];

// ========== MCS PARAMS ==========
// NOTE: These must exactly match result_entry.html's URINE_MICRO_PARAMS (same keys, same option strings)
const URINE_MICRO_PARAMS = [
  // Physical
  {key:'colour',       name:'Colour',              unit:'', section:'Physical',   type:'select', options:['Yellow','Straw','Clear','Dark Yellow','Red','Brown','Amber','Orange']},
  {key:'appearance',   name:'Appearance',           unit:'', section:'Physical',   type:'select', options:['Clear','Slightly Turbid','Turbid','Cloudy','Bloody','Frothy']},
  {key:'volume',       name:'Volume',               unit:'mL', section:'Physical', type:'number', low:0, high:3000, step:10},
  // Chemical
  {key:'ph',           name:'pH',                   unit:'', section:'Chemical',   type:'number', step:0.5, low:5.0, high:8.0},
  {key:'sg',           name:'Specific Gravity',     unit:'', section:'Chemical',   type:'number', step:0.001, low:1.005, high:1.030},
  {key:'protein',      name:'Protein',              unit:'', section:'Chemical',   type:'select', options:['Negative','Trace','+','++','+++']},
  {key:'glucose',      name:'Glucose',              unit:'', section:'Chemical',   type:'select', options:['Negative','Trace','+','++','+++']},
  {key:'ketones',      name:'Ketones',              unit:'', section:'Chemical',   type:'select', options:['Negative','Trace','+','++','+++']},
  {key:'blood',        name:'Blood',                unit:'', section:'Chemical',   type:'select', options:['Negative','Trace','+','++','+++']},
  {key:'bilirubin',    name:'Bilirubin',            unit:'', section:'Chemical',   type:'select', options:['Negative','+','++']},
  {key:'urobilinogen', name:'Urobilinogen',         unit:'mg/dL', section:'Chemical', type:'number', step:0.1, low:0.1, high:1.0},
  {key:'nitrite',      name:'Nitrite',              unit:'', section:'Chemical',   type:'select', options:['Negative','Positive']},
  {key:'leuko',        name:'Leukocyte Esterase',   unit:'', section:'Chemical',   type:'select', options:['Negative','Trace','+','++','+++']},
  // Microscopy — option strings must match result_entry exactly (TNTC full label)
  {key:'wbc_micro',    name:'WBC (Pus Cells)',      unit:'/HPF', section:'Microscopy', type:'select', options:['None seen','1–5','6–10','11–20','21–50','>50','Too numerous to count (TNTC)']},
  {key:'rbc_micro',    name:'RBC',                  unit:'/HPF', section:'Microscopy', type:'select', options:['None seen','1–2','3–5','6–10','11–20','>20','Too numerous to count (TNTC)']},
  {key:'epithelial',   name:'Epithelial Cells',     unit:'/HPF', section:'Microscopy', type:'select', options:['None seen','Squamous — Few','Squamous — Moderate','Squamous — Many','Transitional — Few','Transitional — Moderate','Renal tubular — seen']},
  {key:'casts',        name:'Casts',                unit:'/LPF', section:'Microscopy', type:'select', options:['None seen','Hyaline casts','Granular casts (coarse)','Granular casts (fine)','RBC casts','WBC casts','Epithelial cell casts','Waxy casts','Broad casts','Fatty casts','Mixed casts']},
  {key:'crystals',     name:'Crystals',             unit:'',     section:'Microscopy', type:'select', options:['None seen','Uric acid','Calcium oxalate (monohydrate)','Calcium oxalate (dihydrate)','Triple phosphate (struvite)','Amorphous phosphates','Amorphous urates','Calcium carbonate','Calcium phosphate','Cystine','Tyrosine','Leucine']},
  {key:'bacteria',     name:'Bacteria',             unit:'',     section:'Microscopy', type:'select', options:['None seen','Few','Moderate','Many','Too numerous to count (TNTC)']},
  {key:'yeast',        name:'Yeast Cells',          unit:'',     section:'Microscopy', type:'select', options:['None seen','Few','Moderate','Many']},
  {key:'parasite',     name:'Parasite / Ova',       unit:'',     section:'Microscopy', type:'select', options:['None seen','Trichomonas vaginalis','Schistosoma haematobium ova','Other — see comments']},
  {key:'mucus',        name:'Mucus Threads',        unit:'',     section:'Microscopy', type:'select', options:['None seen','Few','Moderate','Many']},
  {key:'sperm',        name:'Spermatozoa',          unit:'',     section:'Microscopy', type:'select', options:['Not seen','Seen (incidental)']},
  {key:'micro_comment',name:'Microscopy Comment',   unit:'',     section:'Microscopy', type:'text'}
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

// ========== PARAMETER HELPER FUNCTIONS ==========

// Mirrors result_entry.html's getTestType() — DB lookup first, then regex fallback
// so results always render even if test_definitions name casing differs slightly
function getTestType(testName) {
  if (testDefinitions.testTypes[testName]) return testDefinitions.testTypes[testName];
  const n = testName.toLowerCase().trim();
  if (/e\/u\/cr|eucr|e\.u\.cr|electrolytes.*urea|urea.*electrolyte/.test(n)) return 'complex_eucr';
  if (/lipid\s*profile|cholesterol/.test(n))                          return 'complex_lipid';
  if (/\bcalcium\b/.test(n) && !/phosphate|bone/.test(n))            return 'complex_calcium';
  if (/inorganic\s*phosphate|phosphate\s*profile/.test(n))           return 'complex_phosphate';
  if (/uric\s*acid/.test(n))                                          return 'complex_uric_acid';
  if (/liver\s*function|lft\b/.test(n))                              return 'complex_lft';
  if (/total\s*protein\b|albumin.*globulin|protein\s*profile/.test(n)) return 'complex_total_protein';
  if (/\bpsa\b|prostate\s*specific/.test(n))                        return 'complex_psa';
  if (/diabetes\s*profile|glucose\s*profile/.test(n))                return 'complex_diabetes';
  if (/\brf\b|rheumatoid\s*factor/.test(n))                         return 'complex_rf';
  if (/\blh\b|\bfsh\b|testosterone|progesterone|prolactin|hormone\s*profile|reproductive/.test(n)) return 'complex_hormone';
  if (/\bmarry\b|marriage\s*screen|pre.?marital/.test(n)) return 'complex_marry';
  if (/antenatal|ante.?natal|anc\b|booking\s*test/.test(n)) return 'complex_antenatal';
  if (/\bblood\s*transfusion\b|grouping.*cross|crossmatch|cross\s*match/.test(n)) return 'complex_blood';
  if (/renal\s*function|kidney\s*function|rft\b/.test(n))            return 'complex_rft';
  if (/full\s*blood\s*count|complete\s*blood|cbc\b|fbc\b/.test(n))   return 'complex_cbc';
  if (/thyroid|tsh|thyroid\s*function/.test(n))                      return 'complex_thyroid';
  if (/lipid\s*profile|cholesterol/.test(n))                         return 'complex_lipid';
  if (/coagul|prothrombin|clotting\s*profile|pt\/inr|coag\b/.test(n))return 'complex_coag';
  if (/widal/.test(n))                                               return 'complex_widal';
  if (/urine\s*mcs|urine\s*m\/c\/s|urine\s*culture|urinalysis\s*mcs/.test(n)) return 'complex_urine_mcs';
  if (/stool\s*mcs|stool\s*m\/c\/s|stool\s*culture/.test(n))        return 'complex_stool_mcs';
  if (/urinalysis|urine\s*r\/e|u\/a\b|routine\s*urine/.test(n))     return 'complex_urinalysis';
  if (/culture|sensitivity|c\/s\b|cs\b/.test(n) && /stool|faec/.test(n)) return 'complex_stool_cs';
  if (/culture|sensitivity|c\/s\b|cs\b/.test(n))                    return 'complex_culture';
  if (/malaria|rdt|thick.*film|blood.*film/.test(n))                 return 'complex_malaria';
  if (/genexpert|xpert|tb.*pcr|mtb/.test(n))                        return 'complex_tb_genexpert';
  if (/serology|hbsag|hepatitis/.test(n))                           return 'complex_serology';
  if (/iron\s*studies|iron\s*profile|serum\s*iron/.test(n))         return 'complex_iron';
  if (/bone\s*profile|calcium\s*profile/.test(n))                   return 'complex_bone';
  if (/cardiac|troponin|ckmb/.test(n))                              return 'complex_cardiac';
  if (/ogtt|glucose\s*tolerance/.test(n))                           return 'complex_ogtt';
  if (/csf|cerebrospinal/.test(n))                                  return 'complex_csf';
  if (/blood\s*gas|abg\b/.test(n))                                  return 'complex_abg';
  if (/semen\s*analysis|seminal/.test(n))                           return 'complex_semen';
  if (/packed\s*cell|pcv\b|haematocrit/.test(n))                    return 'complex_pcv';
  if (/haemoglobin|hemoglobin|\bhb\b/.test(n))                      return 'complex_hb';
  if (/esr\b|sedimentation/.test(n))                                return 'complex_esr';
  if (/random\s*blood\s*sugar|rbs\b/.test(n))                       return 'complex_rbs';
  if (/fasting\s*blood\s*sugar|fbs\b/.test(n))                      return 'complex_fbs';
  return 'simple';
}
function getParamFlag(val, p) {
  let n = parseFloat(val);
  if (isNaN(n)) return '';
  if (p.high !== null && n > p.high) return '↑';
  if (p.low  !== null && n < p.low)  return '↓';
  return '';
}

function paramsFor(testType) {
  switch (testType) {
    case 'complex_cbc': return CBC_PARAMS;
    case 'complex_eucr': return EUCR_PARAMS;
    case 'complex_calcium': return CALCIUM_PARAMS;
    case 'complex_phosphate': return PHOSPHATE_PARAMS;
    case 'complex_uric_acid': return URIC_ACID_PARAMS;
    case 'complex_lft': return LFT_PARAMS_FULL;
    case 'complex_total_protein': return TOTAL_PROTEIN_PARAMS;
    case 'complex_psa': return PSA_PARAMS;
    case 'complex_diabetes': return DIABETES_PARAMS;
    case 'complex_rf': return RF_PARAMS;
    case 'complex_hormone': return HORMONE_PARAMS;
    case 'complex_marry': return MARRY_PARAMS;
    case 'complex_antenatal': return ANTENATAL_PARAMS;
    case 'complex_blood': return BLOOD_TRANSFUSION_PARAMS;
    case 'complex_rft': return RFT_PARAMS_FULL;
    case 'complex_thyroid': return THYROID_PARAMS;
    case 'complex_lipid': return LIPID_PARAMS;
    case 'complex_coag': return COAG_PARAMS;
    case 'complex_urinalysis': return URINALYSIS_MICRO_PARAMS;
    case 'complex_urine_mcs': return URINE_MICRO_PARAMS;
    case 'complex_stool_mcs': return STOOL_MICRO_PARAMS;
    case 'complex_iron': return IRON_PARAMS;
    case 'complex_bone': return BONE_PARAMS;
    case 'complex_cardiac': return CARDIAC_PARAMS;
    case 'complex_ogtt': return OGTT_PARAMS;
    case 'complex_malaria': return MALARIA_PARAMS;
    case 'complex_tb_genexpert': return TB_GX_PARAMS;
    case 'complex_csf': return CSF_PARAMS;
    case 'complex_abg': return ABG_PARAMS;
    case 'complex_semen': return SEMEN_PARAMS;
    case 'complex_serology': return SEROLOGY_PARAMS;
    case 'complex_pcv':
    case 'complex_hb':
    case 'complex_esr':
    case 'complex_rbs':
    case 'complex_fbs':
      return [];
    default: return [];
  }
}

function buildReportPreview(s) {
  let rows = '';
  s.tests.forEach(t => {
    let testType = getTestType(t.test_name);
    const techWho  = t.tech_name || t.done_by || null;
    const techDone = t.done_at ? new Date(t.done_at).toLocaleString() : null;
    const techBadge = techWho
      ? `<span style="font-size:0.72rem;font-weight:500;color:#1a6840;background:#eaf5ef;
                       border:1px solid #c6e8d4;border-radius:20px;padding:1px 9px;margin-left:8px;">
           <i class="fas fa-user-circle" style="font-size:0.65rem;"></i>&nbsp;${esc(techWho)}${techDone ? ` &middot; ${techDone}` : ''}
         </span>`
      : `<span style="font-size:0.72rem;color:#9ca3af;margin-left:8px;">No tech recorded</span>`;

    // ── Rejected test — show as a note row, no results ──────────────────
    if (t.status === 'Rejected') {
      rows += `<tr style="background:#fff0f0;">
        <td colspan="4" style="padding:8px 12px;">
          <span style="font-weight:600;color:#b91c1c;"><i class="fas fa-ban"></i> ${esc(t.test_name)}</span>
          <span style="font-size:0.78rem;color:#b91c1c;background:#fff;border:1px solid #fca5a5;border-radius:20px;padding:2px 10px;margin-left:8px;">
            Rejected: ${esc(t.rejection_reason || 'No reason recorded')}
          </span>
          <span style="font-size:0.72rem;color:#92400e;margin-left:8px;">Patient to return for recollection</span>
        </td>
      </tr>`;
      return;
    }
    rows += `<tr style="background:#f8fafb;"><td colspan="4" style="padding:8px 12px; font-weight:600;">${esc(t.test_name)}${techBadge}</td></tr>`;
    if (t.result && t.result.startsWith('{')) {
      try {
        let d = JSON.parse(t.result);
        if (testType === 'complex_pcv' || testType === 'complex_hb' || testType === 'complex_esr' ||
            testType === 'complex_rbs' || testType === 'complex_fbs') {
          let key = testType.split('_')[1];
          let val = d[key];
          if (val !== undefined) {
            let range = getReferenceRange(t.test_name, s.age, s.gender);
            if (!range) range = { low: 0, high: 100, unit: '' };
            let flag = '';
            let num = parseFloat(val);
            if (!isNaN(num)) {
              if (num > range.high) flag = '↑';
              else if (num < range.low) flag = '↓';
            }
            rows += `<tr><td style="padding:6px 12px;">Result</td>
                         <td style="padding:6px 12px; ${flag ? 'font-weight:700;color:#dc2626;' : ''}">${val} ${flag}</td>
                         <td style="padding:6px 12px;">${esc(range.unit)}</td>
                         <td style="padding:6px 12px;">${range.low}–${range.high}</td></tr>`;
          }
        } else if (testType === 'complex_widal') {
          const widalEntries = [
            { organism: 'Salmonella Typhi',        o: d.o ?? '—', h: d.h ?? '—' },
            { organism: 'Salmonella Paratyphi A',  o: d.ao ?? '—', h: d.ah ?? '—' },
            { organism: 'Salmonella Paratyphi B',  o: d.bo ?? '—', h: d.bh ?? '—' },
            { organism: 'Salmonella Paratyphi C',  o: d.co ?? '—', h: d.ch ?? '—' }
          ];
          let widalRows = '';
          for (let r of widalEntries) {
            const oFlag = parseInt(r.o) >= 160 ? ' ↑' : '';
            const hFlag = parseInt(r.h) >= 160 ? ' ↑' : '';
            const oDisplay = r.o !== '—' ? `1:${r.o}${oFlag}` : '—';
            const hDisplay = r.h !== '—' ? `1:${r.h}${hFlag}` : '—';
            widalRows += `<tr><td style="padding:6px 12px;">${r.organism}</td>
                             <td style="padding:6px 12px; ${oFlag ? 'font-weight:700;color:#dc2626;' : ''}">${oDisplay}</td>
                             <td style="padding:6px 12px; ${hFlag ? 'font-weight:700;color:#dc2626;' : ''}">${hDisplay}</td></tr>`;
          }
          rows += `<tr><td colspan="4"><table style="width:100%; border-collapse:collapse;"><thead><tr><th>Organism</th><th>O Antigen (TO)</th><th>H Antigen (TH)</th></tr></thead><tbody>${widalRows}</tbody></table></td></tr>`;
        } else if (testType === 'complex_culture' || testType === 'complex_stool_cs') {
          let organism = d.organism || 'Not specified';
          rows += `<tr style="background:#f0f7f4;"><td colspan="4" style="padding:8px 12px;"><strong>Organism:</strong> <span style="font-style:italic;">${esc(organism)}</span></td></tr>`;
          if (d.sensitivities && d.sensitivities.length) {
            rows += `<tr style="background:#e8f4f0;"><th style="padding:6px 12px;">Antibiotic</th><th style="padding:6px 12px;">Result</th><th style="padding:6px 12px;">Interpretation</th><th style="padding:6px 12px;"></th></tr>`;
            d.sensitivities.forEach(s => {
              const label  = s.result === 'S' ? 'Sensitive'     : s.result === 'R' ? 'Resistant'    : s.result === 'I' ? 'Intermediate' : s.result || '—';
              const colour = s.result === 'S' ? '#15803d'       : s.result === 'R' ? '#b91c1c'       : s.result === 'I' ? '#92400e'      : '#374151';
              const bg     = s.result === 'S' ? '#dcfce7'       : s.result === 'R' ? '#fee2e2'        : s.result === 'I' ? '#fef3c7'      : '#f3f4f6';
              rows += `<tr><td style="padding:6px 12px;">${esc(s.antibiotic)}</td><td style="padding:6px 12px; font-weight:700; color:${colour};">${esc(s.result)}</td><td style="padding:6px 12px;"><span style="display:inline-block; padding:2px 10px; border-radius:20px; background:${bg}; color:${colour}; font-size:0.78rem; font-weight:600;">${label}</span></td><td></td></tr>`;
            });
          } else {
            rows += `<tr><td colspan="4" style="padding:6px 12px; color:#6b7280;">No antibiotic sensitivities recorded.</td></tr>`;
          }
        } else if (testType === 'complex_urine_mcs' || testType === 'complex_stool_mcs') {
          const isMCS = testType === 'complex_urine_mcs';
          const MICRO_PARAMS = isMCS ? URINE_MICRO_PARAMS : STOOL_MICRO_PARAMS;
          const sections = isMCS ? ['Physical','Chemical','Microscopy'] : ['Macroscopy','Microscopy'];
          sections.forEach(sec => {
            rows += `<tr style="background:#dbeafe;"><td colspan="4" style="font-weight:700; padding:6px 12px; font-size:0.75rem; text-transform:uppercase; letter-spacing:1px;">${sec}</td></tr>`;
            MICRO_PARAMS.filter(p => p.section === sec).forEach(p => {
              let v = d[p.key]; if (v === undefined || v === '' || v === 'None seen' || v === 'Absent' || v === 'Negative') return;
              let flag = '';
              if (p.type === 'number' && p.low !== undefined) { let n = parseFloat(v); if (!isNaN(n)) { if (n > p.high) flag = '↑'; else if (n < p.low) flag = '↓'; } }
              rows += `<tr><td style="padding:5px 12px;">${esc(p.name)}</td><td style="padding:5px 12px;${flag?'font-weight:700;color:#dc2626;':''}">${esc(v)} ${flag}</td><td style="padding:5px 12px;">${esc(p.unit||'')}</td><td></td></tr>`;
            });
          });
          rows += `<tr style="background:#dbeafe;"><td colspan="4" style="font-weight:700; padding:6px 12px; font-size:0.75rem; text-transform:uppercase; letter-spacing:1px;">Culture &amp; Sensitivity</td></tr>`;
          rows += `<tr><td style="padding:6px 12px;">Organism</td><td colspan="3" style="padding:6px 12px; font-style:italic;">${esc(d.organism || 'No growth / Not specified')}</td></tr>`;
          if (d.sensitivities && d.sensitivities.length) {
            rows += `<tr style="background:#e8f4f0;"><th style="padding:6px 12px;">Antibiotic</th><th style="padding:6px 12px;">Result</th><th style="padding:6px 12px;">Interpretation</th><th></th></tr>`;
            d.sensitivities.forEach(s => {
              const label  = s.result==='S'?'Sensitive':s.result==='R'?'Resistant':s.result==='I'?'Intermediate':s.result||'—';
              const colour = s.result==='S'?'#15803d':s.result==='R'?'#b91c1c':s.result==='I'?'#92400e':'#374151';
              const bg     = s.result==='S'?'#dcfce7':s.result==='R'?'#fee2e2':s.result==='I'?'#fef3c7':'#f3f4f6';
              rows += `<tr><td style="padding:6px 12px;">${esc(s.antibiotic)}</td><td style="padding:6px 12px;font-weight:700;color:${colour};">${esc(s.result)}</td><td style="padding:6px 12px;"><span style="display:inline-block;padding:2px 10px;border-radius:20px;background:${bg};color:${colour};font-size:0.78rem;font-weight:600;">${label}</span></td><td></td></tr>`;
            });
          } else {
            rows += `<tr><td colspan="4" style="padding:6px 12px;color:#6b7280;">No antibiotic sensitivities recorded.</td></tr>`;
          }
        } else if (testType === 'complex_malaria') {
          if (d.species) rows += `<tr><td>Species</td><td colspan="3">${esc(d.species)}</td></tr>`;
          if (d.stage) rows += `<tr><td>Stage</td><td colspan="3">${esc(d.stage)}</td></tr>`;
          if (d.density !== undefined) rows += `<tr><td>Parasite Density</td><td colspan="3">${esc(d.density)} parasites/µL</td></tr>`;
        } else if (testType === 'complex_tb_genexpert') {
          if (d.mtb_detected) rows += `<tr><td>MTB Detected</td><td colspan="3">${esc(d.mtb_detected)}</td></tr>`;
          if (d.rif_resistance) rows += `<tr><td>Rifampicin Resistance</td><td colspan="3">${esc(d.rif_resistance)}</td></tr>`;
          for (let probe of ['probeA_ct','probeB_ct','probeC_ct','probeD_ct','probeE_ct']) {
            if (d[probe] !== undefined) rows += `<tr><td>${probe.replace('_ct',' Probe Ct')}</td><td colspan="3">${esc(d[probe])}</td></tr>`;
          }
        } else if (testType === 'complex_serology') {
          for (let p of SEROLOGY_PARAMS) {
            if (d[p.key] !== undefined) rows += `<tr><td>${esc(p.name)}</td><td colspan="3">${esc(d[p.key])}</td></tr>`;
          }
        } else if (testType === 'complex_semen') {
          SEMEN_PARAMS.forEach(p => {
            let v = d[p.key];
            if (v === undefined || v === '') return;
            let flag = getParamFlag(v, p);
            let ref = (p.low != null && p.high != null) ? `${p.low}–${p.high}` : '—';
            rows += `<tr><td style="padding:6px 12px;">${esc(p.name)}</td>
                         <td style="padding:6px 12px; ${flag ? 'font-weight:700;color:#dc2626;' : ''}">${esc(v)} ${flag}</td>
                         <td style="padding:6px 12px;">${esc(p.unit||'')}</td>
                         <td style="padding:6px 12px;">${ref}</td></tr>`;
          });
          rows += `<tr style="background:#dbeafe;"><td colspan="4" style="font-weight:700; padding:6px 12px; font-size:0.75rem; text-transform:uppercase; letter-spacing:1px;">Culture &amp; Sensitivity</td></tr>`;
          rows += `<tr><td style="padding:6px 12px;">Organism</td><td colspan="3" style="padding:6px 12px; font-style:italic;">${esc(d.organism || 'No growth / Not specified')}</td></tr>`;
          if (d.sensitivities && d.sensitivities.length) {
            rows += `<tr style="background:#e8f4f0;"><th style="padding:6px 12px;">Antibiotic</th><th style="padding:6px 12px;">Result</th><th style="padding:6px 12px;">Interpretation</th><th></th></tr>`;
            d.sensitivities.forEach(s => {
              const label  = s.result==='S'?'Sensitive':s.result==='R'?'Resistant':s.result==='I'?'Intermediate':s.result||'—';
              const colour = s.result==='S'?'#15803d':s.result==='R'?'#b91c1c':s.result==='I'?'#92400e':'#374151';
              const bg     = s.result==='S'?'#dcfce7':s.result==='R'?'#fee2e2':s.result==='I'?'#fef3c7':'#f3f4f6';
              rows += `<tr><td style="padding:6px 12px;">${esc(s.antibiotic)}</td><td style="padding:6px 12px;font-weight:700;color:${colour};">${esc(s.result)}</td><td style="padding:6px 12px;"><span style="display:inline-block;padding:2px 10px;border-radius:20px;background:${bg};color:${colour};font-size:0.78rem;font-weight:600;">${label}</span></td><td></td></tr>`;
            });
          } else {
            rows += `<tr><td colspan="4" style="padding:6px 12px;color:#6b7280;">No antibiotic sensitivities recorded.</td></tr>`;
          }
        } else {
          let params = paramsFor(testType);
          if (params.length) {
            params.forEach(p => {
              let v = d[p.key];
              if (v === undefined) return;
              let flag = getParamFlag(v, p);
              let ref = (p.low !== null && p.high !== null) ? `${p.low}–${p.high}` : (p.low !== null ? `≥${p.low}` : p.high !== null ? `≤${p.high}` : '—');
              rows += `<tr><td style="padding:6px 12px;">${esc(p.name)}</td>
                           <td style="padding:6px 12px; ${flag ? 'font-weight:700;color:#dc2626;' : ''}">${v} ${flag}</td>
                           <td style="padding:6px 12px;">${esc(p.unit)}</td>
                           <td style="padding:6px 12px;">${ref}</td></tr>`;
            });
          } else {
            rows += `<tr><td colspan="4">${esc(JSON.stringify(d))}</td></tr>`;
          }
        }
      } catch(e) { rows += `<tr><td colspan="4">${esc(t.result)}</td></tr>`; }
    } else {
      rows += `<tr><td colspan="4">${esc(t.result || '—')}</td></tr>`;
    }
  });
  return `<table style="width:100%; border-collapse:collapse; font-size:0.85rem;"><thead><tr><th>Parameter</th><th>Result</th><th>Unit</th><th>Reference</th></tr></thead><tbody>${rows}</tbody></table>`;
}

// ========== RENDER ALL SAMPLES (unchanged, kept from your previous version) ==========
async function renderAllSamples() {
  await loadSamples();
  let search = document.getElementById('allSearch')?.value.toLowerCase() || '';
  let status = document.getElementById('allStatusFilter')?.value || 'all';
  let payment = document.getElementById('allPayFilter')?.value || 'all';
  let filtered = samples.filter(s => {
    if (status !== 'all' && s.status !== status) return false;
    if (payment !== 'all' && s.paystatus !== payment) return false;
    if (search && !s.id.toString().includes(search) && !s.patient.toLowerCase().includes(search) && !(s.offline_ref || '').toLowerCase().includes(search) && !(s.receipt_no || '').toLowerCase().includes(search)) return false;
    return true;
  });
  let tbody = document.getElementById('allSamplesTable');
  if (!tbody) return;
  if (!filtered.length) { tbody.innerHTML = '<tr><td colspan="10" style="text-align:center;padding:30px;">No samples found.</td></tr>'; return; }
  let today = new Date().toISOString().slice(0,10);
  tbody.innerHTML = filtered.map(s => {
    let isOverdue = s.due && s.due < today && s.status !== 'Result Released' && s.status !== 'Rejected';
    let priCls = s.priority === 'STAT' ? 'badge-stat' : s.priority === 'Urgent' ? 'badge-urgent' : 'badge-routine';
    return `<tr>
      <td style="font-family:monospace;">MU-${s.id}${s.offline_ref ? `<br><span style="font-size:0.6rem;background:#fff9ec;border:1px solid #fde68a;color:#92400e;padding:1px 5px;border-radius:5px;font-family:monospace;">${esc(s.offline_ref)}</span>` : ''}</td>
      <td><strong>${esc(s.patient)}</strong><br><small>${s.age ?? '?'}y ${esc(s.gender)}</small></td>
      <td><small>${s.tests.map(t => esc(t.test_name)).join('<br>')}</small></td>
      <td><small>${esc(s.stype || '')}</small></td>
      <td>${esc(s.collDate || '')}</td>
      <td><small ${isOverdue ? 'style="color:var(--red-light);font-weight:700;"' : ''}>${s.due || '—'}${isOverdue ? ' ⚠' : ''}</small></td>
      <td><span class="badge ${priCls}">${esc(s.priority)}</span></td>
      <td><span class="badge">${esc(s.status)}</span></td>
      <td>${payBadge(s.paystatus)}</td>
      <td style="white-space:nowrap;">
        <button class="btn btn-secondary btn-sm" onclick="togglePayment(${s.id})"><i class="fas fa-dollar-sign"></i></button>
        ${s.status === 'Result Released' ? `<button class="btn btn-secondary btn-sm" onclick="generatePDF(${s.id})"><i class="fas fa-file-pdf"></i></button>` : ''}
        <button class="btn btn-danger btn-sm" onclick="deleteSample(${s.id})"><i class="fas fa-trash"></i></button>
      </td>
    </tr>`;
  }).join('');
}
async function togglePayment(id) {
  let s = samples.find(x => x.id === id);
  if (!s) return;
  if (s.paystatus === 'Paid') {
    s.paystatus = 'Unpaid'; s.amountPaid = 0; s.balanceDue = s.totalAmount || 0;
  } else {
    s.paystatus = 'Paid'; s.amountPaid = s.totalAmount || 0; s.balanceDue = 0;
  }
  await saveSample(s);
  await addAudit('Payment toggled', id, `New status: ${s.paystatus}`);
  await renderAllSamples();
  toast(`Payment: ${s.paystatus}`);
}
async function deleteSample(id) {
  if (!confirm(`Permanently delete sample MU-${id}?`)) return;
  await deleteSampleFromServer(id);
  await addAudit('Deleted', id, 'Sample removed');
  await Promise.all([renderAllSamples(), renderDashboard(), renderVerifyTable()]);
  toast('Sample deleted', 'warn');
}
function exportAllSamples() {
  let headers = ['ID','Patient','Age','Gender','Phone','Clinician','Tests','Sample Type','Collection Date','Due Date','Priority','Status','Payment Status','Total NGN','Paid NGN','Balance NGN'];
  let rows = samples.map(s => [`MU-${s.id}`, s.patient, s.age || '', s.gender, s.phone || '', s.clinician || '', s.tests.map(t => t.test_name).join('; '), s.stype, s.collDate, s.due || '', s.priority, s.status, s.paystatus, (s.totalAmount||0).toFixed(2), (s.amountPaid||0).toFixed(2), (s.balanceDue||0).toFixed(2)]);
  let csv = [headers, ...rows].map(r => r.map(c => `"${String(c ?? '').replace(/"/g,'""')}"`).join(',')).join('\n');
  let blob = new Blob([csv], { type:'text/csv' });
  let a = document.createElement('a'); a.href = URL.createObjectURL(blob);
  a.download = `muujiza_samples_${new Date().toISOString().slice(0,10)}.csv`; a.click();
  toast('CSV exported');
}
async function renderDashboard() {
  await loadSamples();
  let byStatus = s => samples.filter(x => x.status === s).length;
  let overdue = samples.filter(s => s.status !== 'Result Released' && s.status !== 'Rejected' && s.due && s.due < new Date().toISOString().slice(0,10)).length;
  document.getElementById('statsRow').innerHTML = `
    <div class="stat-card"><div><div class="stat-label">Total</div><div class="stat-val">${samples.length}</div></div><i class="fas fa-flask fa-2x"></i></div>
    <div class="stat-card"><div><div class="stat-label">Collected</div><div class="stat-val">${byStatus('Collected')}</div></div><i class="fas fa-clipboard-list fa-2x"></i></div>
    <div class="stat-card"><div><div class="stat-label">Processing</div><div class="stat-val">${byStatus('Processing')}</div></div><i class="fas fa-microscope fa-2x"></i></div>
    <div class="stat-card"><div><div class="stat-label">Verifying</div><div class="stat-val">${byStatus('Verifying')}</div></div><i class="fas fa-check-double fa-2x"></i></div>
    <div class="stat-card"><div><div class="stat-label">Released</div><div class="stat-val">${byStatus('Result Released')}</div></div><i class="fas fa-file-alt fa-2x"></i></div>
    <div class="stat-card" style="${overdue > 0 ? 'border-color:#f87171;' : ''}"><div><div class="stat-label">Overdue</div><div class="stat-val" style="${overdue > 0 ? 'color:var(--red-light);' : ''}">${overdue}</div></div><i class="fas fa-clock fa-2x"></i></div>`;
  let overdueSamples = samples.filter(s => s.status !== 'Result Released' && s.status !== 'Rejected' && s.due && s.due < new Date().toISOString().slice(0,10));
  document.getElementById('criticalList').innerHTML = '<p>No critical flags at this time.</p>';
  document.getElementById('overdueList').innerHTML = overdueSamples.length ? overdueSamples.map(s => `<div><strong>MU-${s.id}</strong> ${esc(s.patient)} — Due: ${s.due}</div>`).join('') : '<p>No overdue samples.</p>';
}
async function renderVerifyTable() {
  await loadSamples();
  let search = document.getElementById('verifySearch')?.value.toLowerCase() || '';
  let statusFilter = document.getElementById('verifyStatusFilter')?.value || 'all';
  let filtered = samples.filter(s => {
    if (statusFilter === 'all') return s.status === 'Verifying' || s.status === 'Result Released';
    return s.status === statusFilter;
  });
  if (search) filtered = filtered.filter(s => s.id.toString().includes(search) || s.patient.toLowerCase().includes(search) || (s.offline_ref || '').toLowerCase().includes(search) || (s.receipt_no || '').toLowerCase().includes(search));
  let tbody = document.getElementById('verifyTable');
  if (!tbody) return;
  if (!filtered.length) { tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:30px;">No samples found.</td></tr>'; return; }
  tbody.innerHTML = filtered.map(s => {
    const isReleased = s.status === 'Result Released';
    const statusBadge = isReleased
      ? '<span class="badge badge-paid"><i class="fas fa-check-circle"></i> Released</span>'
      : '<span class="badge badge-partial">Verifying</span>';
    const releasedAt = isReleased && s.releasedAt ? new Date(s.releasedAt).toLocaleString() : (isReleased ? '—' : '');
    const actions = `<button class="btn btn-primary btn-sm" onclick="openVerifyModal(${s.id})"><i class="fas fa-eye"></i> Review</button>`;
    return `<tr style="${isReleased ? 'opacity:0.85;background:#f8fff9;' : ''}">
      <td style="font-family:monospace;">MU-${s.id}${s.offline_ref ? `<br><span style="font-size:0.6rem;background:#fff9ec;border:1px solid #fde68a;color:#92400e;padding:1px 5px;border-radius:5px;font-family:monospace;">${esc(s.offline_ref)}</span>` : ''}</td>
      <td><strong>${esc(s.patient)}</strong><br><small>${s.age ?? '?'}y ${esc(s.gender)}</small></td>
      <td><small>${s.tests.map(t => esc(t.test_name)).join('<br>')}</small></td>
      <td><small>${s.tests.map(t => {
        const who = t.tech_name || t.done_by || '—';
        return `<span style="display:block;">${esc(t.test_name)}: <strong>${esc(who)}</strong></span>`;
      }).join('')}</small></td>
      <td>${statusBadge}</td>
      <td><small>${releasedAt}</small></td>
      <td>${actions}</td>
    </tr>`;
  }).join('');
}
async function openVerifyModal(id) {
  currentVerifySample = samples.find(s => s.id === id);
  if (!currentVerifySample) return;

  const s = currentVerifySample;
  const actionableTests = s.tests.filter(t => t.status !== 'Rejected');
  const rejectedTests   = s.tests.filter(t => t.status === 'Rejected');

  let flags = [];
  actionableTests.forEach(t => {
    let testType = getTestType(t.test_name);
    if (!t.result || !t.result.startsWith('{')) return;
    try {
      let d = JSON.parse(t.result);
      let params = paramsFor(testType);
      params.forEach(p => {
        let v = d[p.key];
        if (v !== undefined) {
          if (p.high && parseFloat(v) > p.high) flags.push(`${p.name} ↑ (${v})`);
          if (p.low  && parseFloat(v) < p.low)  flags.push(`${p.name} ↓ (${v})`);
        }
      });
    } catch(e) {}
  });

  // ── Payment status panel ─────────────────────────────────────────────────
  const total    = parseFloat(s.totalAmount  || 0);
  const paid     = parseFloat(s.amountPaid   || 0);
  const balance  = parseFloat(s.balanceDue   || 0);
  const paymode  = s.paymode     || '—';
  const receipt  = s.receiptNo   || '—';
  const paydate  = s.paymentDate ? new Date(s.paymentDate).toLocaleDateString() : '—';
  const insurance = s.insurance  || null;

  const isPaid    = s.paystatus === 'Paid';
  const isPartial = s.paystatus === 'Partial';
  const isUnpaid  = !isPaid && !isPartial;

  const panelBg     = isPaid ? '#f0fdf4' : isPartial ? '#fffbeb' : '#fef2f2';
  const panelBorder = isPaid ? '#86efac' : isPartial ? '#fde68a' : '#fca5a5';
  const iconColour  = isPaid ? '#15803d' : isPartial ? '#b45309' : '#b91c1c';
  const payIcon     = isPaid ? 'fa-check-circle' : isPartial ? 'fa-exclamation-circle' : 'fa-times-circle';
  const payLabel    = isPaid ? 'FULLY PAID' : isPartial ? 'PARTIAL PAYMENT' : 'UNPAID';

  const overrideBlock = (isPartial || isUnpaid) ? `
    <div style="margin-top:10px; padding:8px 12px; background:#fff7ed; border:1px solid #fde68a; border-radius:10px; font-size:0.8rem; color:#92400e;">
      <i class="fas fa-lock"></i> <strong>Release blocked</strong> — payment not fully settled.
      Tick the override box below and provide a reason. Balance will remain outstanding until cleared from Accession Settlement.
    </div>
    <div style="margin-top:8px; display:flex; align-items:flex-start; gap:8px;">
      <input type="checkbox" id="payOverrideChk" style="margin-top:3px; width:16px; height:16px; cursor:pointer;"
        onchange="document.getElementById('payOverrideReason').style.display=this.checked?'block':'none';
                  document.querySelector('.release-btn').disabled=!this.checked;">
      <label for="payOverrideChk" style="font-size:0.82rem; color:#92400e; cursor:pointer; font-weight:600;">
        Override — release result before payment clearance (balance remains outstanding)
      </label>
    </div>
    <textarea id="payOverrideReason" rows="2" class="form-input"
      placeholder="Required: state reason for overriding payment gate…"
      style="display:none; width:100%; margin-top:6px; border-color:#f97316; font-size:0.82rem;"></textarea>` : '';

  const paymentPanel = `
    <div style="background:${panelBg}; border:2px solid ${panelBorder}; border-radius:14px; padding:14px 16px; margin-bottom:16px;">
      <div style="display:flex; align-items:center; gap:10px; margin-bottom:10px;">
        <i class="fas ${payIcon}" style="color:${iconColour}; font-size:1.15rem;"></i>
        <span style="font-weight:700; color:${iconColour}; font-size:0.92rem; letter-spacing:0.4px;">${payLabel}</span>
        <span style="margin-left:auto; font-size:0.76rem; color:#6b7280;">
          Mode: <strong>${esc(paymode)}</strong>${insurance ? ` &nbsp;|&nbsp; Insurance: <strong>${esc(insurance)}</strong>` : ''}
        </span>
      </div>
      <div style="display:grid; grid-template-columns:repeat(3,1fr); gap:10px; margin-bottom:10px;">
        <div style="background:#fff; border-radius:10px; padding:8px 12px; text-align:center; border:1px solid ${panelBorder};">
          <div style="font-size:0.68rem; color:#6b7280; text-transform:uppercase; letter-spacing:0.5px;">Total Bill</div>
          <div style="font-weight:700; font-size:0.95rem; color:#1f2937;">₦${total.toLocaleString(undefined,{minimumFractionDigits:2})}</div>
        </div>
        <div style="background:#fff; border-radius:10px; padding:8px 12px; text-align:center; border:1px solid #86efac;">
          <div style="font-size:0.68rem; color:#6b7280; text-transform:uppercase; letter-spacing:0.5px;">Amount Paid</div>
          <div style="font-weight:700; font-size:0.95rem; color:#15803d;">₦${paid.toLocaleString(undefined,{minimumFractionDigits:2})}</div>
        </div>
        <div style="background:#fff; border-radius:10px; padding:8px 12px; text-align:center; border:1px solid ${balance > 0 ? '#fca5a5' : '#86efac'};">
          <div style="font-size:0.68rem; color:#6b7280; text-transform:uppercase; letter-spacing:0.5px;">Balance Due</div>
          <div style="font-weight:700; font-size:0.95rem; color:${balance > 0 ? '#b91c1c' : '#15803d'};">₦${balance.toLocaleString(undefined,{minimumFractionDigits:2})}</div>
        </div>
      </div>
      <div style="font-size:0.74rem; color:#6b7280; display:flex; gap:16px; flex-wrap:wrap;">
        <span><i class="fas fa-receipt"></i> Receipt: <strong>${esc(receipt)}</strong></span>
        <span><i class="fas fa-calendar-check"></i> Payment Date: <strong>${esc(paydate)}</strong></span>
      </div>
      ${overrideBlock}
    </div>`;

  // ── Rejected tests banner ────────────────────────────────────────────────
  const rejectedBanner = rejectedTests.length ? `
    <div style="background:#fff0f0; border:1.5px solid #fca5a5; border-radius:12px; padding:12px 16px; margin-bottom:14px;">
      <div style="font-weight:700; color:#b91c1c; margin-bottom:8px;"><i class="fas fa-ban"></i> ${rejectedTests.length} Test(s) Rejected — Patient Must Return</div>
      ${rejectedTests.map(t => `
        <div style="display:flex; align-items:center; gap:10px; padding:6px 0; border-top:1px solid #fde8e8;">
          <span style="font-weight:600; font-size:0.85rem;">${esc(t.test_name)}</span>
          <span style="font-size:0.78rem; color:#b91c1c; background:#fff; border:1px solid #fca5a5; border-radius:20px; padding:2px 10px;">${esc(t.rejection_reason || 'No reason recorded')}</span>
        </div>`).join('')}
      <div style="font-size:0.75rem; color:#92400e; margin-top:8px; background:#fff7ed; border-radius:8px; padding:6px 10px;">
        <i class="fas fa-info-circle"></i> You can still authorise and release the available results. The printed report will note the rejected tests.
      </div>
    </div>` : '';

  let html = `
    <div style="background:#f0f7f4; border-radius:16px; padding:14px; margin-bottom:12px;">
      <div style="display:flex; flex-wrap:wrap; gap:10px; align-items:center;">
        <div>
          <span style="font-family:monospace; font-weight:700; font-size:1rem;">MU-${s.id}</span>
          <span style="margin:0 8px; color:#9ca3af;">|</span>
          <strong>${esc(s.patient)}</strong>
          <span style="margin:0 6px; color:#9ca3af;">·</span>
          <small>${s.age ?? '?'}y ${esc(s.gender)}</small>
        </div>
        <div style="margin-left:auto; font-size:0.78rem; color:#374151; display:flex; gap:12px; flex-wrap:wrap;">
          <span><i class="fas fa-user-md"></i> ${esc(s.clinician || '—')}</span>
          <span><i class="fas fa-calendar"></i> ${esc(s.collDate || '—')}</span>
          <span><i class="fas fa-vial"></i> ${esc(s.stype || '—')}</span>
        </div>
      </div>
    </div>
    ${paymentPanel}
    ${rejectedBanner}
    ${flags.length
      ? `<div class="interp-abnormal"><strong>⚠ Abnormal:</strong> ${flags.join(' · ')}</div>`
      : '<div style="background:#dcfce7;color:#15803d;border-radius:12px;padding:8px 14px;margin-bottom:16px;">✓ All available values within range</div>'}
    <div style="border:1px solid var(--border); border-radius:16px; overflow-x:auto; margin-bottom:16px; padding:8px;">${buildReportPreview(s)}</div>
    <div class="form-group"><label class="form-label">Supervisor Comment</label><textarea id="supervisorComment" rows="2" class="form-input" style="width:100%;"></textarea></div>`;

  document.getElementById('verifyModalTitle').innerHTML = `Review — MU-${s.id} | ${esc(s.patient)}`;
  document.getElementById('verifyModalBody').innerHTML = html;

  // Disable release button immediately for unsettled payments
  const releaseBtn = document.querySelector('.release-btn');
  if (releaseBtn) releaseBtn.disabled = (isPartial || isUnpaid);

  document.getElementById('verifyModal').style.display = 'flex';
}
async function returnToTech() {
  if (!currentVerifySample) { toast('No sample selected', 'error'); return; }
  const s = currentVerifySample;
  const comment = document.getElementById('supervisorComment')?.value || '';
  s.status = 'Processing';
  if (s.tests) s.tests.forEach(t => { t.status = 'Processing'; t.done_by = null; t.done_at = null; });
  await saveSample(s);
  await addAudit('Returned to Tech', s.id, comment);
  closeVerifyModal();
  await Promise.all([renderVerifyTable(), renderAllSamples()]);
  toast(`MU-${s.id} returned to technologist`);
}
async function releaseResults() {
  if (!currentVerifySample) { toast('No sample selected', 'error'); return; }
  const s = currentVerifySample;

  // ── Payment gate ─────────────────────────────────────────────────────────
  const needsPayment = s.paystatus === 'Partial' || s.paystatus === 'Unpaid' || !s.paystatus;
  if (needsPayment) {
    const overrideChk    = document.getElementById('payOverrideChk');
    const overrideReason = document.getElementById('payOverrideReason');
    if (!overrideChk?.checked) {
      toast('Release blocked — payment not settled. Tick override to proceed.', 'error'); return;
    }
    const reason = overrideReason?.value?.trim();
    if (!reason) {
      toast('Enter a reason for the payment override before releasing.', 'error');
      overrideReason?.focus(); return;
    }
    // Balance is intentionally NOT cleared — must be resolved in Accession Settlement
    s._payOverrideReason = reason;
  }

  s.status    = 'Result Released';
  s.releasedAt = new Date().toISOString();
  s.supervisorComment = document.getElementById('supervisorComment')?.value || '';

  try {
    for (const t of s.tests) {
      if (t.status === 'Rejected') continue;
      await db.from('sample_tests').update({ status: 'Released' }).eq('id', t.id);
    }
  } catch(e) { console.warn('[M1] Failed to update test statuses on release', e); }

  const rejectedCount = s.tests.filter(t => t.status === 'Rejected').length;
  const overrideNote  = s._payOverrideReason
    ? ` | PAYMENT OVERRIDE: ${s._payOverrideReason} (balance ₦${parseFloat(s.balanceDue||0).toFixed(2)} still outstanding)`
    : '';
  const releaseNote = `Authorised by ${currentUser?.name}.${rejectedCount ? ` ${rejectedCount} test(s) still rejected.` : ''} ${s.supervisorComment}${overrideNote}`;

  await saveSample(s);
  await addAudit('Released', s.id, releaseNote);
  if (s._payOverrideReason) {
    await addAudit('Payment Override on Release', s.id,
      `Override by ${currentUser?.name}: ${s._payOverrideReason} — balance ₦${parseFloat(s.balanceDue||0).toFixed(2)} remains outstanding`);
  }
  closeVerifyModal();
  await Promise.all([renderVerifyTable(), renderAllSamples(), renderDashboard()]);
  toast(`MU-${s.id} released ✓${rejectedCount ? ` (${rejectedCount} test(s) pending recollection)` : ''}${s._payOverrideReason ? ' — balance still outstanding' : ''}`);

  if (typeof window._analyticsInvalidateCache === 'function') {
    window._analyticsInvalidateCache();
  }
}
function closeVerifyModal() { document.getElementById('verifyModal').style.display = 'none'; currentVerifySample = null; }
async function renderAudit() {
  let { data, error } = await db.from('audit_log').select('ts,user_name,user_role,action,sample_id,details').order('ts', { ascending: false }).limit(500);
  if (error) return;
  document.getElementById('auditTableBody').innerHTML = data.map(e => `<tr>
    <td>${new Date(e.ts).toLocaleString()}</td>
    <td>${esc(e.user_name)} (${esc(e.user_role)})</td>
    <td><strong>${esc(e.action)}</strong></td>
    <td>${e.sample_id ? `MU-${e.sample_id}` : '—'}</td>
    <td><small>${esc(e.details || '')}</small></td>
  </tr>`).join('');
}
async function renderFinanceReport() {
  await loadSamples();
  let start = document.getElementById('financeStart')?.value;
  let end   = document.getElementById('financeEnd')?.value;
  let filtered = samples.filter(s =>
    (!start || (s.collDate || '') >= start) &&
    (!end   || (s.collDate || '') <= end)
  );

  // ── Aggregate into daily buckets ─────────────────────────────────────────
  let daily = {};
  filtered.forEach(s => {
    let d = s.collDate || 'Unknown';
    if (!daily[d]) daily[d] = { total:0, paid:0, balance:0, count:0, unpaid:0, partial:0 };
    daily[d].total   += parseFloat(s.totalAmount || 0);
    daily[d].paid    += parseFloat(s.amountPaid  || 0);
    daily[d].balance += parseFloat(s.balanceDue  || 0);
    daily[d].count++;
    if (s.paystatus === 'Unpaid')  daily[d].unpaid++;
    if (s.paystatus === 'Partial') daily[d].partial++;
  });

  let totalRevenue = 0, totalPaid = 0, totalBalance = 0, rows = '';
  for (let [date, data] of Object.entries(daily).sort((a,b) => b[0].localeCompare(a[0]))) {
    const balColour  = data.balance  > 0 ? 'color:#b91c1c; font-weight:700;' : 'color:#15803d;';
    const paidColour = 'color:#15803d; font-weight:600;';
    const unpaidHint = (data.unpaid + data.partial) > 0
      ? `<small style="color:#b91c1c; font-size:0.72rem; display:block;">${data.unpaid} unpaid · ${data.partial} partial</small>` : '';
    rows += `<tr>
      <td>${esc(date)}</td>
      <td>₦${data.total.toLocaleString(undefined,{minimumFractionDigits:2})}</td>
      <td style="${paidColour}">₦${data.paid.toLocaleString(undefined,{minimumFractionDigits:2})}</td>
      <td style="${balColour}">₦${data.balance.toLocaleString(undefined,{minimumFractionDigits:2})}${unpaidHint}</td>
      <td>${data.count}</td>
    </tr>`;
    totalRevenue += data.total; totalPaid += data.paid; totalBalance += data.balance;
  }
  if (!rows) rows = '<tr><td colspan="5" style="text-align:center;padding:24px;color:var(--text2);">No records found.</td></tr>';
  rows += `<tr style="font-weight:700; background:#f0f7f4;">
    <td>TOTAL</td>
    <td>₦${totalRevenue.toLocaleString(undefined,{minimumFractionDigits:2})}</td>
    <td style="color:#15803d;">₦${totalPaid.toLocaleString(undefined,{minimumFractionDigits:2})}</td>
    <td style="${totalBalance > 0 ? 'color:#b91c1c;' : 'color:#15803d;'}">₦${totalBalance.toLocaleString(undefined,{minimumFractionDigits:2})}</td>
    <td>${filtered.length}</td>
  </tr>`;
  document.getElementById('financeTable').innerHTML = rows;

  // ── Stats cards ──────────────────────────────────────────────────────────
  const unpaidCount  = filtered.filter(s => s.paystatus === 'Unpaid').length;
  const partialCount = filtered.filter(s => s.paystatus === 'Partial').length;
  document.getElementById('financeStats').innerHTML = `
    <div class="stat-card">
      <div><div class="stat-label">Total Revenue</div><div class="stat-val">₦${totalRevenue.toLocaleString(undefined,{minimumFractionDigits:2})}</div></div>
      <i class="fas fa-chart-line fa-2x"></i>
    </div>
    <div class="stat-card">
      <div><div class="stat-label">Collected (Paid)</div><div class="stat-val" style="color:var(--green);">₦${totalPaid.toLocaleString(undefined,{minimumFractionDigits:2})}</div></div>
      <i class="fas fa-check-circle fa-2x" style="color:var(--green);"></i>
    </div>
    <div class="stat-card" style="${totalBalance > 0 ? 'border-color:#f87171;' : ''}">
      <div><div class="stat-label">Outstanding Balance</div><div class="stat-val" style="${totalBalance > 0 ? 'color:#b91c1c;' : ''}">₦${totalBalance.toLocaleString(undefined,{minimumFractionDigits:2})}</div></div>
      <i class="fas fa-exclamation-circle fa-2x" style="${totalBalance > 0 ? 'color:#b91c1c;' : ''}"></i>
    </div>
    <div class="stat-card" style="${unpaidCount > 0 ? 'border-color:#f87171;' : ''}">
      <div><div class="stat-label">Unpaid Samples</div><div class="stat-val" style="${unpaidCount > 0 ? 'color:#b91c1c;' : ''}">${unpaidCount}</div></div>
      <i class="fas fa-times-circle fa-2x" style="${unpaidCount > 0 ? 'color:#b91c1c;' : ''}"></i>
    </div>
    <div class="stat-card" style="${partialCount > 0 ? 'border-color:#fde68a;' : ''}">
      <div><div class="stat-label">Partial Payments</div><div class="stat-val" style="${partialCount > 0 ? 'color:#b45309;' : ''}">${partialCount}</div></div>
      <i class="fas fa-adjust fa-2x" style="${partialCount > 0 ? 'color:#b45309;' : ''}"></i>
    </div>`;
}
function resetFinanceFilter() {
  document.getElementById('financeStart').value = '';
  document.getElementById('financeEnd').value   = '';
  renderFinanceReport();
}
function exportFinanceCSV() {
  let headers = ['Date','Sample ID','Patient','Age','Gender','Tests','Total (NGN)','Paid (NGN)','Balance (NGN)','Payment Status','Pay Mode','Receipt No','Sample Status'];
  let rows = samples.map(s => [
    s.collDate || '', `MU-${s.id}`, s.patient, s.age || '', s.gender,
    s.tests.map(t => t.test_name).join('; '),
    (s.totalAmount||0).toFixed(2), (s.amountPaid||0).toFixed(2), (s.balanceDue||0).toFixed(2),
    s.paystatus || 'Unpaid', s.paymode || '', s.receiptNo || '', s.status
  ]);
  let csv = [headers, ...rows].map(r => r.map(c => `"${String(c??'').replace(/"/g,'""')}"`).join(',')).join('\n');
  let a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv]));
  a.download = `finance_${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
  toast('CSV exported');
}
async function generatePDF(id) {
  let s = samples.find(x => x.id === id);
  if (!s) return;
  let wrap = document.createElement('div');
  wrap.style.cssText = 'position:fixed; left:-9999px; top:0; width:800px; background:white; padding:30px; font-family:Arial; font-size:12px;';
  let rows = '';
  const rejectedTests = s.tests.filter(t => t.status === 'Rejected');

  for (let t of s.tests) {
    if (t.status === 'Rejected') {
      // Show rejected tests as a clearly marked row — no result
      rows += `<tr style="background:#fff0f0;">
        <td colspan="4" style="padding:8px; color:#b91c1c; font-weight:bold;">
          ✗ ${t.test_name} — SAMPLE REJECTED: ${t.rejection_reason || 'No reason recorded'} · Patient to return for recollection
        </td>
      </tr>`;
      continue;
    }
    let testType = getTestType(t.test_name);
    if (t.result && t.result.startsWith('{') && testType) {
      try {
        let data = JSON.parse(t.result);
        rows += generatePDFRows(t.test_name, data, testType, s.age, s.gender);
      } catch(e) { rows += `<tr><td colspan="4">${esc(t.test_name)}: ${esc(t.result)}</td></tr>`; }
    } else {
      rows += `<tr><td colspan="4">${esc(t.test_name)}: ${esc(t.result || '—')}</td></tr>`;
    }
  }

  const rejectedNote = rejectedTests.length
    ? `<p style="background:#fff7ed; border:1px solid #fed7aa; border-radius:6px; padding:8px 12px; color:#92400e; font-size:11px; margin-top:12px;">
        <strong>⚠ Note:</strong> ${rejectedTests.map(t => `${t.test_name} (${t.rejection_reason || 'rejected'})`).join(', ')} — patient is required to return to the laboratory for recollection of the affected sample(s).
       </p>` : '';

  wrap.innerHTML = `<div style="text-align:center; margin-bottom:20px; border-bottom:2px solid #1F6E43; padding-bottom:16px;">
      <h1 style="color:#1F6E43;">MU'UJIZA DIAGNOSTICS</h1>
      <p style="font-size:11px;">Accredited Laboratory · ISO 15189</p>
    </div>
    <div style="margin-bottom:16px;">
      <p><strong>Sample ID:</strong> MU-${s.id}</p>
      <p><strong>Patient:</strong> ${esc(s.patient)} (${s.age ?? '?'}y, ${esc(s.gender)})</p>
      <p><strong>Collected:</strong> ${s.collection_date} | <strong>Released:</strong> ${s.released_at ? new Date(s.released_at).toLocaleString() : '—'}</p>
      <p><strong>Payment:</strong> ${s.pay_status} | Paid: ${(s.amount_paid || 0).toFixed(2)} NGN | Balance: ${(s.balance_due || 0).toFixed(2)} NGN</p>
      ${s.supervisor_comment ? `<p><strong>Supervisor Note:</strong> ${esc(s.supervisor_comment)}</p>` : ''}
    </div>
    <table border="1" style="border-collapse:collapse; width:100%;">
      <thead><tr><th>Parameter</th><th>Result</th><th>Unit</th><th>Reference</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    ${rejectedNote}
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
  if (testType === 'complex_pcv' || testType === 'complex_hb' || testType === 'complex_esr' ||
      testType === 'complex_rbs' || testType === 'complex_fbs') {
    let key = testType.split('_')[1];
    let val = data[key];
    if (val === undefined) return '';
    let range = getReferenceRange(testName, age, gender);
    if (!range) range = { low: 0, high: 100, unit: '' };
    let flag = '';
    let num = parseFloat(val);
    if (!isNaN(num)) {
      if (num > range.high) flag = '↑';
      else if (num < range.low) flag = '↓';
    }
    return `<tr style="background:#f0f0f0;"><td colspan="4" style="font-weight:bold;">${esc(testName)}</td></tr>
            <tr><td style="padding:5px;">Value</td><td>${val} ${flag}</td><td>${esc(range.unit)}</td><td>${range.low}–${range.high}</td></tr>`;
  }
if (testType === 'complex_widal') {
  const rows = [
    { organism: 'Salmonella Typhi',        o: data.o ?? '—', h: data.h ?? '—' },
    { organism: 'Salmonella Paratyphi A',  o: data.ao ?? '—', h: data.ah ?? '—' },
    { organism: 'Salmonella Paratyphi B',  o: data.bo ?? '—', h: data.bh ?? '—' },
    { organism: 'Salmonella Paratyphi C',  o: data.co ?? '—', h: data.ch ?? '—' }
  ];
  let tableRows = '';
  for (let r of rows) {
    const oFlag = parseInt(r.o) >= 160 ? ' ↑' : '';
    const hFlag = parseInt(r.h) >= 160 ? ' ↑' : '';
    const oDisplay = r.o !== '—' ? `1:${r.o}${oFlag}` : '—';
    const hDisplay = r.h !== '—' ? `1:${r.h}${hFlag}` : '—';
    tableRows += `<tr><td style="padding:5px;">${r.organism}</td><td style="padding:5px;${oFlag?'font-weight:bold;':''}">${oDisplay}</td><td style="padding:5px;${hFlag?'font-weight:bold;':''}">${hDisplay}</td></tr>`;
  }
  return `<tr style="background:#f0f0f0;"><td colspan="4" style="font-weight:bold;">${esc(testName)}</td></tr>
          <tr><td colspan="4"><table style="width:100%; border-collapse:collapse;"><thead><tr><th>Organism</th><th>O Antigen</th><th>H Antigen</th></tr></thead><tbody>${tableRows}</tbody></table></td></tr>`;
}
  if (testType === 'complex_culture' || testType === 'complex_stool_cs') {
    let organism = data.organism || 'Not specified';
    let html = `<tr style="background:#e8f4f0;"><td colspan="4" style="font-weight:bold; padding:7px;">${esc(testName)}</td></tr>`;
    html += `<tr><td colspan="4" style="padding:6px;"><strong>Organism:</strong> <em>${esc(organism)}</em></td></tr>`;
    if (data.sensitivities && data.sensitivities.length) {
      html += `<tr style="background:#f0f0f0;"><th style="padding:6px;">Antibiotic</th><th style="padding:6px;">Result</th><th style="padding:6px;">Interpretation</th><th style="padding:6px;"></th></tr>`;
      data.sensitivities.forEach(s => {
        const label  = s.result === 'S' ? 'Sensitive' : s.result === 'R' ? 'Resistant' : s.result === 'I' ? 'Intermediate' : s.result || '—';
        const colour = s.result === 'S' ? '#15803d'   : s.result === 'R' ? '#b91c1c'   : s.result === 'I' ? '#92400e'      : '#374151';
        html += `<tr><td style="padding:5px;">${esc(s.antibiotic)}</td><td style="padding:5px; font-weight:bold; color:${colour};">${esc(s.result)}</td><td style="padding:5px; color:${colour};">${label}</td><td></td></tr>`;
      });
    } else {
      html += `<tr><td colspan="4" style="padding:5px; color:#6b7280;">No antibiotic sensitivities recorded.</td></tr>`;
    }
    return html;
  }
  if (testType === 'complex_urine_mcs' || testType === 'complex_stool_mcs') {
    const isMCS = testType === 'complex_urine_mcs';
    const MICRO_PARAMS = isMCS ? URINE_MICRO_PARAMS : STOOL_MICRO_PARAMS;
    const sections = isMCS ? ['Physical','Chemical','Microscopy'] : ['Macroscopy','Microscopy'];
    let html = `<tr style="background:#dbeafe;"><td colspan="4" style="font-weight:bold; padding:8px;">${esc(testName)}</td></tr>`;
    sections.forEach(sec => {
      html += `<tr style="background:#eff6ff;"><td colspan="4" style="font-weight:700; padding:5px 8px; font-size:0.72rem; text-transform:uppercase; letter-spacing:1px;">${sec}</td></tr>`;
      MICRO_PARAMS.filter(p => p.section === sec).forEach(p => {
        let v = data[p.key]; if (v === undefined || v === '' || v === 'None seen' || v === 'Absent' || v === 'Negative') return;
        let flag = '';
        if (p.type === 'number' && p.low !== undefined) { let n = parseFloat(v); if (!isNaN(n)) { if (n > p.high) flag = '↑'; else if (n < p.low) flag = '↓'; } }
        let ref = (p.low !== undefined) ? `${p.low}–${p.high}` : '—';
        html += `<tr><td style="padding:4px 8px;">${esc(p.name)}</td><td style="padding:4px 8px;${flag?'font-weight:bold;color:#b91c1c;':''}">${esc(v)} ${flag}</td><td style="padding:4px 8px;">${esc(p.unit||'')}</td><td style="padding:4px 8px;">${ref}</td></tr>`;
      });
    });
    html += `<tr style="background:#eff6ff;"><td colspan="4" style="font-weight:700; padding:5px 8px; font-size:0.72rem; text-transform:uppercase; letter-spacing:1px;">Culture &amp; Sensitivity</td></tr>`;
    html += `<tr><td style="padding:4px 8px;">Organism</td><td colspan="3" style="padding:4px 8px; font-style:italic;">${esc(data.organism || 'No growth / Not specified')}</td></tr>`;
    if (data.sensitivities && data.sensitivities.length) {
      html += `<tr style="background:#f0f0f0;"><th style="padding:5px;">Antibiotic</th><th style="padding:5px;">Result</th><th style="padding:5px;">Interpretation</th><th></th></tr>`;
      data.sensitivities.forEach(s => {
        const label  = s.result==='S'?'Sensitive':s.result==='R'?'Resistant':s.result==='I'?'Intermediate':s.result||'—';
        const colour = s.result==='S'?'#15803d':s.result==='R'?'#b91c1c':s.result==='I'?'#92400e':'#374151';
        html += `<tr><td style="padding:5px;">${esc(s.antibiotic)}</td><td style="padding:5px;font-weight:bold;color:${colour};">${esc(s.result)}</td><td style="padding:5px;color:${colour};">${label}</td><td></td></tr>`;
      });
    } else {
      html += `<tr><td colspan="4" style="padding:5px;color:#6b7280;">No antibiotic sensitivities recorded.</td></tr>`;
    }
    return html;
  }
  if (testType === 'complex_malaria') {
    let rows = '';
    if (data.species) rows += `<tr><td>Species</td><td colspan="3">${esc(data.species)}</td></tr>`;
    if (data.stage) rows += `<tr><td>Stage</td><td colspan="3">${esc(data.stage)}</td></tr>`;
    if (data.density !== undefined) rows += `<tr><td>Parasite Density</td><td colspan="3">${esc(data.density)} parasites/µL</td></tr>`;
    return `<tr><td colspan="4" style="font-weight:bold;">${esc(testName)}</td></tr>${rows}`;
  }
  if (testType === 'complex_tb_genexpert') {
    let rows = '';
    if (data.mtb_detected) rows += `<tr><td>MTB Detected</td><td colspan="3">${esc(data.mtb_detected)}</td></tr>`;
    if (data.rif_resistance) rows += `<tr><td>Rifampicin Resistance</td><td colspan="3">${esc(data.rif_resistance)}</td></tr>`;
    for (let probe of ['probeA_ct','probeB_ct','probeC_ct','probeD_ct','probeE_ct']) {
      if (data[probe] !== undefined) rows += `<tr><td>${probe.replace('_ct',' Probe Ct')}</td><td colspan="3">${esc(data[probe])}</td></tr>`;
    }
    return `<tr><td colspan="4" style="font-weight:bold;">${esc(testName)}</td></tr>${rows}`;
  }
  if (testType === 'complex_serology') {
    let rows = '';
    for (let p of SEROLOGY_PARAMS) {
      if (data[p.key] !== undefined) rows += `<tr><td>${esc(p.name)}</td><td colspan="3">${esc(data[p.key])}</td></tr>`;
    }
    return `<tr><td colspan="4" style="font-weight:bold;">${esc(testName)}</td></tr>${rows}`;
  }
  if (testType === 'complex_semen') {
    let rows = '';
    for (let p of SEMEN_PARAMS) {
      let val = data[p.key];
      if (val === undefined || val === '') continue;
      let flag = '';
      let n = parseFloat(val);
      if (!isNaN(n)) {
        if (p.high != null && n > p.high) flag = '↑';
        if (p.low != null && n < p.low) flag = '↓';
      }
      let ref = (p.low != null && p.high != null) ? `${p.low}–${p.high}` : '—';
      rows += `<tr><td style="padding:5px;">${esc(p.name)}</td><td style="padding:5px;${flag?'font-weight:bold;':''}">${esc(val)} ${flag}</td><td style="padding:5px;">${esc(p.unit||'')}</td><td style="padding:5px;">${ref}</td></tr>`;
    }
    let html = `<tr style="background:#f0f0f0;"><td colspan="4" style="font-weight:bold;">${esc(testName)}</td></tr>${rows}`;
    html += `<tr style="background:#eff6ff;"><td colspan="4" style="font-weight:700; padding:5px 8px; font-size:0.72rem; text-transform:uppercase; letter-spacing:1px;">Culture &amp; Sensitivity</td></tr>`;
    html += `<tr><td style="padding:4px 8px;">Organism</td><td colspan="3" style="padding:4px 8px; font-style:italic;">${esc(data.organism || 'No growth / Not specified')}</td></tr>`;
    if (data.sensitivities && data.sensitivities.length) {
      html += `<tr style="background:#f0f0f0;"><th style="padding:5px;">Antibiotic</th><th style="padding:5px;">Result</th><th style="padding:5px;">Interpretation</th><th></th></tr>`;
      data.sensitivities.forEach(s => {
        const label  = s.result==='S'?'Sensitive':s.result==='R'?'Resistant':s.result==='I'?'Intermediate':s.result||'—';
        const colour = s.result==='S'?'#15803d':s.result==='R'?'#b91c1c':s.result==='I'?'#92400e':'#374151';
        html += `<tr><td style="padding:5px;">${esc(s.antibiotic)}</td><td style="padding:5px;font-weight:bold;color:${colour};">${esc(s.result)}</td><td style="padding:5px;color:${colour};">${label}</td><td></td></tr>`;
      });
    } else {
      html += `<tr><td colspan="4" style="padding:5px;color:#6b7280;">No antibiotic sensitivities recorded.</td></tr>`;
    }
    return html;
  }
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
  if (!params.length) return `<tr><td colspan="4">${esc(testName)}: ${esc(JSON.stringify(data))}</td></tr>`;
  let rows = params.filter(p => data[p.key] !== undefined).map(p => {
    let val = data[p.key];
    let flag = '';
    let n = parseFloat(val);
    if (!isNaN(n)) {
      if (p.high !== null && n > p.high) flag = '↑';
      if (p.low !== null && n < p.low) flag = '↓';
    }
    let ref = (p.low !== null && p.high !== null) ? `${p.low}–${p.high}` : (p.low !== null ? `≥${p.low}` : p.high !== null ? `≤${p.high}` : (p.note || '—'));
    return `<tr><td style="padding:5px;">${esc(p.name)}</td><td style="padding:5px;${flag?'font-weight:bold;':''}">${val} ${flag}</td><td style="padding:5px;">${esc(p.unit)}</td><td style="padding:5px;">${esc(ref)}</td></tr>`;
  }).join('');
  return `<tr><td colspan="4" style="font-weight:bold;">${esc(testName)}</td></tr>${rows}`;
}

function startClock() {
  function tick() {
    let el = document.getElementById('clockDisplay');
    if (el) el.innerText = new Date().toLocaleTimeString('en-GB');
  }
  tick(); setInterval(tick, 1000);
}
if (currentUser) {
  document.getElementById('logoutBtn').addEventListener('click', logoutUser);
  document.getElementById('userDisplay').innerHTML = `<i class="fas fa-user-shield"></i> ${esc(currentUser.name || '')} (${esc(currentUser.role || '')})`;
  if (currentUser.role !== 'admin' && currentUser.role !== 'supervisor') {
    const adminTabBtn = document.getElementById('adminTabBtn');
    if (adminTabBtn) adminTabBtn.style.display = 'none';
  }
  document.querySelectorAll('.tab-btn').forEach(btn => btn.addEventListener('click', () => {
    let tab = btn.getAttribute('data-tab');
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    document.getElementById(`tab-${tab}`).classList.add('active');
    if(tab==='all') renderAllSamples();
    if(tab==='dashboard') renderDashboard();
    if(tab==='qc') renderQC();
    if(tab==='verify') renderVerifyTable();
    if(tab==='audit') renderAudit();
    if(tab==='finance') renderFinanceReport();
    if(tab==='admin') renderUnitsList();
  }));
  document.getElementById('allSearch')?.addEventListener('input', renderAllSamples);
  document.getElementById('allStatusFilter')?.addEventListener('change', renderAllSamples);
  document.getElementById('allPayFilter')?.addEventListener('change', renderAllSamples);
  document.getElementById('verifySearch')?.addEventListener('input', renderVerifyTable);
  document.getElementById('verifyStatusFilter')?.addEventListener('change', renderVerifyTable);
  document.getElementById('addUnitBtn')?.addEventListener('click', addUnit);
  document.getElementById('addAreaBtn')?.addEventListener('click', addArea);
  startClock();
  loadTestDefinitions().then(() => {
    renderAllSamples();
    renderDashboard();
    renderQC();
    renderVerifyTable();
    renderAudit();
    renderFinanceReport();
    renderUnitsList();
    renderAreasList();
  });
  setInterval(() => { if(!currentVerifySample) Promise.all([renderVerifyTable(), renderAllSamples(), renderDashboard()]); }, 30000);
}

// ── Area Management ──────────────────────────────────────────────────────────
let _allAreasAdmin = [];

async function renderAreasList() {
  const container = document.getElementById('areasList');
  if (!container) return;
  container.innerHTML = '<div style="color:var(--muted);font-size:.82rem;">Loading...</div>';
  try {
    const { data, error } = await db.from('areas').select('id,name').order('name');
    if (error) throw error;
    _allAreasAdmin = data || [];
    _renderAreasTable(_allAreasAdmin);
  } catch(e) {
    container.innerHTML = `<div style="color:var(--red);font-size:.82rem;">Failed to load areas: ${e.message}</div>`;
  }
}

function _renderAreasTable(areas) {
  const container = document.getElementById('areasList');
  if (!container) return;
  if (!areas.length) {
    container.innerHTML = '<div style="color:var(--muted);font-size:.82rem;padding:12px 0;">No areas added yet. Add your first area above.</div>';
    return;
  }
  container.innerHTML = `
    <table style="width:100%;border-collapse:collapse;font-size:.85rem;">
      <thead><tr style="background:var(--card-bg);border-bottom:2px solid var(--border);">
        <th style="padding:8px 12px;text-align:left;">Area Name</th>
        <th style="padding:8px 12px;text-align:right;">Action</th>
      </tr></thead>
      <tbody>
        ${areas.map(a => `
          <tr style="border-bottom:1px solid var(--border);">
            <td style="padding:8px 12px;">${esc(a.name)}</td>
            <td style="padding:8px 12px;text-align:right;">
              <button class="btn btn-danger btn-sm" onclick="deleteArea('${a.id}','${esc(a.name)}')" style="padding:4px 10px;font-size:.75rem;">
                <i class="fas fa-trash"></i> Delete
              </button>
            </td>
          </tr>`).join('')}
      </tbody>
    </table>`;
}

window.filterAreasList = function() {
  const q = (document.getElementById('areaSearch')?.value || '').toLowerCase();
  const filtered = q ? _allAreasAdmin.filter(a => a.name.toLowerCase().includes(q)) : _allAreasAdmin;
  _renderAreasTable(filtered);
};

async function addArea() {
  const input = document.getElementById('newAreaName');
  const name = input?.value.trim();
  if (!name) { toast('Please enter an area name', 'error'); input?.focus(); return; }
  const btn = document.getElementById('addAreaBtn');
  btn.disabled = true; btn.textContent = 'Adding...';
  try {
    const { error } = await db.from('areas').insert([{ name }]);
    if (error) throw error;
    input.value = '';
    toast(`Area "${name}" added successfully`, 'success');
    await renderAreasList();
  } catch(e) {
    toast('Failed to add area: ' + e.message, 'error');
  } finally {
    btn.disabled = false; btn.innerHTML = '<i class="fas fa-plus"></i> Add Area';
  }
}

window.deleteArea = async function(id, name) {
  if (!confirm(`Delete area "${name}"? This cannot be undone.`)) return;
  try {
    const { error } = await db.from('areas').delete().eq('id', id);
    if (error) throw error;
    toast(`Area "${name}" deleted`, 'success');
    await renderAreasList();
  } catch(e) {
    toast('Failed to delete: ' + e.message, 'error');
  }
};
