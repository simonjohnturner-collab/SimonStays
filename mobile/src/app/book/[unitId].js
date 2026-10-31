import { useEffect, useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as WebBrowser from 'expo-web-browser';
import { Button, Card, Check, Choice, Field, H, Row } from '../../components/Ui';
import { API_BASE, api } from '../../lib/api';
import { appReturnUrl, runCheckout } from '../../lib/pay';
import { fmtDay, nightsBetween, rand, todayIso } from '../../lib/format';
import { C } from '../../lib/theme';

const SPLIT_FEE = 25000; // R250 admin fee for the 50/50 plan (matches the server)

// Guest details, how to pay, the T&Cs, then off to Paygate (or EFT details).
export default function BookScreen() {
  const { unitId, propertyId, checkIn, checkOut } = useLocalSearchParams();
  const insets = useSafeAreaInsets();
  const [prop, setProp] = useState(null);
  const [quote, setQuote] = useState(null);
  const [host, setHost] = useState(null);
  const [f, setF] = useState({ name: '', email: '', phone: '', guests: '', message: '' });
  const [method, setMethod] = useState('card');
  const [plan, setPlan] = useState('full');
  const [agree, setAgree] = useState(false);
  const [agreeTnc, setAgreeTnc] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api.property(propertyId).then((r) => setProp(r.property)).catch((e) => setError(e.message));
    api.quote({ unitId, checkIn, checkOut }).then((r) => setQuote(r.quote)).catch((e) => setError(e.message));
    api.host().then((r) => setHost(r.host)).catch(() => {});
  }, [unitId, propertyId, checkIn, checkOut]);

  const unit = prop && prop.units.find((u) => u.id === unitId);
  const canSplit = nightsBetween(todayIso(), checkIn) >= 3;
  const split = canSplit && plan === 'split';
  const payable = quote ? quote.totalCents + (split ? SPLIT_FEE : 0) : 0;
  const dueNow = split ? payable - Math.round(payable / 2) : payable;
  const set = (k) => (v) => setF((x) => ({ ...x, [k]: v }));
  const ready = f.name.trim() && (f.email.trim() || f.phone.trim()) && agree && agreeTnc && quote;

  async function book() {
    setError(''); setBusy(true);
    try {
      const r = await api.book({
        unitId, checkIn, checkOut,
        guestName: f.name.trim(), guestEmail: f.email.trim(), guestPhone: f.phone.trim(),
        guests: f.guests.trim(), message: f.message.trim(),
        paymentMethod: method, paymentPlan: split ? 'split' : 'full',
        acceptedTerms: true, appReturn: appReturnUrl(),
      });
      const result = await runCheckout(r.bookingId, r.payment);
      router.replace({ pathname: '/booking/[id]', params: { id: r.bookingId, result } });
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  if (!quote || !prop) {
    return <View style={styles.center}>{error ? <Text style={styles.err}>{error}</Text> : <ActivityIndicator color={C.green} size="large" />}</View>;
  }
  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={90}>
      <ScrollView contentContainerStyle={[styles.body, { paddingBottom: 40 + insets.bottom }]} keyboardShouldPersistTaps="handled">
        <Card>
          <Text style={styles.title}>{prop.name}{unit ? ` · Unit ${unit.name}` : ''}</Text>
          <Text style={styles.muted}>{fmtDay(checkIn)} → {fmtDay(checkOut)} · {quote.nights} night{quote.nights === 1 ? '' : 's'}</Text>
          <View style={styles.sep} />
          <Row left={`${quote.nights} night${quote.nights === 1 ? '' : 's'} @ ${rand(quote.avgNightlyCents)}`} right={rand(quote.accommodationCents)} />
          {!!quote.discountCents && <Row left={`${quote.discountPercent}% length discount`} right={`−${rand(quote.discountCents)}`} />}
          {!!quote.cleaningCents && <Row left="Cleaning fee" right={rand(quote.cleaningCents)} />}
          {!!quote.depositCents && <Row left="Refundable breakage deposit" right={rand(quote.depositCents)} />}
          {split && <Row left="50/50 plan admin fee" right={rand(SPLIT_FEE)} />}
          <Row left="Total" right={rand(payable)} bold />
          {!!quote.depositCents && <Text style={styles.note}>🔒 The deposit is refunded after check-out, subject to no damage.</Text>}
        </Card>

        <Card>
          <H>Your details</H>
          <Field label="Full name" value={f.name} onChangeText={set('name')} autoComplete="name" textContentType="name" autoCapitalize="words" />
          <Field label="Email" value={f.email} onChangeText={set('email')} autoComplete="email" textContentType="emailAddress" keyboardType="email-address" autoCapitalize="none" />
          <Field label="Mobile number" value={f.phone} onChangeText={set('phone')} autoComplete="tel" textContentType="telephoneNumber" keyboardType="phone-pad" />
          <Field label="Number of guests" value={f.guests} onChangeText={set('guests')} keyboardType="number-pad" />
          <Field label="Anything we should know? (optional)" value={f.message} onChangeText={set('message')} multiline style={[styles.multi]} />
        </Card>

        <Card>
          <H>How would you like to pay?</H>
          <Choice selected={method === 'card'} onPress={() => setMethod('card')} title="💳 Card" sub={host && host.cardOnline ? 'Secure payment with Paygate. Confirmed instantly.' : 'Test mode: no card is charged.'} />
          <Choice selected={method === 'eft'} onPress={() => setMethod('eft')} title="🏦 EFT (bank transfer)" sub="Confirmed once your payment reflects." />
          {canSplit && (
            <>
              <View style={styles.sep} />
              <Choice selected={plan === 'full'} onPress={() => setPlan('full')} title="Pay in full now" />
              <Choice selected={plan === 'split'} onPress={() => setPlan('split')} title="Pay 50% now, 50% later" sub={`The rest is due at least 3 days before check-in. +${rand(SPLIT_FEE)} admin fee.`} />
            </>
          )}
        </Card>

        <Card>
          <Check checked={agree} onToggle={() => setAgree(!agree)}>
            I confirm that SimonStays accepts no responsibility whatsoever for anything that happens at the property. I have read and understood the cancellation policy, and I accept that no refunds will be granted outside of that policy.
          </Check>
          <Check checked={agreeTnc} onToggle={() => setAgreeTnc(!agreeTnc)}>
            I have read and accept the <Text style={styles.link} onPress={() => WebBrowser.openBrowserAsync(`${API_BASE}/terms`)}>Terms &amp; Conditions</Text>.
          </Check>
        </Card>

        {!!error && <Text style={styles.err}>{error}</Text>}
        <Button
          title={method === 'eft' ? 'Reserve and get bank details' : `Pay ${rand(dueNow)}`}
          onPress={book} busy={busy} disabled={!ready}
        />
        {!ready && <Text style={[styles.muted, { textAlign: 'center', marginTop: 8 }]}>Add your name, an email or phone number, and tick both boxes.</Text>}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  body: { padding: 16 },
  title: { fontSize: 17, fontWeight: '800', color: C.ink },
  muted: { color: C.muted, fontSize: 14, marginTop: 2 },
  sep: { height: 1, backgroundColor: C.line, marginVertical: 12 },
  note: { fontSize: 13, color: C.muted, marginTop: 8 },
  multi: { minHeight: 80, textAlignVertical: 'top' },
  link: { color: C.green, fontWeight: '700', textDecorationLine: 'underline' },
  err: { color: C.red, fontSize: 15, marginBottom: 12, textAlign: 'center' },
});
