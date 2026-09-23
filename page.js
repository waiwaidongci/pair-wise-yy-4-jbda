/*
 * 页面层：放行台的全部界面逻辑。
 * 只做渲染与表单交互；判定走 Rules，数据走 Records，本层不自行计算放行结论。
 */
"use strict";

(() => {
  const diveForm = document.querySelector("#diveForm");
  const markForm = document.querySelector("#markForm");
  const queueEl = document.querySelector("#queue");
  const timelineEl = document.querySelector("#timeline");
  const marksEl = document.querySelector("#marks");
  const flashEl = document.querySelector("#flash");
  const archiveNote = document.querySelector("#archiveNote");
  const diveFormTitle = document.querySelector("#diveFormTitle");
  const diveSubmit = document.querySelector("#diveSubmit");

  const TYPE_TEXT = { ceramic: "陶片", wood: "木构件", metal: "金属件", unknown: "未知物" };
  const MARK_STATE_TEXT = { active: "在时间线", held: "挂起", unlinked: "潜次缺失" };

  const esc = s => String(s ?? "").replace(/[&<>"']/g,
    c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmt = iso => (iso ? iso.replace("T", " ").slice(5, 16) : "—");

  function flash(text) {
    flashEl.textContent = text;
    clearTimeout(flash._t);
    flash._t = setTimeout(() => (flashEl.textContent = ""), 4000);
  }

  /* ---------------- 渲染 ---------------- */

  function render() {
    const dives = Records.listDives();
    const queue = Records.queue();
    const byId = Object.fromEntries(dives.map(d => [d.id, d]));
    renderQueue(queue, byId);
    renderTimeline(queue, byId);
    renderDiveOptions(dives);
    renderMarks(byId);
    archiveNote.textContent = `留档旧版 ${Records.archiveCount()} 份（不进入导出）`;
  }

  function renderQueue(queue, byId) {
    queueEl.innerHTML = queue.map(q => {
      const d = byId[q.diveId] || {};
      const facts = [
        `入水 ${fmt(d.entry)}`, `出水 ${fmt(d.exit)}`,
        `深度 ${d.depth ?? "—"}m`, `计划 ${d.planMinutes ?? "—"}min`
      ].join(" · ");
      const verdict = [
        q.interval != null ? `间隔 ${q.interval}min` : "间隔 —",
        q.margin != null ? `余量 ${q.margin}min` : "余量 —",
        q.reason || ""
      ].filter(Boolean).join(" · ");
      return `<div class="item ${q.status}" data-id="${esc(q.diveId)}" title="点击载入修订">
        <b>${esc(q.code)}</b> <span class="pill ${q.status}">${Rules.STATUS_TEXT[q.status]}</span>
        <span class="muted">v${q.version}</span>
        <div class="muted">${esc(facts)}</div>
        <div class="verdict">${esc(verdict)}</div>
      </div>`;
    }).join("");
    queueEl.querySelectorAll("[data-id]").forEach(el =>
      (el.onclick = () => loadForRevise(el.dataset.id)));
  }

  function renderTimeline(queue, byId) {
    const marks = Records.marks();
    const released = queue.filter(q => q.status === Rules.STATUS.RELEASED);
    const heldCount = queue.length - released.length;
    document.querySelector("#timelineNote").textContent =
      heldCount ? `（${heldCount} 个潜次待复核/禁止，未进入时间线）` : "";
    timelineEl.innerHTML = released.length ? released.map(q => {
      const d = byId[q.diveId] || {};
      const own = marks.filter(m => m.diveId === q.diveId);
      return `<div class="item">
        <b>${esc(q.code)}</b> <span class="muted">${fmt(d.entry)} → ${fmt(d.exit)} · 深度 ${d.depth ?? "—"}m · 余量 ${q.margin ?? "—"}min</span>
        ${own.map(m => `<div>· ${esc(m.code)} ${esc(TYPE_TEXT[m.type] || m.type)}${m.note ? " — " + esc(m.note) : ""}</div>`).join("")}
      </div>`;
    }).join("") : '<div class="muted">暂无放行潜次。</div>';
  }

  function renderDiveOptions(dives) {
    const select = markForm.diveId;
    const keep = select.value;
    select.innerHTML = dives
      .map(d => `<option value="${esc(d.id)}">${esc(d.code)}（v${d.version}）</option>`).join("");
    if (dives.some(d => d.id === keep)) select.value = keep;
  }

  function renderMarks(byId) {
    marksEl.innerHTML = Records.marks().map(m => {
      const dive = byId[m.diveId];
      return `<div class="item">
        <b>${esc(m.code)}</b> <span class="pill">${esc(TYPE_TEXT[m.type] || m.type)}</span>
        <span class="pill ${m.state}">${MARK_STATE_TEXT[m.state]}</span>
        <div class="muted">${dive ? esc(dive.code) + "（v" + dive.version + "）" : "潜次缺失"}${m.note ? " · " + esc(m.note) : ""}</div>
      </div>`;
    }).join("");
  }

  /* ---------------- 潜次表单：登记 / 修订 ---------------- */

  function resetDiveForm() {
    diveForm.reset();
    diveForm.id.value = "";
    diveFormTitle.textContent = "登记潜次";
    diveSubmit.textContent = "提交登记";
  }

  function loadForRevise(id) {
    const dive = Records.listDives().find(d => d.id === id);
    if (!dive) return;
    diveForm.id.value = dive.id;
    diveForm.code.value = dive.code;
    diveForm.entry.value = dive.entry || "";
    diveForm.exit.value = dive.exit || "";
    diveForm.depth.value = dive.depth ?? "";
    diveForm.planMinutes.value = dive.planMinutes ?? "";
    diveFormTitle.textContent = `修订潜次 ${dive.code}（当前 v${dive.version}）`;
    diveSubmit.textContent = "提交修订";
  }

  diveForm.onsubmit = event => {
    event.preventDefault();
    if (diveSubmit.disabled) return; // 并发/重复点击守卫
    diveSubmit.disabled = true;
    try {
      const data = Object.fromEntries(new FormData(diveForm).entries());
      const revising = Boolean(data.id);
      const result = Records.submitDive(data);
      if (result.reused) {
        flash("重复或并发提交，已沿用首次结果。");
      } else {
        flash(revising
          ? `${result.dive.code} 已修订为 v${result.dive.version}，后续放行与关联标记已按新值重算。`
          : `${result.dive.code} 已登记（v1），放行队列已重算。`);
      }
      resetDiveForm();
      render();
    } finally {
      diveSubmit.disabled = false;
    }
  };

  document.querySelector("#newDiveBtn").onclick = resetDiveForm;

  /* ---------------- 标记表单 ---------------- */

  markForm.onsubmit = event => {
    event.preventDefault();
    const btn = markForm.querySelector("button[type=submit]");
    if (btn.disabled) return;
    btn.disabled = true;
    try {
      const data = Object.fromEntries(new FormData(markForm).entries());
      const result = Records.submitMark(data);
      flash(result.reused ? "重复或并发提交，已沿用首次结果。" : `标记 ${result.mark.code} 已关联。`);
      markForm.reset();
      render();
    } finally {
      btn.disabled = false;
    }
  };

  /* ---------------- 导出（留档旧版不进入导出） ---------------- */

  document.querySelector("#exportBtn").onclick = () => {
    const blob = new Blob([JSON.stringify(Records.exportData(), null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "release-queue.json";
    a.click();
    URL.revokeObjectURL(a.href);
  };

  render();
})();
