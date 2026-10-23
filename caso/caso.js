/* Página de caso del cliente: ver el estado y conversar con el asesor usando el enlace secreto. */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var ESTADOS = { nueva: 'Recibida', en_gestion: 'En gestión', cotizada: 'Cotizada', ganada: 'Cerrada', perdida: 'Cerrada' };
  var token = decodeURIComponent(location.hash.replace('#', ''));
  var aviso = $('estado-carga');
  var ultimo = '';

  var fecha = function (iso) {
    return new Date(iso).toLocaleString('es-CO', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'America/Bogota' });
  };
  var mostrarError = function (texto) { aviso.className = 'alert alert--error'; aviso.textContent = texto; aviso.hidden = false; };

  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token)) {
    mostrarError('Este enlace no es válido. Revisa que esté completo o escríbenos por WhatsApp al 316 526 8039.');
    $('guardar').hidden = false;
    return;
  }
  if (!window.RG || !RG.listo) {
    mostrarError('El servicio no está disponible en este momento. Escríbenos por WhatsApp al 316 526 8039.');
    return;
  }

  var pintar = function (c) {
    $('codigo').textContent = c.codigo;
    $('estado').textContent = ESTADOS[c.estado] || c.estado;
    $('estado').className = 'pill pill--' + c.estado;
    $('fecha').textContent = 'Enviada el ' + fecha(c.creada);
    $('asesor').textContent = c.asesor ? 'Asesor: ' + c.asesor : 'Pronto te asignaremos un asesor';
    $('seguros').textContent = c.seguros && c.seguros.length ? 'Seguros de interés: ' + c.seguros.join(', ') : '';
    var firma = JSON.stringify(c.mensajes);
    if (firma === ultimo) return;
    ultimo = firma;
    var hilo = $('hilo');
    hilo.textContent = '';
    if (!c.mensajes.length) {
      var vacio = document.createElement('p');
      vacio.className = 'muted';
      vacio.textContent = 'Aún no hay mensajes. Un asesor te escribirá aquí y también puede llamarte o escribirte por WhatsApp.';
      hilo.appendChild(vacio);
    }
    c.mensajes.forEach(function (m) {
      var div = document.createElement('div');
      div.className = 'msg msg--' + m.autor;
      div.textContent = m.texto;
      var pie = document.createElement('small');
      pie.textContent = (m.autor === 'cliente' ? 'Tú' : (c.asesor || 'Asesor RG')) + ' · ' + fecha(m.fecha);
      div.appendChild(pie);
      hilo.appendChild(div);
    });
  };

  var cargar = function () {
    return RG.rpc('caso_ver', { p_token: token }).then(function (c) {
      if (!c) { mostrarError('No encontramos esta solicitud. Es posible que el enlace esté incompleto o que la solicitud haya sido eliminada.'); return; }
      aviso.hidden = true;
      $('resumen').hidden = $('conversacion').hidden = $('guardar').hidden = false;
      pintar(c);
    }).catch(function () { mostrarError('No pudimos cargar tu solicitud. Revisa tu conexión e inténtalo de nuevo.'); });
  };

  $('responder').addEventListener('submit', function (e) {
    e.preventDefault();
    var texto = $('texto').value.trim();
    var err = $('error');
    var boton = this.querySelector('button');
    err.hidden = true;
    if (!texto) { err.textContent = 'Escribe un mensaje.'; err.hidden = false; return; }
    boton.disabled = true;
    RG.rpc('caso_responder', { p_token: token, p_texto: texto }).then(function (r) {
      if (!r.ok) { err.textContent = r.message; err.hidden = false; return; }
      $('texto').value = '';
      return cargar();
    }).catch(function () { err.textContent = 'No pudimos enviar tu mensaje. Inténtalo de nuevo.'; err.hidden = false; })
      .then(function () { boton.disabled = false; });
  });

  $('copiar').addEventListener('click', function () {
    var b = this;
    (navigator.clipboard ? navigator.clipboard.writeText(location.href) : Promise.reject()).then(function () {
      b.textContent = 'Enlace copiado';
    }, function () { window.prompt('Copia tu enlace:', location.href); });
  });

  cargar();
  // Revisa si hay respuestas nuevas mientras la página está abierta
  setInterval(function () { if (!document.hidden) cargar(); }, 20000);
})();
