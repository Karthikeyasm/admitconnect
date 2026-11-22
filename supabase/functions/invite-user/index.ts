// AdmitConnect – Edge Function "invite-user"
// Lets an approved ADMIN create an account for someone else and email them a set-password link.
// Runs inside Supabase, so the secret service-role key never reaches the browser.
//
// Request (POST, JSON, called from the website with the admin's login token):
//   { full_name, email, phone, role: "counsellor" | "college" | "admin", college?, employee_id?, redirect_to }
// Response: { ok: true, user_id } or { error: "..." }

import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const ROLES = ["counsellor", "college", "admin"];
// Only these sites may receive the set-password link
const ALLOWED_REDIRECTS = ["https://karthikeyasm.github.io/admitconnect/"];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Use POST" }, 405);

  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;   // provided automatically by Supabase
    const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

    // 1. Who is calling? Must be a logged-in, approved admin.
    const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    const { data: who, error: whoErr } = await admin.auth.getUser(token);
    if (whoErr || !who?.user) return json({ error: "Please log in again." }, 401);
    const { data: me, error: meErr } = await admin.from("profiles").select("role, approved").eq("id", who.user.id).single();
    if (meErr || !me || me.role !== "admin" || !me.approved) return json({ error: "Only approved admins can add users." }, 403);

    // 2. Validate the new user's details.
    const b = await req.json();
    const fullName = String(b.full_name || "").trim();
    const email = String(b.email || "").trim().toLowerCase();
    const phone = String(b.phone || "").replace(/\D/g, "");
    const role = String(b.role || "counsellor");
    const college = role === "college" ? (b.college ? String(b.college) : null) : null;
    const employeeId = b.employee_id ? String(b.employee_id).trim() : null;
    const redirectTo = ALLOWED_REDIRECTS.includes(b.redirect_to) ? b.redirect_to : ALLOWED_REDIRECTS[0];
    if (fullName.length < 2) return json({ error: "Full name is required." }, 400);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return json({ error: "Invalid email ID." }, 400);
    if (!/^[6-9]\d{9}$/.test(phone)) return json({ error: "Phone must be a 10-digit Indian mobile number." }, 400);
    if (!ROLES.includes(role)) return json({ error: "Invalid role." }, 400);
    if (role === "college" && !college) return json({ error: "Choose the college for a college partner." }, 400);

    // 3. Create the account and send the invite email (link validity = Auth › Email OTP expiration).
    const { data: inv, error: invErr } = await admin.auth.admin.inviteUserByEmail(email, {
      data: { full_name: fullName, phone, role, college },
      redirectTo,
    });
    if (invErr) {
      const m = invErr.message || "";
      if (/already/i.test(m)) return json({ error: "An account with this email already exists. Use 'Send set-password link' instead." }, 409);
      return json({ error: m }, 400);
    }
    const userId = inv.user.id;

    // 4. Make sure the profile row has the admin's chosen details and is active.
    const { error: pErr } = await admin.from("profiles").upsert(
      { id: userId, full_name: fullName, email, phone, role, college, employee_id: employeeId, approved: true },
      { onConflict: "id" },
    );
    if (pErr) return json({ error: "Invite sent, but saving the profile failed: " + pErr.message, user_id: userId }, 500);

    return json({ ok: true, user_id: userId });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
