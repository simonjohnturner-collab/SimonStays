import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';
import { api } from './api';

// Where Paygate sends the guest back to when they finish paying: this app
// (simonstays://payment in the store app, exp://…/--/payment in Expo Go).
export const appReturnUrl = () => Linking.createURL('payment');

// Run a checkout the server handed us. Returns 'paid' | 'cancelled' | 'unknown'
// — 'unknown' when the guest closed the payment page themselves; the booking
// screen then asks the server (which asks Paygate) how it went.
export async function runCheckout(bookingId, payment) {
  if (!payment || payment.mode === 'eft') return 'eft';
  if (payment.mode === 'simulate') {
    await api.simulatePay(bookingId); // test mode: no real card payment
    return 'paid';
  }
  const back = appReturnUrl();
  const r = await WebBrowser.openAuthSessionAsync(payment.goUrl, back);
  if (r.type === 'success' && r.url) {
    const { queryParams } = Linking.parse(r.url);
    return queryParams && queryParams.result === 'paid' ? 'paid' : 'cancelled';
  }
  return 'unknown';
}
