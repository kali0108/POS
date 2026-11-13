import { Fragment, useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabaseClient';
import { useAuth } from '../context/AuthContext';

// Orders placed on the Foodies website land here (see supabase/migrations/0027).
// new -> accepted (a branch takes it) -> fulfilled (invoice created, stock deducted)
const STATUS_BADGE = { new: 'warning', accepted: 'neutral', fulfilled: 'success', rejected: 'danger', cancelled: 'danger' };
const PAY_LABEL = { cod: 'Cash on delivery', transfer: 'Online transfer', card: 'Card' };
const FILTERS = [['open', 'To do'], ['fulfilled', 'Fulfilled'], ['closed', 'Rejected / cancelled'], ['all', 'All']];

async function callShopSync(action) {
  const { data } = await supabase.auth.getSession();
  const token = data?.session?.access_token;
  if (!token) throw new Error('Your session has expired — please sign in again.');
  const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/shop-sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ action }),
  });
  let json;
  try { json = await res.json(); } catch { throw new Error(`Unexpected response (status ${res.status}). Is the shop-sync Edge Function deployed?`); }
  if (!res.ok) throw new Error(json.error || 'Request failed');
  return json;
}

export default function OnlineOrders() {
  const { isOwner, can, branches, currentBranchId } = useAuth();
  const canManage = isOwner || can('online_orders.manage');
  const canSettings = isOwner || can('branches.manage');
  const [filter, setFilter] = useState('open');
  const [orders, setOrders] = useState([]);
  const [lines, setLines] = useState({});       // order_id -> items
  const [open, setOpen] = useState(null);
  const [settings, setSettings] = useState(null);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  const load = useCallback(async () => {
    const [o, s] = await Promise.all([
      supabase.from('online_orders')
        .select('id, external_ref, branch_id, status, cancel_requested, payment_method, payment_status, customer_name, customer_phone, customer_address, customer_notes, subtotal, delivery_fee, total_amount, received_at, invoice_id, reject_reason, branches(name, code, currency_symbol)')
        .order('received_at', { ascending: false }).limit(300),
      supabase.from('shop_settings').select('*').eq('id', true).maybeSingle(),
    ]);
    if (o.error) setError(o.error.message); else setOrders(o.data || []);
    if (s.data) setSettings(s.data);
  }, []);

  useEffect(() => { load(); const t = setInterval(load, 30000); return () => clearInterval(t); }, [load]);

  async function toggle(order) {
    if (open === order.id) { setOpen(null); return; }
    setOpen(order.id);
    if (!lines[order.id]) {
      const { data } = await supabase.from('online_order_items').select('id, sku, item_id, name, unit_price, quantity').eq('order_id', order.id).order('name');
      setLines((l) => ({ ...l, [order.id]: data || [] }));
    }
  }

  async function run(label, fn) {
    setBusy(label); setError(null); setNotice(null);
    try { await fn(); await load(); } catch (e) { setError(e.message || String(e)); } finally { setBusy(null); }
  }

  const rpc = (name, args, okMsg) => run(`${name}:${args.p_order_id}`, async () => {
    const { data, error: err } = await supabase.rpc(name, args);
    if (err) throw new Error(err.message);
    if (okMsg) setNotice(typeof okMsg === 'function' ? okMsg(data) : okMsg);
    setLines((l) => { const n = { ...l }; delete n[args.p_order_id]; return n; });
  });

  const shown = orders.filter((o) => {
    if (filter === 'open') return o.status === 'new' || o.status === 'accepted';
    if (filter === 'fulfilled') return o.status === 'fulfilled';
    if (filter === 'closed') return o.status === 'rejected' || o.status === 'cancelled';
    return true;
  });
  const cancelFlags = orders.filter((o) => o.cancel_requested);
  const newCount = orders.filter((o) => o.status === 'new').length;

  return (
    <div>
      <h1>Online orders {newCount > 0 && <span className="badge badge-warning">{newCount} new</span>}</h1>
      <p>
        Orders placed on the website. <strong>Accept</strong> when your branch will prepare it; <strong>Create invoice</strong> at
        hand-over, which issues the bill and deducts stock. Online prices already include tax.
      </p>
      {error && <p style={{ color: 'var(--danger)' }}>{error}</p>}
      {notice && <p style={{ color: 'var(--success, green)' }}>{notice}</p>}

      {cancelFlags.map((o) => (
        <div key={o.id} className="card" style={{ borderColor: 'var(--danger)', marginBottom: 12 }}>
          <strong>{o.external_ref} was cancelled on the website after it was invoiced.</strong>{' '}
          The invoice has not been changed. Refund the customer from <em>Bills</em>, then confirm here.{' '}
          {canManage && <button className="btn btn-sm" disabled={!!busy} onClick={() => rpc('ack_online_cancel', { p_order_id: o.id }, 'Marked as handled.')}>I have handled it</button>}
        </div>
      ))}

      {canManage && (
        <div className="card" style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 16 }}>
          {canSettings && (
            <div className="field" style={{ marginBottom: 0, minWidth: 220 }}>
              <label>Branch that fulfils online orders</label>
              <select
                value={settings?.default_branch_id || ''}
                onChange={(e) => run('settings', async () => {
                  const { error: err } = await supabase.from('shop_settings').update({ default_branch_id: e.target.value || null, updated_at: new Date().toISOString() }).eq('id', true);
                  if (err) throw new Error(err.message);
                })}
              >
                <option value="">— choose —</option>
                {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </div>
          )}
          <button className="btn" disabled={!!busy} onClick={() => run('pull', async () => {
            const r = await callShopSync('pull_orders');
            setNotice(`Website check: ${r.found} waiting, ${r.imported} new, ${r.duplicates} already here.${r.failed?.length ? ' Problems: ' + r.failed.join('; ') : ''}`);
          })}>{busy === 'pull' ? 'Checking…' : 'Check website for missed orders'}</button>
          <button className="btn" disabled={!!busy} onClick={() => run('push', async () => {
            const r = await callShopSync('push_catalog');
            setNotice(`Website updated: ${r.updated} products refreshed, ${r.not_on_website} POS items are not on the website.${r.not_in_pos?.length ? ` Website SKUs missing from the POS: ${r.not_in_pos.join(', ')}.` : ''}${r.errors?.length ? ' Problems: ' + r.errors.join('; ') : ''}`);
          })}>{busy === 'push' ? 'Updating…' : 'Update website prices & stock'}</button>
          {settings?.last_catalog_push_at && <small>Last update: {new Date(settings.last_catalog_push_at).toLocaleString()}</small>}
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
        {FILTERS.map(([k, label]) => (
          <button key={k} className={`btn btn-sm ${filter === k ? 'btn-primary' : ''}`} onClick={() => setFilter(k)}>{label}</button>
        ))}
        <button className="btn btn-sm" onClick={load}>Refresh</button>
      </div>

      <div className="table-wrap"><table>
        <thead><tr><th>Received</th><th>Order</th><th>Branch</th><th>Customer</th><th>Payment</th><th>Status</th><th className="num">Total</th><th /></tr></thead>
        <tbody>
          {shown.map((o) => {
            const cur = o.branches?.currency_symbol || '';
            const isBusy = !!busy && busy.endsWith(o.id);
            return (
              <Fragment key={o.id}>
                <tr>
                  <td className="num">{new Date(o.received_at).toLocaleString()}</td>
                  <td className="invoice-number">{o.external_ref}</td>
                  <td>{o.branches?.name || <em>unassigned</em>}</td>
                  <td>{o.customer_name || '—'}<br /><small>{o.customer_phone}</small></td>
                  <td>{PAY_LABEL[o.payment_method] || o.payment_method}<br /><small>{o.payment_status}</small></td>
                  <td><span className={`badge badge-${STATUS_BADGE[o.status] || 'neutral'}`}>{o.status}</span></td>
                  <td className="num money">{cur}{Number(o.total_amount).toFixed(2)}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button className="btn btn-sm" onClick={() => toggle(o)}>{open === o.id ? 'Hide' : 'Details'}</button>{' '}
                    {canManage && o.status === 'new' && (
                      <button className="btn btn-sm btn-primary" disabled={isBusy}
                        onClick={() => rpc('accept_online_order', { p_order_id: o.id, p_branch_id: o.branch_id || currentBranchId || null }, 'Order accepted.')}>Accept</button>
                    )}{' '}
                    {canManage && o.status === 'accepted' && (
                      <button className="btn btn-sm btn-primary" disabled={isBusy}
                        onClick={() => rpc('fulfil_online_order', { p_order_id: o.id }, (d) => `Invoice ${d?.invoice_number || ''} created.`)}>Create invoice</button>
                    )}{' '}
                    {canManage && (o.status === 'new' || o.status === 'accepted') && (
                      <button className="btn btn-sm" disabled={isBusy} onClick={() => {
                        const reason = window.prompt(`Reject ${o.external_ref}? Reason (optional).\n\nAfterwards cancel it in the website admin so its stock is released${o.payment_status === 'paid' ? ' and refund the customer (already paid)' : ''}.`);
                        if (reason !== null) rpc('reject_online_order', { p_order_id: o.id, p_reason: reason }, 'Order rejected — now cancel it in the website admin.');
                      }}>Reject</button>
                    )}
                  </td>
                </tr>
                {open === o.id && (
                  <tr><td colSpan={8}>
                    <div style={{ display: 'grid', gap: 6 }}>
                      <div><strong>Deliver to:</strong> {o.customer_address || '—'} {o.customer_notes && <em> — “{o.customer_notes}”</em>}</div>
                      {o.reject_reason && <div><strong>Rejected because:</strong> {o.reject_reason}</div>}
                      <table><thead><tr><th>Item</th><th>SKU</th><th className="num">Qty</th><th className="num">Price</th><th /></tr></thead>
                        <tbody>
                          {(lines[o.id] || []).map((l) => (
                            <tr key={l.id}>
                              <td>{l.name}</td><td>{l.sku || '—'}</td>
                              <td className="num">{Number(l.quantity)}</td>
                              <td className="num money">{cur}{Number(l.unit_price).toFixed(2)}</td>
                              <td>{!l.item_id && <span className="badge badge-danger">not in POS catalogue</span>}</td>
                            </tr>
                          ))}
                          {Number(o.delivery_fee) > 0 && <tr><td>Delivery fee</td><td /><td className="num">1</td><td className="num money">{cur}{Number(o.delivery_fee).toFixed(2)}</td><td /></tr>}
                        </tbody></table>
                      {(lines[o.id] || []).some((l) => !l.item_id) && <small style={{ color: 'var(--danger)' }}>Add the missing SKU to the product in Products, then create the invoice.</small>}
                    </div>
                  </td></tr>
                )}
              </Fragment>
            );
          })}
          {shown.length === 0 && <tr><td colSpan={8}>Nothing here.</td></tr>}
        </tbody>
      </table></div>
    </div>
  );
}
