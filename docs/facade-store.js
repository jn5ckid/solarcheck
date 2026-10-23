let database;
function open() {
  database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open('solarcheck-facades', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('photos', {keyPath: 'key'});
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('다른 탭의 사진 저장소를 닫고 다시 시도해 주세요.'));
  });
  return database;
}

export async function loadFacades(siteId) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const request = db.transaction('photos').objectStore('photos').getAll();
    request.onsuccess = () => resolve(request.result.filter(p => p.siteId === siteId));
    request.onerror = () => reject(request.error);
  });
}

async function change(action) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('photos', 'readwrite');
    action(tx.objectStore('photos'));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('사진 저장이 취소됐어요.'));
  });
}

export function saveFacade(siteId, faceId, data) {
  return change(store => store.put({...data, siteId, faceId, key: `${siteId}:${faceId}`, updatedAt: new Date().toISOString()}));
}

export function removeFacade(siteId, faceId) {
  return change(store => store.delete(`${siteId}:${faceId}`));
}
