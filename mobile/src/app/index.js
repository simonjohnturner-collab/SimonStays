import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, RefreshControl, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { router } from 'expo-router';
import Photo from '../components/Photo';
import { Button } from '../components/Ui';
import { api } from '../lib/api';
import { rand } from '../lib/format';
import { C } from '../lib/theme';

// Browse: every bookable SimonStays unit as a big photo card.
export default function Browse() {
  const [units, setUnits] = useState(null);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try { setError(''); const r = await api.units(); setUnits(r.units); }
    catch (e) { setError(e.message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  if (!units && !error) return <View style={styles.center}><ActivityIndicator color={C.green} size="large" /></View>;
  if (!units) {
    return (
      <View style={styles.center}>
        <Text style={styles.err}>Couldn’t load the stays. Check your connection.</Text>
        <Button title="Try again" onPress={load} style={{ alignSelf: 'center' }} />
      </View>
    );
  }
  return (
    <FlatList
      data={units}
      keyExtractor={(u) => u.unitId}
      contentContainerStyle={styles.list}
      contentInsetAdjustmentBehavior="automatic"
      refreshControl={<RefreshControl refreshing={refreshing} tintColor={C.green} onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }} />}
      ListHeaderComponent={<Text style={styles.intro}>Book your stay direct with SimonStays.</Text>}
      ListEmptyComponent={<Text style={styles.err}>No stays are open for booking right now.</Text>}
      renderItem={({ item, index }) => <UnitCard u={item} first={index < 2} />}
    />
  );
}

function UnitCard({ u, first }) {
  const { width } = useWindowDimensions();
  const w = width - 32;
  const facts = [
    u.bedrooms != null && `${u.bedrooms} bedroom${u.bedrooms === 1 ? '' : 's'}`,
    u.bathrooms != null && `${u.bathrooms} bath`,
    u.capacity && `sleeps ${u.capacity}`,
  ].filter(Boolean).join(' · ');
  return (
    <Pressable
      onPress={() => router.push({ pathname: '/unit/[id]', params: { id: u.unitId, propertyId: u.propertyId } })}
      style={({ pressed }) => [styles.card, pressed && { opacity: 0.92 }]}
      accessibilityRole="button"
      accessibilityLabel={`${u.propertyName} unit ${u.unitName}`}
    >
      <Photo id={u.coverPhotoId} width={w} height={Math.round(w * 2 / 3)} priority={first ? 'high' : 'normal'} style={styles.cardImg} />
      <View style={styles.cardBody}>
        <Text style={styles.title} numberOfLines={1}>{u.propertyName} · Unit {u.unitName}</Text>
        {!!u.address && <Text style={styles.sub} numberOfLines={1}>{u.address.split(',').slice(0, 2).join(',')}</Text>}
        {!!facts && <Text style={styles.sub}>{facts}</Text>}
        {u.fromNightlyCents != null && (
          <Text style={styles.price}><Text style={styles.priceBold}>{rand(u.fromNightlyCents)}</Text> / night{u.minNights > 1 ? ` · ${u.minNights}-night minimum` : ''}</Text>
        )}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 14 },
  err: { color: C.muted, textAlign: 'center', fontSize: 15, padding: 24 },
  list: { padding: 16, paddingBottom: 40 },
  intro: { fontSize: 15, color: C.muted, marginBottom: 14 },
  card: { backgroundColor: C.card, borderRadius: 16, marginBottom: 18, overflow: 'hidden', borderWidth: 1, borderColor: C.line },
  cardImg: { borderTopLeftRadius: 16, borderTopRightRadius: 16 },
  cardBody: { padding: 14, gap: 3 },
  title: { fontSize: 17, fontWeight: '800', color: C.ink },
  sub: { fontSize: 14, color: C.muted },
  price: { fontSize: 15, color: C.ink, marginTop: 4 },
  priceBold: { fontWeight: '800' },
});
