// ============================================================
// MU'UJIZA RECORDS — register-patient.js
// Saves full intake form to patient_registry. Uses the records
// session token (x-lis-token) so RLS (records_officer/records_admin)
// applies. Independent of lab JS/session entirely.
// ============================================================

const SUPABASE_URL      = 'https://npdopywxemtwzvpummsn.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5wZG9weXd4ZW10d3p2cHVtbXNuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk4NzY0MjksImV4cCI6MjA5NTQ1MjQyOX0.Mo5LfGdfSiHL6QHsPOaGkDmeaIRDqZTe8MGwz_6ou1c';

// records-auth-guard.js runs first and sets window.recordsSession,
// or redirects to records-login.html if there's no valid session.
const session = window.recordsSession;

const client = session?.token
  ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { 'x-lis-token': session.token } }
    })
  : window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

document.getElementById('logoutBtn')?.addEventListener('click', () => {
  sessionStorage.removeItem('muujiza_records_session');
  window.location.replace('records-login.html');
});

const form       = document.getElementById('patientForm');
const saveBtn    = document.getElementById('saveBtn');
const errorMsg   = document.getElementById('errorMsg');
const successMsg = document.getElementById('successMsg');

function showError(msg) {
  successMsg.classList.remove('show');
  errorMsg.textContent = msg;
  errorMsg.classList.add('show');
}
function showSuccess(msg) {
  errorMsg.classList.remove('show');
  successMsg.textContent = msg;
  successMsg.classList.add('show');
}
function clearMsgs() {
  errorMsg.classList.remove('show');
  successMsg.classList.remove('show');
}
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

document.getElementById('resetBtn')?.addEventListener('click', () => {
  form.reset();
  clearMsgs();
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  clearMsgs();

  // Minimal required-field check (mirrors HTML5 required, double-checked here)
  const required = ['surname', 'first_name', 'gender', 'phone'];
  for (const id of required) {
    if (!val(id)) {
      showError('Please fill all required fields (Surname, First Name, Gender, Phone).');
      document.getElementById(id)?.focus();
      return;
    }
  }

  const tagsRaw = val('tags');
  const tags = tagsRaw ? tagsRaw.split(',').map(t => t.trim()).filter(Boolean) : null;

  const payload = {
    surname:                          val('surname'),
    first_name:                       val('first_name'),
    middle_name:                      val('middle_name'),
    date_of_birth:                    val('date_of_birth'),
    age:                              numVal('age'),
    gender:                           val('gender'),
    national_id:                      val('national_id'),
    nin:                              val('nin'),
    nationality:                      val('nationality') || 'NIGERIA',
    state_of_origin:                  val('state_of_origin'),
    lga_of_origin:                    val('lga_of_origin'),
    ethnicity:                        val('ethnicity'),
    religion:                         val('religion'),
    marital_status:                   val('marital_status'),
    genotype:                         val('genotype'),
    blood_group:                      val('blood_group'),
    height:                           numVal('height'),
    weight:                           numVal('weight'),
    skin_colour:                      val('skin_colour'),

    phone:                            fullPhone('phone_code', 'phone'),
    other_phone:                      fullPhone('other_phone_code', 'other_phone'),
    whatsapp_number:                  fullPhone('whatsapp_code', 'whatsapp_number'),
    email:                            val('email'),
    address:                          val('address'),
    contact_preference:               val('contact_preference'),
    state_of_residence:               val('state_of_residence'),
    lga_of_residence:                 val('lga_of_residence'),
    ward_of_residence:                val('ward_of_residence'),
    treatment_zone:                   val('treatment_zone'),

    occupation:                       val('occupation'),
    level_of_education:               val('level_of_education'),
    billing_currency:                 val('billing_currency') || 'NAIRA',
    credit_limit:                     numVal('credit_limit') ?? 0,
    discount_percent:                 numVal('discount_percent') ?? 0,
    mobility:                         val('mobility'),
    referral_source:                  val('referral_source'),
    company:                          val('company'),
    tags:                             tags,
    reg_payment_status:               val('reg_payment_status'),
    patient_type:                     val('patient_type'),
    patient_department:               val('patient_department'),
    assigned_doctor:                  val('assigned_doctor'),
    main_consultant:                  val('main_consultant'),
    primary_care_giver:               val('primary_care_giver'),
    care_giver_contact:               val('care_giver_contact'),
    future_appointment_notification:  val('future_appointment_notification') || false
  };

  saveBtn.disabled = true;
  saveBtn.textContent = 'Saving...';

  try {
    const { data, error } = await client
      .from('patient_registry')
      .insert(payload)
      .select('hospital_number')
      .single();

    if (error) throw error;

    showSuccess(`✅ Patient registered successfully. Hospital Number: ${data.hospital_number}`);
    document.getElementById('hospNoPreview').textContent = `Hospital No: ${data.hospital_number}`;
    form.reset();

  } catch (err) {
    showError(err.message || 'Failed to save patient. Please try again.');
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = 'Save Patient';
  }
});
