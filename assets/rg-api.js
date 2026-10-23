/* Acceso público a la API de Supabase (funciones RPC). Usa solo la clave pública. */
window.RG = (function () {
  'use strict';
  var c = window.RG_CONFIG || {};
  var url = String(c.supabaseUrl || '').replace(/\/+$/, '');
  var listo = Boolean(url && c.supabaseKey);
  var headers = function () {
    return { 'apikey': c.supabaseKey, 'Authorization': 'Bearer ' + c.supabaseKey, 'Content-Type': 'application/json', 'Accept': 'application/json' };
  };
  var rpc = function (fn, args) {
    if (!listo) return Promise.reject(new Error('NO_CONFIGURADO'));
    return fetch(url + '/rest/v1/rpc/' + fn, { method: 'POST', headers: headers(), body: JSON.stringify(args || {}) })
      .then(function (r) {
        return r.json().catch(function () { return null; }).then(function (d) {
          if (!r.ok) throw new Error((d && d.message) || ('HTTP ' + r.status));
          return d;
        });
      });
  };
  return { listo: listo, url: url, headers: headers, rpc: rpc };
})();
