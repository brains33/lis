// ============================================================
// MU'UJIZA RECORDS — register-patient.js
// Trimmed form: NIN/National ID merged, duplicate check, print card
// ============================================================

const SUPABASE_URL      = 'https://npdopywxemtwzvpummsn.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5wZG9weXd4ZW10d3p2cHVtbXNuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk4NzY0MjksImV4cCI6MjA5NTQ1MjQyOX0.Mo5LfGdfSiHL6QHsPOaGkDmeaIRDqZTe8MGwz_6ou1c';

const session = window.recordsSession;
const client = session?.token
  ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { 'x-lis-token': session.token } }
    })
  : window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Show logged-in user
const userLabel = document.getElementById('userLabel');
if (userLabel && session?.name) userLabel.textContent = session.name;

document.getElementById('logoutBtn')?.addEventListener('click', () => {
  sessionStorage.removeItem('muujiza_records_session');
  window.location.replace('records-login.html');
});

const form       = document.getElementById('patientForm');
const saveBtn    = document.getElementById('saveBtn');
const printBtn   = document.getElementById('printBtn');
const errorMsg   = document.getElementById('errorMsg');
const successMsg = document.getElementById('successMsg');

function showError(msg)   { successMsg.classList.remove('show'); errorMsg.textContent = msg; errorMsg.classList.add('show'); window.scrollTo(0,0); }
function showSuccess(msg) { errorMsg.classList.remove('show'); successMsg.textContent = msg; successMsg.classList.add('show'); window.scrollTo(0,0); }
function clearMsgs()      { errorMsg.classList.remove('show'); successMsg.classList.remove('show'); }

function val(id) {
  const el = document.getElementById(id);
  if (!el) return null;
  if (el.type === 'checkbox') return el.checked;
  const v = el.value.trim();
  return v === '' ? null : v;
}
function numVal(id) {
  const v = val(id);
  return v === null ? null : Number(v);
}
function fullPhone(codeId, numId) {
  const num = val(numId);
  if (!num) return null;
  const code = document.getElementById(codeId)?.value || '+234';
  return num.startsWith('+') ? num : `${code}${num.replace(/^0+/, '')}`;
}

// ---- NIN duplicate check (on blur) ----
let ninDupFlag = false;
document.getElementById('nin')?.addEventListener('blur', async () => {
  const nin = val('nin');
  const warn = document.getElementById('ninDupWarn');
  if (!nin || nin.length < 6) { warn.classList.remove('show'); ninDupFlag = false; return; }

  const { data } = await client
    .from('patient_registry')
    .select('hospital_number, surname, first_name')
    .eq('nin', nin)
    .limit(1);

  if (data && data.length > 0) {
    const p = data[0];
    warn.textContent = `⚠ NIN already registered — ${p.surname} ${p.first_name} (${p.hospital_number})`;
    warn.classList.add('show');
    ninDupFlag = true;
  } else {
    warn.classList.remove('show');
    ninDupFlag = false;
  }
});

document.getElementById('resetBtn')?.addEventListener('click', () => {
  form.reset();
  clearMsgs();
  printBtn.style.display = 'none';
  document.getElementById('ninDupWarn')?.classList.remove('show');
  ninDupFlag = false;
  document.getElementById('hospNoPreview').textContent = 'Hospital No: auto-generated on save';
});

// ---- Save patient ----
let lastSaved = null; // store last saved record for print

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  clearMsgs();

  const required = ['surname', 'first_name', 'gender', 'phone'];
  for (const id of required) {
    if (!val(id)) {
      showError('Please fill all required fields: Surname, First Name, Gender, Phone.');
      document.getElementById(id)?.focus();
      return;
    }
  }

  if (ninDupFlag) {
    const ok = confirm('A patient with this NIN already exists. Register anyway?');
    if (!ok) return;
  }

  const payload = {
    surname:            val('surname'),
    first_name:         val('first_name'),
    middle_name:        val('middle_name'),
    date_of_birth:      val('date_of_birth'),
    age:                numVal('age'),
    gender:             val('gender'),
    nin:                val('nin'),    // merged NIN/National ID stored in nin column
    nationality:        val('nationality') || 'NIGERIA',
    state_of_origin:    val('state_of_origin'),
    lga_of_origin:      val('lga_of_origin'),
    ethnicity:          val('ethnicity'),
    religion:           val('religion'),
    marital_status:     val('marital_status'),
    genotype:           val('genotype'),
    blood_group:        val('blood_group'),
    height:             numVal('height'),
    weight:             numVal('weight'),
    phone:              fullPhone('phone_code', 'phone'),
    other_phone:        fullPhone('other_phone_code', 'other_phone'),
    whatsapp_number:    fullPhone('whatsapp_code', 'whatsapp_number'),
    email:              val('email'),
    address:            val('address'),
    state_of_residence: val('state_of_residence'),
    lga_of_residence:   val('lga_of_residence'),
    contact_preference: val('contact_preference'),
    patient_type:       val('patient_type'),
    patient_department: val('patient_department'),
    assigned_doctor:    val('assigned_doctor'),
    main_consultant:    val('main_consultant'),
    referral_source:    val('referral_source'),
    reg_payment_status: val('reg_payment_status'),
    occupation:         val('occupation'),
    primary_care_giver: val('primary_care_giver'),
    care_giver_contact: val('care_giver_contact'),
    next_of_kin_name:         val('nok_name'),
    next_of_kin_relationship: val('nok_relationship'),
    next_of_kin_phone:        fullPhone('nok_phone_code', 'nok_phone'),
    next_of_kin_occupation:   val('nok_occupation'),
    next_of_kin_address:      val('nok_address'),
    billing_currency:   'NAIRA',
    credit_limit:       0,
    discount_percent:   0,
    future_appointment_notification: false
  };

  saveBtn.disabled = true;
  saveBtn.textContent = 'Saving...';

  try {
    const { data, error } = await client
      .from('patient_registry')
      .insert(payload)
      .select('hospital_number, surname, first_name, middle_name, date_of_birth, age, gender, nin, blood_group, genotype, phone, address, patient_department, patient_type, assigned_doctor, next_of_kin_name, next_of_kin_relationship, next_of_kin_phone, created_at')
      .single();

    if (error) throw error;

    lastSaved = data;
    document.getElementById('hospNoPreview').textContent = `Hospital No: ${data.hospital_number}`;
    showSuccess(`✅ Patient registered — Hospital No: ${data.hospital_number}`);
    printBtn.style.display = 'inline-block';
    populatePrintCard(data);
    form.reset();
    document.getElementById('ninDupWarn')?.classList.remove('show');
    ninDupFlag = false;

  } catch (err) {
    showError(err.message || 'Failed to save patient. Please try again.');
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = 'Save Patient';
  }
});

// ---- Print card ----
function populatePrintCard(d) {
  const nameParts = [d.surname, d.first_name, d.middle_name].filter(Boolean);
  document.getElementById('pc_hospno').textContent  = d.hospital_number || '—';
  document.getElementById('pc_name').textContent    = nameParts.join(' ') || '—';
  document.getElementById('pc_dob').textContent     = d.date_of_birth ? new Date(d.date_of_birth).toLocaleDateString('en-GB') : (d.age ? `Age: ${d.age}` : '—');
  document.getElementById('pc_gender').textContent  = d.gender || '—';
  document.getElementById('pc_nin').textContent     = d.nin || '—';
  document.getElementById('pc_blood').textContent   = d.blood_group || '—';
  document.getElementById('pc_geno').textContent    = d.genotype || '—';
  document.getElementById('pc_phone').textContent   = d.phone || '—';
  document.getElementById('pc_address').textContent = d.address || '—';
  document.getElementById('pc_dept').textContent    = d.patient_department || '—';
  document.getElementById('pc_type').textContent    = d.patient_type || '—';
  document.getElementById('pc_doctor').textContent  = d.assigned_doctor || '—';
  document.getElementById('pc_nok').textContent     = d.next_of_kin_name
    ? `${d.next_of_kin_name}${d.next_of_kin_relationship ? ' (' + d.next_of_kin_relationship + ')' : ''}${d.next_of_kin_phone ? ' — ' + d.next_of_kin_phone : ''}`
    : '—';
  document.getElementById('pc_date').textContent    = new Date(d.created_at).toLocaleDateString('en-GB');
}

printBtn?.addEventListener('click', () => window.print());
