// 记录层测试：版本留档、幂等提交、修订重算、导出排除旧版
import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore, memoryStorage } from '../src/records.js';
import { STATUS } from '../src/rules.js';

const DAY = '2026-09-22';
const dive = (seq, hhmmEntry, hhmmExit, over = {}) => ({
  seq, depth: over.depth ?? 15, minutes: over.minutes ?? 30,
  entryAt: `${DAY}T${hhmmEntry}`,
  exitAt: hhmmExit ? `${DAY}T${hhmmExit}` : null,
  note: over.note || '',
});

function statusMap(store) {
  return new Map(store.getDecisions().map(d => [d.seq, d.status]));
}

test('完整链路：首潜放行；前潜未出水 -> 待复核；补登后（间隔不足）-> 禁潜；修订拉开间隔 -> 放行', () => {
  const store = createStore(memoryStorage());
  const d1 = store.submitDive({ data: dive(1, '08:00', null) }).dive;
  let s = statusMap(store);
  assert.equal(s.get(1), STATUS.CLEARED);

  const d2 = store.submitDive({ data: dive(2, '10:00', null) }).dive;
  s = statusMap(store);
  // 前潜未登记出水时刻 -> 只留待复核，不进时间线
  assert.equal(s.get(2), STATUS.PENDING_REVIEW);
  assert.deepEqual(store.getDecisions().filter(d => d.status === STATUS.CLEARED).map(d => d.seq), [1]);

  // 补登：出水 09:30，距第二潜下水仅 30 分钟 -> 禁潜
  store.registerExit({ diveId: d1.id, exitAt: `${DAY}T09:30` });
  s = statusMap(store);
  assert.equal(s.get(2), STATUS.BLOCKED);

  // 修订第二潜下水时刻到 10:30（间隔 60 分钟）-> 放行并进入时间线
  store.reviseDive({ diveId: d2.id, data: { entryAt: `${DAY}T10:30`, reason: '推迟下水' } });
  s = statusMap(store);
  assert.equal(s.get(2), STATUS.CLEARED);
  assert.deepEqual(store.getDecisions().filter(d => d.status === STATUS.CLEARED).map(d => d.seq), [1, 2]);
});

test('修订任一潜次：旧版留档、版本号递增、后续放行按新值级联重算', () => {
  const store = createStore(memoryStorage());
  const d1 = store.submitDive({ data: dive(1, '08:00', '08:30') }).dive;
  const d2 = store.submitDive({ data: dive(2, '09:30', null) }).dive; // gap 60，已放行
  const d3 = store.submitDive({ data: dive(3, '11:00', null) }).dive; // 相对 d2 无出水 -> 待复核
  assert.equal(statusMap(store).get(3), STATUS.PENDING_REVIEW);

  // 把第一潜出水改晚到 09:10 -> 第二潜 gap 只有 20 分钟，转 BLOCKED
  store.reviseDive({ diveId: d1.id, data: { exitAt: `${DAY}T09:10` } });
  const s = statusMap(store);
  assert.equal(s.get(2), STATUS.BLOCKED);

  // d1 版本升至 2，旧版 v1 已留档
  const fresh1 = store._dives().find(d => d.id === d1.id);
  assert.equal(fresh1.version, 2);
  assert.equal(fresh1.exitAt, `${DAY}T09:10`);
  const arcs = store._archives();
  assert.equal(arcs.length, 1);
  assert.equal(arcs[0].diveId, d1.id);
  assert.equal(arcs[0].version, 1);
  assert.equal(arcs[0].exitAt, `${DAY}T08:30`);

  // 再次修订 d2，留档继续追加，互不覆盖
  store.reviseDive({ diveId: d2.id, data: { entryAt: `${DAY}T12:00` } });
  assert.equal(store._archives().length, 2);
  assert.equal(store._dives().find(d => d.id === d2.id).version, 2);
});

test('幂等：同 token 并发/重复提交沿用首次结果，只生成一条记录', async () => {
  const store = createStore(memoryStorage());
  const token = 'req-abc-001';
  const payload = { data: dive(1, '08:00', '08:30'), token };
  const results = await Promise.all([
    Promise.resolve(store.submitDive(payload)),
    Promise.resolve(store.submitDive(payload)),
    Promise.resolve(store.submitDive(payload)),
  ]);
  assert.equal(store._dives().length, 1);
  const id = results[0].dive.id;
  assert.ok(results.every(r => r.dive.id === id));
  assert.equal(results[0].duplicate, false);
  assert.equal(results[1].duplicate, true);
  assert.equal(results[2].duplicate, true);
});

test('幂等：无 token 时同内容重复申报也去重（刷新页面后仍一致）', () => {
  const storage = memoryStorage();
  const store1 = createStore(storage);
  const r1 = store1.submitDive({ data: dive(1, '08:00', '08:30') });
  const r2 = store1.submitDive({ data: dive(1, '08:00', '08:30') });
  assert.equal(r2.duplicate, true);
  assert.equal(r2.dive.id, r1.dive.id);

  // 模拟刷新：从同一 storage 重建 store
  const store2 = createStore(storage);
  const r3 = store2.submitDive({ data: dive(1, '08:00', '08:30') });
  assert.equal(r3.duplicate, true);
  assert.equal(r3.dive.id, r1.dive.id);
});

test('不同内容的申报不会被误去重', () => {
  const store = createStore(memoryStorage());
  store.submitDive({ data: dive(1, '08:00', '08:30') });
  store.submitDive({ data: dive(2, '09:30', null) });
  assert.equal(store._dives().length, 2);
});

test('修订与补登出水同样幂等', () => {
  const store = createStore(memoryStorage());
  const d1 = store.submitDive({ data: dive(1, '08:00', null) }).dive;
  const token = 'exit-1';
  const r1 = store.registerExit({ diveId: d1.id, exitAt: `${DAY}T08:30`, token });
  const r2 = store.registerExit({ diveId: d1.id, exitAt: `${DAY}T08:30`, token });
  assert.equal(r2.duplicate, true);
  assert.equal(store._archives().length, 1);
  assert.equal(store._dives()[0].version, 2);

  const tok2 = 'revise-1';
  const a = store.reviseDive({ diveId: d1.id, data: { minutes: 40 }, token: tok2 });
  const b = store.reviseDive({ diveId: d1.id, data: { minutes: 40 }, token: tok2 });
  assert.equal(b.duplicate, true);
  assert.equal(a.dive.minutes, 40);
  assert.equal(store._dives()[0].version, 3); // 只真正修订一次
});

test('导出：只含现行版本，留档与内部字段不进入导出', () => {
  const store = createStore(memoryStorage());
  const d1 = store.submitDive({ data: dive(1, '08:00', '08:30') }).dive;
  store.submitDive({ data: dive(2, '09:30', null) });
  store.reviseDive({ diveId: d1.id, data: { minutes: 45 } });

  const json = JSON.parse(store.exportJSON());
  assert.ok(Array.isArray(json.dives) && json.dives.length === 2);
  assert.ok(!('archives' in json), '留档不得进入导出');
  assert.ok(!('idempotency' in json), '幂等登记不得进入导出');
  const exported1 = json.dives.find(d => d.id === d1.id);
  assert.equal(exported1.minutes, 45);        // 现行新值
  assert.equal(exported1.version, 2);
  const oldVersions = json.dives.filter(d => d.id === d1.id && d.version === 1);
  assert.equal(oldVersions.length, 0);        // 旧版不导出
  assert.ok(!('releaseStatus' in exported1)); // 内部瞬态字段不导出
  // 导出同时携带按新值计算的放行判定
  assert.ok(json.decisions.every(d => ['CLEARED', 'BLOCKED', 'PENDING_REVIEW', 'INVALID'].includes(d.status)));
});

test('CSV 导出含状态与关联前潜，BOM 头存在', () => {
  const store = createStore(memoryStorage());
  store.submitDive({ data: dive(1, '08:00', '08:30') });
  store.submitDive({ data: dive(2, '09:00', null) }); // gap 30 -> BLOCKED
  const csv = store.exportCSV();
  assert.ok(csv.startsWith('﻿'));
  assert.match(csv, /BLOCKED/);
  assert.match(csv, /CLEARED/);
});

test('校验：深度/时长非法、出水早于下水抛错', () => {
  const store = createStore(memoryStorage());
  assert.throws(() => store.submitDive({ data: dive(1, '08:00', null, { depth: 0 }) }), /深度/);
  assert.throws(() => store.submitDive({ data: dive(1, '08:00', null, { minutes: 0 }) }), /时长/);
  assert.throws(() => store.submitDive({ data: dive(1, '08:00', '07:50') }), /出水时刻/);
  assert.equal(store._dives().length, 0); // 失败提交不留数据
});

test('失败的提交不占用幂等键，修正后可重新提交', () => {
  const store = createStore(memoryStorage());
  const token = 'retry-me';
  assert.throws(() => store.submitDive({ data: dive(1, '08:00', null, { depth: -1 }), token }));
  const r = store.submitDive({ data: dive(1, '08:00', '08:30'), token });
  assert.equal(r.duplicate, false);
  assert.equal(store._dives().length, 1);
});
