// 业务文件一：规则
// 连续潜次放行判定，纯函数、无存储、无 DOM，可直接在 Node 中单测。
// 数据形态（潜水记录由 records.js 维护）：
// { id, seq, depth, minutes, entryAt, exitAt, note, version, ... }
// 时刻统一使用 "YYYY-MM-DDTHH:mm" 本地时间字符串，比较用 Date.parse。

export const RULES = Object.freeze({
  // 相邻潜次最小水面间隔（分钟），不足则后一潜不得开始
  MIN_SURFACE_GAP_MIN: 60,
  // 连续潜水的可下水余量，在前一潜深度与时长基础上固定折减三成
  CONSECUTIVE_DISCOUNT_RATE: 0.3,
  // 可下水余量基线表（分钟）：按本潜计划深度向下取档查表
  BASE_MARGIN_TABLE: Object.freeze([
    { maxDepth: 12, minutes: 120 },
    { maxDepth: 18, minutes: 80 },
    { maxDepth: 24, minutes: 50 },
    { maxDepth: 30, minutes: 30 },
    { maxDepth: 36, minutes: 15 },
  ]),
  BEYOND_TABLE_MARGIN_MIN: 0,
});

export const STATUS = Object.freeze({
  CLEARED: 'CLEARED',                 // 准予放行
  BLOCKED: 'BLOCKED',                 // 间隔不足，不得下水
  PENDING_REVIEW: 'PENDING_REVIEW',   // 前潜未登记出水时刻，留待复核
  INVALID: 'INVALID',                 // 记录数据本身不合法
});

export const REASON = Object.freeze({
  FIRST_DIVE: 'FIRST_DIVE',
  PREV_EXIT_MISSING: 'PREV_EXIT_MISSING',
  SURFACE_GAP_SHORT: 'SURFACE_GAP_SHORT',
  SURFACE_GAP_OK: 'SURFACE_GAP_OK',
  MARGIN_DISCOUNTED: 'MARGIN_DISCOUNTED',
  DATA_INVALID: 'DATA_INVALID',
});

export const STATUS_LABEL = Object.freeze({
  CLEARED: '准予放行',
  BLOCKED: '间隔不足·禁止下水',
  PENDING_REVIEW: '待复核',
  INVALID: '数据异常',
});

// 深度 -> 基线可下水余量（分钟）
export function baseMarginMinutes(depth) {
  for (const row of RULES.BASE_MARGIN_TABLE) {
    if (depth <= row.maxDepth) return row.minutes;
  }
  return RULES.BEYOND_TABLE_MARGIN_MIN;
}

// 连续潜次余量：基线折减三成（前一潜深度/时长为折减依据，随判定结果一并留痕）
export function consecutiveMarginMinutes(depth) {
  return Math.round(baseMarginMinutes(depth) * (1 - RULES.CONSECUTIVE_DISCOUNT_RATE));
}

export function toMinutes(ms) {
  return Math.round(ms / 60000);
}

export function parseTime(value) {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

// 潜次排序：先按下水时刻，时刻缺失再按序号；重算后邻居关系随之刷新
export function orderDives(dives) {
  return [...dives].sort((a, b) => {
    const ta = parseTime(a.entryAt);
    const tb = parseTime(b.entryAt);
    if (ta !== null && tb !== null && ta !== tb) return ta - tb;
    if (ta !== null && tb === null) return -1;
    if (ta === null && tb !== null) return 1;
    return a.seq - b.seq;
  });
}

function invalidDive(dive) {
  if (!Number.isFinite(dive.seq) || dive.seq <= 0 ||
      !Number.isFinite(dive.depth) || dive.depth <= 0 ||
      !Number.isFinite(dive.minutes) || dive.minutes <= 0 ||
      parseTime(dive.entryAt) === null) {
    return true;
  }
  if (dive.exitAt) {
    const e = parseTime(dive.exitAt);
    if (e === null || e < parseTime(dive.entryAt)) return true;
  }
  return false;
}

// 判定单个潜次；prev 为排序后的前一潜（首潜为 null）
export function evaluateDive(dive, prev) {
  const base = {
    diveId: dive.id,
    seq: dive.seq,
    prevDiveId: prev ? prev.id : null,
    prevSeq: prev ? prev.seq : null,
    // 前一潜深度与时长：连续潜次折减的依据
    prevDepth: prev ? prev.depth : null,
    prevMinutes: prev ? prev.minutes : null,
    surfaceGapMinutes: null,
    baseMarginMinutes: baseMarginMinutes(dive.depth),
    marginMinutes: baseMarginMinutes(dive.depth),
    discounted: false,
    reasons: [],
  };

  if (invalidDive(dive)) {
    return { ...base, status: STATUS.INVALID, reasons: [REASON.DATA_INVALID] };
  }

  if (!prev) {
    return { ...base, status: STATUS.CLEARED, reasons: [REASON.FIRST_DIVE] };
  }

  const margin = consecutiveMarginMinutes(dive.depth);
  const discounted = {
    marginMinutes: margin,
    discounted: true,
    reasons: [REASON.MARGIN_DISCOUNTED],
  };

  // 前一潜未登记出水时刻：只留待复核，不能进入时间线
  const prevExit = parseTime(prev.exitAt);
  if (prevExit === null) {
    return {
      ...base, ...discounted,
      status: STATUS.PENDING_REVIEW,
      reasons: [REASON.PREV_EXIT_MISSING, ...discounted.reasons],
    };
  }

  const gap = toMinutes(parseTime(dive.entryAt) - prevExit);
  const withGap = { ...base, ...discounted, surfaceGapMinutes: gap };

  if (gap < RULES.MIN_SURFACE_GAP_MIN) {
    return {
      ...withGap,
      status: STATUS.BLOCKED,
      reasons: [REASON.SURFACE_GAP_SHORT, REASON.MARGIN_DISCOUNTED],
    };
  }

  return {
    ...withGap,
    status: STATUS.CLEARED,
    reasons: [REASON.SURFACE_GAP_OK, REASON.MARGIN_DISCOUNTED],
  };
}

// 全量重算：任一潜次修订后调用，后续放行与关联标记全部按新值刷新
export function evaluateAll(dives) {
  const ordered = orderDives(dives);
  return ordered.map((dive, i) => evaluateDive(dive, i === 0 ? null : ordered[i - 1]));
}

// 时间线：只有已放行潜次可进入；待复核与禁止下水均不出现
export function buildTimeline(dives) {
  return evaluateAll(dives).filter(d => d.status === STATUS.CLEARED);
}
