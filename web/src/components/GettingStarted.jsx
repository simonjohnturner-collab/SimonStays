import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { navigate } from '../router.js';

// A new host's step-by-step to a live listing, on Today. Each step ticks itself
// off from what's set up, and links to where it's done. Hidden once every
// required step is done, or when the host closes it.
const GUIDE = 'https://simonstays.co.za/host/guide';
const HIDE_KEY = 'ss_onboarding_hidden';

export default function GettingStarted() {
  const [data, setData] = useState(null);
  const [hidden, setHidden] = useState(() => { try { return localStorage.getItem(HIDE_KEY) === '1'; } catch { return false; } });
  useEffect(() => { if (!hidden) api.onboarding().then(setData).catch(() => {}); }, [hidden]);

  if (hidden || !data || data.done) return null;
  const required = data.steps.filter((s) => !s.optional);
  const doneCount = required.filter((s) => s.done).length;
  const next = data.steps.find((s) => !s.done && !s.optional);
  const hide = () => { try { localStorage.setItem(HIDE_KEY, '1'); } catch { /* private window */ } setHidden(true); };

  return (
    <section className="onb">
      <div className="onb-head">
        <div>
          <h3>🚀 Getting started</h3>
          <span className="muted small">{doneCount} of {required.length} done. Follow the steps to get your first listing live.</span>
        </div>
        <button className="x" title="Hide this checklist" onClick={hide}>×</button>
      </div>
      <div className="onb-bar"><span style={{ width: `${Math.round((doneCount / required.length) * 100)}%` }} /></div>
      <ol className="onb-steps">
        {data.steps.map((s, i) => (
          <li key={s.key} className={`${s.done ? 'done' : ''}${next && next.key === s.key ? ' next' : ''}`}>
            <span className="onb-n">{s.done ? '✓' : i + 1}</span>
            <span className="onb-txt"><b>{s.title}</b><span className="muted small">{s.how}</span></span>
            {!s.done && <button className={next && next.key === s.key ? '' : 'secondary'} onClick={() => navigate(s.to)}>{next && next.key === s.key ? 'Start →' : 'Go'}</button>}
          </li>
        ))}
      </ol>
      <p className="muted small onb-foot">Stuck? The <a href={GUIDE} target="_blank" rel="noreferrer">host guide</a> walks through every step, with answers to common questions.</p>
    </section>
  );
}
