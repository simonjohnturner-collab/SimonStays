const BASE = import.meta.env.VITE_API_BASE || 'http://localhost:4000';

export function photoUrl(id) { return `${BASE}/photos/${id}`; }

async function req(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || `Request failed (${res.status})`);
  return data;
}

export const api = {
  properties: () => req('GET', '/public/properties'),
  property: (id) => req('GET', `/public/properties/${id}`),
  calendar: (unitId) => req('GET', `/public/units/${unitId}/calendar`),
  quote: (payload) => req('POST', '/public/quote', payload),
  book: (payload) => req('POST', '/public/book', payload),
  pay: (id, payload) => req('POST', `/public/book/${id}/pay`, payload || {}),
};
