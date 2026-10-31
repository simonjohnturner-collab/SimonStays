import { Image } from 'expo-image';
import { photoUrl } from '../lib/api';
import { C } from '../lib/theme';

// A listing photo: requested at the size it's drawn (sharp on any screen, fast
// on mobile data), cached on disk, faded in over a soft grey.
export default function Photo({ id, width, height, fit = 'cover', style, priority, recyclingKey }) {
  return (
    <Image
      source={id ? { uri: photoUrl(id, width) } : null}
      style={[{ width, height, backgroundColor: fit === 'contain' ? 'transparent' : C.line }, style]}
      contentFit={fit}
      transition={180}
      cachePolicy="disk"
      priority={priority}
      recyclingKey={recyclingKey || id}
      accessibilityIgnoresInvertColors
    />
  );
}
