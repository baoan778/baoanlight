'use strict';
// Rendered-UI tests for the robot overlay.
//
// The node:test suite proves the state machine. These prove what a person
// actually sees: which beacon is lit, where the robot sits, whether it is
// clipped by the window, what the label says, and what colour the gauge is.
// Every test here corresponds to something that was once visibly wrong.

const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 隔离到临时目录：本套件在 port 0 上起 server，必须把 HOME 指走，否则临时端口
// 会写进 ~/.baoanlight/port，覆盖用户真实机器人的端口 —— 正是「服务在跑、
// status 却说 not running」的根因。必须在 require server 之前设好（config.DIR
// 在模块加载时就定死了）。
const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'bao-ui-'));
process.env.BAOANLIGHT_HOME = testHome;

const { start } = require('../src/server');

const GUTTER = 16;             // minimum clear space around the robot
let server;
let base;
let token;                     // writes need it; reads do not (see src/auth.js)
let ccSwitchHome;

test.beforeAll(async () => {
  // 与机器上真实的 cc-switch 隔离：overlay 测试验证的是渲染契约，不该依赖
  // 开发机当前把哪个代理切到哪个供应商（否则一个本地 provider 就能让
  // "label 精确匹配"这类断言在别人的机器上飘绿、在自己的机器上飘红）。
  ccSwitchHome = fs.mkdtempSync(path.join(os.tmpdir(), 'bao-ccs-'));
  process.env.BAOANLIGHT_CCSWITCH_HOME = ccSwitchHome;
  const r = await start({ port: 0, idleTtlMs: 600_000 });
  server = r.server;
  token = r.token;
  base = `http://127.0.0.1:${server.address().port}`;
});

test.afterAll(() => {
  server && server.close();
  delete process.env.BAOANLIGHT_CCSWITCH_HOME;
  delete process.env.BAOANLIGHT_HOME;
  if (ccSwitchHome) fs.rmSync(ccSwitchHome, { recursive: true, force: true });
  if (testHome) fs.rmSync(testHome, { recursive: true, force: true });
});

const api = (path, body) =>
  fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-bao-token': token },
    body: JSON.stringify(body),
  });

const clear = async () => {
  const snap = await (await fetch(base + '/state')).json();
  for (const s of snap.sessions) await api('/state', { session: s.session, state: 'offline' });
};

// Wait for the page's own SSE-driven render, rather than a fixed sleep.
const settled = (page, fn) => expect.poll(() => page.evaluate(fn), { timeout: 4000 });

test.beforeEach(async ({ page }) => {
  await clear();
  await page.goto(base + '/');
  await page.waitForFunction(() => document.body.dataset.state !== undefined);

  // In Electron the stage is pinned to the window's top-left; without
  // window.bao the page centres itself instead, which would make the robot
  // drift as content grows. Test the layout the product actually ships.
  await page.evaluate(() => document.body.classList.remove('browser'));

  // Read settled values, not frames mid-transition.
  await page.addStyleTag({
    content: '*,*::before,*::after{transition:none!important;animation:none!important}',
  });
});

// ---------------------------------------------------------------- the beacon

// The colour contract, and it is not the one the first version shipped with:
// green is "alive and working", yellow is "stopped, your turn", red is
// "it broke". Green-as-idle was the bug — it told people to come and look at a
// working agent, and red-for-waiting made an ordinary permission prompt read
// like a crash.
test('the right beacon lights for each state', async ({ page }) => {
  for (const [state, colour] of [
    ['busy', 'green'], ['waiting', 'amber'], ['error', 'red'], ['idle', 'white'], ['unknown', 'grey'],
  ]) {
    await api('/state', { session: 'a', agent: 'claude', state });
    await settled(page, () => {
      const led = document.getElementById('status-led');
      return led.classList.contains('on') ? led.dataset.color : null;
    }).toBe(colour);
  }
});

// idle used to be a dim green, which meant "green" could mean either "working"
// or "not working" — and the colour was the only thing telling them apart.
// Green now belongs to running alone; idle is a dim neutral.
test('idle never borrows the running colour', async ({ page }) => {
  const lit = () => page.evaluate(() => {
    const el = document.getElementById('status-led');
    return { fill: getComputedStyle(el).fill, opacity: Number(getComputedStyle(el).opacity) };
  });

  await api('/state', { session: 'a', agent: 'claude', state: 'busy' });
  await settled(page, () => document.body.dataset.state).toBe('busy');
  const running = await lit();
  expect(running.opacity).toBeGreaterThan(0.9);

  await api('/state', { session: 'a', agent: 'claude', state: 'idle' });
  await settled(page, () => document.body.dataset.state).toBe('idle');
  const idle = await lit();

  expect(idle.fill, 'a neutral, not the running green').not.toBe(running.fill);
  expect(idle.opacity, 'and visibly dimmer').toBeLessThan(0.5);
});

// P0: one robot, four harnesses, no switching. Each software owns a fixed
// segment; none of them may be hidden behind the one that won the main lamp.
test('four software at once each keep their own segment', async ({ page }) => {
  await api('/state', { session: 'c1', agent: 'claude', state: 'busy' });
  await api('/state', { session: 'x1', agent: 'codex', state: 'waiting' });
  await api('/state', { session: 'w1', agent: 'workbuddy', state: 'idle' });
  await api('/state', { session: 'd1', agent: 'deepseek', state: 'error' });
  await settled(page, () => document.body.dataset.state).toBe('error');

  const cells = await page.evaluate(() => [0, 1, 2, 3, 4].map((i) => {
    const el = document.getElementById('slot' + i);
    return { agent: el.dataset.agent, state: el.dataset.state, fill: getComputedStyle(el).fill };
  }));

  expect(cells.map((c) => c.agent))
    .toEqual(['deepseek', 'claude', 'codex', 'workbuddy', 'codebuddy']);
  // codebuddy 没有会话 → 暗格；前四格各是一种状态。
  expect(cells.map((c) => c.state)).toEqual(['error', 'busy', 'waiting', 'idle', 'offline']);
  expect(new Set(cells.slice(0, 4).map((c) => c.fill)).size, 'four distinct lights on screen').toBe(4);
});

// A failure outranks a question: if one agent is stuck on a red and another
// wants permission, the lamp must not hide the broken one behind the polite one.
test('a failed run outranks a waiting one', async ({ page }) => {
  await api('/state', { session: 'a', agent: 'claude', state: 'waiting' });
  await settled(page, () => document.body.dataset.state).toBe('waiting');

  await api('/state', { session: 'b', agent: 'codex', state: 'error', detail: 'Bash failed' });
  await settled(page, () => document.body.dataset.state).toBe('error');

  await api('/state', { session: 'b', state: 'offline' });
  await settled(page, () => document.body.dataset.state).toBe('waiting');
});

test('the most urgent agent wins the beacon', async ({ page }) => {
  await api('/state', { session: 'a', agent: 'claude', state: 'busy' });
  await api('/state', { session: 'b', agent: 'codex', state: 'waiting' });
  await settled(page, () => document.body.dataset.state).toBe('waiting');

  await api('/state', { session: 'b', agent: 'codex', state: 'idle' });
  await settled(page, () => document.body.dataset.state).toBe('busy');
});

// The base ring is the answer to "one robot, four harnesses": every software
// owns a FIXED stretch of light, in the fixed order DeepSeek → Claude → Codex →
// WorkBuddy, so a state change never moves a light the user has already learned.
// `worst` marks the software that owns the main lamp.
test('the scene is told which software owns which light, in fixed order', async ({ page }) => {
  await page.evaluate(() => {
    window.__ring = [];
    window.addEventListener('bao:render', (e) => window.__ring.push(e.detail));
  });

  await api('/state', { session: 'a', agent: 'claude', state: 'busy' });
  await api('/state', { session: 'b', agent: 'codex', state: 'error' });
  await api('/state', { session: 'c', agent: 'workbuddy', state: 'waiting' });

  await settled(page, () => {
    const last = window.__ring[window.__ring.length - 1];
    return last ? last.agents.length : 0;
  }).toBe(5);

  // 5 个注册软件都在（deepseek / codebuddy 没会话 = 离线占位）：灯环段位置固定，
  // 和胸口槽位、pills 行一致。offline 段 hex 为空，由 3D 端画成暗色。
  const agents = await page.evaluate(() =>
    window.__ring[window.__ring.length - 1].agents.map((a) => `${a.agent}:${a.state}:${a.worst}`));

  expect(agents).toEqual([
    'deepseek:offline:false',
    'claude:busy:false',
    'codex:error:true',
    'workbuddy:waiting:false',
    'codebuddy:offline:false',
  ]);
});

// ---------------------------------------------------------------- the label

// Regression: idle clears `detail`, and the old visibility rule required a
// non-empty detail — so the label vanished on exactly one state, green.
test('every state is labelled, green included', async ({ page }) => {
  // Every registered software keeps a row now (offline ones show dark), so the
  // label under test must be pinned to Claude's row, not "the first pill".
  await api('/state', { session: 'a', agent: 'claude', state: 'idle' });
  await settled(page, () => document.querySelector('.pill[data-agent="claude"]')?.textContent.trim()).toBe('Claude Code就绪');

  await api('/state', { session: 'a', agent: 'claude', state: 'waiting' });
  await settled(page, () => document.querySelector('.pill[data-agent="claude"]')?.textContent.trim()).toBe('Claude Code需要你');

  await api('/state', { session: 'a', agent: 'claude', state: 'busy', detail: 'running Bash' });
  await settled(page, () => document.querySelector('.pill[data-agent="claude"]')?.textContent.trim()).toBe('Claude Coderunning Bash');
});

// One software with several open sessions must still be one row, or its
// duplicate rows push the other software off the panel — a real bug where
// workbuddy had both an idle and an error session and claude vanished.
test('one software with several sessions still shows a single row', async ({ page }) => {
  await api('/state', { session: 'w1', agent: 'workbuddy', state: 'idle' });
  await api('/state', { session: 'w2', agent: 'workbuddy', state: 'error' });
  await api('/state', { session: 'c1', agent: 'claude', state: 'busy' });

  // Every registered software keeps exactly one row, in the fixed order; two
  // WorkBuddy sessions must collapse into its single row rather than add another.
  await settled(page, () => document.querySelectorAll('.pill').length).toBe(5);
  await settled(page, () => document.querySelectorAll('.pill[data-agent="workbuddy"]').length).toBe(1);

  const rows = await page.evaluate(() =>
    [...document.querySelectorAll('.pill')].map((el) => el.dataset.agent));
  expect(rows, 'one row per software, fixed order')
    .toEqual(['deepseek', 'claude', 'codex', 'workbuddy', 'codebuddy']);

  // 两个会话合成一行时，行上要写 ×2：否则「Claude 出错了」看不出是三个里哪个，
  // 而 README 一直承诺标签会带 ×N。
  await expect(page.locator('.pill[data-agent="workbuddy"] b')).toHaveText('WorkBuddy ×2');
  await expect(page.locator('.pill[data-agent="claude"] b')).toHaveText('Claude Code');
});

// The list can be reined in: hide the software that is not running, and cap how
// many rows it shows. Both are user choices; the defaults show everything.
test('the software list honours the offline and row-limit settings', async ({ page }) => {
  await api('/state', { session: 'a', agent: 'claude', state: 'busy' });
  await page.locator('#robot').click({ button: 'right', position: { x: 30, y: 30 } });
  await page.locator('#s-gear').click();
  await expect(page.locator('#menu')).toBeVisible();

  // Default: every registered software keeps a row.
  await settled(page, () => document.querySelectorAll('.pill').length).toBe(5);

  // Hide the ones that are not running (the control lives in a collapsed group,
  // so drive it directly rather than depending on scroll/visibility).
  await page.evaluate(() => {
    const el = document.getElementById('m-offline');
    el.checked = false;
    el.dispatchEvent(new Event('change'));
  });
  await settled(page, () => document.querySelectorAll('.pill').length).toBe(1);
  await settled(page, () => document.querySelector('.pill')?.dataset.agent).toBe('claude');

  // Bring them back, then cap the list at two rows.
  await page.evaluate(() => {
    const el = document.getElementById('m-offline');
    el.checked = true;
    el.dispatchEvent(new Event('change'));
  });
  await settled(page, () => document.querySelectorAll('.pill').length).toBe(5);
  await page.evaluate(() => {
    const sel = document.getElementById('m-maxrows');
    sel.value = '2';
    sel.dispatchEvent(new Event('change'));
  });
  await settled(page, () => document.querySelectorAll('.pill:not(.more)').length).toBe(2);
  await settled(page, () => document.querySelector('.pill.more')?.textContent).toContain('还有 3 个');
});

// 行数预算必须先给「真的在跑」的软件：否则 maxRows=2 时前两行是两个离线占位，
// 唯一在跑的那一行被折进「还有 N 个」—— 灯亮着，列表里却查不出是谁。
test('a running software is never hidden behind offline placeholder rows', async ({ page }) => {
  await api('/state', { session: 'a', agent: 'workbuddy', state: 'busy' });
  await page.locator('#robot').click({ button: 'right', position: { x: 30, y: 30 } });
  await page.locator('#s-gear').click();
  await expect(page.locator('#menu')).toBeVisible();
  await page.evaluate(() => {
    const sel = document.getElementById('m-maxrows');
    sel.value = '2';
    sel.dispatchEvent(new Event('change'));
  });

  await settled(page, () => document.querySelectorAll('.pill:not(.more)').length).toBe(2);
  // workbuddy 排在固定顺序的最后，但它是在跑的那一个 —— 必须出现在可见的两行里。
  await settled(page, () => [...document.querySelectorAll('.pill:not(.more)')]
    .map((el) => el.dataset.agent).includes('workbuddy')).toBe(true);
});

// 聚焦的行被行数预算裁掉之后，主灯不能继续锁在它上面：列表里没有可点的行，
// 用户没有任何办法取消聚焦，灯和列表从此各说各的。
test('focus is dropped when the focused row is hidden by the row limit', async ({ page }) => {
  await api('/state', { session: 'a', agent: 'claude', state: 'waiting' });
  await api('/state', { session: 'b', agent: 'codex', state: 'waiting' });
  await api('/state', { session: 'c', agent: 'workbuddy', state: 'busy' });
  await settled(page, () => document.body.dataset.state).toBe('waiting');

  // 聚焦 workbuddy → 主灯临时显示它的 busy
  await page.locator('.pill[data-agent="workbuddy"]').click();
  await settled(page, () => document.body.dataset.state).toBe('busy');

  // 行数压到 2：claude、codex 占掉名额，workbuddy 会被裁掉
  await page.locator('#robot').click({ button: 'right', position: { x: 30, y: 30 } });
  await page.locator('#s-gear').click();
  await page.evaluate(() => {
    const sel = document.getElementById('m-maxrows');
    sel.value = '2';
    sel.dispatchEvent(new Event('change'));
  });

  // 行没了，聚焦必须一起消失，主灯回到聚合最坏者（waiting）
  await settled(page, () => document.querySelector('.pill[data-agent="workbuddy"]')).toBe(null);
  await settled(page, () => document.body.dataset.state).toBe('waiting');
});

// Clicking a software's row focuses the lamp on that software (even if it is
// not the worst); clicking it again restores the automatic aggregate. The four
// channels never disappear — only the main lamp re-points.
test('clicking a software focuses the lamp, clicking again restores the aggregate', async ({ page }) => {
  await api('/state', { session: 'a', agent: 'claude', state: 'busy' });
  await api('/state', { session: 'b', agent: 'workbuddy', state: 'error' });
  await settled(page, () => document.body.dataset.state).toBe('error');

  // Focus claude (busy) even though workbuddy is worse.
  await page.locator('.pill[data-agent="claude"]').click();
  await settled(page, () => document.body.dataset.state).toBe('busy');
  await expect(page.locator('.pill[data-agent="claude"]')).toHaveClass(/focused/);
  await expect(page.locator('.pill[data-agent="workbuddy"]')).not.toHaveClass(/focused/);

  // Click again to clear focus and return to the aggregate (error).
  await page.locator('.pill[data-agent="claude"]').click();
  await settled(page, () => document.body.dataset.state).toBe('error');
  await expect(page.locator('.pill[data-agent="claude"]')).not.toHaveClass(/focused/);
});

test('a long status never widens the page or overflows its pill', async ({ page }) => {
  await api('/state', {
    session: 'a', agent: 'claude', state: 'busy',
    detail: 'running an extremely long command with a great many arguments indeed and then some',
  });
  await settled(page, () => document.querySelectorAll('.pill[data-agent="claude"]').length).toBe(1);

  const m = await page.evaluate(() => {
    const stage = document.getElementById('stage').getBoundingClientRect();
    const pill = document.querySelector('.pill[data-agent="claude"]').getBoundingClientRect();
    return { stageW: Math.round(stage.width), pillW: Math.round(pill.width), bodyScroll: document.body.scrollWidth, bodyClient: document.body.clientWidth };
  });
  expect(m.pillW).toBeLessThanOrEqual(m.stageW);
  expect(m.bodyScroll).toBeLessThanOrEqual(m.bodyClient);
});

// ------------------------------------------------------------ layout stability

// Regression: the lamp slid sideways whenever the status text changed length,
// because the stage was shrink-wrapped around content of varying width.
test('the robot does not move when the status text changes', async ({ page }) => {
  const box = async () => {
    const b = await page.locator('#robot').boundingBox();
    return { x: Math.round(b.x), y: Math.round(b.y) };
  };

  await api('/state', { session: 'a', agent: 'claude', state: 'busy', detail: 'thinking' });
  await settled(page, () => document.querySelector('.pill[data-agent="claude"] span')?.textContent).toContain('thinking');
  const before = await box();

  await api('/state', { session: 'a', agent: 'claude', state: 'busy', detail: 'running a considerably longer command indeed' });
  await settled(page, () => document.querySelector('.pill[data-agent="claude"] span')?.textContent).toContain('considerably');
  expect(await box()).toEqual(before);
});

test('the robot does not move when a second agent appears', async ({ page }) => {
  await api('/state', { session: 'a', agent: 'claude', state: 'busy', detail: 'thinking' });
  await settled(page, () => document.querySelector('.pill[data-agent="claude"]')?.dataset.state).toBe('busy');
  const before = await page.locator('#robot').boundingBox();

  await api('/state', { session: 'b', agent: 'codex', state: 'waiting', detail: 'needs approval' });
  await settled(page, () => document.querySelector('.pill[data-agent="codex"]')?.dataset.state).toBe('waiting');
  const after = await page.locator('#robot').boundingBox();

  expect(Math.round(after.x)).toBe(Math.round(before.x));
  expect(Math.round(after.y)).toBe(Math.round(before.y));
});

// ------------------------------------------------------------------ clipping

// Regression, twice: the window was sized to the content, so the glow was
// sliced off at the edge into a visible box. The robot is drawn in an SVG that
// paints outside its own box, so the stage must keep clear space around it in
// every shape mode.
for (const mode of ['full', 'mini', 'collapsed']) {
  test(`the robot is never clipped in ${mode} mode`, async ({ page }) => {
    await api('/state', { session: 'a', agent: 'claude', state: 'busy' });
    await settled(page, () => document.body.dataset.state).toBe('busy');

    await page.evaluate((m) => {
      document.body.classList.toggle('collapsed', m === 'collapsed');
      document.body.dataset.theme = m === 'mini' ? 'mini' : 'full';
      if (m === 'collapsed') document.getElementById('labels').innerHTML = '';
    }, mode);

    const gap = await page.evaluate(() => {
      const s = document.getElementById('stage').getBoundingClientRect();
      const b = document.getElementById('bot').getBoundingClientRect();
      return {
        top: Math.round(b.top - s.top), bottom: Math.round(s.bottom - b.bottom),
        left: Math.round(b.left - s.left), right: Math.round(s.right - b.right),
      };
    });

    for (const [side, px] of Object.entries(gap)) {
      expect(px, `${side} clearance in ${mode} mode`).toBeGreaterThanOrEqual(GUTTER);
    }
  });
}

// ------------------------------------------------------------ size control

// The settings pane used to open on top of the robot, hiding the very thing it
// configures. It now opens to the right of the machine, and the window widens
// to hold it so the menu is never clipped.
test('the settings menu opens beside the robot, not on top of it', async ({ page }) => {
  await api('/state', { session: 'a', agent: 'claude', state: 'busy' });
  await settled(page, () => document.body.dataset.state).toBe('busy');

  await page.locator('#robot').click({ button: 'right', position: { x: 30, y: 30 } });
  await page.locator('#s-gear').click();
  await expect(page.locator('#menu')).toBeVisible();

  const m = await page.evaluate(() => {
    const robot = document.getElementById('bot').getBoundingClientRect();
    const menu = document.getElementById('menu').getBoundingClientRect();
    return {
      robotRight: robot.right,
      menuLeft: menu.left,
      overlaps: menu.left < robot.right && menu.right > robot.left
        && menu.top < robot.bottom && menu.bottom > robot.top,
    };
  });
  expect(m.menuLeft, '菜单在机器人右边').toBeGreaterThanOrEqual(m.robotRight - 1);
  expect(m.overlaps, '菜单不压住机器人').toBe(false);
});

// Right-click used to open a settings pane where the size slider was one row
// among four. The whole point of a desk robot is that it can be made bigger
// without hunting, and "bigger" has to mean the whole machine — body, tracks,
// arms and gauge — not a bigger lamp on a small robot.
test('right-click opens the size bar, and it scales the whole machine', async ({ page }) => {
  await api('/state', { session: 'a', agent: 'claude', state: 'busy' });
  await settled(page, () => document.body.dataset.state).toBe('busy');

  const width = async (sel) => (await page.locator(sel).boundingBox()).width;
  const before = await width('#bot');
  const pillBefore = await width('.pill[data-agent="claude"]');

  await page.locator('#robot').click({ button: 'right', position: { x: 30, y: 30 } });
  await expect(page.locator('#sizer')).toHaveClass(/on/);

  await page.evaluate(() => {
    const r = document.getElementById('s-range');
    r.value = '150';
    r.dispatchEvent(new Event('input', { bubbles: true }));
  });

  await expect.poll(() => page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--scale').trim())).toBe('1.5');
  // the robot and the agent list scale together: this is a bigger machine on
  // the desk, not a bigger lamp on the same machine
  expect(await width('#bot')).toBeGreaterThan(before * 1.3);
  expect(await width('.pill[data-agent="claude"]')).toBeGreaterThan(pillBefore * 1.3);
});

test('the size bar closes when the click lands somewhere else', async ({ page }) => {
  await page.locator('#robot').click({ button: 'right', position: { x: 30, y: 30 } });
  await expect(page.locator('#sizer')).toHaveClass(/on/);

  const stage = await page.locator('#stage').boundingBox();
  await page.mouse.click(stage.x + 8, stage.y + 8);
  await expect(page.locator('#sizer')).not.toHaveClass(/on/);
});

// 预览只该活 3 秒，或者活到面板收起为止。以前关掉面板（Esc / 再右键）不会结束
// 它：假状态继续挂满 3 秒，而这期间真实状态是被冻结的 —— 灯在说谎。
test('closing the quick panel ends a state preview immediately', async ({ page }) => {
  await api('/state', { session: 'a', agent: 'claude', state: 'busy' });
  await settled(page, () => document.body.dataset.state).toBe('busy');

  await page.locator('#robot').click({ button: 'right', position: { x: 30, y: 30 } });
  await expect(page.locator('#preview')).toHaveClass(/on/);
  await page.locator('#preview button[data-st="error"]').click();
  await expect(page.locator('body')).toHaveAttribute('data-state', 'error');

  await page.keyboard.press('Escape');
  await expect(page.locator('#sizer')).not.toHaveClass(/on/);
  await expect(page.locator('body')).toHaveAttribute('data-state', 'busy');
});

// Regression: `body[data-theme="mini"] #bot` 与 `body.collapsed #bot` 特异性相同、
// 且写在后面 —— mini 下点「收起」只收走软件列表，机器人仍是 210px。
test('collapsing in mini mode still shrinks the robot', async ({ page }) => {
  const w = await page.evaluate(() => {
    document.body.dataset.theme = 'mini';
    document.body.classList.add('collapsed');
    return document.getElementById('bot').getBoundingClientRect().width;
  });
  // mini = 210px；收起后必须是 150px（此时缩放为 100%）。
  expect(w).toBeLessThan(190);
});

// Regression: the slider used to overflow its pill and the window. Chromium
// gives <input type=range> a ~129px content minimum, and without min-width:0 the
// track and thumb spilled out of the bar and off the screen.
test('the quick size slider stays inside its bar and the window', async ({ page }) => {
  await page.locator('#robot').click({ button: 'right', position: { x: 30, y: 30 } });
  await expect(page.locator('#sizer')).toHaveClass(/on/);

  const m = await page.evaluate(() => {
    const bar = document.getElementById('sizer').getBoundingClientRect();
    const r = document.getElementById('s-range').getBoundingClientRect();
    return {
      sliderFits: r.left >= bar.left && r.right <= bar.right,
      barFits: bar.left >= 0 && bar.right <= window.innerWidth && bar.top >= 0 && bar.bottom <= window.innerHeight,
    };
  });
  expect(m.sliderFits, 'the slider must sit inside its bar').toBe(true);
  expect(m.barFits, 'the bar must sit inside the window').toBe(true);
});

test('the settings size slider stays inside its menu', async ({ page }) => {
  await page.locator('#robot').click({ button: 'right', position: { x: 30, y: 30 } });
  await expect(page.locator('#sizer')).toHaveClass(/on/);
  await page.locator('#s-gear').click();
  await expect(page.locator('#menu')).toBeVisible();

  const m = await page.evaluate(() => {
    const menu = document.getElementById('menu').getBoundingClientRect();
    const r = document.getElementById('m-size').getBoundingClientRect();
    return { fits: r.left >= menu.left - 0.5 && r.right <= menu.right + 0.5 };
  });
  expect(m.fits, 'the slider must sit inside the menu').toBe(true);
});

// The interface must be Chinese, with no leftover English chrome. Agent names
// are product names and stay as-is; everything else is translated.
test('the interface text is Chinese', async ({ page }) => {
  await page.locator('#robot').click({ button: 'right', position: { x: 30, y: 30 } });
  await expect(page.locator('#sizer')).toHaveClass(/on/);
  await expect(page.locator('#s-gear')).toHaveAttribute('title', '全部设置');
  await expect(page.locator('#s-range')).toHaveAttribute('aria-label', '机器人尺寸');

  await page.locator('#s-gear').click();
  await expect(page.locator('#menu .title').first()).toHaveText('机器人');
  await expect(page.locator('#m-quit')).toHaveText('退出');
  await expect(page.locator('#disconnected')).toHaveText(/状态未知/);
});

// ---------------------------------------------------------------- fuel gauge

test('no gauge when nothing reports fuel', async ({ page }) => {
  await api('/state', { session: 'a', agent: 'claude', state: 'busy' });
  await settled(page, () => document.body.dataset.state).toBe('busy');
  await settled(page, () => document.getElementById('fuel').classList.contains('on')).toBe(false);
});

test('the gauge fills from the bottom, in proportion', async ({ page }) => {
  await api('/state', { session: 'a', agent: 'claude', state: 'busy' });
  await api('/state', { session: 'a', fuel: { remaining: 61, label: 'plan quota' } });
  await settled(page, () => document.getElementById('fuel').classList.contains('on')).toBe(true);

  const measure = () => page.evaluate(() => {
    const track = document.getElementById('fuel').getBoundingClientRect();
    const fill = document.querySelector('#fuel b').getBoundingClientRect();
    return {
      bottomAligned: Math.abs(track.bottom - fill.bottom) <= 1,
      ratio: fill.height / track.height,
      topGap: fill.top - track.top,
    };
  });
  await expect.poll(async () => (await measure()).ratio, { timeout: 4000 }).toBeGreaterThan(0.5);
  const g = await measure();

  expect(g.bottomAligned, 'fill is anchored to the bottom of the track').toBe(true);
  expect(g.ratio).toBeGreaterThan(0.55);
  expect(g.ratio).toBeLessThan(0.67);
  expect(g.topGap, 'an unfilled remainder is visible above').toBeGreaterThan(0);
});

// The beacon already owns red/amber/green. If the gauge used them at normal
// levels, the same three colours would carry two meanings on one small widget.
test('the gauge is neutral until it is genuinely low', async ({ page }) => {
  const fillColour = () => page.evaluate(() => getComputedStyle(document.querySelector('#fuel b')).backgroundColor);
  await api('/state', { session: 'a', agent: 'claude', state: 'busy' });

  await api('/state', { session: 'a', fuel: { remaining: 61 } });
  await settled(page, () => document.getElementById('fuel').dataset.level).toBe('ok');
  const neutral = await fillColour();
  expect(neutral).not.toBe('rgb(52, 199, 89)');   // not the green state
  expect(neutral).not.toBe('rgb(255, 204, 0)');   // not the amber state
  expect(neutral).not.toBe('rgb(255, 59, 48)');   // not the red state

  await api('/state', { session: 'a', fuel: { remaining: 20 } });
  await settled(page, () => document.getElementById('fuel').dataset.level).toBe('mid');
  await expect.poll(fillColour, { timeout: 4000 }).toBe('rgb(255, 204, 0)');

  await api('/state', { session: 'a', fuel: { remaining: 5 } });
  await settled(page, () => document.getElementById('fuel').dataset.level).toBe('low');
  await expect.poll(fillColour, { timeout: 4000 }).toBe('rgb(255, 59, 48)');
});

// The overlay window is transparent and floats over an unknown desktop, so a
// translucent track disappeared and the gauge read as a bar of arbitrary
// length. The unfilled portion is half the information.
test('the empty part of the gauge is visible over any background', async ({ page }) => {
  await api('/state', { session: 'a', agent: 'claude', state: 'busy' });
  await api('/state', { session: 'a', fuel: { remaining: 61 } });
  await settled(page, () => document.getElementById('fuel').classList.contains('on')).toBe(true);

  const track = await page.evaluate(() => getComputedStyle(document.getElementById('fuel')).backgroundColor);
  const image = await page.evaluate(() => getComputedStyle(document.getElementById('fuel')).backgroundImage);

  // Either an opaque colour or a gradient — never a translucent tint that the
  // desktop shows straight through.
  const alpha = track.startsWith('rgba') ? Number(track.split(',')[3]) : 1;
  const opaque = image !== 'none' || alpha === 1;
  expect(opaque, `track must not be see-through (bg: ${track}, image: ${image})`).toBe(true);

  // And it must differ from the fill, or there is nothing to read the level against.
  const fill = await page.evaluate(() => getComputedStyle(document.querySelector('#fuel b')).backgroundColor);
  expect(fill).not.toBe(track);
});

test('a fuel update does not disturb the beacon', async ({ page }) => {
  await api('/state', { session: 'a', agent: 'claude', state: 'waiting', detail: 'needs you' });
  await settled(page, () => document.body.dataset.state).toBe('waiting');

  await api('/state', { session: 'a', fuel: { remaining: 5 } });
  await settled(page, () => document.getElementById('fuel').dataset.level).toBe('low');
  expect(await page.evaluate(() => document.body.dataset.state)).toBe('waiting');
});

// A session that reported once and went silent must not look as confident as
// one that just spoke. This is what made a non-reporting second window read as
// a healthy "ready".
test('a quiet session is visibly dimmed', async ({ page }) => {
  await api('/state', { session: 'a', agent: 'claude', state: 'idle' });
  await settled(page, () => document.querySelectorAll('.pill[data-agent="claude"]').length).toBe(1);
  const fresh = await page.evaluate(() => getComputedStyle(document.querySelector('.pill[data-agent="claude"]')).opacity);
  expect(Number(fresh)).toBeGreaterThan(0.9);

  // Render a quiet session directly: the server's own threshold is 90s, far too
  // long to wait for, and this asserts the rendering rule rather than the clock.
  await page.evaluate(() => {
    const pill = document.querySelector('.pill[data-agent="claude"]');
    pill.classList.add('quiet');
  });
  const quiet = await page.evaluate(() => getComputedStyle(document.querySelector('.pill[data-agent="claude"]')).opacity);
  expect(Number(quiet)).toBeLessThan(0.6);
});

// The worst failure this tool can have: the server goes away and the window
// keeps showing its last frame at full confidence. A frozen green tells the
// user their agent has finished while it is still working. Disconnected is not
// a state the agent is in — it is us not knowing, and the robot must power down.
test('a lost connection darkens the robot instead of freezing it', async ({ page }) => {
  await api('/state', { session: 'a', agent: 'claude', state: 'busy' });
  await settled(page, () => document.body.dataset.state).toBe('busy');

  const lit = await page.evaluate(() => getComputedStyle(document.getElementById('status-led')).fill);
  expect(lit, 'the beacon is lit while connected').toBe('rgb(52, 199, 89)');

  // Simulate the server disappearing, exactly as the page sees it.
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await page.evaluate(() => document.body.classList.add('disconnected'));

  const dark = await page.evaluate(() => getComputedStyle(document.getElementById('status-led')).fill);
  expect(dark, 'no state colour may survive the disconnect').not.toBe(lit);

  const filter = await page.evaluate(() => getComputedStyle(document.getElementById('bot')).filter);
  expect(filter, 'the robot visibly powers down').toContain('grayscale');

  await expect(page.locator('#disconnected')).toBeVisible();
});

// 断开时那行提示必须一起消失：它会在「状态未知」正上方继续断言一件此刻无法
// 知道的事（「Claude Code 正在运行」「自检发现 2 个问题」）。而且 flashNote 的
// 1.6 秒定时器不能把旧快照重新渲染回来，把过期文案又写上去。
test('losing the connection clears the note line and keeps it clear', async ({ page }) => {
  await page.evaluate(() => document.getElementById('btn-menu').click());
  await page.evaluate(() => {
    for (const s of document.querySelectorAll('#menu summary')) {
      if (s.textContent.trim() === '系统') s.parentElement.open = true;
    }
  });
  // 打开提示音 → flashNote 显示「提示音已开启」，并起一个 1.6 秒的定时器。
  await page.evaluate(() => {
    const el = document.getElementById('m-sound');
    el.checked = true;
    el.dispatchEvent(new Event('change'));
  });
  await expect(page.locator('#note')).toBeVisible();

  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await page.evaluate(() => document.body.classList.add('disconnected'));
  await expect(page.locator('#note')).toBeHidden();

  // 等过 flashNote 的 1.6 秒定时器：它不许把过期文案写回来。
  await page.waitForTimeout(1900);
  await expect(page.locator('#note')).toBeHidden();
});

// ------------------------------------------------------------------ offline

// "Nothing is running" and "Claude is running but its hooks are not wired up"
// are indistinguishable from the outside, and only one of them is the user's
// fault. The display must never claim the first when it can prove the second —
// but it may only claim the second on real evidence, which is platform- and
// machine-dependent, so both honest branches are asserted here.
test('with nothing connected the robot never claims a state', async ({ page }) => {
  const snap = await (await fetch(base + '/state')).json();
  const running = snap.presence === true;    // a Claude process exists on this machine

  await api('/state', { session: 'a', agent: 'claude', state: 'busy' });
  await settled(page, () => document.body.dataset.state).toBe('busy');

  await api('/state', { session: 'a', state: 'offline' });
  // Rows never disappear — every software keeps its dark row — but none may
  // claim a live state when nothing is reporting.
  await settled(page, () => document.querySelectorAll('.pill').length).toBe(5);
  await settled(page, () => document.querySelectorAll('.pill.offline').length).toBe(5);

  if (running) {
    // It can prove Claude exists, so it says "not reporting" instead of "off".
    await settled(page, () => document.body.dataset.state).toBe('unknown');
    await expect(page.locator('#note')).toBeVisible();
    const colour = await page.evaluate(() => document.getElementById('status-led').dataset.color);
    expect(colour, 'never a state colour on a guess').toBe('grey');
  } else {
    await settled(page, () => document.body.dataset.state).toBe('offline');
    await settled(page, () => document.getElementById('status-led').classList.contains('on')).toBe(false);
  }
});

// ---------------------------------------------------------------- autonomous

// The robot must feel alive when nothing is running. This once regressed: the
// idle-action gate required "cursor invisible", which desktop mode never
// satisfies, so the robot sat frozen like a brick. `#bot[data-idle]` writes the
// current action number (empty = none), giving us a stable thing to wait for.
test('the offline robot performs an autonomous action on its own', async ({ page }) => {
  await api('/state', { session: 'a', agent: 'claude', state: 'idle' });
  await settled(page, () => document.body.dataset.state).toBe('idle');

  const action = () => page.evaluate(() => document.getElementById('bot').dataset.idle || '');
  await expect.poll(action, { timeout: 20000 }).not.toBe('');
});

// ------------------------------------------------------------- slot table

// 槽位表由服务端下发：多接一个软件，界面自动多一行、多一段灯环，前端不需要
// 改一行代码。这条用「设置里的软件顺序」当观察点 —— 它读的就是这份表。
test('a software the server adds shows up without touching the front end', async ({ page }) => {
  await api('/state', { session: 'd1', agent: 'deploy', state: 'busy' });
  await settled(page, () => document.body.dataset.state).toBe('busy');

  await expect.poll(
    () => page.evaluate(() => [...document.querySelectorAll('#m-order .row span')].map((el) => el.textContent)),
    { timeout: 4000 }
  ).toContain('deploy');

  // 而且它排在四个已知软件之后，位置由服务端决定。
  const order = await page.evaluate(() => [...document.querySelectorAll('#m-order .row span')].map((el) => el.textContent));
  expect(order[order.length - 1]).toBe('deploy');
});

// ---------------------------------------------------------------- spoken

// 这个工具的主输出是颜色，而颜色对看不见屏幕的人没有信息量。状态必须还有一条
// 文字通道，并且它得真的隐形 —— 一个 1px 的区域也不能把机器人或灯挤歪。
test('state changes are spoken, not only coloured', async ({ page }) => {
  await api('/state', { session: 'a', agent: 'claude', state: 'waiting' });
  await settled(page, () => document.body.dataset.state).toBe('waiting');

  const live = () => page.evaluate(() => document.getElementById('live').textContent);
  await expect.poll(live).toContain('需要你');
  expect(await live(), 'it must name the software too').toContain('Claude Code');

  const box = await page.evaluate(() => {
    const el = document.getElementById('live');
    const r = el.getBoundingClientRect();
    return {
      w: r.width, h: r.height,
      role: el.getAttribute('role'), polite: el.getAttribute('aria-live'),
    };
  });
  expect(box.role).toBe('status');
  expect(box.polite).toBe('polite');
  expect(box.w, 'visually hidden, still audible').toBeLessThanOrEqual(1);
  expect(box.h).toBeLessThanOrEqual(1);

  await api('/state', { session: 'a', agent: 'claude', state: 'busy' });
  await settled(page, () => document.body.dataset.state).toBe('busy');
  await expect.poll(live).toContain('运行中');
});

// ------------------------------------------------------------- local trust

// three 的颜色管理对 `#rrggbb` 和 0xrrggbb 做同样的 sRGB→linear 转换，所以把
// 材质色从十六进制数换成 palette 里的 CSS 字符串不会改变画面。这条断言把那个
// 假设钉住 —— 将来升级 three 时如果改了转换策略，这里会先红，而不是等用户发现
// 机器人颜色变了。
test('a CSS hex and a packed hex resolve to the same colour', async ({ page }) => {
  const same = await page.evaluate(async () => {
    const THREE = await import('/vendor/three.module.js');
    return new THREE.Color('#c9a238').getHexString() === new THREE.Color(0xc9a238).getHexString();
  });
  expect(same).toBe(true);
});

// CSP 是「注入也执行不了」的最后一道闸。它一旦配错（漏了 img-src、把模块挡在
// script-src 外），页面会照样画出一半，只在控制台里留一条违规 —— 所以断言这里
// 一条都不能有。
test('the page runs under the strict policy with no violations', async ({ page }) => {
  const violations = [];
  page.on('console', (m) => {
    if (/Content Security Policy/i.test(m.text())) violations.push(m.text());
  });
  await page.goto(base + '/');
  await page.waitForFunction(() => document.body.dataset.state !== undefined);
  // 等首帧 3D 与纹理都跑过一遍：被 CSP 挡掉的资源才会出现在控制台。
  await expect.poll(() => page.evaluate(() => !!document.querySelector('#bot canvas')), { timeout: 8000 }).toBe(true);
  await page.waitForTimeout(500);
  expect(violations).toEqual([]);
});

// 这个服务活在 127.0.0.1 上，而浏览器对「本机地址」没有额外敬畏：任何网页都能
// 往这个端口发请求。一个 <img src="…/set/busy"> 就能让机器人替别人的网站举手，
// 而这套设计唯一的承诺就是灯不说谎。所以写入必须带本机 token。
test('a write without the local token is refused', async () => {
  const res = await fetch(`${base}/state`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session: 'untrusted', agent: 'claude', state: 'waiting' }),
  });
  expect(res.status, 'no token, no write').toBe(401);

  const snap = await (await fetch(base + '/state')).json();
  expect(snap.sessions.some((s) => s.session === 'untrusted'), 'nothing was recorded').toBe(false);
});

// 带 token 也不行：另一个源的页面连读都不该读到（cwd 里有你的项目路径），
// 更不用说写。这就是 Host/Origin 两道检查存在的原因。
test('a cross-origin page can neither drive nor read the robot', async () => {
  const write = await fetch(`${base}/set/busy?agent=claude`, { headers: { origin: 'https://evil.example' } });
  expect(write.status, 'a foreign origin cannot move the lamp').toBe(403);

  const read = await fetch(base + '/state', { headers: { origin: 'https://evil.example' } });
  expect(read.status).toBe(403);
  expect(read.headers.get('access-control-allow-origin'), 'and gets no CORS pass').toBeNull();
});

// agent 名是服务端字符串，必须当文本处理。它曾经被拼进 innerHTML，于是
// `bao set busy --agent '<img onerror=…>'` 能在页面里执行脚本 —— 而页面手里
// 有 preload 暴露的通知、开终端、退出。
test('an agent name is shown as text, never as markup', async ({ page }) => {
  const name = '<img src=x onerror="window.__pwned=1">';
  // 第一次出现只记「已知」，不算一次状态变化；第二次才是要渲染到「最近动态」的那条。
  await api('/state', { session: 'xss', agent: name, state: 'busy' });
  await settled(page, () => document.body.dataset.state).toBe('busy');
  await api('/state', { session: 'xss', agent: name, state: 'waiting' });
  await settled(page, () => document.body.dataset.state).toBe('waiting');

  // 「最近动态」只在设置菜单里可见，而菜单关着时面板不重建（看不见的东西不画）。
  // 打开它 —— 这也正是用户看到这条记录的路径。
  await page.evaluate(() => document.getElementById('btn-menu').click());

  expect(await page.evaluate(() => document.getElementById('m-recent').innerHTML)).not.toContain('<img');
  expect(await page.evaluate(() => window.__pwned)).toBeUndefined();
  expect(await page.evaluate(() => document.getElementById('m-recent').textContent)).toContain('onerror');
});

// 工具栏和尺寸条都只认指针。键盘用户至少要有办法打开设置、关掉浮层，
// 否则「自定义」这个功能对他们是完全不存在的。
test('the settings menu can be opened and closed from the keyboard', async ({ page }) => {
  const open = () => page.evaluate(() => !document.getElementById('menu').hidden);

  await page.evaluate(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: ',', ctrlKey: true, bubbles: true }));
  });
  expect(await open(), 'Ctrl+, opens settings').toBe(true);

  await page.keyboard.press('Escape');
  expect(await open(), 'Escape closes it again').toBe(false);
});

// 工具栏隐藏时仍在 tab 序列里（opacity:0 不会移除焦点）。聚焦到它上面时
// 必须现身，否则用户看不到自己正在操作什么。
test('the hidden toolbar reveals itself when it takes focus', async ({ page }) => {
  await page.evaluate(() => document.getElementById('btn-quit').focus());
  expect(await page.evaluate(() => document.getElementById('bar').matches(':focus-within'))).toBe(true);
  expect(await page.evaluate(() => getComputedStyle(document.getElementById('bar')).opacity)).toBe('1');
});

// 纯键盘走查：不靠鼠标也能依序到达四个工具栏按钮，而且每聚焦一个，工具栏就现身。
test('keyboard users can reach every toolbar control in order', async ({ page }) => {
  const reached = new Set();
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press('Tab');
    const id = await page.evaluate(() => document.activeElement && document.activeElement.id);
    if (!id) continue;
    reached.add(id);
    if (['btn-menu', 'btn-theme', 'btn-collapse', 'btn-quit'].includes(id)) {
      const opacity = await page.evaluate(() => getComputedStyle(document.getElementById('bar')).opacity);
      expect(Number(opacity), `toolbar must reveal when ${id} is focused`).toBe(1);
    }
  }
  for (const id of ['btn-menu', 'btn-theme', 'btn-collapse', 'btn-quit']) {
    expect(reached.has(id), `Tab should reach ${id}`).toBe(true);
  }
});

// 「请执行 bao connect claude」只写在画面上，读屏用户就永远不知道该敲什么。
test('the two advisory lines are announced, not only drawn', async ({ page }) => {
  for (const id of ['note', 'disconnected']) {
    await expect(page.locator('#' + id)).toHaveAttribute('role', 'status');
    await expect(page.locator('#' + id)).toHaveAttribute('aria-live', 'polite');
  }
});

// ------------------------------------------------------------ system panel

// CPU / 内存面板：数字来自 /sys，开关要真的生效，而且它是中性色 ——
// 红黄绿已经被代理状态占满。
test('the system panel shows real numbers and can be turned off', async ({ page }) => {
  await expect(page.locator('#sys')).toBeVisible();
  await expect(page.locator('#sys-cpu')).toHaveText(/^\d+%$/);
  await expect(page.locator('#sys-mem')).toHaveText(/^\d+%$/);

  await page.evaluate(() => {
    const el = document.getElementById('m-sys');
    el.checked = false;
    el.dispatchEvent(new Event('change'));
  });
  await expect(page.locator('#sys')).toBeHidden();

  await page.evaluate(() => {
    const el = document.getElementById('m-sys');
    el.checked = true;
    el.dispatchEvent(new Event('change'));
  });
  await expect(page.locator('#sys')).toBeVisible();
});

// 广告牌曾经挂在会被体型缩放的机器人组上：默认体型顶边正好贴边，Q 版直接
// 出画。现在它挂在场景里，任何一种体型下四角都必须留在画面内。
test('the scoreboard stays inside the frame in every body type', async ({ page }) => {
  await expect.poll(() => page.evaluate(() => Number(document.getElementById('bot').dataset.signEdge)))
    .toBeLessThan(0.98);

  for (const body of ['Q版', '修长', '标准']) {
    await page.evaluate((b) => {
      const s = document.getElementById('m-body');
      s.value = b;
      s.dispatchEvent(new Event('change'));
    }, body);
    await expect.poll(
      () => page.evaluate(() => Number(document.getElementById('bot').dataset.signEdge)),
      { timeout: 4000 }
    ).toBeLessThan(0.98);
  }
});

// 自定义皮肤：挑一个任意颜色当身体主色，色块与取色器即时跟随；换回固定皮肤时
// 取色器收起。做旧纹理由机器人侧保留，这里只钉住 UI 契约。
test('a custom skin colour is applied and the picker follows the selection', async ({ page }) => {
  await page.evaluate(() => document.getElementById('btn-menu').click());
  // 皮肤下拉在「外观」details 里，默认折叠；先展开，否则不可交互。
  await page.evaluate(() => {
    for (const s of document.querySelectorAll('#menu summary')) {
      if (s.textContent.trim() === '外观') s.parentElement.open = true;
    }
  });

  // 出厂状态：取色器行是收起的（它只在选了「自定义」之后才该出现）
  await expect(page.locator('#custom-skin-row')).toBeHidden();

  // 选「自定义」→ 取色器行现身
  await page.selectOption('#m-skin', '自定义');
  await expect(page.locator('#custom-skin-row')).toBeVisible();

  // 改颜色 → 色块即时变成这个颜色（rgb(58,165,201) = #3aa5c9）
  await page.evaluate(() => {
    const el = document.getElementById('m-skin-custom');
    el.value = '#3aa5c9';
    el.dispatchEvent(new Event('input'));
    el.dispatchEvent(new Event('change'));
  });
  await expect(page.locator('#skin-swatch')).toHaveCSS('background-color', 'rgb(58, 165, 201)');

  // 换回固定皮肤 → 取色器行收起，色块回到固定色
  await page.selectOption('#m-skin', '做旧黄');
  await expect(page.locator('#custom-skin-row')).toBeHidden();
  await expect(page.locator('#skin-swatch')).toHaveCSS('background-color', 'rgb(201, 162, 56)');
});

// 自定义配色覆盖四个部位，而不只是皮肤：每条取色器只影响自己那一项，
// 换回固定配色就收起；「重置外观」把它们全部收回出厂值。
test('custom colours are per part and reset with the look', async ({ page }) => {
  await page.evaluate(() => document.getElementById('btn-menu').click());
  await page.evaluate(() => {
    for (const s of document.querySelectorAll('#menu summary')) {
      if (s.textContent.trim() === '外观') s.parentElement.open = true;
    }
  });

  const setColor = (id, value) => page.evaluate(({ id, value }) => {
    const el = document.getElementById(id);
    el.value = value;
    el.dispatchEvent(new Event('input'));
    el.dispatchEvent(new Event('change'));
  }, { id, value });

  // 眼睛
  await page.selectOption('#m-eyestyle', '自定义');
  await expect(page.locator('#custom-eye-row')).toBeVisible();
  await setColor('m-eyestyle-custom', '#3aa5c9');
  await expect(page.locator('#eye-swatch')).toHaveCSS('background-color', 'rgb(58, 165, 201)');

  // 履带与配件各自独立：换一个部位不会把上一个颜色带走。
  await page.selectOption('#m-trackstyle', '自定义');
  await setColor('m-trackstyle-custom', '#223344');
  await expect(page.locator('#track-swatch')).toHaveCSS('background-color', 'rgb(34, 51, 68)');
  await page.selectOption('#m-armskin', '自定义');
  await setColor('m-armskin-custom', '#8899aa');
  await expect(page.locator('#arm-swatch')).toHaveCSS('background-color', 'rgb(136, 153, 170)');
  // 上一项仍然是刚才那个颜色，没有被后一次覆盖。
  await expect(page.locator('#eye-swatch')).toHaveCSS('background-color', 'rgb(58, 165, 201)');

  // 四项都没对上任何主题 → 主题下拉自动落到「自定义」。
  await expect(page.locator('#m-theme')).toHaveValue('自定义');

  // 把皮肤换回固定色，只收起皮肤那条取色器。
  await page.selectOption('#m-skin', '做旧黄');
  await expect(page.locator('#custom-skin-row')).toBeHidden();
  await expect(page.locator('#custom-eye-row')).toBeVisible();

  // 重置外观：四条取色器全部收起，色块回到 palette 的出厂值。
  await page.evaluate(() => document.getElementById('m-reset-look').click());
  for (const row of ['#custom-skin-row', '#custom-eye-row', '#custom-track-row', '#custom-arm-row']) {
    await expect(page.locator(row)).toBeHidden();
  }
  await expect(page.locator('#eye-swatch')).toHaveCSS('background-color', 'rgb(27, 36, 44)');
  await expect(page.locator('#m-theme')).toHaveValue('经典战损黄');
});

// 广告牌颜色也能自定义：任意十六进制直接下发给场景（牌子是 canvas 画的，
// 没有理由锁死在八色调色板里）。切回固定颜色时取色器收起。
test('the sign colour accepts a custom hex', async ({ page }) => {
  await page.evaluate(() => document.getElementById('btn-menu').click());
  await page.evaluate(() => {
    for (const s of document.querySelectorAll('#menu summary')) {
      if (s.textContent.trim() === '广告牌') s.parentElement.open = true;
    }
  });
  await page.evaluate(() => {
    window.__signs = [];
    window.addEventListener('bao:sign', (e) => window.__signs.push(e.detail));
  });

  await page.selectOption('#m-sign-color', '自定义');
  await expect(page.locator('#custom-sign-row')).toBeVisible();
  await page.evaluate(() => {
    const el = document.getElementById('m-sign-color-custom');
    el.value = '#12ab34';
    el.dispatchEvent(new Event('input'));
    el.dispatchEvent(new Event('change'));
  });
  await expect.poll(() => page.evaluate(() => window.__signs.at(-1)?.color)).toBe('#12ab34');

  // 切回调色板里的颜色：收起取色器，下发的颜色回到那个固定值。
  await page.selectOption('#m-sign-color', '青色');
  await expect(page.locator('#custom-sign-row')).toBeHidden();
  await expect.poll(() => page.evaluate(() => window.__signs.at(-1)?.color)).toBe('#4ad5ff');
});

// 场景按时间自动切换：打开后由时间决定白天/夜晚场景，手动那个下拉置灰但仍然
// 显示「此刻生效的是哪一档」。关掉后回到手动。
test('scenes can switch automatically between day and night', async ({ page }) => {
  await page.evaluate(() => document.getElementById('btn-menu').click());
  await page.evaluate(() => {
    for (const s of document.querySelectorAll('#menu summary')) {
      if (s.textContent.trim() === '场景') s.parentElement.open = true;
    }
  });

  // 默认：自动切换关，白天/夜晚选项隐藏，手动场景下拉可用。
  await expect(page.locator('#autoscene-opts')).toBeHidden();
  await expect(page.locator('#m-scene')).toBeEnabled();

  // 打开自动切换：选项出现，手动下拉置灰。
  await page.evaluate(() => {
    const el = document.getElementById('m-autoscene');
    el.checked = true;
    el.dispatchEvent(new Event('change'));
  });
  await expect(page.locator('#autoscene-opts')).toBeVisible();
  await expect(page.locator('#m-scene')).toBeDisabled();

  // 把「夜晚时段」设成覆盖此刻（00:00 → 23:59），夜晚场景设为「星空」→ 应立刻切到星空。
  await page.evaluate(() => {
    const set = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event('change')); };
    set('m-nightscene', '星空');
    set('m-night-start', '00:00');
    set('m-night-end', '23:59');
  });
  await expect(page.locator('#m-scene')).toHaveValue('星空');

  // 关掉自动切换：选项收起、手动下拉恢复可用。
  await page.evaluate(() => {
    const el = document.getElementById('m-autoscene');
    el.checked = false;
    el.dispatchEvent(new Event('change'));
  });
  await expect(page.locator('#autoscene-opts')).toBeHidden();
  await expect(page.locator('#m-scene')).toBeEnabled();
});

// 焦点在输入框里时 Esc 只交出焦点，不能把整块设置连刚输入的文字一起关掉。
test('Escape inside a text field does not close the whole settings panel', async ({ page }) => {
  await page.evaluate(() => document.getElementById('btn-menu').click());
  await expect(page.locator('#menu')).toBeVisible();
  await page.evaluate(() => {
    for (const s of document.querySelectorAll('#menu summary')) {
      if (s.textContent.trim() === '广告牌') s.parentElement.open = true;
    }
  });

  const input = page.locator('#m-nameplate');
  await input.click();
  await input.fill('小助手');
  await page.keyboard.press('Escape');

  // 菜单还在、输入还在，只是焦点被交了出去。
  await expect(page.locator('#menu')).toBeVisible();
  await expect(input).toHaveValue('小助手');
  expect(await page.evaluate(() => document.activeElement && document.activeElement.id)).not.toBe('m-nameplate');

  // 焦点不在输入框后，再按一次 Esc 才关菜单。
  await page.keyboard.press('Escape');
  await expect(page.locator('#menu')).toBeHidden();
});

// 全局快捷键是系统级的，有些人不想被任何程序常驻抢键 —— 设置里可以关掉。
test('the global hotkey can be switched off', async ({ page }) => {
  await page.evaluate(() => document.getElementById('btn-menu').click());
  await page.evaluate(() => {
    for (const s of document.querySelectorAll('#menu summary')) {
      if (s.textContent.trim() === '系统') s.parentElement.open = true;
    }
  });
  const box = page.locator('#m-hotkey');
  await expect(box).toBeChecked();
  await box.uncheck();
  await expect(box).not.toBeChecked();
});

// 提示音音量过去只有配置项、没有入口。滑块要即时反映在百分比上（松手才落盘）。
test('the cue volume slider reports its own value', async ({ page }) => {
  await page.evaluate(() => document.getElementById('btn-menu').click());
  await page.evaluate(() => {
    for (const s of document.querySelectorAll('#menu summary')) {
      if (s.textContent.trim() === '系统') s.parentElement.open = true;
    }
  });
  await page.evaluate(() => {
    const el = document.getElementById('m-soundvol');
    el.value = '45';
    el.dispatchEvent(new Event('input'));
  });
  await expect(page.locator('#m-soundvol-val')).toHaveText('45%');
});

// 静音时长可选：开半小时的会和出两小时的门不是一回事，按钮上要写清楚。
test('the mute duration is configurable and shown on the button', async ({ page }) => {
  await page.evaluate(() => document.getElementById('btn-menu').click());
  await page.evaluate(() => {
    for (const s of document.querySelectorAll('#menu summary')) {
      if (s.textContent.trim() === '系统') s.parentElement.open = true;
    }
  });
  await page.selectOption('#m-mutedur', '30');
  await expect(page.locator('#m-mute')).toContainText('30 分钟');
  await page.selectOption('#m-mutedur', '120');
  await expect(page.locator('#m-mute')).toContainText('2 小时');
});

// 菜单底部的「今日战绩 / 最近动态」两块面板可以各自收起：纯显示开关，
// 不影响灯与通知，只是让菜单短一截。
test('the score and recent panels can be hidden independently', async ({ page }) => {
  await page.evaluate(() => document.getElementById('btn-menu').click());
  await page.evaluate(() => {
    for (const s of document.querySelectorAll('#menu summary')) {
      if (s.textContent.trim() === '系统') s.parentElement.open = true;
    }
  });

  await page.evaluate(() => {
    const el = document.getElementById('m-score-panel');
    el.checked = false;
    el.dispatchEvent(new Event('change'));
  });
  await expect(page.locator('#panel-score')).toBeHidden();
  await expect(page.locator('#panel-recent')).toBeVisible();

  await page.evaluate(() => {
    const el = document.getElementById('m-recent-panel');
    el.checked = false;
    el.dispatchEvent(new Event('change'));
  });
  await expect(page.locator('#panel-recent')).toBeHidden();

  await page.evaluate(() => {
    for (const id of ['m-score-panel', 'm-recent-panel']) {
      const el = document.getElementById(id);
      el.checked = true;
      el.dispatchEvent(new Event('change'));
    }
  });
  await expect(page.locator('#panel-score')).toBeVisible();
  await expect(page.locator('#panel-recent')).toBeVisible();
});

// 尺寸模式现在有两个入口（工具栏图标 + 设置下拉）。两个入口必须指向同一个开关，
// 否则「点了按钮，下拉还写着完整」这种自相矛盾会一直存在。
test('the size mode select and the toolbar button agree', async ({ page }) => {
  await page.evaluate(() => document.getElementById('btn-menu').click());
  await expect(page.locator('#m-thememode')).toHaveValue('full');

  await page.evaluate(() => document.getElementById('btn-theme').click());
  await expect(page.locator('#m-thememode')).toHaveValue('mini');
  await expect(page.locator('body')).toHaveAttribute('data-theme', 'mini');

  await page.selectOption('#m-thememode', 'full');
  await expect(page.locator('body')).toHaveAttribute('data-theme', 'full');
});

// 每日目标是用户自己定的刻度：只出现在战绩面板里，不参与任何状态判断。
test('a daily goal shows as progress in the scoreboard', async ({ page }) => {
  await api('/state', { session: 'a', agent: 'claude', state: 'busy' });
  await settled(page, () => document.body.dataset.state).toBe('busy');
  await page.evaluate(() => document.getElementById('btn-menu').click());

  await page.selectOption('#m-goal', '2');
  const goal = page.locator('#m-score .goal');
  await expect(goal).toHaveCount(1);
  await expect(goal).toContainText('每日目标');
  await expect(goal).toContainText('/ 2 时');

  await page.selectOption('#m-goal', '0');
  await expect(page.locator('#m-score .goal')).toHaveCount(0);
});

// 软件改名只改显示名：列表、顺序列表、铭牌/通知都拿这一个名字，而服务端
// 上报的 agent 键不变（状态匹配不能因为改名而失效）。清空即恢复默认。
test('renaming a software changes its label, not its state key', async ({ page }) => {
  await api('/state', { session: 'a', agent: 'claude', state: 'busy' });
  await settled(page, () => document.querySelector('.pill[data-agent="claude"] b')?.textContent).toBe('Claude Code');

  await page.evaluate(() => document.getElementById('btn-menu').click());
  await page.evaluate(() => {
    for (const s of document.querySelectorAll('#menu summary')) {
      if (s.textContent.trim() === '软件') s.parentElement.open = true;
    }
  });

  const input = page.getByLabel('给「Claude Code」改名');
  await input.fill('项目A');
  await expect(page.locator('.pill[data-agent="claude"] b')).toHaveText('项目A');
  await expect(page.locator('#m-order .row[data-agent="claude"] span')).toHaveText('项目A');

  // agent 键没变：同一条会话进入 waiting，颜色照常变。
  await api('/state', { session: 'a', agent: 'claude', state: 'waiting' });
  await settled(page, () => {
    const el = document.querySelector('.pill[data-agent="claude"]');
    return el ? el.querySelector('i').dataset.color : null;
  }).toBe('amber');

  // 清空 → 回到内置名。
  await input.fill('');
  await expect(page.locator('.pill[data-agent="claude"] b')).toHaveText('Claude Code');
});

// 逐个软件的通知开关：关掉只影响通知，灯与列表照旧；列表行会说明「通知已关闭」，
// 否则「它出错了我怎么没收到通知」会变成一个查不出来的问题。
test('a software can have its notifications turned off', async ({ page }) => {
  await api('/state', { session: 'a', agent: 'claude', state: 'error' });
  await settled(page, () => document.body.dataset.state).toBe('error');

  await page.evaluate(() => document.getElementById('btn-menu').click());
  await page.evaluate(() => {
    for (const s of document.querySelectorAll('#menu summary')) {
      if (s.textContent.trim() === '软件') s.parentElement.open = true;
    }
  });

  const bell = page.getByLabel('接收「Claude Code」的系统通知');
  await bell.uncheck();
  await expect(page.locator('.pill[data-agent="claude"]')).toHaveAttribute('aria-label', /系统通知已关闭/);
  // 灯的颜色不受影响：关的是通知，不是状态。
  await expect(page.locator('.pill[data-agent="claude"] i')).toHaveAttribute('data-color', 'red');

  await bell.check();
  await expect(page.locator('.pill[data-agent="claude"]')).not.toHaveAttribute('aria-label', /系统通知已关闭/);
});

// 设置搜索：控件已经过五十个、分组十个，记得住名字但记不住位置。过滤只改
// 可见性，清空后必须回到完整菜单（包括用户原本展开的分组）。
test('the settings search filters rows and restores them', async ({ page }) => {
  await page.evaluate(() => document.getElementById('btn-menu').click());
  const find = page.locator('#m-find');

  await find.fill('亮度');
  await expect(page.locator('#m-brightness')).toBeVisible();
  await expect(page.locator('#m-body')).toBeHidden();
  await expect(page.locator('#m-find-empty')).toBeHidden();

  // 分组名/组内小标题也算命中：输入「名称」应该露出改名那一块，而不是报「没有」。
  await find.fill('名称');
  await expect(page.locator('#m-alias input').first()).toBeVisible();
  await expect(page.locator('#m-find-empty')).toBeHidden();

  await find.fill('没有这个词');
  await expect(page.locator('#m-find-empty')).toBeVisible();
  await expect(page.locator('#m-brightness')).toBeHidden();

  await find.fill('');
  await expect(page.locator('#m-body')).toBeVisible();
  await expect(page.locator('#m-brightness')).toBeVisible();
  await expect(page.locator('#m-find-empty')).toBeHidden();

  // 回归：搜索清空时不能顺手把「自定义配色」的取色器行放出来 —— 那一行的
  // 隐藏状态属于配色本身，不属于搜索。
  await page.evaluate(() => {
    for (const s of document.querySelectorAll('#menu summary')) {
      if (s.textContent.trim() === '外观') s.parentElement.open = true;
    }
  });
  await find.fill('皮肤');
  await expect(page.locator('#custom-skin-row')).toBeHidden();
  await find.fill('');
  await expect(page.locator('#custom-skin-row')).toBeHidden();
});

// 点一下机器人的反应可以关掉：不是所有人都想在工作时被一只小机器人弹一下。
test('the click reaction can be changed', async ({ page }) => {
  await page.evaluate(() => {
    window.__react = [];
    for (const e of ['bao:poke', 'bao:greet']) window.addEventListener(e, () => window.__react.push(e));
  });
  const pick = (value) => page.evaluate((v) => {
    const el = document.getElementById('m-clickaction');
    el.value = v;
    el.dispatchEvent(new Event('change'));
  }, value);

  await pick('none');
  await page.locator('#robot').click({ position: { x: 30, y: 30 } });
  // 单击反应现在延迟 300ms 派发（为了和双击/三连击区分）——等过这个窗口再断言，
  // 才真正证明「不反应」是被设置关掉的，而不是「还没到点」。
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => window.__react)).toEqual([]);

  // 等过 900ms 连击窗口，别让下面这一下和上一击连成双击。
  await page.waitForTimeout(950);

  await pick('greet');
  await page.locator('#robot').click({ position: { x: 30, y: 30 } });
  await expect.poll(() => page.evaluate(() => window.__react)).toContain('bao:greet');
});

// 双击的「挥手」也可以关掉：它是唯一纯粹为人的动作，但不是每个人都想在
// 工作时被一只小机器人挥手。
test('the double-click reaction can be turned off', async ({ page }) => {
  await page.evaluate(() => {
    window.__greets = 0;
    window.addEventListener('bao:greet', () => { window.__greets += 1; });
  });
  const pick = (value) => page.evaluate((v) => {
    const el = document.getElementById('m-dblclick');
    el.value = v;
    el.dispatchEvent(new Event('change'));
  }, value);

  await pick('none');
  await page.locator('#robot').dblclick({ position: { x: 30, y: 30 } });
  // 双击反应同样延迟 300ms：等过窗口再断言，证明「不反应」是被设置关掉的。
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => window.__greets)).toBe(0);

  // 等过 900ms 连击窗口，别让下面这一下和上一击连成三连击。
  await page.waitForTimeout(950);

  await pick('greet');
  await page.locator('#robot').dblclick({ position: { x: 30, y: 30 } });
  await expect.poll(() => page.evaluate(() => window.__greets)).toBe(1);
});

// 三连击彩蛋：原地抓狂。关键是不能在第三下之前就把前两下的单击/双击反应发出去
// —— 否则机器人会一边转圈抓狂一边挥手/弹跳。
test('a triple click fires the crazy easter egg without the single/double reactions', async ({ page }) => {
  await page.evaluate(() => {
    window.__acts = [];
    for (const e of ['bao:poke', 'bao:greet', 'bao:crazy']) window.addEventListener(e, () => window.__acts.push(e));
  });

  // 三次点击必须在 900ms 连击窗口内，且彼此间隔小于 300ms 的反应窗口。用
  // Playwright 的 click() 各自要等可见/稳定，全套件串跑时会被拉长到几百毫秒，
  // 第三下因此偶发落到窗口之外 —— 改为在页面里一次性派发三组指针事件，时间
  // 间隔由代码决定，不受负载影响。
  const box = await page.locator('#robot').boundingBox();
  await page.evaluate(([x, y]) => {
    const el = document.elementFromPoint(x, y) || document.getElementById('robot');
    const opts = {
      bubbles: true, cancelable: true, composed: true,
      clientX: x, clientY: y, screenX: x, screenY: y, pointerId: 1, button: 0, buttons: 1,
    };
    for (let i = 0; i < 3; i++) {
      el.dispatchEvent(new PointerEvent('pointerdown', opts));
      el.dispatchEvent(new PointerEvent('pointerup', { ...opts, buttons: 0 }));
    }
  }, [box.x + 30, box.y + 30]);

  await expect.poll(() => page.evaluate(() => window.__acts)).toContain('bao:crazy');
  // 前两下不得补发 poke/greet —— 彩蛋就该只有彩蛋。
  expect(await page.evaluate(() => window.__acts.filter((x) => x !== 'bao:crazy'))).toEqual([]);
});

// 开机自启只属于桌面版：浏览器页里没有 bridge，勾选框必须禁用并说明原因，
// 而不是给一个点了没反应的勾。
test('autostart is desktop-only and says so', async ({ page }) => {
  await page.evaluate(() => document.getElementById('btn-menu').click());
  await page.evaluate(() => {
    for (const s of document.querySelectorAll('#menu summary')) {
      if (s.textContent.trim() === '系统') s.parentElement.open = true;
    }
  });
  await expect(page.locator('#m-autostart')).toBeDisabled();
  await expect(page.locator('#m-autostart')).toHaveAttribute('title', '只在桌面版可用');
});

// 每一行设置都必须在某个可折叠分组里。每日目标曾经是唯一的例外：它游离在
// 所有 <details> 之外，既不能随分组收起，搜索时也只能靠一段特判才被藏起来。
test('every settings row lives inside a collapsible group', async ({ page }) => {
  await page.evaluate(() => document.getElementById('btn-menu').click());
  const looseRows = await page.evaluate(() => document.querySelectorAll('#menu > .row').length);
  expect(looseRows, 'no row may sit outside a group').toBe(0);
  const grouped = await page.evaluate(() => !!document.getElementById('m-goal').closest('details.group'));
  expect(grouped, 'the daily goal belongs to 基础').toBe(true);
});

// 材质是新的自定义维度：做旧程度改贴图、表面质感改反光，两者都不碰颜色。
// 拖到 40% 要能派发 0.4；「重置外观」把它一起收回出厂值。
test('the wear slider drives the scene and resets with the look', async ({ page }) => {
  await page.evaluate(() => document.getElementById('btn-menu').click());
  await page.evaluate(() => {
    for (const s of document.querySelectorAll('#menu summary')) {
      if (s.textContent.trim() === '材质') s.parentElement.open = true;
    }
  });
  await page.evaluate(() => {
    window.__wear = [];
    window.addEventListener('bao:wear', (e) => window.__wear.push(e.detail.wear));
  });

  await page.evaluate(() => {
    const el = document.getElementById('m-wear');
    el.value = '40';
    el.dispatchEvent(new Event('input'));
    el.dispatchEvent(new Event('change'));
  });
  await expect(page.locator('#m-wear-val')).toHaveText('40%');
  await expect.poll(() => page.evaluate(() => window.__wear.at(-1))).toBe(0.4);

  // 重置外观：滑杆回到 100%，机器人也回到出厂锈迹。
  await page.evaluate(() => document.getElementById('m-reset-look').click());
  await expect(page.locator('#m-wear-val')).toHaveText('100%');
  await expect.poll(() => page.evaluate(() => window.__wear.at(-1))).toBe(1);
});

// 表面质感只有三档，且必须是白名单：配置文件里的脏值不能变出一个不存在的档位。
test('the surface finish has three values and dispatches the one picked', async ({ page }) => {
  await page.evaluate(() => document.getElementById('btn-menu').click());
  await page.evaluate(() => {
    for (const s of document.querySelectorAll('#menu summary')) {
      if (s.textContent.trim() === '材质') s.parentElement.open = true;
    }
  });
  await expect(page.locator('#m-finish option')).toHaveCount(3);
  await page.evaluate(() => {
    window.__finish = [];
    window.addEventListener('bao:finish', (e) => window.__finish.push(e.detail.finish));
  });
  await page.selectOption('#m-finish', '精工');
  await expect.poll(() => page.evaluate(() => window.__finish.at(-1))).toBe('精工');
});

// 台词：设置里写的一句话要同时到达气泡和语音（两边读同一个值），
// 「试一句」只冒泡不改状态，「恢复内置」把三条都清空。
test('a custom phrase reaches the robot and can be reset', async ({ page }) => {
  await page.evaluate(() => document.getElementById('btn-menu').click());
  await page.evaluate(() => {
    for (const s of document.querySelectorAll('#menu summary')) {
      if (s.textContent.trim() === '台词') s.parentElement.open = true;
    }
  });
  await page.evaluate(() => {
    window.__phrase = [];
    window.__say = [];
    window.addEventListener('bao:phrase', (e) => window.__phrase.push(e.detail));
    window.addEventListener('bao:say', (e) => window.__say.push(e.detail.text));
  });

  const input = page.locator('#m-phrase-waiting');
  await input.fill('老板等你');
  await input.blur();
  await expect.poll(() => page.evaluate(() => window.__phrase.at(-1)))
    .toEqual({ state: 'waiting', text: '老板等你' });

  // 「试一句」：读输入框的当前内容，走临时提示通道。
  await page.locator('#m-phrase-try').click();
  await expect.poll(() => page.evaluate(() => window.__say.at(-1))).toBe('老板等你');

  await page.locator('#m-phrase-reset').click();
  await expect(input).toHaveValue('');
  await expect.poll(() => page.evaluate(() => window.__phrase.at(-1).text)).toBe('');
  // 恢复内置要三条一起清空：只清一条，另外两条还会念着用户写的话。
  expect(await page.evaluate(() =>
    [...document.querySelectorAll('#m-phrase-waiting, #m-phrase-error, #m-phrase-done')].map((i) => i.value)))
    .toEqual(['', '', '']);
});

// 勿扰的起止时间相同 = 这段永远不生效。合法，但没人猜得到，所以必须写在开关下面。
test('the dnd note explains a window whose ends are the same', async ({ page }) => {
  await page.evaluate(() => document.getElementById('btn-menu').click());
  await page.evaluate(() => {
    for (const s of document.querySelectorAll('#menu summary')) {
      if (s.textContent.trim() === '系统') s.parentElement.open = true;
    }
  });
  const set = (id, value) => page.evaluate(([i, v]) => {
    const el = document.getElementById(i);
    if (el.type === 'checkbox') el.checked = v === 'on'; else el.value = v;
    el.dispatchEvent(new Event('change'));
  }, [id, value]);

  await set('m-dnd', 'on');
  await set('m-dnd-start', '22:00');
  await set('m-dnd-end', '22:00');
  await expect(page.locator('#m-dnd-note')).toBeVisible();

  await set('m-dnd-end', '07:30');
  await expect(page.locator('#m-dnd-note')).toBeHidden();
});
