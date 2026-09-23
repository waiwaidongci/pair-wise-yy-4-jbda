// 规则层测试：node --test
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RULES, STATUS, baseMarginMinutes, consecutiveMarginMinutes,
  evaluateDive, evaluateAll, buildTimeline, orderDives,
} from '../src/rules.js';

function plus30(entryAt) {
  const m = /^(.+)T(\d{2}):(\d{2})$/.exec(entryAt || '');
  if (!m) return null;
  const total = Number(m[2]) * 60 + Number(m[3]) + 30;
  return `${m[1]}T${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

const base = (over = {}) => {
  const entryAt = over.entryAt === undefined ? '2026-09-22T09:00' : over.entryAt;
  return {
    id: over.id || 'd1', seq: over.seq ?? 1,
    depth: over.depth ?? 15, minutes: over.minutes ?? 30,
    entryAt,
    // 默认出水 = 下水 + 30 分钟；显式传 null 表示未登记
    exitAt: over.exitAt === undefined ? plus30(entryAt) : over.exitAt,
    note: over.note || '',
  };
};

test('基线余量按深度查表', () => {
  assert.equal(baseMarginMinutes(12), 120);
  assert.equal(baseMarginMinutes(18), 80);
  assert.equal(baseMarginMinutes(25), 30);
  assert.equal(baseMarginMinutes(40), 0);
});

test('连续潜次余量固定折减三成（四舍五入）', () => {
  // 18m 档基线 80 -> 56
  assert.equal(consecutiveMarginMinutes(18), Math.round(80 * 0.7));
  assert.equal(consecutiveMarginMinutes(18), 56);
  // 24m 档基线 50 -> 35
  assert.equal(consecutiveMarginMinutes(24), 35);
  // 判定结果须留痕前一潜深度与时长
  const prev = base({ id: 'p', seq: 1, depth: 30, minutes: 25 });
  const cur = base({ id: 'c', seq: 2, entryAt: '2026-09-22T10:30' });
  const r = evaluateDive(cur, prev);
  assert.equal(r.prevDepth, 30);
  assert.equal(r.prevMinutes, 25);
  assert.equal(r.discounted, true);
  assert.equal(r.baseMarginMinutes, 80);
  assert.equal(r.marginMinutes, 56);
});

test('首潜：准予放行，按基线余量，不折减', () => {
  const r = evaluateDive(base(), null);
  assert.equal(r.status, STATUS.CLEARED);
  assert.equal(r.discounted, false);
  assert.equal(r.marginMinutes, r.baseMarginMinutes);
  assert.equal(r.surfaceGapMinutes, null);
});

test('相邻潜次间隔不足 60 分钟：后一潜 BLOCKED，不得开始', () => {
  const prev = base({ id: 'p', seq: 1, entryAt: '2026-09-22T08:00', exitAt: '2026-09-22T08:30' });
  const cur = base({ id: 'c', seq: 2, entryAt: '2026-09-22T09:29' }); // 59 分钟
  const r = evaluateDive(cur, prev);
  assert.equal(r.status, STATUS.BLOCKED);
  assert.equal(r.surfaceGapMinutes, 59);
  assert.equal(r.marginMinutes, 56); // 即便禁止下水，折减余量仍给出

  // 恰好 60 分钟：可以开始
  const edge = evaluateDive(base({ id: 'c2', seq: 3, entryAt: '2026-09-22T09:30' }), prev);
  assert.equal(edge.status, STATUS.CLEARED);
  assert.equal(edge.surfaceGapMinutes, 60);
});

test('前一潜未登记出水时刻：后一潜 PENDING_REVIEW，且不进入时间线', () => {
  const prev = base({ id: 'p', seq: 1, exitAt: null });
  const cur = base({ id: 'c', seq: 2, entryAt: '2026-09-22T12:00' });
  const r = evaluateDive(cur, prev);
  assert.equal(r.status, STATUS.PENDING_REVIEW);
  assert.equal(r.surfaceGapMinutes, null);

  const timeline = buildTimeline([prev, cur]);
  assert.deepEqual(timeline.map(d => d.diveId), ['p']); // 前潜（首潜）在，后潜不在
});

test('补登出水且间隔满足后，后一潜恢复放行并进入时间线', () => {
  const prev = base({ id: 'p', seq: 1, exitAt: '2026-09-22T09:30' });
  const cur = base({ id: 'c', seq: 2, entryAt: '2026-09-22T10:30' });
  const r = evaluateDive(cur, prev);
  assert.equal(r.status, STATUS.CLEARED);
  const timeline = buildTimeline([prev, cur]);
  assert.equal(timeline.length, 2);
});

test('链式效应：第二潜被间隔挡住时，第三潜与第二潜间隔再长仍按数据评估', () => {
  // 规则逐对评估；第三潜相对的是排序意义上的前一潜
  const d1 = base({ id: '1', seq: 1, entryAt: '2026-09-22T08:00', exitAt: '2026-09-22T08:30' });
  const d2 = base({ id: '2', seq: 2, entryAt: '2026-09-22T09:00', exitAt: '2026-09-22T09:30' }); // gap 30 -> BLOCKED
  const d3 = base({ id: '3', seq: 3, entryAt: '2026-09-22T11:00' }); // 相对 d2 的出水(09:30) gap 90
  const all = evaluateAll([d3, d1, d2]); // 乱序输入
  const map = new Map(all.map(d => [d.diveId, d.status]));
  assert.equal(map.get('1'), STATUS.CLEARED);
  assert.equal(map.get('2'), STATUS.BLOCKED);
  assert.equal(map.get('3'), STATUS.CLEARED);
  // 时间线只含已放行：1 与 3
  assert.deepEqual(buildTimeline([d1, d2, d3]).map(d => d.diveId), ['1', '3']);
});

test('数据不合法：INVALID', () => {
  assert.equal(evaluateDive(base({ depth: 0 }), null).status, STATUS.INVALID);
  assert.equal(evaluateDive(base({ minutes: -5 }), null).status, STATUS.INVALID);
  assert.equal(evaluateDive(base({ entryAt: '' }), null).status, STATUS.INVALID);
  assert.equal(evaluateDive(base({ exitAt: '2026-09-22T08:00' }), null).status, STATUS.INVALID);
});

test('排序：先下水时刻，缺失者靠后，再按序号', () => {
  const a = base({ id: 'a', seq: 3, entryAt: '2026-09-22T10:00' });
  const b = base({ id: 'b', seq: 1, entryAt: '2026-09-22T08:00' });
  const c = base({ id: 'c', seq: 2, entryAt: null });
  assert.deepEqual(orderDives([a, b, c]).map(d => d.id), ['b', 'a', 'c']);
});

test('折减率常量为三成', () => {
  assert.equal(RULES.CONSECUTIVE_DISCOUNT_RATE, 0.3);
  assert.equal(RULES.MIN_SURFACE_GAP_MIN, 60);
});
