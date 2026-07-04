// ============================================================
// MU'UJIZA HMS — pharmacy-admin.js  (pharmacy_admin dashboard)
// Tabs: Stock | Staff | Dispensing History
// ============================================================

const SUPABASE_URL      = 'https://npdopywxemtwzvpummsn.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5wZG9weXd4ZW10d3p2cHVtbXNuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk4NzY0MjksImV4cCI6MjA5NTQ1MjQyOX0.Mo5LfGdfSiHL6QHsPOaGkDmeaIRDqZTe8MGwz_6ou1c';

const session = window.pharmacySession;
const client  = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  global: { headers: { 'x-lis-token': session.token } }
});

document.getElementById('userLabel').textContent = session.name || session.username;
document.getElementById('logoutBtn').addEventListener('click', () => {
  sessionStorage.removeItem('muujiza_pharmacy_session'); window.location.replace('pharmacy-login.html');
});

const errorMsg   = document.getElementById('errorMsg');
const successMsg = document.getElementById('successMsg');
function showError(m)  { successMsg.classList.remove('show'); errorMsg.textContent=m; errorMsg.classList.add('show'); }
function showSuccess(m){ errorMsg.classList.remove('show'); successMsg.textContent=m; successMsg.classList.add('show'); }
function clearMsgs()   { errorMsg.classList.remove('show'); successMsg.classList.remove('show'); }
function esc(s){ if(!s&&s!==0)return'—'; return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

// Tabs
document.querySelectorAll('.tab-btn').forEach(btn=>{
  btn.addEventListener('click',()=>{
    document.querySelectorAll('.tab-btn').forEach(b=>b.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(p=>p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`panel-${btn.dataset.tab}`).classList.add('active');
    clearMsgs();
    if(btn.dataset.tab==='staff')   loadStaff();
    if(btn.dataset.tab==='history') searchHistory();
    if(btn.dataset.tab==='stock')   loadStock();
  });
});

// ============================================================
// STOCK TAB
// ============================================================
let allStock = [];

async function loadStock(){
  const tbody = document.getElementById('stockTbody');
  tbody.innerHTML = `<tr><td colspan="7" class="empty">Loading...</td></tr>`;
  const { data, error } = await client.from('drug_inventory')
    .select('id,drug_name,generic_name,category,unit,quantity_in_stock,reorder_level,unit_price,is_active')
    .order('drug_name',{ascending:true});
  if(error){ tbody.innerHTML = `<tr><td colspan="7" class="empty">Error loading stock</td></tr>`; return; }
  allStock = data||[];
  renderStock();
  updateLowStockBadge();
}

function renderStock(){
  const filter = document.getElementById('stockFilter').value.toLowerCase();
  const tbody = document.getElementById('stockTbody');
  const items = allStock.filter(d =>
    !filter || d.drug_name.toLowerCase().includes(filter) || (d.generic_name||'').toLowerCase().includes(filter));

  if(items.length===0){ tbody.innerHTML = `<tr><td colspan="7" class="empty">No drugs found</td></tr>`; return; }

  tbody.innerHTML = items.map(d => {
    const low = d.quantity_in_stock <= d.reorder_level;
    return `<tr class="${!d.is_active?'inactive-row':''}">
      <td>
        <div class="dn">${esc(d.drug_name)}</div>
        ${d.generic_name?`<div class="dn-sub">${esc(d.generic_name)}</div>`:''}
      </td>
      <td>${esc(d.category)}</td>
      <td>${d.quantity_in_stock} ${esc(d.unit)}(s) ${low?'<span class="low-badge">LOW</span>':''}</td>
      <td>${d.reorder_level}</td>
      <td>${d.unit_price!=null?'₦'+Number(d.unit_price).toLocaleString():'—'}</td>
      <td>
        <input type="number" min="1" class="restock-qty" data-id="${d.id}" placeholder="Qty" style="width:70px;">
        <button class="btn-ghost btn-small restock-btn" data-id="${d.id}" data-name="${esc(d.drug_name)}">Restock</button>
      </td>
      <td><button class="btn-ghost btn-small toggle-drug-btn" data-id="${d.id}" data-active="${d.is_active}">
        ${d.is_active?'Deactivate':'Activate'}</button></td>
    </tr>`;
  }).join('');

  tbody.querySelectorAll('.restock-btn').forEach(btn=>{
    btn.addEventListener('click', async ()=>{
      clearMsgs();
      const qtyInput = tbody.querySelector(`.restock-qty[data-id="${btn.dataset.id}"]`);
      const qty = parseInt(qtyInput.value);
      if(!qty || qty<=0) return showError('Enter a quantity to restock.');
      btn.disabled = true;
      const { data, error } = await client.rpc('restock_drug', {
        p_token: session.token, p_drug_id: btn.dataset.id, p_quantity: qty,
        p_reason: `Restock — ${btn.dataset.name}`
      });
      btn.disabled = false;
      if(error){ showError(error.message); return; }
      const r = Array.isArray(data)?data[0]:data;
      if(!r?.success){ showError(r?.message||'Failed to restock.'); return; }
      showSuccess(`✅ ${btn.dataset.name} restocked. New balance: ${r.new_balance}.`);
      qtyInput.value='';
      loadStock();
    });
  });

  tbody.querySelectorAll('.toggle-drug-btn').forEach(btn=>{
    btn.addEventListener('click', async ()=>{
      clearMsgs();
      const active = btn.dataset.active === 'true';
      const { error } = await client.from('drug_inventory')
        .update({ is_active: !active }).eq('id', btn.dataset.id);
      if(error){ showError(error.message); return; }
      showSuccess(active ? 'Drug deactivated.' : 'Drug activated.');
      loadStock();
    });
  });
}

document.getElementById('stockFilter').addEventListener('input', renderStock);

async function updateLowStockBadge(){
  const low = allStock.filter(d => d.is_active && d.quantity_in_stock <= d.reorder_level).length;
  const badge = document.getElementById('lowStockBadge');
  if(!badge) return;
  if(low>0){ badge.textContent = `${low} low`; badge.classList.add('show'); }
  else { badge.classList.remove('show'); }
}

// ============================================================
// CATEGORY & MEDICATION TYPE — searchable dropdowns backed by
// drug_categories / medication_types lookup tables, with inline
// "add new" so the lists grow from the UI, no code changes needed.
// ============================================================
function makeLookupDropdown({ inputId, dropdownId, tableName }) {
  const input = document.getElementById(inputId);
  const dropdown = document.getElementById(dropdownId);
  if (!input || !dropdown) return;
  let cache = [];
  let debounceTimer = null;

  async function loadAll() {
    const { data, error } = await client.from(tableName).select('id,name').order('name', { ascending: true });
    if (!error) cache = data || [];
  }
  loadAll();

  function render(filterText) {
    const q = (filterText || '').trim().toLowerCase();
    const matches = q ? cache.filter(c => c.name.toLowerCase().includes(q)) : cache;
    let html = matches.map(c =>
      `<div class="lookup-row" data-name="${esc(c.name)}" style="padding:9px 12px;cursor:pointer;border-bottom:1px solid var(--border);font-size:0.85rem;color:var(--text);">${esc(c.name)}</div>`
    ).join('');

    const exactMatch = cache.some(c => c.name.toLowerCase() === q);
    if (q && !exactMatch) {
      html += `<div class="lookup-add-row" data-name="${esc(filterText.trim())}" style="padding:9px 12px;cursor:pointer;color:var(--primary-dark);font-weight:700;font-size:0.85rem;">+ Add "${esc(filterText.trim())}"</div>`;
    }
    if (!html) html = `<div style="padding:9px 12px;color:var(--text2);font-size:0.85rem;">Type to add a new entry</div>`;

    dropdown.innerHTML = html;
    dropdown.style.display = 'block';

    dropdown.querySelectorAll('.lookup-row').forEach(row => {
      row.addEventListener('mouseenter', () => row.style.background = 'var(--primary-light)');
      row.addEventListener('mouseleave', () => row.style.background = 'var(--surface)');
      row.addEventListener('click', () => { input.value = row.dataset.name; dropdown.style.display = 'none'; });
    });
    const addRow = dropdown.querySelector('.lookup-add-row');
    if (addRow) {
      addRow.addEventListener('click', async () => {
        const name = addRow.dataset.name;
        addRow.textContent = 'Adding...';
        const { error } = await client.from(tableName).insert({ name });
        if (error) { showError(`Could not add "${name}": ${error.message}`); return; }
        cache.push({ name });
        input.value = name;
        dropdown.style.display = 'none';
        showSuccess(`"${name}" added to ${tableName === 'drug_categories' ? 'categories' : 'medication types'}.`);
      });
    }
  }

  input.addEventListener('focus', () => render(input.value));
  input.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => render(input.value), 150);
  });
  input.addEventListener('blur', () => setTimeout(() => { dropdown.style.display = 'none'; }, 150));
}

makeLookupDropdown({ inputId: 'newDrugCategory', dropdownId: 'categoryDropdown', tableName: 'drug_categories' });
makeLookupDropdown({ inputId: 'newDrugForm', dropdownId: 'medTypeDropdown', tableName: 'medication_types' });


document.getElementById('addDrugBtn').addEventListener('click', async () => {
  clearMsgs();
  const name = document.getElementById('newDrugName').value.trim();
  if(!name) return showError('Drug name is required.');

  const btn = document.getElementById('addDrugBtn');
  btn.disabled = true; btn.textContent = 'Adding...';
  try{
    const { data, error } = await client.rpc('create_drug', {
      p_token:             session.token,
      p_drug_name:         name,
      p_generic_name:      document.getElementById('newDrugGeneric').value.trim() || null,
      p_category:          document.getElementById('newDrugCategory').value.trim() || null,
      p_dosage_form:       document.getElementById('newDrugForm').value.trim() || null,
      p_strength:          document.getElementById('newDrugStrength').value.trim() || null,
      p_unit:              document.getElementById('newDrugUnit').value.trim() || 'unit',
      p_initial_quantity:  parseInt(document.getElementById('newDrugQty').value) || 0,
      p_reorder_level:     parseInt(document.getElementById('newDrugReorder').value) || 10,
      p_unit_price:        document.getElementById('newDrugPrice').value ? Number(document.getElementById('newDrugPrice').value) : null,
      p_batch_number:      document.getElementById('newDrugBatch').value.trim() || null,
      p_expiry_date:       document.getElementById('newDrugExpiry').value || null
    });
    if(error) throw error;
    const r = Array.isArray(data)?data[0]:data;
    if(!r?.success) throw new Error(r?.message||'Failed to add drug.');
    showSuccess(r.message);
    ['newDrugName','newDrugGeneric','newDrugCategory','newDrugForm','newDrugStrength','newDrugUnit',
     'newDrugQty','newDrugReorder','newDrugPrice','newDrugBatch','newDrugExpiry']
      .forEach(id=>{ const el=document.getElementById(id); if(el) el.value=''; });
    loadStock();
  }catch(err){ showError(err.message||'Failed to add drug.'); }
  finally{ btn.disabled=false; btn.textContent='Add Drug'; }
});

// ============================================================
// STAFF TAB
// ============================================================
async function loadStaff(){
  const tbody = document.getElementById('staffTbody');
  tbody.innerHTML = `<tr><td colspan="5" class="empty">Loading...</td></tr>`;
  const { data, error } = await client.rpc('list_pharmacy_staff',{ p_token: session.token });
  if(error){ tbody.innerHTML = `<tr><td colspan="5" class="empty">Error loading staff</td></tr>`; return; }
  if(!data||data.length===0){ tbody.innerHTML = `<tr><td colspan="5" class="empty">No pharmacy staff yet</td></tr>`; return; }
  tbody.innerHTML = data.map(u=>`<tr>
    <td>${esc(u.username)}</td>
    <td>${u.role==='pharmacy_admin'?'Pharmacy Admin':'Pharmacist'}</td>
    <td><span style="color:${u.is_active?'#3ddc97':'#ff6b6b'}">${u.is_active?'Active':'Inactive'}</span></td>
    <td style="font-size:0.76rem;">${u.created_at?new Date(u.created_at).toLocaleDateString():''}</td>
    <td><button class="btn-ghost btn-small toggle-btn" data-username="${esc(u.username)}" data-active="${u.is_active}">
      ${u.is_active?'Deactivate':'Activate'}</button></td>
  </tr>`).join('');

  tbody.querySelectorAll('.toggle-btn').forEach(btn=>{
    btn.addEventListener('click', async ()=>{
      clearMsgs();
      const { data:d, error:e } = await client.rpc('toggle_records_user_status',{
        p_token:session.token, p_username:btn.dataset.username, p_active:btn.dataset.active==='true'?false:true
      });
      if(e){ showError(e.message); return; }
      const r=Array.isArray(d)?d[0]:d;
      if(!r?.success){ showError(r?.message||'Failed'); return; }
      showSuccess(r.message); loadStaff();
    });
  });
}

document.getElementById('createUserBtn').addEventListener('click', async()=>{
  clearMsgs();
  const username = document.getElementById('newUsername').value.trim();
  const password = document.getElementById('newPassword').value;
  const role     = document.getElementById('newRole').value;
  if(!username||username.length<3) return showError('Username must be at least 3 characters.');
  if(!password||password.length<6) return showError('Password must be at least 6 characters.');

  const btn = document.getElementById('createUserBtn');
  btn.disabled=true; btn.textContent='Creating...';
  try{
    const { data, error } = await client.rpc('create_pharmacy_user',{
      p_token:session.token, p_username:username, p_password:password, p_role:role
    });
    if(error) throw error;
    const r=Array.isArray(data)?data[0]:data;
    if(!r?.success) throw new Error(r?.message||'Failed.');
    showSuccess(r.message);
    document.getElementById('newUsername').value='';
    document.getElementById('newPassword').value='';
    loadStaff();
  }catch(err){ showError(err.message||'Failed.'); }
  finally{ btn.disabled=false; btn.textContent='Create Account'; }
});

// ============================================================
// DISPENSING HISTORY TAB
// ============================================================
document.getElementById('historyDate').value = new Date().toISOString().split('T')[0];

async function searchHistory(){
  clearMsgs();
  const date = document.getElementById('historyDate').value;
  const q    = document.getElementById('historySearch').value.trim();
  const tbody = document.getElementById('historyTbody');
  tbody.innerHTML = `<tr><td colspan="6" class="empty">Loading...</td></tr>`;

  let query = client.from('dispensing_records')
    .select('id,hospital_number,prescription_text,status,dispensed_by,dispensed_at,created_at')
    .order('created_at',{ascending:false}).limit(100);

  if(date) query = query.gte('created_at', date+'T00:00:00').lt('created_at', date+'T23:59:59');
  if(q)    query = query.ilike('hospital_number', `%${q}%`);

  const { data, error } = await query;
  if(error){ showError(error.message); tbody.innerHTML=`<tr><td colspan="6" class="empty">Error</td></tr>`; return; }
  if(!data||data.length===0){ tbody.innerHTML=`<tr><td colspan="6" class="empty">No dispensing records found</td></tr>`; return; }

  tbody.innerHTML = data.map(r=>`<tr>
    <td style="font-family:'JetBrains Mono',monospace;font-size:0.78rem;">${esc(r.hospital_number)}</td>
    <td>${esc(r.prescription_text)}</td>
    <td><span class="status-badge ${r.status}">${r.status}</span></td>
    <td>${esc(r.dispensed_by)}</td>
    <td style="font-size:0.76rem;">${r.dispensed_at?new Date(r.dispensed_at).toLocaleString('en-NG',{dateStyle:'medium',timeStyle:'short'}):''}</td>
    <td><button class="btn-ghost btn-small view-items-btn" data-id="${r.id}">Items</button></td>
  </tr>`).join('');

  tbody.querySelectorAll('.view-items-btn').forEach(btn=>{
    btn.addEventListener('click', ()=>viewDispensingItems(btn.dataset.id));
  });
}

async function viewDispensingItems(recordId){
  clearMsgs();
  const { data, error } = await client.from('dispensing_items')
    .select('drug_name,quantity_dispensed,unit_price,line_total')
    .eq('dispensing_record_id', recordId);
  if(error){ showError(error.message); return; }
  if(!data||data.length===0){ showSuccess('No items recorded for this dispensing.'); return; }
  const lines = data.map(i => `${i.drug_name} × ${i.quantity_dispensed}${i.line_total!=null?` (₦${Number(i.line_total).toLocaleString()})`:''}`);
  showSuccess(`Items: ${lines.join(' · ')}`);
}

document.getElementById('searchHistoryBtn').addEventListener('click', searchHistory);
document.getElementById('clearHistoryBtn').addEventListener('click', ()=>{
  document.getElementById('historySearch').value='';
  document.getElementById('historyDate').value=new Date().toISOString().split('T')[0];
  searchHistory();
});

// Init
loadStock();
