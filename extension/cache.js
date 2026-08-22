const DB_NAME = "manga-translate-cache";
const STORE_NAME = "translations";
const DB_VERSION = 2;

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      const store = db.objectStoreNames.contains(STORE_NAME)
        ? request.transaction.objectStore(STORE_NAME)
        : db.createObjectStore(STORE_NAME, { keyPath: "key" });
      createIndex(store, "createdAt", "createdAt");
      createIndex(store, "lastAccessedAt", "lastAccessedAt");
      createIndex(store, "siteKeys", "siteKeys", { multiEntry: true });
      createIndex(store, "pageKeys", "pageKeys", { multiEntry: true });
      createIndex(store, "pipelineVersion", "pipelineVersion");
      createIndex(store, "providerModel", "providerModel");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function createIndex(store, name, keyPath, options) {
  if (!store.indexNames.contains(name)) store.createIndex(name, keyPath, options);
}

async function transaction(mode, operation) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, mode);
      let result;
      let settled = false;
      const finish = (value) => { result = value; };
      const fail = (error) => {
        if (settled) return;
        settled = true;
        try { tx.abort(); } catch {}
        reject(error);
      };
      tx.oncomplete = () => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      tx.onerror = () => fail(tx.error);
      tx.onabort = () => fail(tx.error || new Error("Cache transaction aborted"));
      try {
        operation(tx.objectStore(STORE_NAME), finish, fail);
      } catch (error) {
        fail(error);
      }
    });
  } finally {
    db.close();
  }
}

export async function cacheGet(key, metadata = {}) {
  return transaction("readwrite", (store, finish, fail) => {
    const request = store.get(key);
    request.onerror = () => fail(request.error);
    request.onsuccess = () => {
      const entry = request.result;
      if (!entry) {
        finish(undefined);
        return;
      }
      const updated = mergeMetadata(entry, metadata);
      updated.lastAccessedAt = Date.now();
      const put = store.put(updated);
      put.onerror = () => fail(put.error);
      finish(updated);
    };
  });
}

export async function cachePut(entry) {
  return transaction("readwrite", (store, finish, fail) => {
    const now = Date.now();
    const request = store.put({
      ...entry,
      byteLength: entry.byteLength || entry.bytes?.byteLength || entry.bytes?.size || 0,
      createdAt: entry.createdAt || now,
      lastAccessedAt: now,
    });
    request.onerror = () => fail(request.error);
    request.onsuccess = () => finish(request.result);
  });
}

export async function cacheDelete(key) {
  return transaction("readwrite", (store, finish, fail) => {
    const request = store.delete(key);
    request.onerror = () => fail(request.error);
    request.onsuccess = () => finish(true);
  });
}

export async function cacheClear({ scope = "all", siteKey = "", pageKey = "" } = {}) {
  if (scope === "all") return deleteMatching(() => true);
  return deleteMatching((entry) => matchesScope(entry, { scope, siteKey, pageKey }));
}

export async function cacheStats({ siteKey = "", pageKey = "", pipelineVersion = "", maxAgeMs = 0 } = {}) {
  return transaction("readonly", (store, finish, fail) => {
    const now = Date.now();
    const summary = {
      total: emptySummary(),
      site: emptySummary(),
      page: emptySummary(),
      staleCount: 0,
    };
    const request = store.openCursor();
    request.onerror = () => fail(request.error);
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        finish(summary);
        return;
      }
      const entry = cursor.value;
      addToSummary(summary.total, entry);
      if (siteKey && entryKeys(entry, "siteKeys", "siteKey").includes(siteKey)) addToSummary(summary.site, entry);
      if (pageKey && entryKeys(entry, "pageKeys", "pageKey").includes(pageKey)) addToSummary(summary.page, entry);
      if ((entry.pipelineVersion && pipelineVersion && entry.pipelineVersion !== pipelineVersion)
        || (maxAgeMs > 0 && now - Number(entry.lastAccessedAt || entry.createdAt || 0) > maxAgeMs)) {
        summary.staleCount += 1;
      }
      cursor.continue();
    };
  });
}

export async function cachePrune({
  pipelineVersion = "",
  maxAgeMs = 0,
  maxBytes = Number.MAX_SAFE_INTEGER,
  maxEntries = Number.MAX_SAFE_INTEGER,
} = {}) {
  return transaction("readwrite", (store, finish, fail) => {
    const now = Date.now();
    const retained = [];
    let removedCount = 0;
    let removedBytes = 0;
    const request = store.openCursor();
    request.onerror = () => fail(request.error);
    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor) {
        const entry = cursor.value;
        const bytes = entryBytes(entry);
        const lastAccessedAt = Number(entry.lastAccessedAt || entry.createdAt || 0);
        const incompatible = Boolean(pipelineVersion && entry.pipelineVersion
          && entry.pipelineVersion !== pipelineVersion);
        const expired = maxAgeMs > 0 && now - lastAccessedAt > maxAgeMs;
        if (incompatible || expired) {
          cursor.delete();
          removedCount += 1;
          removedBytes += bytes;
        } else {
          retained.push({ key: entry.key, bytes, lastAccessedAt });
        }
        cursor.continue();
        return;
      }

      retained.sort((left, right) => left.lastAccessedAt - right.lastAccessedAt);
      let retainedBytes = retained.reduce((total, entry) => total + entry.bytes, 0);
      let retainedCount = retained.length;
      for (const entry of retained) {
        if (retainedBytes <= maxBytes && retainedCount <= maxEntries) break;
        store.delete(entry.key);
        retainedBytes -= entry.bytes;
        retainedCount -= 1;
        removedCount += 1;
        removedBytes += entry.bytes;
      }
      finish({ removedCount, removedBytes, retainedCount, retainedBytes });
    };
  });
}

async function deleteMatching(predicate) {
  return transaction("readwrite", (store, finish, fail) => {
    let count = 0;
    let bytes = 0;
    const request = store.openCursor();
    request.onerror = () => fail(request.error);
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        finish({ count, bytes });
        return;
      }
      if (predicate(cursor.value)) {
        count += 1;
        bytes += entryBytes(cursor.value);
        cursor.delete();
      }
      cursor.continue();
    };
  });
}

function mergeMetadata(entry, metadata) {
  const next = { ...entry, ...metadata };
  next.siteKeys = mergeKeys(entryKeys(entry, "siteKeys", "siteKey"), metadata.siteKeys, metadata.siteKey);
  next.pageKeys = mergeKeys(entryKeys(entry, "pageKeys", "pageKey"), metadata.pageKeys, metadata.pageKey);
  return next;
}

function matchesScope(entry, { scope, siteKey, pageKey }) {
  if (scope === "site") return Boolean(siteKey && entryKeys(entry, "siteKeys", "siteKey").includes(siteKey));
  if (scope === "page") return Boolean(pageKey && entryKeys(entry, "pageKeys", "pageKey").includes(pageKey));
  return false;
}

function entryKeys(entry, arrayKey, legacyKey) {
  return mergeKeys(entry[arrayKey], entry[legacyKey]);
}

function mergeKeys(...values) {
  const keys = values.flatMap((value) => Array.isArray(value) ? value : [value]);
  return [...new Set(keys.filter(Boolean))].slice(-32);
}

function emptySummary() {
  return { count: 0, bytes: 0, oldestAt: 0, newestAt: 0 };
}

function addToSummary(summary, entry) {
  const createdAt = Number(entry.createdAt || 0);
  summary.count += 1;
  summary.bytes += entryBytes(entry);
  if (createdAt && (!summary.oldestAt || createdAt < summary.oldestAt)) summary.oldestAt = createdAt;
  if (createdAt > summary.newestAt) summary.newestAt = createdAt;
}

function entryBytes(entry) {
  return Number(entry.byteLength || entry.bytes?.byteLength || entry.bytes?.size || 0);
}
