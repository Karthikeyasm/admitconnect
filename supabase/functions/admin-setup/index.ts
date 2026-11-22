// AdmitConnect – Edge Function "admin-setup"
// Lets the business create its FIRST admin from the website (no backend person needed),
// and lets the admin hand the role over to someone else later.
//
// POST { action: "status" }                          → { needs_setup: true|false }        (public)
// POST { action: "create_admin", full_name, email, phone, setup_code, redirect_to }       (public, only while no admin exists)
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
const ALLOWED_REDIRECTS = ["https://karthikeyasm.github.io/admitconnect/"];

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

    // ---- 2. Create the first admin (only while none exists, only with the setup code) ----
    if (b.action === "create_admin") {
      if ((await adminCount()) > 0) return json({ error: "An admin already exists. Ask them to add you, or use Forgot password." }, 409);
      const code = Deno.env.get("ADMIN_SETUP_CODE") || "";
      if (!code) return json({ error: "Setup is locked: ADMIN_SETUP_CODE is not configured in Supabase." }, 503);
      if (String(b.setup_code || "") !== code) return json({ error: "The setup code is incorrect." }, 403);
      const fullName = String(b.full_name || "").trim(), email = String(b.email || "").trim().toLowerCase(), phone = String(b.phone || "").replace(/\D/g, "");
      if (fullName.length < 2) return json({ error: "Full name is required." }, 400);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return json({ error: "Invalid email ID." }, 400);
      if (!/^[6-9]\d{9}$/.test(phone)) return json({ error: "Phone must be a 10-digit Indian mobile number." }, 400);
      const redirectTo = ALLOWED_REDIRECTS.includes(b.redirect_to) ? b.redirect_to : ALLOWED_REDIRECTS[0];

      // Existing user with this email → promote; otherwise invite (email with set-password link)
      let userId: string | null = null;
      const { data: inv, error: invErr } = await db.auth.admin.inviteUserByEmail(email, { data: { full_name: fullName, phone, role: "admin" }, redirectTo });
      if (invErr) {
        if (!/already/i.test(invErr.message)) return json({ error: invErr.message }, 400);
        const { data: p } = await db.from("profiles").select("id").eq("email", email).single();
        if (!p) return json({ error: "This email exists but has no profile. Contact support." }, 400);
        userId = p.id;
        await db.auth.resetPasswordForEmail(email, { redirectTo });   // send a set-password link anyway
      } else userId = inv.user.id;

      const { error: pErr } = await db.from("profiles").upsert(
        { id: userId, full_name: fullName, email, phone, role: "admin", approved: true }, { onConflict: "id" });
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
