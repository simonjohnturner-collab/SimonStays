import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { Button, Card, H, Row } from '../../components/Ui';
import { api } from '../../lib/api';
import { appReturnUrl, runCheckout } from '../../lib/pay';
import { fmtDay, rand } from '../../lib/format';
import { C } from '../../lib/theme';

// After checkout: confirmed / still confirming / payment not completed
// instructions. The server is always asked (it checks with Paygate) — the
// result passed in from the payment page is only a hint.
export default function BookingScreen() {
  const { id, result } = useLocalSearchParams();
  const [b, setB] = useState(null);
  const [error, setError] = useState('');
  const [waited, setWaited] = useState(false);
  const [busy, setBusy] = useState(false);
  const tries = useRef(0);

  const load = useCallback(async () => {
    try { const s = await api.status(id); setB(s); return s; }
    catch (e) { setError(e.message); return null; }
  }, [id]);

  useEffect(() => {
    let timer;
    const tick = async () => {
      const s = await load();
      // Card payment just finished: Paygate can take a few seconds to confirm.
      if (s && s.status === 'pending' && result !== 'cancelled' && tries.current < 15) {
        tries.current += 1;
        timer = setTimeout(tick, 2500);
      } else {
        setWaited(true);
      }
    };
    tick();
    return () => clearTimeout(timer);
  }, [load, result]);

  async function retry() {
    setBusy(true); setError('');
    try {
      const r = await api.checkout(id, { kind: 'booking', appReturn: appReturnUrl() });
      const res = await runCheckout(id, r.payment);
      router.setParams({ result: res });
      tries.current = 0; setWaited(false);
      const s = await load();
      if (s && s.status === 'pending' && res !== 'cancelled') setTimeout(load, 2500);
      setWaited(true);
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  if (!b) return <View style={styles.center}>{error ? <Text style={styles.err}>{error}</Text> : <ActivityIndicator color={C.green} size="large" />}</View>;

  const confirmed = b.status === 'confirmed';
  const cancelled = b.status === 'cancelled';
  const stillChecking = b.status === 'pending' && !waited;

  return (
    <ScrollView contentContainerStyle={styles.body}>
      <View style={styles.hero}>
        <Text style={styles.icon}>{confirmed ? '✅' : stillChecking ? '⏳' : cancelled ? '✖️' : '⚠️'}</Text>
        <Text style={styles.heading}>
          {confirmed ? 'Booking confirmed' : stillChecking ? 'Confirming your payment…' : cancelled ? 'Booking cancelled' : 'Payment not completed'}
        </Text>
        <Text style={styles.sub}>
          {confirmed ? `See you soon! We’ve emailed your confirmation${b.guestEmail ? ` to ${b.guestEmail}` : ''}.`
            : stillChecking ? 'This usually takes a few seconds. Please don’t close the app.'
                : cancelled ? 'This booking is no longer active.'
                  : 'Your card wasn’t charged. You can try again; the dates aren’t held until you pay.'}
        </Text>
        {stillChecking && <ActivityIndicator color={C.green} style={{ marginTop: 12 }} />}
      </View>

      <Card>
        <Text style={styles.title}>{b.property}{b.unit ? ` · Unit ${b.unit}` : ''}</Text>
        <Text style={styles.muted}>{fmtDay(b.checkIn)} → {fmtDay(b.checkOut)}</Text>
        {!!b.ref && <Row left="Booking reference" right={b.ref} bold />}
        {confirmed && b.amountOwingCents > 0 && <Row left="Balance due 3 days before check-in" right={rand(b.amountOwingCents)} />}
      </Card>

      {!!error && <Text style={styles.err}>{error}</Text>}
      {!confirmed && !cancelled && waited && <Button title="Try paying again" onPress={retry} busy={busy} style={{ marginBottom: 12 }} />}
      <Button title="Back to stays" kind={confirmed ? 'primary' : 'secondary'} onPress={() => router.dismissTo('/')} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  body: { padding: 16, paddingBottom: 48 },
  hero: { alignItems: 'center', paddingVertical: 24, paddingHorizontal: 8 },
  icon: { fontSize: 48, marginBottom: 8 },
  heading: { fontSize: 22, fontWeight: '800', color: C.ink, textAlign: 'center' },
  sub: { fontSize: 15, color: C.muted, textAlign: 'center', marginTop: 8, lineHeight: 21 },
  title: { fontSize: 17, fontWeight: '800', color: C.ink },
  muted: { color: C.muted, fontSize: 14, marginTop: 2, marginBottom: 8 },
  note: { fontSize: 13, color: C.muted, marginTop: 8, lineHeight: 18 },
  err: { color: C.red, fontSize: 15, marginBottom: 12, textAlign: 'center' },
});
