// ============================================================
// MU'UJIZA HMS — pharmacy-queue.js  (Pharmacist dispense view)
// Reads from: consultations, drug_inventory, dispensing_records
// Writes to:  dispensing_records, dispensing_items, drug_inventory,
//             drug_stock_transactions (all via dispense_prescription RPC)
// ============================================================

const SUPABASE_URL      = 'https://npdopywxemtwzvpummsn.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5wZG9weXd4ZW10d3p2cHVtbXNuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk4NzY0MjksImV4cCI6MjA5NTQ1MjQyOX0.Mo5LfGdfSiHL6QHsPOaGkDmeaIRDqZTe8MGwz_6ou1c';

const session = window.pharmacySession;
const client  = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  global: { headers: { 'x-lis-token': session.token } }
});

document.getElementById('userLabel').textContent = session.name || session.username;
document.getElementById('logoutBtn').addEventListener('click', () => {
  sessionStorage.removeItem('muujiza_pharmacy_session');
  window.location.replace('pharmacy-login.html');
});

const errorMsg   = document.getElementById('errorMsg');
const successMsg = document.getElementById('successMsg');
function showError(m)  { successMsg.classList.remove('show'); errorMsg.textContent=m; errorMsg.classList.add('show'); }
function showSuccess(m){ errorMsg.classList.remove('show'); successMsg.textContent=m; successMsg.classList.add('show'); }
function clearMsgs()   { errorMsg.classList.remove('show'); successMsg.classList.remove('show'); }
function esc(s){ if(!s&&s!==0) return '—'; return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

// ============================================================
// STATE
// ============================================================
let queueItems      = [];   // today's un-dispensed consultations with a prescription
let selectedConsult  = null;
let allDrugs         = [];
let selectedDrugs     = [];  // { id, name, unit, available, qty }

// ============================================================
// PRESCRIPTION QUEUE (auto, today) + manual search fallback
// ============================================================
async function loadQueue(){
  const { data, error } = await client.from('consultations')
    .select('id,hospital_number,visit_id,doctor_name,diagnosis,prescription,presenting_complaint,allergy_note,created_at')
    .not('prescription','is',null)
    .order('created_at',{ascending:true});

  if(error){ showError(error.message); return; }

  const { data: doneRows } = await client.from('dispensing_records')
    .select('consultation_id').eq('status','completed');
  const doneIds = new Set((doneRows||[]).map(r=>r.consultation_id));

  queueItems = (data||[]).filter(c => !doneIds.has(c.id));
  renderQueue();
  updateStats();
  checkLowStock();
}

function renderQueue(){
  const filter = document.getElementById('queueFilter').value.toLowerCase();
  const list = document.getElementById('rxQueueList');
  const items = queueItems.filter(c =>
    !filter || c.hospital_number.toLowerCase().includes(filter) || (c.diagnosis||'').toLowerCase().includes(filter));

  document.getElementById('queueCount').textContent = items.length;

  if(items.length===0){ list.innerHTML = `<div class="empty">No pending prescriptions</div>`; return; }

  list.innerHTML = items.map(c => {
    const time = c.created_at ? new Date(c.created_at).toLocaleTimeString('en-NG',{hour:'2-digit',minute:'2-digit'}) : '';
    return `
      <div class="queue-item ${selectedConsult?.id===c.id?'selected':''}" data-id="${c.id}">
        <div class="qi-top">
          <span class="qi-hospno">${esc(c.hospital_number)}</span>
          <span>⏰ ${time}</span>
        </div>
        <div class="qi-dx">${esc(c.diagnosis)}</div>
        <div class="qi-doc">Dr. ${esc(c.doctor_name)}</div>
      </div>`;
  }).join('');

  list.querySelectorAll('.queue-item').forEach(el=>{
    el.addEventListener('click', () => {
      const c = queueItems.find(x=>x.id===el.dataset.id) || manualResult;
      if(c) selectConsultation(c);
    });
  });
}

async function updateStats(){
  const today = new Date().toISOString().split('T')[0];
  const [{count: dispensedToday}] = await Promise.all([
    client.from('dispensing_records').select('*',{count:'exact',head:true})
      .eq('status','completed').gte('dispensed_at', today+'T00:00:00')
  ]);
  document.getElementById('s_pending').textContent  = queueItems.length;
  document.getElementById('s_dispensed').textContent = dispensedToday ?? 0;
}

async function checkLowStock(){
  const { count } = await client.from('drug_inventory')
    .select('*',{count:'exact',head:true}).eq('is_active',true)
    .lte('quantity_in_stock','reorder_level');
  const banner = document.getElementById('lowStockBanner');
  if(!banner) return;
  if(count && count>0){
    banner.classList.add('show');
    banner.textContent = `⚠️ ${count} drug${count>1?'s':''} at or below reorder level.`;
  } else {
    banner.classList.remove('show');
  }
}

document.getElementById('queueFilter').addEventListener('input', renderQueue);

// ---- Manual search by hospital number (any date, not yet dispensed) ----
let manualResult = null;
document.getElementById('rxSearchBtn').addEventListener('click', async () => {
  clearMsgs();
  const hospNum = document.getElementById('rxSearchHospNum').value.trim().toUpperCase();
  if(!hospNum) return showError('Enter a hospital number.');

  const { data, error } = await client.from('consultations')
    .select('id,hospital_number,visit_id,doctor_name,diagnosis,prescription,presenting_complaint,allergy_note,created_at')
    .eq('hospital_number', hospNum)
    .not('prescription','is',null)
    .order('created_at',{ascending:false}).limit(5);

  if(error){ showError(error.message); return; }
  if(!data||data.length===0){ showError('No prescription found for that hospital number.'); return; }

  const { data: doneRows } = await client.from('dispensing_records')
    .select('consultation_id').eq('status','completed').eq('hospital_number', hospNum);
  const doneIds = new Set((doneRows||[]).map(r=>r.consultation_id));
  const pending = data.find(c => !doneIds.has(c.id));

  if(!pending){ showError('All prescriptions for this patient have already been dispensed.'); return; }
  manualResult = pending;
  selectConsultation(pending);
});
document.getElementById('rxSearchHospNum').addEventListener('keydown', e=>{
  if(e.key==='Enter') document.getElementById('rxSearchBtn').click();
});

// ============================================================
// SELECT CONSULTATION → show prescription + drug picker
// ============================================================
async function selectConsultation(c){
  selectedConsult = c;
  clearMsgs();
  resetDispenseForm();
  document.getElementById('placeholder').style.display = 'none';
  document.getElementById('dispenseContent').classList.add('show');
  renderQueue();

  document.getElementById('patientHeader').innerHTML = `
    <div class="ph-hospno">${esc(c.hospital_number)}</div>
    <div class="ph-meta">
      Dr. ${esc(c.doctor_name)} &nbsp;|&nbsp;
      ${c.created_at ? new Date(c.created_at).toLocaleString('en-NG',{dateStyle:'medium',timeStyle:'short'}) : ''}
    </div>
    <div class="ph-dx">🔍 ${esc(c.diagnosis)}</div>`;

  document.getElementById('prescriptionText').textContent = c.prescription || '—';

  const allergyBox = document.getElementById('allergyWarning');
  if(c.allergy_note){
    allergyBox.classList.add('show');
    allergyBox.innerHTML = `⚠️ <b>Known allergy:</b> ${esc(c.allergy_note)}`;
  } else {
    allergyBox.classList.remove('show');
    allergyBox.innerHTML = '';
  }

  await loadDrugs();
}

// ============================================================
// DRUG PICKER (search + quantity per selected drug)
// ============================================================
async function loadDrugs(){
  if(allDrugs.length>0){ renderDrugList(); return; }
  const { data, error } = await client.from('drug_inventory')
    .select('id,drug_name,generic_name,strength,unit,quantity_in_stock,unit_price')
    .eq('is_active',true)
    .order('drug_name',{ascending:true});
  if(error){ showError(error.message); return; }
  allDrugs = data||[];
  renderDrugList();
}

function renderDrugList(){
  const search = document.getElementById('drugSearch').value.toLowerCase();
  const list = document.getElementById('drugList');
  const filtered = allDrugs.filter(d =>
    !search || d.drug_name.toLowerCase().includes(search) || (d.generic_name||'').toLowerCase().includes(search));

  if(filtered.length===0){ list.innerHTML = `<div style="padding:10px;color:var(--muted);font-size:0.82rem;">No drugs found.</div>`; return; }

  list.innerHTML = filtered.map(d => {
    const out = d.quantity_in_stock<=0;
    const already = selectedDrugs.some(s=>s.id===d.id);
    return `<div class="drug-item ${out?'out':''}">
      <div class="di-name">${esc(d.drug_name)} ${d.strength?`<span class="di-strength">${esc(d.strength)}</span>`:''}</div>
      <div class="di-meta">${d.generic_name?esc(d.generic_name)+' · ':''}${d.quantity_in_stock} ${esc(d.unit)}(s) in stock</div>
      <button class="btn-add" data-id="${d.id}" ${out||already?'disabled':''}>${already?'Added':out?'Out of stock':'+ Add'}</button>
    </div>`;
  }).join('');

  list.querySelectorAll('.btn-add').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const drug = allDrugs.find(d=>d.id===btn.dataset.id);
      if(!drug || selectedDrugs.some(s=>s.id===drug.id)) return;
      selectedDrugs.push({ id: drug.id, name: drug.drug_name, unit: drug.unit,
        available: drug.quantity_in_stock, qty: 1 });
      renderSelectedDrugs();
      renderDrugList();
    });
  });
}
document.getElementById('drugSearch').addEventListener('input', renderDrugList);

function renderSelectedDrugs(){
  const el = document.getElementById('selectedDrugs');
  if(selectedDrugs.length===0){ el.innerHTML = `<div style="color:var(--muted);font-size:0.82rem;">No drugs selected yet.</div>`; return; }

  el.innerHTML = selectedDrugs.map(s => `
    <div class="selected-drug-row" data-id="${s.id}">
      <span class="sd-name">${esc(s.name)}</span>
      <input type="number" class="sd-qty" min="1" max="${s.available}" value="${s.qty}">
      <span class="sd-unit">${esc(s.unit)}(s) — max ${s.available}</span>
      <button class="sd-remove" data-id="${s.id}" title="Remove">✕</button>
    </div>`).join('');

  el.querySelectorAll('.sd-qty').forEach(inp=>{
    inp.addEventListener('input', ()=>{
      const row = inp.closest('.selected-drug-row');
      const s = selectedDrugs.find(x=>x.id===row.dataset.id);
      if(!s) return;
      let v = parseInt(inp.value)||1;
      v = Math.max(1, Math.min(v, s.available));
      inp.value = v;
      s.qty = v;
    });
  });
  el.querySelectorAll('.sd-remove').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      selectedDrugs = selectedDrugs.filter(s=>s.id!==btn.dataset.id);
      renderSelectedDrugs();
      renderDrugList();
    });
  });
}

// ============================================================
// SUBMIT DISPENSE
// ============================================================
document.getElementById('submitDispenseBtn').addEventListener('click', async () => {
  clearMsgs();
  if(!selectedConsult) return showError('No prescription selected.');
  if(selectedDrugs.length===0) return showError('Select at least one drug to dispense.');

  const btn = document.getElementById('submitDispenseBtn');
  btn.disabled = true; btn.textContent = 'Dispensing...';

  try{
    const { data, error } = await client.rpc('dispense_prescription', {
      p_token:             session.token,
      p_consultation_id:   selectedConsult.id,
      p_hospital_number:   selectedConsult.hospital_number,
      p_visit_id:          selectedConsult.visit_id || null,
      p_patient_name:      null,
      p_prescription_text: selectedConsult.prescription,
      p_items:             selectedDrugs.map(s => ({ drug_id: s.id, quantity: s.qty })),
      p_pharmacist_note:   document.getElementById('pharmacistNote').value.trim() || null
    });

    if(error) throw error;
    const r = Array.isArray(data) ? data[0] : data;
    if(!r?.success) throw new Error(r?.message || 'Failed to dispense.');

    showSuccess(`✅ ${r.message}`);
    resetDispenseForm();
    selectedConsult = null;
    document.getElementById('placeholder').style.display = 'flex';
    document.getElementById('dispenseContent').classList.remove('show');
    allDrugs = []; // force refresh so stock levels are current next selection
    await loadQueue();

  }catch(err){
    showError(err.message || 'Failed to dispense.');
  }finally{
    btn.disabled = false; btn.textContent = 'Dispense';
  }
});

function resetDispenseForm(){
  selectedDrugs = [];
  document.getElementById('selectedDrugs').innerHTML = '';
  document.getElementById('drugSearch').value = '';
  document.getElementById('pharmacistNote').value = '';
  document.getElementById('allergyWarning').classList.remove('show');
}

document.getElementById('clearDispenseBtn').addEventListener('click', () => {
  clearMsgs();
  resetDispenseForm();
  if(selectedConsult) renderDrugList();
});

// Init
loadQueue();
setInterval(loadQueue, 30000);
