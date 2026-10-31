import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import PhotoCarousel from '../../components/PhotoCarousel';
import Calendar from '../../components/Calendar';
import { Button, Card, H, Row } from '../../components/Ui';
import { api } from '../../lib/api';
import { fmtDay, nightsBetween, rand } from '../../lib/format';
import { C } from '../../lib/theme';

// One unit: photos, details, availability calendar and a live price.
export default function UnitScreen() {
  const { id, propertyId } = useLocalSearchParams();
  const insets = useSafeAreaInsets();
  const [prop, setProp] = useState(null);
  const [booked, setBooked] = useState([]);
  const [error, setError] = useState('');
  const [dates, setDates] = useState({ checkIn: null, checkOut: null });
  const [quote, setQuote] = useState(null);
  const [quoteErr, setQuoteErr] = useState('');

  useEffect(() => {
    api.property(propertyId).then((r) => setProp(r.property)).catch((e) => setError(e.message));
    api.calendar(id).then((r) => setBooked(r.booked)).catch(() => {});
  }, [id, propertyId]);

  const unit = prop && prop.units.find((u) => u.id === id);
  // The unit's own photos first, then the building's.
  const photos = useMemo(() => (prop && unit ? [...unit.photos, ...prop.photos] : []), [prop, unit]);
  const nights = dates.checkIn && dates.checkOut ? nightsBetween(dates.checkIn, dates.checkOut) : 0;
  const shortStay = unit && unit.minNights && nights && nights < unit.minNights;

  useEffect(() => {
    setQuote(null); setQuoteErr('');
    if (!dates.checkOut || shortStay) return;
    let live = true;
    api.quote({ unitId: id, checkIn: dates.checkIn, checkOut: dates.checkOut })
      .then((r) => live && setQuote(r.quote)).catch((e) => live && setQuoteErr(e.message));
    return () => { live = false; };
  }, [id, dates.checkIn, dates.checkOut, shortStay]);

  if (error) return <View style={styles.center}><Text style={styles.muted}>{error}</Text></View>;
  if (!prop) return <View style={styles.center}><ActivityIndicator color={C.green} size="large" /></View>;
  if (!unit) return <View style={styles.center}><Text style={styles.muted}>This stay is no longer listed.</Text></View>;

  const facts = [
    unit.bedrooms != null && `${unit.bedrooms} bedroom${unit.bedrooms === 1 ? '' : 's'}`,
    unit.bathrooms != null && `${unit.bathrooms} bathroom${unit.bathrooms === 1 ? '' : 's'}`,
    unit.capacity && `Sleeps ${unit.capacity}`,
  ].filter(Boolean);
  const amenities = [
    ['🕒', `Check-in from ${unit.checkInTime || '15:00'} · check-out by ${unit.checkOutTime || '10:00'}`],
    unit.wifi && ['📶', 'Wi-Fi'],
    unit.backupPower && ['🔋', unit.backupPower],
    unit.backupWater && ['💧', unit.backupWater],
    unit.parking && ['🚗', unit.parking],
    unit.security && ['🛡️', unit.security],
    unit.access && ['🔑', unit.access],
    unit.minNights > 1 && ['📅', `${unit.minNights}-night minimum stay`],
  ].filter(Boolean);

  return (
    <View style={{ flex: 1 }}>
      <Stack.Screen options={{ title: `Unit ${unit.name}` }} />
      <ScrollView contentContainerStyle={{ paddingBottom: 120 + insets.bottom }}>
        <PhotoCarousel photos={photos} />
        <View style={styles.body}>
          <Text style={styles.title}>{prop.name} · Unit {unit.name}</Text>
          {!!prop.address && <Text style={styles.muted}>{prop.address}</Text>}
          {facts.length > 0 && <Text style={styles.facts}>{facts.join(' · ')}</Text>}
          {!!(unit.description || prop.description) && <Text style={styles.desc}>{unit.description || prop.description}</Text>}

          <Card>
            <H>What’s here</H>
            {amenities.map(([icon, text], i) => (
              <View key={i} style={styles.amen}><Text style={styles.amenIcon}>{icon}</Text><Text style={styles.amenText}>{text}</Text></View>
            ))}
          </Card>

          <Card>
            <H>{!dates.checkIn ? 'Choose your check-in' : !dates.checkOut ? 'Now choose your check-out' : `${nights} night${nights === 1 ? '' : 's'}`}</H>
            {dates.checkIn && <Text style={[styles.muted, { marginBottom: 10 }]}>{fmtDay(dates.checkIn)}{dates.checkOut ? ` → ${fmtDay(dates.checkOut)}` : ''}</Text>}
            <Calendar booked={booked} checkIn={dates.checkIn} checkOut={dates.checkOut} onChange={setDates} />
            {shortStay ? <Text style={styles.warn}>This home has a {unit.minNights}-night minimum stay.</Text> : null}
            {quoteErr ? <Text style={styles.warn}>{quoteErr}</Text> : null}
            {quote && (
              <View style={styles.quote}>
                <Row left={`${quote.nights} night${quote.nights === 1 ? '' : 's'} @ ${rand(quote.avgNightlyCents)}`} right={rand(quote.accommodationCents)} />
                {!!quote.discountCents && <Row left={`${quote.discountPercent}% length discount`} right={`−${rand(quote.discountCents)}`} />}
                {!!quote.cleaningCents && <Row left="Cleaning fee" right={rand(quote.cleaningCents)} />}
                {!!quote.depositCents && <Row left="Refundable breakage deposit" right={rand(quote.depositCents)} muted />}
                <Row left="Total" right={rand(quote.totalCents)} bold />
              </View>
            )}
          </Card>

          {!!prop.cancellationPolicy && (
            <Card>
              <H>Cancellation policy</H>
              <Text style={styles.desc}>{prop.cancellationPolicy}</Text>
            </Card>
          )}
        </View>
      </ScrollView>

      <View style={[styles.bar, { paddingBottom: 12 + insets.bottom }]}>
        <View style={{ flex: 1 }}>
          {quote ? (
            <>
              <Text style={styles.barPrice}>{rand(quote.totalCents)}</Text>
              <Text style={styles.muted}>{fmtDay(dates.checkIn)} → {fmtDay(dates.checkOut)}</Text>
            </>
          ) : (
            <Text style={styles.muted}>{unit.fromNightlyCents != null ? `From ${rand(unit.fromNightlyCents)} / night` : 'Pick your dates'}</Text>
          )}
        </View>
        <Button
          title="Reserve"
          disabled={!quote}
          style={{ minWidth: 140 }}
          onPress={() => router.push({ pathname: '/book/[unitId]', params: { unitId: id, propertyId, checkIn: dates.checkIn, checkOut: dates.checkOut } })}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  body: { padding: 16 },
  title: { fontSize: 22, fontWeight: '800', color: C.ink, marginBottom: 4 },
  muted: { color: C.muted, fontSize: 14 },
  facts: { fontSize: 15, color: C.ink, marginTop: 8, fontWeight: '600' },
  desc: { fontSize: 15, color: C.ink, lineHeight: 22, marginTop: 10, marginBottom: 14 },
  amen: { flexDirection: 'row', gap: 10, paddingVertical: 5 },
  amenIcon: { fontSize: 16, width: 22 },
  amenText: { flex: 1, fontSize: 15, color: C.ink, lineHeight: 21 },
  warn: { color: C.red, marginTop: 10, fontSize: 14 },
  quote: { marginTop: 14, borderTopWidth: 1, borderTopColor: C.line, paddingTop: 10 },
  bar: { position: 'absolute', left: 0, right: 0, bottom: 0, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingTop: 12, backgroundColor: '#fff', borderTopWidth: 1, borderTopColor: C.line },
  barPrice: { fontSize: 18, fontWeight: '800', color: C.ink },
});
