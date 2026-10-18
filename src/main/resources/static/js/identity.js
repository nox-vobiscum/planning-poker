// Resume proofs only. Participant state remains authoritative on the server.
(() => {
  'use strict';
  const memory = new Map();
  const key = room => 'pp-identity-v2:' + encodeURIComponent(room);
  const valid = value => value && typeof value.roomInstanceId === 'string' &&
    typeof value.participantId === 'string' && typeof value.token === 'string' && value.token.length === 43;
  function read(room) {
    if (memory.has(room)) return memory.get(room);
    for (const area of ['localStorage', 'sessionStorage']) {
      try {
        const value = JSON.parse(window[area].getItem(key(room)) || 'null');
        if (valid(value)) { memory.set(room, value); return value; }
      } catch {}
    }
    return null;
  }
  function save(room, value) {
    if (!valid(value)) throw new Error('Invalid identity response');
    const credential = { roomInstanceId: value.roomInstanceId, participantId: value.participantId, token: value.token };
    memory.set(room, credential);
    for (const area of ['localStorage', 'sessionStorage']) {
      try {
        const text = JSON.stringify(credential);
        window[area].setItem(key(room), text);
        if (window[area].getItem(key(room)) === text) return area;
      } catch {}
    }
    return 'memory';
  }
  function clear(room, expected) {
    // A stale tab must not delete a newer participation's proof.
    const matches = value => value && expected && value.token === expected.token &&
      value.roomInstanceId === expected.roomInstanceId && value.participantId === expected.participantId;
    if (matches(memory.get(room))) memory.delete(room);
    for (const area of ['localStorage', 'sessionStorage']) {
      try {
        const value = JSON.parse(window[area].getItem(key(room)) || 'null');
        if (matches(value)) window[area].removeItem(key(room));
      } catch {}
    }
  }
  window.PPIdentity = Object.freeze({ read, save, clear });
})();