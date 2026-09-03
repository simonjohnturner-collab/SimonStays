// Thin fetch wrapper. Token is kept in localStorage and sent as a Bearer header.
const BASE = import.meta.env.VITE_API_BASE || 'http://localhost:4000';

let token = localStorage.getItem('staysync_token') || null;

export function setToken(t) {
  token = t;
  if (t) localStorage.setItem('staysync_token', t);
  else localStorage.removeItem('staysync_token');
}
export function getToken() { return token; }

// Public URL for a stored photo's bytes (usable directly in <img src>).
export function photoUrl(id) { return `${BASE}/photos/${id}`; }

async function req(method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body != null ? JSON.stringify(body) : undefined,
  });
  let data = null;
  const text = await res.text();
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!res.ok) {
    const err = new Error((data && data.error) || `HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export const api = {
  // auth
  register: (email, password, name) => req('POST', '/auth/register', { email, password, name }),
  login: (email, password) => req('POST', '/auth/login', { email, password }),
  me: () => req('GET', '/auth/me'),

  // properties + units
  listProperties: () => req('GET', '/properties'),
  createProperty: (name, address) => req('POST', '/properties', { name, address }),
  updateProperty: (id, name) => req('PATCH', `/properties/${id}`, { name }),
  reorderProperties: (ids) => req('PUT', '/properties/reorder', { ids }),
  deleteProperty: (id) => req('DELETE', `/properties/${id}`),
  createUnit: (propertyId, name, capacity) => req('POST', '/units', { propertyId, name, capacity }),
  getUnit: (id) => req('GET', `/units/${id}`),
  deleteUnit: (id) => req('DELETE', `/units/${id}`),
  unitBookings: (id, from, to) => req('GET', `/units/${id}/bookings?from=${from}&to=${to}`),
  syncUnit: (id) => req('POST', `/units/${id}/sync`),
  setCalendar: (id, importUrl) => req('PUT', `/units/${id}/calendar`, { importUrl }),

  // channels
  listChannels: (unitId) => req('GET', `/units/${unitId}/channels`),
  addChannel: (unitId, type, importUrl, label) => req('POST', `/units/${unitId}/channels`, { type, importUrl, label }),
  deleteChannel: (channelId) => req('DELETE', `/channels/${channelId}`),

  // guest-name email ingest
  ingestEmail: (subject, body) => req('POST', '/email/ingest', { subject, body }),
  pollEmail: () => req('POST', '/email/poll'), // pull the Zoho Airbnb folder now

  // biller profile + invoices
  getBiller: () => req('GET', '/biller'),
  saveBiller: (data) => req('PUT', '/biller', data),
  listInvoices: () => req('GET', '/invoices'),
  getInvoice: (id) => req('GET', `/invoices/${id}`),
  createInvoice: (payload) => req('POST', '/invoices', payload),
  updateInvoice: (id, payload) => req('PATCH', `/invoices/${id}`, payload),
  duplicateInvoice: (id) => req('POST', `/invoices/${id}/duplicate`),
  deleteInvoice: (id) => req('DELETE', `/invoices/${id}`),

  // pricing groups (units in a group share one rate card) + quotes
  quoteUnit: (unitId, body) => req('POST', `/units/${unitId}/quote`, body),
  quoteBooking: (bookingId) => req('GET', `/bookings/${bookingId}/quote`),
  listGroups: () => req('GET', '/groups'),
  createGroup: (name) => req('POST', '/groups', { name }),
  updateGroup: (id, data) => req('PUT', `/groups/${id}`, data),
  deleteGroup: (id) => req('DELETE', `/groups/${id}`),
  assignUnitGroup: (unitId, pricingGroupId) => req('PATCH', `/units/${unitId}`, { pricingGroupId }),

  // listings (descriptions + photos) for the property/unit content manager
  getListings: () => req('GET', '/listings'),
  saveProperty: (id, data) => req('PATCH', `/properties/${id}`, data), // { name, address, description }
  saveUnit: (id, data) => req('PATCH', `/units/${id}`, data), // { name, capacity, description }
  addPropertyPhoto: (propertyId, payload) => req('POST', `/photos/property/${propertyId}`, payload),
  addUnitPhoto: (unitId, payload) => req('POST', `/photos/unit/${unitId}`, payload),
  setPhotoSort: (id, sort) => req('PATCH', `/photos/${id}`, { sort }),
  deletePhoto: (id) => req('DELETE', `/photos/${id}`),

  // bookings
  availability: (unitId, checkIn, checkOut) =>
    req('GET', `/units/${unitId}/availability?checkIn=${checkIn}&checkOut=${checkOut}`),
  createBooking: (unitId, payload) => req('POST', `/units/${unitId}/bookings`, payload),
  createFloating: (payload) => req('POST', '/bookings/floating', payload),
  listFloating: (from, to) => req('GET', `/bookings/floating?from=${from}&to=${to}`),
  updateBooking: (id, payload) => req('PATCH', `/bookings/${id}`, payload),
  searchBookings: (q) => req('GET', `/bookings/search?q=${encodeURIComponent(q)}`),
  deleteBooking: (id) => req('DELETE', `/bookings/${id}`),
};
