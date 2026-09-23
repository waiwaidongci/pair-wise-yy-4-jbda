// 业务文件三：页面
// 放行台界面：放行队列、潜次时间线、留档审计、录入/修订表单。
// 依赖 rules.js 与 records.js；只负责渲染与交互，规则与持久化都在另外两个文件。

import { STATUS, STATUS_LABEL, RULES, evaluateAll, orderDives } from './rules.js';
import { createStore } from './records.js';

const REASON_LABEL = {
  FIRST_DIVE: '首潜，按基线余量放行',
  PREV_EXIT_MISSING: '前一潜未登记出水时刻，只留待复核，不进入时间线',
  SURFACE_GAP_SHORT: `水面间隔不足 ${RULES.MIN_SURFACE_GAP_MIN} 分钟，不得开始后一潜`,
  SURFACE_GAP_OK: '水面间隔满足要求',
  MARGIN_DISCOUNTED: `连续潜次，可下水余量按前一潜深度与时长折减 ${RULES.CONSECUTIVE_DISCOUNT_RATE * 100}%`,
  DATA_INVALID: '记录数据不合法',
};

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

function fmtTime(v) {
  if (!v) return '—';
  const t = new Date(v);
  return Number.isNaN(t.getTime()) ? '—'
    : `${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')} ${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
}

function download(name, content, type) {
  const blob = new Blob([content], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

export function mountApp(root, { store = createStore() } = {}) {
  root.innerHTML = `
    <header class="hd">
      <div>
        <h1>水下考古连续潜次放行台</h1>
        <div class="muted">间隔不足 ${RULES.MIN_SURFACE_GAP_MIN} 分钟禁止后一潜下水；连续潜次余量按前潜深度与时长折减 ${RULES.CONSECUTIVE_DISCOUNT_RATE * 100}%；前潜未出水登记的潜次仅待复核，不进时间线。</div>
      </div>
      <div class="hd-actions">
        <button id="refreshBtn" class="secondary" type="button">刷新队列</button>
        <button id="exportJsonBtn" type="button">导出JSON</button>
        <button id="exportCsvBtn" class="secondary" type="button">导出CSV</button>
      </div>
    </header>
    <main class="grid">
      <section class="panel" id="queuePanel">
        <div class="panel-h"><h2>放行队列</h2><span id="queueCount" class="pill"></span></div>
        <div id="queue" class="cards"></div>
      </section>
      <section class="panel" id="formPanel">
        <div class="panel-h"><h2 id="formTitle">申报潜次</h2><button id="resetFormBtn" class="link" type="button">＋新增</button></div>
        <form id="diveForm">
          <input type="hidden" name="diveId">
          <input type="hidden" name="token">
          <div class="row2">
            <div><label>序号</label><input name="seq" type="number" min="1" step="1" placeholder="自动"></div>
            <div><label>计划深度（米）</label><input name="depth" type="number" min="0.1" step="0.1" required></div>
          </div>
          <div class="row2">
            <div><label>计划时长（分钟）</label><input name="minutes" type="number" min="1" step="1" required></div>
            <div><label>计划下水时刻</label><input name="entryAt" type="datetime-local" required></div>
          </div>
          <label>出水时刻（可先空，后续补登）</label>
          <input name="exitAt" type="datetime-local">
          <label>备注</label>
          <textarea name="note" placeholder="气源、海况、任务目标等"></textarea>
          <div class="form-actions">
            <button type="submit" id="submitBtn">提交申报</button>
            <span id="formHint" class="muted"></span>
          </div>
          <div id="formError" class="error" hidden></div>
        </form>
        <div id="exitBox" class="exitbox" hidden>
          <h3>为 <b id="exitDiveSeq"></b> 补登出水时刻</h3>
          <form id="exitForm">
            <input type="hidden" name="diveId">
            <input type="hidden" name="token">
            <input name="exitAt" type="datetime-local" required>
            <button type="submit">登记并重算</button>
          </form>
        </div>
      </section>
      <section class="panel" id="timelinePanel">
        <div class="panel-h"><h2>潜次时间线</h2><span class="muted">仅已放行潜次</span></div>
        <div id="timeline" class="timeline"></div>
      </section>
      <section class="panel" id="archivePanel">
        <div class="panel-h"><h2>修订留档</h2><span id="archiveCount" class="pill"></span></div>
        <div id="archives" class="archives"></div>
      </section>
    </main>`;

  const $ = sel => root.querySelector(sel);
  const form = $('#diveForm');
  const exitForm = $('#exitForm');

  function showError(msg) {
    const box = $('#formError');
    if (!msg) { box.hidden = true; box.textContent = ''; return; }
    box.hidden = false;
    box.textContent = msg;
  }

  function card(dive, dec) {
    const reasons = dec.reasons.map(r => `<li>${esc(REASON_LABEL[r] || r)}</li>`).join('');
    const gapText = dec.surfaceGapMinutes === null ? '—' : `${dec.surfaceGapMinutes} 分钟`;
    const marginText = dec.discounted
      ? `${dec.baseMarginMinutes} → <b>${dec.marginMinutes}</b> 分钟（折减）`
      : `<b>${dec.marginMinutes}</b> 分钟`;
    const blockedExit = !dive.exitAt && dec.prevDiveId; // 自身缺出水：后续潜次会因此待复核
    return `
    <article class="card st-${esc(dec.status.toLowerCase())}">
      <header>
        <div class="card-title"><span class="seq">DIVE-${String(dive.seq).padStart(2, '0')}</span>
          <span class="badge ${esc(dec.status.toLowerCase())}">${esc(STATUS_LABEL[dec.status])}</span></div>
        <div class="muted">${esc(fmtTime(dive.entryAt))} 下水 · ${esc(fmtTime(dive.exitAt))} 出水</div>
      </header>
      <dl class="kv">
        <div><dt>深度 / 时长</dt><dd>${esc(dive.depth)} m · ${esc(dive.minutes)} min</dd></div>
        <div><dt>与前潜水面间隔</dt><dd>${gapText}（前潜 DIVE-${dec.prevSeq ? String(dec.prevSeq).padStart(2, '0') : '—'}）</dd></div>
        <div><dt>可下水余量</dt><dd>${marginText}</dd></div>
      </dl>
      <ul class="reasons">${reasons}</ul>
      ${dive.note ? `<div class="muted note">备注：${esc(dive.note)}</div>` : ''}
      ${blockedExit ? '<div class="muted note">⚠ 本潜尚未登记出水时刻，后一潜将只留待复核</div>' : ''}
      <footer class="card-actions">
        <button type="button" class="link" data-act="edit" data-id="${esc(dive.id)}">修订</button>
        ${dive.exitAt ? '' : `<button type="button" class="link" data-act="exit" data-id="${esc(dive.id)}">登记出水</button>`}
        <span class="muted">v${esc(dive.version)}</span>
      </footer>
    </article>`;
  }

  function renderQueue() {
    const decisions = store.getDecisions();
    const byId = new Map(decisions.map(d => [d.diveId, d]));
    const dives = orderDives(store._dives());
    $('#queue').innerHTML = dives.map(d => card(d, byId.get(d.id))).join('')
      || '<div class="muted empty">尚无潜次申报。在右侧录入第一潜。</div>';
    const counts = decisions.reduce((m, d) => (m[d.status] = (m[d.status] || 0) + 1, m), {});
    $('#queueCount').textContent =
      `共 ${dives.length} 潜 · 放行 ${counts[STATUS.CLEARED] || 0} · 待复核 ${counts[STATUS.PENDING_REVIEW] || 0} · 禁潜 ${counts[STATUS.BLOCKED] || 0}`;
  }

  function renderTimeline() {
    // 与规则同源：待复核 / 禁止下水的潜次不会渲染
    const cleared = evaluateAll(store._dives()).filter(d => d.status === STATUS.CLEARED);
    const dives = new Map(store._dives().map(d => [d.id, d]));
    if (!cleared.length) {
      $('#timeline').innerHTML = '<div class="muted empty">时间线为空（首潜放行前不显示）。</div>';
      return;
    }
    $('#timeline').innerHTML = cleared.map((d) => {
      const dive = dives.get(d.diveId);
      return `
      <div class="tl-item">
        <div class="tl-dot st-${esc(d.status.toLowerCase())}">${String(dive.seq).padStart(2, '0')}</div>
        <div class="tl-body">
          <b>DIVE-${String(dive.seq).padStart(2, '0')}</b>
          <span class="muted">${esc(fmtTime(dive.entryAt))} → ${esc(fmtTime(dive.exitAt))}</span>
          <div class="muted">${esc(dive.depth)} m · ${esc(dive.minutes)} min · 余量 ${d.marginMinutes} min${d.prevSeq ? ` · 距 DIVE-${String(d.prevSeq).padStart(2, '0')} 出水 ${d.surfaceGapMinutes} min` : ''}</div>
        </div>
      </div>`;
    }).join('');
  }

  function renderArchives() {
    const archives = store._archives();
    $('#archiveCount').textContent = `${archives.length} 份旧版（不进入导出）`;
    $('#archives').innerHTML = archives.slice().reverse().map(a => `
      <details class="arc">
        <summary>DIVE-${String(a.seq).padStart(2, '0')} · v${a.version} 旧版 · ${esc(fmtTime(a.supersededAt))} 被取代</summary>
        <div class="muted">${esc(a.reason)}</div>
        <div class="muted">深度 ${esc(a.depth)}m · 时长 ${esc(a.minutes)}min · 下水 ${esc(fmtTime(a.entryAt))} · 出水 ${esc(fmtTime(a.exitAt))}</div>
      </details>`).join('') || '<div class="muted empty">暂无修订。</div>';
  }

  function renderAll() {
    renderQueue();
    renderTimeline();
    renderArchives();
  }

  function resetForm() {
    form.reset();
    form.diveId.value = '';
    $('#formTitle').textContent = '申报潜次';
    $('#submitBtn').textContent = '提交申报';
    $('#formHint').textContent = '';
    $('#exitBox').hidden = true;
    showError('');
  }

  function editDive(id) {
    const dive = store._dives().find(d => d.id === id);
    if (!dive) return;
    form.diveId.value = dive.id;
    form.seq.value = dive.seq;
    form.depth.value = dive.depth;
    form.minutes.value = dive.minutes;
    form.entryAt.value = dive.entryAt;
    form.exitAt.value = dive.exitAt || '';
    form.note.value = dive.note || '';
    $('#formTitle').textContent = `修订 DIVE-${String(dive.seq).padStart(2, '0')}（当前 v${dive.version}）`;
    $('#submitBtn').textContent = '保存修订并重算';
    $('#formHint').textContent = '保存后旧版留档，后续潜次放行按新值重算。';
    $('#formPanel').scrollIntoView({ behavior: 'smooth' });
  }

  function openExit(id) {
    const dive = store._dives().find(d => d.id === id);
    if (!dive) return;
    $('#exitBox').hidden = false;
    $('#exitDiveSeq').textContent = `DIVE-${String(dive.seq).padStart(2, '0')}`;
    exitForm.diveId.value = id;
    exitForm.exitAt.value = dive.exitAt || '';
    $('#exitBox').scrollIntoView({ behavior: 'smooth' });
  }

  $('#queue').addEventListener('click', e => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    if (btn.dataset.act === 'edit') editDive(btn.dataset.id);
    if (btn.dataset.act === 'exit') openExit(btn.dataset.id);
  });

  $('#resetFormBtn').onclick = resetForm;

  form.onsubmit = e => {
    e.preventDefault();
    showError('');
    // 每次 UI 提交生成幂等令牌：双击、重试、并发都沿用首次结果
    const token = form.token.value || crypto.randomUUID();
    form.token.value = token;
    const fd = new FormData(form);
    const data = {
      seq: fd.get('seq') ? Number(fd.get('seq')) : undefined,
      depth: Number(fd.get('depth')),
      minutes: Number(fd.get('minutes')),
      entryAt: fd.get('entryAt'),
      exitAt: fd.get('exitAt') || null,
      note: fd.get('note'),
    };
    try {
      const r = form.diveId.value
        ? store.reviseDive({ diveId: form.diveId.value, data: { ...data, reason: '页面修订' }, token })
        : store.submitDive({ data, token });
      if (r.duplicate) showError('重复提交：沿用首次受理结果。');
      resetForm();
      renderAll();
    } catch (err) {
      showError(err.message);
    }
  };

  exitForm.onsubmit = e => {
    e.preventDefault();
    const token = exitForm.token.value || crypto.randomUUID();
    exitForm.token.value = token;
    try {
      const r = store.registerExit({
        diveId: exitForm.diveId.value,
        exitAt: exitForm.exitAt.value,
        token,
      });
      if (r.duplicate) showError('重复提交：沿用首次受理结果。');
      $('#exitBox').hidden = true;
      exitForm.reset();
      renderAll();
    } catch (err) {
      showError(err.message);
    }
  };

  $('#refreshBtn').onclick = () => {
    // 放行判定全部由规则即时重算：刷新后队列一致
    renderAll();
  };

  $('#exportJsonBtn').onclick = () =>
    download('dive-release.json', store.exportJSON(), 'application/json');
  $('#exportCsvBtn').onclick = () =>
    download('dive-release.csv', store.exportCSV(), 'text/csv;charset=utf-8');

  renderAll();
  return { renderAll, store };
}
