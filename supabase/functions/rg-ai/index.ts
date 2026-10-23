// =============================================================================
// RG AI — Edge Function (Supabase). Asistente del sitio con Claude (Anthropic).
//
// Secretos (Supabase → Edge Functions → Secrets):
//   ANTHROPIC_API_KEY   clave de API de Anthropic (obligatoria)
//   ALLOWED_ORIGINS     orígenes permitidos, separados por comas
//                       p. ej. https://usuario.github.io,https://www.rgasesoriasyseguros.com.co
//   RG_AI_MODELO        opcional (por defecto claude-opus-5-5)
// Supabase ya provee SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY.
//
// Se despliega con verificación JWT desactivada (es pública): ver config.toml.
// No guarda el contenido de las conversaciones; solo cuenta consultas por día.
// =============================================================================
import Anthropic from "npm:@anthropic-ai/sdk@0.132.0";
import { createClient } from "npm:@supabase/supabase-js@2.117.3";
import { INSTRUCCIONES } from "./instrucciones.ts";

const WHATSAPP = "https://wa.me/573165268039";
const NO_DISPONIBLE = `RG AI no está disponible en este momento. Escríbenos por WhatsApp (${WHATSAPP}) o llámanos al 316 526 8039.`;
const LIMITES = { porVentana: 20, ventanaMin: 10, porDia: 80, globalDia: 600 };

type Mensaje = { role: "user" | "assistant"; content: string };

const origenes = () => (Deno.env.get("ALLOWED_ORIGINS") ?? "").split(",").map((s) => s.trim()).filter(Boolean);

function cabeceras(origen: string | null) {
  const permitido = origen && origenes().includes(origen) ? origen : origenes()[0] ?? "*";
  return {
    "Access-Control-Allow-Origin": permitido,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  };
}

const limpiar = (s: string, max: number) =>
  s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").replace(/\r\n?/g, "\n").trim().slice(0, max);

/** Conversación alternada usuario/asistente, que empieza y termina con el usuario. */
export function validarMensajes(entrada: unknown): Mensaje[] | null {
  if (!Array.isArray(entrada) || entrada.length < 1 || entrada.length > 16) return null;
  const salida: Mensaje[] = [];
  let esperado: Mensaje["role"] = "user";
  let total = 0;
  for (const m of entrada) {
    if (!m || typeof m !== "object" || (m as Mensaje).role !== esperado || typeof (m as Mensaje).content !== "string") return null;
    const texto = limpiar((m as Mensaje).content, esperado === "user" ? 800 : 4000);
    if (!texto) return null;
    total += texto.length;
    salida.push({ role: esperado, content: texto });
    esperado = esperado === "user" ? "assistant" : "user";
  }
  if (salida[salida.length - 1].role !== "user" || total > 16000) return null;
  return salida;
}

export async function manejar(req: Request): Promise<Response> {
  const origen = req.headers.get("origin");
  const h = cabeceras(origen);
  const responder = (estado: number, cuerpo: Record<string, unknown>) => new Response(JSON.stringify(cuerpo), { status: estado, headers: h });

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: h });
  if (req.method !== "POST") return responder(405, { ok: false, message: "Método no permitido." });
  if (origenes().length && (!origen || !origenes().includes(origen))) return responder(403, { ok: false, message: "Solicitud no permitida." });

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) {
    console.error("[rg-ai] Falta el secreto ANTHROPIC_API_KEY");
    return responder(503, { ok: false, message: NO_DISPONIBLE });
  }

  const crudo = await req.text();
  if (crudo.length > 65536) return responder(413, { ok: false, message: "Mensaje demasiado largo." });
  let datos: { messages?: unknown } = {};
  try { datos = JSON.parse(crudo); } catch { /* se valida abajo */ }
  const mensajes = validarMensajes(datos?.messages);
  if (!mensajes) return responder(400, { ok: false, message: "No pude leer tu mensaje. Recarga la página e inténtalo de nuevo." });

  // Límites de uso (por IP y global por día) en la base de datos
  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || req.headers.get("cf-connecting-ip") || "desconocida";
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const { data: cupo, error: errCupo } = await admin.rpc("rg_ai_registrar", {
    p_ip: ip, p_por_ventana: LIMITES.porVentana, p_ventana_min: LIMITES.ventanaMin, p_por_dia: LIMITES.porDia, p_global_dia: LIMITES.globalDia,
  });
  if (errCupo) {
    console.error("[rg-ai] Error de base de datos:", errCupo.message);
    return responder(503, { ok: false, message: NO_DISPONIBLE });
  }
  if (cupo === "ip") return responder(429, { ok: false, message: `Has enviado muchas preguntas seguidas. Espera unos minutos o escríbenos por WhatsApp: ${WHATSAPP}` });
  if (cupo !== "ok") return responder(429, { ok: false, message: `RG AI alcanzó su límite de consultas por hoy. Escríbenos por WhatsApp (${WHATSAPP}) o llámanos al 316 526 8039.` });

  try {
    const client = new Anthropic({ apiKey });
    const params = {
      model: Deno.env.get("RG_AI_MODELO") || "claude-opus-5-5",
      max_tokens: 1500, // respuestas de chat cortas; límite de costo por consulta
      // Instrucciones fijas primero y en caché: abaratan las consultas repetidas
      system: [{ type: "text", text: INSTRUCCIONES, cache_control: { type: "ephemeral" } }],
      messages: mensajes,
      output_config: { effort: "low" },
      // Si el modelo declina por sus filtros, la API reintenta en el modelo de respaldo recomendado
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    };
    // deno-lint-ignore no-explicit-any
    const r: any = await client.beta.messages.create(params as any);

    // Revisar stop_reason antes de leer el contenido
    if (r.stop_reason === "refusal") {
      return responder(200, { ok: true, reply: `No puedo ayudarte con esa consulta. Si es sobre un seguro o una póliza, un asesor puede orientarte por WhatsApp: ${WHATSAPP}` });
    }
    let texto = (r.content ?? []).filter((b: { type: string }) => b.type === "text").map((b: { text: string }) => b.text).join("").trim();
    if (!texto) throw new Error(`Respuesta sin texto (stop_reason=${r.stop_reason})`);
    if (r.stop_reason === "max_tokens") texto += `\n\n(Respuesta resumida. Para más detalle, escríbenos por WhatsApp: ${WHATSAPP})`;
    console.log(`[rg-ai] ok modelo=${r.model} in=${r.usage?.input_tokens} out=${r.usage?.output_tokens} cache=${r.usage?.cache_read_input_tokens ?? 0}`);
    return responder(200, { ok: true, reply: texto });
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) console.error("[rg-ai] ANTHROPIC_API_KEY inválida");
    else if (e instanceof Anthropic.RateLimitError) console.error("[rg-ai] Límite de la API de Anthropic");
    else if (e instanceof Anthropic.APIError) console.error(`[rg-ai] API ${e.status}: ${e.message}`);
    else console.error("[rg-ai] Error:", (e as Error).message);
    return responder(502, { ok: false, message: NO_DISPONIBLE });
  }
}

if (import.meta.main) Deno.serve(manejar);
