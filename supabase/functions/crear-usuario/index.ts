// =============================================================================
// crear-usuario — Edge Function (Supabase)
// La dueña (rol admin) crea desde el panel las cuentas del equipo. Devuelve un código de
// un solo uso con el que el panel arma el enlace de activación: cada persona elige su
// contraseña y nadie más la conoce. También genera un enlace nuevo si venció o si la
// persona olvidó su contraseña.
//
// Seguridad: el rol se comprueba con la sesión de quien llama; el rol del usuario nuevo lo
// asigna panel_cambiar_rol con esa misma sesión. La clave service_role solo vive en el servidor.
// =============================================================================
import { createClient } from "npm:@supabase/supabase-js@2.117.3";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

export async function manejar(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json(405, { ok: false, motivo: "metodo" });

  const auth = req.headers.get("Authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return json(401, { ok: false, motivo: "sin_sesion" });
  const url = Deno.env.get("SUPABASE_URL")!;
  const opciones = { auth: { persistSession: false, autoRefreshToken: false } };
  const usuario = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, { ...opciones, global: { headers: { Authorization: auth } } });
  const { data: yo, error: errYo } = await usuario.rpc("panel_yo");
  if (errYo || yo?.rol !== "admin") return json(403, { ok: false, motivo: "no_autorizado" });

  let b: Record<string, unknown> = {};
  try { b = await req.json() ?? {}; } catch { /* validado abajo */ }
  const servicio = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, opciones);

  // Enlace nuevo para alguien que ya es del equipo (nunca para cuentas de clientes)
  if (b.usuario_id) {
    const { data: p } = await servicio.from("perfiles").select("email, rol").eq("id", String(b.usuario_id)).maybeSingle();
    if (!p || p.rol === "cliente") return json(404, { ok: false, motivo: "no_existe" });
    const { data, error } = await servicio.auth.admin.generateLink({ type: "recovery", email: p.email });
    if (error) { console.error("[crear-usuario] enlace:", error.message); return json(200, { ok: false, motivo: "error" }); }
    return json(200, { ok: true, email: p.email, codigo: data.properties.hashed_token, tipo: "recovery" });
  }

  const email = String(b.email ?? "").trim().toLowerCase();
  const nombre = String(b.nombre ?? "").trim().slice(0, 120);
  const rol = String(b.rol ?? "");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 || !nombre || !["admin", "asesor"].includes(rol)) {
    return json(400, { ok: false, motivo: "datos" });
  }

  const { data, error } = await servicio.auth.admin.generateLink({ type: "invite", email, options: { data: { nombre } } });
  if (error) {
    if (/already|exists|registered/i.test(error.message)) return json(200, { ok: false, motivo: "ya_existe" });
    console.error("[crear-usuario] invitar:", error.message);
    return json(200, { ok: false, motivo: "error" });
  }
  const { error: errRol } = await usuario.rpc("panel_cambiar_rol", { p_usuario: data.user.id, p_rol: rol, p_nombre: nombre });
  if (errRol) { console.error("[crear-usuario] rol:", errRol.message); return json(200, { ok: false, motivo: "error" }); }
  return json(200, { ok: true, email, codigo: data.properties.hashed_token, tipo: "invite" });
}

if (import.meta.main) Deno.serve(manejar);
