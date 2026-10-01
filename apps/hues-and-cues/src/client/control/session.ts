import { storage } from '../common/storage.js';

const LAST_ROOM_KEY = 'hues-and-cues:last-room';

/** Remembers which game this browser last opened (a convenience only). */
export const lastRoom = {
  get: (): string | null => storage.get(LAST_ROOM_KEY),
  set: (roomId: string): void => {
    storage.set(LAST_ROOM_KEY, roomId);
  },
  clear: (): void => {
    storage.remove(LAST_ROOM_KEY);
  },
};

export function overlayUrl(roomId: string): string {
  const url = new URL('/overlay', window.location.origin);
  url.searchParams.set('room', roomId);
  return url.toString();
}
