// =============================================================================
// notificar-cliente — Edge Function (Supabase)
// Envía al cliente un correo cuando un asesor le responde desde el panel, con el
// enlace a su caso para leer y contestar en la web.
//
// Secretos (Supabase → Edge Functions → Secrets):
//   SMTP_HOST, SMTP_PORT (587 o 465), SMTP_USER, SMTP_PASS
//   SMTP_FROM   p. ej. "RG Asesorías y Seguros <Comercial@rgasesoriasyseguros.com.co>"
//   SITE_URL    URL pública del sitio, terminada en "/" (p. ej. https://usuario.github.io/rg-seguros/)
// Supabase ya provee SUPABASE_URL, SUPABASE_ANON_KEY y SUPABASE_SERVICE_ROLE_KEY.
//
// Seguridad: solo usuarios con rol admin/asesor (se comprueba con su sesión). El
// destinatario sale de la base de datos, nunca del navegador. Las notas internas no se envían.
// =============================================================================
import { createClient } from "npm:@supabase/supabase-js@2.117.3";
import nodemailer from "npm:nodemailer@10.0.16";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

export function armarCorreo(d: { nombre: string; codigo: string; texto: string; asesor: string | null }, enlace: string) {
  const asunto = `Respuesta a tu solicitud ${d.codigo} · RG Asesorías y Seguros`;
  const quien = d.asesor ? `${esc(d.asesor)}, de nuestro equipo,` : "Nuestro equipo";
  const html = `<div style="background:#f4f5f9;padding:28px 12px;font-family:Arial,Helvetica,sans-serif;color:#111633">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:580px;margin:0 auto;background:#ffffff">
<tr><td style="background:#0f1a45;padding:22px 28px;color:#ffffff;font-size:13px;letter-spacing:3px;text-transform:uppercase;font-weight:bold">RG Asesorías y Seguros</td></tr>
<tr><td style="padding:28px">
  <p style="margin:0 0 6px;font-size:11px;letter-spacing:3px;text-transform:uppercase;color:#223883;font-weight:bold">Solicitud ${esc(d.codigo)}</p>
  <h1 style="margin:0 0 16px;font-size:22px;line-height:1.25">Hola ${esc(d.nombre)}, tienes una respuesta</h1>
  <p style="margin:0 0 12px;font-size:15px;line-height:1.6;color:#353b57">${quien} te escribió:</p>
  <div style="border-left:4px solid #f7dc29;background:#f4f5f9;padding:14px 16px;font-size:15px;line-height:1.6;white-space:pre-wrap">${esc(d.texto)}</div>
  <p style="margin:24px 0"><a href="${esc(enlace)}" style="display:inline-block;background:#0f1a45;color:#ffffff;padding:14px 26px;font-size:12px;letter-spacing:2px;text-transform:uppercase;font-weight:bold;text-decoration:none">Ver y responder</a></p>
  <p style="margin:0;font-size:13px;line-height:1.6;color:#646a82">Este enlace es personal: no lo compartas. También puedes escribirnos por WhatsApp al 316 526 8039.</p>
</td></tr>
<tr><td style="background:#0a1233;padding:16px 28px;font-size:12px;color:#aab1cf">RG Asesorías y Seguros Ltda. · Valledupar, Cesar · Comercial@rgasesoriasyseguros.com.co</td></tr>
</table></div>`;
  const texto = `Hola ${d.nombre}, tienes una respuesta a tu solicitud ${d.codigo}.\n\n${d.asesor ?? "Nuestro equipo"} te escribió:\n\n${d.texto}\n\nVer y responder: ${enlace}\n\nRG Asesorías y Seguros · WhatsApp 316 526 8039`;
  return { asunto, html, texto };
}

export async function manejar(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json(405, { ok: false, motivo: "metodo" });

  const auth = req.headers.get("Authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return json(401, { ok: false, motivo: "sin_sesion" });
  const url = Deno.env.get("SUPABASE_URL")!;
  const usuario = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: auth } }, auth: { persistSession: false } });
  const { data: yo, error: errYo } = await usuario.rpc("panel_yo");
  if (errYo || !yo || !["admin", "asesor"].includes(yo.rol)) return json(403, { ok: false, motivo: "no_autorizado" });

  let mensajeId = "";
  try { mensajeId = String((await req.json())?.mensaje_id ?? ""); } catch { /* validado abajo */ }
  if (!/^[0-9a-f-]{36}$/i.test(mensajeId)) return json(400, { ok: false, motivo: "datos" });

  const servicio = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const { data: d, error } = await servicio.rpc("datos_notificacion", { p_mensaje: mensajeId });
  if (error || !d) return json(404, { ok: false, motivo: "no_existe" });
  if (d.interno) return json(400, { ok: false, motivo: "nota_interna" });

  const [host, port, user, pass, from, site] = ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS", "SMTP_FROM", "SITE_URL"].map((k) => Deno.env.get(k) ?? "");
  if (!host || !user || !pass || !from || !site) return json(200, { ok: false, motivo: "smtp_no_configurado" });

  const enlace = `${site.replace(/\/?$/, "/")}caso/#${d.token}`;
  const correo = armarCorreo(d, enlace);
  try {
    const transporte = nodemailer.createTransport({ host, port: Number(port) || 587, secure: Number(port) === 465, auth: { user, pass } });
    await transporte.sendMail({ from, to: d.email, subject: correo.asunto, html: correo.html, text: correo.texto });
    return json(200, { ok: true });
  } catch (e) {
    console.error("[notificar-cliente] SMTP:", (e as Error).message);
    return json(200, { ok: false, motivo: "smtp_error" });
  }
}

if (import.meta.main) Deno.serve(manejar);
