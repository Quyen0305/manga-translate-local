const DB_NAME = "manga-translate-cache";
const STORE_NAME = "translations";
const DB_VERSION = 1;

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: "key" });
        store.createIndex("createdAt", "createdAt");
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function transaction(mode, operation) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, mode);
      const request = operation(tx.objectStore(STORE_NAME));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export async function cacheGet(key) {
  return transaction("readonly", (store) => store.get(key));
}

export async function cachePut(entry) {
  return transaction("readwrite", (store) => store.put({ ...entry, createdAt: Date.now() }));
}

export async function cacheClear() {
  return transaction("readwrite", (store) => store.clear());
}

export async function cacheCount() {
  return transaction("readonly", (store) => store.count());
}
