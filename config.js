// Conexión pública con Supabase (Project Settings → API).
// La clave "publishable"/"anon" es pública por diseño: la seguridad la aplican las
// reglas RLS y las funciones del servidor. NUNCA pongas aquí la clave service_role.
window.RG_CONFIG = {
  supabaseUrl: 'https://iwvoyhigvusdncdjqpnb.supabase.co',   // p. ej. 'https://abcdefgh.supabase.co'
  supabaseKey: 'sb_publishable_fWO3WGaEZ6u4SsncwoDQFQ_qWU4hdTe',    // clave publishable (sb_publishable_…) o anon
  portalPolizas: 'https://softseguros.com'   // enlace del portal de clientes de Soft Seguros de RG (p. ej. 'https://…')
};
