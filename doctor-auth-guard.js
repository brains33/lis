(function(){
  const KEY='muujiza_doctor_session';
  try{
    const s=JSON.parse(sessionStorage.getItem(KEY)||'null');
    if(!s||!s.token||s.role!=='doctor'||Date.now()>=s.expiresAt){
      sessionStorage.removeItem(KEY); window.location.replace('doctor-login.html'); return;
    }
    window.doctorSession=s;
  }catch{ window.location.replace('doctor-login.html'); }
})();
