import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { fmtR } from '../money.js';
import InvoiceEditor from './InvoiceEditor.jsx';
import BillerSettings from './BillerSettings.jsx';

// Full-screen invoices workspace: list on the left, editor on the right.
export default function InvoicesView({ onClose, initialInvoiceId }) {
  const [invoices, setInvoices] = useState([]);
  const [selected, setSelected] = useState(null);
  const [biller, setBiller] = useState(null);
  const [billerOpen, setBillerOpen] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const [inv, bl] = await Promise.all([api.listInvoices(), api.getBiller()]);
      setInvoices(inv.invoices); setBiller(bl.biller);
      if (initialInvoiceId) {
        const one = await api.getInvoice(initialInvoiceId);
        setSelected(one.invoice);
        if (!inv.invoices.find((x) => x.id === initialInvoiceId)) setInvoices([one.invoice, ...inv.invoices]);
      }
      setLoading(false);
    })();
    // eslint-disable-next-line
  }, []);

  async function newInvoice() {
    const r = await api.createInvoice({});
    setInvoices([r.invoice, ...invoices]);
    setSelected(r.invoice);
  }
  async function select(inv) { const r = await api.getInvoice(inv.id); setSelected(r.invoice); }
  function onSaved(u) { setInvoices(invoices.map((x) => (x.id === u.id ? u : x))); setSelected(u); }
  function onDeleted(id) { setInvoices(invoices.filter((x) => x.id !== id)); setSelected(null); }
  function onDuplicated(nu) { setInvoices([nu, ...invoices]); setSelected(nu); }

  return (
    <div className="invoices-view">
      <header className="topbar no-print">
        <div className="brand">Simon<span>Stays</span></div>
        <span className="host">Invoices</span>
        <div className="spacer" />
        <button className="ghost" onClick={newInvoice}>＋ New invoice</button>
        <button className="ghost" onClick={onClose}>✕ Close</button>
      </header>

      <div className="invoices-body">
        <aside className="inv-list no-print">
          {loading && <p className="muted small">Loading…</p>}
          {!loading && invoices.length === 0 && <p className="muted small">No invoices yet. Create one, or use “Invoice” on a booking.</p>}
          {invoices.map((inv) => (
            <button key={inv.id} className={`inv-item ${selected?.id === inv.id ? 'active' : ''}`} onClick={() => select(inv)}>
              <div className="inv-item-top"><b>{inv.number}</b><span>{fmtR(inv.totalCents)}</span></div>
              <div className="inv-item-sub">{inv.billToName || '—'} · {(inv.date || '').slice(0, 10)}</div>
            </button>
          ))}
        </aside>

        <main className="inv-main">
          {selected
            ? <InvoiceEditor
                key={selected.id}
                invoice={selected}
                biller={biller}
                onSaved={onSaved}
                onDeleted={onDeleted}
                onDuplicated={onDuplicated}
                onEditBiller={() => setBillerOpen(true)}
              />
            : <div className="center muted no-print">Select an invoice, or create a new one.</div>}
        </main>
      </div>

      {billerOpen && (
        <BillerSettings
          biller={biller}
          onClose={() => setBillerOpen(false)}
          onSaved={(b) => { setBiller(b); setBillerOpen(false); }}
        />
      )}
    </div>
  );
}
