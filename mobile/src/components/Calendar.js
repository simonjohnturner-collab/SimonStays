import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { C } from '../lib/theme';
import { MONTHS_LONG, addDaysIso, todayIso } from '../lib/format';

// Pick check-in then check-out. Booked nights are struck through; a stay can't
// run across one. `booked` = [{ checkIn, checkOut }] (checkout day is free).
export default function Calendar({ booked = [], checkIn, checkOut, onChange }) {
  const today = todayIso();
  const [month, setMonth] = useState(() => (checkIn || today).slice(0, 7));
  const takenNights = useMemo(() => {
    const s = new Set();
    for (const b of booked) for (let d = b.checkIn; d < b.checkOut; d = addDaysIso(d, 1)) s.add(d);
    return s;
  }, [booked]);

  const [y, m] = month.split('-').map(Number);
  const first = `${month}-01`;
  const lead = (new Date(Date.UTC(y, m - 1, 1)).getUTCDay() + 6) % 7; // Monday-first
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const cells = [...Array(lead).fill(null), ...Array.from({ length: days }, (_, i) => addDaysIso(first, i))];
  while (cells.length % 7) cells.push(null);

  const shift = (n) => { const d = new Date(Date.UTC(y, m - 1 + n, 1)); setMonth(d.toISOString().slice(0, 7)); };
  const canGoBack = month > today.slice(0, 7);

  function freeRun(a, b) { for (let d = a; d < b; d = addDaysIso(d, 1)) if (takenNights.has(d)) return false; return true; }
  function tap(d) {
    if (!checkIn || checkOut || d <= checkIn) {
      if (takenNights.has(d)) return; // can't arrive on a booked night
      onChange({ checkIn: d, checkOut: null });
    } else if (freeRun(checkIn, d)) {
      onChange({ checkIn, checkOut: d });
    } else if (!takenNights.has(d)) {
      onChange({ checkIn: d, checkOut: null });
    }
  }

  return (
    <View>
      <View style={styles.head}>
        <Pressable onPress={() => shift(-1)} disabled={!canGoBack} hitSlop={10} style={styles.nav} accessibilityLabel="Previous month">
          <Text style={[styles.navText, !canGoBack && { opacity: 0.25 }]}>‹</Text>
        </Pressable>
        <Text style={styles.month}>{MONTHS_LONG[m - 1]} {y}</Text>
        <Pressable onPress={() => shift(1)} hitSlop={10} style={styles.nav} accessibilityLabel="Next month">
          <Text style={styles.navText}>›</Text>
        </Pressable>
      </View>
      <View style={styles.grid}>
        {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d, i) => <Text key={i} style={styles.dow}>{d}</Text>)}
        {cells.map((d, i) => {
          if (!d) return <View key={i} style={styles.cell} />;
          const past = d < today;
          const taken = takenNights.has(d);
          // A booked night can still be someone's check-out day.
          const checkoutOk = checkIn && !checkOut && d > checkIn && freeRun(checkIn, d);
          const disabled = past || (taken && !checkoutOk);
          const ends = d === checkIn || d === checkOut;
          const inside = checkIn && checkOut && d > checkIn && d < checkOut;
          return (
            <Pressable key={i} style={styles.cell} disabled={disabled} onPress={() => tap(d)}>
              <View style={[styles.day, inside && styles.inside, ends && styles.end]}>
                <Text style={[styles.dayText, disabled && styles.disabled, taken && !checkoutOk && styles.taken, ends && styles.endText]}>
                  {Number(d.slice(8))}
                </Text>
              </View>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
  nav: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  navText: { fontSize: 28, color: C.ink, lineHeight: 30 },
  month: { fontSize: 16, fontWeight: '700', color: C.ink },
  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  dow: { width: `${100 / 7}%`, textAlign: 'center', fontSize: 12, color: C.muted, paddingBottom: 6, fontWeight: '600' },
  cell: { width: `${100 / 7}%`, aspectRatio: 1, padding: 2 },
  day: { flex: 1, borderRadius: 999, alignItems: 'center', justifyContent: 'center' },
  inside: { backgroundColor: C.greenSoft, borderRadius: 6 },
  end: { backgroundColor: C.green },
  dayText: { fontSize: 15, color: C.ink },
  endText: { color: '#fff', fontWeight: '800' },
  disabled: { color: '#c3c8cf' },
  taken: { textDecorationLine: 'line-through' },
});
