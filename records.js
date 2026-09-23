/*
 * 记录层：潜次与关联标记的登记、修订、留档、幂等提交、持久化与导出。
 * 不做任何判定，放行结论一律调用 Rules 重算；不操作页面。
 *
 * 关键约定：
 *  - 修订潜次：当前版本整体进入 archive 留档，新版本号 +1，随后整队列重算；
 *    留档旧版只保存在本机，不进入导出。
 *  - 提交按内容生成幂等键：重复或并发提交沿用首次结果，不会二次登记/二次修订。
 *  - 每次加载都按当前版本重算队列，放行队列刷新后一致。
 */
"use strict";

const Records = (() => {
  const STORE_KEY = "uwArchRelease.v1";

  /* ---------------- 持久化 ---------------- */

  function load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }
  const save = () => localStorage.setItem(STORE_KEY, JSON.stringify(state));

  function seed() {
    const dives = [
      { id: "d-seed-01", seq: 1, version: 1, code: "DIVE-01",
        entry: "2026-09-22T08:00", exit: "2026-09-22T08:50", depth: 17.8, planMinutes: 50 },
      { id: "d-seed-02", seq: 2, version: 1, code: "DIVE-02",
        entry: "2026-09-22T10:10", exit: "2026-09-22T11:00", depth: 18.2, planMinutes: 50 },
      { id: "d-seed-03", seq: 3, version: 1, code: "DIVE-03",
        entry: "2026-09-22T11:20", exit: "", depth: 19.4, planMinutes: 45 },
      { id: "d-seed-04", seq: 4, version: 1, code: "DIVE-04",
        entry: "2026-09-22T13:00", exit: "", depth: 18.6, planMinutes: 40 }
    ];
    const marks = [
      { id: "m-seed-01", code: "A-017", type: "ceramic", diveId: "d-seed-01", note: "靠近船肋" },
      { id: "m-seed-02", code: "W-003", type: "wood", diveId: "d-seed-02", note: "疑似横梁" },
      { id: "m-seed-03", code: "M-011", type: "metal", diveId: "d-seed-03", note: "所属潜次待复核，标记挂起" }
    ];
    return { dives, marks, archive: [], submissions: {}, nextSeq: 5 };
  }

  let state = load() || seed();
  // 刷新后以当前版本重算，保证放行队列与页面刷新前一致
  state.queue = Rules.recompute(state.dives);
  save();

  /* ---------------- 幂等提交 ---------------- */

  /** 提交键由提交内容决定：同内容的重复/并发提交命中同一键，沿用首次结果 */
  const submissionKey = (scope, payload) => scope + ":" + JSON.stringify(payload);

  function firstResult(scope, payload, apply) {
    const key = submissionKey(scope, payload);
    if (Object.prototype.hasOwnProperty.call(state.submissions, key)) {
      return { ...state.submissions[key], reused: true };
    }
    const result = apply();
    state.submissions[key] = result;
    save();
    return { ...result, reused: false };
  }

  const normalizeDive = input => ({
    code: String(input.code || "").trim(),
    entry: input.entry || "",
    exit: input.exit || "",
    depth: input.depth === "" || input.depth == null ? null : Number(input.depth),
    planMinutes: input.planMinutes === "" || input.planMinutes == null ? null : Number(input.planMinutes)
  });

  /* ---------------- 潜次登记 / 修订 ---------------- */

  function register(input) {
    const dive = { id: "d-" + state.nextSeq + "-" + Math.random().toString(36).slice(2, 8),
      seq: state.nextSeq++, version: 1, ...normalizeDive(input) };
    state.dives.push(dive);
    state.queue = Rules.recompute(state.dives);
    return { dive, queue: state.queue };
  }

  /** 修订：旧版留档（不进入导出），新版本 +1，后续放行与关联标记按新值重算 */
  function revise(input) {
    const idx = state.dives.findIndex(d => d.id === input.id);
    if (idx < 0) return register({ ...input, id: undefined });
    const current = state.dives[idx];
    state.archive.push({ ...current, archivedAt: new Date().toISOString(), reason: "revised" });
    const next = { ...current, ...normalizeDive(input), id: current.id, seq: current.seq,
      version: current.version + 1 };
    state.dives[idx] = next;
    state.queue = Rules.recompute(state.dives);
    return { dive: next, queue: state.queue };
  }

  const submitDive = input =>
    firstResult("dive", { id: input.id || null, ...normalizeDive(input) },
      () => (input.id ? revise(input) : register(input)));

  /* ---------------- 关联标记 ---------------- */

  const submitMark = input =>
    firstResult("mark", {
      code: String(input.code || "").trim(),
      type: input.type,
      diveId: input.diveId,
      note: input.note || ""
    }, () => {
      const mark = { id: "m-" + Math.random().toString(36).slice(2, 10),
        code: String(input.code || "").trim(), type: input.type,
        diveId: input.diveId, note: input.note || "" };
      state.marks.push(mark);
      return { mark };
    });

  /** 标记视图：状态由放行队列派生，潜次一修订即随新值重算 */
  function marks() {
    const byDive = Rules.queueIndex(state.queue);
    return state.marks.map(m => ({ ...m, state: Rules.markState(m, byDive) }));
  }

  /* ---------------- 查询与导出 ---------------- */

  const listDives = () => state.dives.map(d => ({ ...d }));
  const queue = () => state.queue.map(q => ({ ...q }));
  const archiveCount = () => state.archive.length;

  /** 导出：仅含潜次当前版本、重算后的放行队列与标记状态；留档旧版不进入导出 */
  function exportData() {
    const queueNow = Rules.recompute(state.dives);
    const byDive = Rules.queueIndex(queueNow);
    return {
      exportedAt: new Date().toISOString(),
      rules: {
        minIntervalMinutes: Rules.MIN_INTERVAL_MINUTES,
        discountRate: Rules.DISCOUNT_RATE,
        baseMarginMinutes: Rules.BASE_MARGIN_MINUTES
      },
      dives: state.dives.map(d => ({ ...d })),
      queue: queueNow,
      marks: state.marks.map(m => ({ ...m, state: Rules.markState(m, byDive) }))
    };
  }

  return { submitDive, submitMark, listDives, queue, marks, archiveCount, exportData };
})();

if (typeof module !== "undefined" && module.exports) module.exports = Records;
