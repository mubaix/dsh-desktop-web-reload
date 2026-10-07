// Test: load lib/client.js the way the desktop's Client module loader does, then
// exercise the caption injection against a fake DOM that reproduces the shipped
// Windows caption menubar (a `<div data-windows-menu>` with an OPEN shadow root
// holding `role=menubar` and the 「应用」/「编辑」 buttons).
//
// Plain Node, no dependencies and no browser: the point is to prove the plugin's
// own logic — ordering, the running-session gate, the refusal warning, teardown —
// not to emulate a real engine. Run it with:
//
//   node test/client.mjs

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

//#region tiny DOM
/** Minimal event target supporting the listeners the plugin registers. */
class FakeTarget {
  constructor() {
    this.listeners = new Map();
    this.disabled = false;
    this.attrs = new Map();
    this.style = new Proxy({}, { set: (t, k, v) => { t[k] = v; return true; } });
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  removeEventListener(type, fn) {
    const list = this.listeners.get(type) ?? [];
    const index = list.indexOf(fn);
    if (index >= 0) list.splice(index, 1);
  }
  /** Fire the listeners registered for one type (no bubbling needed here). */
  dispatch(type, event = {}) {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn({ preventDefault() {}, target: this, ...event });
  }
  setAttribute(name, value) {
    this.attrs.set(name, String(value));
  }
  getAttribute(name) {
    return this.attrs.has(name) ? this.attrs.get(name) : null;
  }
  hasAttribute(name) {
    return this.attrs.has(name);
  }
  matches() {
    return false;
  }
  getBoundingClientRect() {
    return { left: 120, right: 180, top: 0, bottom: 40, width: 60, height: 40 };
  }
}

class FakeElement extends FakeTarget {
  constructor(tag) {
    super();
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.parent = null;
    this.shadowRoot = null;
    this.dataset = {};
    this.textContent = '';
  }
  get lastElementChild() {
    return this.children.at(-1) ?? null;
  }
  get nextSibling() {
    if (this.parent === null) return null;
    const index = this.parent.children.indexOf(this);
    return index < 0 ? null : this.parent.children[index + 1] ?? null;
  }
  append(...nodes) {
    for (const node of nodes) {
      node.parent = this;
      this.children.push(node);
    }
  }
  insertBefore(node, reference) {
    node.parent = this;
    const index = reference === null ? this.children.length : this.children.indexOf(reference);
    if (index < 0) throw new Error('insertBefore: reference is not a child');
    this.children.splice(index, 0, node);
  }
  remove() {
    if (this.parent === null) return;
    const index = this.parent.children.indexOf(this);
    if (index >= 0) this.parent.children.splice(index, 1);
    this.parent = null;
  }
  attachShadow() {
    this.shadowRoot = new FakeElement('#shadow-root');
    return this.shadowRoot;
  }
  /** Text of every descendant, pre-order — the caption's visible label order. */
  labels() {
    const out = [];
    const walk = (node) => {
      if (node.tagName === 'BUTTON') out.push(node.textContent);
      for (const child of node.children) walk(child);
    };
    walk(this);
    return out;
  }
  querySelector(selector) {
    const match = (node) => {
      if (selector === '[role="menubar"]') return node.getAttribute('role') === 'menubar';
      if (selector === 'button') return node.tagName === 'BUTTON';
      return false;
    };
    const walk = (node) => {
      for (const child of node.children) {
        if (match(child)) return child;
        const found = walk(child);
        if (found !== null) return found;
      }
      return null;
    };
    return walk(this);
  }
  querySelectorAll(selector) {
    const out = [];
    const walk = (node) => {
      for (const child of node.children) {
        if (selector === 'button' && child.tagName === 'BUTTON') out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }
}

/**
 * The theme tokens the fake page reports. Mutable so a test can simulate a switch.
 */
const themeTokens = {
  '--dsw-alias-label-primary': '#0f1115',
  '--dsw-alias-label-secondary': '#61666b',
  '--dsw-alias-label-tertiary': '#81858c'
};

/**
 * Install the fake DOM as globals and return its caption host.
 * @returns the `<div data-windows-menu>`-shaped host with a menubar inside.
 */
function installFakeDocument() {  const html = new FakeElement('html');
  html.lang = 'zh-CN';
  const body = new FakeElement('body');
  const host = new FakeElement('div');
  host.dataset.windowsMenu = '';
  const shadow = host.attachShadow();
  const bar = new FakeElement('div');
  bar.setAttribute('role', 'menubar');
  const application = new FakeElement('button');
  application.textContent = '应用';
  application.setAttribute('role', 'menuitem');
  const edit = new FakeElement('button');
  edit.textContent = '编辑';
  edit.setAttribute('role', 'menuitem');
  bar.append(application, edit);
  shadow.append(bar);

  const document = {
    documentElement: html,
    body,
    createElement: (tag) => new FakeElement(tag),
    querySelector: (selector) => (selector === '[data-windows-menu]' ? (host.parent === null ? null : host) : null)
  };
  globalThis.document = document;
  // Node exposes `navigator` as a getter-only accessor, so the language stub has to
  // be installed as an own property rather than assigned.
  Object.defineProperty(globalThis, 'navigator', {
    value: { language: 'zh-CN' },
    configurable: true,
    writable: true
  });
  globalThis.MutationObserver = class {
    observe() {}
    disconnect() {}
  };
  globalThis.CSSStyleSheet = class {
    replaceSync() {}
  };
  // The plugin resolves its two colours by reading theme tokens off the document
  // element, so the fake page has to answer `getComputedStyle`. `themeTokens` is
  // mutable so a test can simulate a theme switch.
  globalThis.getComputedStyle = () => ({
    getPropertyValue: (token) => themeTokens[token] ?? ''
  });
  globalThis.setTimeout = setTimeout;
  globalThis.clearTimeout = clearTimeout;
  return { html, body, host, shadow, bar, application, edit };
}

/** Attach the host to the document body, as the preload's `mount()` does. */
function mountHost(dom) {
  dom.body.append(dom.host);
}
//#endregion

//#region loader
const loaded = [];
globalThis.window = {
  __ModuleLoader__: {
    load: (entry) => loaded.push(entry)
  },
  location: { reload: () => loaded.push({ reloaded: true }) }
};

const clientUrl = new URL('../lib/client.js', import.meta.url);
await import(`${clientUrl.href}?envelope=${String(Date.now())}`);
assert.equal(loaded.length, 1, 'the module envelope registers exactly one entry');
const entry = loaded[0];
assert.equal(typeof entry.factory, 'function', 'the envelope carries a factory');

const client = entry.factory(() => {
  throw new Error('this plugin must require nothing');
});
//#endregion

//#region checks
let passed = 0;
/**
 * Assert one labelled expectation, mirroring the sibling plugin's test style.
 * @param label - what is being checked.
 * @param condition - the expectation.
 * @param detail - extra text on failure.
 */
function check(label, condition, detail = '') {
  if (!condition) throw new Error(`FAIL ${label}${detail === '' ? '' : ` — ${detail}`}`);
  passed += 1;
  console.log(`ok ${passed} - ${label}`);
}

check('the factory exports apply()', typeof client.apply === 'function');
check('inject declares the session catalog and the remote channel', ['sessions', 'remote'].every((s) => client.inject.includes(s)), client.inject.join(','));
// Cordis throws on property access to a service a plugin did not inject, so the
// source must never reach the locale service that way — not even in a comment,
// which is why this is a source-level check on the raw text.
{
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
  check('the source never reads the locale service by property', !source.includes('ctx.locale'), 'found ctx.locale');
}

//#region running-count
const idleCtx = { sessions: { list: { getSnapshot: () => ({ byId: { a: { id: 'a', running: false }, b: { id: 'b' } } }), subscribe: () => () => {} } } };
check('runningCount ignores idle and run-less rows', client.runningCount(idleCtx) === 0);

const busyCtx = { sessions: { list: { getSnapshot: () => ({ byId: { a: { running: false }, b: { running: true } } }), subscribe: () => () => {} } } };
check('runningCount counts every running row', client.runningCount(busyCtx) === 1);

const brokenCtx = { sessions: { list: { getSnapshot: () => { throw new Error('store unavailable'); } } } };
check('runningCount degrades to idle when the store throws', client.runningCount(brokenCtx) === 0);
check('runningCount degrades to idle without a session service', client.runningCount({}) === 0);
//#endregion

//#region apply is inert off the desktop shell
const domOff = installFakeDocument();
mountHost(domOff);
delete globalThis.dshPlatform;
let offEffects = 0;
client.apply({
  effect: () => {
    offEffects += 1;
  },
  sessions: idleCtx.sessions
});
check('apply installs nothing in a plain browser document', offEffects === 0 && domOff.bar.labels().length === 2);
//#endregion

//#region caption injection
const dom = installFakeDocument();
globalThis.dshPlatform = { protocolVersion: 1 };
const effects = [];
const subscriptions = [];
const ctx = {
  sessions: {
    list: {
      getSnapshot: () => ({ byId: { s1: { id: 's1', running: false } } }),
      subscribe: (fn) => {
        subscriptions.push(fn);
        return () => subscriptions.splice(subscriptions.indexOf(fn), 1);
      }
    }
  },
  remote: { $on: () => () => {} },
  // Reached through ctx.get, never as ctx.locale: Cordis throws on property access
  // to an uninjected service, so the plugin must not touch ctx.locale at all.
  get: (name) => {
    if (name === 'locale') return { getSnapshot: () => ({ id: 'zh-CN' }), register: () => () => {}, bind: () => (key) => key };
    return undefined;
  },
  effect: (fn) => {
    effects.push(fn);
  },
  on: () => () => {}
};
Object.defineProperty(ctx, 'locale', {
  get() {
    throw new Error('cannot get property "locale" without inject');
  }
});
client.apply(ctx);
check('apply registers its effects on the desktop shell', effects.length === 2, String(effects.length));

// The preload mounts the host only after the app frame exists; run the effects
// before that, exactly as boot order does, and confirm discovery is reactive.
for (const fn of effects) fn();
check('nothing is injected before the caption host mounts', dom.bar.labels().join('|') === '应用|编辑', dom.bar.labels().join('|'));

mountHost(dom);
const installed = client.mountWhenAvailable(ctx);
check('the button lands immediately right of 编辑', dom.bar.labels().join('|') === '应用|编辑|刷新', dom.bar.labels().join('|'));

const button = dom.bar.querySelector('button');
const reloadButton = dom.shadow.querySelectorAll('button').at(-1);
check('the injected button is the last one in the row', reloadButton.textContent === '刷新');
check('the button is enabled while every session is idle', reloadButton.disabled === false);
check('the row stays ordered by the menubar', dom.bar.children.at(-1).textContent === '刷新');
check(
  'an idle button is painted with the darkest label token',
  reloadButton.style.color === '#0f1115',
  String(reloadButton.style.color)
);
//#endregion

//#region the gate
const running = { byId: { s1: { id: 's1', running: false }, s2: { id: 's2', running: true } } };
ctx.sessions.list.getSnapshot = () => running;
for (const fn of subscriptions) fn();
check('a running session disables the button', reloadButton.disabled === true);
check('the disabled button carries a warning label', reloadButton.title.includes('有对话正在运行'), reloadButton.title);

for (const fn of subscriptions) fn();
check('a click while disabled does not reload', loaded.every((item) => item.reloaded !== true));

running.byId.s2.running = false;
for (const fn of subscriptions) fn();
check('the button re-enables once every session is idle', reloadButton.disabled === false);

reloadButton.dispatch('click');
check('an idle click reaches window.location.reload', loaded.some((item) => item.reloaded === true), JSON.stringify(loaded.at(-1)));
//#endregion

//#region teardown
installed();
check('teardown restores the shipped two-button caption', dom.bar.labels().join('|') === '应用|编辑', dom.bar.labels().join('|'));
check('teardown releases its session subscription', subscriptions.length === 0);
//#endregion

//#region theming
// A theme switch rewrites the alias tokens; the button is not React, so the plugin
// has to re-measure and repaint it on `theme/change`. Run this in its own install so
// it cannot disturb the assertions above.
const themeHandlers = [];
ctx.on = (event, handler) => {
  if (event === 'theme/change') themeHandlers.push(handler);
  return () => {};
};
themeTokens['--dsw-alias-label-primary'] = '#f9fafb';
themeTokens['--dsw-alias-label-tertiary'] = '#adb2b8';
const themedInstall = client.mountWhenAvailable(ctx);
const themed = dom.shadow.querySelectorAll('button').at(-1);
check('the idle colour is re-measured from the current palette', themed.style.color === '#f9fafb', String(themed.style.color));
check('the plugin subscribes to theme changes', themeHandlers.length === 1, String(themeHandlers.length));

// An unset token must not blank the colour: the stylesheet rule is the fallback.
delete themeTokens['--dsw-alias-label-primary'];
themeHandlers.forEach((handler) => handler());
check('an unresolvable token keeps the previous paint', themed.style.color === '#f9fafb', String(themed.style.color));

// With a running session the button takes the dimmer token instead.
themeTokens['--dsw-alias-label-primary'] = '#f9fafb';
ctx.sessions.list.getSnapshot = () => ({ byId: { s1: { running: true } } });
for (const fn of subscriptions) fn();
check('a busy button takes the dimmest label token', themed.style.color === '#adb2b8', String(themed.style.color));
themedInstall();
//#endregion

console.log(`\n${passed} checks passed`);
