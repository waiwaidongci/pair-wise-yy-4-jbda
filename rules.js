/*
 * 规则层：水下考古连续潜次放行规则。
 * 纯函数集合，不读写存储、不操作页面；修订任一潜次后整条队列由此重算。
 *
 * 业务规则：
 *  1. 相邻潜次间隔不足一小时，不得开始后一潜（后一潜直接禁止）。
 *  2. 可下水余量 = 基准余量 - 前一潜“深度 × 时长”负荷折减三成。
 *  3. 前一潜未登记出水时刻，后一潜只留待复核，不能进入时间线。
 */
"use strict";

const Rules = (() => {
  const MIN_INTERVAL_MINUTES = 60;   // 相邻潜次最小间隔：不足一小时
  const DISCOUNT_RATE = 0.3;        // 余量折减三成
  const BASE_MARGIN_MINUTES = 480;  // 基准可下水余量（分钟）

  const STATUS = {
    RELEASED: "released", // 放行：可进入时间线
    PENDING: "pending",   // 待复核：资料不全，只留待复核，不进入时间线
    BLOCKED: "blocked"    // 禁止：违反间隔或余量规则，不得开始
  };
  const STATUS_TEXT = { released: "放行", pending: "待复核", blocked: "禁止" };

  const toMinutes = iso => {
    if (!iso) return null;
    const t = new Date(iso).getTime();
    return Number.isFinite(t) ? t / 60000 : null;
  };

  /** 单潜次水下时长（出水 - 入水，分钟），任一时刻缺失则为 null */
  const durationOf = dive => {
    const start = toMinutes(dive.entry);
    const end = toMinutes(dive.exit);
    return start != null && end != null && end >= start ? end - start : null;
  };

  /**
   * 可下水余量：按前一潜深度与时长折减三成。
   * 负荷 = 深度（米）× 时长（分钟），折减 = 负荷 × 0.3，余量最低为 0。
   */
  function marginAfter(prev) {
    const duration = durationOf(prev);
    const depth = Number(prev && prev.depth);
    if (duration == null || !Number.isFinite(depth)) return null;
    return Math.max(0, Math.round(BASE_MARGIN_MINUTES - DISCOUNT_RATE * depth * duration));
  }

  /** 评估单个潜次；prev 为序列中的前一潜（当前版本），首潜传 null */
  function evaluate(dive, prev) {
    if (!dive.entry) {
      return { status: STATUS.PENDING, reason: "入水时刻未登记", interval: null, margin: null };
    }
    if (prev) {
      // 规则 3：前一潜未登记出水时刻 → 只留待复核，不能进入时间线
      if (!prev.exit) {
        return { status: STATUS.PENDING, reason: "前一潜未登记出水时刻", interval: null, margin: null };
      }
      const interval = Math.round(toMinutes(dive.entry) - toMinutes(prev.exit));
      const margin = marginAfter(prev);
      // 规则 1：间隔不足一小时，不得开始后一潜
      if (interval < MIN_INTERVAL_MINUTES) {
        return { status: STATUS.BLOCKED, reason: "相邻潜次间隔不足一小时", interval, margin };
      }
      // 规则 2：计划时长不得超过折减后的可下水余量
      const need = dive.planMinutes != null ? Number(dive.planMinutes) : durationOf(dive);
      if (need != null && margin != null && need > margin) {
        return { status: STATUS.BLOCKED, reason: "计划时长超出可下水余量", interval, margin };
      }
      return { status: STATUS.RELEASED, reason: "", interval, margin };
    }
    // 当日首潜：无前序负担，余量为基准余量
    return { status: STATUS.RELEASED, reason: "", interval: null, margin: BASE_MARGIN_MINUTES };
  }

  const byTime = (a, b) => {
    const ta = toMinutes(a.entry);
    const tb = toMinutes(b.entry);
    if (ta == null && tb == null) return a.seq - b.seq;
    if (ta == null) return 1;
    if (tb == null) return -1;
    return ta - tb || a.seq - b.seq;
  };

  /**
   * 按当前版本潜次重算整条放行队列。
   * 修订任一潜次后调用，后续放行结论即按新值全部重算。
   */
  function recompute(dives) {
    const ordered = [...dives].sort(byTime);
    const queue = [];
    let prev = null;
    for (const dive of ordered) {
      queue.push({ diveId: dive.id, code: dive.code, version: dive.version, ...evaluate(dive, prev) });
      prev = dive;
    }
    return queue;
  }

  /** 关联标记是否进入时间线：仅所属潜次当前为“放行”时进入，其余挂起 */
  function markState(mark, queueByDiveId) {
    const q = queueByDiveId[mark.diveId];
    if (!q) return "unlinked";
    return q.status === STATUS.RELEASED ? "active" : "held";
  }

  const queueIndex = queue => Object.fromEntries(queue.map(q => [q.diveId, q]));

  return {
    MIN_INTERVAL_MINUTES,
    DISCOUNT_RATE,
    BASE_MARGIN_MINUTES,
    STATUS,
    STATUS_TEXT,
    durationOf,
    marginAfter,
    evaluate,
    recompute,
    markState,
    queueIndex
  };
})();

if (typeof module !== "undefined" && module.exports) module.exports = Rules;
