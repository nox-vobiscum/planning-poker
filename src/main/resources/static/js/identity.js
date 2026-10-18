// Resume proofs and proof-bound lifecycle intent only. Room state remains server-authoritative.
(() => {
  'use strict';
  const memory = new Map();
  const pendingExitMemory = new Map();
  const key = room => 'pp-identity-v2:' + encodeURIComponent(room);
  const exitKey = room => 'pp-identity-exit-v1:' + encodeURIComponent(room);
  const valid = value => value && typeof value.roomInstanceId === 'string' &&
    typeof value.participantId === 'string' && typeof value.token === 'string' && value.token.length === 43;
  const same = (left, right) => valid(left) && valid(right) && left.token === right.token &&
    left.roomInstanceId === right.roomInstanceId && left.participantId === right.participantId;
  const credential = value => ({
    roomInstanceId: value.roomInstanceId,
    participantId: value.participantId,
    token: value.token
  });
  const get = (area, storageKey) => {
    try { return JSON.parse(window[area].getItem(storageKey) || 'null'); } catch { return null; }
  };
  const put = (area, storageKey, value) => {
    try {
      const text = JSON.stringify(value);
      window[area].setItem(storageKey, text);
      return window[area].getItem(storageKey) === text;
    } catch { return false; }
  };
  const remove = (area, storageKey) => {
    try { window[area].removeItem(storageKey); } catch {}
  };

  function migrateLegacySessionKeys() {
    try {
      sessionStorage.removeItem('pp-cid');
      for (let index = sessionStorage.length - 1; index >= 0; index--) {
        const candidate = sessionStorage.key(index);
        if (candidate && candidate.startsWith('pp-pf-ok:')) sessionStorage.removeItem(candidate);
      }
    } catch {}
  }

  function read(room) {
    if (memory.has(room)) return memory.get(room);
    const local = get('localStorage', key(room));
    if (valid(local)) {
      const value = credential(local);
      memory.set(room, value);
      return value;
    }
    const session = get('sessionStorage', key(room));
    if (!valid(session)) return null;
    const value = credential(session);
    memory.set(room, value);
    // Promote a session fallback when durable storage becomes available again.
    if (put('localStorage', key(room), value)) remove('sessionStorage', key(room));
    return value;
  }

  function save(room, value) {
    if (!valid(value)) throw new Error('Invalid identity response');
    const stored = credential(value);
    memory.set(room, stored);
    if (put('localStorage', key(room), stored)) {
      remove('sessionStorage', key(room));
      return 'localStorage';
    }
    if (put('sessionStorage', key(room), stored)) return 'sessionStorage';
    return 'memory';
  }

  function clear(room, expected) {
    // A stale tab must not delete a newer participation's proof.
    if (same(memory.get(room), expected)) memory.delete(room);
    for (const area of ['localStorage', 'sessionStorage']) {
      const value = get(area, key(room));
      if (same(value, expected)) remove(area, key(room));
    }
  }

  function markExit(room, expected) {
    if (!valid(expected)) return 'unavailable';
    const marker = { roomInstanceId: expected.roomInstanceId, participantId: expected.participantId };
    pendingExitMemory.set(room, marker);
    if (put('localStorage', exitKey(room), marker)) {
      remove('sessionStorage', exitKey(room));
      return 'localStorage';
    }
    if (put('sessionStorage', exitKey(room), marker)) return 'sessionStorage';
    return 'memory';
  }

  function exitPending(room, expected) {
    if (!valid(expected)) return false;
    const matches = marker => marker && marker.roomInstanceId === expected.roomInstanceId &&
      marker.participantId === expected.participantId;
    if (matches(pendingExitMemory.get(room))) return true;
    for (const area of ['localStorage', 'sessionStorage']) {
      const marker = get(area, exitKey(room));
      if (matches(marker)) {
        pendingExitMemory.set(room, marker);
        return true;
      }
    }
    return false;
  }

  function clearExit(room, expected) {
    const matches = marker => marker && expected && marker.roomInstanceId === expected.roomInstanceId &&
      marker.participantId === expected.participantId;
    if (matches(pendingExitMemory.get(room))) pendingExitMemory.delete(room);
    for (const area of ['localStorage', 'sessionStorage']) {
      const marker = get(area, exitKey(room));
      if (matches(marker)) remove(area, exitKey(room));
    }
  }

  migrateLegacySessionKeys();
  window.PPIdentity = Object.freeze({ read, save, clear, markExit, exitPending, clearExit });
})();
