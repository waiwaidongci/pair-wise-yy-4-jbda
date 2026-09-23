// 业务文件二：记录
// 潜次记录的增改、出水登记、版本留档、幂等提交、重算与导出。
// 不碰 DOM；存储可注入，浏览器默认用 localStorage，测试用内存对象。

import { evaluateAll, orderDives, STATUS } from './rules.js';

const STORE_KEY = 'uwArchDiveStation.v1';

export function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: k => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: k => map.delete(k),
    __dump: () => Object.fromEntries(map),
  };
}

// 浏览器 localStorage 与内存存储的统一封装
export function createStore(storage) {
  if (!storage) {
    if (typeof localStorage === 'undefined') throw new Error('需要可注入的 storage');
    storage = localStorage;
  }

  function load() {
    try {
      const raw = storage.getItem(STORE_KEY);
      if (!raw) return { dives: [], archives: [], idempotency: {} };
      const state = JSON.parse(raw);
      return {
        dives: Array.isArray(state.dives) ? state.dives : [],
        archives: Array.isArray(state.archives) ? state.archives : [],
        idempotency: state.idempotency && typeof state.idempotency === 'object' ? state.idempotency : {},
      };
    } catch {
      return { dives: [], archives: [], idempotency: {} };
    }
  }

  let state = load();

  function persist() {
    storage.setItem(STORE_KEY, JSON.stringify(state));
  }

  function snapshot() {
    return JSON.parse(JSON.stringify({
      dives: state.dives,
      archives: state.archives,
      idempotency: state.idempotency,
    }));
  }

  // 同 key 的重复或并发提交沿用首次结果；key 缺省时由内容生成（刷新页面/重连也去重）
  function idemKey(input) {
    if (input.token) return 'token:' + input.token;
    return 'auto:' + JSON.stringify({
      op: input.op, diveId: input.diveId || null,
      data: input.data || input.exitAt || null,
    });
  }

  function replayFirst(key) {
    const first = state.idempotency[key];
    if (!first) return null;
    // 展开在前：duplicate 标记必须覆盖首次结果中的 false
    return { ...JSON.parse(JSON.stringify(first.result)), duplicate: true };
  }

  function remember(key, result) {
    // 幂等登记随状态持久化：队列刷新后一致
    state.idempotency[key] = { result: JSON.parse(JSON.stringify(result)) };
  }

  function nextSeq() {
    return state.dives.reduce((max, d) => Math.max(max, d.seq || 0), 0) + 1;
  }

  function validateDive(data) {
    const depth = Number(data.depth);
    const minutes = Number(data.minutes);
    if (!Number.isFinite(depth) || depth <= 0) throw new Error('深度必须为正数（米）');
    if (!Number.isFinite(minutes) || minutes <= 0) throw new Error('时长必须为正数（分钟）');
    if (!data.entryAt) throw new Error('必须登记计划下水时刻');
    if (data.exitAt && Date.parse(data.exitAt) < Date.parse(data.entryAt)) {
      throw new Error('出水时刻不得早于下水时刻');
    }
    return { depth, minutes };
  }

  // 全量重算并产出关联标记；每次写操作后调用，修订后后续放行自动按新值刷新
  function recalc() {
    const decisions = evaluateAll(state.dives);
    const byId = new Map(decisions.map(d => [d.diveId, d]));
    state.dives = orderDives(state.dives.map(d => {
      const dec = byId.get(d.id);
      return { ...d, releaseStatus: dec ? dec.status : STATUS.INVALID };
    }));
    return decisions;
  }

  // —— 提交新潜次 ——
  function submitDive(input = {}) {
    const key = idemKey({ op: 'submit', token: input.token, data: input.data });
    const first = replayFirst(key);
    if (first) return first;

    const data = input.data || {};
    validateDive(data);
    const id = (crypto?.randomUUID?.() || `dive-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const dive = {
      id,
      seq: Number(data.seq) || nextSeq(),
      depth: Number(data.depth),
      minutes: Number(data.minutes),
      entryAt: data.entryAt,
      exitAt: data.exitAt || null,
      note: data.note || '',
      version: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    state.dives.push(dive);
    const decisions = recalc();
    const result = { ok: true, duplicate: false, dive, decision: decisions.find(d => d.diveId === id) };
    remember(key, result);
    persist();
    return result;
  }

  function archive(dive, changes) {
    state.archives.push({
      id: `${dive.id}__v${dive.version}`,
      diveId: dive.id,
      seq: dive.seq,
      version: dive.version,
      depth: dive.depth,
      minutes: dive.minutes,
      entryAt: dive.entryAt,
      exitAt: dive.exitAt,
      note: dive.note,
      supersededAt: new Date().toISOString(),
      reason: changes.reason || '修订留档',
    });
  }

  // —— 修订潜次：旧版留档（不进入导出），后续放行与关联标记按新值重算 ——
  function reviseDive(input = {}) {
    const key = idemKey({ op: 'revise', token: input.token, diveId: input.diveId, data: input.data });
    const first = replayFirst(key);
    if (first) return first;

    const dive = state.dives.find(d => d.id === input.diveId);
    if (!dive) throw new Error('潜次不存在：' + input.diveId);
    const data = input.data || {};
    const merged = {
      depth: data.depth !== undefined ? Number(data.depth) : dive.depth,
      minutes: data.minutes !== undefined ? Number(data.minutes) : dive.minutes,
      entryAt: data.entryAt !== undefined ? data.entryAt : dive.entryAt,
      exitAt: data.exitAt !== undefined ? (data.exitAt || null) : dive.exitAt,
      note: data.note !== undefined ? data.note : dive.note,
    };
    validateDive(merged);

    archive(dive, { reason: data.reason });
    Object.assign(dive, merged, {
      seq: Number(data.seq) || dive.seq,
      version: dive.version + 1,
      updatedAt: new Date().toISOString(),
    });
    const decisions = recalc();
    const result = {
      ok: true, duplicate: false, dive,
      decision: decisions.find(d => d.diveId === dive.id),
      recalculated: decisions,
    };
    remember(key, result);
    persist();
    return result;
  }

  // —— 登记出水时刻（同样是幂等写操作，可能解锁后一潜） ——
  function registerExit(input = {}) {
    const key = idemKey({ op: 'exit', token: input.token, diveId: input.diveId, exitAt: input.exitAt });
    const first = replayFirst(key);
    if (first) return first;

    const dive = state.dives.find(d => d.id === input.diveId);
    if (!dive) throw new Error('潜次不存在：' + input.diveId);
    if (!input.exitAt) throw new Error('必须填写出水时刻');
    if (Date.parse(input.exitAt) < Date.parse(dive.entryAt)) {
      throw new Error('出水时刻不得早于下水时刻');
    }
    archive(dive, { reason: '补登出水时刻' });
    dive.exitAt = input.exitAt;
    dive.version += 1;
    dive.updatedAt = new Date().toISOString();
    const decisions = recalc();
    const result = {
      ok: true, duplicate: false, dive,
      decision: decisions.find(d => d.diveId === dive.id),
      recalculated: decisions,
    };
    remember(key, result);
    persist();
    return result;
  }

  function getDecisions() {
    return evaluateAll(state.dives);
  }

  // 导出只含现行版本；旧版留档与幂等登记一律不进入导出
  function exportJSON() {
    return JSON.stringify({
      exportedAt: new Date().toISOString(),
      dives: orderDives(state.dives).map(d => ({ ...d, releaseStatus: undefined })),
      decisions: evaluateAll(state.dives),
    }, null, 2);
  }

  function exportCSV() {
    const header = ['序号', '深度m', '时长min', '下水时刻', '出水时刻', '水面间隔min', '可下水余量min', '放行状态', '关联前潜', '备注'];
    const decisions = new Map(evaluateAll(state.dives).map(d => [d.diveId, d]));
    const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const rows = orderDives(state.dives).map(d => {
      const dec = decisions.get(d.id);
      return [
        d.seq, d.depth, d.minutes, d.entryAt, d.exitAt || '',
        dec?.surfaceGapMinutes ?? '', dec?.marginMinutes ?? '',
        dec?.status ?? '', dec?.prevSeq ?? '', d.note || '',
      ].map(esc).join(',');
    });
    return '\uFEFF' + [header.map(esc).join(','), ...rows].join('\n');
  }

  return {
    submitDive, reviseDive, registerExit, getDecisions,
    exportJSON, exportCSV, snapshot,
    _dives: () => state.dives,
    _archives: () => state.archives,
  };
}
