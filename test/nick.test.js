import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanNick, nickKey, nickProblem } from '../src/nick.js';

test('nicks: length, characters, reserved words, case and look-alikes', () => {
  assert.equal(nickProblem('Gonza'), null);
  assert.equal(nickProblem('  Juan   Pérez  '), null, 'accents and inner spaces are fine');
  assert.equal(cleanNick('  Juan   Pérez  '), 'Juan Pérez');
  assert.match(nickProblem('ab'), /3 to 20/);
  assert.match(nickProblem('x'.repeat(21)), /3 to 20/);
  assert.match(nickProblem('bad<script>'), /letters/);
  assert.match(nickProblem('😀😀😀'), /letters/);
  assert.match(nickProblem('ADMIN'), /reserved/);
  assert.equal(nickProblem(null) !== null, true);
  assert.equal(nickKey('Ｇｏｎｚａ'), nickKey('gonza'), 'full-width letters are the same nick');
});
