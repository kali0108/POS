// supabase/functions/shop-webhook/index.ts
//
// Receives order events from the Foodies online shop and drops them in the
// POS inbox (online_orders). It does NOT create invoices — staff do that
// when the order is fulfilled (see fulfil_online_order in 0027).
//
// DEPLOY WITH --no-verify-jwt: the shop is not a Supabase user and sends no
// Supabase JWT. Authentication here is the HMAC signature instead.
//   supabase functions deploy shop-webhook --no-verify-jwt
//   supabase secrets set SHOP_WEBHOOK_SECRET=<same value as the shop's POS_WEBHOOK_SECRET>
//
// Shop setting:  POS_WEBHOOK_URL=https://<project>.supabase.co/functions/v1/shop-webhook
//
// Response codes matter: the shop treats any non-2xx as a failure and retries
// (3 attempts, then it shows "SEND TO POS" in its admin). Duplicates return 200.

import { createClient } from "npm:@supabase/supabase-js@2";
import { verifyShopSignature } from "../_shared/shopSignature.ts";

const MAX_BODY_BYTES = 256 * 1024;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const secret = Deno.env.get("SHOP_WEBHOOK_SECRET") ?? "";
  if (secret.length < 16) return json({ error: "Webhook is not configured (SHOP_WEBHOOK_SECRET)." }, 503);

  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) return json({ error: "Payload too large" }, 413);

  // Verify BEFORE parsing or touching the database.
  if (!(await verifyShopSignature(secret, raw, req.headers.get("x-signature")))) {
    return json({ error: "Invalid signature" }, 401);
  }

  let payload: { event?: string; order?: unknown };
  try {
    payload = JSON.parse(raw);
  } catch {
    return json({ error: "Body is not valid JSON" }, 400);
  }

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });

  const { data, error } = await admin.rpc("receive_online_order", { payload });
  if (error) {
    // 400, not 500: a bad payload will never succeed on retry, and the message
    // shows up in the shop's admin so someone can see why.
    console.error("receive_online_order failed:", error.message);
    return json({ error: error.message }, 400);
  }
  return json(data);
});
