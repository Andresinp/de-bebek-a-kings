// Corrects a Spanish learner's spoken or written text with Claude and returns
// { corrections: [{ from, to, why }] }, where `from` is an exact piece of the text.
// Called from the speech/study maps on andresinp.github.io (any student). Each page sends
// { text, context }: `context` says who the student is and what the task is (level, topic, facts).
// Secret needed in the Supabase project: ANTHROPIC_API_KEY. Deploy with --no-verify-jwt
// (the page has no login); only the allowed origins below get CORS headers.
// Source of truth: _canon/skills/speech-map/assets/corregir/index.ts (copied into each site repo).
import Anthropic from "npm:@anthropic-ai/sdk@1.11.0";

const ALLOWED = ["https://andresinp.github.io", "http://localhost:8765"];
const MAX_CHARS = 12000;
const MAX_CONTEXT = 2000;

const SYSTEM = `Eres profesor de español de España. Corriges lo que ha dicho o escrito un estudiante.
El texto suele venir de un reconocimiento de voz: ignora la puntuación, las mayúsculas y las palabras
repetidas típicas del habla; corrige solo errores reales de español. El contexto de la tarea (estudiante,
nivel, tema, datos correctos) viene en la etiqueta <contexto>.

Busca sobre todo:
- tiempos verbales: para contar el argumento de una película, un libro o un chiste se usa el PRESENTE;
  en anécdotas personales, indefinido para acciones terminadas e imperfecto para descripciones y hábitos;
- artículos: género (una película), artículo que falta (me gusta la música) o que sobra (ser músico, la su familia);
- concordancia de género y número (la animación es bonita, la gente es simpática);
- ser / estar, por / para, la "a" de persona (busca a su padre), pronombres (le / lo / la / se lo),
  subjuntivo cuando es obligatorio (quiere que esté), persona del verbo (él quiere),
  tildes que cambian el sentido (él / el, está / esta);
- datos falsos sobre el tema, si el contexto los da.

Reglas de la respuesta:
- "from" es un trozo COPIADO EXACTAMENTE del texto, lo más corto posible pero que se entienda (2–6 palabras).
- "to" es ese mismo trozo corregido, listo para sustituirlo.
- "why" es la razón en español muy sencillo, máximo 12 palabras.
- No cambies el estilo ni reescribas frases correctas. Si no hay errores, devuelve una lista vacía.`;

const SCHEMA = {
  type: "object",
  properties: {
    corrections: {
      type: "array",
      items: {
        type: "object",
        properties: { from: { type: "string" }, to: { type: "string" }, why: { type: "string" } },
        required: ["from", "to", "why"],
        additionalProperties: false,
      },
    },
  },
  required: ["corrections"],
  additionalProperties: false,
};

type Correction = { from: string; to: string; why: string };

// The model's output is untrusted: keep only well-formed items whose `from` really is in the text.
function parseCorrections(raw: unknown, text: string): Correction[] {
  const list = typeof raw === "object" && raw !== null ? (raw as { corrections?: unknown }).corrections : undefined;
  if (!Array.isArray(list)) return [];
  return list.flatMap((c: unknown) => {
    if (typeof c !== "object" || c === null) return [];
    const { from, to, why } = c as Record<string, unknown>;
    if (typeof from !== "string" || typeof to !== "string" || typeof why !== "string") return [];
    if (!from || from === to || !text.includes(from)) return [];
    return [{ from, to, why }];
  });
}

const client = new Anthropic(); // reads ANTHROPIC_API_KEY

function cors(origin: string | null): Record<string, string> {
  if (!origin || !ALLOWED.includes(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type",
    "Vary": "Origin",
  };
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  const h = cors(origin);
  if (req.method === "OPTIONS") return new Response(null, { status: h["Access-Control-Allow-Origin"] ? 204 : 403, headers: h });
  if (req.method !== "POST" || !h["Access-Control-Allow-Origin"]) return new Response("forbidden", { status: 403 });

  let body: unknown;
  try { body = await req.json(); } catch (e) {
    console.error("corregir: body is not JSON", e);
    return Response.json({ error: "body must be JSON" }, { status: 400, headers: h });
  }
  const field = (k: string): string => {
    const v = typeof body === "object" && body !== null ? (body as Record<string, unknown>)[k] : undefined;
    return typeof v === "string" ? v : "";
  };
  const text = field("text");
  const context = field("context").slice(0, MAX_CONTEXT);
  if (!text.trim() || text.length > MAX_CHARS) {
    return Response.json({ error: "text must be 1–" + MAX_CHARS + " characters" }, { status: 400, headers: h });
  }

  try {
    const res = await client.beta.messages.create({
      model: "claude-opus-5-5",
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "medium", format: { type: "json_schema", schema: SCHEMA } },
      system: SYSTEM,
      messages: [{ role: "user", content: (context ? "<contexto>\n" + context + "\n</contexto>\n\n" : "") + "<texto>\n" + text + "\n</texto>" }],
    });
    if (res.stop_reason === "refusal") return Response.json({ error: "refused" }, { status: 502, headers: h });
    const block = res.content.find((b) => b.type === "text");
    if (!block || block.type !== "text") return Response.json({ error: "no answer" }, { status: 502, headers: h });
    return Response.json({ corrections: parseCorrections(JSON.parse(block.text), text) }, { headers: h });
  } catch (e) {
    console.error("corregir:", e);
    if (e instanceof Anthropic.RateLimitError) return Response.json({ error: "busy" }, { status: 429, headers: h });
    if (e instanceof Anthropic.APIError) return Response.json({ error: "api " + e.status }, { status: 502, headers: h });
    if (e instanceof SyntaxError) return Response.json({ error: "bad json from model" }, { status: 502, headers: h });
    return Response.json({ error: "failed" }, { status: 500, headers: h });
  }
});
