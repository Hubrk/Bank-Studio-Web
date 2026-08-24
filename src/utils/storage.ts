/**
 * IndexedDB 持久化封装：
 * - recent: 最近打开的 bank（原始字节），供空态页一键重新载入
 * - session: 当前会话的替换状态 + 源 bank，供刷新后恢复
 *
 * PCM / bank 字节较大，故用 IndexedDB 而非 localStorage。
 */

const DB_NAME = 'bank-studio-web';
const DB_VERSION = 1;

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('recent')) {
        db.createObjectStore('recent', { keyPath: 'name' });
      }
      if (!db.objectStoreNames.contains('session')) {
        db.createObjectStore('session', { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx<T>(
  store: string,
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDB().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = fn(t.objectStore(store));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
  );
}

/** 把任何数组缓冲/typed array 统一转成 Uint8Array（IDB 反序列化后保证是 Uint8Array） */
const toU8 = (v: unknown): Uint8Array =>
  v instanceof Uint8Array ? v : new Uint8Array(v as ArrayBuffer);

// ---------------------------------------------------------------- recent

export interface RecentBank {
  name: string;
  bytes: Uint8Array;
  time: number;
}

export const putRecent = (name: string, bytes: Uint8Array): Promise<void> =>
  tx('recent', 'readwrite', (s) => s.put({ name, bytes, time: Date.now() })).then(() => undefined);

export const listRecent = async (): Promise<RecentBank[]> => {
  const rows = await tx<RecentBank[]>('recent', 'readonly', (s) => s.getAll());
  return rows
    .map((r) => ({ ...r, bytes: toU8(r.bytes) }))
    .sort((a, b) => b.time - a.time)
    .slice(0, 8);
};

export const removeRecent = (name: string): Promise<void> =>
  tx('recent', 'readwrite', (s) => s.delete(name)).then(() => undefined);

export const clearRecent = (): Promise<void> =>
  tx('recent', 'readwrite', (s) => s.clear()).then(() => undefined);

// ---------------------------------------------------------------- session

/** 持久化的替换条目：只存原生 PCM 一份，恢复时用 matchOriginal 重算最终 PCM，省空间 */
export interface PersistedReplace {
  index: number;
  nativePcm: Int16Array;
  nativeChannels: number;
  nativeRate: number;
}

export interface Session {
  id: string;
  fileName: string;
  bytes: Uint8Array;
  matchOriginal: boolean;
  matchLoudness?: boolean;
  replaces: PersistedReplace[];
  time: number;
}

export const putSession = (s: Session): Promise<void> =>
  tx('session', 'readwrite', (st) => st.put(s)).then(() => undefined);

export const getSession = async (): Promise<Session | null> => {
  const row = await tx<Session | null>('session', 'readonly', (st) => st.get('current'));
  if (!row) return null;
  return { ...row, bytes: toU8(row.bytes) };
};

export const clearSession = (): Promise<void> =>
  tx('session', 'readwrite', (st) => st.delete('current')).then(() => undefined);