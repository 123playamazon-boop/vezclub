// Vezclub — endpoint de chat (MVP). Provedor swappable via app_config. Drip de presentes.
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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE);

    const userId = userIdFromJwt(req.headers.get("Authorization") || "");
    if (!userId) return json({ error: "auth" }, 401);

    const { creator_key, message } = await req.json();
    if (!creator_key || !message) return json({ error: "missing" }, 400);

    const { data: persona } = await admin.from("chat_personas").select("*").eq("creator_key", creator_key).eq("active", true).single();
    if (!persona) return json({ error: "persona_not_found" }, 404);

    const { data: cred } = await admin.from("chat_credits").select("seconds_balance").eq("user_id", userId).single();
    const balance = cred?.seconds_balance ?? 0;
    if (balance <= 0) return json({ error: "no_credit", balance: 0 }, 402);

    let thread = (await admin.from("chat_threads").select("id,user_msgs,gift_idx,human_mode,flagged").eq("user_id", userId).eq("creator_key", creator_key).single()).data;
    if (!thread) {
      thread = (await admin.from("chat_threads").insert({ user_id: userId, creator_key }).select("id,user_msgs,gift_idx,human_mode,flagged").single()).data;
    }

    const { data: mem } = await admin.from("chat_memory").select("summary").eq("user_id", userId).eq("creator_key", creator_key).single();
    const { data: recent } = await admin.from("chat_messages").select("role,content").eq("thread_id", thread!.id).order("created_at", { ascending: false }).limit(16);
    const history = (recent || []).reverse();

    await admin.from("chat_messages").insert({ thread_id: thread!.id, user_id: userId, role: "user", content: message });

    // --- deteccao de risco: sinaliza pro time entrar (intervencao humana) ---
    const low = (message || "").toLowerCase();
    const RISK = /(charge\s?back|estorno|estornar|reembols|cancel(ar|amento|o|a)|quero meu dinheiro|meu dinheiro de volta|dinheiro de volta|processar|advogad|procon|pol[ií]cia|denunci|fraude|golpe|me enganaram|tô sendo roubad|to sendo roubad)/;
    const WELL = /(suic[ií]d|me matar|quero morrer|vou me machucar|me machucar|automutila|não aguento mais viver|nao aguento mais viver)/;
    let flagReason: string | null = null;
    if (WELL.test(low)) flagReason = "bem-estar";
    else if (RISK.test(low)) flagReason = "risco de cancelamento/chargeback";
    if (flagReason && !thread!.flagged) {
      try {
        await admin.from("chat_threads").update({ flagged: true, flag_reason: flagReason, flagged_at: new Date().toISOString() }).eq("id", thread!.id);
        const { data: hooks } = await admin.from("alert_webhooks").select("url").eq("active", true);
        const title = encodeURIComponent("⚠️ Chat precisa de atenção");
        const text = encodeURIComponent(`${creator_key}: "${(message || "").slice(0, 90)}" — ${flagReason}`);
        for (const h of (hooks || [])) { try { await fetch(`${h.url}?title=${title}&text=${text}`, { method: "POST" }); } catch (_) {} }
      } catch (_) {}
    }

    // --- modo humano: o robô fica em silêncio; um atendente responde pelo painel ---
    if (thread!.human_mode) {
      const { data: credH } = await admin.from("chat_credits").select("seconds_balance").eq("user_id", userId).single();
      return json({ human: true, balance: credH?.seconds_balance ?? balance });
    }

    const { data: cfg } = await admin.from("app_config").select("key,value").in("key", ["OPENAI_API_KEY", "OPENAI_BASE_URL"]);
    const cfgMap: Record<string, string> = {};
    for (const row of (cfg || [])) cfgMap[row.key] = row.value;
    const MODEL_KEY = Deno.env.get("OPENAI_API_KEY") || cfgMap["OPENAI_API_KEY"] || "";
    const MODEL_BASE = Deno.env.get("OPENAI_BASE_URL") || cfgMap["OPENAI_BASE_URL"] || "https://api.openai.com/v1";
    if (!MODEL_KEY) return json({ error: "no_model_key" }, 503);

    const sys = persona.system_prompt + (mem?.summary ? `\n\n[O que você já sabe sobre ele]\n${mem.summary}` : "");
    const messages = [{ role: "system", content: sys }, ...history.map((m: any) => ({ role: m.role, content: m.content })), { role: "user", content: message }];

    const r = await fetch(`${MODEL_BASE}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${MODEL_KEY}` },
      body: JSON.stringify({ model: persona.model || "gpt-4o-mini", messages, temperature: 0.9, max_tokens: 400 }),
    });
    const out = await r.json();
    if (!r.ok) return json({ error: "model_error", detail: out }, 502);
    const reply = out?.choices?.[0]?.message?.content?.trim() || "...";

    await admin.from("chat_messages").insert({ thread_id: thread!.id, user_id: userId, role: "assistant", content: reply });

    // drip de presentes: a cada N mensagens do usuário, manda a próxima imagem
    const userMsgs = (thread!.user_msgs || 0) + 1;
    let giftIdx = thread!.gift_idx || 0;
    let gift = null;
    const gifts = Array.isArray(persona.gift_images) ? persona.gift_images : [];
    const every = persona.gift_every || 4;
    const firstAt = 2; // primeira foto cedo, pra empolgar ainda no minuto grátis
    const giftDue = giftIdx === 0 ? (userMsgs >= firstAt) : ((userMsgs - firstAt) % every === 0 && userMsgs > firstAt);
    if (giftDue && giftIdx < gifts.length) {
      const g = gifts[giftIdx];
      gift = { url: `${SUPABASE_URL}/storage/v1/object/public/avatars/${g.path}`, caption: g.caption || "" };
      giftIdx += 1;
    }
    await admin.from("chat_threads").update({ last_message_at: new Date().toISOString(), user_msgs: userMsgs, gift_idx: giftIdx }).eq("id", thread!.id);

    const cost = persona.credit_cost_per_msg ?? 20;
    const newBal = Math.max(0, balance - cost);
    await admin.from("chat_credits").update({ seconds_balance: newBal, updated_at: new Date().toISOString() }).eq("user_id", userId);
    await admin.from("credit_ledger").insert({ user_id: userId, delta_seconds: -cost, reason: "chat" });

    return json({ reply, balance: newBal, gift });
  } catch (e) {
    return json({ error: "server", detail: String(e) }, 500);
  }
});
