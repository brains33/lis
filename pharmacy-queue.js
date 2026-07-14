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

// ============================================================
// WAIT-TIME BADGE — colors by how long a prescription has been
// sitting, NOT clinical urgency. Order in the list stays oldest-first
// (fairness — first in, first served); this is purely a visual cue so
// an aging prescription still catches the eye without jumping the queue.
//   🟢 0–5 min   — just in, no rush
//   🟡 5–15 min  — getting up there
//   🔴 15+ min   — overdue, serve next
// ============================================================
const WAIT_AMBER_MINS = 5;
const WAIT_RED_MINS   = 15;

function waitBadge(createdAt){
  if(!createdAt) return '';
  const mins = Math.max(0, Math.floor((Date.now() - new Date(createdAt).getTime()) / 60000));
  let bg, fg;
  if(mins < WAIT_AMBER_MINS)      { bg = '#dcfce7'; fg = '#166534'; }
  else if(mins < WAIT_RED_MINS)   { bg = '#fef3c7'; fg = '#92400e'; }
  else                            { bg = '#fee2e2'; fg = '#991b1b'; }
  const label = mins < 1 ? 'just in' : `${mins}m wait`;
  return `<span class="wait-badge" style="background:${bg};color:${fg};border-radius:10px;padding:2px 8px;font-size:0.7rem;font-weight:700;white-space:nowrap;">${label}</span>`;
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
          <span style="display:flex;align-items:center;gap:6px;">⏰ ${time} ${waitBadge(c.created_at)}</span>
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
  autoMatchPrescription(c.prescription);
}

// ============================================================
// AUTO-MATCH — parses the (now structured) prescription text line
// by line and matches each against drug_inventory by name, so the
// pharmacist doesn't have to manually re-search what was prescribed.
// ============================================================
function autoMatchPrescription(prescriptionText){
  const area = document.getElementById('autoMatchArea');
  const statusEl = document.getElementById('autoMatchStatus');
  const btn = document.getElementById('autoMatchBtn');

  if(!prescriptionText || !prescriptionText.trim() || allDrugs.length===0){
    area.style.display='none';
    return;
  }

  const lines = prescriptionText.split('\n').map(l=>l.trim()).filter(Boolean);
  const matched = [];
  const unmatched = [];

  lines.forEach(line=>{
    const lineLower = line.toLowerCase();
    // Match if the prescription line contains the inventory drug's name
    // (handles "Amoxicillin 500mg TDS 5 days" matching drug_name "Amoxicillin")
    const found = allDrugs.find(d => lineLower.includes(d.drug_name.toLowerCase()));
    if(found) matched.push({ line, drug: found }); else unmatched.push(line);
  });

  if(matched.length===0){
    area.style.display='none';
    return;
  }

  area.style.display='block';
  statusEl.textContent = unmatched.length>0
    ? `${matched.length} matched, ${unmatched.length} not found in inventory — add those manually.`
    : `${matched.length} drug${matched.length===1?'':'s'} matched from prescription.`;

  btn.onclick = ()=>{
    matched.forEach(({drug})=>{
      if(selectedDrugs.some(s=>s.id===drug.id)) return; // already added
      if(drug.quantity_in_stock<=0) return; // skip out-of-stock, pharmacist sees it's unavailable in the list below
      selectedDrugs.push({ id: drug.id, name: drug.drug_name, unit: drug.unit, available: drug.quantity_in_stock, qty: 1, price: drug.unit_price || 0 });
    });
    renderSelectedDrugs();
    renderDrugList();
    updateDispenseTotal();
    btn.disabled = true;
    btn.textContent = '✓ Added';
  };
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
        available: drug.quantity_in_stock, qty: 1, price: drug.unit_price || 0 });
      renderSelectedDrugs();
      renderDrugList();
      updateDispenseTotal();
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
      updateDispenseTotal();
    });
  });
  el.querySelectorAll('.sd-remove').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      selectedDrugs = selectedDrugs.filter(s=>s.id!==btn.dataset.id);
      renderSelectedDrugs();
      renderDrugList();
      updateDispenseTotal();
    });
  });
}

// ============================================================
// PAYMENT — mirrors accession.js's updateTotal(): total is the sum
// of (qty × unit price) for everything selected, staff enters what
// was actually paid, balance + Paid/Partial/Unpaid badge update live.
// ============================================================
function updateDispenseTotal(){
  const total = selectedDrugs.reduce((sum,s) => sum + (s.price||0) * s.qty, 0);
  const paidInput = document.getElementById('dxAmountPaid');
  let paid = parseFloat(paidInput?.value) || 0;
  if(paid > total){
    paid = total;
    if(paidInput) paidInput.value = total.toFixed(2);
  }
  const balance = total - paid;
  document.getElementById('dxTotalAmount').textContent = total.toFixed(2);
  document.getElementById('dxBalanceDue').textContent = balance.toFixed(2);

  const badge = document.getElementById('dxPayBadge');
  if(total === 0 || (balance > 0 && paid === 0)){
    badge.textContent = 'Unpaid'; badge.style.background = '#fee2e2'; badge.style.color = '#991b1b';
  } else if(balance > 0){
    badge.textContent = 'Partial'; badge.style.background = '#fef3c7'; badge.style.color = '#92400e';
  } else {
    badge.textContent = 'Paid'; badge.style.background = '#dcfce7'; badge.style.color = '#166534';
  }
}
document.getElementById('dxAmountPaid').addEventListener('input', updateDispenseTotal);

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
      p_pharmacist_note:   document.getElementById('pharmacistNote').value.trim() || null,
      p_pay_mode:          document.getElementById('dxPayMode').value,
      p_amount_paid:       parseFloat(document.getElementById('dxAmountPaid').value) || 0
    });

    if(error) throw error;
    const r = Array.isArray(data) ? data[0] : data;
    if(!r?.success) throw new Error(r?.message || 'Failed to dispense.');

    const badge = document.getElementById('dxPayBadge').textContent;
    showSuccess(`✅ ${r.message} — Payment: ${badge} (Balance: ${document.getElementById('dxBalanceDue').textContent} NGN)`);
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
  document.getElementById('autoMatchArea').style.display = 'none';
  document.getElementById('dxAmountPaid').value = '';
  document.getElementById('dxPayMode').value = 'Cash';
  updateDispenseTotal();
  const btn = document.getElementById('autoMatchBtn');
  btn.disabled = false;
  btn.textContent = '✓ Add All Matched Drugs';
}

document.getElementById('clearDispenseBtn').addEventListener('click', () => {
  clearMsgs();
  resetDispenseForm();
  if(selectedConsult) renderDrugList();
});

// ============================================================
// SETTLE OUTSTANDING BALANCE — mirrors accession.js's settlement
// panel: look up by hospital number (pharmacy has no single "sample
// ID" concept — a patient can have several dispenses, so this lists
// every unpaid/partial one and lets staff settle whichever applies),
// pick a payment mode, confirm. Goes through settle_dispensing_balance
// (role-checked RPC) rather than a direct table update.
// ============================================================
document.getElementById('settlePanelToggle').addEventListener('click', () => {
  const body = document.getElementById('settlePanelBody');
  const chevron = document.getElementById('settlePanelChevron');
  const isHidden = body.style.display === 'none';
  body.style.display = isHidden ? 'block' : 'none';
  chevron.style.transform = isHidden ? 'rotate(180deg)' : 'rotate(0deg)';
});

let _settlePayMode = 'Cash';

async function lookupPharmacyBalance(){
  const hospNum = document.getElementById('settleHospNum').value.trim();
  const box = document.getElementById('settleResultBox');
  if(!hospNum){ showError('Enter a hospital number.'); return; }

  box.style.display = 'block';
  box.innerHTML = `<div style="padding:14px;text-align:center;color:var(--muted);">Looking up ${esc(hospNum)}…</div>`;

  const { data, error } = await client.from('dispensing_records')
    .select('id,patient_name,total_amount,amount_paid,balance_due,pay_status,dispensed_at')
    .eq('hospital_number', hospNum)
    .neq('pay_status', 'Paid')
    .order('dispensed_at', {ascending:false});

  if(error){ box.innerHTML = `<div style="padding:14px;color:#991b1b;">${esc(error.message)}</div>`; return; }
  if(!data || data.length===0){
    box.innerHTML = `<div style="padding:14px;background:#dcfce7;border-radius:10px;">✓ No outstanding balance for ${esc(hospNum)}.</div>`;
    return;
  }

  box.innerHTML = data.map(d => `
    <div style="border:1px solid #e2e8f0;border-radius:10px;padding:12px;margin-bottom:8px;">
      <div style="font-size:0.82rem;margin-bottom:6px;">
        <strong>${esc(d.patient_name||hospNum)}</strong> — ${new Date(d.dispensed_at).toLocaleString('en-NG',{dateStyle:'medium',timeStyle:'short'})}
      </div>
      <div style="font-size:0.82rem;background:#f0f7f3;border-radius:8px;padding:8px;margin-bottom:8px;">
        <div>Total: <strong>${(d.total_amount||0).toFixed(2)} NGN</strong></div>
        <div>Already Paid: <strong>${(d.amount_paid||0).toFixed(2)} NGN</strong></div>
        <div style="border-top:1px solid #c6e2d4;margin-top:4px;padding-top:4px;">Balance Due: <strong>${(d.balance_due||0).toFixed(2)} NGN</strong></div>
      </div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px;" class="settle-mode-row" data-id="${d.id}">
        <button type="button" class="settle-mode-btn active" data-mode="Cash">💵 Cash</button>
        <button type="button" class="settle-mode-btn" data-mode="POS">🏧 POS</button>
        <button type="button" class="settle-mode-btn" data-mode="Transfer">🏦 Transfer</button>
        <button type="button" class="settle-mode-btn" data-mode="NHIS">🏥 NHIS</button>
      </div>
      <button class="btn btn-primary settle-confirm-btn" data-id="${d.id}" data-balance="${d.balance_due}" style="width:100%;">
        Confirm Payment of ${(d.balance_due||0).toFixed(2)} NGN
      </button>
    </div>`).join('');

  box.querySelectorAll('.settle-mode-btn').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const row = btn.closest('.settle-mode-row');
      row.querySelectorAll('.settle-mode-btn').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      row.dataset.selectedMode = btn.dataset.mode;
    });
  });

  box.querySelectorAll('.settle-confirm-btn').forEach(btn=>{
    btn.addEventListener('click', () => confirmPharmacySettlement(btn));
  });
}

async function confirmPharmacySettlement(btn){
  const recordId = btn.dataset.id;
  const row = btn.closest('div').querySelector('.settle-mode-row');
  const mode = row?.dataset.selectedMode || 'Cash';

  btn.disabled = true; btn.textContent = 'Processing...';
  try{
    const { data, error } = await client.rpc('settle_dispensing_balance', {
      p_token: session.token,
      p_dispensing_record_id: recordId,
      p_pay_mode: mode
    });
    if(error) throw error;
    const r = Array.isArray(data) ? data[0] : data;
    if(!r?.success) throw new Error(r?.message || 'Settlement failed.');

    showSuccess(`✅ ${r.message}`);
    document.getElementById('settleHospNum').value = '';
    document.getElementById('settleResultBox').style.display = 'none';
  }catch(err){
    showError(err.message || 'Settlement failed.');
    btn.disabled = false;
    btn.textContent = `Confirm Payment of ${parseFloat(btn.dataset.balance).toFixed(2)} NGN`;
  }
}

document.getElementById('settleLookupBtn').addEventListener('click', lookupPharmacyBalance);
document.getElementById('settleHospNum').addEventListener('keydown', e => { if(e.key==='Enter') lookupPharmacyBalance(); });

// Init
loadQueue();
updateDispenseTotal();
setInterval(loadQueue, 30000);
