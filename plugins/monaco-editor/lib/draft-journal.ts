const DATABASE_NAME = "bb.monaco-editor.drafts";
const STORE_NAME = "drafts";

export type DraftRecord = {
  key: string;
  text: string;
  baseSha: string | null;
};

let databasePromise: Promise<IDBDatabase> | null = null;

function openDatabase(): Promise<IDBDatabase> | null {
  if (typeof indexedDB === "undefined") return null;
  databasePromise ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE_NAME, { keyPath: "key" });
    };
    request.onsuccess = () => {
      const database = request.result;
      database.onclose = () => {
        databasePromise = null;
      };
      database.onversionchange = () => {
        database.close();
        databasePromise = null;
      };
      resolve(database);
    };
    request.onerror = () => {
      databasePromise = null;
      reject(request.error ?? new Error("Could not open the draft journal"));
    };
    request.onblocked = () => {
      databasePromise = null;
      reject(new Error("The draft journal is blocked"));
    };
  });
  return databasePromise;
}

async function runStoreRequest<Result>(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<Result>,
): Promise<Result | undefined> {
  const opening = openDatabase();
  if (opening === null) return undefined;
  const database = await opening;
  return new Promise<Result>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, mode);
    const request = operation(transaction.objectStore(STORE_NAME));
    transaction.oncomplete = () => resolve(request.result);
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("Draft journal write failed"));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("Draft journal write aborted"));
  });
}

function isDraftRecord(value: unknown): value is DraftRecord {
  if (typeof value !== "object" || value === null) return false;
  const { key, text, baseSha } = value as Record<string, unknown>;
  return (
    typeof key === "string" &&
    typeof text === "string" &&
    (typeof baseSha === "string" || baseSha === null)
  );
}

export async function readDraft(key: string): Promise<DraftRecord | null> {
  try {
    const value = await runStoreRequest("readonly", (store) => store.get(key));
    return isDraftRecord(value) ? value : null;
  } catch {
    return null;
  }
}

export async function writeDraft(record: DraftRecord): Promise<void> {
  await runStoreRequest("readwrite", (store) => store.put(record));
}

export async function deleteDraft(key: string): Promise<void> {
  await runStoreRequest("readwrite", (store) => store.delete(key));
}
