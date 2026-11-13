'use strict';
// Rendered-UI tests for the robot overlay.
//
// The node:test suite proves the state machine. These prove what a person
// actually sees: which beacon is lit, where the robot sits, whether it is
// clipped by the window, what the label says, and what colour the gauge is.
// Every test here corresponds to something that was once visibly wrong.

const { test, expect } = require('@playwright/test');
const { start } = require('../src/server');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

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
  if (ccSwitchHome) fs.rmSync(ccSwitchHome, { recursive: true, force: true });
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

  const cells = await page.evaluate(() => [0, 1, 2, 3].map((i) => {
    const el = document.getElementById('slot' + i);
    return { agent: el.dataset.agent, state: el.dataset.state, fill: getComputedStyle(el).fill };
  }));

  expect(cells.map((c) => c.agent)).toEqual(['deepseek', 'claude', 'codex', 'workbuddy']);
  expect(cells.map((c) => c.state)).toEqual(['error', 'busy', 'waiting', 'idle']);
  expect(new Set(cells.map((c) => c.fill)).size, 'four distinct lights on screen').toBe(4);
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
  }).toBe(3);

  const agents = await page.evaluate(() =>
    window.__ring[window.__ring.length - 1].agents.map((a) => `${a.agent}:${a.state}:${a.worst}`));

  expect(agents).toEqual(['claude:busy:false', 'codex:error:true', 'workbuddy:waiting:false']);
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
  await settled(page, () => document.querySelectorAll('.pill').length).toBe(4);
  await settled(page, () => document.querySelectorAll('.pill[data-agent="workbuddy"]').length).toBe(1);

  const rows = await page.evaluate(() =>
    [...document.querySelectorAll('.pill')].map((el) => el.dataset.agent));
  expect(rows, 'one row per software, fixed order').toEqual(['deepseek', 'claude', 'codex', 'workbuddy']);
});

// The list can be reined in: hide the software that is not running, and cap how
// many rows it shows. Both are user choices; the defaults show everything.
test('the software list honours the offline and row-limit settings', async ({ page }) => {
  await api('/state', { session: 'a', agent: 'claude', state: 'busy' });
  await page.locator('#robot').click({ button: 'right', position: { x: 30, y: 30 } });
  await page.locator('#s-gear').click();
  await expect(page.locator('#menu')).toBeVisible();

  // Default: all four software keep a row.
  await settled(page, () => document.querySelectorAll('.pill').length).toBe(4);

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
  await settled(page, () => document.querySelectorAll('.pill').length).toBe(4);
  await page.evaluate(() => {
    const sel = document.getElementById('m-maxrows');
    sel.value = '2';
    sel.dispatchEvent(new Event('change'));
  });
  await settled(page, () => document.querySelectorAll('.pill:not(.more)').length).toBe(2);
  await settled(page, () => document.querySelector('.pill.more')?.textContent).toContain('还有 2 个');
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
  await settled(page, () => document.querySelectorAll('.pill').length).toBe(4);
  await settled(page, () => document.querySelectorAll('.pill.offline').length).toBe(4);

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

// ------------------------------------------------------------ desktop teardown

// 拆解必须在桌面上完成：同一个浮层、同一台机器人，不跳网页、不开第二个窗口。
test('the teardown happens on the desktop robot itself', async ({ page }) => {
  await page.evaluate(() => document.getElementById('m-teardown').click());
  await settled(page, () => document.getElementById('bot').dataset.td).toBe('1');

  expect(await page.evaluate(() => document.getElementById('bot').dataset.tdParts)).toBe('51');
  await expect(page.locator('#tdbar')).toBeVisible();
  // 窗口/舞台变大，机器人本体换成拆解模型
  expect(await page.evaluate(() => getComputedStyle(document.getElementById('bot')).width)).toBe('460px');

  await page.locator('#tdbar button[data-td="explode"]').click();
  await expect.poll(
    () => page.evaluate(() => Number(document.getElementById('bot').dataset.tdAmount)),
    { timeout: 8000 }
  ).toBe(100);
  await expect(page.locator('#td-pct')).toHaveText('100%');

  // 悬停标签的接线：零件名和说明都写进控制条下方
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('bao:teardown-hover', {
    detail: { label: '主壳体', note: '1.5 mm 冷轧钢板' },
  })));
  await expect(page.locator('#td-tag')).toContainText('主壳体');
  await expect(page.locator('#td-tag')).toContainText('冷轧钢板');

  // Esc 收起：回到普通机器人，控制条消失
  await page.keyboard.press('Escape');
  await settled(page, () => document.getElementById('bot').dataset.td).toBe('0');
  await expect(page.locator('#tdbar')).toBeHidden();
  expect(await page.evaluate(() => getComputedStyle(document.getElementById('bot')).width)).toBe('300px');
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
