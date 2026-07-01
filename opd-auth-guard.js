(function(){
  const SESSION_KEY = 'muujiza_opd_session';
  try{
    const s = JSON.parse(sessionStorage.getItem(SESSION_KEY)||'null');
    if(!s||!s.token||!s.role||Date.now()>=s.expiresAt){ sessionStorage.removeItem(SESSION_KEY); window.location.replace('opd-login.html'); return; }
    window.opdSession = s;
  }catch{ window.location.replace('opd-login.html'); }
})();
