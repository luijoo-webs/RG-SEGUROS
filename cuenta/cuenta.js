/* Mi cuenta (clientes): crear cuenta, ingresar, recuperar contraseña, ver sus solicitudes y datos.
   Las solicitudes se muestran solo si la cuenta confirmó su correo (lo valida el servidor). */
(function () {
  'use strict';
  var C = window.RG_CONFIG || {};
  var app = document.getElementById('app');
  var ESTADOS = { nueva: 'Recibida', en_gestion: 'En gestión', cotizada: 'Cotizada', ganada: 'Cerrada', perdida: 'Cerrada' };
  var WA = 'https://wa.me/573165268039?text=';
  var aqui = location.href.split('#')[0];

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
      [].concat(arguments[i]).forEach(function (h) { if (h != null && h !== false) n.appendChild(typeof h === 'string' ? document.createTextNode(h) : h); });
    }
    return n;
  }
  function pintar() { while (app.firstChild) app.removeChild(app.firstChild); for (var i = 0; i < arguments.length; i++) if (arguments[i]) app.appendChild(arguments[i]); }
  function fecha(iso) { return iso ? new Date(iso).toLocaleDateString('es-CO', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'America/Bogota' }) : ''; }
  function aviso(tipo, texto) { return el('p', { class: 'alert alert--' + tipo, role: tipo === 'error' ? 'alert' : 'status', text: texto }); }
  function campo(id, etiqueta, attrs) {
    return el('div', {}, el('label', { class: 'label', for: id, text: etiqueta }), el('input', Object.assign({ class: 'input', id: id }, attrs)));
  }
  function valor(id) { return document.getElementById(id).value.trim(); }

  if (!C.supabaseUrl || !C.supabaseKey || !window.supabase) {
    pintar(aviso('error', 'Mi cuenta no está disponible en este momento. Escríbenos por WhatsApp al 316 526 8039.'));
    return;
  }
  var sb = window.supabase.createClient(C.supabaseUrl, C.supabaseKey, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });

  // ---------- Sin sesión: ingresar / crear cuenta / recuperar ----------
  function acceso(pestana, mensaje) {
    var tabs = el('div', { class: 'cuenta-tabs', role: 'tablist' },
      el('button', { type: 'button', role: 'tab', 'aria-selected': String(pestana === 'ingresar'), text: 'Ingresar', onclick: function () { acceso('ingresar'); } }),
      el('button', { type: 'button', role: 'tab', 'aria-selected': String(pestana === 'crear'), text: 'Crear cuenta', onclick: function () { acceso('crear'); } }));
    var error = el('p', { class: 'alert alert--error', role: 'alert', hidden: true });
    var mostrarError = function (t) { error.textContent = t; error.hidden = false; };
    var form;

    if (pestana === 'ingresar') {
      form = el('form', { class: 'caso__form', onsubmit: function (e) {
        e.preventDefault(); error.hidden = true;
        var b = form.querySelector('button[type=submit]'); b.disabled = true;
        sb.auth.signInWithPassword({ email: valor('c-correo'), password: document.getElementById('c-clave').value }).then(function (r) {
          if (r.error) mostrarError(/confirm/i.test(r.error.message) ? 'Primero confirma tu correo: revisa tu bandeja de entrada (y la carpeta de spam).' : 'Correo o contraseña incorrectos.');
          else return panel();
        }).catch(function () { mostrarError('No pudimos conectar. Inténtalo de nuevo.'); }).then(function () { b.disabled = false; });
      } },
        campo('c-correo', 'Correo', { type: 'email', autocomplete: 'email', required: true }),
        campo('c-clave', 'Contraseña', { type: 'password', autocomplete: 'current-password', required: true }),
        error,
        el('button', { class: 'btn', type: 'submit', text: 'Ingresar' }),
        el('button', { class: 'link-btn', type: 'button', text: '¿Olvidaste tu contraseña?', onclick: function () {
          var correo = valor('c-correo');
          if (!correo) { mostrarError('Escribe tu correo y vuelve a tocar "¿Olvidaste tu contraseña?".'); return; }
          sb.auth.resetPasswordForEmail(correo, { redirectTo: aqui }).then(function () {
            acceso('ingresar', 'Si el correo tiene una cuenta, te enviamos un enlace para crear una nueva contraseña.');
          });
        } }));
    } else {
      form = el('form', { class: 'caso__form', onsubmit: function (e) {
        e.preventDefault(); error.hidden = true;
        var clave = document.getElementById('c-clave').value;
        if (clave.length < 8) { mostrarError('La contraseña debe tener al menos 8 caracteres.'); return; }
        if (clave !== document.getElementById('c-clave2').value) { mostrarError('Las contraseñas no coinciden.'); return; }
        if (!document.getElementById('c-aut').checked) { mostrarError('Debes autorizar el tratamiento de tus datos para crear la cuenta.'); return; }
        var b = form.querySelector('button[type=submit]'); b.disabled = true;
        sb.auth.signUp({ email: valor('c-correo'), password: clave, options: {
          emailRedirectTo: aqui, data: { tipo: 'cliente', nombre: valor('c-nombre'), telefono: valor('c-tel'), autorizacion: 'si' }
        } }).then(function (r) {
          if (r.error) { mostrarError(/registered|exists/i.test(r.error.message) ? 'Ya existe una cuenta con ese correo. Ingresa o recupera tu contraseña.' : 'No pudimos crear la cuenta: ' + r.error.message); return; }
          if (r.data.session) return panel();
          acceso('ingresar', 'Te enviamos un correo para confirmar tu cuenta. Ábrelo y toca el enlace; después ingresa aquí.');
        }).catch(function () { mostrarError('No pudimos conectar. Inténtalo de nuevo.'); }).then(function () { b.disabled = false; });
      } },
        campo('c-nombre', 'Nombre completo', { autocomplete: 'name', required: true, maxlength: 120 }),
        campo('c-tel', 'Teléfono', { type: 'tel', autocomplete: 'tel', inputmode: 'tel', maxlength: 20 }),
        campo('c-correo', 'Correo', { type: 'email', autocomplete: 'email', required: true }),
        campo('c-clave', 'Contraseña (mínimo 8 caracteres)', { type: 'password', autocomplete: 'new-password', required: true, minlength: 8 }),
        campo('c-clave2', 'Repite la contraseña', { type: 'password', autocomplete: 'new-password', required: true }),
        el('label', { class: 'check', for: 'c-aut' }, el('input', { type: 'checkbox', id: 'c-aut' }),
          el('span', {}, 'Autorizo a RG Asesorías y Seguros Ltda. a tratar mis datos personales según la ', el('a', { href: '../#politica', text: 'Política de tratamiento de datos' }), '.')),
        error,
        el('button', { class: 'btn', type: 'submit', text: 'Crear mi cuenta' }));
    }

    pintar(el('section', { class: 'acceso' },
      el('div', { class: 'acceso__lado' },
        el('p', { class: 'acceso__eyebrow', text: 'RG Asesorías y Seguros' }),
        el('h2', { class: 'acceso__titulo', text: 'Tus seguros, en un solo lugar.' }),
        el('ul', { class: 'acceso__lista' },
          el('li', { text: 'Sigue el estado de cada solicitud' }),
          el('li', { text: 'Conversa directo con tu asesor' }),
          el('li', { text: 'Reporta un siniestro en minutos' }))),
      el('div', { class: 'acceso__form' },
        el('h1', { class: 'h1', text: pestana === 'crear' ? 'Crea tu cuenta' : 'Ingresa a tu cuenta' }),
        el('p', { class: 'muted', text: pestana === 'crear' ? 'Usa el mismo correo con el que pediste tu cotización.' : 'Bienvenido de nuevo.' }),
        tabs, mensaje ? aviso('ok', mensaje) : null, form)));
    var primero = form.querySelector('input'); if (primero) primero.focus();
  }

  // Volvió desde el correo de recuperación
  function nuevaClave(alGuardar) {
    var error = el('p', { class: 'alert alert--error', role: 'alert', hidden: true });
    var form = el('form', { class: 'caso__form', onsubmit: function (e) {
      e.preventDefault();
      var clave = document.getElementById('n-clave').value;
      if (clave.length < 8) { error.textContent = 'La contraseña debe tener al menos 8 caracteres.'; error.hidden = false; return; }
      sb.auth.updateUser({ password: clave }).then(function (r) {
        if (r.error) { error.textContent = 'No pudimos cambiar la contraseña. Pide un enlace nuevo.'; error.hidden = false; return; }
        if (alGuardar) alGuardar(); else panel('Tu contraseña se actualizó.');
      });
    } }, campo('n-clave', 'Nueva contraseña (mínimo 8 caracteres)', { type: 'password', autocomplete: 'new-password', required: true, minlength: 8 }), error,
      el('button', { class: 'btn', type: 'submit', text: 'Guardar contraseña' }));
    pintar(el('section', { class: 'caso__card' }, el('p', { class: 'eyebrow', text: 'Mi cuenta' }), el('h1', { class: 'h1', text: 'Crea una nueva contraseña' }), form));
  }

  var PASOS = [['nueva', 'Recibida'], ['en_gestion', 'En gestión'], ['cotizada', 'Cotizada'], ['fin', 'Cerrada']];
  function progreso(estado) {
    var actual = ['ganada', 'perdida'].indexOf(estado) >= 0 ? 'fin' : estado, ok = true;
    return el('ol', { class: 'progreso', 'aria-label': 'Estado: ' + (ESTADOS[estado] || estado) }, PASOS.map(function (x) {
      var c = x[0] === actual ? 'is-actual' : ok ? 'is-hecho' : '';
      if (x[0] === actual) ok = false;
      return el('li', { class: c }, el('i'), el('span', { text: x[1] }));
    }));
  }

  // ---------- Con sesión ----------
  function panel(mensaje) {
    return sb.rpc('cliente_resumen').then(function (r) {
      if (r.error) throw r.error;
      var d = r.data, p = d.perfil || {};
      var primerNombre = (p.nombre || '').split(' ')[0];

      var acciones = el('div', { class: 'cuenta-acciones' },
        p.rol === 'admin' || p.rol === 'asesor' ? el('a', { class: 'cuenta-accion', href: '../admin/' }, el('b', { text: 'Ir al panel del equipo' }), el('span', { text: 'Gestiona solicitudes y clientes' })) : null,
        el('a', { class: 'cuenta-accion', href: '../#contacto' }, el('b', { text: 'Solicitar una cotización' }), el('span', { text: 'Elige tus seguros y envía tu solicitud' })),
        el('a', { class: 'cuenta-accion', href: WA + encodeURIComponent('Hola, soy ' + (p.nombre || '') + ' y necesito reportar un siniestro'), target: '_blank', rel: 'noopener' }, el('b', { text: 'Reportar un siniestro' }), el('span', { text: 'Te acompañamos en la reclamación' })),
        el('a', { class: 'cuenta-accion', href: 'tel:+573165268039' }, el('b', { text: 'Hablar con un asesor' }), el('span', { text: '316 526 8039 · 316 249 2831' })));

      var lista = el('div', { class: 'cuenta-lista' });
      if (!d.confirmado) lista.appendChild(aviso('info', 'Confirma tu correo para ver tus solicitudes: revisa el mensaje que te enviamos.'));
      else if (!d.solicitudes.length) lista.appendChild(el('div', { class: 'empty' }, 'Aún no tienes solicitudes con este correo. ', el('a', { href: '../#contacto', text: 'Solicita una cotización' }), '.'));
      d.solicitudes.forEach(function (s) {
        lista.appendChild(el('article', { class: 'sol-card' },
          el('div', { class: 'sol-card__top' }, el('b', { text: s.codigo }), el('span', { class: 'pill pill--' + s.estado, text: ESTADOS[s.estado] || s.estado })),
          el('h3', { class: 'sol-card__titulo', text: s.seguros.join(', ') || 'Asesoría general' }),
          el('p', { class: 'muted', style: 'margin:0', text: 'Enviada el ' + fecha(s.creada) }),
          progreso(s.estado),
          el('p', { class: 'sol-card__meta' }, s.asesor ? 'Asesor: ' + s.asesor : 'Pronto te asignaremos un asesor',
            s.respuestas ? el('span', { class: 'sol-card__badge', text: s.respuestas + (s.respuestas === 1 ? ' respuesta' : ' respuestas') }) : null),
          el('a', { class: 'btn btn--sm', href: '../caso/#' + s.token, text: 'Ver conversación' })));
      });

      var datosErr = el('p', { class: 'alert', role: 'status', hidden: true });
      var datos = el('form', { class: 'caso__form', onsubmit: function (e) {
        e.preventDefault();
        sb.rpc('cliente_actualizar', { p_nombre: valor('d-nombre'), p_telefono: valor('d-tel') }).then(function (x) {
          var ok = x.data && x.data.ok;
          datosErr.className = 'alert alert--' + (ok ? 'ok' : 'error');
          datosErr.textContent = ok ? 'Datos guardados.' : ((x.data && x.data.message) || 'No pudimos guardar tus datos.');
          datosErr.hidden = false;
        });
      } },
        campo('d-nombre', 'Nombre', { value: p.nombre || '', required: true, maxlength: 120, autocomplete: 'name' }),
        campo('d-tel', 'Teléfono', { value: p.telefono || '', type: 'tel', maxlength: 20, autocomplete: 'tel' }),
        campo('d-correo', 'Correo', { value: p.email || '', type: 'email', disabled: true }),
        datosErr,
        el('div', { class: 'cuenta-botones' },
          el('button', { class: 'btn btn--sm', type: 'submit', text: 'Guardar datos' }),
          el('button', { class: 'btn btn--line btn--sm', type: 'button', text: 'Cambiar contraseña', onclick: nuevaClave }),
          el('button', { class: 'btn btn--line btn--sm', type: 'button', text: 'Cerrar sesión', onclick: function () { sb.auth.signOut().then(function () { acceso('ingresar'); }); } })));

      var sols = d.solicitudes || [];
      var enCurso = sols.filter(function (s) { return ['nueva', 'en_gestion', 'cotizada'].indexOf(s.estado) >= 0; }).length;
      var resp = sols.reduce(function (a, s) { return a + (s.respuestas || 0); }, 0);
      var nombre = p.nombre || p.email || '';
      pintar(
        el('section', { class: 'cuenta-hero' },
          el('div', { class: 'cuenta-hero__yo' },
            el('span', { class: 'cuenta-hero__avatar', 'aria-hidden': 'true', text: (nombre.charAt(0) || 'R').toUpperCase() }),
            el('div', {},
              el('p', { class: 'cuenta-hero__eyebrow', text: 'Mi cuenta' }),
              el('h1', { class: 'cuenta-hero__nombre', text: 'Hola' + (primerNombre ? ', ' + primerNombre : '') }),
              el('p', { class: 'cuenta-hero__mail', text: p.email || '' }))),
          el('div', { class: 'cuenta-hero__nums' },
            el('div', {}, el('b', { text: String(sols.length) }), el('span', { text: 'Solicitudes' })),
            el('div', {}, el('b', { text: String(enCurso) }), el('span', { text: 'En curso' })),
            el('div', {}, el('b', { text: String(resp) }), el('span', { text: 'Respuestas' })))),
        mensaje ? aviso('ok', mensaje) : null,
        el('div', { class: 'cuenta-grid' },
          el('section', { class: 'caso__card', 'aria-labelledby': 'mis-sol' },
            el('div', { class: 'cuenta-sec' }, el('h2', { id: 'mis-sol', text: 'Mis solicitudes' }), el('a', { class: 'btn btn--sm', href: '../#contacto', text: 'Nueva solicitud' })),
            lista),
          el('div', { class: 'cuenta-col' },
            el('section', { class: 'caso__card' }, el('div', { class: 'cuenta-sec' }, el('h2', { text: '¿Qué necesitas?' })), acciones),
            el('section', { class: 'caso__card', 'aria-labelledby': 'mis-datos' }, el('div', { class: 'cuenta-sec' }, el('h2', { id: 'mis-datos', text: 'Mis datos' })), datos))));
    }).catch(function () { pintar(aviso('error', 'No pudimos cargar tu cuenta. Vuelve a ingresar.')); setTimeout(function () { acceso('ingresar'); }, 1500); });
  }

  // Enlace de activación que la administración entrega a cada persona del equipo.
  // El código va en la parte # para que las vistas previas de los chats no lo gasten: solo esta página lo usa.
  var activar = /^#activar=(invite|recovery):([\w-]+)$/.exec(location.hash);
  if (activar) {
    history.replaceState(null, '', aqui);
    sb.auth.verifyOtp({ token_hash: activar[2], type: activar[1] }).then(function (r) {
      if (r.error) throw r.error;
      nuevaClave(function () { location.href = '../admin/'; });
    }).catch(function () { pintar(aviso('error', 'Este enlace ya se usó o venció. Pídele a la administración uno nuevo.')); });
    return;
  }

  // Se lee al cargar: la librería limpia la URL al procesar el enlace del correo
  var recuperando = /type=recovery/.test(location.hash);
  var vieneDeRegistro = /type=signup/.test(location.hash);
  sb.auth.onAuthStateChange(function (evento) { if (evento === 'PASSWORD_RECOVERY') { recuperando = true; nuevaClave(); } });
  sb.auth.getSession().then(function (r) {
    if (recuperando) return nuevaClave();
    if (r.data && r.data.session) return panel(vieneDeRegistro ? 'Tu correo quedó confirmado. ¡Te damos la bienvenida!' : null);
    acceso('ingresar');
  }).catch(function () { acceso('ingresar'); });
})();
