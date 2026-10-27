// Vezclub — endpoint de chat (MVP). Provedor swappable via env.
// Deploy: Supabase Edge Function "chat".
// Secrets necessários: OPENAI_API_KEY (e, opcional, OPENAI_BASE_URL para trocar de provedor).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const MODEL_KEY = Deno.env.get("OPENAI_API_KEY") || "";
const MODEL_BASE = Deno.env.get("OPENAI_BASE_URL") || "https://api.openai.com/v1";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE);

    // autentica o usuário pelo JWT
    const token = (req.headers.get("Authorization") || "").replace("Bearer ", "");
    const { data: ures } = await admin.auth.getUser(token);
    const user = ures?.user;
    if (!user) return json({ error: "auth" }, 401);

    const { creator_key, message } = await req.json();
    if (!creator_key || !message) return json({ error: "missing" }, 400);

    // persona
    const { data: persona } = await admin
      .from("chat_personas").select("*")
      .eq("creator_key", creator_key).eq("active", true).single();
    if (!persona) return json({ error: "persona_not_found" }, 404);

    // crédito
    const { data: cred } = await admin
      .from("chat_credits").select("seconds_balance").eq("user_id", user.id).single();
    const balance = cred?.seconds_balance ?? 0;
    if (balance <= 0) return json({ error: "no_credit", balance: 0 }, 402);

    // thread (cria se não existir)
    let thread = (await admin.from("chat_threads").select("id")
      .eq("user_id", user.id).eq("creator_key", creator_key).single()).data;
    if (!thread) {
      thread = (await admin.from("chat_threads")
        .insert({ user_id: user.id, creator_key }).select("id").single()).data;
    }

    // memória + histórico recente
    const { data: mem } = await admin.from("chat_memory").select("summary")
      .eq("user_id", user.id).eq("creator_key", creator_key).single();
    const { data: recent } = await admin.from("chat_messages").select("role,content")
      .eq("thread_id", thread!.id).order("created_at", { ascending: false }).limit(16);
    const history = (recent || []).reverse();

    // grava a mensagem do usuário
    await admin.from("chat_messages")
      .insert({ thread_id: thread!.id, user_id: user.id, role: "user", content: message });

    if (!MODEL_KEY) return json({ error: "no_model_key" }, 503);

    const sys = persona.system_prompt +
      (mem?.summary ? `\n\n[O que você já sabe sobre ele]\n${mem.summary}` : "");
    const messages = [
      { role: "system", content: sys },
      ...history.map((m: any) => ({ role: m.role, content: m.content })),
      { role: "user", content: message },
    ];

    const r = await fetch(`${MODEL_BASE}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${MODEL_KEY}` },
      body: JSON.stringify({
        model: persona.model || "gpt-4o-mini",
        messages,
        temperature: 0.9,
        max_tokens: 400,
      }),
    });
    const out = await r.json();
    if (!r.ok) return json({ error: "model_error", detail: out }, 502);
    const reply = out?.choices?.[0]?.message?.content?.trim() || "...";

    // grava resposta + consome crédito
    await admin.from("chat_messages")
      .insert({ thread_id: thread!.id, user_id: user.id, role: "assistant", content: reply });
    await admin.from("chat_threads")
      .update({ last_message_at: new Date().toISOString() }).eq("id", thread!.id);

    const cost = persona.credit_cost_per_msg ?? 20;
    const newBal = Math.max(0, balance - cost);
    await admin.from("chat_credits")
      .update({ seconds_balance: newBal, updated_at: new Date().toISOString() })
      .eq("user_id", user.id);
    await admin.from("credit_ledger")
      .insert({ user_id: user.id, delta_seconds: -cost, reason: "chat" });

    return json({ reply, balance: newBal });
  } catch (e) {
    return json({ error: "server", detail: String(e) }, 500);
  }
});
