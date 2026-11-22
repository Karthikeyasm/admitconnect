// AdmitConnect – Edge Function "admin-setup"
// Lets the business create its FIRST admin from the website (no backend person needed),
// and lets the admin hand the role over to someone else later.
//
// POST { action: "status" }                          → { needs_setup: true|false }        (public)
// POST { action: "verify_code", email, setup_code }  → { ok } if the admin code is right  (public, only while no admin exists)
// POST { action: "create_admin", email, setup_code, full_name, password } → admin created (public, only while no admin exists)
// POST { action: "transfer", to_user_id }            → current admin becomes counsellor,   (logged-in admin only)
//                                                       chosen user becomes the one admin
// Deploy with "Verify JWT" OFF (the first admin has no login yet). Secret needed: ADMIN_SETUP_CODE.

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

    // ---- 2. First login: check the admin code, then create the admin with the chosen password ----
    const checkCode = async () => {
      if ((await adminCount()) > 0) return json({ error: "An admin already exists. Please log in, or ask the admin to add you." }, 409);
      const code = Deno.env.get("ADMIN_SETUP_CODE") || "";
      if (!code) return json({ error: "The admin code has not been set on the server yet." }, 503);
      if (String(b.setup_code || "") !== code) {
        await new Promise((r) => setTimeout(r, 1500));            // slow down guessing
        return json({ error: "The admin code is incorrect." }, 403);
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(b.email || ""))) return json({ error: "Invalid email ID." }, 400);
      return null;
    };
    if (b.action === "verify_code") return (await checkCode()) ?? json({ ok: true });

    if (b.action === "create_admin") {
      const bad = await checkCode(); if (bad) return bad;
      const email = String(b.email).trim().toLowerCase(), fullName = String(b.full_name || "").trim(), pw = String(b.password || "");
      if (fullName.length < 2) return json({ error: "Full name is required." }, 400);
      if (pw.length < 8 || !/[A-Za-z]/.test(pw) || !/\d/.test(pw)) return json({ error: "Password must be at least 8 characters with letters and numbers." }, 400);

      // New user → create with the chosen password (email counts as confirmed: the admin code proves who they are).
      // Existing user with this email → set the password and promote.
      let userId: string;
      const { data: cu, error: cErr } = await db.auth.admin.createUser({ email, password: pw, email_confirm: true, user_metadata: { full_name: fullName, role: "admin" } });
      if (cErr) {
        if (!/already/i.test(cErr.message)) return json({ error: cErr.message }, 400);
        const { data: p } = await db.from("profiles").select("id").eq("email", email).single();
        if (!p) return json({ error: "This email exists but has no profile. Contact support." }, 400);
        userId = p.id;
        const { error: uErr } = await db.auth.admin.updateUserById(userId, { password: pw, email_confirm: true });
        if (uErr) return json({ error: uErr.message }, 400);
      } else userId = cu.user.id;

      const { error: pErr } = await db.from("profiles").upsert(
        { id: userId, full_name: fullName, email, role: "admin", approved: true }, { onConflict: "id" });
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
