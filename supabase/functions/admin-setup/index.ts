// AdmitConnect – Edge Function "admin-setup"
// Lets the business create its FIRST admin from the website (no backend person needed),
// and lets the admin hand the role over to someone else later.
//
// POST { action: "status" }                          → { needs_setup: true|false }        (public)
// POST { action: "request_code", email }            → creates the admin login (only the admin email, only while no admin exists);
//                                                       the website then asks Supabase Auth to email a one-time code
// POST { action: "claim_admin", full_name }          → (logged in via the code) becomes the one admin
// POST { action: "transfer", to_user_id }            → current admin becomes counsellor,   (logged-in admin only)
//                                                       chosen user becomes the one admin
// Deploy with "Verify JWT" OFF (the first admin has no login yet). Optional secret ADMIN_EMAIL (default anushncc2@gmail.com).

import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Use POST" }, 405);
  try {
    const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
                            { auth: { persistSession: false, autoRefreshToken: false } });
    const b = await req.json().catch(() => ({}));
    const adminCount = async () => {
      const { count } = await db.from("profiles").select("id", { count: "exact", head: true }).eq("role", "admin");
      return count ?? 0;
    };

    // ---- 1. Does the site still need its first admin? ----
    if (b.action === "status") return json({ needs_setup: (await adminCount()) === 0 });

    // ---- 2. First login: the admin email gets a one-time code by email (sent by Supabase Auth) ----
    // Only the configured admin email can become admin, and only while no admin exists.
    const ADMIN_EMAILS = (Deno.env.get("ADMIN_EMAIL") || "anushncc2@gmail.com").toLowerCase().split(",").map((s) => s.trim());
    const gate = async (email: string) => {
      if ((await adminCount()) > 0) return json({ error: "An admin already exists. Please log in, or use Forgot password." }, 409);
      if (!ADMIN_EMAILS.includes(email)) {
        await new Promise((r) => setTimeout(r, 1000));
        return json({ error: "This email is not registered as the AdmitConnect admin." }, 403);
      }
      return null;
    };

    // 2a. Make sure the admin's login exists, so the website can email the code
    if (b.action === "request_code") {
      const email = String(b.email || "").trim().toLowerCase();
      const bad = await gate(email); if (bad) return bad;
      const { error } = await db.auth.admin.createUser({ email, email_confirm: true, user_metadata: { role: "admin" } });
      if (error && !/already/i.test(error.message)) return json({ error: error.message }, 400);
      return json({ ok: true });
    }

    // 2b. After the code is verified and the password set: make this logged-in user the admin
    if (b.action === "claim_admin") {
      const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
      const { data: who } = await db.auth.getUser(token);
      if (!who?.user) return json({ error: "Please verify the email code again." }, 401);
      const email = (who.user.email || "").toLowerCase();
      const bad = await gate(email); if (bad) return bad;
      const fullName = String(b.full_name || "").trim();
      if (fullName.length < 2) return json({ error: "Full name is required." }, 400);
      const { error: pErr } = await db.from("profiles").upsert(
        { id: who.user.id, full_name: fullName, email, role: "admin", approved: true }, { onConflict: "id" });
      if (pErr) return json({ error: "Could not save the admin profile: " + pErr.message }, 500);
      return json({ ok: true });
    }

    // ---- 3. Hand the admin role to another existing user ----
    if (b.action === "transfer") {
      const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
      const { data: who } = await db.auth.getUser(token);
      if (!who?.user) return json({ error: "Please log in again." }, 401);
      const { data: me } = await db.from("profiles").select("role, approved").eq("id", who.user.id).single();
      if (!me || me.role !== "admin" || !me.approved) return json({ error: "Only the admin can transfer the role." }, 403);
      const to = String(b.to_user_id || "");
      if (!to || to === who.user.id) return json({ error: "Choose another user." }, 400);
      const { data: target } = await db.from("profiles").select("id, full_name").eq("id", to).single();
      if (!target) return json({ error: "User not found." }, 404);
      // one admin at a time: demote first, then promote (roll back if promotion fails)
      const d = await db.from("profiles").update({ role: "counsellor" }).eq("id", who.user.id);
      if (d.error) return json({ error: d.error.message }, 500);
      const pr = await db.from("profiles").update({ role: "admin", approved: true }).eq("id", to);
      if (pr.error) { await db.from("profiles").update({ role: "admin" }).eq("id", who.user.id); return json({ error: pr.error.message }, 500); }
      return json({ ok: true, new_admin: target.full_name });
    }

    return json({ error: "Unknown action." }, 400);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
