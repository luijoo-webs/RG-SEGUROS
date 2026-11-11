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
    equipo: 'Equipo', eliminada: 'Eliminada', reclamada: 'Caso reclamado', soltada: 'Devuelta a la bandeja', cerrada: 'Caso cerrado'
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
    if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) iso += 'T12:00:00Z'; // un día sin hora se leería como medianoche UTC = día anterior en Colombia
    return new Date(iso).toLocaleString('es-CO', corta ? { day: 'numeric', month: 'short', timeZone: 'America/Bogota' } : { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'America/Bogota' });
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
  var COP = new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 });
  function plata(n, corta) {
    if (n == null) return '—';
    n = Number(n);
    if (corta && Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace('.', ',') + ' M';
    return COP.format(n);
  }
  function horas(h) { return h == null ? '—' : h < 48 ? Math.round(h) + ' h' : Math.round(h / 24) + ' d'; }
  function hbars(lista, etiqueta, valor, fmt) {
    var tope = Math.max.apply(null, [1].concat(lista.map(function (x) { return Number(x[valor]) || 0; })));
    return lista.length ? lista.map(function (x) {
      var barra = el('i'); barra.style.width = ((Number(x[valor]) || 0) / tope * 100) + '%';
      return el('div', { class: 'hbar' }, el('span', { text: x[etiqueta] }), el('div', {}, barra), el('b', { text: fmt ? fmt(x[valor], true) : String(x[valor]) }));
    }) : el('p', { class: 'muted', text: 'Sin datos en el periodo.' });
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
  var ERRORES = {
    TERMINA_TU_CASO: 'Primero cotiza o cierra tu caso activo; luego reclama el siguiente.',
    YA_RECLAMADA: 'Otra persona reclamó ese caso primero. Toma el siguiente de la bandeja.',
    USA_CERRAR: 'Para cerrar un caso usa «Cerrar con venta» o «Cerrar sin venta».',
    NO_ES_TU_CASO: 'Este caso lo tiene otra persona del equipo.',
    PRIMA_INVALIDA: 'Escribe la prima anual en pesos (mayor que cero).',
    COMISION_INVALIDA: 'La comisión debe estar entre 0 y el valor de la prima.',
    FALTA_ASEGURADORA: 'Indica la aseguradora que emite la póliza.',
    FALTA_MOTIVO: 'Elige el motivo por el que no hubo venta.',
    NO_AUTORIZADO: 'Tu usuario no tiene permiso para esta acción.',
    NO_EXISTE: 'La solicitud ya no existe.'
  };
  function mensajeError(e) {
    var m = (e && e.message) || '';
    var k = Object.keys(ERRORES).filter(function (x) { return m.indexOf(x) >= 0; })[0];
    return k ? ERRORES[k] : 'Ocurrió un error: ' + (m || 'inténtalo de nuevo') + '.';
  }
  function falla(e) { console.error(e); toast(mensajeError(e)); }

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
          yo && yo.rol === 'cliente'
            ? el('p', { class: 'muted', text: 'Este panel es solo para el equipo de RG. Tus solicitudes están en Mi cuenta.' })
            : el('p', { class: 'muted', text: 'Tu cuenta aún no tiene un rol asignado. Pide a la administración que te dé acceso de asesor.' }),
          yo && yo.rol === 'cliente' ? el('a', { class: 'btn', href: '../cuenta/', text: 'Ir a Mi cuenta' }) : null,
          el('button', { class: yo && yo.rol === 'cliente' ? 'btn btn--line' : 'btn', type: 'button', text: 'Cerrar sesión', onclick: salir }))));
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
    var items = [['resumen', 'Resumen', true], ['finanzas', 'Finanzas', true], ['solicitudes', 'Solicitudes'], ['clientes', 'Clientes'], ['actividad', 'Actividad'], ['equipo', 'Equipo', true]];
    badge = el('span', { class: 'badge', hidden: true });
    items.forEach(function (it) {
      if (it[2] && yo.rol !== 'admin') return;
      nav[it[0]] = el('button', { class: 'adm__nav', type: 'button', onclick: function () { side.classList.remove('is-open'); ir(it[0]); } }, it[1], it[0] === 'solicitudes' ? badge : null);
      side.appendChild(nav[it[0]]);
    });
    live = el('span', { class: 'live' }, el('i'), 'Conectando…');
    var nombreYo = yo.nombre || yo.email;
    side.appendChild(el('div', { class: 'adm__me' },
      el('div', { class: 'adm__who' },
        el('span', { class: 'adm__avatar', 'aria-hidden': 'true', text: nombreYo.charAt(0).toUpperCase() }),
        el('div', {}, el('b', { text: nombreYo }), el('small', { text: yo.rol === 'admin' ? 'Administración' : 'Asesor' }))),
      live,
      el('button', { class: 'adm__salir', type: 'button', text: 'Cerrar sesión', onclick: salir })));
    main = el('main', { class: 'adm__main', id: 'contenido' });
    var burger = el('button', { class: 'adm__burger', type: 'button', 'aria-label': 'Abrir menú', onclick: function () { side.classList.toggle('is-open'); } }, el('span'), el('span'), el('span'));
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
    var vistas = { resumen: verResumen, finanzas: verFinanzas, solicitudes: verSolicitudes, clientes: verClientes, actividad: verActividad, equipo: verEquipo };
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
        stat(r.en_cola, 'En la bandeja sin reclamar', r.en_cola > 0),
        stat(r.primera_respuesta_horas == null ? null : r.primera_respuesta_horas + ' h', 'Tiempo 1.ª respuesta'),
        stat(horas(r.resolucion_horas), 'Tiempo hasta el cierre'),
        stat(plata(r.comisiones, true), 'Comisiones del periodo'),
        stat(r.clientes, 'Clientes'),
        stat(r.cuentas, 'Cuentas de clientes'),
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
      var estados = Object.keys(ESTADOS).map(function (k) { return { estado: ESTADOS[k], n: r.por_estado[k] || 0 }; });
      var asesores = el('table', { class: 'table' }, el('thead', {}, el('tr', {}, ['Asesor', 'Activos', 'Asignadas', 'Ganadas', '1.ª respuesta'].map(function (t) { return el('th', { text: t }); }))),
        el('tbody', {}, r.por_asesor.map(function (a) {
          return el('tr', {}, el('td', { text: a.nombre || '—' }), el('td', { text: String(a.activos == null ? '—' : a.activos) }), el('td', { text: String(a.asignadas) }), el('td', { text: String(a.ganadas) }), el('td', { text: a.respuesta_horas == null ? '—' : a.respuesta_horas + ' h' }));
        })));
      main.appendChild(el('div', { class: 'grid2' },
        el('section', { class: 'card' }, el('h2', { text: 'Solicitudes por día' }), barras(mapa), leyenda),
        el('section', { class: 'card' }, el('h2', { text: 'Consultas a RG AI por día' }), barras(mapaAi, 'ai'), leyenda.cloneNode(true)),
        el('section', { class: 'card' }, el('h2', { text: 'Seguros más solicitados' }), hbars(r.por_seguro, 'seguro', 'n')),
        el('section', { class: 'card' }, el('h2', { text: 'Solicitudes por estado' }), hbars(estados, 'estado', 'n')),
        el('section', { class: 'card', style: 'grid-column:1/-1' }, el('h2', { text: 'Rendimiento por asesor' }), el('div', { class: 'table-wrap' }, asesores))));
    });
  }

  // ---------- Solicitudes: bandeja por reclamar y búsqueda ----------
  // Cada persona reclama un caso de la bandeja, lo resuelve (cotiza o cierra) y reclama el siguiente.
  var lista, detalle, zona, modo = 'bandeja';
  var ABIERTOS = ['nueva', 'en_gestion', 'cotizada'];
  function esAbierto(s) { return ABIERTOS.indexOf(s.estado) >= 0; }
  function esMio(s) { return s.asignado_a === yo.id; }
  function puedoGestionar(s) { return yo.rol === 'admin' || esMio(s); }
  function chips(seguros) {
    return el('div', { class: 'chips' }, (seguros.length ? seguros : ['Asesoría general']).map(function (x) { return el('span', { class: 'chip', text: x.replace(/^Seguro (de |)/, '') }); }));
  }
  function espera(iso) {
    var h = (Date.now() - new Date(iso).getTime()) / 3600000;
    return h >= 24 ? 'q--critica' : h >= 2 ? 'q--urgente' : '';
  }

  function verSolicitudes(opciones) {
    if (opciones && opciones.q != null) { modo = 'todas'; filtros.q = opciones.q; filtros.estado = ''; filtros.asignado = ''; }
    var tabs = el('div', { class: 'seg', role: 'tablist', 'aria-label': 'Vista de solicitudes' },
      [['bandeja', 'Bandeja'], ['todas', 'Buscar en todas']].map(function (t) {
        return el('button', { type: 'button', role: 'tab', 'aria-selected': String(modo === t[0]), text: t[1], onclick: function () { modo = t[0]; seleccion = null; ir('solicitudes'); } });
      }));
    vaciar(main).appendChild(cabecera('Gestión', 'Solicitudes', tabs));
    zona = main.appendChild(el('div'));
    lista = null;
    if (modo === 'bandeja') return seleccion ? abrirDetalle(seleccion) : pintarBandeja();
    return pintarTodas();
  }

  function reclamar(id) {
    return rpc('panel_reclamar', { p_id: id || null }).then(function (r) {
      if (!r.ok) { toast('La bandeja está vacía. ¡Buen trabajo!'); return pintarBandeja(); }
      toast('Caso reclamado: ahora es tuyo.');
      modo = 'bandeja';
      return abrirDetalle(r.id);
    }).catch(function (e) { falla(e); if (modo === 'bandeja' && !seleccion) pintarBandeja(); });
  }

  function pintarBandeja(aviso) {
    return Promise.all([
      rpc('panel_solicitudes', { p_estado: 'abiertas', p_asignado: 'mias', p_limite: 50 }),
      rpc('panel_solicitudes', { p_estado: 'abiertas', p_asignado: 'sin_asignar', p_limite: 100 }),
      rpc('panel_solicitudes', { p_estado: 'abiertas', p_asignado: 'equipo', p_limite: 100 })
    ]).then(function (r) {
      if (vista !== 'solicitudes' || modo !== 'bandeja' || seleccion) return;
      var mios = r[0].items, otros = r[2].items;
      var cola = r[1].items.slice().sort(function (a, b) { return new Date(a.created_at) - new Date(b.created_at); });
      var activo = mios.filter(function (s) { return s.estado !== 'cotizada'; })[0];
      var esperando = mios.filter(function (s) { return s.estado === 'cotizada'; });
      var bloqueado = Boolean(activo) && yo.rol !== 'admin';
      badge.textContent = String(cola.length); badge.hidden = !cola.length;
      vaciar(zona);

      if (aviso) zona.appendChild(el('div', { class: 'celebra' + (aviso === 'ganada' ? ' celebra--venta' : '') },
        el('b', { text: aviso === 'ganada' ? '¡Venta registrada!' : 'Caso cerrado' }),
        el('span', { text: cola.length ? 'Hay ' + cola.length + (cola.length === 1 ? ' solicitud esperando' : ' solicitudes esperando') + ' en la bandeja.' : 'No quedan solicitudes en la bandeja.' })));

      zona.appendChild(el('div', { class: 'kpis' },
        el('div', { class: 'kpi' + (cola.length ? ' kpi--alerta' : '') }, el('b', { text: String(cola.length) }), el('span', { text: 'Por reclamar' })),
        el('div', { class: 'kpi' }, el('b', { text: String(mios.length) }), el('span', { text: 'Mis casos' })),
        el('div', { class: 'kpi' }, el('b', { text: String(esperando.length) }), el('span', { text: 'Cotizados, esperan al cliente' })),
        el('div', { class: 'kpi' }, el('b', { text: String(otros.length) }), el('span', { text: 'En manos del equipo' }))));

      // Mi caso activo (o invitación a reclamar el siguiente)
      if (activo) {
        zona.appendChild(el('section', { class: 'activo', 'aria-label': 'Mi caso activo' },
          el('div', {},
            el('p', { class: 'activo__eyebrow', text: 'Tu caso activo · ' + activo.codigo }),
            el('h2', { class: 'activo__nombre', text: activo.nombre + ' ' + activo.apellido }),
            chips(activo.seguros),
            el('p', { class: 'activo__meta', text: 'Lo reclamaste ' + hace(activo.reclamada_at || activo.ultimo_mensaje_at) + (activo.pendiente_equipo ? ' · el cliente espera tu respuesta' : '') })),
          el('button', { class: 'btn btn--yellow btn--grande', type: 'button', text: 'Continuar el caso', onclick: function () { abrirDetalle(activo.id); } })));
      } else {
        zona.appendChild(el('section', { class: 'activo activo--libre', 'aria-label': 'Reclamar' },
          el('div', {},
            el('p', { class: 'activo__eyebrow', text: 'Sin caso activo' }),
            el('h2', { class: 'activo__nombre', text: cola.length ? 'Toma el siguiente caso' : 'La bandeja está al día' }),
            el('p', { class: 'activo__meta', text: cola.length ? 'Se asigna la solicitud que lleva más tiempo esperando: ' + cola[0].codigo + ', recibida ' + hace(cola[0].created_at) + '.' : 'Cuando entre una solicitud nueva te avisaremos aquí.' })),
          el('button', { class: 'btn btn--yellow btn--grande', type: 'button', disabled: !cola.length, text: 'Reclamar siguiente', onclick: function () { this.disabled = true; reclamar(null); } })));
      }

      // Bandeja
      var grid = el('div', { class: 'qgrid' });
      if (!cola.length) grid.appendChild(el('div', { class: 'empty', text: 'No hay solicitudes por reclamar.' }));
      cola.forEach(function (s) {
        grid.appendChild(el('article', { class: 'q ' + espera(s.created_at) },
          el('div', { class: 'q__top' }, el('b', { text: s.codigo }), el('span', { class: 'q__espera', text: 'Espera ' + hace(s.created_at).replace('hace ', '') })),
          el('h3', { class: 'q__nombre', text: s.nombre + ' ' + s.apellido }),
          chips(s.seguros),
          s.mensaje ? el('p', { class: 'q__msg', text: '“' + s.mensaje + (s.mensaje.length >= 180 ? '…' : '') + '”' }) : null,
          el('div', { class: 'q__acciones' },
            el('button', { class: 'btn btn--sm', type: 'button', disabled: bloqueado, title: bloqueado ? 'Primero cotiza o cierra tu caso activo' : null, text: 'Reclamar', onclick: function () { this.disabled = true; reclamar(s.id); } }),
            el('button', { class: 'btn btn--line btn--sm', type: 'button', text: 'Ver', onclick: function () { abrirDetalle(s.id); } }))));
      });
      zona.appendChild(el('section', { class: 'bloque' },
        el('div', { class: 'bloque__head' }, el('h2', { text: 'Bandeja por reclamar' }),
          bloqueado ? el('span', { class: 'muted', text: 'Termina tu caso activo para reclamar otro.' }) : null),
        grid));

      if (esperando.length) zona.appendChild(el('section', { class: 'bloque' }, el('div', { class: 'bloque__head' }, el('h2', { text: 'Mis cotizaciones en espera' })), tablaCasos(esperando, false)));
      if (otros.length) zona.appendChild(el('section', { class: 'bloque' }, el('div', { class: 'bloque__head' }, el('h2', { text: 'En manos del equipo' })), tablaCasos(otros, true)));
    });
  }

  function tablaCasos(items, conAsesor) {
    return el('div', { class: 'table-wrap' }, el('table', { class: 'table' },
      el('thead', {}, el('tr', {}, ['Código', 'Cliente', 'Estado'].concat(conAsesor ? ['A cargo de'] : [], ['Movimiento']).map(function (t) { return el('th', { scope: 'col', text: t }); }))),
      el('tbody', {}, items.map(function (s) {
        return el('tr', { class: 'click', tabindex: 0, onclick: function () { abrirDetalle(s.id); }, onkeydown: function (e) { if (e.key === 'Enter') abrirDetalle(s.id); } },
          el('td', {}, s.pendiente_equipo ? el('span', { class: 'dot', title: 'Espera respuesta' }) : null, ' ', el('b', { text: s.codigo })),
          el('td', {}, el('div', { text: s.nombre + ' ' + s.apellido }), el('small', { class: 'muted', text: s.seguros.join(', ') || 'Asesoría general' })),
          el('td', {}, pill(s.estado)),
          conAsesor ? el('td', { class: 'muted', text: s.asignado_nombre || '—' }) : null,
          el('td', { class: 'muted', text: hace(s.ultimo_mensaje_at) }));
      }))));
  }

  function pintarTodas() {
    var q = el('input', { class: 'input', type: 'search', placeholder: 'Buscar por nombre, correo, teléfono, código o seguro', value: filtros.q, 'aria-label': 'Buscar' });
    var tq;
    q.addEventListener('input', function () { clearTimeout(tq); tq = setTimeout(function () { filtros.q = q.value.trim(); cargarLista(); }, 300); });
    var est = el('select', { class: 'select', 'aria-label': 'Estado', onchange: function () { filtros.estado = this.value; cargarLista(); } },
      [['abiertas', 'Abiertas'], ['', 'Todas']].concat(Object.keys(ESTADOS).map(function (k) { return [k, ESTADOS[k]]; }))
        .map(function (o) { return el('option', { value: o[0], selected: filtros.estado === o[0], text: o[1] }); }));
    var asg = el('select', { class: 'select', 'aria-label': 'Asignación', onchange: function () { filtros.asignado = this.value; cargarLista(); } },
      [['', 'Todo el equipo'], ['mias', 'Mis casos'], ['sin_asignar', 'En la bandeja'], ['equipo', 'De otros asesores']].map(function (o) { return el('option', { value: o[0], selected: filtros.asignado === o[0], text: o[1] }); }));
    lista = el('div');
    detalle = el('div');
    zona.appendChild(el('div', { class: 'toolbar' }, q, est, asg));
    zona.appendChild(el('div', { class: 'split' }, lista, detalle));
    if (seleccion) abrirDetalle(seleccion);
    else detalle.appendChild(el('div', { class: 'empty', text: 'Selecciona una solicitud para ver el caso.' }));
    return cargarLista();
  }

  function cargarLista() {
    if (!lista) return Promise.resolve();
    return rpc('panel_solicitudes', { p_estado: filtros.estado || null, p_busqueda: filtros.q || null, p_asignado: filtros.asignado || null, p_limite: 100, p_offset: 0 })
      .then(function (r) {
        vaciar(lista);
        if (!r.items.length) { lista.appendChild(el('div', { class: 'empty', text: 'No hay solicitudes con estos filtros.' })); return; }
        lista.appendChild(el('p', { class: 'muted', style: 'margin:0 0 8px;font-size:.82rem', text: r.total + (r.total === 1 ? ' solicitud' : ' solicitudes') }));
        lista.appendChild(tablaCasos(r.items, true));
        Array.prototype.forEach.call(lista.querySelectorAll('tr.click'), function (tr, i) { tr.dataset.id = r.items[i].id; tr.classList.toggle('is-sel', r.items[i].id === seleccion); });
      });
  }

  function abrirDetalle(id) {
    seleccion = id;
    if (vista !== 'solicitudes') return ir('solicitudes');
    if (lista) Array.prototype.forEach.call(lista.querySelectorAll('tr.click'), function (tr) { tr.classList.toggle('is-sel', tr.dataset.id === id); });
    return rpc('panel_solicitud', { p_id: id }).then(function (s) {
      if (seleccion !== id) return;
      if (modo === 'bandeja') {
        if (!detalle || !zona.contains(detalle) || detalle.dataset.id !== id) {
          vaciar(zona).appendChild(el('button', { class: 'link-btn volver', type: 'button', text: '← Volver a la bandeja', onclick: function () { seleccion = null; pintarBandeja(); } }));
          detalle = zona.appendChild(el('div', { class: 'detalle-full' }));
        }
      }
      pintarDetalle(s);
    }).catch(function (e) {
      if (/NO_EXISTE/.test(e.message)) { seleccion = null; toast('La solicitud ya no existe.'); ir('solicitudes'); } else falla(e);
    });
  }

  function registrar(id, canalContacto) { rpc('panel_registrar_contacto', { p_id: id, p_canal: canalContacto }).catch(falla); }

  var MOTIVOS = ['Precio', 'Eligió otra aseguradora o agencia', 'El cliente no respondió', 'Ya no lo necesita', 'No cumple los requisitos', 'Otro'];
  function dialogoCierre(s, resultado) {
    var venta = resultado === 'ganada';
    var err = el('p', { class: 'alert alert--error', role: 'alert', hidden: true });
    var aseg = el('input', { class: 'input', id: 'c-aseg', maxlength: 80, required: true, autocomplete: 'off', placeholder: 'Ej.: la compañía que emite la póliza' });
    var prima = el('input', { class: 'input', id: 'c-prima', type: 'number', min: 1, step: 1, required: true, inputmode: 'numeric' });
    var comision = el('input', { class: 'input', id: 'c-comision', type: 'number', min: 0, step: 1, required: true, inputmode: 'numeric' });
    var pct = el('small', { class: 'muted' });
    var calc = function () { var p = Number(prima.value), c = Number(comision.value); pct.textContent = p > 0 && c >= 0 ? plata(c) + ' = ' + (c / p * 100).toFixed(1).replace('.', ',') + ' % de ' + plata(p) : ''; };
    prima.addEventListener('input', calc); comision.addEventListener('input', calc);
    var motivo = el('select', { class: 'select', id: 'c-motivo', required: true }, [el('option', { value: '', text: 'Elige un motivo' })].concat(MOTIVOS.map(function (m) { return el('option', { value: m, text: m }); })));
    var nota = el('textarea', { class: 'textarea', id: 'c-nota', maxlength: 240, placeholder: 'Detalle (opcional)' });
    var dlg = el('dialog', { class: 'modal', 'aria-labelledby': 'c-titulo' });
    var enviar = el('button', { class: venta ? 'btn btn--yellow' : 'btn', type: 'submit', text: venta ? 'Registrar venta' : 'Cerrar sin venta' });
    dlg.appendChild(el('form', { class: 'modal__form', onsubmit: function (e) {
      e.preventDefault(); err.hidden = true; enviar.disabled = true;
      var args = venta ? { p_id: s.id, p_resultado: 'ganada', p_prima: Number(prima.value), p_comision: Number(comision.value), p_aseguradora: aseg.value }
        : { p_id: s.id, p_resultado: 'perdida', p_motivo: motivo.value + (nota.value.trim() ? ' – ' + nota.value.trim() : '') };
      sb.rpc('panel_cerrar', args).then(function (r) {
        if (r.error) { err.textContent = mensajeError(r.error); err.hidden = false; enviar.disabled = false; return; }
        dlg.close(); seleccion = null; modo = 'bandeja';
        ir('solicitudes').then(function () { return pintarBandeja(resultado); });
      });
    } },
      el('p', { class: 'eyebrow', text: s.codigo + ' · ' + s.nombre + ' ' + s.apellido }),
      el('h2', { class: 'h1', id: 'c-titulo', style: 'font-size:1.3rem', text: venta ? 'Cerrar con venta' : 'Cerrar sin venta' }),
      venta ? el('div', { class: 'modal__campos' },
        el('div', {}, el('label', { class: 'label', for: 'c-aseg', text: 'Aseguradora' }), aseg),
        el('div', {}, el('label', { class: 'label', for: 'c-prima', text: 'Prima anual (COP)' }), prima),
        el('div', {}, el('label', { class: 'label', for: 'c-comision', text: 'Comisión de RG (COP)' }), comision, pct))
        : el('div', { class: 'modal__campos' },
          el('div', {}, el('label', { class: 'label', for: 'c-motivo', text: 'Motivo' }), motivo),
          el('div', {}, el('label', { class: 'label', for: 'c-nota', text: 'Detalle' }), nota)),
      err,
      el('div', { class: 'modal__acciones' },
        el('button', { class: 'btn btn--line', type: 'button', text: 'Cancelar', onclick: function () { dlg.close(); } }), enviar)));
    dlg.addEventListener('close', function () { dlg.remove(); });
    document.body.appendChild(dlg);
    dlg.showModal();
    (venta ? aseg : motivo).focus();
  }

  var PASOS = [['nueva', 'Recibida'], ['en_gestion', 'En gestión'], ['cotizada', 'Cotizada'], ['cerrada', 'Cerrada']];
  function pintarDetalle(s) {
    var mismo = detalle.dataset.id === s.id;
    var borrador = mismo && detalle.querySelector('#d-texto') ? detalle.querySelector('#d-texto').value : '';
    detalle.dataset.id = s.id;
    var url = casoUrl(s.token);
    var firma = (yo.nombre || 'el equipo') + ' de RG Asesorías y Seguros';
    var textoContacto = 'Hola ' + s.nombre + ', te escribe ' + firma + ' sobre tu solicitud ' + s.codigo + '. También puedes ver y responder aquí: ' + url;
    var abierto = esAbierto(s), mio = esMio(s), gestiono = puedoGestionar(s);
    var recargar = function () { abrirDetalle(s.id); };

    var contacto = el('div', { class: 'detail__actions' },
      el('a', { class: 'btn btn--sm btn--wa', href: 'https://wa.me/' + telefonoWa(s.telefono) + '?text=' + encodeURIComponent(textoContacto), target: '_blank', rel: 'noopener', text: 'WhatsApp', onclick: function () { registrar(s.id, 'whatsapp'); } }),
      el('a', { class: 'btn btn--line btn--sm', href: 'tel:+' + telefonoWa(s.telefono), text: 'Llamar', onclick: function () { registrar(s.id, 'llamada'); } }),
      el('a', { class: 'btn btn--line btn--sm', href: 'mailto:' + s.email + '?subject=' + encodeURIComponent('Tu solicitud ' + s.codigo + ' · RG Asesorías y Seguros') + '&body=' + encodeURIComponent(textoContacto), text: 'Correo', onclick: function () { registrar(s.id, 'correo'); } }),
      el('button', { class: 'btn btn--line btn--sm', type: 'button', text: 'Copiar enlace del caso', onclick: function () {
        var b = this;
        (navigator.clipboard ? navigator.clipboard.writeText(url) : Promise.reject()).then(function () { b.textContent = 'Enlace copiado'; registrar(s.id, 'enlace'); }, function () { window.prompt('Enlace del caso:', url); });
      } }));

    // Pasos del caso
    var actual = abierto ? s.estado : 'cerrada', llegado = true;
    var pasos = el('ol', { class: 'pasos' }, PASOS.map(function (p) {
      var cls = p[0] === actual ? 'is-actual' : llegado ? 'is-hecho' : '';
      if (p[0] === actual) llegado = false;
      return el('li', { class: cls }, el('i'), el('span', { text: p[0] === 'cerrada' && !abierto ? ESTADOS[s.estado] : p[1] }));
    }));

    // Acciones principales según quién mira y en qué punto va el caso
    var principales = el('div', { class: 'hero__acciones' });
    if (abierto && !s.asignado_a) {
      principales.appendChild(el('button', { class: 'btn btn--yellow btn--grande', type: 'button', text: 'Reclamar este caso', onclick: function () { this.disabled = true; reclamar(s.id); } }));
    } else if (abierto && gestiono) {
      if (s.estado !== 'cotizada') principales.appendChild(el('button', { class: 'btn btn--white', type: 'button', text: 'Marcar como cotizada', onclick: function () {
        rpc('panel_actualizar', { p_id: s.id, p_estado: 'cotizada' }).then(function () { toast('Caso cotizado. Ya puedes reclamar otro mientras el cliente decide.'); recargar(); }).catch(falla);
      } }));
      principales.appendChild(el('button', { class: 'btn btn--yellow', type: 'button', text: 'Cerrar con venta', onclick: function () { dialogoCierre(s, 'ganada'); } }));
      principales.appendChild(el('button', { class: 'btn btn--ghost', type: 'button', text: 'Cerrar sin venta', onclick: function () { dialogoCierre(s, 'perdida'); } }));
      principales.appendChild(el('button', { class: 'link-btn link-btn--claro', type: 'button', text: 'Devolver a la bandeja', onclick: function () {
        if (!window.confirm('¿Devolver ' + s.codigo + ' a la bandeja para que otra persona la reclame?')) return;
        rpc('panel_soltar', { p_id: s.id }).then(function () { toast('Caso devuelto a la bandeja.'); seleccion = null; ir('solicitudes'); }).catch(falla);
      } }));
    } else if (!abierto) {
      principales.appendChild(el('div', { class: 'cierre' + (s.estado === 'ganada' ? ' cierre--venta' : '') },
        s.estado === 'ganada'
          ? [el('b', { text: 'Venta con ' + (s.aseguradora || '—') }), el('span', { text: 'Prima ' + plata(s.prima) + ' · Comisión ' + plata(s.comision) })]
          : [el('b', { text: 'Sin venta' }), el('span', { text: s.motivo_cierre || '' })]));
      if (gestiono) principales.appendChild(el('button', { class: 'link-btn link-btn--claro', type: 'button', text: 'Reabrir caso', onclick: function () {
        if (!window.confirm('¿Reabrir ' + s.codigo + '? Se borrarán los datos del cierre.')) return;
        rpc('panel_actualizar', { p_id: s.id, p_estado: 'en_gestion' }).then(function () { toast('Caso reabierto.'); recargar(); }).catch(falla);
      } }));
    }

    var quien = s.asignado_a ? (mio ? 'ti' : s.asignado_nombre || 'otro asesor') : null;
    var hero = el('div', { class: 'hero hero--' + s.estado },
      el('div', { class: 'hero__top' },
        el('p', { class: 'hero__eyebrow', text: s.codigo + ' · recibida ' + fecha(s.created_at) }),
        s.pendiente_equipo && abierto ? el('span', { class: 'hero__alerta', text: 'El cliente espera respuesta' }) : null),
      el('h2', { class: 'hero__nombre', text: s.nombre + ' ' + s.apellido }),
      chips(s.seguros),
      el('p', { class: 'hero__meta', text: quien ? 'A cargo de ' + quien + (s.reclamada_at ? ' · desde ' + hace(s.reclamada_at) : '') : 'En la bandeja · esperando ' + hace(s.created_at).replace('hace ', '') }),
      pasos, principales);

    // Solo la administración reasigna
    var asignar = yo.rol === 'admin' ? el('select', { class: 'select', id: 'd-asignado', onchange: function () {
      var v = this.value;
      rpc('panel_actualizar', v ? { p_id: s.id, p_asignado_a: v } : { p_id: s.id, p_quitar_asignacion: true })
        .then(function () { toast('Asignación actualizada.'); recargar(); }).catch(falla);
    } }, [el('option', { value: '', text: 'En la bandeja (sin asignar)' })].concat(equipo.filter(function (p) { return p.rol !== 'ninguno'; })
      .map(function (p) { return el('option', { value: p.id, selected: p.id === s.asignado_a, text: p.nombre || p.email }); }))) : null;

    var hilo = el('div', { class: 'thread' });
    if (!s.mensajes.length) hilo.appendChild(el('p', { class: 'muted', text: 'Sin mensajes todavía.' }));
    s.mensajes.forEach(function (m) {
      hilo.appendChild(el('div', { class: 'msg msg--' + (m.interno ? 'interno' : m.autor) }, m.texto,
        el('small', { text: (m.interno ? 'Nota interna · ' : '') + (m.autor === 'cliente' ? s.nombre : (m.por || 'Equipo')) + ' · ' + fecha(m.fecha) })));
    });

    var texto = el('textarea', { class: 'textarea', id: 'd-texto', maxlength: 4000, placeholder: 'Escribe tu respuesta al cliente…', 'aria-label': 'Mensaje' });
    texto.value = borrador;
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
      }).catch(falla).then(function () { enviar.disabled = false; texto.value = ''; recargar(); });
    } },
      texto,
      el('div', { class: 'composer__row' },
        el('label', { class: 'check', for: 'd-interno' }, interno, 'Nota interna (el cliente no la ve)'),
        el('div', { style: 'display:flex;gap:6px' },
          s.pendiente_equipo ? el('button', { class: 'btn btn--line btn--sm', type: 'button', text: 'Marcar atendida', onclick: function () {
            rpc('panel_marcar_atendida', { p_id: s.id }).then(recargar).catch(falla);
          } }) : null,
          enviar)));

    var actividad = el('details', { style: 'margin-top:18px' }, el('summary', { class: 'label', style: 'cursor:pointer', text: 'Historial del caso (' + s.actividad.length + ')' }),
      el('ul', { class: 'timeline' }, s.actividad.map(function (a) {
        return el('li', {}, el('time', { text: fecha(a.fecha) }), el('b', { text: TIPOS[a.tipo] || a.tipo }), ' ', a.detalle ? '· ' + a.detalle : '', a.por ? ' · ' + a.por : '');
      })));

    var eliminar = yo.rol === 'admin' ? el('button', { class: 'btn btn--danger btn--sm', type: 'button', text: 'Eliminar datos (Ley 1581)', onclick: function () {
      if (!window.confirm('¿Eliminar definitivamente la solicitud ' + s.codigo + ' y su conversación? Úsalo solo si el titular pidió la supresión de sus datos.')) return;
      rpc('panel_eliminar_solicitud', { p_id: s.id }).then(function () { seleccion = null; toast('Solicitud eliminada.'); ir('solicitudes'); }).catch(falla);
    } }) : null;

    vaciar(detalle).appendChild(el('section', { class: 'detail', 'aria-label': 'Solicitud ' + s.codigo },
      hero,
      el('div', { class: 'detail__body' },
        el('div', { class: 'detail__grid' },
          el('div', { class: 'kv' }, el('span', { text: 'Correo' }), s.email),
          el('div', { class: 'kv' }, el('span', { text: 'Teléfono' }), s.telefono),
          el('div', { class: 'kv' }, el('span', { text: 'Autorización de datos' }), fecha(s.autorizacion_at)),
          s.otras > 0 ? el('div', { class: 'kv' }, el('span', { text: 'Historial' }), el('a', { href: '#', text: s.otras + ' solicitud(es) más de este cliente', onclick: function (e) { e.preventDefault(); seleccion = null; ir('solicitudes', { q: s.email }); } })) : null,
          asignar ? el('div', {}, el('label', { class: 'label', for: 'd-asignado', text: 'Asignar (administración)' }), asignar) : null),
        contacto,
        el('h3', { class: 'label', style: 'margin-top:18px', text: 'Conversación' }), hilo, actividad,
        eliminar ? el('div', { style: 'margin-top:18px' }, eliminar) : null),
      composer));
    var body = detalle.querySelector('.detail__body');
    if (!mismo) body.scrollTop = body.scrollHeight;
  }

  // ---------- Finanzas (solo admin) ----------
  var diasFin = 365;
  function verFinanzas() {
    return rpc('panel_finanzas', { p_dias: diasFin }).then(function (f) {
      var sel = el('select', { class: 'select', 'aria-label': 'Periodo', onchange: function () { diasFin = Number(this.value); ir('finanzas'); } },
        [[30, 'Últimos 30 días'], [90, 'Últimos 90 días'], [365, 'Último año'], [730, 'Últimos 2 años']].map(function (d) { return el('option', { value: d[0], selected: d[0] === diasFin, text: d[1] }); }));
      var csv = el('button', { class: 'btn btn--line btn--sm', type: 'button', text: 'Exportar ventas (CSV)', disabled: !f.lista.length, onclick: function () { exportarCsv(f.lista); } });
      vaciar(main).appendChild(cabecera('Plan Pro · Finanzas', 'Finanzas', el('div', { style: 'display:flex;gap:8px;align-items:center;flex-wrap:wrap' }, sel, csv)));
      var stat = function (n, t, cls) { return el('div', { class: 'stat' + (cls ? ' ' + cls : '') }, el('b', { text: n == null ? '—' : String(n) }), el('span', { text: t })); };
      main.appendChild(el('div', { class: 'stats' },
        stat(plata(f.comisiones, true), 'Comisiones de RG', 'stat--oro'),
        stat(plata(f.primas, true), 'Primas vendidas'),
        stat(f.ventas, 'Pólizas vendidas'),
        stat(plata(f.ticket, true), 'Prima promedio'),
        stat(f.pct_comision == null ? null : String(f.pct_comision).replace('.', ',') + ' %', 'Comisión promedio'),
        stat(f.tasa_cierre == null ? null : f.tasa_cierre + ' %', 'Tasa de cierre'),
        stat(f.cotizadas, 'Cotizaciones abiertas'),
        stat(f.perdidas, 'Cerradas sin venta')));
      if (!f.ventas) main.appendChild(el('div', { class: 'empty', style: 'margin-bottom:18px', text: 'Aún no hay ventas en este periodo. Cuando un asesor cierre un caso con venta (prima, comisión y aseguradora), aparecerá aquí.' }));

      var tope = Math.max.apply(null, [1].concat(f.por_mes.map(function (m) { return Number(m.comisiones) || 0; })));
      var meses = el('div', { class: 'mbars', role: 'img', 'aria-label': 'Comisiones por mes' }, f.por_mes.map(function (m) {
        var b = el('i'); b.style.height = ((Number(m.comisiones) || 0) / tope * 100) + '%';
        var nombre = new Date(m.mes + '-15T12:00:00Z').toLocaleDateString('es-CO', { month: 'short', timeZone: 'America/Bogota' });
        return el('div', { title: m.mes + ': ' + plata(m.comisiones) + ' en ' + m.ventas + ' venta(s)' }, el('small', { text: m.comisiones > 0 ? plata(m.comisiones, true) : '' }), el('span', {}, b), el('em', { text: nombre }));
      }));
      var asesores = el('table', { class: 'table' }, el('thead', {}, el('tr', {}, ['Asesor', 'Ventas', 'Sin venta', 'Primas', 'Comisiones', 'Resolución'].map(function (t) { return el('th', { scope: 'col', text: t }); }))),
        el('tbody', {}, f.por_asesor.length ? f.por_asesor.map(function (a) {
          return el('tr', {}, el('td', { text: a.nombre || '—' }), el('td', { text: String(a.ventas) }), el('td', { text: String(a.perdidas) }), el('td', { text: plata(a.primas) }), el('td', {}, el('b', { text: plata(a.comisiones) })), el('td', { text: a.resolucion_horas == null ? '—' : horas(a.resolucion_horas) }));
        }) : el('tr', {}, el('td', { colspan: 6, class: 'muted', text: 'Sin cierres en el periodo.' }))));
      var ventas = el('table', { class: 'table' }, el('thead', {}, el('tr', {}, ['Fecha', 'Código', 'Cliente', 'Seguro', 'Aseguradora', 'Prima', 'Comisión', 'Asesor'].map(function (t) { return el('th', { scope: 'col', text: t }); }))),
        el('tbody', {}, f.lista.slice(0, 50).map(function (v) {
          return el('tr', {}, el('td', { text: fecha(v.fecha, true) }), el('td', {}, el('b', { text: v.codigo })), el('td', { text: v.cliente }), el('td', { class: 'muted', text: (v.seguros || []).join(', ') }),
            el('td', { text: v.aseguradora || '—' }), el('td', { text: plata(v.prima) }), el('td', {}, el('b', { text: plata(v.comision) })), el('td', { class: 'muted', text: v.asesor || '—' }));
        })));
      main.appendChild(el('div', { class: 'grid2' },
        el('section', { class: 'card', style: 'grid-column:1/-1' }, el('h2', { text: 'Comisiones por mes (últimos 12 meses)' }), meses),
        el('section', { class: 'card' }, el('h2', { text: 'Comisiones por aseguradora' }), hbars(f.por_aseguradora, 'aseguradora', 'comisiones', plata)),
        el('section', { class: 'card' }, el('h2', { text: 'Ventas por tipo de seguro' }), hbars(f.por_seguro, 'seguro', 'n')),
        el('section', { class: 'card' }, el('h2', { text: 'Por qué se pierden casos' }), hbars(f.motivos, 'motivo', 'n')),
        el('section', { class: 'card' }, el('h2', { text: 'Resultado por asesor' }), el('div', { class: 'table-wrap' }, asesores)),
        f.lista.length ? el('section', { class: 'card', style: 'grid-column:1/-1' }, el('h2', { text: 'Últimas ventas' }), el('div', { class: 'table-wrap' }, ventas)) : null));
    });
  }
  function exportarCsv(lista) {
    var c = function (x) { x = x == null ? '' : String(x); return /[;"\n]/.test(x) ? '"' + x.replace(/"/g, '""') + '"' : x; };
    var filas = [['Fecha', 'Código', 'Cliente', 'Seguros', 'Aseguradora', 'Prima', 'Comisión', 'Asesor']].concat(lista.map(function (v) {
      return [String(v.fecha).slice(0, 10), v.codigo, v.cliente, (v.seguros || []).join(', '), v.aseguradora, v.prima, v.comision, v.asesor];
    }));
    var blob = new Blob(['﻿' + filas.map(function (f) { return f.map(c).join(';'); }).join('\r\n')], { type: 'text/csv;charset=utf-8' });
    var a = el('a', { href: URL.createObjectURL(blob), download: 'ventas-rg-' + new Date().toISOString().slice(0, 10) + '.csv' });
    document.body.appendChild(a); a.click(); a.remove();
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
  var MOTIVOS_USUARIO = { ya_existe: 'Ese correo ya tiene una cuenta. Si es de un cliente, usa otro correo para el equipo.', datos: 'Revisa el nombre y el correo.', no_autorizado: 'Solo la administración puede crear usuarios.' };
  // Pide a la Edge Function el código de activación; la contraseña la elige cada persona
  function pedirEnlace(cuerpo) {
    return sb.functions.invoke('crear-usuario', { body: cuerpo }).then(function (r) {
      var d = r.data || {};
      if (!d.ok) throw new Error(MOTIVOS_USUARIO[d.motivo] || 'No se pudo generar el acceso. Inténtalo de nuevo');
      return { email: d.email, url: new URL('../cuenta/', location.href).href + '#activar=' + d.tipo + ':' + d.codigo };
    });
  }
  function cajaEnlace(enlace) {
    var campo = el('input', { class: 'input', readonly: true, value: enlace.url, 'aria-label': 'Enlace de activación' });
    return el('section', { class: 'card', style: 'margin-bottom:16px' },
      el('h2', { text: 'Enlace para ' + enlace.email }),
      el('p', { class: 'muted', text: 'Envíaselo solo a esa persona: con él elige su contraseña y entra al panel. Sirve una vez y vence en 24 horas. No lo abras en este navegador.' }),
      campo,
      el('div', { class: 'detail__actions' },
        el('button', { class: 'btn btn--sm', type: 'button', text: 'Copiar enlace', onclick: function () {
          campo.select();
          navigator.clipboard.writeText(enlace.url).then(function () { toast('Enlace copiado.'); }, function () { toast('Selecciona el enlace y cópialo.'); });
        } }),
        el('a', { class: 'btn btn--sm btn--line', href: 'https://wa.me/?text=' + encodeURIComponent('Hola, este es tu acceso al panel de RG Asesorías y Seguros. Ábrelo para crear tu contraseña: ' + enlace.url), target: '_blank', rel: 'noopener', text: 'Enviar por WhatsApp' })));
  }

  function verEquipo(enlace) {
    return rpc('panel_equipo').then(function (lista) {
      equipo = lista;
      vaciar(main).appendChild(cabecera('Accesos', 'Equipo'));
      if (enlace) main.appendChild(cajaEnlace(enlace));
      var nuevoNombre = el('input', { class: 'input', id: 'u-nombre', required: true, maxlength: 120, autocomplete: 'off' });
      var nuevoCorreo = el('input', { class: 'input', id: 'u-correo', type: 'email', required: true, autocomplete: 'off' });
      var nuevoRol = el('select', { class: 'select', id: 'u-rol' }, [['asesor', 'Asesor: solicitudes y clientes'], ['admin', 'Administración: todo, con estadísticas']].map(function (o) { return el('option', { value: o[0], text: o[1] }); }));
      var crear = el('button', { class: 'btn btn--sm', type: 'submit', text: 'Crear usuario' });
      main.appendChild(el('section', { class: 'card', style: 'margin-bottom:16px' }, el('h2', { text: 'Crear usuario' }),
        el('form', { class: 'caso__form', onsubmit: function (e) {
          e.preventDefault(); crear.disabled = true;
          pedirEnlace({ nombre: nuevoNombre.value, email: nuevoCorreo.value, rol: nuevoRol.value })
            .then(function (x) { toast('Usuario creado.'); return verEquipo(x); }).catch(falla).then(function () { crear.disabled = false; });
        } },
          el('label', { class: 'label', for: 'u-nombre', text: 'Nombre' }), nuevoNombre,
          el('label', { class: 'label', for: 'u-correo', text: 'Correo' }), nuevoCorreo,
          el('label', { class: 'label', for: 'u-rol', text: 'Rol' }), nuevoRol,
          el('div', {}, crear))));
      main.appendChild(el('div', { class: 'table-wrap' }, el('table', { class: 'table' },
        el('thead', {}, el('tr', {}, ['Nombre', 'Correo', 'Rol', ''].map(function (t) { return el('th', { scope: 'col', text: t }); }))),
        el('tbody', {}, lista.map(function (p) {
          var nombre = el('input', { class: 'input', value: p.nombre, 'aria-label': 'Nombre de ' + p.email, maxlength: 120 });
          var rol = el('select', { class: 'select', 'aria-label': 'Rol de ' + p.email, disabled: p.id === yo.id },
            [['asesor', 'Asesor'], ['admin', 'Administración'], ['ninguno', 'Sin acceso']].map(function (o) { return el('option', { value: o[0], selected: o[0] === p.rol, text: o[1] }); }));
          return el('tr', {}, el('td', {}, nombre), el('td', { text: p.email }), el('td', {}, rol),
            el('td', {}, el('button', { class: 'btn btn--sm', type: 'button', text: 'Guardar', onclick: function () {
              rpc('panel_cambiar_rol', { p_usuario: p.id, p_rol: rol.value, p_nombre: nombre.value }).then(function () { toast('Cambios guardados.'); verEquipo(); }).catch(falla);
            } }), ' ', p.id === yo.id ? null : el('button', { class: 'btn btn--sm btn--line', type: 'button', text: 'Enlace de acceso', title: 'Para quien no activó a tiempo u olvidó su contraseña', onclick: function () {
              pedirEnlace({ usuario_id: p.id }).then(function (x) { return verEquipo(x); }).catch(falla);
            } })));
        })))));
    });
  }

  // ---------- Tiempo real y respaldo por consulta periódica ----------
  var refrescoTimer;
  function refrescar() {
    clearTimeout(refrescoTimer);
    refrescoTimer = setTimeout(function () {
      if (document.querySelector('dialog[open]')) return; // no interrumpir un cierre a medio escribir
      if (vista === 'solicitudes') {
        if (seleccion) abrirDetalle(seleccion);
        if (modo === 'bandeja' && !seleccion) pintarBandeja().catch(falla); else cargarLista().catch(falla);
      } else if (vista === 'resumen' || vista === 'actividad' || vista === 'finanzas') ir(vista);
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
