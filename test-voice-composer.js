'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadInsertion(document, window = {}, Event = class {}) {
  const source = fs.readFileSync(path.join(__dirname, 'plugin/dshup-client-settings/lib/client.js'), 'utf8');
  const start = source.indexOf('function captureComposerInsertion(');
  const end = source.indexOf('function openVoiceSettings()', start);
  assert.ok(start >= 0 && end > start);
  const context = vm.createContext({ document, window, Event });
  vm.runInContext(source.slice(start, end), context);
  return { capture: context.captureComposerInsertion, insert: context.insertComposerText };
}

test('0.2 语音通过当前会话动作填入并保留录音开始时的选区', () => {
  const api = loadInsertion({ querySelector() { throw new Error('不得查询或改写 DOM'); } });
  const span = { start: 2, end: 2, draftRev: 7 };
  let inserted;
  const actions = {
    captureInsertion: () => span,
    insertText(text, captured) { inserted = { text, captured, owner: this }; return true; },
  };
  const target = api.capture(actions);
  assert.equal(api.insert('语音文字', target), true);
  assert.equal(inserted.text, '语音文字');
  assert.equal(inserted.captured, span);
  assert.equal(inserted.owner, actions);
});

test('0.2 草稿变更或提交锁拒绝插入时不回退覆盖 DOM，重试重新捕获', () => {
  const api = loadInsertion({ querySelector() { throw new Error('不得回退到 DOM'); } });
  let revision = 1;
  let draft = '原始内容';
  let locked = false;
  const actions = {
    captureInsertion: () => ({ start: draft.length, end: draft.length, draftRev: revision }),
    insertText(text, span) {
      if (locked || span.draftRev !== revision) return false;
      draft += text;
      revision++;
      return true;
    },
  };
  const oldTarget = api.capture(actions);
  draft = '用户后续编辑';
  revision++;
  assert.equal(api.insert('识别结果', oldTarget), false);
  assert.equal(draft, '用户后续编辑');
  assert.equal(api.insert('识别结果', api.capture(actions)), true);
  assert.equal(draft, '用户后续编辑识别结果');
  locked = true;
  assert.equal(api.insert('锁定期间的文字', api.capture(actions)), false);
  assert.equal(draft, '用户后续编辑识别结果');
});

function legacyFixture() {
  class Textarea {
    constructor() { this.current = '原文'; this.isConnected = true; this.events = []; }
    get value() { return this.current; }
    set value(value) { this.current = value; }
    dispatchEvent(event) { this.events.push(event); }
    focus() { this.focused = true; }
  }
  class InputEvent {
    constructor(type, options) { this.type = type; Object.assign(this, options); }
  }
  const textarea = new Textarea();
  const api = loadInsertion({ querySelector: () => textarea }, { HTMLTextAreaElement: Textarea }, InputEvent);
  return { api, textarea };
}

test('0.1 保留 textarea 原生值写入和受控输入事件', () => {
  const { api, textarea } = legacyFixture();
  assert.equal(api.insert('追加语音', api.capture({ setDraft() {} })), true);
  assert.equal(textarea.value, '原文追加语音');
  assert.equal(textarea.events[0].type, 'input');
  assert.equal(textarea.events[0].bubbles, true);
  assert.equal(textarea.focused, true);
});

test('0.1 不向已改动、已卸载或只读输入框填入迟到的识别结果', () => {
  for (const change of [textarea => { textarea.value = '新内容'; }, textarea => { textarea.isConnected = false; }, textarea => { textarea.readOnly = true; }]) {
    const { api, textarea } = legacyFixture();
    const target = api.capture();
    change(textarea);
    const before = textarea.value;
    assert.equal(api.insert('识别结果', target), false);
    assert.equal(textarea.value, before);
    assert.equal(textarea.events.length, 0);
  }
});
