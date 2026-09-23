// 页面层冒烟：最小 DOM 桩挂载 pages.js，验证渲染、提交、修订、刷新、导出不报错
import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
if (!globalThis.crypto) globalThis.crypto = webcrypto;
import { mountApp } from '../src/pages.js';
import { createStore, memoryStorage } from '../src/records.js';
import { STATUS_LABEL } from '../src/rules.js';

function makeEl(tag = 'div') {
  const el = {
    tag, children: [], style: {}, dataset: {}, hidden: false, value: '',
    textContent: '', innerHTML: '', type: '', name: '',
    _handlers: {},
    classList: { add() {}, remove() {}, toggle() {} },
    appendChild(c) { this.children.push(c); return c; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener(type, fn) { this._handlers[type] = fn; },
    set onsubmit(fn) { this._handlers.submit = fn; },
    get onsubmit() { return this._handlers.submit; },
    set onclick(fn) { this._handlers.click = fn; },
    get onclick() { return this._handlers.click; },
    scrollIntoView() {},
    click() { this._handlers.click?.({ preventDefault() {}, target: this }); },
    closest() { return null; },
    reset() { for (const k of Object.keys(this)) if (this[k] && typeof this[k] === 'object' && 'value' in this[k]) this[k].value = ''; },
  };
  return el;
}

// 表单：任意命名字段（form.diveId 等）自动返回一个表单控件
function formEl(tag) {
  const form = makeEl(tag);
  return new Proxy(form, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (typeof prop === 'string' && !['then'].includes(prop)) {
        const ctl = makeEl('input');
        ctl.name = prop;
        target[prop] = ctl;
        return ctl;
      }
      return undefined;
    },
  });
}

function mount() {
  const els = new Map();
  const formSelectors = new Set(['#diveForm', '#exitForm']);
  const get = sel => {
    if (!els.has(sel)) els.set(sel, formSelectors.has(sel) ? formEl('form') : makeEl());
    return els.get(sel);
  };
  const root = makeEl('div');
  root.querySelector = get;
  root.querySelectorAll = () => [];
  const store = createStore(memoryStorage());
  const app = mountApp(root, { store });
  return { els, store, app };
}

test('页面挂载：空数据渲染占位，队列计数正确', () => {
  const { els } = mount();
  assert.match(els.get('#queueCount').textContent, /共 0 潜/);
  assert.match(els.get('#queue').innerHTML, /尚无潜次/);
  assert.match(els.get('#timeline').innerHTML, /时间线为空/);
  assert.match(els.get('#archiveCount').textContent, /0 份旧版/);
});

test('队列卡片含放行/待复核状态；时间线排除待复核；刷新后一致；导出无留档', () => {
  const { els, store, app } = mount();
  store.submitDive({ data: { seq: 1, depth: 15, minutes: 30, entryAt: '2026-09-23T08:00', exitAt: null } });
  store.submitDive({ data: { seq: 2, depth: 18, minutes: 25, entryAt: '2026-09-23T10:00', exitAt: null } });
  app.renderAll();
  const html = els.get('#queue').innerHTML + els.get('#queueCount').textContent;
  assert.match(html, new RegExp(STATUS_LABEL.CLEARED));
  assert.match(html, new RegExp(STATUS_LABEL.PENDING_REVIEW));
  assert.match(html, /待复核 1/);
  assert.match(els.get('#timeline').innerHTML, /DIVE-01/);
  assert.doesNotMatch(els.get('#timeline').innerHTML, /DIVE-02/);

  const before = els.get('#queue').innerHTML;
  els.get('#refreshBtn')._handlers.click();
  assert.equal(els.get('#queue').innerHTML, before);

  const json = JSON.parse(store.exportJSON());
  assert.equal(json.dives.length, 2);
  assert.ok(!('archives' in json));
});
