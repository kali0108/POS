// supabase/functions/shop-sync/index.ts
//
// Staff-triggered sync with the Foodies shop. Called from the POS
// "Online Orders" page. Needs the caller to hold `online_orders.manage`.
//
//   { "action": "push_catalog" }  POS -> website: price, stock, active (matched by SKU)
//   { "action": "pull_orders"  }  website -> POS: fetch confirmed orders the webhook missed
//
// Secrets:  SHOP_URL=https://your-shop.example   SHOP_API_KEY=<shop's POS_API_KEY>
// Deploy :  supabase functions deploy shop-sync        (JWT verification stays ON)

import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";

const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

const BATCH = 500; // the shop accepts up to 2000 per request
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return reply({ error: "POST only" }, 405);

  try {
    // 1. Who is calling, and may they?
    const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
    const caller = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: `Bearer ${token}` } },
    });
    const { data: allowed } = await caller.rpc("has_permission", { perm_key: "online_orders.manage" });
    if (!allowed) return reply({ error: "Not authorized to sync the online shop." }, 403);

    const shopUrl = (Deno.env.get("SHOP_URL") ?? "").replace(/\/+$/, "");
    const shopKey = Deno.env.get("SHOP_API_KEY") ?? "";
    if (!shopUrl || shopKey.length < 16) {
      return reply({ error: "SHOP_URL / SHOP_API_KEY are not set on the server." }, 503);
    }
    const shopHeaders = { Authorization: `Bearer ${shopKey}`, "Content-Type": "application/json" };

    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
      auth: { persistSession: false },
    });
    const { action } = await req.json().catch(() => ({ action: "" }));

    const { data: settings } = await admin.from("shop_settings").select("*").eq("id", true).single();

    // ---------------- POS -> website ----------------
    if (action === "push_catalog") {
      const branchId = settings?.default_branch_id;
      if (!branchId) return reply({ error: "Choose the branch that fulfils online orders first." }, 400);
      const { data: okBranch } = await caller.rpc("has_branch_access", { b_id: branchId });
      if (!okBranch) return reply({ error: "You do not have access to the online-shop branch." }, 403);

      const { data: branch } = await admin.from("branches").select("tax_rate_percent").eq("id", branchId).single();
      const rate = Number(branch?.tax_rate_percent ?? 0) / 100;
      const gross = settings.push_gross_prices !== false;

      const { data: items, error: iErr } = await admin
        .from("items")
        .select("id, sku, unit_price, is_active, pricing_mode")
        .not("sku", "is", null)
        .eq("pricing_mode", "unit"); // sold-by-weight items do not map onto a web "add to cart"
      if (iErr) throw new Error(iErr.message);

      const { data: stock } = await admin.from("branch_item_stock").select("item_id, quantity").eq("branch_id", branchId);
      const qty = new Map((stock ?? []).map((s) => [s.item_id, Number(s.quantity)]));

      // Push only SKUs the website already has. Otherwise every POS item that is
      // not sold online would come back as a "new product needs a category" error.
      const catRes = await fetch(`${shopUrl}/api/pos/products`, { headers: shopHeaders, signal: AbortSignal.timeout(20000) });
      const catBody = await catRes.json().catch(() => ({}));
      if (!catRes.ok) return reply({ error: `Shop returned HTTP ${catRes.status} reading its catalogue: ${catBody?.error ?? ""}` }, 502);
      const onShop = new Set(((catBody.products ?? []) as { sku: string | null }[]).map((p) => p.sku).filter(Boolean));
      const shopSkus = new Set(items?.map((i) => i.sku));
      const missingInPos = [...onShop].filter((s) => !shopSkus.has(s as string)) as string[];

      const products = (items ?? []).filter((i) => onShop.has(i.sku)).map((i) => ({
        sku: i.sku,
        price: round2(Number(i.unit_price) * (gross ? 1 + rate : 1)),
        // The shop treats 0 as SOLD OUT. Fractional / negative POS stock is clamped.
        stock: Math.max(0, Math.floor(qty.get(i.id) ?? 0)),
        active: i.is_active,
      }));

      const totals = {
        sent: products.length,
        created: 0,
        updated: 0,
        not_on_website: (items ?? []).length - products.length,
        // Website products whose SKU does not exist in the POS: they are never updated, so flag them.
        not_in_pos: missingInPos.slice(0, 50),
        errors: [] as string[],
      };
      for (let i = 0; i < products.length; i += BATCH) {
        const res = await fetch(`${shopUrl}/api/pos/products`, {
          method: "PUT",
          headers: shopHeaders,
          body: JSON.stringify({ products: products.slice(i, i + BATCH) }),
          signal: AbortSignal.timeout(30000),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          totals.errors.push(`HTTP ${res.status}: ${body?.error ?? "shop rejected the request"}`);
          break;
        }
        totals.created += Number(body.created ?? 0);
        totals.updated += Number(body.updated ?? 0);
        if (Array.isArray(body.errors)) totals.errors.push(...body.errors.map(String));
      }
      await admin.from("shop_settings")
        .update({ last_catalog_push_at: new Date().toISOString(), last_catalog_push_result: totals })
        .eq("id", true);
      return reply({ ok: totals.errors.length === 0, ...totals });
    }

    // ---------------- website -> POS (fallback for missed webhooks) ----------------
    if (action === "pull_orders") {
      const res = await fetch(`${shopUrl}/api/pos/orders`, { headers: shopHeaders, signal: AbortSignal.timeout(20000) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) return reply({ error: `Shop returned HTTP ${res.status}: ${body?.error ?? ""}` }, 502);

      const out = { found: 0, imported: 0, duplicates: 0, failed: [] as string[] };
      for (const order of (body.orders ?? []) as { id: string }[]) {
        out.found++;
        const { data, error } = await admin.rpc("receive_online_order", {
          payload: { event: "order.confirmed", order },
        });
        if (error) { out.failed.push(`${order.id}: ${error.message}`); continue; }
        if (data?.result === "created") out.imported++; else out.duplicates++;
        // Acknowledge ONLY after it is safely stored, so a crash here can never lose an order.
        await fetch(`${shopUrl}/api/pos/orders/${encodeURIComponent(order.id)}/ack`, {
          method: "POST", headers: shopHeaders, signal: AbortSignal.timeout(10000),
        }).catch(() => { /* will simply be re-pulled; receive is idempotent */ });
      }
      await admin.from("shop_settings").update({ last_order_pull_at: new Date().toISOString() }).eq("id", true);
      return reply({ ok: out.failed.length === 0, ...out });
    }

    return reply({ error: "action must be 'push_catalog' or 'pull_orders'" }, 400);
  } catch (e) {
    return reply({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
