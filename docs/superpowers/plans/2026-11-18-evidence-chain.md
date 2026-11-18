# 会话证据链与卡住诊断 实现计划

> **For agentic workers:** 按任务顺序执行，每个任务先写失败测试、再实现、再跑测试。用户要求：**只在本地修改，不提交 git**，所以每个任务末尾用「跑测试」代替 commit。

**Goal:** 展开一个软件的多会话时，能看到驱动当前颜色的最近事件，以及「静默多久 / 是否疑似卡住」。

**Architecture:** 服务端 `Store` 为每个会话维护一个内存事件环（8 条 / 2 小时），随 `/state` 快照下发；观察器心跳带 `pulse: true`，只刷新存活时间、不写入事件环；前端在多会话展开区渲染一个小型时间线与诊断语，阈值来自本地配置。

**Tech Stack:** Node.js CJS、node:test、Electron/原生 DOM、Playwright。

**Spec:** `docs/superpowers/specs/2026-11-18-evidence-chain-design.md`

---

### Task 1: Store 事件环与 pulse

**Files:**
- Modify: `src/store.js:221-311`（`set`）、`:414-502`（`snapshot`）、`:313-382`（`sweep`）、构造函数 `:86-114`
- Test: `test/store.test.js`

- [ ] **Step 1: 写失败测试**

在 `test/store.test.js` 末尾追加：

```js
test('a state change is recorded as one evidence event', () => {
  const st = new Store();
  st.set({ session: 'ev-1', agent: 'claude', state: 'busy', detail: 'running', source: 'hook', event: 'PreToolUse' });
  const s = st.snapshot().sessions.find((x) => x.session === 'ev-1');
  assert.equal(s.events.length, 1);
  assert.equal(s.events[0].source, 'hook');
  assert.equal(s.events[0].event, 'PreToolUse');
  assert.equal(s.events[0].state, 'busy');
  assert.ok(s.lastEventAt > 0, 'the activity clock starts with the first real event');
});

test('a repeated report does not add another event', () => {
  const st = new Store();
  st.set({ session: 'ev-2', agent: 'claude', state: 'busy', detail: 'running' });
  st.set({ session: 'ev-2', agent: 'claude', state: 'busy', detail: 'running' });
  assert.equal(st.snapshot().sessions[0].events.length, 1);
});

test('a heartbeat keeps the session alive but is not evidence', () => {
  const st = new Store();
  st.set({ session: 'ev-3', agent: 'codex', state: 'busy', detail: 'working' });
  const before = st.snapshot().sessions[0].lastEventAt;
  st.set({ session: 'ev-3', agent: 'codex', state: 'busy', detail: 'working', pulse: true });
  const s = st.snapshot().sessions[0];
  assert.equal(s.events.length, 1, 'heartbeats never enter the ring');
  assert.equal(s.lastEventAt, before, 'heartbeats never move the activity clock');
});

test('the ring keeps the newest eight events', () => {
  const st = new Store();
  for (let i = 0; i < 10; i += 1) {
    st.set({ session: 'ev-4', agent: 'claude', state: i % 2 ? 'busy' : 'waiting', detail: String(i) });
  }
  const s = st.snapshot().sessions[0];
  assert.equal(s.events.length, 8);
  assert.equal(s.events[7].detail, '9');
});

test('events older than two hours are dropped, and going offline clears the trail', () => {
  const st = new Store();
  st.set({ session: 'ev-5', agent: 'claude', state: 'busy', detail: 'old' });
  st.trails.get('ev-5')[0].at = Date.now() - 3 * 60 * 60 * 1000;
  st.set({ session: 'ev-5', agent: 'claude', state: 'waiting', detail: 'new' });
  assert.equal(st.snapshot().sessions[0].events.length, 1, 'the stale event is gone');
  st.set({ session: 'ev-5', agent: 'claude', state: 'offline' });
  assert.equal(st.trails.has('ev-5'), false, 'an ended session leaves nothing behind');
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `node --test test/store.test.js`
Expected: FAIL（`s.events` 为 undefined；`st.trails` 不存在）

- [ ] **Step 3: 实现**

构造函数里加：

```js
    // 每个会话最近的状态证据（只有元数据，进程内，重启即清）。
    this.trails = new Map();
```

`set` 的签名：

```js
  set({
    session = 'default', agent = 'agent', state, detail = '', cwd = '', fuel, create = false,
    source = 'api', event = '', pulse = false,
  } = {}) {
```

在 `const now = Date.now();` 之后、统计结算之前插入：

```js
    const changed = !prev || prev.state !== next || prev.detail !== detail;
    const meaningful = !pulse && (changed || !!event);
    if (meaningful) this.recordEvent(session, prev, next, detail, now, source, event);
```

在 `this.sessions.set(session, { ... })` 的对象里加一行：

```js
        lastEventAt: meaningful ? now : (prev?.lastEventAt ?? now),
```

`next === 'offline'` 的分支改成：

```js
    if (next === 'offline') {
      this.sessions.delete(session);
      this.trails.delete(session);
    } else {
```

新增方法（放在 `set` 之前）：

```js
  recordEvent(session, prev, state, detail, now, source, event) {
    const cut = now - 2 * 60 * 60 * 1000;
    const list = (this.trails.get(session) || []).filter((e) => e.at >= cut);
    list.push({
      at: now,
      source: String(source || 'api').slice(0, 12),
      event: String(event || '').slice(0, 40),
      state,
      detail: String(detail || '').slice(0, 120),
      tookMs: prev ? Math.max(0, now - prev.since) : 0,
    });
    while (list.length > 8) list.shift();
    this.trails.set(session, list);
  }
```

`snapshot` 的 sessions 构造改为（注意：必须复制，不能把 events 挂到 store 里的原对象上）：

```js
    const sessions = [...this.sessions.values()]
      .map((s) => {
        const out = now - s.updatedAt > this.quietAfterMs
          ? { ...s, quiet: true, quietFor: now - s.updatedAt }
          : { ...s };
        const trail = this.trails.get(s.session);
        if (trail && trail.length) out.events = trail.filter((e) => now - e.at <= 2 * 60 * 60 * 1000);
        return out;
      })
      .sort((a, b) => b.updatedAt - a.updatedAt);
```

`sweep` 末尾、`if (changed)` 之前加：

```js
    for (const id of this.trails.keys()) {
      if (!this.sessions.has(id)) this.trails.delete(id);
    }
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `node --test test/store.test.js`
Expected: PASS

---

### Task 2: 适配器与钩子带上来源，心跳标记 pulse

**Files:**
- Modify: `src/adapters/log-watch.js:284-310`
- Modify: `src/adapters/dsh-watch.js:202-215`
- Modify: `src/adapters/task-watch.js:164-180`
- Modify: `src/adapters/wbt-watch.js:157-166, 237-245`
- Modify: `src/hooks/claude.js`、`src/hooks/event.js`、`src/mcp-server.js`（各自的 `setState` 对象）
- Test: `test/adapters.test.js`（或 `test/e2e.test.js`）

- [ ] **Step 1: 写失败测试**

在 `test/e2e.test.js` 的 Claude 全流程测试末尾追加断言：

```js
  const ev = (await api('/state')).sessions.find((x) => x.session === `claude:${sid}`);
  assert.equal(ev.events[0].source, 'hook');
  assert.equal(ev.events[0].event, 'UserPromptSubmit');
  assert.ok(ev.events.some((e) => e.event === 'Stop'), 'the stop event is visible evidence');
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `node --test test/e2e.test.js`
Expected: FAIL（`source` 是 `'api'`，`event` 是空串）

- [ ] **Step 3: 实现**

`log-watch.js` 心跳分支：

```js
          setState({ session, agent: name, state: 'busy', detail: 'working', cwd: t.cwd || '', source: 'log', event: type, pulse: true });
```

`log-watch.js` 正常上报的 payload 加：

```js
        source: 'log',
        event: type || next,
```

`dsh-watch.js` 的 payload 加：

```js
        source: 'file',
        event: 'projection',
        pulse: alive,
```

`task-watch.js` 的 payload 加：

```js
        source: 'file',
        event: 'task_board',
        pulse: alive,
```

`wbt-watch.js` 的 `emit` 改为：

```js
  const emit = (st, next, detail, pulse = false) => {
    st.state = next;
    st.detail = detail;
    st.reportedAt = Date.now();
    setState({ session: st.session, agent: st.agent, state: next, detail, cwd: st.cwd || '', source: 'log', event: detail, pulse });
```

心跳调用改为 `emit(st, next, detail, true);`。

三个钩子入口（`claude.js` / `event.js`）的 `setState` 对象加：

```js
      source: 'hook',
      event: name,
```

`mcp-server.js` 的 `setState` 对象加：

```js
      source: 'mcp',
      event: 'set_state',
```

- [ ] **Step 4: 运行测试**

Run: `node --test test/e2e.test.js test/adapters.test.js`
Expected: PASS

---

### Task 3: 卡住阈值配置与设置界面

**Files:**
- Modify: `src/config.js`（DEFAULTS）
- Modify: `src/overlay/index.html`（系统组）
- Modify: `src/overlay/ui.js`（`EXPORT_KEYS`、`sanitizeImport`、恢复、监听）
- Test: `test-ui/overlay.spec.js`（「every saved customisation…」）

- [ ] **Step 1: 写失败测试**

在恢复测试的保存配置里加：

```js
    stuckBusyMin: 20, stuckWaitMin: 7,
```

并在系统设置断言附近加：

```js
  await expect(page.locator('#m-stuck-busy')).toHaveValue('20');
  await expect(page.locator('#m-stuck-wait')).toHaveValue('7');
```

- [ ] **Step 2: 运行，确认失败**

Run: `npx playwright test -g "every saved customisation"`
Expected: FAIL（输入框不存在）

- [ ] **Step 3: 实现**

`config.js` 默认值加：

```js
  // 证据链里的「卡住」阈值（分钟）。只在界面计算文案，不影响状态推导。
  stuckBusyMin: 15,
  stuckWaitMin: 10,
```

`index.html` 在 `m-sys-motion` 那一行后加：

```html
      <div class="row">
        <label for="m-stuck-busy">忙碌多久算卡住</label>
        <input id="m-stuck-busy" type="number" min="1" max="240" step="1" value="15" />
      </div>
      <div class="row">
        <label for="m-stuck-wait">等待多久提醒</label>
        <input id="m-stuck-wait" type="number" min="1" max="240" step="1" value="10" />
      </div>
```

`ui.js` 顶部引用：

```js
  const stuckBusyInput = document.getElementById('m-stuck-busy');
  const stuckWaitInput = document.getElementById('m-stuck-wait');
```

`EXPORT_KEYS` 追加 `'stuckBusyMin', 'stuckWaitMin'`。

`sanitizeImport` 里加：

```js
    for (const key of ['stuckBusyMin', 'stuckWaitMin']) {
      if (out[key] !== undefined) {
        const n = Math.round(Number(out[key]));
        out[key] = n >= 1 && n <= 240 ? n : (key === 'stuckBusyMin' ? 15 : 10);
      }
    }
```

恢复配置处加：

```js
      stuckBusyInput.value = String(cfg.stuckBusyMin >= 1 && cfg.stuckBusyMin <= 240 ? cfg.stuckBusyMin : 15);
      stuckWaitInput.value = String(cfg.stuckWaitMin >= 1 && cfg.stuckWaitMin <= 240 ? cfg.stuckWaitMin : 10);
```

监听（放在系统组其它监听旁）：

```js
  const saveThreshold = (key, input, fallback) => {
    const n = Math.round(Number(input.value));
    cfg[key] = n >= 1 && n <= 240 ? n : fallback;
    input.value = String(cfg[key]);
    if (inElectron) saveConfig({ [key]: cfg[key] });
  };
  stuckBusyInput.addEventListener('change', () => saveThreshold('stuckBusyMin', stuckBusyInput, 15));
  stuckWaitInput.addEventListener('change', () => saveThreshold('stuckWaitMin', stuckWaitInput, 10));
```

- [ ] **Step 4: 运行测试**

Run: `npx playwright test -g "every saved customisation"`
Expected: PASS

---

### Task 4: 展开区渲染证据与诊断

**Files:**
- Modify: `src/overlay/index.html`（CSS）
- Modify: `src/overlay/ui.js:1186-1200`（`appendSessionRows`）
- Test: `test-ui/overlay.spec.js`

- [ ] **Step 1: 写失败测试**

新增：

```js
test('an expanded software explains its colour with recent events', async ({ page }) => {
  await clear();
  await api('/state', { session: 'why-1', agent: 'codex', state: 'busy', detail: 'running' });
  await api('/state', { session: 'why-1', agent: 'codex', state: 'waiting', detail: 'approve?' });
  // 第二个会话让 ×N 展开按钮出现（单会话时按钮是隐藏的）。
  await api('/state', { session: 'why-2', agent: 'codex', state: 'busy', detail: 'building' });
  await page.goto(base + '/');
  await page.locator('.pill[data-agent="codex"] .pill-expand').click();
  const why = page.locator('.why');
  await expect(why).toBeVisible();
  await expect(why).toContainText('为什么是这个颜色');
  await expect(why).toContainText('·');
  await expect(why).toContainText('已静默');
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `npx playwright test -g "explains its colour"`
Expected: FAIL（`.why` 不存在）

- [ ] **Step 3: 实现**

`index.html` 加样式：

```css
  .why { margin: 2px 0 6px 14px; padding: 6px 8px; border-left: 2px solid #3a4048; color: #9aa6b2; font-size: 10px; line-height: 1.5; }
  .why b { display: block; color: #c9d3dd; font-size: 10px; font-weight: 600; margin-bottom: 2px; }
  .why ol { margin: 0; padding-left: 14px; }
  .why p { margin: 2px 0 0; color: #8a96a2; }
```

`ui.js` 在 `appendSessionRows` 之前加（复用 `subPool`，这样收起时会和其它展开行一起被清理，不会每次渲染堆一个副本）：

```js
  function whyBlock(worst, sessions, used) {
    const rows = sessions
      .filter((x) => x.agent === worst.agent && x.state !== 'offline')
      .sort((a, b) => (PRIO[b.state] - PRIO[a.state]) || (b.updatedAt - a.updatedAt));
    const s = rows[0];
    if (!s) return;
    const key = `why:${worst.agent}`;
    let el = subPool.get(key);
    if (!el) {
      el = document.createElement('div');
      el.className = 'why';
      subPool.set(key, el);
    }
    el.textContent = '';
    const title = document.createElement('b');
    title.textContent = '为什么是这个颜色';
    el.appendChild(title);
    const evs = (Array.isArray(s.events) ? s.events : []).slice(-5);
    if (!evs.length) {
      const p = document.createElement('p');
      p.textContent = '还没有可展示的事件，等待下一次上报。';
      el.appendChild(p);
    } else {
      const ol = document.createElement('ol');
      for (const e of evs) {
        const li = document.createElement('li');
        const t = new Date(e.at).toLocaleTimeString('zh-CN', { hour12: false });
        li.textContent = `${t} · ${e.source || 'api'} · ${e.event || '状态'} → ${VERB[e.state] || e.state}`;
        ol.appendChild(li);
      }
      el.appendChild(ol);
    }
    const mins = Math.max(0, Math.floor((Date.now() - (s.lastEventAt || s.updatedAt || Date.now())) / 60000));
    const busyMin = Number(cfg.stuckBusyMin) || 15;
    const waitMin = Number(cfg.stuckWaitMin) || 10;
    let text = `已静默 ${mins} 分钟`;
    if (s.state === 'busy' && mins >= busyMin) text += ' · 疑似卡住：可能卡在长工具调用，或进程/日志已停止';
    else if (s.state === 'waiting' && mins >= waitMin) text += ' · 已经等你很久，它仍停在确认这一步';
    else if (s.state === 'error' && mins >= 30) text += ' · 错误已 30 分钟未处理';
    const p = document.createElement('p');
    p.textContent = text;
    el.appendChild(p);
    labels.appendChild(el);
    used.add(key);
  }
```

在 `appendSessionRows` 末尾调用：

```js
    whyBlock(worst, sessions, used);
```

- [ ] **Step 4: 运行测试**

Run: `npx playwright test -g "explains its colour|system panel"`
Expected: PASS

---

### Task 5: 全量回归与清理

- [ ] **Step 1:** `npm run lint` → 无输出（通过）
- [ ] **Step 2:** `npm test` → 全部通过（预期 ≥ 235 项）
- [ ] **Step 3:** `npm run test:ui` → 全部通过（预期 ≥ 123 项）
- [ ] **Step 4:** `npm run test:electron` → ALL PASS
- [ ] **Step 5:** `npm run check:pack` → package check ok
- [ ] **Step 6:** 重启实机，`bao doctor` 14/14，`bao status` 正常
- [ ] **Step 7:** 不提交 git（用户要求）

---

## 风险与注意

- 事件环只在内存，重启清空是刻意行为；不要改成落盘。
- 心跳漏传 `pulse` 会让「卡住」永不触发，用 Task 1 的 store 测试锁定。
- `snapshot` 必须复制 session 再挂 `events`，否则会把只读数据写回 store。
- 诊断文案只出现在展开区，绝不参与颜色计算。
