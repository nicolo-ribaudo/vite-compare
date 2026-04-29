const DB_NAME = 'vite-compare';
const STORE = 'kv';
const KEY = 'state';
const VERSION = 2;

export interface PersistedFile {
  filename: string;
  raw: string;
}

export interface PersistedSide {
  stats?: PersistedFile;
}

export interface PersistedState {
  version: number;
  a: PersistedSide;
  b: PersistedSide;
  graphView: 'a' | 'b';
  graphHideUnchanged?: boolean;
  entryDynamicSearch?: string;
  graphHiddenChunks?: string[];
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

export async function loadPersisted(): Promise<PersistedState | null> {
  try {
    const db = await openDb();
    return await new Promise<PersistedState | null>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(KEY);
      req.onsuccess = () => {
        const value = req.result as PersistedState | undefined;
        if (!value || value.version !== VERSION) {
          resolve(null);
          return;
        }
        resolve(value);
      };
      req.onerror = () => reject(req.error);
    });
  } catch (err) {
    console.warn('vite-compare: load persisted state failed', err);
    return null;
  }
}

export async function savePersisted(
  state: Omit<PersistedState, 'version'>,
): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put({ version: VERSION, ...state }, KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    console.warn('vite-compare: save persisted state failed', err);
  }
}

export async function clearPersisted(): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    console.warn('vite-compare: clear persisted state failed', err);
  }
}
