// The SimonStays server — the same public API the simonstays.co.za shopfront uses.
import Constants from 'expo-constants';
import { PixelRatio } from 'react-native';

export const API_BASE = (Constants.expoConfig?.extra?.apiBase || 'https://simonstays.co.za').replace(/\/$/, '');

async function req(method, path, body) {
  const r = await fetch(API_BASE + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await r.json(); } catch (e) { /* empty body */ }
  if (!r.ok) {
    const err = new Error((data && data.message) || `Something went wrong (${r.status}). Please try again.`);
    err.status = r.status; err.data = data;
    throw err;
  }
  return data;
}

// A photo sized for how wide it's drawn on this phone (the server sends a
// resized, correctly rotated copy instead of the multi-megabyte original).
export function photoUrl(id, layoutWidth) {
  if (!id) return null;
  const px = PixelRatio.getPixelSizeForLayoutSize(layoutWidth || 400);
  return `${API_BASE}/photos/${id}?w=${Math.round(px)}`;
}

export const api = {
  host: () => req('GET', '/public/host'),
  units: () => req('GET', '/public/units'),
  property: (id) => req('GET', `/public/properties/${id}`),
  calendar: (unitId) => req('GET', `/public/units/${unitId}/calendar`),
  quote: (body) => req('POST', '/public/quote', body),
  book: (body) => req('POST', '/public/book', body),
  simulatePay: (bookingId) => req('POST', `/public/book/${bookingId}/pay`, {}),
  status: (bookingId) => req('GET', `/public/book/${bookingId}/status`),
  checkout: (bookingId, body) => req('POST', `/public/book/${bookingId}/checkout`, body),
};
