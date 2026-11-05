/* Conexión pública con Supabase (solo la clave pública): funciones RPC, formulario de solicitudes y RG AI.
   La usan el sitio, la página de caso y Mi cuenta, en el hosting y en GitHub Pages. */
window.RG = (function () {
  'use strict';
  var c = window.RG_CONFIG || {};
  var url = String(c.supabaseUrl || '').replace(/\/+$/, '');
  var listo = Boolean(url && c.supabaseKey);
  // Raíz del sitio: carpeta padre de assets si viene como archivo; la carpeta de la página si va incrustado
  var src = document.currentScript && document.currentScript.src;
  var raiz = src ? new URL('../', src).href : new URL('./', location.href).href;
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
  return { listo: listo, url: url, raiz: raiz, headers: headers, rpc: rpc };
})();

(function () {
  'use strict';
  var respuesta = function (d, estado) { return new Response(JSON.stringify(d), { status: estado || 200, headers: { 'Content-Type': 'application/json' } }); };

  // Formulario de solicitudes: crea la solicitud y lleva al cliente a la página de su caso
  window.RG_ENVIAR_SOLICITUD = function (form) {
    if (!RG.listo) return Promise.resolve(respuesta({ ok: false, message: 'El formulario no está disponible en este momento. Escríbenos por WhatsApp al 316 526 8039 o llámanos.' }, 503));
    var f = new FormData(form);
    return RG.rpc('crear_solicitud', {
      p_nombre: f.get('nombre') || '', p_apellido: f.get('apellido') || '', p_email: f.get('email') || '',
      p_telefono: f.get('telefono') || '', p_mensaje: f.get('mensaje') || '', p_seguros: f.get('seguros') || '',
      p_autorizacion: f.get('autorizacion') || '', p_sitio_web: f.get('sitio_web') || '', p_t: f.get('_t') || ''
    }).then(function (d) {
      if (d && d.ok && d.caso) {
        d.message += ' En un momento te llevamos a la página de tu solicitud, donde verás las respuestas de tu asesor.';
        setTimeout(function () { location.href = RG.raiz + 'caso/#' + d.caso; }, 2500);
      }
      return respuesta(d);
    }, function () { return respuesta({ ok: false, message: 'No pudimos enviar tu solicitud. Inténtalo de nuevo o escríbenos por WhatsApp al 316 526 8039.' }, 502); });
  };

  // RG AI habla con la Edge Function de Supabase
  var conectarAI = function () {
    var ai = document.getElementById('rgai-form');
    if (ai) ai.action = RG.listo ? RG.url + '/functions/v1/rg-ai' : 'about:blank';
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', conectarAI); else conectarAI();
})();
