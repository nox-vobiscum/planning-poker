import { expect, test } from '@playwright/test';
import { newRoomCode, roomUrlFor } from './utils/env';

test('pageshow cannot send regular messages before identityReady', async ({ browserName, page }) => {
  test.skip(browserName !== 'firefox', 'Firefox lifecycle ordering regression');

  await page.addInitScript(() => {
    const nativeSend = WebSocket.prototype.send;
    WebSocket.prototype.send = function (payload) {
      nativeSend.call(this, payload);
      try {
        const message = JSON.parse(String(payload));
        if (message.type === 'newJoin') {
          window.dispatchEvent(new PageTransitionEvent('pageshow'));
        }
      } catch {}
    };
  });

  const frames: Array<{ direction: 'sent' | 'received'; type: string; reason?: string }> = [];
  page.on('websocket', socket => {
    socket.on('framesent', frame => {
      const payload = String(frame.payload);
      try {
        const message = JSON.parse(payload);
        frames.push({ direction: 'sent', type: message.type || 'json' });
      } catch {
        frames.push({ direction: 'sent', type: payload.split(':', 1)[0]! });
      }
    });
    socket.on('framereceived', frame => {
      try {
        const message = JSON.parse(String(frame.payload));
        if (message.type?.startsWith('identity')) {
          frames.push({ direction: 'received', type: message.type, reason: message.reason });
        }
      } catch {}
    });
  });

  await page.goto(roomUrlFor('Firefox Wake', newRoomCode('FF-WAKE')));
  await expect(page.locator('body')).toHaveClass(/is-host/);
  await expect(page.locator('#liveParticipantList .participant-row')).toHaveCount(1);

  const readyIndex = frames.findIndex(frame => frame.direction === 'received' && frame.type === 'identityReady');
  const newJoinIndex = frames.findIndex(frame => frame.direction === 'sent' && frame.type === 'newJoin');
  const grantIndex = frames.findIndex(frame => frame.direction === 'received' && frame.type === 'identityGrant');
  const ackIndex = frames.findIndex(frame => frame.direction === 'sent' && frame.type === 'identityAck');
  expect(readyIndex, JSON.stringify(frames)).toBeGreaterThan(-1);
  expect(newJoinIndex, JSON.stringify(frames)).toBeGreaterThan(-1);
  expect(grantIndex, JSON.stringify(frames)).toBeGreaterThan(newJoinIndex);
  expect(ackIndex, JSON.stringify(frames)).toBeGreaterThan(grantIndex);
  expect(readyIndex, JSON.stringify(frames)).toBeGreaterThan(ackIndex);
  expect(frames.slice(0, readyIndex).some(frame => frame.type === 'ping' || frame.type === 'requestSync')).toBe(false);
  expect(frames.some(frame => frame.type === 'identityError')).toBe(false);
});
