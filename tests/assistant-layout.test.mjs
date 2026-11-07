import test from 'node:test';
import assert from 'node:assert/strict';
import { assistantPaneSizes, DEFAULT_ASSISTANT_WIDTH } from '../ui/mail-layout.mjs';

test('assistant resizing preserves a usable desktop workspace', () => {
  for (const available of [1001, 1100, 1440, 1920]) {
    for (const preferred of [-100, 300, DEFAULT_ASSISTANT_WIDTH, 600, 5000, NaN]) {
      const pane = assistantPaneSizes(preferred, available);
      assert.equal(pane.overlay, false);
      assert.ok(pane.width >= 300 && pane.width <= 720);
      assert.ok(available - pane.width >= 600);
      assert.ok(pane.min <= pane.width && pane.width <= pane.max);
    }
  }
});

test('narrow assistant overlays stay within the available window', () => {
  for (const available of [0, 240, 280, 300, 390, 768, 1000]) {
    for (const preferred of [280, DEFAULT_ASSISTANT_WIDTH, 2000, Infinity]) {
      const pane = assistantPaneSizes(preferred, available);
      assert.equal(pane.overlay, true);
      assert.ok(pane.width >= Math.min(300, available));
      assert.ok(pane.width <= available && pane.width <= 720);
    }
  }
});

test('restoring a wide preference after a temporary narrow window', () => {
  assert.equal(assistantPaneSizes(620, 390).width, 390);
  assert.equal(assistantPaneSizes(620, 1440).width, 620);
  assert.equal(assistantPaneSizes(NaN, 1440).width, DEFAULT_ASSISTANT_WIDTH);
});
