import { useState } from 'react';
import { FlatList, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import Photo from './Photo';
import { C } from '../lib/theme';

// Swipeable full-width photos (4:3, edge to edge) with a 1 / 12 counter. Tap one
// to open it full screen and uncropped, where you can keep swiping (and pinch
// to zoom on iPhone).
export default function PhotoCarousel({ photos }) {
  const { width } = useWindowDimensions();
  const height = Math.round(width * 0.75);
  const [index, setIndex] = useState(0);
  const [open, setOpen] = useState(null);

  if (!photos.length) {
    return <View style={[styles.empty, { width, height }]}><Text style={styles.emptyText}>Photos coming soon</Text></View>;
  }
  return (
    <View>
      <FlatList
        data={photos}
        keyExtractor={(p) => p.id}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        getItemLayout={(_, i) => ({ length: width, offset: width * i, index: i })}
        onMomentumScrollEnd={(e) => setIndex(Math.round(e.nativeEvent.contentOffset.x / width))}
        initialNumToRender={2}
        windowSize={3}
        renderItem={({ item, index: i }) => (
          <Pressable onPress={() => setOpen(i)} accessibilityLabel={`Photo ${i + 1} of ${photos.length}, tap to enlarge`}>
            <Photo id={item.id} width={width} height={height} priority={i === 0 ? 'high' : 'normal'} />
          </Pressable>
        )}
      />
      {photos.length > 1 && <View style={styles.counter}><Text style={styles.counterText}>{index + 1} / {photos.length}</Text></View>}
      {open != null && <Lightbox photos={photos} start={open} onClose={() => setOpen(null)} />}
    </View>
  );
}

function Lightbox({ photos, start, onClose }) {
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [index, setIndex] = useState(start);

  return (
    <Modal visible animationType="fade" onRequestClose={onClose} statusBarTranslucent supportedOrientations={['portrait']}>
      <StatusBar style="light" />
      <View style={styles.lbWrap}>
        <FlatList
          data={photos}
          keyExtractor={(p) => p.id}
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          initialScrollIndex={start}
          getItemLayout={(_, i) => ({ length: width, offset: width * i, index: i })}
          onMomentumScrollEnd={(e) => setIndex(Math.round(e.nativeEvent.contentOffset.x / width))}
          windowSize={3}
          renderItem={({ item }) => (
            Platform.OS === 'ios' ? (
              <ScrollView style={{ width, height }} contentContainerStyle={{ width, height, justifyContent: 'center' }}
                maximumZoomScale={4} minimumZoomScale={1} centerContent bouncesZoom
                showsHorizontalScrollIndicator={false} showsVerticalScrollIndicator={false}>
                <Photo id={item.id} width={width} height={height} fit="contain" />
              </ScrollView>
            ) : (
              <View style={{ width, height, justifyContent: 'center' }}>
                <Photo id={item.id} width={width} height={height} fit="contain" />
              </View>
            )
          )}
        />
        <View style={[styles.lbBar, { top: insets.top + 8 }]} pointerEvents="box-none">
          <Text style={styles.lbCount}>{index + 1} / {photos.length}</Text>
          <Pressable onPress={onClose} hitSlop={12} style={styles.lbClose} accessibilityLabel="Close photos">
            <Text style={styles.lbCloseText}>✕</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  empty: { backgroundColor: C.line, alignItems: 'center', justifyContent: 'center' },
  emptyText: { color: C.muted },
  counter: { position: 'absolute', right: 12, bottom: 12, backgroundColor: 'rgba(0,0,0,0.6)', borderRadius: 12, paddingHorizontal: 9, paddingVertical: 3 },
  counterText: { color: '#fff', fontSize: 12, fontWeight: '600' },
  lbWrap: { flex: 1, backgroundColor: '#000' },
  lbBar: { position: 'absolute', left: 16, right: 16, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  lbCount: { color: '#fff', fontSize: 14, fontWeight: '600' },
  lbClose: { width: 36, height: 36, borderRadius: 18, backgroundColor: 'rgba(255,255,255,0.18)', alignItems: 'center', justifyContent: 'center' },
  lbCloseText: { color: '#fff', fontSize: 18 },
});
