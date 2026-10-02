'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const C = require('../src/fx-charts.js');

describe('chart axes', () => {
  test('niceTicks lands on round numbers that cover the range', () => {
    assert.deepEqual(C.niceTicks(3.75, 6.75, 5), [4, 4.5, 5, 5.5, 6, 6.5]);
    assert.deepEqual(C.niceTicks(0, 10, 5), [0, 2, 4, 6, 8, 10]);
    assert.deepEqual(C.niceTicks(5, 5, 5), [5]);
    assert.deepEqual(C.niceTicks(1, 2, 5), [1, 1.2, 1.4, 1.6, 1.8, 2], 'no float noise');
    for (const v of C.niceTicks(0.1, 0.9, 4)) assert.equal(String(v).length <= 4, true, 'clean decimals: ' + v);
    for (const [lo, hi] of [[0.3, 7.9], [1, 2], [0, 1000], [-3, 4]]) {
      const t = C.niceTicks(lo, hi, 5);
      assert.ok(t.length >= 2 && t[0] >= lo - 1e-9 && t[t.length - 1] <= hi + 1e-9, JSON.stringify([lo, hi, t]));
    }
  });
  test('time ticks use hours for short spans and days for long ones', () => {
    const short = C.timeTicks(-0.25, 1, 6), long = C.timeTicks(-3, 40, 6);
    assert.ok(short.every(v => Math.abs(v * 24 - Math.round(v * 24)) < 1e-9), 'whole hours: ' + short);
    assert.ok(long.every(v => Math.abs(v - Math.round(v)) < 1e-9), 'whole days: ' + long);
    assert.ok(long.includes(0) && short.includes(0), 'the mainshock is always a tick');
  });
  test('time labels', () => {
    assert.equal(C.timeLabel(0), '0');
    assert.equal(C.timeLabel(0.25), '+6h');
    assert.equal(C.timeLabel(-1), '−1d');
    assert.equal(C.timeLabel(2.5), '+2.5d');
    assert.equal(C.timeLabel(-0.5), '−12h');
  });
});
