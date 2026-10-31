import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { C } from '../lib/theme';

export function Button({ title, onPress, disabled, busy, kind = 'primary', style }) {
  const secondary = kind === 'secondary';
  return (
    <Pressable onPress={onPress} disabled={disabled || busy} accessibilityRole="button"
      style={({ pressed }) => [styles.btn, secondary && styles.btnSecondary, (disabled || busy) && styles.btnDisabled, pressed && { opacity: 0.85 }, style]}>
      {busy ? <ActivityIndicator color={secondary ? C.green : '#fff'} /> : <Text style={[styles.btnText, secondary && { color: C.green }]}>{title}</Text>}
    </Pressable>
  );
}

export function Field({ label, style, ...props }) {
  return (
    <View style={{ marginBottom: 12 }}>
      <Text style={styles.label}>{label}</Text>
      <TextInput placeholderTextColor="#9aa1ab" style={[styles.input, style]} {...props} />
    </View>
  );
}

export function Check({ checked, onToggle, children }) {
  return (
    <Pressable onPress={onToggle} style={styles.check} accessibilityRole="checkbox" accessibilityState={{ checked }}>
      <View style={[styles.box, checked && styles.boxOn]}>{checked && <Text style={styles.tick}>✓</Text>}</View>
      <Text style={styles.checkText}>{children}</Text>
    </Pressable>
  );
}

export function Choice({ selected, onPress, title, sub }) {
  return (
    <Pressable onPress={onPress} style={[styles.choice, selected && styles.choiceOn]} accessibilityRole="radio" accessibilityState={{ selected }}>
      <View style={[styles.radio, selected && styles.radioOn]}>{selected && <View style={styles.radioDot} />}</View>
      <View style={{ flex: 1 }}>
        <Text style={styles.choiceTitle}>{title}</Text>
        {sub ? <Text style={styles.choiceSub}>{sub}</Text> : null}
      </View>
    </Pressable>
  );
}

export function Row({ left, right, bold, muted }) {
  return (
    <View style={styles.row}>
      <Text style={[styles.rowText, bold && styles.bold, muted && styles.muted]}>{left}</Text>
      <Text style={[styles.rowText, bold && styles.bold, muted && styles.muted]}>{right}</Text>
    </View>
  );
}

export function Card({ children, style }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

export function H({ children, style }) {
  return <Text style={[styles.h, style]}>{children}</Text>;
}

const styles = StyleSheet.create({
  btn: { backgroundColor: C.green, borderRadius: 10, paddingVertical: 14, paddingHorizontal: 18, alignItems: 'center', justifyContent: 'center', minHeight: 50 },
  btnSecondary: { backgroundColor: '#fff', borderWidth: 1, borderColor: C.green },
  btnDisabled: { opacity: 0.45 },
  btnText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  label: { fontSize: 13, color: C.muted, marginBottom: 5, fontWeight: '600' },
  input: { borderWidth: 1, borderColor: C.line, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 11, fontSize: 16, color: C.ink, backgroundColor: '#fff' },
  check: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, marginBottom: 12 },
  box: { width: 22, height: 22, borderRadius: 6, borderWidth: 1.5, borderColor: '#9aa1ab', alignItems: 'center', justifyContent: 'center', marginTop: 1 },
  boxOn: { backgroundColor: C.green, borderColor: C.green },
  tick: { color: '#fff', fontSize: 14, fontWeight: '800' },
  checkText: { flex: 1, fontSize: 14, color: C.ink, lineHeight: 20 },
  choice: { flexDirection: 'row', alignItems: 'center', gap: 12, borderWidth: 1, borderColor: C.line, borderRadius: 12, padding: 14, marginBottom: 10, backgroundColor: '#fff' },
  choiceOn: { borderColor: C.green, backgroundColor: C.greenSoft },
  radio: { width: 22, height: 22, borderRadius: 11, borderWidth: 1.5, borderColor: '#9aa1ab', alignItems: 'center', justifyContent: 'center' },
  radioOn: { borderColor: C.green },
  radioDot: { width: 12, height: 12, borderRadius: 6, backgroundColor: C.green },
  choiceTitle: { fontSize: 15, fontWeight: '700', color: C.ink },
  choiceSub: { fontSize: 13, color: C.muted, marginTop: 2 },
  row: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4, gap: 12 },
  rowText: { fontSize: 15, color: C.ink, flexShrink: 1 },
  bold: { fontWeight: '800' },
  muted: { color: C.muted },
  card: { backgroundColor: C.card, borderRadius: 14, borderWidth: 1, borderColor: C.line, padding: 16, marginBottom: 14 },
  h: { fontSize: 18, fontWeight: '800', color: C.ink, marginBottom: 10 },
});
