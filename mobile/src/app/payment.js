import { Redirect, useLocalSearchParams } from 'expo-router';

// Paygate's return link (simonstays://payment?booking=…&result=…). Normally the
// in-app payment browser catches it; if the phone opens the app with it
// instead, go to that booking's status screen.
export default function PaymentReturn() {
  const { booking, result } = useLocalSearchParams();
  if (!booking) return <Redirect href="/" />;
  return <Redirect href={{ pathname: '/booking/[id]', params: { id: booking, result: result || 'unknown' } }} />;
}
