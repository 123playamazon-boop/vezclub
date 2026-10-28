// Vezclub — tradução simultânea pro atendimento humano. Admin-only. Usa a mesma chave do chat.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json" } });
}
function userIdFromJwt(authHeader: string): string | null {
  try {
    const jwt = authHeader.replace(/^Bearer\s+/i, "");
    let b = jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    while (b.length % 4) b += "=";
    return JSON.parse(atob(b)).sub || null;
  } catch (_) { return null; }
}

const LANGS: Record<string, string> = { pt: "Portuguese (Brazil)", en: "English", es: "Spanish" };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE);
    const userId = userIdFromJwt(req.headers.get("Authorization") || "");
    if (!userId) return json({ error: "auth" }, 401);
    const { data: prof } = await admin.from("profiles").select("is_admin").eq("id", userId).single();
    if (!prof?.is_admin) return json({ error: "forbidden" }, 403);

    const { text, to } = await req.json();
    if (!text || !to || !LANGS[to]) return json({ error: "missing" }, 400);

    const { data: cfg } = await admin.from("app_config").select("key,value").in("key", ["OPENAI_API_KEY", "OPENAI_BASE_URL"]);
    const map: Record<string, string> = {};
    for (const r of (cfg || [])) map[r.key] = r.value;
    const KEY = Deno.env.get("OPENAI_API_KEY") || map["OPENAI_API_KEY"] || "";
    const BASE = Deno.env.get("OPENAI_BASE_URL") || map["OPENAI_BASE_URL"] || "https://api.openai.com/v1";
    if (!KEY) return json({ error: "no_model_key" }, 503);

    const sys = `You are a professional real-time chat translator for a casual flirty adult chat app. Translate the user's message into ${LANGS[to]}. Output ONLY the translation — no quotes, no explanations, no notes. Keep the casual, flirty, intimate tone, slang, abbreviations, emojis and punctuation. Do not censor or soften. If the text is already in ${LANGS[to]}, return it unchanged.`;
    const r = await fetch(`${BASE}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ model: "gpt-4o-mini", temperature: 0.2, max_tokens: 600, messages: [{ role: "system", content: sys }, { role: "user", content: text }] }),
    });
    const out = await r.json();
    if (!r.ok) return json({ error: "model_error", detail: out }, 502);
    const t = out?.choices?.[0]?.message?.content?.trim() ?? text;
    return json({ text: t });
  } catch (e) {
    return json({ error: "server", detail: String(e) }, 500);
  }
});
