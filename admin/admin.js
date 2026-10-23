/* RG Asesorías y Seguros — Panel del equipo (admin y asesores).
   Todos los datos pasan por funciones del servidor (panel_*) que validan el rol.
   El texto de clientes se inserta siempre como texto (nunca como HTML). */
(function () {
  'use strict';

  var C = window.RG_CONFIG || {};
  var app = document.getElementById('app');
  var ESTADOS = { nueva: 'Nueva', en_gestion: 'En gestión', cotizada: 'Cotizada', ganada: 'Ganada', perdida: 'Perdida' };
  var TIPOS = {
    solicitud_creada: 'Nueva solicitud', mensaje_cliente: 'Mensaje del cliente', mensaje_asesor: 'Respuesta al cliente',
    nota_interna: 'Nota interna', estado: 'Cambio de estado', asignacion: 'Asignación', contacto: 'Contacto', atendida: 'Atendida',
    equipo: 'Equipo', eliminada: 'Eliminada'
  };

  // ---------- Utilidades DOM (texto seguro) ----------
  function el(tag, attrs) {
    var n = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      var v = attrs[k];
      if (v == null || v === false) return;
      if (k === 'text') n.textContent = v;
      else if (k === 'class') n.className = v;
      else if (k.slice(0, 2) === 'on') n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? '' : v);
    });
    for (var i = 2; i < arguments.length; i++) {
      var h = arguments[i];
      (Array.isArray(h) ? h : [h]).forEach(function (x) { if (x != null && x !== false) n.appendChild(typeof x === 'string' ? document.createTextNode(x) : x); });
    }
    return n;
  }
  function vaciar(n) { while (n.firstChild) n.removeChild(n.firstChild); return n; }
  function fecha(iso, corta) {
    if (!iso) return '—';
    return new Date(iso).toLocaleString('es-CO', corta ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'America/Bogota' });
  }
  function hace(iso) {
    var m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (m < 1) return 'ahora';
    if (m < 60) return 'hace ' + m + ' min';
    if (m < 1440) return 'hace ' + Math.round(m / 60) + ' h';
    return 'hace ' + Math.round(m / 1440) + ' d';
  }
  function pill(estado) { return el('span', { class: 'pill pill--' + estado, text: ESTADOS[estado] || estado }); }
  var toastTimer;
  function toast(texto) {
    var t = document.querySelector('.toast') || document.body.appendChild(el('div', { class: 'toast', role: 'status' }));
    t.textContent = texto; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.hidden = true; }, 5000);
  }
  function telefonoWa(t) {
    var d = String(t || '').replace(/\D/g, '');
    if (d.length === 10 && d.charAt(0) === '3') return '57' + d;
    return d;
  }
  function casoUrl(token) { return new URL('../caso/#' + token, location.href).href; }

  // ---------- Sin configuración ----------
  if (!C.supabaseUrl || !C.supabaseKey || !window.supabase) {
    vaciar(app).appendChild(el('div', { class: 'login' }, el('div', { class: 'login__box' },
      el('p', { class: 'eyebrow', text: 'Configuración pendiente' }),
      el('h1', { class: 'h1', text: 'Panel no conectado' }),
      el('p', { class: 'muted', text: 'Falta la URL y la clave pública de Supabase en config.js (ver supabase/INSTRUCCIONES.md).' }))));
    return;
  }

  var sb = window.supabase.createClient(C.supabaseUrl, C.supabaseKey, { auth: { persistSession: true, autoRefreshToken: true } });
  var yo = null, equipo = [], vista = null, seleccion = null, canal = null;
  var filtros = { estado: 'abiertas', asignado: '', q: '' };
  var main, nav = {};

  function rpc(fn, args) {
    return sb.rpc(fn, args || {}).then(function (r) {
      if (r.error) {
        if (/NO_AUTORIZADO|JWT|not authenticated/i.test(r.error.message)) toast('Tu sesión no tiene permisos para esta acción.');
        throw r.error;
      }
      return r.data;
    });
  }
  function falla(e) { console.error(e); toast('Ocurrió un error: ' + (e && e.message ? e.message : 'inténtalo de nuevo') + '.'); }

  // ---------- Inicio de sesión ----------
  function pantallaLogin(mensaje) {
    if (canal) { sb.removeChannel(canal); canal = null; }
    var err = el('p', { class: 'alert alert--error', role: 'alert', hidden: !mensaje, text: mensaje || '' });
    var correo = el('input', { class: 'input', id: 'l-correo', type: 'email', autocomplete: 'username', required: true });
    var clave = el('input', { class: 'input', id: 'l-clave', type: 'password', autocomplete: 'current-password', required: true });
    var boton = el('button', { class: 'btn', type: 'submit', text: 'Entrar' });
    var form = el('form', {
      onsubmit: function (e) {
        e.preventDefault(); err.hidden = true; boton.disabled = true;
        sb.auth.signInWithPassword({ email: correo.value.trim(), password: clave.value }).then(function (r) {
          if (r.error) { err.textContent = 'Correo o contraseña incorrectos.'; err.hidden = false; return; }
          return iniciar();
        }).catch(falla).then(function () { boton.disabled = false; });
      }
    },
      el('div', {}, el('label', { class: 'label', for: 'l-correo', text: 'Correo' }), correo),
      el('div', {}, el('label', { class: 'label', for: 'l-clave', text: 'Contraseña' }), clave),
      err, boton);
    vaciar(app).appendChild(el('div', { class: 'login' }, el('div', { class: 'login__box' },
      el('img', { src: '../assets/logo-rg.png', alt: '' }),
      el('p', { class: 'eyebrow', text: 'RG Asesorías y Seguros' }),
      el('h1', { class: 'h1', text: 'Panel del equipo' }),
      el('p', { class: 'muted', text: 'Acceso privado para la administración y los asesores.' }),
      form,
      el('p', { style: 'margin:16px 0 0;font-size:.85rem' }, el('a', { href: '../', text: '← Volver al sitio' })))));
    correo.focus();
  }

  function iniciar() {
    return rpc('panel_yo').then(function (p) {
      yo = p;
      if (!yo || (yo.rol !== 'admin' && yo.rol !== 'asesor')) {
        vaciar(app).appendChild(el('div', { class: 'login' }, el('div', { class: 'login__box' },
          el('h1', { class: 'h1', text: 'Sin permisos' }),
          el('p', { class: 'muted', text: 'Tu cuenta aún no tiene un rol asignado. Pide a la administración que te dé acceso de asesor.' }),
          el('button', { class: 'btn', type: 'button', text: 'Cerrar sesión', onclick: salir }))));
        return;
      }
      return rpc('panel_equipo').then(function (e) { equipo = e; armarShell(); ir(yo.rol === 'admin' ? 'resumen' : 'solicitudes'); escucharCambios(); });
    }).catch(function (e) { falla(e); pantallaLogin('No se pudo validar tu sesión. Ingresa de nuevo.'); });
  }
  function salir() { sb.auth.signOut().then(function () { pantallaLogin(); }); }

  // ---------- Estructura del panel ----------
  var badge, live;
  function armarShell() {
    var side = el('aside', { class: 'adm__side', 'aria-label': 'Menú del panel' });
    side.appendChild(el('a', { class: 'adm__brand', href: '../' }, el('img', { src: '../assets/logo-rg.png', alt: '' }),
      el('span', {}, el('b', { text: 'RG' }), el('small', { text: 'Panel del equipo' }))));
    var items = [['resumen', 'Resumen', true], ['solicitudes', 'Solicitudes'], ['clientes', 'Clientes'], ['actividad', 'Actividad'], ['equipo', 'Equipo', true]];
    badge = el('span', { class: 'badge', hidden: true });
    items.forEach(function (it) {
      if (it[2] && yo.rol !== 'admin') return;
      nav[it[0]] = el('button', { class: 'adm__nav', type: 'button', onclick: function () { side.classList.remove('is-open'); ir(it[0]); } }, it[1], it[0] === 'solicitudes' ? badge : null);
      side.appendChild(nav[it[0]]);
    });
    live = el('span', { class: 'live' }, el('i'), 'Conectando…');
    side.appendChild(el('div', { class: 'adm__me' }, el('b', { text: yo.nombre || yo.email }),
      el('span', { class: 'muted', text: yo.rol === 'admin' ? 'Administración' : 'Asesor' }), el('br'), live,
      el('button', { class: 'btn btn--line btn--sm', type: 'button', text: 'Cerrar sesión', onclick: salir })));
    main = el('main', { class: 'adm__main', id: 'contenido' });
    var burger = el('button', { class: 'btn btn--line btn--sm adm__burger', type: 'button', text: 'Menú', onclick: function () { side.classList.toggle('is-open'); } });
    main.burger = burger;
    vaciar(app).appendChild(el('div', { class: 'adm' }, side, main));
  }
  function cabecera(eyebrow, titulo, extra) {
    return el('div', { class: 'adm__head' }, el('div', {}, main.burger, el('p', { class: 'eyebrow', text: eyebrow }), el('h1', { class: 'h1', text: titulo })), extra || null);
  }
  function ir(v, opciones) {
    vista = v;
    Object.keys(nav).forEach(function (k) { if (k === v) nav[k].setAttribute('aria-current', 'page'); else nav[k].removeAttribute('aria-current'); });
    vaciar(main).appendChild(el('p', { class: 'muted', text: 'Cargando…' }));
    var vistas = { resumen: verResumen, solicitudes: verSolicitudes, clientes: verClientes, actividad: verActividad, equipo: verEquipo };
    return (vistas[v] || verSolicitudes)(opciones).catch(falla);
  }

  // ---------- Resumen (solo admin) ----------
  var dias = 30;
  function verResumen() {
    return rpc('panel_resumen', { p_dias: dias }).then(function (r) {
      var sel = el('select', { class: 'select', 'aria-label': 'Periodo', onchange: function () { dias = Number(this.value); ir('resumen'); } },
        [7, 30, 90, 365].map(function (d) { return el('option', { value: d, selected: d === dias, text: 'Últimos ' + d + ' días' }); }));
      vaciar(main).appendChild(cabecera('Rendimiento del negocio', 'Resumen', sel));
      var stat = function (n, t, alerta) { return el('div', { class: 'stat' + (alerta ? ' stat--alert' : '') }, el('b', { text: n == null ? '—' : String(n) }), el('span', { text: t })); };
      main.appendChild(el('div', { class: 'stats' },
        stat(r.total, 'Solicitudes del periodo'),
        stat(r.abiertas, 'Abiertas ahora'),
        stat(r.sin_responder, 'Esperan respuesta', r.sin_responder > 0),
        stat(r.tasa_cierre == null ? null : r.tasa_cierre + ' %', 'Tasa de cierre'),
        stat(r.primera_respuesta_horas == null ? null : r.primera_respuesta_horas + ' h', 'Tiempo 1.ª respuesta'),
        stat(r.clientes, 'Clientes'),
        stat(r.rg_ai, 'Consultas a RG AI')));

      // Serie diaria (solicitudes y RG AI)
      var mapa = {}, mapaAi = {};
      r.por_dia.forEach(function (x) { mapa[x.dia] = x.n; });
      r.rg_ai_por_dia.forEach(function (x) { mapaAi[x.dia] = x.n; });
      var dd = [], hoy = new Date();
      for (var i = Math.min(dias, 90) - 1; i >= 0; i--) { var d = new Date(hoy); d.setDate(d.getDate() - i); dd.push(d.toLocaleDateString('en-CA', { timeZone: 'America/Bogota' })); }
      var max = Math.max(1, Math.max.apply(null, dd.map(function (k) { return Math.max(mapa[k] || 0, mapaAi[k] || 0); })));
      var barras = function (m, cls) {
        return el('div', { class: 'bars', role: 'img', 'aria-label': 'Por día' }, dd.map(function (k) {
          var b = el('i', { class: cls || '', title: k + ': ' + (m[k] || 0) }); b.style.height = ((m[k] || 0) / max * 100) + '%'; return b;
        }));
      };
      var leyenda = el('div', { class: 'bars-legend' }, el('span', { text: fecha(dd[0], true) }), el('span', { text: fecha(dd[dd.length - 1], true) }));
      var hbars = function (lista, campo) {
        var tope = Math.max.apply(null, [1].concat(lista.map(function (x) { return x.n; })));
        return lista.length ? lista.map(function (x) {
          var barra = el('i'); barra.style.width = (x.n / tope * 100) + '%';
          return el('div', { class: 'hbar' }, el('span', { text: x[campo] }), el('div', {}, barra), el('b', { text: String(x.n) }));
        }) : el('p', { class: 'muted', text: 'Sin datos en el periodo.' });
      };
      var estados = Object.keys(ESTADOS).map(function (k) { return { estado: ESTADOS[k], n: r.por_estado[k] || 0 }; });
      var asesores = el('table', { class: 'table' }, el('thead', {}, el('tr', {}, ['Asesor', 'Asignadas', 'Ganadas', '1.ª respuesta'].map(function (t) { return el('th', { text: t }); }))),
        el('tbody', {}, r.por_asesor.map(function (a) {
          return el('tr', {}, el('td', { text: a.nombre || '—' }), el('td', { text: String(a.asignadas) }), el('td', { text: String(a.ganadas) }), el('td', { text: a.respuesta_horas == null ? '—' : a.respuesta_horas + ' h' }));
        })));
      main.appendChild(el('div', { class: 'grid2' },
        el('section', { class: 'card' }, el('h2', { text: 'Solicitudes por día' }), barras(mapa), leyenda),
        el('section', { class: 'card' }, el('h2', { text: 'Consultas a RG AI por día' }), barras(mapaAi, 'ai'), leyenda.cloneNode(true)),
        el('section', { class: 'card' }, el('h2', { text: 'Seguros más solicitados' }), hbars(r.por_seguro, 'seguro')),
        el('section', { class: 'card' }, el('h2', { text: 'Solicitudes por estado' }), hbars(estados, 'estado')),
        el('section', { class: 'card', style: 'grid-column:1/-1' }, el('h2', { text: 'Rendimiento por asesor' }), el('div', { class: 'table-wrap' }, asesores))));
    });
  }

  // ---------- Solicitudes ----------
  var lista, detalle;
  function verSolicitudes(opciones) {
    if (opciones && opciones.q != null) { filtros.q = opciones.q; filtros.estado = ''; filtros.asignado = ''; }
    var q = el('input', { class: 'input', type: 'search', placeholder: 'Buscar por nombre, correo, teléfono, código o seguro', value: filtros.q, 'aria-label': 'Buscar' });
    var tq;
    q.addEventListener('input', function () { clearTimeout(tq); tq = setTimeout(function () { filtros.q = q.value.trim(); cargarLista(); }, 300); });
    var est = el('select', { class: 'select', 'aria-label': 'Estado', onchange: function () { filtros.estado = this.value; cargarLista(); } },
      [['abiertas', 'Abiertas'], ['', 'Todas']].concat(Object.keys(ESTADOS).map(function (k) { return [k, ESTADOS[k]]; }))
        .map(function (o) { return el('option', { value: o[0], selected: filtros.estado === o[0], text: o[1] }); }));
    var asg = el('select', { class: 'select', 'aria-label': 'Asignación', onchange: function () { filtros.asignado = this.value; cargarLista(); } },
      [['', 'Todo el equipo'], ['mias', 'Asignadas a mí'], ['sin_asignar', 'Sin asignar']].map(function (o) { return el('option', { value: o[0], selected: filtros.asignado === o[0], text: o[1] }); }));
    lista = el('div');
    detalle = el('div');
    vaciar(main).appendChild(cabecera('Gestión', 'Solicitudes'));
    main.appendChild(el('div', { class: 'toolbar' }, q, est, asg));
    main.appendChild(el('div', { class: 'split' }, lista, detalle));
    if (seleccion) abrirDetalle(seleccion);
    else detalle.appendChild(el('div', { class: 'empty', text: 'Selecciona una solicitud para ver la conversación.' }));
    return cargarLista();
  }

  function cargarLista() {
    return rpc('panel_solicitudes', { p_estado: filtros.estado || null, p_busqueda: filtros.q || null, p_asignado: filtros.asignado || null, p_limite: 100, p_offset: 0 })
      .then(function (r) {
        var pendientes = r.items.filter(function (s) { return s.pendiente_equipo; }).length;
        badge.textContent = String(pendientes); badge.hidden = !pendientes || filtros.estado !== 'abiertas';
        vaciar(lista);
        if (!r.items.length) { lista.appendChild(el('div', { class: 'empty', text: 'No hay solicitudes con estos filtros.' })); return; }
        var tbody = el('tbody');
        r.items.forEach(function (s) {
          var tr = el('tr', { class: 'click' + (s.id === seleccion ? ' is-sel' : ''), tabindex: 0, onclick: function () { abrirDetalle(s.id); }, onkeydown: function (e) { if (e.key === 'Enter') abrirDetalle(s.id); } },
            el('td', {}, s.pendiente_equipo ? el('span', { class: 'dot', title: 'Espera respuesta', 'aria-label': 'Espera respuesta' }) : null, ' ', el('b', { text: s.codigo })),
            el('td', {}, el('div', { text: s.nombre + ' ' + s.apellido }), el('small', { class: 'muted', text: s.seguros.join(', ') || 'Sin seguro indicado' })),
            el('td', {}, pill(s.estado)),
            el('td', { class: 'muted', text: s.asignado_nombre || 'Sin asignar' }),
            el('td', { class: 'muted', text: hace(s.ultimo_mensaje_at) }));
          tr.dataset.id = s.id;
          tbody.appendChild(tr);
        });
        lista.appendChild(el('p', { class: 'muted', style: 'margin:0 0 8px;font-size:.82rem', text: r.total + (r.total === 1 ? ' solicitud' : ' solicitudes') }));
        lista.appendChild(el('div', { class: 'table-wrap' }, el('table', { class: 'table' },
          el('thead', {}, el('tr', {}, ['Código', 'Cliente', 'Estado', 'Asesor', 'Movimiento'].map(function (t) { return el('th', { scope: 'col', text: t }); }))), tbody)));
      });
  }

  function abrirDetalle(id) {
    seleccion = id;
    if (vista !== 'solicitudes') return ir('solicitudes');
    Array.prototype.forEach.call(lista.querySelectorAll('tr.click'), function (tr) { tr.classList.toggle('is-sel', tr.dataset.id === id); });
    return rpc('panel_solicitud', { p_id: id }).then(pintarDetalle).catch(function (e) {
      if (/NO_EXISTE/.test(e.message)) { seleccion = null; vaciar(detalle).appendChild(el('div', { class: 'empty', text: 'La solicitud ya no existe.' })); } else falla(e);
    });
  }

  function registrar(id, canalContacto) { rpc('panel_registrar_contacto', { p_id: id, p_canal: canalContacto }).then(function () { cargarLista(); }).catch(falla); }

  function pintarDetalle(s) {
    var url = casoUrl(s.token);
    var firma = (yo.nombre || 'el equipo') + ' de RG Asesorías y Seguros';
    var textoContacto = 'Hola ' + s.nombre + ', te escribe ' + firma + ' sobre tu solicitud ' + s.codigo + '. También puedes ver y responder aquí: ' + url;
    var acciones = el('div', { class: 'detail__actions' },
      el('a', { class: 'btn btn--sm', href: 'https://wa.me/' + telefonoWa(s.telefono) + '?text=' + encodeURIComponent(textoContacto), target: '_blank', rel: 'noopener', text: 'WhatsApp', onclick: function () { registrar(s.id, 'whatsapp'); } }),
      el('a', { class: 'btn btn--line btn--sm', href: 'tel:+' + telefonoWa(s.telefono), text: 'Llamar', onclick: function () { registrar(s.id, 'llamada'); } }),
      el('a', { class: 'btn btn--line btn--sm', href: 'mailto:' + s.email + '?subject=' + encodeURIComponent('Tu solicitud ' + s.codigo + ' · RG Asesorías y Seguros') + '&body=' + encodeURIComponent(textoContacto), text: 'Correo', onclick: function () { registrar(s.id, 'correo'); } }),
      el('button', { class: 'btn btn--line btn--sm', type: 'button', text: 'Copiar enlace del caso', onclick: function () {
        var b = this;
        (navigator.clipboard ? navigator.clipboard.writeText(url) : Promise.reject()).then(function () { b.textContent = 'Enlace copiado'; registrar(s.id, 'enlace'); }, function () { window.prompt('Enlace del caso:', url); });
      } }));

    var estado = el('select', { class: 'select', id: 'd-estado', onchange: function () {
      rpc('panel_actualizar', { p_id: s.id, p_estado: this.value }).then(function () { toast('Estado actualizado.'); cargarLista(); abrirDetalle(s.id); }).catch(falla);
    } }, Object.keys(ESTADOS).map(function (k) { return el('option', { value: k, selected: k === s.estado, text: ESTADOS[k] }); }));
    var asignar = el('select', { class: 'select', id: 'd-asignado', onchange: function () {
      var v = this.value;
      rpc('panel_actualizar', v ? { p_id: s.id, p_asignado_a: v } : { p_id: s.id, p_quitar_asignacion: true })
        .then(function () { toast('Asignación actualizada.'); cargarLista(); abrirDetalle(s.id); }).catch(falla);
    } }, [el('option', { value: '', text: 'Sin asignar' })].concat(equipo.filter(function (p) { return p.rol !== 'ninguno'; })
      .map(function (p) { return el('option', { value: p.id, selected: p.id === s.asignado_a, text: p.nombre || p.email }); })));

    var hilo = el('div', { class: 'thread' });
    if (!s.mensajes.length) hilo.appendChild(el('p', { class: 'muted', text: 'Sin mensajes todavía. Escribe al cliente: recibirá un correo con el enlace a su caso (si el correo automático está configurado).' }));
    s.mensajes.forEach(function (m) {
      hilo.appendChild(el('div', { class: 'msg msg--' + (m.interno ? 'interno' : m.autor) }, m.texto,
        el('small', { text: (m.interno ? 'Nota interna · ' : '') + (m.autor === 'cliente' ? s.nombre : (m.por || 'Equipo')) + ' · ' + fecha(m.fecha) })));
    });

    var texto = el('textarea', { class: 'textarea', id: 'd-texto', maxlength: 4000, placeholder: 'Escribe tu respuesta al cliente…', 'aria-label': 'Mensaje' });
    var interno = el('input', { type: 'checkbox', id: 'd-interno' });
    var enviar = el('button', { class: 'btn', type: 'submit', text: 'Enviar' });
    interno.addEventListener('change', function () { texto.placeholder = interno.checked ? 'Nota interna para el equipo (el cliente no la ve)…' : 'Escribe tu respuesta al cliente…'; enviar.textContent = interno.checked ? 'Guardar nota' : 'Enviar'; });
    var composer = el('form', { class: 'composer', onsubmit: function (e) {
      e.preventDefault();
      var t = texto.value.trim(); if (!t) { texto.focus(); return; }
      var esNota = interno.checked;
      enviar.disabled = true;
      rpc('panel_enviar_mensaje', { p_id: s.id, p_texto: t, p_interno: esNota }).then(function (r) {
        texto.value = '';
        if (esNota) { toast('Nota interna guardada.'); return; }
        return sb.functions.invoke('notificar-cliente', { body: { mensaje_id: r.mensaje_id } }).then(function (n) {
          var d = n.data || {};
          if (d.ok) toast('Mensaje enviado. El cliente recibió un correo con el enlace a su caso.');
          else if (d.motivo === 'smtp_no_configurado') toast('Mensaje guardado en el caso. El correo automático no está configurado: avísale por WhatsApp o copia el enlace del caso.');
          else toast('Mensaje guardado en el caso, pero el correo no se pudo enviar. Avísale por WhatsApp o copia el enlace.');
        });
      }).catch(falla).then(function () { enviar.disabled = false; cargarLista(); abrirDetalle(s.id); });
    } },
      texto,
      el('div', { class: 'composer__row' },
        el('label', { class: 'check', for: 'd-interno' }, interno, 'Nota interna (el cliente no la ve)'),
        el('div', { style: 'display:flex;gap:6px' },
          s.pendiente_equipo ? el('button', { class: 'btn btn--line btn--sm', type: 'button', text: 'Marcar atendida', onclick: function () {
            rpc('panel_marcar_atendida', { p_id: s.id }).then(function () { cargarLista(); abrirDetalle(s.id); }).catch(falla);
          } }) : null,
          enviar)));

    var actividad = el('details', { style: 'margin-top:18px' }, el('summary', { class: 'label', style: 'cursor:pointer', text: 'Actividad (' + s.actividad.length + ')' }),
      el('ul', { class: 'timeline' }, s.actividad.map(function (a) {
        return el('li', {}, el('time', { text: fecha(a.fecha) }), el('b', { text: TIPOS[a.tipo] || a.tipo }), ' ', a.detalle ? '· ' + a.detalle : '', a.por ? ' · ' + a.por : '');
      })));

    var eliminar = yo.rol === 'admin' ? el('button', { class: 'btn btn--danger btn--sm', type: 'button', text: 'Eliminar datos (Ley 1581)', onclick: function () {
      if (!window.confirm('¿Eliminar definitivamente la solicitud ' + s.codigo + ' y su conversación? Úsalo solo si el titular pidió la supresión de sus datos.')) return;
      rpc('panel_eliminar_solicitud', { p_id: s.id }).then(function () { seleccion = null; toast('Solicitud eliminada.'); ir('solicitudes'); }).catch(falla);
    } }) : null;

    vaciar(detalle).appendChild(el('section', { class: 'detail', 'aria-label': 'Solicitud ' + s.codigo },
      el('div', { class: 'detail__head' },
        el('p', { class: 'eyebrow', text: s.codigo + ' · ' + fecha(s.created_at) }),
        el('h2', { class: 'h1', style: 'font-size:1.35rem', text: s.nombre + ' ' + s.apellido }),
        acciones),
      el('div', { class: 'detail__body' },
        el('div', { class: 'detail__grid' },
          el('div', {}, el('label', { class: 'label', for: 'd-estado', text: 'Estado' }), estado),
          el('div', {}, el('label', { class: 'label', for: 'd-asignado', text: 'Asesor' }), asignar),
          el('div', { class: 'kv' }, el('span', { text: 'Correo' }), s.email),
          el('div', { class: 'kv' }, el('span', { text: 'Teléfono' }), s.telefono),
          el('div', { class: 'kv' }, el('span', { text: 'Seguros de interés' }), s.seguros.join(', ') || '—'),
          el('div', { class: 'kv' }, el('span', { text: 'Autorización de datos' }), fecha(s.autorizacion_at)),
          s.otras > 0 ? el('div', { class: 'kv' }, el('span', { text: 'Historial' }), el('a', { href: '#', text: s.otras + ' solicitud(es) más de este cliente', onclick: function (e) { e.preventDefault(); seleccion = null; ir('solicitudes', { q: s.email }); } })) : null),
        el('h3', { class: 'label', text: 'Conversación' }), hilo, actividad,
        eliminar ? el('div', { style: 'margin-top:18px' }, eliminar) : null),
      composer));
    var body = detalle.querySelector('.detail__body');
    body.scrollTop = body.scrollHeight;
  }

  // ---------- Clientes ----------
  function verClientes() {
    var q = el('input', { class: 'input', type: 'search', placeholder: 'Buscar cliente', 'aria-label': 'Buscar cliente' });
    var cont = el('div');
    var cargar = function () {
      return rpc('panel_clientes', { p_busqueda: q.value.trim() || null }).then(function (c) {
        vaciar(cont);
        if (!c.length) { cont.appendChild(el('div', { class: 'empty', text: 'Sin clientes todavía.' })); return; }
        cont.appendChild(el('div', { class: 'table-wrap' }, el('table', { class: 'table' },
          el('thead', {}, el('tr', {}, ['Cliente', 'Contacto', 'Solicitudes', 'Ganadas', 'Última', 'Estado'].map(function (t) { return el('th', { scope: 'col', text: t }); }))),
          el('tbody', {}, c.map(function (x) {
            return el('tr', { class: 'click', tabindex: 0, onclick: function () { seleccion = null; ir('solicitudes', { q: x.email }); }, onkeydown: function (e) { if (e.key === 'Enter') { seleccion = null; ir('solicitudes', { q: x.email }); } } },
              el('td', {}, el('b', { text: x.nombre })), el('td', {}, el('div', { text: x.email }), el('small', { class: 'muted', text: x.telefono })),
              el('td', { text: String(x.solicitudes) }), el('td', { text: String(x.ganadas) }), el('td', { class: 'muted', text: fecha(x.ultima, true) }), el('td', {}, pill(x.ultimo_estado)));
          })))));
      });
    };
    var t;
    q.addEventListener('input', function () { clearTimeout(t); t = setTimeout(function () { cargar().catch(falla); }, 300); });
    vaciar(main).appendChild(cabecera('Cartera', 'Clientes'));
    main.appendChild(el('div', { class: 'toolbar' }, q));
    main.appendChild(cont);
    return cargar();
  }

  // ---------- Actividad ----------
  function verActividad() {
    return rpc('panel_actividad', { p_limite: 150 }).then(function (a) {
      vaciar(main).appendChild(cabecera('Registro', 'Actividad'));
      if (!a.length) { main.appendChild(el('div', { class: 'empty', text: 'Sin actividad todavía.' })); return; }
      main.appendChild(el('div', { class: 'card' }, el('ul', { class: 'timeline' }, a.map(function (x) {
        return el('li', {}, el('time', { text: fecha(x.fecha) }), el('b', { text: TIPOS[x.tipo] || x.tipo }),
          x.codigo ? el('span', {}, ' · ', el('a', { href: '#', text: x.codigo + ' ' + (x.cliente || ''), onclick: function (e) { e.preventDefault(); ir('solicitudes').then(function () { abrirDetalle(x.solicitud_id); }); } })) : null,
          x.detalle ? ' · ' + x.detalle : '', x.por ? ' · ' + x.por : '');
      }))));
    });
  }

  // ---------- Equipo (solo admin) ----------
  function verEquipo() {
    return rpc('panel_equipo').then(function (lista) {
      equipo = lista;
      vaciar(main).appendChild(cabecera('Accesos', 'Equipo'));
      main.appendChild(el('p', { class: 'alert alert--info', text: 'Para dar acceso a una persona nueva: en Supabase → Authentication → Users → "Add user" crea su usuario con correo y contraseña. Aparecerá aquí sin permisos; asígnale el rol "Asesor" o "Administración".' }));
      main.appendChild(el('div', { class: 'table-wrap' }, el('table', { class: 'table' },
        el('thead', {}, el('tr', {}, ['Nombre', 'Correo', 'Rol', ''].map(function (t) { return el('th', { scope: 'col', text: t }); }))),
        el('tbody', {}, lista.map(function (p) {
          var nombre = el('input', { class: 'input', value: p.nombre, 'aria-label': 'Nombre de ' + p.email, maxlength: 120 });
          var rol = el('select', { class: 'select', 'aria-label': 'Rol de ' + p.email, disabled: p.id === yo.id },
            [['asesor', 'Asesor'], ['admin', 'Administración'], ['ninguno', 'Sin acceso']].map(function (o) { return el('option', { value: o[0], selected: o[0] === p.rol, text: o[1] }); }));
          return el('tr', {}, el('td', {}, nombre), el('td', { text: p.email }), el('td', {}, rol),
            el('td', {}, el('button', { class: 'btn btn--sm', type: 'button', text: 'Guardar', onclick: function () {
              rpc('panel_cambiar_rol', { p_usuario: p.id, p_rol: rol.value, p_nombre: nombre.value }).then(function () { toast('Cambios guardados.'); verEquipo(); }).catch(falla);
            } })));
        })))));
    });
  }

  // ---------- Tiempo real y respaldo por consulta periódica ----------
  var refrescoTimer;
  function refrescar() {
    clearTimeout(refrescoTimer);
    refrescoTimer = setTimeout(function () {
      if (vista === 'solicitudes') { cargarLista().catch(falla); if (seleccion) abrirDetalle(seleccion); }
      else if (vista === 'resumen' || vista === 'actividad') ir(vista);
    }, 400);
  }
  function escucharCambios() {
    canal = sb.channel('panel-rg')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'solicitudes' }, function () { toast('Nueva solicitud recibida.'); refrescar(); })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'mensajes' }, function (p) { if (p.new && p.new.autor === 'cliente') toast('Nuevo mensaje de un cliente.'); refrescar(); })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'solicitudes' }, refrescar)
      .subscribe(function (estado) {
        var on = estado === 'SUBSCRIBED';
        live.classList.toggle('on', on);
        live.lastChild.textContent = on ? 'En vivo' : 'Actualización cada minuto';
      });
    setInterval(function () { if (!document.hidden && !live.classList.contains('on')) refrescar(); }, 60000);
  }

  // ---------- Arranque ----------
  sb.auth.onAuthStateChange(function (evento) { if (evento === 'SIGNED_OUT') pantallaLogin(); });
  sb.auth.getSession().then(function (r) { if (r.data && r.data.session) iniciar(); else pantallaLogin(); }).catch(function () { pantallaLogin(); });
})();
