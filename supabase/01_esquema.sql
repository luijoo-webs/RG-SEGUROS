-- =============================================================================
-- RG ASESORÍAS Y SEGUROS — Base de datos (Supabase)
-- Cómo usarlo: Supabase → SQL Editor → New query → pegar TODO → Run.
-- Es re-ejecutable: no borra datos.
--
-- Seguridad
--   * Ninguna tabla se puede leer ni escribir directamente desde el navegador
--     público (RLS activado sin políticas para "anon").
--   * El público solo puede: crear una solicitud (crear_solicitud) y ver/responder
--     su propio caso con el enlace secreto (caso_ver / caso_responder).
--   * El equipo (roles admin/asesor) trabaja con las funciones panel_*, que
--     comprueban el rol en el servidor. Solo "admin" ve estadísticas y equipo.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Tablas
-- ---------------------------------------------------------------------------
create table if not exists public.perfiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  email       text,
  nombre      text not null default '',
  rol         text not null default 'ninguno' check (rol in ('admin', 'asesor', 'ninguno')),
  created_at  timestamptz not null default now()
);

-- Cuentas de clientes (creadas desde "Mi cuenta"): rol 'cliente'
alter table public.perfiles add column if not exists telefono text not null default '';
alter table public.perfiles add column if not exists autorizacion_at timestamptz;
alter table public.perfiles drop constraint if exists perfiles_rol_check;
alter table public.perfiles add constraint perfiles_rol_check check (rol in ('admin', 'asesor', 'cliente', 'ninguno'));

create sequence if not exists public.solicitudes_numero_seq;

create table if not exists public.solicitudes (
  id                 uuid primary key default gen_random_uuid(),
  numero             bigint not null default nextval('public.solicitudes_numero_seq') unique,
  token              uuid not null default gen_random_uuid() unique,   -- enlace secreto del cliente
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  nombre             text not null,
  apellido           text not null,
  email              text not null,
  telefono           text not null,
  seguros            text[] not null default '{}',
  mensaje            text not null default '',
  autorizacion_at    timestamptz not null,                             -- Ley 1581: autorización de datos
  estado             text not null default 'nueva'
                     check (estado in ('nueva', 'en_gestion', 'cotizada', 'ganada', 'perdida')),
  asignado_a         uuid references public.perfiles(id) on delete set null,
  primera_respuesta_at timestamptz,
  ultimo_mensaje_at  timestamptz not null default now(),
  pendiente_equipo   boolean not null default true                     -- el cliente escribió y nadie ha respondido
);
-- Bandeja por reclamar y cierre con datos financieros (plan Pro)
alter table public.solicitudes add column if not exists reclamada_at timestamptz;
alter table public.solicitudes add column if not exists cerrada_at timestamptz;
alter table public.solicitudes add column if not exists prima numeric(14, 0) check (prima is null or prima >= 0);       -- prima anual vendida (COP)
alter table public.solicitudes add column if not exists comision numeric(14, 0) check (comision is null or comision >= 0); -- comisión de RG (COP)
alter table public.solicitudes add column if not exists aseguradora text;
alter table public.solicitudes add column if not exists motivo_cierre text;
create index if not exists solicitudes_cerrada_idx on public.solicitudes (cerrada_at desc) where cerrada_at is not null;
create index if not exists solicitudes_created_idx on public.solicitudes (created_at desc);
create index if not exists solicitudes_email_idx on public.solicitudes (lower(email));

create table if not exists public.mensajes (
  id            uuid primary key default gen_random_uuid(),
  solicitud_id  uuid not null references public.solicitudes(id) on delete cascade,
  autor         text not null check (autor in ('cliente', 'asesor')),
  autor_id      uuid references public.perfiles(id) on delete set null,
  interno       boolean not null default false,                       -- nota interna: el cliente no la ve
  texto         text not null check (char_length(texto) between 1 and 4000),
  created_at    timestamptz not null default now()
);
create index if not exists mensajes_solicitud_idx on public.mensajes (solicitud_id, created_at);

create table if not exists public.actividad (
  id            bigint generated always as identity primary key,
  created_at    timestamptz not null default now(),
  actor_id      uuid references public.perfiles(id) on delete set null,
  solicitud_id  uuid references public.solicitudes(id) on delete cascade,
  tipo          text not null,
  detalle       text not null default ''
);
create index if not exists actividad_created_idx on public.actividad (created_at desc);

-- Límites antispam (por IP o por enlace) y uso diario de RG AI
create table if not exists public.limites (
  clave  text not null,
  ts     timestamptz not null default now()
);
create index if not exists limites_idx on public.limites (clave, ts);

create table if not exists public.rg_ai_uso (
  dia        date primary key default (now() at time zone 'America/Bogota')::date,
  consultas  integer not null default 0
);

-- ---------------------------------------------------------------------------
-- 2. Funciones base
-- ---------------------------------------------------------------------------
create or replace function public.rol_actual()
returns text language sql stable security definer set search_path = public as $$
  select coalesce((select rol from public.perfiles where id = auth.uid()), 'ninguno');
$$;

create or replace function public.es_equipo()
returns boolean language sql stable security definer set search_path = public as $$
  select public.rol_actual() in ('admin', 'asesor');
$$;

create or replace function public.exigir_equipo()
returns void language plpgsql stable security definer set search_path = public as $$
begin
  if not public.es_equipo() then raise exception 'NO_AUTORIZADO' using errcode = '42501'; end if;
end $$;

create or replace function public.exigir_admin()
returns void language plpgsql stable security definer set search_path = public as $$
begin
  if public.rol_actual() <> 'admin' then raise exception 'NO_AUTORIZADO' using errcode = '42501'; end if;
end $$;

-- Perfil automático al crear un usuario (sin permisos hasta que el admin asigne rol)
create or replace function public.crear_perfil()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  -- Nunca se asigna admin/asesor desde los datos que envía el navegador
  insert into public.perfiles (id, email, nombre, telefono, rol, autorizacion_at)
  values (new.id, new.email,
          left(coalesce(nullif(btrim(new.raw_user_meta_data->>'nombre'), ''), split_part(new.email, '@', 1)), 120),
          left(regexp_replace(coalesce(new.raw_user_meta_data->>'telefono', ''), '[^0-9+ ()-]', '', 'g'), 20),
          case when new.raw_user_meta_data->>'tipo' = 'cliente' then 'cliente' else 'ninguno' end,
          case when new.raw_user_meta_data->>'autorizacion' = 'si' then now() end)
  on conflict (id) do nothing;
  return new;
end $$;
drop trigger if exists rg_on_auth_user_created on auth.users;
create trigger rg_on_auth_user_created after insert on auth.users for each row execute function public.crear_perfil();

-- IP del visitante (la entrega la API de Supabase en las cabeceras)
create or replace function public.ip_cliente()
returns text language sql stable as $$
  select coalesce(
    nullif(split_part(coalesce(current_setting('request.headers', true)::json->>'x-forwarded-for', ''), ',', 1), ''),
    current_setting('request.headers', true)::json->>'cf-connecting-ip',
    'desconocida');
$$;

-- Devuelve true y registra el intento si no se superó el límite
create or replace function public.dentro_del_limite(p_clave text, p_max integer, p_ventana interval)
returns boolean language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  delete from public.limites where ts < now() - interval '2 days';
  select count(*) into n from public.limites where clave = p_clave and ts > now() - p_ventana;
  if n >= p_max then return false; end if;
  insert into public.limites (clave) values (p_clave);
  return true;
end $$;

create or replace function public.limpiar(p text, p_max integer)
returns text language sql immutable as $$
  select left(btrim(regexp_replace(coalesce(p, ''), '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]', '', 'g')), p_max);
$$;

-- ---------------------------------------------------------------------------
-- 3. Funciones públicas (sitio web)
-- ---------------------------------------------------------------------------
create or replace function public.crear_solicitud(
  p_nombre text, p_apellido text, p_email text, p_telefono text,
  p_mensaje text default '', p_seguros text default '', p_autorizacion text default '',
  p_sitio_web text default '', p_t text default ''
) returns json language plpgsql security definer set search_path = public as $$
declare
  v_nombre text := public.limpiar(p_nombre, 100);
  v_apellido text := public.limpiar(p_apellido, 100);
  v_email text := lower(public.limpiar(p_email, 150));
  v_tel text := public.limpiar(p_telefono, 20);
  v_msg text := public.limpiar(p_mensaje, 2000);
  v_seguros text[];
  v_err jsonb := '{}'::jsonb;
  v_sol public.solicitudes;
begin
  -- Campo trampa: los bots lo llenan. Respuesta neutra, no se guarda nada.
  if coalesce(p_sitio_web, '') <> '' then
    return json_build_object('ok', true, 'message', 'Recibimos tu solicitud.');
  end if;
  -- Envío demasiado rápido tras cargar la página (si el navegador informó la hora)
  if p_t ~ '^\d{10,16}$' and (extract(epoch from now()) * 1000 - p_t::numeric) < 3000 then
    return json_build_object('ok', false, 'message', 'Espera unos segundos y vuelve a intentarlo.');
  end if;

  if v_nombre = '' or v_nombre !~ '^[[:alpha:]][[:alpha:][:space:].''’-]*$' then v_err := v_err || '{"nombre":"Escribe tu nombre (solo letras)."}'; end if;
  if v_apellido = '' or v_apellido !~ '^[[:alpha:]][[:alpha:][:space:].''’-]*$' then v_err := v_err || '{"apellido":"Escribe tu apellido (solo letras)."}'; end if;
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then v_err := v_err || '{"email":"Escribe un correo electrónico válido."}'; end if;
  if v_tel !~ '^\+?[0-9 ()-]{7,20}$' or length(regexp_replace(v_tel, '\D', '', 'g')) not between 7 and 15 then
    v_err := v_err || '{"telefono":"Escribe un número de teléfono válido (7 a 15 dígitos)."}';
  end if;
  if p_autorizacion is distinct from 'si' then v_err := v_err || '{"autorizacion":"Debes autorizar el tratamiento de tus datos para poder contactarte."}'; end if;
  if v_err <> '{}'::jsonb then
    return json_build_object('ok', false, 'message', 'Revisa los campos marcados antes de enviar.', 'errors', v_err);
  end if;

  if not public.dentro_del_limite('solicitud:' || public.ip_cliente(), 5, interval '1 hour') then
    return json_build_object('ok', false, 'message', 'Has enviado varias solicitudes seguidas. Inténtalo más tarde o escríbenos por WhatsApp.');
  end if;

  select coalesce(array_agg(s), '{}') into v_seguros from (
    select distinct public.limpiar(x, 80) s from unnest(string_to_array(coalesce(p_seguros, ''), ',')) x
    where public.limpiar(x, 80) <> '' limit 12) t;

  insert into public.solicitudes (nombre, apellido, email, telefono, seguros, mensaje, autorizacion_at)
  values (v_nombre, v_apellido, v_email, v_tel, v_seguros, v_msg, now())
  returning * into v_sol;

  if v_msg <> '' then
    insert into public.mensajes (solicitud_id, autor, texto) values (v_sol.id, 'cliente', v_msg);
  end if;
  insert into public.actividad (solicitud_id, tipo, detalle)
  values (v_sol.id, 'solicitud_creada', 'Nueva solicitud RG-' || lpad(v_sol.numero::text, 4, '0'));

  return json_build_object('ok', true,
    'message', 'Recibimos tu solicitud RG-' || lpad(v_sol.numero::text, 4, '0') || '. Un asesor se pondrá en contacto contigo.',
    'caso', v_sol.token);
end $$;

-- Vista del caso para el cliente (solo con el enlace secreto; sin notas internas)
create or replace function public.caso_ver(p_token uuid)
returns json language sql stable security definer set search_path = public as $$
  select json_build_object(
    'codigo', 'RG-' || lpad(s.numero::text, 4, '0'),
    'nombre', s.nombre,
    'estado', s.estado,
    'seguros', s.seguros,
    'creada', s.created_at,
    'asesor', (select nullif(p.nombre, '') from public.perfiles p where p.id = s.asignado_a),
    'mensajes', coalesce((select json_agg(json_build_object('autor', m.autor, 'texto', m.texto, 'fecha', m.created_at) order by m.created_at)
                          from public.mensajes m where m.solicitud_id = s.id and not m.interno), '[]'::json))
  from public.solicitudes s where s.token = p_token;
$$;

create or replace function public.caso_responder(p_token uuid, p_texto text)
returns json language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_txt text := public.limpiar(p_texto, 2000);
begin
  select id into v_id from public.solicitudes where token = p_token;
  if v_id is null then return json_build_object('ok', false, 'message', 'Este enlace no es válido.'); end if;
  if v_txt = '' then return json_build_object('ok', false, 'message', 'Escribe un mensaje.'); end if;
  if not public.dentro_del_limite('caso:' || v_id, 20, interval '1 hour') then
    return json_build_object('ok', false, 'message', 'Enviaste muchos mensajes seguidos. Espera un momento.');
  end if;
  insert into public.mensajes (solicitud_id, autor, texto) values (v_id, 'cliente', v_txt);
  update public.solicitudes set ultimo_mensaje_at = now(), pendiente_equipo = true, updated_at = now() where id = v_id;
  insert into public.actividad (solicitud_id, tipo, detalle) values (v_id, 'mensaje_cliente', left(v_txt, 140));
  return json_build_object('ok', true);
end $$;

-- Uso de RG AI (solo lo llama la Edge Function con la clave de servicio)
create or replace function public.rg_ai_registrar(p_ip text, p_por_ventana integer, p_ventana_min integer, p_por_dia integer, p_global_dia integer)
returns text language plpgsql security definer set search_path = public as $$
declare v_dia date := (now() at time zone 'America/Bogota')::date; v_total integer;
begin
  select consultas into v_total from public.rg_ai_uso where dia = v_dia;
  if coalesce(v_total, 0) >= p_global_dia then return 'global'; end if;
  if not public.dentro_del_limite('ai:' || p_ip, p_por_ventana, make_interval(mins => p_ventana_min)) then return 'ip'; end if;
  if (select count(*) from public.limites where clave = 'ai:' || p_ip and ts > now() - interval '1 day') > p_por_dia then return 'ip'; end if;
  insert into public.rg_ai_uso (dia, consultas) values (v_dia, 1)
  on conflict (dia) do update set consultas = public.rg_ai_uso.consultas + 1;
  return 'ok';
end $$;

-- Mi cuenta: solicitudes del cliente. Se vinculan por correo SOLO si la cuenta confirmó ese correo.
create or replace function public.cliente_resumen()
returns json language plpgsql stable security definer set search_path = public as $$
declare v_email text; v json;
begin
  if auth.uid() is null then raise exception 'NO_AUTORIZADO' using errcode = '42501'; end if;
  select lower(email) into v_email from auth.users where id = auth.uid() and email_confirmed_at is not null;
  select json_build_object(
    'perfil', (select json_build_object('nombre', p.nombre, 'email', p.email, 'telefono', p.telefono, 'rol', p.rol) from public.perfiles p where p.id = auth.uid()),
    'confirmado', v_email is not null,
    'solicitudes', coalesce((select json_agg(x order by x.ultimo_mensaje_at desc) from (
        select 'RG-' || lpad(s.numero::text, 4, '0') as codigo, s.estado, s.seguros, s.created_at as creada, s.ultimo_mensaje_at, s.token,
               (select count(*) from public.mensajes m where m.solicitud_id = s.id and m.autor = 'asesor' and not m.interno) as respuestas,
               (select max(m.created_at) from public.mensajes m where m.solicitud_id = s.id and m.autor = 'asesor' and not m.interno) as ultima_respuesta,
               (select nullif(p.nombre, '') from public.perfiles p where p.id = s.asignado_a) as asesor
        from public.solicitudes s where v_email is not null and lower(s.email) = v_email) x), '[]'::json))
  into v;
  return v;
end $$;

create or replace function public.cliente_actualizar(p_nombre text, p_telefono text)
returns json language plpgsql security definer set search_path = public as $$
declare v_nombre text := public.limpiar(p_nombre, 120); v_tel text := public.limpiar(p_telefono, 20);
begin
  if auth.uid() is null then raise exception 'NO_AUTORIZADO' using errcode = '42501'; end if;
  if v_nombre = '' then return json_build_object('ok', false, 'message', 'Escribe tu nombre.'); end if;
  if v_tel <> '' and (v_tel !~ '^\+?[0-9 ()-]{7,20}$' or length(regexp_replace(v_tel, '\D', '', 'g')) not between 7 and 15) then
    return json_build_object('ok', false, 'message', 'Escribe un teléfono válido (7 a 15 dígitos).');
  end if;
  update public.perfiles set nombre = v_nombre, telefono = v_tel where id = auth.uid();
  return json_build_object('ok', true);
end $$;

-- ---------------------------------------------------------------------------
-- 4. Funciones del panel (equipo)
-- ---------------------------------------------------------------------------
create or replace function public.panel_yo()
returns json language sql stable security definer set search_path = public as $$
  select json_build_object('id', p.id, 'email', p.email, 'nombre', p.nombre, 'rol', p.rol)
  from public.perfiles p where p.id = auth.uid();
$$;

create or replace function public.codigo(p_numero bigint)
returns text language sql immutable as $$ select 'RG-' || lpad(p_numero::text, 4, '0'); $$;

create or replace function public.panel_solicitudes(
  p_estado text default null, p_busqueda text default null, p_asignado text default null,
  p_limite integer default 50, p_offset integer default 0
) returns json language plpgsql stable security definer set search_path = public as $$
declare v json;
begin
  perform public.exigir_equipo();
  with base as (
    select s.*, p.nombre as asignado_nombre,
           (select count(*) from public.mensajes m where m.solicitud_id = s.id and not m.interno) as n_mensajes
    from public.solicitudes s left join public.perfiles p on p.id = s.asignado_a
    where (p_estado is null or p_estado = '' or (p_estado = 'abiertas' and s.estado in ('nueva', 'en_gestion', 'cotizada')) or s.estado = p_estado)
      and (p_asignado is null or p_asignado = '' or (p_asignado = 'mias' and s.asignado_a = auth.uid())
           or (p_asignado = 'sin_asignar' and s.asignado_a is null)
           or (p_asignado = 'equipo' and s.asignado_a is not null and s.asignado_a <> auth.uid()))
      and (p_busqueda is null or p_busqueda = '' or
           (s.nombre || ' ' || s.apellido || ' ' || s.email || ' ' || s.telefono || ' ' || public.codigo(s.numero) || ' ' || array_to_string(s.seguros, ' '))
           ilike '%' || p_busqueda || '%')
  )
  select json_build_object(
    'total', (select count(*) from base),
    'items', coalesce((select json_agg(x order by x.pendiente_equipo desc, x.ultimo_mensaje_at desc) from (
      select id, public.codigo(numero) as codigo, created_at, nombre, apellido, email, telefono, seguros, estado,
             asignado_a, asignado_nombre, pendiente_equipo, ultimo_mensaje_at, n_mensajes, reclamada_at,
             left(mensaje, 180) as mensaje
      from base order by pendiente_equipo desc, ultimo_mensaje_at desc
      limit least(greatest(p_limite, 1), 200) offset greatest(p_offset, 0)) x), '[]'::json))
  into v;
  return v;
end $$;

create or replace function public.panel_solicitud(p_id uuid)
returns json language plpgsql stable security definer set search_path = public as $$
declare v json;
begin
  perform public.exigir_equipo();
  select json_build_object(
    'id', s.id, 'codigo', public.codigo(s.numero), 'token', s.token, 'created_at', s.created_at,
    'nombre', s.nombre, 'apellido', s.apellido, 'email', s.email, 'telefono', s.telefono,
    'seguros', s.seguros, 'mensaje', s.mensaje, 'autorizacion_at', s.autorizacion_at,
    'estado', s.estado, 'asignado_a', s.asignado_a, 'pendiente_equipo', s.pendiente_equipo,
    'asignado_nombre', (select nombre from public.perfiles where id = s.asignado_a),
    'reclamada_at', s.reclamada_at, 'cerrada_at', s.cerrada_at, 'prima', s.prima, 'comision', s.comision,
    'aseguradora', s.aseguradora, 'motivo_cierre', s.motivo_cierre,
    'otras', (select count(*) - 1 from public.solicitudes o where lower(o.email) = lower(s.email)),
    'mensajes', coalesce((select json_agg(json_build_object('id', m.id, 'autor', m.autor, 'interno', m.interno, 'texto', m.texto,
                          'fecha', m.created_at, 'por', p.nombre) order by m.created_at)
                          from public.mensajes m left join public.perfiles p on p.id = m.autor_id where m.solicitud_id = s.id), '[]'::json),
    'actividad', coalesce((select json_agg(json_build_object('tipo', a.tipo, 'detalle', a.detalle, 'fecha', a.created_at, 'por', p.nombre) order by a.created_at desc)
                           from public.actividad a left join public.perfiles p on p.id = a.actor_id where a.solicitud_id = s.id), '[]'::json))
  into v from public.solicitudes s where s.id = p_id;
  if v is null then raise exception 'NO_EXISTE'; end if;
  return v;
end $$;

create or replace function public.panel_actualizar(p_id uuid, p_estado text default null, p_asignado_a uuid default null, p_quitar_asignacion boolean default false)
returns json language plpgsql security definer set search_path = public as $$
declare v_old public.solicitudes; v_nombre text; v_admin boolean := public.rol_actual() = 'admin';
begin
  perform public.exigir_equipo();
  select * into v_old from public.solicitudes where id = p_id for update;
  if v_old.id is null then raise exception 'NO_EXISTE'; end if;
  if p_estado is not null and p_estado <> v_old.estado then
    if p_estado in ('ganada', 'perdida') then raise exception 'USA_CERRAR'; end if;
    if p_estado not in ('nueva', 'en_gestion', 'cotizada') then raise exception 'ESTADO_INVALIDO'; end if;
    if not v_admin and v_old.asignado_a is distinct from auth.uid() then raise exception 'NO_ES_TU_CASO'; end if;
    -- reabrir un caso cerrado borra su cierre para no contarlo en finanzas
    update public.solicitudes set estado = p_estado, updated_at = now(), cerrada_at = null,
           prima = null, comision = null, aseguradora = null, motivo_cierre = null where id = p_id;
    insert into public.actividad (actor_id, solicitud_id, tipo, detalle) values (auth.uid(), p_id, 'estado', v_old.estado || ' → ' || p_estado);
  end if;
  if (p_quitar_asignacion or p_asignado_a is not null) and not v_admin then raise exception 'NO_AUTORIZADO' using errcode = '42501'; end if;
  if p_quitar_asignacion and v_old.asignado_a is not null then
    update public.solicitudes set asignado_a = null, reclamada_at = null, updated_at = now() where id = p_id;
    insert into public.actividad (actor_id, solicitud_id, tipo, detalle) values (auth.uid(), p_id, 'asignacion', 'Devuelta a la bandeja');
  elsif p_asignado_a is not null and p_asignado_a is distinct from v_old.asignado_a then
    select nombre into v_nombre from public.perfiles where id = p_asignado_a and rol in ('admin', 'asesor');
    if v_nombre is null then raise exception 'ASESOR_INVALIDO'; end if;
    update public.solicitudes set asignado_a = p_asignado_a, reclamada_at = now(), updated_at = now(),
           estado = case when estado = 'nueva' then 'en_gestion' else estado end where id = p_id;
    insert into public.actividad (actor_id, solicitud_id, tipo, detalle) values (auth.uid(), p_id, 'asignacion', 'Asignada a ' || v_nombre);
  end if;
  return json_build_object('ok', true);
end $$;

-- Reclamar: toma una solicitud de la bandeja (o la más antigua si p_id es null).
-- Un asesor trabaja un caso a la vez: debe cotizarlo o cerrarlo antes de reclamar otro.
create or replace function public.panel_reclamar(p_id uuid default null)
returns json language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_cod text;
begin
  perform public.exigir_equipo();
  if public.rol_actual() <> 'admin' and exists (
      select 1 from public.solicitudes where asignado_a = auth.uid() and estado in ('nueva', 'en_gestion')) then
    raise exception 'TERMINA_TU_CASO';
  end if;
  select id into v_id from public.solicitudes
   where asignado_a is null and estado in ('nueva', 'en_gestion', 'cotizada') and (p_id is null or id = p_id)
   order by created_at limit 1 for update skip locked;
  if v_id is null then
    if p_id is not null then raise exception 'YA_RECLAMADA'; end if;
    return json_build_object('ok', false, 'motivo', 'bandeja_vacia');
  end if;
  update public.solicitudes set asignado_a = auth.uid(), reclamada_at = now(), updated_at = now(),
         estado = case when estado = 'nueva' then 'en_gestion' else estado end
   where id = v_id returning public.codigo(numero) into v_cod;
  insert into public.actividad (actor_id, solicitud_id, tipo, detalle) values (auth.uid(), v_id, 'reclamada', v_cod);
  return json_build_object('ok', true, 'id', v_id);
end $$;

-- Soltar: devuelve el caso a la bandeja (quien lo tiene o la administración)
create or replace function public.panel_soltar(p_id uuid)
returns json language plpgsql security definer set search_path = public as $$
begin
  perform public.exigir_equipo();
  if public.rol_actual() <> 'admin' and not exists (select 1 from public.solicitudes where id = p_id and asignado_a = auth.uid()) then
    raise exception 'NO_ES_TU_CASO';
  end if;
  update public.solicitudes set asignado_a = null, reclamada_at = null, updated_at = now() where id = p_id and estado in ('nueva', 'en_gestion', 'cotizada');
  if not found then raise exception 'NO_EXISTE'; end if;
  insert into public.actividad (actor_id, solicitud_id, tipo, detalle) values (auth.uid(), p_id, 'soltada', 'Devuelta a la bandeja');
  return json_build_object('ok', true);
end $$;

-- Cerrar: venta (con prima, comisión y aseguradora) o sin venta (con motivo)
create or replace function public.panel_cerrar(p_id uuid, p_resultado text, p_prima numeric default null, p_comision numeric default null,
                                               p_aseguradora text default null, p_motivo text default null)
returns json language plpgsql security definer set search_path = public as $$
declare v public.solicitudes; v_aseg text := public.limpiar(p_aseguradora, 80); v_mot text := public.limpiar(p_motivo, 300);
begin
  perform public.exigir_equipo();
  select * into v from public.solicitudes where id = p_id for update;
  if v.id is null then raise exception 'NO_EXISTE'; end if;
  if public.rol_actual() <> 'admin' and v.asignado_a is distinct from auth.uid() then raise exception 'NO_ES_TU_CASO'; end if;
  if p_resultado = 'ganada' then
    if p_prima is null or p_prima <= 0 or p_prima > 100000000000 then raise exception 'PRIMA_INVALIDA'; end if;
    if p_comision is null or p_comision < 0 or p_comision > p_prima then raise exception 'COMISION_INVALIDA'; end if;
    if v_aseg = '' then raise exception 'FALTA_ASEGURADORA'; end if;
  elsif p_resultado = 'perdida' then
    if v_mot = '' then raise exception 'FALTA_MOTIVO'; end if;
  else
    raise exception 'ESTADO_INVALIDO';
  end if;
  update public.solicitudes set
    estado = p_resultado, cerrada_at = now(), updated_at = now(), pendiente_equipo = false,
    asignado_a = coalesce(asignado_a, auth.uid()), reclamada_at = coalesce(reclamada_at, now()),
    prima = case when p_resultado = 'ganada' then round(p_prima) end,
    comision = case when p_resultado = 'ganada' then round(p_comision) end,
    aseguradora = case when p_resultado = 'ganada' then v_aseg end,
    motivo_cierre = nullif(v_mot, '')
  where id = p_id;
  insert into public.actividad (actor_id, solicitud_id, tipo, detalle)
  values (auth.uid(), p_id, 'cerrada', case when p_resultado = 'ganada' then 'Venta · ' || v_aseg else 'Sin venta · ' || v_mot end);
  return json_build_object('ok', true);
end $$;

-- Finanzas (solo admin): ventas, primas y comisiones registradas al cerrar
create or replace function public.panel_finanzas(p_dias integer default 365)
returns json language plpgsql stable security definer set search_path = public as $$
declare v_desde timestamptz := now() - make_interval(days => least(greatest(p_dias, 1), 1825)); v json;
begin
  perform public.exigir_admin();
  with c as (select * from public.solicitudes where cerrada_at >= v_desde),
       g as (select * from c where estado = 'ganada')
  select json_build_object(
    'ventas', (select count(*) from g),
    'primas', (select coalesce(sum(prima), 0) from g),
    'comisiones', (select coalesce(sum(comision), 0) from g),
    'ticket', (select round(avg(prima)) from g),
    'pct_comision', (select round(100.0 * sum(comision) / nullif(sum(prima), 0), 1) from g),
    'perdidas', (select count(*) from c where estado = 'perdida'),
    'tasa_cierre', (select round(100.0 * count(*) filter (where estado = 'ganada') / nullif(count(*), 0), 1) from c),
    'cotizadas', (select count(*) from public.solicitudes where estado = 'cotizada'),
    'en_gestion', (select count(*) from public.solicitudes where estado in ('nueva', 'en_gestion') and asignado_a is not null),
    'por_mes', coalesce((select json_agg(json_build_object('mes', to_char(m, 'YYYY-MM'), 'ventas', coalesce(x.ventas, 0),
                          'primas', coalesce(x.primas, 0), 'comisiones', coalesce(x.comisiones, 0)) order by m)
        from generate_series(date_trunc('month', now() at time zone 'America/Bogota') - interval '11 months',
                             date_trunc('month', now() at time zone 'America/Bogota'), interval '1 month') m
        left join (select date_trunc('month', cerrada_at at time zone 'America/Bogota') mm, count(*) ventas, sum(prima) primas, sum(comision) comisiones
                   from public.solicitudes where estado = 'ganada' group by 1) x on x.mm = m), '[]'::json),
    'por_aseguradora', coalesce((select json_agg(x order by x.comisiones desc) from (
        select aseguradora, count(*) ventas, sum(prima) primas, sum(comision) comisiones from g group by aseguradora) x), '[]'::json),
    'por_asesor', coalesce((select json_agg(x order by x.comisiones desc nulls last) from (
        select p.nombre, count(c.id) filter (where c.estado = 'ganada') ventas, count(c.id) filter (where c.estado = 'perdida') perdidas,
               coalesce(sum(c.prima) filter (where c.estado = 'ganada'), 0) primas, coalesce(sum(c.comision) filter (where c.estado = 'ganada'), 0) comisiones,
               round((extract(epoch from avg(c.cerrada_at - c.reclamada_at)) / 3600)::numeric, 1) resolucion_horas
        from public.perfiles p left join c on c.asignado_a = p.id
        where p.rol in ('admin', 'asesor') group by p.id, p.nombre) x), '[]'::json),
    'por_seguro', coalesce((select json_agg(json_build_object('seguro', seguro, 'n', n) order by n desc) from (
        select unnest(seguros) seguro, count(*) n from g group by 1 order by 2 desc limit 12) t), '[]'::json),
    'motivos', coalesce((select json_agg(json_build_object('motivo', motivo_cierre, 'n', n) order by n desc) from (
        select motivo_cierre, count(*) n from c where estado = 'perdida' group by 1 order by 2 desc limit 8) t), '[]'::json),
    'lista', coalesce((select json_agg(x order by x.fecha desc) from (
        select public.codigo(g.numero) codigo, g.cerrada_at fecha, g.nombre || ' ' || g.apellido cliente, g.seguros, g.aseguradora,
               g.prima, g.comision, p.nombre asesor
        from g left join public.perfiles p on p.id = g.asignado_a order by g.cerrada_at desc limit 300) x), '[]'::json)
  ) into v;
  return v;
end $$;

create or replace function public.panel_enviar_mensaje(p_id uuid, p_texto text, p_interno boolean default false)
returns json language plpgsql security definer set search_path = public as $$
declare v_txt text := public.limpiar(p_texto, 4000); v_msg uuid; v_sol public.solicitudes;
begin
  perform public.exigir_equipo();
  if v_txt = '' then raise exception 'MENSAJE_VACIO'; end if;
  select * into v_sol from public.solicitudes where id = p_id for update;
  if v_sol.id is null then raise exception 'NO_EXISTE'; end if;
  insert into public.mensajes (solicitud_id, autor, autor_id, interno, texto)
  values (p_id, 'asesor', auth.uid(), coalesce(p_interno, false), v_txt) returning id into v_msg;
  if not coalesce(p_interno, false) then
    update public.solicitudes set
      ultimo_mensaje_at = now(), pendiente_equipo = false, updated_at = now(),
      primera_respuesta_at = coalesce(primera_respuesta_at, now()),
      estado = case when estado = 'nueva' then 'en_gestion' else estado end,
      reclamada_at = case when asignado_a is null then now() else reclamada_at end,
      asignado_a = coalesce(asignado_a, auth.uid())
    where id = p_id;
  end if;
  insert into public.actividad (actor_id, solicitud_id, tipo, detalle)
  values (auth.uid(), p_id, case when p_interno then 'nota_interna' else 'mensaje_asesor' end, left(v_txt, 140));
  return json_build_object('ok', true, 'mensaje_id', v_msg);
end $$;

-- Marca como atendida sin responder (p. ej. se resolvió por teléfono)
create or replace function public.panel_marcar_atendida(p_id uuid)
returns json language plpgsql security definer set search_path = public as $$
begin
  perform public.exigir_equipo();
  update public.solicitudes set pendiente_equipo = false, updated_at = now() where id = p_id;
  insert into public.actividad (actor_id, solicitud_id, tipo, detalle) values (auth.uid(), p_id, 'atendida', 'Marcada como atendida');
  return json_build_object('ok', true);
end $$;

create or replace function public.panel_registrar_contacto(p_id uuid, p_canal text)
returns json language plpgsql security definer set search_path = public as $$
begin
  perform public.exigir_equipo();
  if p_canal not in ('whatsapp', 'llamada', 'correo', 'enlace') then raise exception 'CANAL_INVALIDO'; end if;
  insert into public.actividad (actor_id, solicitud_id, tipo, detalle) values (auth.uid(), p_id, 'contacto', p_canal);
  update public.solicitudes set primera_respuesta_at = coalesce(primera_respuesta_at, now()),
    estado = case when estado = 'nueva' then 'en_gestion' else estado end,
    asignado_a = coalesce(asignado_a, auth.uid()), updated_at = now()
  where id = p_id;
  return json_build_object('ok', true);
end $$;

create or replace function public.panel_clientes(p_busqueda text default null)
returns json language plpgsql stable security definer set search_path = public as $$
declare v json;
begin
  perform public.exigir_equipo();
  select coalesce(json_agg(c order by c.ultima desc), '[]'::json) into v from (
    select lower(email) as email,
           (array_agg(nombre || ' ' || apellido order by created_at desc))[1] as nombre,
           (array_agg(telefono order by created_at desc))[1] as telefono,
           count(*) as solicitudes,
           count(*) filter (where estado = 'ganada') as ganadas,
           max(created_at) as ultima,
           (array_agg(estado order by created_at desc))[1] as ultimo_estado
    from public.solicitudes
    where p_busqueda is null or p_busqueda = '' or (nombre || ' ' || apellido || ' ' || email || ' ' || telefono) ilike '%' || p_busqueda || '%'
    group by lower(email) limit 500) c;
  return v;
end $$;

create or replace function public.panel_actividad(p_limite integer default 60)
returns json language plpgsql stable security definer set search_path = public as $$
declare v json;
begin
  perform public.exigir_equipo();
  select coalesce(json_agg(x), '[]'::json) into v from (
    select a.created_at as fecha, a.tipo, a.detalle, p.nombre as por, a.solicitud_id,
           public.codigo(s.numero) as codigo, s.nombre || ' ' || s.apellido as cliente
    from public.actividad a left join public.perfiles p on p.id = a.actor_id left join public.solicitudes s on s.id = a.solicitud_id
    order by a.created_at desc limit least(greatest(p_limite, 1), 300)) x;
  return v;
end $$;

-- Estadísticas del negocio (solo admin)
create or replace function public.panel_resumen(p_dias integer default 30)
returns json language plpgsql stable security definer set search_path = public as $$
declare v_desde timestamptz := now() - make_interval(days => least(greatest(p_dias, 1), 730)); v json;
begin
  perform public.exigir_admin();
  with s as (select * from public.solicitudes where created_at >= v_desde)
  select json_build_object(
    'dias', p_dias,
    'total', (select count(*) from s),
    'abiertas', (select count(*) from public.solicitudes where estado in ('nueva', 'en_gestion', 'cotizada')),
    'en_cola', (select count(*) from public.solicitudes where asignado_a is null and estado in ('nueva', 'en_gestion', 'cotizada')),
    'resolucion_horas', (select round((extract(epoch from avg(cerrada_at - coalesce(reclamada_at, created_at))) / 3600)::numeric, 1) from s where cerrada_at is not null),
    'comisiones', (select coalesce(sum(comision), 0) from public.solicitudes where estado = 'ganada' and cerrada_at >= v_desde),
    'sin_responder', (select count(*) from public.solicitudes where pendiente_equipo and estado in ('nueva', 'en_gestion', 'cotizada')),
    'ganadas', (select count(*) from s where estado = 'ganada'),
    'perdidas', (select count(*) from s where estado = 'perdida'),
    'tasa_cierre', (select round(100.0 * count(*) filter (where estado = 'ganada') / nullif(count(*) filter (where estado in ('ganada', 'perdida')), 0), 1) from s),
    'primera_respuesta_horas', (select round((extract(epoch from avg(primera_respuesta_at - created_at)) / 3600)::numeric, 1) from s where primera_respuesta_at is not null),
    'clientes', (select count(distinct lower(email)) from s),
    'cuentas', (select count(*) from public.perfiles where rol = 'cliente'),
    'rg_ai', (select coalesce(sum(consultas), 0) from public.rg_ai_uso where dia >= (v_desde at time zone 'America/Bogota')::date),
    'por_dia', coalesce((select json_agg(json_build_object('dia', d, 'n', n) order by d) from (
        select (created_at at time zone 'America/Bogota')::date d, count(*) n from s group by 1) t), '[]'::json),
    'rg_ai_por_dia', coalesce((select json_agg(json_build_object('dia', dia, 'n', consultas) order by dia)
        from public.rg_ai_uso where dia >= (v_desde at time zone 'America/Bogota')::date), '[]'::json),
    'por_estado', coalesce((select json_object_agg(estado, n) from (select estado, count(*) n from s group by estado) t), '{}'::json),
    'por_seguro', coalesce((select json_agg(json_build_object('seguro', seguro, 'n', n) order by n desc) from (
        select unnest(seguros) seguro, count(*) n from s group by 1 order by 2 desc limit 12) t), '[]'::json),
    'por_asesor', coalesce((select json_agg(x order by x.asignadas desc) from (
        select p.nombre, count(s.id) asignadas, count(s.id) filter (where s.estado = 'ganada') ganadas,
               (select count(*) from public.solicitudes a where a.asignado_a = p.id and a.estado in ('nueva', 'en_gestion', 'cotizada')) activos,
               round((extract(epoch from avg(s.primera_respuesta_at - s.created_at)) / 3600)::numeric, 1) as respuesta_horas
        from public.perfiles p left join s on s.asignado_a = p.id
        where p.rol in ('admin', 'asesor') group by p.id, p.nombre) x), '[]'::json)
  ) into v;
  return v;
end $$;

create or replace function public.panel_equipo()
returns json language plpgsql stable security definer set search_path = public as $$
declare v json;
begin
  perform public.exigir_equipo();
  select coalesce(json_agg(json_build_object('id', id, 'email', email, 'nombre', nombre, 'rol', rol) order by rol, nombre), '[]'::json)
  into v from public.perfiles
  where rol <> 'cliente' and (public.rol_actual() = 'admin' or rol in ('admin', 'asesor'));   -- los asesores solo ven al equipo activo (para asignar)
  return v;
end $$;

create or replace function public.panel_cambiar_rol(p_usuario uuid, p_rol text, p_nombre text default null)
returns json language plpgsql security definer set search_path = public as $$
begin
  perform public.exigir_admin();
  if p_rol not in ('admin', 'asesor', 'ninguno') then raise exception 'ROL_INVALIDO'; end if;
  if (select rol from public.perfiles where id = p_usuario) = 'cliente' then raise exception 'ES_CLIENTE'; end if;
  if p_usuario = auth.uid() and p_rol <> 'admin' then raise exception 'NO_PUEDES_QUITARTE_ADMIN'; end if;
  update public.perfiles set rol = p_rol, nombre = coalesce(nullif(public.limpiar(p_nombre, 120), ''), nombre) where id = p_usuario;
  insert into public.actividad (actor_id, tipo, detalle) values (auth.uid(), 'equipo', 'Rol ' || p_rol || ' para ' || (select email from public.perfiles where id = p_usuario));
  return json_build_object('ok', true);
end $$;

-- Ley 1581: supresión de datos a petición del titular (solo admin)
create or replace function public.panel_eliminar_solicitud(p_id uuid)
returns json language plpgsql security definer set search_path = public as $$
declare v_cod text;
begin
  perform public.exigir_admin();
  select public.codigo(numero) into v_cod from public.solicitudes where id = p_id;
  delete from public.solicitudes where id = p_id;
  insert into public.actividad (actor_id, tipo, detalle) values (auth.uid(), 'eliminada', coalesce(v_cod, '') || ' eliminada a petición del titular');
  return json_build_object('ok', true);
end $$;

-- Datos para el correo al cliente (solo la Edge Function, con la clave de servicio)
create or replace function public.datos_notificacion(p_mensaje uuid)
returns json language sql stable security definer set search_path = public as $$
  select json_build_object('email', s.email, 'nombre', s.nombre, 'codigo', public.codigo(s.numero), 'token', s.token,
                           'texto', m.texto, 'interno', m.interno, 'asesor', p.nombre)
  from public.mensajes m join public.solicitudes s on s.id = m.solicitud_id left join public.perfiles p on p.id = m.autor_id
  where m.id = p_mensaje;
$$;

-- ---------------------------------------------------------------------------
-- 5. Seguridad: RLS y permisos de ejecución
-- ---------------------------------------------------------------------------
alter table public.perfiles    enable row level security;
alter table public.solicitudes enable row level security;
alter table public.mensajes    enable row level security;
alter table public.actividad   enable row level security;
alter table public.limites     enable row level security;
alter table public.rg_ai_uso   enable row level security;

-- Lectura solo para el equipo (la necesita el aviso en tiempo real del panel). Sin escritura directa.
drop policy if exists "equipo_lee_solicitudes" on public.solicitudes;
create policy "equipo_lee_solicitudes" on public.solicitudes for select to authenticated using ((select public.es_equipo()));
drop policy if exists "equipo_lee_mensajes" on public.mensajes;
create policy "equipo_lee_mensajes" on public.mensajes for select to authenticated using ((select public.es_equipo()));
drop policy if exists "perfil_propio" on public.perfiles;
create policy "perfil_propio" on public.perfiles for select to authenticated using (id = (select auth.uid()));

revoke all on all tables in schema public from anon;
revoke insert, update, delete on all tables in schema public from authenticated;

do $$
declare f text;
begin
  -- Nadie ejecuta por defecto…
  for f in select p.oid::regprocedure::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname in (
             'crear_solicitud', 'caso_ver', 'caso_responder', 'rg_ai_registrar', 'datos_notificacion', 'dentro_del_limite',
             'panel_yo', 'panel_solicitudes', 'panel_solicitud', 'panel_actualizar', 'panel_enviar_mensaje', 'panel_marcar_atendida',
             'panel_registrar_contacto', 'panel_clientes', 'panel_actividad', 'panel_resumen', 'panel_equipo', 'panel_cambiar_rol',
             'panel_eliminar_solicitud', 'panel_reclamar', 'panel_soltar', 'panel_cerrar', 'panel_finanzas', 'exigir_equipo', 'exigir_admin', 'crear_perfil', 'cliente_resumen', 'cliente_actualizar')
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
  end loop;
end $$;

-- …y se concede lo justo:
grant execute on function public.crear_solicitud(text, text, text, text, text, text, text, text, text) to anon, authenticated;
grant execute on function public.caso_ver(uuid) to anon, authenticated;
grant execute on function public.caso_responder(uuid, text) to anon, authenticated;
grant execute on function public.cliente_resumen() to authenticated;
grant execute on function public.cliente_actualizar(text, text) to authenticated;
grant execute on function public.panel_yo() to authenticated;
grant execute on function public.panel_solicitudes(text, text, text, integer, integer) to authenticated;
grant execute on function public.panel_solicitud(uuid) to authenticated;
grant execute on function public.panel_actualizar(uuid, text, uuid, boolean) to authenticated;
grant execute on function public.panel_enviar_mensaje(uuid, text, boolean) to authenticated;
grant execute on function public.panel_marcar_atendida(uuid) to authenticated;
grant execute on function public.panel_registrar_contacto(uuid, text) to authenticated;
grant execute on function public.panel_clientes(text) to authenticated;
grant execute on function public.panel_actividad(integer) to authenticated;
grant execute on function public.panel_resumen(integer) to authenticated;
grant execute on function public.panel_equipo() to authenticated;
grant execute on function public.panel_cambiar_rol(uuid, text, text) to authenticated;
grant execute on function public.panel_eliminar_solicitud(uuid) to authenticated;
grant execute on function public.panel_reclamar(uuid) to authenticated;
grant execute on function public.panel_soltar(uuid) to authenticated;
grant execute on function public.panel_cerrar(uuid, text, numeric, numeric, text, text) to authenticated;
grant execute on function public.panel_finanzas(integer) to authenticated;
-- rg_ai_registrar y datos_notificacion: solo service_role (Edge Functions), que no necesita grant explícito en Supabase.
grant execute on function public.rg_ai_registrar(text, integer, integer, integer, integer) to service_role;
grant execute on function public.datos_notificacion(uuid) to service_role;
grant select on public.perfiles to service_role;  -- crear-usuario: enlace nuevo para alguien del equipo

-- ---------------------------------------------------------------------------
-- 6. Tiempo real (avisos en el panel)
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin alter publication supabase_realtime add table public.solicitudes; exception when duplicate_object then null; end;
    begin alter publication supabase_realtime add table public.mensajes; exception when duplicate_object then null; end;
  end if;
end $$;
