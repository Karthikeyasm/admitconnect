# AdmitConnect – setup for admin-created accounts

Accounts are **created by an admin only** (no self-registration). The new person gets an email with a
link to set their own password. The link is valid for the time set in Supabase (max 24 hours).
"First-time login / Forgot password?" on the login page sends a fresh link.

Do these steps **once**, in https://supabase.com → project **admitconnect**.

## 1. Turn off public sign-up
Authentication → **Sign In / Providers** → turn **off** "Allow new users to sign up" → Save.
(Admin invites still work.)

## 2. Where the email links should open
Authentication → **URL Configuration**
- Site URL: `https://karthikeyasm.github.io/admitconnect/`
- Redirect URLs → Add: `https://karthikeyasm.github.io/admitconnect/`
→ Save.

## 3. How long the link stays valid
Authentication → **Providers → Email** → "Email OTP Expiration" → `86400` (24 hours; this is the maximum),
or `3600` for 1 hour → Save.

## 4. Create the "invite-user" function
Edge Functions → **Deploy a new function** → **Via Editor**
- Function name: `invite-user`
- Replace the sample code with everything in `supabase/functions/invite-user/index.ts` (this repository) → **Deploy**.
- Keep "Verify JWT" **on**.
No secrets to add – Supabase provides the keys to the function automatically.

## 5. Make yourself the first admin (only once)
If you don't have an account yet: Authentication → Users → **Add user → Send invitation** to your own email.
Then Table Editor → `profiles` → your row → `role = admin`, `approved = true` → Save.
Open the email, set your password, log in.

## 6. Add people
Website → Settings → 👥 Accounts → **➕ Add user** → name, email, phone, role (and college) →
**Create account & send invite**. They open the email, set a password, and log in from any laptop.
Resend a link any time with **✉ Send set-password link** in the same table.

## Email delivery (before real use)
Supabase's built-in email sender is for testing only and sends just a few emails per hour.
Connect your own sender: Authentication → **Emails → SMTP Settings** (e.g. Google Workspace, Brevo, Resend).
You can also edit the wording of the "Invite user" and "Reset password" emails there.

## Troubleshooting
- "function is not set up" → step 4 not done, or the name is not exactly `invite-user`.
- "Only approved admins can add users" → your `profiles` row is not `role = admin`, `approved = true`.
- "saving the profile failed" → a database rule blocks the update; check the `profiles` triggers/policies.
- Link says expired → use "First-time login / Forgot password?" to get a new one.
