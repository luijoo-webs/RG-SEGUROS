// =============================================================================
// RG AI — Edge Function (Supabase). Asistente del sitio con Gemini (gratis) o Claude.
//
// Secretos (Supabase → Edge Functions → Secrets):
//   GEMINI_API_KEY      clave gratuita de Google AI Studio (si existe, se usa Gemini)
//   GEMINI_MODELO       opcional (por defecto gemini-flash-latest)
//   ANTHROPIC_API_KEY   clave de API de Anthropic (se usa si no hay GEMINI_API_KEY)
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
// globalDia ≈ suma de los cupos gratis de los 3 modelos Gemini de respaldo
const LIMITES = { porVentana: 20, ventanaMin: 10, porDia: 150, globalDia: 1500 };

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

  const geminiKey = Deno.env.get("GEMINI_API_KEY");
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey && !geminiKey) {
    console.error("[rg-ai] Falta el secreto GEMINI_API_KEY (o ANTHROPIC_API_KEY)");
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

  if (geminiKey) return responder(...await conGemini(geminiKey, mensajes));

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

/** Google Gemini (plan gratuito de AI Studio). Se usa cuando existe GEMINI_API_KEY. */
async function conGemini(clave: string, mensajes: Mensaje[]): Promise<[number, Record<string, unknown>]> {
  // El plan gratuito a veces responde "alta demanda" (503) o cupo agotado (429): se prueba el siguiente modelo
  const modelos = (Deno.env.get("GEMINI_MODELO") || "gemini-flash-latest,gemini-flash-lite-latest,gemini-2.5-flash").split(",").map((m) => m.trim()).filter(Boolean);
  let modelo = modelos[0], cupoAgotado = false;
  try {
    // deno-lint-ignore no-explicit-any
    let res: Response | null = null, r: any = {};
    for (modelo of modelos) {
      try {
        res = await fetch(`${Deno.env.get("GEMINI_BASE_URL") || "https://generativelanguage.googleapis.com"}/v1beta/models/${encodeURIComponent(modelo)}:generateContent`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": clave },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: INSTRUCCIONES }] },
            contents: mensajes.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })),
            generationConfig: { maxOutputTokens: 2048, temperature: 0.4 },
          }),
          signal: AbortSignal.timeout(20000),
        });
      } catch (e) {
        console.error(`[rg-ai] Gemini ${modelo} sin respuesta: ${(e as Error).message}`);
        res = null;
        continue;
      }
      r = await res.json().catch(() => ({}));
      if (res.ok) break;
      console.error(`[rg-ai] Gemini ${modelo} ${res.status}: ${r?.error?.message ?? ""}`);
      if (res.status === 429) cupoAgotado = true;
      if (![404, 429, 500, 503].includes(res.status)) break; // clave inválida o petición mala: otro modelo no lo arregla
    }
    if (!res?.ok) {
      if (cupoAgotado) return [429, { ok: false, message: `RG AI alcanzó su límite de consultas por ahora. Escríbenos por WhatsApp (${WHATSAPP}) o llámanos al 316 526 8039.` }];
      return [502, { ok: false, message: NO_DISPONIBLE }];
    }
    const c = r.candidates?.[0];
    if (r.promptFeedback?.blockReason || c?.finishReason === "SAFETY") {
      return [200, { ok: true, reply: `No puedo ayudarte con esa consulta. Si es sobre un seguro o una póliza, un asesor puede orientarte por WhatsApp: ${WHATSAPP}` }];
    }
    let texto = (c?.content?.parts ?? []).filter((p: { text?: string; thought?: boolean }) => p.text && !p.thought).map((p: { text: string }) => p.text).join("").trim();
    if (!texto) throw new Error(`Respuesta sin texto (finishReason=${c?.finishReason})`);
    if (c?.finishReason === "MAX_TOKENS") texto += `\n\n(Respuesta resumida. Para más detalle, escríbenos por WhatsApp: ${WHATSAPP})`;
    console.log(`[rg-ai] ok gemini modelo=${modelo} in=${r.usageMetadata?.promptTokenCount} out=${r.usageMetadata?.candidatesTokenCount}`);
    return [200, { ok: true, reply: texto }];
  } catch (e) {
    console.error("[rg-ai] Error Gemini:", (e as Error).message);
    return [502, { ok: false, message: NO_DISPONIBLE }];
  }
}

if (import.meta.main) Deno.serve(manejar);
