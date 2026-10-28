// Vezclub — sobe imagens da tabela temporaria tmp_vez_img pro bucket avatars (service role). Admin-only.
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
    const { data: prof } = await admin.from("profiles").select("is_admin").eq("id", userId).single();
    if (!prof?.is_admin) return json({ error: "forbidden" }, 403);

    let prefix = "";
    try { const body = await req.json(); prefix = (body && body.prefix) || ""; } catch (_) {}

    let q = admin.from("tmp_vez_img").select("path,b64");
    if (prefix) q = q.like("path", prefix + "%");
    const { data: rows, error } = await q;
    if (error) return json({ error: "read", detail: error.message }, 500);

    const out: Array<{ path: string; ok: boolean; bytes?: number; err?: string }> = [];
    for (const r of (rows || [])) {
      try {
        const bin = atob(r.b64 as string);
        const arr = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        const up = await admin.storage.from("avatars").upload(r.path as string, arr, { contentType: "image/webp", upsert: true });
        out.push({ path: r.path as string, ok: !up.error, bytes: arr.length, err: up.error?.message });
      } catch (e) {
        out.push({ path: r.path as string, ok: false, err: String(e) });
      }
    }
    return json({ uploaded: out, count: out.length });
  } catch (e) {
    return json({ error: "server", detail: String(e) }, 500);
  }
});
