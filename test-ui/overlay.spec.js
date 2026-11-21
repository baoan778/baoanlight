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

// 渲染测试不该取决于开发机此刻开没开 Claude Code：presence 会把「离线」变成
// 「未知」，让一条条与探测无关的断言随机变红。固定成「没有证据」。
require('../src/presence').claudeRunning = async () => false;

const GUTTER = 16;             // minimum clear space around the robot
let server;
let store;                     // 测试服务端的内存 Storage：用来把会话「变老」，不必真的等
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
  store = r.store;
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
// 可选的 arg 会原样交给 page.evaluate：这样断言可以带一份「哪几个软件」的清单，
// 而不必为每个组合再写一个内联闭包。
// CI 的 runner 上 SSE → 渲染这一跳可能超过 4 秒（实测有一次刚好卡在线上，
// 于是被判「未运行」）。这是等待预算，不是断言强度：真出问题时多等几秒只是
// 让失败来得慢一点，不会把错误变成通过。
const POLL_TIMEOUT = process.env.CI ? 20000 : 4000;
const settled = (page, fn, arg) => expect.poll(() => page.evaluate(fn, arg), { timeout: POLL_TIMEOUT });

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

// 未运行与未知必须是两回事：前者是一盏灭掉的灯，后者才是灰色问号。
test('an offline software is a dark light, not the same grey as unknown', async ({ page }) => {
  await api('/state', { session: 'a', agent: 'claude', state: 'unknown' });
  await expect(page.locator('.pill[data-agent="claude"] i')).toHaveAttribute('data-color', 'grey');
  await api('/state', { session: 'a', agent: 'claude', state: 'offline' });
  await expect(page.locator('.pill[data-agent="claude"] i')).toHaveAttribute('data-color', 'off');
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

  // 两个会话合成一行时，行尾要有 ×2：否则「Claude 出错了」看不出是三个里哪个。
  // 现在这个数字本身是展开按钮（点开逐条列出会话），名字保持干净。
  await expect(page.locator('.pill[data-agent="workbuddy"] .pill-expand')).toHaveText(/×2/);
  await expect(page.locator('.pill[data-agent="workbuddy"] b')).toHaveText('WorkBuddy');
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
  // 必须在同一个 evaluate 里立刻读一次：CI 的慢 runner 上，从派发 change 到
  // 下一次跨进程可见性检查可能超过 1.6 秒，再断言 "visible" 就是在赌调度速度
  // （真实发生过：主 test 流程因此红了一次，本机重复 10 次全过）。
  const flash = await page.evaluate(() => {
    const el = document.getElementById('m-sound');
    el.checked = true;
    el.dispatchEvent(new Event('change'));
    const n = document.getElementById('note');
    return { hidden: n.hidden, text: n.textContent };
  });
  expect(flash.hidden, 'the flash note is shown synchronously').toBe(false);
  expect(flash.text).toContain('提示音已开启');

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
//
// 断言落在「列表行」而不是「最近动态」：行每一帧都画（含未登记的软件），不受菜单
// 打开时机影响 —— 之前断言「最近动态」里的记录，而它在全套件串跑时会偶发为空，
// 让这条安全用例本身成了 flaky。安全性质不变量是「agent 名不进 innerHTML」，
// 行和动态面板共用同一个 textRow/textContent 路径，钉住行就够了。
test('an agent name is shown as text, never as markup', async ({ page }) => {
  const name = '<img src=x onerror="window.__pwned=1">';
  await api('/state', { session: 'xss', agent: name, state: 'busy' });
  await settled(page, () => document.body.dataset.state).toBe('busy');

  const pill = page.locator('.pill').filter({ hasText: 'onerror' }).first();
  await expect(pill).toBeVisible();
  expect(await pill.innerHTML()).not.toContain('<img');
  expect(await page.evaluate(() => window.__pwned)).toBeUndefined();
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

// 没有 NVIDIA 读数的机器上，GPU 行必须整行消失，而不是留一格「—」。
// 这条用例显式伪造一份无 GPU 的 /sys，避免结果取决于跑测试的机器有没有显卡。
test('the GPU row disappears when the machine has no NVIDIA reading', async ({ page }) => {
  await page.route('**/sys', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ cpu: 12, mem: { percent: 30, used: 2, total: 8 }, gpu: null }),
  }));
  await expect.poll(() => page.locator('#sys-gpu-row').isVisible(), { timeout: 8000 }).toBe(false);
});

// CPU / 内存面板：数字来自 /sys，开关要真的生效，而且它是中性色 ——
// 红黄绿已经被代理状态占满。
test('the system panel shows real numbers and can be turned off', async ({ page }) => {
  await expect(page.locator('#sys')).toBeVisible();
  await expect(page.locator('#sys-cpu')).toHaveText(/^\d+%$/);
  await expect(page.locator('#sys-mem')).toHaveText(/^\d+%$/);
  // GPU 行只在有 NVIDIA 读数的机器上出现：出现了就必须是真数字，没出现也不能
  // 空着一格「—」。
  if (await page.locator('#sys-gpu-row').isVisible()) {
    await expect(page.locator('#sys-gpu')).toHaveText(/^\d+%$/);
  }

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

  // 动效三档必须真的落到 data-motion 上：CSS 靠它决定动不动。
  await page.evaluate(() => {
    const s = document.getElementById('m-sys-motion');
    s.value = 'off';
    s.dispatchEvent(new Event('change'));
  });
  await expect(page.locator('#sys')).toHaveAttribute('data-motion', 'off');
  await page.evaluate(() => {
    const s = document.getElementById('m-sys-motion');
    s.value = 'always';
    s.dispatchEvent(new Event('change'));
  });
  await expect(page.locator('#sys')).toHaveAttribute('data-motion', 'always');
});

// 广告牌曾经挂在会被体型缩放的机器人组上：默认体型顶边正好贴边，Q 版直接
// 出画。现在它挂在场景里，任何一种体型下四角都必须留在画面内。
test('the scoreboard stays inside the frame in every body type', async ({ page }) => {
  await expect.poll(() => page.evaluate(() => Number(document.getElementById('bot').dataset.signEdge)))
    .toBeLessThan(0.98);

  // 用时钟模式保证牌子一定有内容，才能量它的屏幕尺寸。
  await page.evaluate(() => {
    const el = document.getElementById('m-sign');
    el.value = '时钟';
    el.dispatchEvent(new Event('change'));
  });
  await expect.poll(() => page.evaluate(() => document.getElementById('bot').dataset.signRect || ''))
    .not.toBe('');
  // 牌子出现时会有一个 0.3s 的弹出缩放；等它落定再量基准宽度。
  await page.waitForTimeout(500);
  const widthOf = () => page.evaluate(() =>
    Number(document.getElementById('bot').dataset.signRect.split(',')[2]));
  const baseWidth = await widthOf();

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
    // 牌子挂在场景里，不随体型缩放：换体型只该改变机器人，不该让牌面大小跳。
    const w = await widthOf();
    expect(Math.abs(w - baseWidth), `sign width changed with body ${body}`).toBeLessThanOrEqual(2);
  }

  // 收起模式只剩一个 150px 的小助手：牌面字读不出来，就不该留一块黄条。
  await page.evaluate(() => document.getElementById('btn-collapse').click());
  await expect.poll(() => page.evaluate(() => document.getElementById('bot').dataset.signRect)).toBe('');
  await page.evaluate(() => document.getElementById('btn-collapse').click());
  await expect.poll(() => page.evaluate(() => document.getElementById('bot').dataset.signRect || ''))
    .not.toBe('');
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
  await expect(page.locator('#m-theme')).toHaveValue('钛金原色');
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

// 广告牌是 3D 画布里的精灵，DOM 没有它的节点。拖动它必须只动牌子、不动窗口，
// 松手后位置写进配置；「恢复默认位置」把它放回肩侧。
test('the billboard can be dragged with the mouse, saved, and reset', async ({ page }) => {
  await api('/state', { session: 'sign', agent: 'claude', state: 'busy' });
  await page.addInitScript(() => {
    window.__saved = {};
    window.bao = {
      serverUrl: location.origin,
      getConfig: () => Promise.resolve({}),
      saveConfig: (p) => { Object.assign(window.__saved, p); return Promise.resolve({}); },
      getAutostart: () => Promise.resolve({ enabled: false }),
      setAutostart: () => Promise.resolve({ enabled: false }),
      getNotes: () => Promise.resolve({ day: '', items: [], open: 0, done: 0, doneToday: 0 }),
      saveNotes: () => Promise.resolve({}),
      contentSize: () => {}, hotRect: () => {}, onCursor: () => {}, notify: () => {},
      openTerminal: () => {}, trayStatus: () => {}, quit: () => {},
      dragStart: () => { window.__windowDragged = true; }, dragEnd: () => {},
    };
  });
  await page.reload();
  await page.waitForFunction(() => document.body.dataset.state !== undefined);
  // 时钟模式总是有内容：不必依赖今天有没有累计过忙碌时长。通过控件切换，
  // 而不是靠启动时的配置 —— 注入的 getConfig 是微任务，可能早于 3D 场景
  // 注册监听（真实的 IPC 是另一条任务，不会这样）。
  await page.evaluate(() => {
    const el = document.getElementById('m-sign');
    el.value = '时钟';
    el.dispatchEvent(new Event('change'));
  });

  // robot3d 每帧把牌子的屏幕矩形写在 #bot 上；有内容时才写。
  await expect.poll(() => page.evaluate(() => document.getElementById('bot').dataset.signRect || ''))
    .not.toBe('');
  const centerNow = () => page.evaluate(() => {
    const [x, y, w, h] = document.getElementById('bot').dataset.signRect.split(',').map(Number);
    const r = document.getElementById('bot').getBoundingClientRect();
    const k = r.width / document.getElementById('bot').clientWidth;
    return { x: r.left + (x + w / 2) * k, y: r.top + (y + h / 2) * k };
  });
  const center = await centerNow();

  await page.mouse.move(center.x, center.y);
  await page.mouse.down();
  await page.mouse.move(center.x - 70, center.y + 40, { steps: 6 });
  await page.mouse.up();

  // 牌子往左下搬：世界坐标 x 变小、y 变小；窗口没有被拖着走。
  await expect.poll(() => page.evaluate(() => window.__saved.signOffset && window.__saved.signOffset.x))
    .toBeLessThan(0);
  const off = await page.evaluate(() => window.__saved.signOffset);
  expect(off.y).toBeLessThan(0);
  expect(await page.evaluate(() => window.__windowDragged === true)).toBe(false);
  // 拖过之后设置里要显示「已自定义」，重置按钮才可按。
  await openGroups(page, ['广告牌']);
  await expect(page.locator('#m-sign-custom')).toBeVisible();
  await expect(page.locator('#m-sign-reset')).toBeEnabled();

  // 双击牌子 = 回到默认位置。
  const moved = await centerNow();
  await page.mouse.dblclick(moved.x, moved.y);
  await expect.poll(() => page.evaluate(() => window.__saved.signOffset)).toEqual({ x: 0, y: 0 });
  await expect(page.locator('#m-sign-custom')).toBeHidden();
  await expect(page.locator('#m-sign-reset')).toBeDisabled();

  // 再拖一次，用设置里的按钮复原。
  const again = await centerNow();
  await page.mouse.move(again.x, again.y);
  await page.mouse.down();
  await page.mouse.move(again.x - 60, again.y + 30, { steps: 5 });
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => window.__saved.signOffset && window.__saved.signOffset.x))
    .toBeLessThan(0);
  // 双击牌子可能已经把设置菜单点关（点在别处会收起菜单），重新打开。
  await openGroups(page, ['广告牌']);
  await page.locator('#m-sign-reset').click();
  await expect.poll(() => page.evaluate(() => window.__saved.signOffset)).toEqual({ x: 0, y: 0 });
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

  // 起止相同 = 夜晚时段为空。自动切换仍开着，但会一直停在白天，必须说出来。
  await page.evaluate(() => {
    const set = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event('change')); };
    set('m-night-start', '09:00');
    set('m-night-end', '09:00');
  });
  await expect(page.locator('#m-night-note')).toBeVisible();

  // 清空时间框不能留下一个「永不生效」的空值：收回默认值并写回控件。
  await page.evaluate(() => {
    const el = document.getElementById('m-night-start');
    el.value = '';
    el.dispatchEvent(new Event('change'));
  });
  await expect(page.locator('#m-night-start')).toHaveValue('20:00');
  await expect(page.locator('#m-night-note')).toBeHidden();

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
  const key = page.locator('#m-hotkey-key');
  await expect(box).toBeChecked();
  await expect(key).toBeEnabled();
  await expect(key).toHaveValue('CommandOrControl+Alt+B');
  await key.selectOption('CommandOrControl+Shift+B');
  await expect(key).toHaveValue('CommandOrControl+Shift+B');

  await box.uncheck();
  await expect(box).not.toBeChecked();
  await expect(key).toBeDisabled();

  await box.check();
  await expect(key).toBeEnabled();
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

  // 直接派发 input/change，不依赖 Playwright 的 fill（全套件串跑、页面繁忙时 fill
  // 的逐键输入偶尔不落盘，导致这条本身变成 flaky）。改名走的是 input 事件 + 立即
  // render(lastSnap)，事件一发就该生效。
  await page.evaluate(() => {
    const input = document.querySelector('#m-alias input[aria-label="给「Claude Code」改名"]');
    input.value = '项目A';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await expect(page.locator('.pill[data-agent="claude"] b')).toHaveText('项目A', { timeout: 8000 });
  await expect(page.locator('#m-order .row[data-agent="claude"] span')).toHaveText('项目A', { timeout: 8000 });

  // agent 键没变：同一条会话进入 waiting，颜色照常变。
  await api('/state', { session: 'a', agent: 'claude', state: 'waiting' });
  await settled(page, () => {
    const el = document.querySelector('.pill[data-agent="claude"]');
    return el ? el.querySelector('i').dataset.color : null;
  }).toBe('amber');

  // 清空 → 回到内置名。
  await page.evaluate(() => {
    const input = document.querySelector('#m-alias input[aria-label="给「Claude Code」改名"]');
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await expect(page.locator('.pill[data-agent="claude"] b')).toHaveText('Claude Code', { timeout: 8000 });
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

// --------------------------------------------------------- 主动提示（通知）

// 系统通知走 preload 的 bridge.notify，浏览器里没有它。注入一个可观测的桥：
// 页面照常走「有 Electron」分支，通知只被记下来。顺便把 AudioContext 包一层，
// 让「完成也响一声」也能被断言（音色/音量不在这里测）。
const withNotifySpy = async (page, cfg = {}) => {
  await page.addInitScript((saved) => {
    // 通知文案跟随浏览器语言；固定成中文，断言才不会随 CI 的 locale 漂。
    try { Object.defineProperty(navigator, 'language', { get: () => 'zh-CN' }); } catch { /* 老浏览器 */ }
    window.__notified = [];
    window.__tones = 0;
    const RealAC = window.AudioContext || window.webkitAudioContext;
    if (RealAC) {
      window.AudioContext = class extends RealAC {
        createOscillator() { window.__tones += 1; return super.createOscillator(); }
      };
    }
    window.bao = {
      serverUrl: location.origin,
      getConfig: () => Promise.resolve(saved),
      saveConfig: () => Promise.resolve(saved),
      getAutostart: () => Promise.resolve({ enabled: false }),
      setAutostart: () => Promise.resolve({ enabled: false }),
      getNotes: () => Promise.resolve({ day: '', items: [], open: 0, done: 0, doneToday: 0 }),
      saveNotes: () => Promise.resolve({}),
      contentSize: () => {}, hotRect: () => {}, onCursor: () => {},
      notify: (title, body) => window.__notified.push({ title, body }),
      openTerminal: () => {}, trayStatus: () => {}, quit: () => {},
      dragStart: () => {}, dragEnd: () => {},
    };
  }, cfg);
  await page.reload();
  await page.waitForFunction(() => document.body.dataset.state !== undefined);
};
const notified = (page) => page.evaluate(() => (window.__notified || []).map((n) => n.title));
// 直接改测试服务端里的内存会话，把「已经静默/已经等待 N 分钟」模拟出来，
// 不必真的等 15 分钟。只改时间戳，不绕开任何判定逻辑。
const ageSession = (id, patch) => {
  const s = store.sessions.get(id);
  if (!s) throw new Error(`no session ${id}`);
  Object.assign(s, patch);
  store.emit('change', store.snapshot());
};
// 在页面里执行：这几个软件是否都已经有会话（不再是「未运行」的暗行）。
const LIVE_ROWS = (list) => list.every((a) => {
  const el = document.querySelector(`.pill[data-agent="${a}"]`);
  return !!el && !el.classList.contains('offline');
});

// 五个软件同时跑：每一行/每一段灯都要显示自己的状态，主灯取最坏的（红），
// 并且每一条「需要你 / 出错 / 完成」都要单独提醒 —— 聚合状态没变时尤其容易漏。
test('five software at once stay accurate and every change is announced', async ({ page }) => {
  await withNotifySpy(page);
  const all = ['deepseek', 'claude', 'codex', 'workbuddy', 'codebuddy'];
  for (const agent of all) await api('/state', { session: `m-${agent}`, agent, state: 'busy' });
  await settled(page, LIVE_ROWS, all).toBe(true);

  await api('/state', { session: 'm-claude', agent: 'claude', state: 'waiting', detail: 'approve?' });
  await api('/state', { session: 'm-codex', agent: 'codex', state: 'error', detail: 'Bash failed' });
  await api('/state', { session: 'm-deepseek', agent: 'deepseek', state: 'idle', event: 'projection' });
  await api('/state', { session: 'm-workbuddy', agent: 'workbuddy', state: 'done' });
  await api('/state', { session: 'm-codebuddy', agent: 'codebuddy', state: 'waiting' });

  await settled(page, () => document.body.dataset.state).toBe('error');
  await expect.poll(() => page.evaluate(() => {
    const out = {};
    for (const el of document.querySelectorAll('.pill[data-agent]')) {
      if (el.dataset.agent in out) continue;
      out[el.dataset.agent] = el.querySelector('i').dataset.color;
    }
    return out;
  })).toEqual({
    deepseek: 'white', claude: 'amber', codex: 'red', workbuddy: 'done', codebuddy: 'amber',
  });

  await expect.poll(() => notified(page)).toEqual(expect.arrayContaining([
    'Claude Code 需要你处理',
    'Codex 出错了',
    // 「完成」有两套来源：显式 done（WorkBuddy），以及只报 Stop/回合结束的 idle
    // （DeepSeek、Claude Code）。它们都该被提醒，否则设置里的开关只对一半软件生效。
    'DeepSeek Harness 完成了',
    'WorkBuddy 完成了',
    'CodeBuddy 需要你处理',
  ]));
});

// 并发/竞态：几条软件在同一秒里反复切换状态。SSE 必须按顺序落地，最终每一行
// 都是该软件最后一次上报的状态，不能串台，也不能让主灯停在中途的旧值上。
test('rapid interleaved updates settle on the right state per software', async ({ page }) => {
  await withNotifySpy(page);
  const seq = [
    ['claude', 'busy'], ['codex', 'busy'], ['deepseek', 'busy'],
    ['claude', 'waiting'], ['codex', 'waiting'], ['deepseek', 'waiting'],
    ['claude', 'busy'], ['codex', 'error'], ['deepseek', 'busy'],
    ['claude', 'idle'], ['codex', 'busy'], ['deepseek', 'error'],
    ['claude', 'waiting'], ['codex', 'idle'], ['deepseek', 'waiting'],
  ];
  for (const [agent, state] of seq) await api('/state', { session: `race-${agent}`, agent, state });

  // 最后：claude waiting、deepseek waiting、codex idle → 主灯黄。
  await settled(page, () => document.body.dataset.state).toBe('waiting');
  await expect.poll(() => page.evaluate(() => {
    const out = {};
    for (const a of ['claude', 'codex', 'deepseek']) {
      out[a] = document.querySelector(`.pill[data-agent="${a}"]`).dataset.state;
    }
    return out;
  })).toEqual({ claude: 'waiting', codex: 'idle', deepseek: 'waiting' });
});

// 重复上报同一种状态（心跳、详情变化）不能重复弹通知：一条事件只该有一次提示。
test('repeating the same state does not repeat the notification', async ({ page }) => {
  await withNotifySpy(page);
  await api('/state', { session: 'dup', agent: 'claude', state: 'busy' });
  await settled(page, () => document.body.dataset.state).toBe('busy');
  await api('/state', { session: 'dup', agent: 'claude', state: 'waiting' });
  await settled(page, () => document.body.dataset.state).toBe('waiting');
  for (let i = 0; i < 4; i++) {
    await api('/state', { session: 'dup', agent: 'claude', state: 'waiting', detail: `again ${i}` });
  }
  await page.waitForTimeout(700);
  expect(await notified(page)).toEqual(['Claude Code 需要你处理']);
});

// 聚合灯已经是红的时，第二个软件的失败也必须提醒 —— 去重键是「软件 + 状态」，
// 不能是聚合状态，否则最该知道的那一条会被当成重复吞掉。
test('a second failure is announced while the lamp is already red', async ({ page }) => {
  await withNotifySpy(page);
  await api('/state', { session: 'f1', agent: 'claude', state: 'busy' });
  await api('/state', { session: 'f2', agent: 'codex', state: 'busy' });
  await settled(page, LIVE_ROWS, ['claude', 'codex']).toBe(true);

  await api('/state', { session: 'f1', agent: 'claude', state: 'error' });
  await settled(page, () => document.body.dataset.state).toBe('error');
  await api('/state', { session: 'f2', agent: 'codex', state: 'error' });

  await expect.poll(() => notified(page)).toEqual(['Claude Code 出错了', 'Codex 出错了']);
});

// 只报 Stop 的代理（Claude Code）用 idle 表示「这一轮结束」：设置里的
// 「完成也弹通知 / 响一声」必须对它生效，否则最常用的软件永远不会提醒。
test('a turn that ends as idle still gets a completion notification and cue', async ({ page }) => {
  await withNotifySpy(page, { sound: true, soundDone: true, soundVolume: 0.2, soundStyle: '清脆叮咚' });
  await expect(page.locator('#m-sound')).toBeChecked();
  await api('/state', { session: 'c1', agent: 'claude', state: 'busy' });
  await settled(page, () => document.body.dataset.state).toBe('busy');
  // 进入 busy 本身就有一声（两声上扬音），而且它占着 2.5 秒的告警限流窗口；
  // 等这个窗口过去，才能确定随后那一声确实是「完成」而不是残留。
  await page.waitForTimeout(2600);
  const before = await page.evaluate(() => window.__tones);

  await api('/state', { session: 'c1', agent: 'claude', state: 'idle', event: 'Stop' });

  await expect.poll(() => notified(page)).toContain('Claude Code 完成了');
  await expect.poll(() => page.evaluate(() => window.__tones)).toBeGreaterThan(before);
});

// 取消不是完成：日志里的 turn_aborted / cancelled 也会把状态带回 idle，
// 但「报喜」在这里就是撒谎。
test('a cancelled turn is not announced as a completion', async ({ page }) => {
  await withNotifySpy(page);
  await api('/state', { session: 'x1', agent: 'codex', state: 'busy', event: 'turn_started' });
  await settled(page, () => document.body.dataset.state).toBe('busy');
  await api('/state', { session: 'x1', agent: 'codex', state: 'idle', event: 'turn_aborted' });
  await settled(page, () => document.body.dataset.state).toBe('idle');
  await page.waitForTimeout(600);
  expect(await notified(page)).toEqual([]);
});

// 完成通知可以单独关掉，但失败通知不受影响。
test('turning off completion notifications keeps failures', async ({ page }) => {
  await withNotifySpy(page, { notifyDone: false });
  await api('/state', { session: 'd1', agent: 'claude', state: 'busy' });
  await api('/state', { session: 'd2', agent: 'codex', state: 'busy' });
  await settled(page, LIVE_ROWS, ['claude', 'codex']).toBe(true);

  await api('/state', { session: 'd1', agent: 'claude', state: 'idle', event: 'Stop' });
  await api('/state', { session: 'd2', agent: 'codex', state: 'error' });

  await expect.poll(() => notified(page)).toEqual(['Codex 出错了']);
});

// 逐个软件的通知开关只关它自己；全局静音/勿扰才是「全部安静」。
test('muting one software does not silence another', async ({ page }) => {
  await withNotifySpy(page, { mutedAgents: ['claude'] });
  await api('/state', { session: 'q1', agent: 'claude', state: 'busy' });
  await api('/state', { session: 'q2', agent: 'codex', state: 'busy' });
  await settled(page, LIVE_ROWS, ['claude', 'codex']).toBe(true);

  await api('/state', { session: 'q1', agent: 'claude', state: 'waiting' });
  await api('/state', { session: 'q2', agent: 'codex', state: 'waiting' });

  await expect.poll(() => notified(page)).toEqual(['Codex 需要你处理']);
});

// 全局静音与定时勿扰：状态照常变化，但一条通知都不弹。
for (const [name, cfg] of [
  ['a global mute', { mutedUntil: Date.now() + 3600_000 }],
  ['do-not-disturb', { doNotDisturb: true, dndStart: '00:00', dndEnd: '23:59' }],
]) {
  test(`${name} silences notifications without hiding the state`, async ({ page }) => {
    await withNotifySpy(page, cfg);
    await api('/state', { session: 'z1', agent: 'claude', state: 'busy' });
    await settled(page, () => document.body.dataset.state).toBe('busy');
    await api('/state', { session: 'z1', agent: 'claude', state: 'error' });
    await settled(page, () => document.body.dataset.state).toBe('error');
    await page.waitForTimeout(600);
    expect(await notified(page)).toEqual([]);
    // 灯仍然是红的：静音关的是声音，不是事实。
    await expect(page.locator('#status-led')).toHaveAttribute('data-color', 'red');
  });
}

// 启动瞬间不刷屏（重报的等待会话只播种），但过了那段窗口，一个新出现就
// 在等待的软件必须提醒 —— 否则「一打开就请求权限」的会话会被整条吞掉。
test('a software that appears already waiting after startup is announced', async ({ page }) => {
  await withNotifySpy(page);
  // 播种窗口是 8 秒（NOTIFY_ARM_MS）。
  await page.waitForTimeout(8300);
  await api('/state', { session: 'late1', agent: 'claude', state: 'waiting' });
  await expect.poll(() => notified(page)).toEqual(['Claude Code 需要你处理']);
});

// 设置里的卡住阈值必须真的决定提醒时机，而不只是诊断文案。
test('the busy stuck alarm follows the configured threshold', async ({ page }) => {
  // 阈值 30 分钟：静默 5 分钟不该报（旧行为固定 5 分钟就会报）。
  await withNotifySpy(page, { stuckBusyMin: 30 });
  await expect(page.locator('#m-stuck-busy')).toHaveValue('30');
  await api('/state', { session: 'stuck-a', agent: 'claude', state: 'busy' });
  await settled(page, () => document.body.dataset.state).toBe('busy');

  ageSession('stuck-a', { updatedAt: Date.now() - 5 * 60_000 });
  await page.waitForTimeout(600);
  expect(await notified(page)).toEqual([]);

  // 真超过阈值再提醒（31 分钟仍在测试服务端 10 分钟会话 TTL 之外，所以先
  // 放大这个会话的 updatedAt 之后立刻断言，不依赖它一直留在 store 里）。
  ageSession('stuck-a', { updatedAt: Date.now() - 31 * 60_000 });
  await expect.poll(() => notified(page)).toContain('Claude Code 好像卡住了');
});

test('a stuck software is alerted once and escalated at twice the threshold', async ({ page }) => {
  await withNotifySpy(page, { stuckBusyMin: 1 });
  await expect(page.locator('#m-stuck-busy')).toHaveValue('1');
  await api('/state', { session: 'stuck-b', agent: 'codex', state: 'busy' });
  await settled(page, () => document.body.dataset.state).toBe('busy');

  // quiet 标记本身在 90 秒后才成立（quietAfterMs），所以这里用 100 秒：
  // 已过 1 分钟阈值，但还没到 2 分钟的升级阈值。
  ageSession('stuck-b', { updatedAt: Date.now() - 100_000 });
  await expect.poll(() => notified(page)).toContain('Codex 好像卡住了');

  // 同一段静默不重复第一次提醒。
  ageSession('stuck-b', { updatedAt: Date.now() - 110_000 });
  await page.waitForTimeout(400);
  expect((await notified(page)).filter((t) => t === 'Codex 好像卡住了')).toHaveLength(1);

  // 两倍阈值（2 分钟）再升级一次。
  ageSession('stuck-b', { updatedAt: Date.now() - 130_000 });
  await expect.poll(() => notified(page)).toContain('Codex 大概率卡死了');
});

// 勿扰 / 静音期间不该弹，但也不能把提醒标记成「已发」：解除之后仍然卡着的软件
// 必须补上这一条，否则用户永远不知道它从会议开始一直卡到现在。
test('a stuck alert suppressed by do-not-disturb is delivered once it lifts', async ({ page }) => {
  await withNotifySpy(page, {
    stuckBusyMin: 1, doNotDisturb: true, dndStart: '00:00', dndEnd: '23:59',
  });
  await api('/state', { session: 'stuck-dnd', agent: 'dndagent', state: 'busy' });
  await settled(page, () => document.body.dataset.state).toBe('busy');

  ageSession('stuck-dnd', { updatedAt: Date.now() - 100_000 });
  await page.waitForTimeout(600);
  expect(await notified(page)).not.toContain('dndagent 好像卡住了');

  // 解除勿扰：下一帧就要补发同一条提醒。
  await page.evaluate(() => {
    const el = document.getElementById('m-dnd');
    el.checked = false;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  ageSession('stuck-dnd', { updatedAt: Date.now() - 100_000 });
  await expect.poll(() => notified(page)).toContain('dndagent 好像卡住了');
});

// 「等待多久提醒」：同一轮等待只提醒一次；离开等待再回来重新计时。
test('a long wait is reminded once per waiting episode', async ({ page }) => {
  await withNotifySpy(page, { stuckWaitMin: 1 });
  await expect(page.locator('#m-stuck-wait')).toHaveValue('1');
  await api('/state', { session: 'wait-a', agent: 'claude', state: 'busy' });
  await settled(page, () => document.body.dataset.state).toBe('busy');
  await api('/state', { session: 'wait-a', agent: 'claude', state: 'waiting' });
  await settled(page, () => document.body.dataset.state).toBe('waiting');

  ageSession('wait-a', { since: Date.now() - 70_000 });
  await expect.poll(() => notified(page)).toContain('Claude Code 还在等你');

  ageSession('wait-a', { updatedAt: Date.now() - 5000 });
  await page.waitForTimeout(400);
  expect((await notified(page)).filter((t) => t === 'Claude Code 还在等你')).toHaveLength(1);

  // 离开等待再回来 = 新的一轮等待，重新计时、重新提醒。
  await api('/state', { session: 'wait-a', agent: 'claude', state: 'busy' });
  await settled(page, () => document.body.dataset.state).toBe('busy');
  await api('/state', { session: 'wait-a', agent: 'claude', state: 'waiting' });
  await settled(page, () => document.body.dataset.state).toBe('waiting');
  ageSession('wait-a', { since: Date.now() - 70_000 });
  await expect.poll(() => page.evaluate(() => (window.__notified || [])
    .filter((n) => n.title === 'Claude Code 还在等你').length)).toBe(2);
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

// 自动场景把下拉改成「此刻生效的那一档」时，手动选择不能被覆盖丢失。
// 关掉自动切换后必须回到用户自己选的那一档，而不是停在自动切到的场景上。
test('turning off automatic scenes restores the manual choice', async ({ page }) => {
  await page.evaluate(() => document.getElementById('btn-menu').click());
  const set = (id, value) => page.evaluate(([i, v]) => {
    const el = document.getElementById(i);
    if (el.type === 'checkbox') el.checked = v === 'on'; else el.value = v;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, [id, value]);

  await set('m-scene', '樱花');
  await set('m-autoscene', 'on');
  // 白天/夜晚都设成草原，测试不依赖运行时刻。
  await set('m-dayscene', '草原');
  await set('m-nightscene', '草原');
  await expect(page.locator('#m-scene')).toHaveValue('草原');

  await set('m-autoscene', 'off');
  await expect(page.locator('#m-scene')).toHaveValue('樱花');
});

// 「外观方案」应该是一套完整的桌面画面：机器人、场景自动切换、广告牌一起回来。
test('an appearance preset restores the sign and the scene schedule', async ({ page }) => {
  await page.evaluate(() => document.getElementById('btn-menu').click());
  const set = (id, value) => page.evaluate(([i, v]) => {
    const el = document.getElementById(i);
    if (el.type === 'checkbox') el.checked = v === 'on'; else el.value = v;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, [id, value]);

  await set('m-autoscene', 'on');
  await set('m-dayscene', '草原');
  await set('m-nightscene', '沙漠');
  await set('m-sign-pos', '左侧');
  await set('m-sign-shape', '胶囊');
  await set('m-sign-color', '青色');

  await page.evaluate(() => {
    document.getElementById('m-preset-name').value = '整桌';
    document.getElementById('m-preset-save').click();
  });

  // 全部改掉，再应用方案。
  await set('m-autoscene', 'off');
  await set('m-dayscene', '无');
  await set('m-nightscene', '无');
  await set('m-sign-pos', '右侧');
  await set('m-sign-shape', '圆角');
  await set('m-sign-color', '粉色');
  await page.evaluate(() => document.getElementById('m-preset-apply').click());

  await expect(page.locator('#m-autoscene')).toBeChecked();
  await expect(page.locator('#m-dayscene')).toHaveValue('草原');
  await expect(page.locator('#m-nightscene')).toHaveValue('沙漠');
  await expect(page.locator('#m-sign-pos')).toHaveValue('左侧');
  await expect(page.locator('#m-sign-shape')).toHaveValue('胶囊');
  await expect(page.locator('#m-sign-color')).toHaveValue('青色');
});

// 每个软件的颜色是「今日战绩」的一部分：改完必须立刻重画，不能等下一次
// 统计变化才生效（score 面板按数据签名去重，颜色也得进签名）。
test('a software colour is applied to the daily score immediately', async ({ page }) => {
  await page.evaluate(() => document.getElementById('btn-menu').click());
  // busy → error 才算一次「进入出错」；直接报 error 的空会话没有前一条状态，
  // 不会计入今日事件。
  await api('/state', { session: 'palette', agent: 'claude', state: 'busy' });
  await api('/state', { session: 'palette', agent: 'claude', state: 'error' });

  const rowColor = () => page.evaluate(() => {
    const row = [...document.querySelectorAll('#m-score .score-row')]
      .find((r) => r.textContent.includes('Claude Code'));
    return row ? getComputedStyle(row).getPropertyValue('--agent-color').trim() : '';
  });
  await expect.poll(rowColor, { timeout: 6000 }).toContain('rgba(');
  const before = await rowColor();
  expect(before).toContain('rgba(');

  await page.evaluate(() => {
    const input = document.querySelector('#m-alias input.agent-color[aria-label="「Claude Code」在今日战绩里的颜色"]');
    input.value = '#123456';
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await expect.poll(rowColor, { timeout: 4000 }).toContain('18, 52, 86');

  await page.evaluate(() => document
    .querySelector('#m-alias button[aria-label="恢复「Claude Code」的默认颜色"]').click());
  await expect.poll(rowColor, { timeout: 4000 }).not.toContain('18, 52, 86');
});

// 提示音和系统通知是两条通道：关掉声音不该顺手关掉弹窗。
test('a software can have its cue muted on its own', async ({ page }) => {
  await page.evaluate(() => document.getElementById('btn-menu').click());
  // “软件”分组默认收起：展开后再点，否则按钮不可见，click() 会一直等。
  await page.evaluate(() => {
    for (const s of document.querySelectorAll('#menu summary')) {
      if (s.textContent.trim() === '软件') s.parentElement.open = true;
    }
  });
  const sound = page.locator('#m-alias button.agent-sound[aria-label="「Claude Code」的提示音"]');
  const notify = page.locator('#m-alias input[aria-label="接收「Claude Code」的系统通知"]');
  await expect(sound).toHaveAttribute('aria-pressed', 'true');
  await expect(notify).toBeChecked();

  await sound.click();
  await expect(sound).toHaveAttribute('aria-pressed', 'false');
  await expect(sound).toHaveText('静');
  await expect(notify).toBeChecked();

  await sound.click();
  await expect(sound).toHaveAttribute('aria-pressed', 'true');
  await expect(sound).toHaveText('声');
});

// 统计不能只留在菜单里：日报给写周报用，CSV 给表格/脚本用。
test('the work report can be exported as Markdown and CSV', async ({ page }) => {
  await api('/state', { session: 'report', agent: 'claude', state: 'busy' });
  await api('/state', { session: 'report', agent: 'claude', state: 'error' });
  await page.evaluate(() => document.getElementById('btn-menu').click());
  await page.evaluate(() => {
    for (const s of document.querySelectorAll('#menu summary')) {
      if (s.textContent.trim() === '配置') s.parentElement.open = true;
    }
  });
  // 等统计帧到达，导出的才是刚报上来的这一天。统计是服务端进程累计的，
  // 前面的用例可能已经给别的软件记过完成/出错，所以这里只找 Claude 这一行。
  await expect(page.locator('#m-score .score-row').filter({ hasText: 'Claude Code' }))
    .toBeVisible({ timeout: 6000 });

  const [md] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('#m-report-md').click(),
  ]);
  expect(md.suggestedFilename()).toMatch(/^baoanlight-report-.*\.md$/);
  const mdText = fs.readFileSync(await md.path(), 'utf8');
  expect(mdText).toContain('# baoanlight 工作记录');
  expect(mdText).toContain('Claude Code');
  expect(mdText).toContain('按天');

  const [csv] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('#m-report-csv').click(),
  ]);
  expect(csv.suggestedFilename()).toMatch(/^baoanlight-report-.*\.csv$/);
  const csvText = fs.readFileSync(await csv.path(), 'utf8');
  expect(csvText.startsWith('\ufeff')).toBe(true);
  expect(csvText).toContain('date,agent,name,minutes,done,error');
  expect(csvText).toContain('claude');

  // CSV 注入：agent 名以 = 开头时，Excel / WPS 会把它当公式执行。导出必须按
  // 字面量处理 —— 前置单引号，且文件里不能出现以 = 开头的裸单元格。
  const formula = '=1+1';
  await api('/state', { session: 'report-formula', agent: formula, state: 'busy' });
  await api('/state', { session: 'report-formula', agent: formula, state: 'error' });
  await expect(page.locator('#m-score .score-row').filter({ hasText: '=1+1' })).toBeVisible({ timeout: 6000 });
  const [csv2] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('#m-report-csv').click(),
  ]);
  const csvText2 = fs.readFileSync(await csv2.path(), 'utf8');
  expect(csvText2).toContain("'=1+1");
  expect(csvText2.split(/\r?\n/).some((line) => line.startsWith('=1+1'))).toBe(false);
});

// ------------------------------------------------------- 自定义系统逐项检查
//
// 设置面板有十一个分组、七十多个控件。「有控件」和「控件真的接上了」是两件事：
// 下面每条测试都要求一个可观察的结果（场景事件、DOM 状态或提示文字），而不是
// 只断言下拉框的值变了 —— 后者在 handler 完全没接的情况下也会通过。

const openGroups = async (page, names) => {
  // 只在菜单关着时才点开：这里通常是在别处点过之后调用的，无条件点一下会
  // 把刚打开的菜单又关掉。
  await page.evaluate(() => {
    const menu = document.getElementById('menu');
    if (menu.hidden) document.getElementById('btn-menu').click();
  });
  await page.evaluate((gs) => {
    for (const s of document.querySelectorAll('#menu summary')) {
      if (gs.includes(s.textContent.trim())) s.parentElement.open = true;
    }
  }, names);
};

// 3D 场景是另一个模块，测试里只需要它收到的事件：把窗口事件录下来，
// 断言载荷就是控件显示的那个值。
const watchBaoEvents = (page, names) => page.evaluate((ns) => {
  window.__bao = [];
  for (const n of ns) {
    window.addEventListener(n, (e) => window.__bao.push({ name: n, detail: e.detail }));
  }
}, names);

const baoEvent = (page, name) => page.evaluate((n) => {
  const hits = (window.__bao || []).filter((e) => e.name === n);
  return hits.length ? hits[hits.length - 1].detail : null;
}, name);

// 选一个「肯定不是当前值」的选项：index 1 在调色板里永远是另一种颜色，
// 不会因为默认值恰好是第一项而什么都没改。
const pickOption = async (page, id, index) => {
  const values = await page.locator(`#${id} option`).evaluateAll((os) => os.map((o) => o.value));
  expect(values.length, `#${id} 应该有足够选项`).toBeGreaterThan(index);
  await page.selectOption(`#${id}`, values[index]);
  return values[index];
};

test('the basic look controls all reach the scene', async ({ page }) => {
  await openGroups(page, ['基础']);
  await watchBaoEvents(page, ['bao:body', 'bao:scale', 'bao:brightness']);

  const body = await pickOption(page, 'm-body', 1);
  expect((await baoEvent(page, 'bao:body')).body).toBe(body);

  await page.evaluate(() => {
    const el = document.getElementById('m-size');
    el.value = '120';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expect(page.locator('#m-size-val')).toHaveText('120%');
  await expect.poll(() => page.evaluate(() =>
    document.documentElement.style.getPropertyValue('--scale'))).toBe('1.2');
  expect((await baoEvent(page, 'bao:scale')).scale).toBeCloseTo(1.2, 5);

  await page.evaluate(() => {
    const el = document.getElementById('m-brightness');
    el.value = '80';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expect(page.locator('#m-brightness-val')).toHaveText('80%');
  expect((await baoEvent(page, 'bao:brightness')).brightness).toBeCloseTo(0.8, 5);

  await page.selectOption('#m-thememode', 'mini');
  await expect(page.locator('body')).toHaveAttribute('data-theme', 'mini');
  await page.selectOption('#m-thememode', 'full');
  await expect(page.locator('body')).toHaveAttribute('data-theme', 'full');
});

test('every appearance dropdown is wired to the scene', async ({ page }) => {
  await openGroups(page, ['外观', '灯光', '材质']);
  const map = [
    ['m-skin', 'bao:skin', 'skin'],
    ['m-eyestyle', 'bao:eyestyle', 'eyestyle'],
    ['m-eyeshape', 'bao:eyeshape', 'eyeshape'],
    ['m-trackstyle', 'bao:trackstyle', 'trackstyle'],
    ['m-tracktype', 'bao:tracktype', 'tracktype'],
    ['m-armskin', 'bao:armskin', 'armskin'],
    ['m-claw', 'bao:claw', 'claw'],
    ['m-armtype', 'bao:armtype', 'armtype'],
    ['m-headtype', 'bao:headtype', 'headtype'],
    ['m-decoration', 'bao:decoration', 'decoration'],
    ['m-halo', 'bao:halo', 'halo'],
    ['m-effect', 'bao:effect', 'effect'],
    ['m-finish', 'bao:finish', 'finish'],
  ];
  await watchBaoEvents(page, map.map((x) => x[1]));
  for (const [id, evt, field] of map) {
    const value = await pickOption(page, id, 1);
    const detail = await baoEvent(page, evt);
    expect(detail, `${id} 没有发出 ${evt}`).not.toBeNull();
    expect(detail[field], `${id} 的事件载荷不对`).toBe(value);
  }
});

test('a colour theme applies all four parts at once', async ({ page }) => {
  await openGroups(page, ['外观']);
  await watchBaoEvents(page, ['bao:skin', 'bao:eyestyle', 'bao:trackstyle', 'bao:armskin']);
  const skinBefore = await page.locator('#m-skin').inputValue();

  await page.selectOption('#m-theme', '赛博霓虹');
  await expect(page.locator('#m-skin')).toHaveValue('深海蓝');
  const names = await page.evaluate(() => (window.__bao || []).map((e) => e.name));
  expect(names).toEqual(expect.arrayContaining(['bao:skin', 'bao:eyestyle', 'bao:trackstyle', 'bao:armskin']));
  expect(skinBefore).not.toBe('深海蓝');
  // 下拉要停在真正套用的那一套，而不是「自定义」。
  await expect(page.locator('#m-theme')).toHaveValue('赛博霓虹');
});

test('poses, idle behaviour, motion and wear are all wired', async ({ page }) => {
  await openGroups(page, ['动作', '材质']);
  await watchBaoEvents(page, ['bao:pose', 'bao:idle', 'bao:motion', 'bao:wear']);

  for (const st of ['error', 'waiting', 'busy', 'done', 'idle']) {
    await page.selectOption(`#m-pose-${st}`, '叉腰');
    expect(await baoEvent(page, 'bao:pose'), `#m-pose-${st} 没有发出手势事件`)
      .toEqual({ state: st, pose: '叉腰' });
  }

  await page.evaluate(() => {
    const el = document.getElementById('m-idle');
    el.checked = false;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect((await baoEvent(page, 'bao:idle')).on).toBe(false);

  await page.selectOption('#m-idlefreq', '快');
  expect((await baoEvent(page, 'bao:idle')).freq).toBe(2);

  await page.selectOption('#m-motion', '华丽');
  expect((await baoEvent(page, 'bao:motion')).motion).toBe('华丽');

  await page.evaluate(() => {
    const el = document.getElementById('m-wear');
    el.value = '60';
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await expect(page.locator('#m-wear-val')).toHaveText('60%');
  expect((await baoEvent(page, 'bao:wear')).wear).toBeCloseTo(0.6, 5);
});

test('scene, billboard and nameplate controls are wired', async ({ page }) => {
  await openGroups(page, ['场景', '广告牌']);
  await watchBaoEvents(page, ['bao:scene', 'bao:sign', 'bao:nameplate']);

  await page.selectOption('#m-scene', '星空');
  expect((await baoEvent(page, 'bao:scene')).scene).toBe('星空');
  // 色块必须跟着场景走，否则用户不知道「星空」是什么颜色。
  await expect.poll(() => page.evaluate(() =>
    document.getElementById('scene-swatch').style.background)).toContain('20, 22, 42');

  await page.selectOption('#m-sign', '合计');
  expect((await baoEvent(page, 'bao:sign')).mode).toBe('total');
  await page.selectOption('#m-sign-pos', '左侧');
  expect((await baoEvent(page, 'bao:sign')).pos).toBe('left');
  await page.selectOption('#m-sign-shape', '胶囊');
  expect((await baoEvent(page, 'bao:sign')).shape).toBe('胶囊');

  await page.evaluate(() => {
    const el = document.getElementById('m-nameplate');
    el.value = '小黄';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect((await baoEvent(page, 'bao:nameplate')).text).toBe('小黄');

  // 自动切换打开后，手动场景下拉置灰，白天/夜晚两档才出现。
  await page.evaluate(() => {
    const el = document.getElementById('m-autoscene');
    el.checked = true;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await expect(page.locator('#m-scene')).toBeDisabled();
  await expect(page.locator('#autoscene-opts')).toBeVisible();
});

test('sound, voice and mute controls all respond', async ({ page }) => {
  await openGroups(page, ['系统']);

  await page.evaluate(() => {
    const el = document.getElementById('m-sound');
    el.checked = true;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  // 打开提示音只该「试个音」，不能顺手报一次「需要你处理」。
  expect(await page.locator('#note').textContent()).toContain('提示音已开启');
  await expect(page.locator('#m-sound')).toBeChecked();

  const style = await pickOption(page, 'm-soundstyle', 1);
  await expect(page.locator('#m-soundstyle')).toHaveValue(style);

  await page.evaluate(() => {
    for (const [id, checked] of [['m-sounddone', false], ['m-notifydone', false], ['m-voice', true]]) {
      const el = document.getElementById(id);
      el.checked = checked;
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });
  await expect(page.locator('#m-sounddone')).not.toBeChecked();
  await expect(page.locator('#m-notifydone')).not.toBeChecked();
  await expect(page.locator('#m-voice')).toBeChecked();

  await page.evaluate(() => document.getElementById('m-mute').click());
  await expect(page.locator('#m-mute')).toContainText('已静音');
  await page.evaluate(() => document.getElementById('m-mute').click());
  await expect(page.locator('#m-mute')).toContainText('静音 1 小时');
});

test('the software list can be turned off without touching the lamp', async ({ page }) => {
  await api('/state', { session: 'labels', agent: 'claude', state: 'busy' });
  await openGroups(page, ['系统']);
  await settled(page, () => document.querySelectorAll('.pill').length).toBe(5);

  await page.evaluate(() => {
    const el = document.getElementById('m-labels');
    el.checked = false;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await settled(page, () => document.querySelectorAll('.pill').length).toBe(0);
  // 列表是显示项，灯仍然是那个软件的真实状态。
  await settled(page, () => document.body.dataset.state).toBe('busy');

  await page.evaluate(() => {
    const el = document.getElementById('m-labels');
    el.checked = true;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await settled(page, () => document.querySelectorAll('.pill').length).toBe(5);
});

test('the software order can be changed and drives the list', async ({ page }) => {
  await api('/state', { session: 'order', agent: 'claude', state: 'busy' });
  await openGroups(page, ['软件']);

  const order = () => page.locator('#m-order .row').evaluateAll((rows) => rows.map((r) => r.dataset.agent));
  const before = await order();
  expect(before.length).toBeGreaterThan(1);
  await expect(page.locator('#m-order .row').first().locator('button').first()).toBeDisabled();

  await page.locator('#m-order .row').first().locator('button').nth(1).click();
  await expect.poll(order).toEqual([before[1], before[0], ...before.slice(2)]);

  // 顺序不是只存在设置里：列表的第一行也要跟着换。
  await settled(page, () => document.querySelector('.pill')?.dataset.agent).toBe(before[1]);
});

test('a log directory can be pointed somewhere else from settings', async ({ page }) => {
  await openGroups(page, ['软件']);
  const input = page.locator('#m-agentdirs .agent-dir input').first();
  await expect(input).toBeVisible();

  await input.fill('D:/logs/agent');
  await input.dispatchEvent('change');
  expect(await page.locator('#note').textContent()).toContain('重启 watch all 生效');
  await expect(input).toHaveValue('D:/logs/agent');

  await input.fill('');
  await input.dispatchEvent('change');
  expect(await page.locator('#note').textContent()).toContain('恢复自动查找');
});

test('appearance presets save, apply and delete', async ({ page }) => {
  await openGroups(page, ['外观', '配置']);
  await page.selectOption('#m-decoration', '皇冠');

  // 空名字不能静默失败：点了「保存」却什么都没发生，用户只会再点几次。
  await page.locator('#m-preset-save').click();
  expect(await page.locator('#note').textContent()).toContain('请输入方案名');

  // 回车与按钮是同一条提交路径。
  await page.fill('#m-preset-name', '测试方案');
  await page.press('#m-preset-name', 'Enter');
  expect(await page.locator('#note').textContent()).toContain('已保存方案「测试方案」');
  await expect(page.locator('#m-preset-list option')).toHaveCount(1);

  await page.selectOption('#m-decoration', '无');
  await page.locator('#m-preset-apply').click();
  await expect(page.locator('#m-decoration')).toHaveValue('皇冠');
  expect(await page.locator('#note').textContent()).toContain('已应用方案「测试方案」');

  await page.locator('#m-preset-del').click();
  await expect(page.locator('#m-preset-list option')).toHaveCount(0);
  expect(await page.locator('#note').textContent()).toContain('已删除方案「测试方案」');
  // 空列表要把「下一步」说出来，而不是只剩一个空下拉和两个还能点的按钮。
  await expect(page.locator('#m-preset-empty')).toBeVisible();
  await expect(page.locator('#m-preset-apply')).toBeDisabled();
  await expect(page.locator('#m-preset-del')).toBeDisabled();
});

// 方案是可导入、可手改的数据。套用时必须按外观白名单取值：一个带 port 的
// 方案不能把端口写回配置，一个 brightness: 9 也不能让界面显示 100% 而磁盘里
// 永远留着 9。
test('an imported preset cannot write unrelated or out-of-range config', async ({ page }) => {
  await page.addInitScript(() => {
    window.__saved = [];
    window.bao = {
      serverUrl: location.origin,
      saveConfig: (patch) => { window.__saved.push(patch); },
      getConfig: () => Promise.resolve({
        presets: {
          危险: {
            port: 9999, window: { x: 1 }, skin: '不存在',
            brightness: 9, wear: -5, signOffset: { x: 'x', y: 0 },
          },
          空壳: { port: 9999 },
          无效: '不是对象',
        },
      }),
      getAutostart: () => Promise.resolve({ enabled: false }),
      setAutostart: () => Promise.resolve({ enabled: false }),
      contentSize: () => {}, hotRect: () => {}, onCursor: () => {}, notify: () => {},
      openTerminal: () => {}, trayStatus: () => {}, quit: () => {},
      dragStart: () => {}, dragEnd: () => {},
    };
  });
  await page.reload();
  await page.waitForFunction(() => document.body.dataset.state !== undefined);
  await openGroups(page, ['配置']);

  // 字符串方案在启动时就被过滤掉：下拉里只留下两个真正的对象。
  await expect(page.locator('#m-preset-list option')).toHaveCount(2);
  await page.selectOption('#m-preset-list', '危险');
  await page.locator('#m-preset-apply').click();
  // 配置落盘有 200ms 防抖：等这次写入真的发生，而不是读一个还没 flush 的数组。
  await page.waitForFunction(() => window.__saved.some((p) => p && p.brightness === 1));

  const saved = await page.evaluate(() => window.__saved);
  // 套用一套方案会分几次落盘（外观一次、广告牌一次），按合并后的结果断言：
  // 任何一次都不许出现未知键，越界值也必须先被夹住。
  const merged = Object.assign({}, ...saved);
  expect(merged).not.toHaveProperty('port');
  expect(merged).not.toHaveProperty('window');
  expect(merged).not.toHaveProperty('skin');
  expect(merged.brightness).toBe(1);
  expect(merged.wear).toBe(0);
  expect(merged.signOffset).toEqual({ x: 0, y: 0 });
  expect(await page.locator('#note').textContent()).toContain('已应用方案「危险」');

  // 一个只剩未知键的方案必须明确失败，并且不落盘。
  const before = saved.length;
  await page.selectOption('#m-preset-list', '空壳');
  await page.locator('#m-preset-apply').click();
  await expect(page.locator('#note')).toContainText('没有可用的外观设置');
  await page.waitForTimeout(350);   // 给防抖写盘留出机会，再断言确实什么都没写
  expect(await page.evaluate(() => window.__saved.length)).toBe(before);
});

// 首次 refresh 发生在 getConfig 返回之前。那一刻 cfg 里还没有磁盘上的时间，
// 如果没有初始值，「修复无效时间」的落盘会把 20:00/07:00 写在用户保存的
// 21:00/06:30 之上 —— 启动一次就丢一次设置。
test('startup never overwrites saved night hours before the config arrives', async ({ page }) => {
  await page.addInitScript(() => {
    window.__saved = [];
    window.bao = {
      serverUrl: location.origin,
      saveConfig: (patch) => { window.__saved.push(patch); },
      getConfig: () => Promise.resolve({ nightStart: '21:00', nightEnd: '06:30' }),
      getAutostart: () => Promise.resolve({ enabled: false }),
      setAutostart: () => Promise.resolve({ enabled: false }),
      contentSize: () => {}, hotRect: () => {}, onCursor: () => {}, notify: () => {},
      openTerminal: () => {}, trayStatus: () => {}, quit: () => {},
      dragStart: () => {}, dragEnd: () => {},
    };
  });
  await page.reload();
  await page.waitForFunction(() => document.body.dataset.state !== undefined);
  await page.waitForTimeout(300);   // 让首次防抖写盘真的发生
  const patches = await page.evaluate(() => window.__saved);
  expect(patches.some((p) => p && ('nightStart' in p || 'nightEnd' in p))).toBe(false);
});

test('the config export contains every customisation currently on screen', async ({ page }) => {
  await openGroups(page, ['基础', '外观', '场景', '日记', '系统', '配置']);
  await page.selectOption('#m-decoration', '围巾');
  await page.selectOption('#m-scene', '草原');
  await page.evaluate(() => {
    const el = document.getElementById('m-brightness');
    el.value = '75';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  // 日记与多会话的新开关同样属于「界面即配置」。
  await page.evaluate(() => {
    for (const id of ['m-notes-open', 'm-expand-sessions']) {
      const el = document.getElementById(id);
      el.checked = true;
      el.dispatchEvent(new Event('change'));
    }
  });

  const [dl] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('#m-export').click(),
  ]);
  expect(dl.suggestedFilename()).toBe('bao-config.json');
  const data = JSON.parse(fs.readFileSync(await dl.path(), 'utf8'));
  // 这三项都是「只写界面、不回写 cfg」的控件：导出必须从界面读回来，
  // 否则导出的是一份启动时的旧配置。
  expect(data.decoration).toBe('围巾');
  expect(data.scene).toBe('草原');
  expect(data.brightness).toBeCloseTo(0.75, 5);
  // 方案、手势、软件顺序这些结构性自定义也要在里面。
  expect(data.poses).toBeTruthy();
  expect(Array.isArray(data.agentOrder)).toBe(true);
  expect(data.showLabels).toBe(true);
  expect(data.memoOpen).toBe(true);
  expect(data.expandSessions).toBe(true);
  // 广告牌拖动位置也要能带走，否则换台机器就回到出厂位置。
  expect(data.signOffset).toEqual({ x: 0, y: 0 });
});

test('reset look restores the factory appearance, random look stays valid', async ({ page }) => {
  await openGroups(page, ['外观']);
  await watchBaoEvents(page, ['bao:skin', 'bao:decoration', 'bao:scene']);

  await page.selectOption('#m-decoration', '皇冠');
  await page.locator('#m-reset-look').click();
  await expect(page.locator('#m-decoration')).toHaveValue('无');
  await expect(page.locator('#m-skin')).toHaveValue('钛金白');

  await page.evaluate(() => { window.__bao = []; });
  await page.locator('#m-random-look').click();
  // 随机换装必须至少改一项，而且改出来的值仍然在合法选项里。
  expect(await page.evaluate(() => (window.__bao || []).length)).toBeGreaterThan(0);
  const skinOk = await page.evaluate(() => {
    const sel = document.getElementById('m-skin');
    return [...sel.options].some((o) => o.value === sel.value);
  });
  expect(skinOk).toBe(true);
});

test('a broken config file is reported instead of reloading silently', async ({ page }) => {
  await openGroups(page, ['配置']);
  await page.setInputFiles('#m-import-file', {
    name: 'broken.json',
    mimeType: 'application/json',
    buffer: Buffer.from('{ not json'),
  });
  await expect(page.locator('#note')).toContainText('不是有效的配置文件');
});

test('the information board offers time, goal and companionship', async ({ page }) => {
  await openGroups(page, ['广告牌', '基础']);
  await watchBaoEvents(page, ['bao:sign']);

  await page.selectOption('#m-sign', '时钟');
  expect((await baoEvent(page, 'bao:sign')).mode).toBe('clock');

  await page.selectOption('#m-sign', '今日目标');
  expect((await baoEvent(page, 'bao:sign')).mode).toBe('goal');
  // 改目标时牌面要立刻跟着改，而不是等下一次打开菜单。
  await page.selectOption('#m-goal', '4');
  const afterGoal = await baoEvent(page, 'bao:sign');
  expect(afterGoal.mode).toBe('goal');
  expect(afterGoal.goalHours).toBe(4);

  await page.selectOption('#m-sign', '陪伴天数');
  const days = await baoEvent(page, 'bao:sign');
  expect(days.mode).toBe('days');
  expect(typeof days.days).toBe('number');

  // 三种「现在要不要管」的计数模式：不依赖今天的时长统计。
  await page.selectOption('#m-sign', '需要你');
  expect((await baoEvent(page, 'bao:sign')).mode).toBe('needs');
  await page.selectOption('#m-sign', '今日完成');
  expect((await baoEvent(page, 'bao:sign')).mode).toBe('done');
  await page.selectOption('#m-sign', '会话数');
  expect((await baoEvent(page, 'bao:sign')).mode).toBe('sessions');

  await page.selectOption('#m-sign', '关闭');
  expect((await baoEvent(page, 'bao:sign')).mode).toBe('off');
});

test('the extended palette reaches the robot', async ({ page }) => {
  await openGroups(page, ['外观']);
  await watchBaoEvents(page, ['bao:skin', 'bao:eyestyle', 'bao:trackstyle', 'bao:armskin']);
  for (const [id, name, evt, field] of [
    ['m-skin', '钛金白', 'bao:skin', 'skin'],
    ['m-eyestyle', '白瞳', 'bao:eyestyle', 'eyestyle'],
    ['m-trackstyle', '石墨', 'bao:trackstyle', 'trackstyle'],
    ['m-armskin', '玫瑰金', 'bao:armskin', 'armskin'],
  ]) {
    await page.selectOption(`#${id}`, name);
    expect((await baoEvent(page, evt))[field]).toBe(name);
  }
});

test('the personality can be chosen and reaches the robot', async ({ page }) => {
  await openGroups(page, ['动作']);
  await expect(page.locator('#m-personality')).toHaveValue('活泼');
  await page.selectOption('#m-personality', '害羞');
  // robot3d 每帧读这个属性；改动必须立刻生效，而不是等重启。
  await expect(page.locator('body')).toHaveAttribute('data-personality', '害羞');
  await expect(page.locator('#m-look')).toContainText('害羞');
});

test('the settings header summarises the current look', async ({ page }) => {
  await openGroups(page, ['外观', '场景', '基础']);
  await expect(page.locator('#m-look')).toContainText('配色');
  await expect(page.locator('#m-look')).toContainText('人格');

  await page.selectOption('#m-theme', '赛博霓虹');
  await expect(page.locator('#m-look')).toContainText('赛博霓虹');
  await page.selectOption('#m-scene', '星空');
  await expect(page.locator('#m-look')).toContainText('星空');
  await page.selectOption('#m-body', '修长');
  await expect(page.locator('#m-look')).toContainText('修长');
});

// 保存下来的设置重启后必须回到各自的控件上：这是「自定义」的另一半。
// 用一份「每一项都非默认」的配置启动页面，任何一项恢复逻辑漏了都会红。
test('every saved customisation is restored into its control on startup', async ({ page }) => {
  const saved = {
    theme: 'mini', scale: 1.2, brightness: 0.8, body: '修长',
    skin: '深海蓝', eyestyle: '蓝瞳', eyeshape: '三角', trackstyle: '黑',
    tracktype: '梯形', armskin: '银白', claw: '三指', armtype: '圆筒', headtype: '三眼',
    decoration: '皇冠', baseEffect: '彩虹', halo: '星形', finish: '精工', wear: 0.6,
    scene: '海洋', autoScene: true, dayScene: '草原', nightScene: '雪夜',
    nightStart: '21:00', nightEnd: '06:30', motion: '华丽',
    poses: { error: '环抱', waiting: '叉腰', busy: '泵动', done: '鼓掌', idle: '垂放' },
    idleActions: false, idleFreq: '快', clickAction: 'greet', doubleClick: 'none',
    sound: true, soundStyle: '电子脉冲', soundVolume: 0.45, soundDone: false, notifyDone: false,
    voice: true, muteMinutes: 120, mutedUntil: 0,
    clickThrough: false, hotkeyOn: false, hotkey: 'Alt+Shift+B',
    showLabels: false, showOffline: false, showModel: false, showSys: false, sysMotion: 'load',
    stuckBusyMin: 20, stuckWaitMin: 7,
    maxRows: 3, showScore: false, showRecent: false, dailyGoalHours: 4,
    notesRemindMinutes: 0, notesNotify: false,
    memoOpen: true, expandSessions: true,
    doNotDisturb: true, dndStart: '00:00', dndEnd: '23:59',
    signMode: 'clock', signPos: 'left', signColor: '#4ad5ff', signShape: '胶囊', customSign: '#4ad5ff',
    nameplate: '阿黄', phrases: { waiting: '等你', error: '坏了', done: '好了' },
    personality: '害羞',
    aliases: { claude: '小C' }, agentColors: { claude: '#123456' }, mutedAgents: ['codex'],
    mutedSoundAgents: ['codex'], agents: { codex: { dir: 'D:/codex-logs' } },
    presets: { 我的方案: { skin: '军绿' } },
  };

  // 注入 Electron 预加载接口：页面会走「真实启动」那条分支，把配置逐项写回控件。
  await page.addInitScript((cfg) => {
    window.bao = {
      serverUrl: location.origin,
      saveConfig: () => {},
      getConfig: () => Promise.resolve(cfg),
      getAutostart: () => Promise.resolve({ enabled: false }),
      setAutostart: () => Promise.resolve({ enabled: false }),
      contentSize: () => {}, hotRect: () => {}, onCursor: () => {}, notify: () => {},
      openTerminal: () => {}, trayStatus: () => {}, quit: () => {},
      dragStart: () => {}, dragEnd: () => {},
    };
  }, saved);
  await page.reload();
  await page.waitForFunction(() => document.body.dataset.state !== undefined);
  await openGroups(page, ['基础', '灯光', '外观', '材质', '动作', '台词', '日记', '场景', '系统', '广告牌', '软件', '配置']);

  // 基础 / 外观 / 材质
  await expect(page.locator('#m-thememode')).toHaveValue('mini');
  await expect(page.locator('#m-size')).toHaveValue('120');
  await expect(page.locator('#m-brightness')).toHaveValue('80');
  await expect(page.locator('#m-body')).toHaveValue('修长');
  await expect(page.locator('#m-skin')).toHaveValue('深海蓝');
  await expect(page.locator('#m-eyestyle')).toHaveValue('蓝瞳');
  await expect(page.locator('#m-eyeshape')).toHaveValue('三角');
  await expect(page.locator('#m-trackstyle')).toHaveValue('黑');
  await expect(page.locator('#m-tracktype')).toHaveValue('梯形');
  await expect(page.locator('#m-armskin')).toHaveValue('银白');
  await expect(page.locator('#m-claw')).toHaveValue('三指');
  await expect(page.locator('#m-armtype')).toHaveValue('圆筒');
  await expect(page.locator('#m-headtype')).toHaveValue('三眼');
  await expect(page.locator('#m-decoration')).toHaveValue('皇冠');
  await expect(page.locator('#m-effect')).toHaveValue('彩虹');
  await expect(page.locator('#m-halo')).toHaveValue('星形');
  await expect(page.locator('#m-finish')).toHaveValue('精工');
  await expect(page.locator('#m-wear')).toHaveValue('60');

  // 场景：自动切换优先，手动下拉置灰；白天/夜晚两档按配置恢复。
  await expect(page.locator('#m-autoscene')).toBeChecked();
  await expect(page.locator('#m-scene')).toBeDisabled();
  await expect(page.locator('#m-dayscene')).toHaveValue('草原');
  await expect(page.locator('#m-nightscene')).toHaveValue('雪夜');
  await expect(page.locator('#m-night-start')).toHaveValue('21:00');
  await expect(page.locator('#m-night-end')).toHaveValue('06:30');
  await expect(page.locator('#m-motion')).toHaveValue('华丽');

  // 动作
  await expect(page.locator('#m-pose-waiting')).toHaveValue('叉腰');
  await expect(page.locator('#m-pose-done')).toHaveValue('鼓掌');
  await expect(page.locator('#m-idle')).not.toBeChecked();
  await expect(page.locator('#m-idlefreq')).toHaveValue('快');
  await expect(page.locator('#m-clickaction')).toHaveValue('greet');
  await expect(page.locator('#m-dblclick')).toHaveValue('none');

  // 声音 / 勿扰
  await expect(page.locator('#m-sound')).toBeChecked();
  await expect(page.locator('#m-soundstyle')).toHaveValue('电子脉冲');
  await expect(page.locator('#m-soundvol')).toHaveValue('45');
  await expect(page.locator('#m-sounddone')).not.toBeChecked();
  await expect(page.locator('#m-notifydone')).not.toBeChecked();
  await expect(page.locator('#m-voice')).toBeChecked();
  await expect(page.locator('#m-mutedur')).toHaveValue('120');
  await expect(page.locator('#m-mute')).toContainText('2 小时');
  await expect(page.locator('#m-dnd')).toBeChecked();
  await expect(page.locator('#m-dnd-start')).toHaveValue('00:00');
  await expect(page.locator('#m-dnd-end')).toHaveValue('23:59');

  // 系统 / 列表
  await expect(page.locator('#m-click')).not.toBeChecked();
  await expect(page.locator('#m-hotkey')).not.toBeChecked();
  await expect(page.locator('#m-hotkey-key')).toHaveValue('Alt+Shift+B');
  await expect(page.locator('#m-labels')).not.toBeChecked();
  await expect(page.locator('#m-offline')).not.toBeChecked();
  await expect(page.locator('#m-model')).not.toBeChecked();
  await expect(page.locator('#m-sys')).not.toBeChecked();
  await expect(page.locator('#m-sys-motion')).toHaveValue('load');
  await expect(page.locator('#sys')).toHaveAttribute('data-motion', 'load');
  await expect(page.locator('#m-stuck-busy')).toHaveValue('20');
  await expect(page.locator('#m-stuck-wait')).toHaveValue('7');
  await expect(page.locator('#m-score-panel')).not.toBeChecked();
  await expect(page.locator('#m-recent-panel')).not.toBeChecked();
  await expect(page.locator('#m-maxrows')).toHaveValue('3');
  await expect(page.locator('#m-goal')).toHaveValue('4');
  await expect(page.locator('#m-notes-remind')).toHaveValue('0');
  await expect(page.locator('#m-notes-notify')).not.toBeChecked();
  await expect(page.locator('#m-notes-open')).toBeChecked();
  await expect(page.locator('#m-expand-sessions')).toBeChecked();
  await expect(page.locator('#memo')).toBeVisible();

  // 广告牌 / 铭牌 / 台词 / 人格
  await expect(page.locator('#m-sign')).toHaveValue('时钟');
  await expect(page.locator('#m-sign-pos')).toHaveValue('左侧');
  await expect(page.locator('#m-sign-color')).toHaveValue('青色');
  await expect(page.locator('#m-sign-shape')).toHaveValue('胶囊');
  await expect(page.locator('#m-nameplate')).toHaveValue('阿黄');
  await expect(page.locator('#m-phrase-waiting')).toHaveValue('等你');
  await expect(page.locator('#m-personality')).toHaveValue('害羞');
  await expect(page.locator('#m-look')).toContainText('害羞');

  // 软件：改名 / 颜色 / 通知 / 提示音 / 日志目录 / 方案
  await expect(page.locator('#m-alias input[aria-label="给「Claude Code」改名"]')).toHaveValue('小C');
  await expect(page.locator('#m-alias input.agent-color[aria-label="「Claude Code」在今日战绩里的颜色"]'))
    .toHaveValue('#123456');
  await expect(page.locator('#m-alias input[aria-label="接收「Codex」的系统通知"]')).not.toBeChecked();
  await expect(page.locator('#m-alias button.agent-sound[aria-label="「Codex」的提示音"]'))
    .toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#m-agentdirs input[aria-label="Codex 的日志目录"]')).toHaveValue('D:/codex-logs');
  await expect(page.locator('#m-preset-list option')).toHaveCount(1);
  await expect(page.locator('#m-preset-list')).toHaveValue('我的方案');
});

test('a software with several sessions expands into one row each', async ({ page }) => {
  await api('/state', { session: 'a', agent: 'claude', state: 'busy', detail: '读文件', cwd: 'D:/work/alpha' });
  await api('/state', { session: 'b', agent: 'claude', state: 'waiting', detail: '等你确认', cwd: 'D:/work/beta' });

  // 右键会话行要在该会话自己的目录里开终端，所以需要真实的桥。
  await page.addInitScript(() => {
    window.__opened = [];
    window.bao = {
      serverUrl: location.origin,
      getConfig: () => Promise.resolve({}),
      saveConfig: () => Promise.resolve({}),
      getAutostart: () => Promise.resolve({ enabled: false }),
      setAutostart: () => Promise.resolve({ enabled: false }),
      getNotes: () => Promise.resolve({ day: '', items: [], open: 0, done: 0, doneToday: 0 }),
      saveNotes: () => Promise.resolve({}),
      contentSize: () => {}, hotRect: () => {}, onCursor: () => {}, notify: () => {},
      openTerminal: (cwd) => window.__opened.push(cwd),
      trayStatus: () => {}, quit: () => {},
      dragStart: () => {}, dragEnd: () => {},
    };
  });
  await page.reload();
  await page.waitForFunction(() => document.body.dataset.state !== undefined);

  const pill = page.locator('.pill[data-agent="claude"]');
  await expect(pill.locator('.pill-expand')).toHaveText(/×2/);
  await expect(page.locator('.subpill')).toHaveCount(0);

  await pill.locator('.pill-expand').click();
  await expect(page.locator('.subpill')).toHaveCount(2);
  // 两个会话的状态和说明要各自可见，而不是只剩一个「最坏者」。
  await expect(page.locator('.subpill', { hasText: '等你确认' })).toHaveCount(1);
  await expect(page.locator('.subpill', { hasText: '读文件' })).toHaveCount(1);
  // 行上要有人认得出的东西：目录名 + 短 id，而不是八位十六进制。
  await expect(page.locator('.subpill', { hasText: 'alpha' })).toHaveCount(1);
  await expect(page.locator('.subpill', { hasText: 'beta' })).toHaveCount(1);
  await expect(pill.locator('.pill-expand')).toHaveAttribute('aria-expanded', 'true');
  // 悬停出现的终端入口：点它也在该会话目录开终端。
  await expect(page.locator('.subpill', { hasText: 'alpha' }).locator('.subterm')).toBeVisible();
  await page.locator('.subpill', { hasText: 'alpha' }).locator('.subterm').click();
  await expect.poll(() => page.evaluate(() => window.__opened)).toEqual(['D:/work/alpha']);

  // 右键某条会话：开在它自己的目录里。
  await page.locator('.subpill', { hasText: 'alpha' }).click({ button: 'right' });
  await expect.poll(() => page.evaluate(() => window.__opened)).toEqual(['D:/work/alpha', 'D:/work/alpha']);

  // 点会话行 = 聚焦这个软件，和点主行一致。
  await page.locator('.subpill', { hasText: 'alpha' }).click();
  await expect(pill).toHaveClass(/focused/);
  await expect(page.locator('.subpill', { hasText: 'alpha' })).toHaveClass(/focused/);
  await page.locator('.subpill', { hasText: 'alpha' }).click();
  await expect(pill).not.toHaveClass(/focused/);

  await pill.locator('.pill-expand').click();
  await expect(page.locator('.subpill')).toHaveCount(0);
});

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

// 「默认展开多会话」打开后，不用每帧点一次 ×N；手动收起后不会被重新拉开。
test('the default-expand setting opens multi-session software on its own', async ({ page }) => {
  await api('/state', { session: 'a', agent: 'claude', state: 'busy', detail: '读文件' });
  await api('/state', { session: 'b', agent: 'claude', state: 'waiting', detail: '等你确认' });

  await page.addInitScript(() => {
    window.bao = {
      serverUrl: location.origin,
      getConfig: () => Promise.resolve({ expandSessions: true }),
      saveConfig: () => Promise.resolve({}),
      getAutostart: () => Promise.resolve({ enabled: false }),
      setAutostart: () => Promise.resolve({ enabled: false }),
      getNotes: () => Promise.resolve({ day: '', items: [], open: 0, done: 0, doneToday: 0 }),
      saveNotes: () => Promise.resolve({}),
      contentSize: () => {}, hotRect: () => {}, onCursor: () => {}, notify: () => {},
      openTerminal: () => {}, trayStatus: () => {}, quit: () => {},
      dragStart: () => {}, dragEnd: () => {},
    };
  });
  await page.reload();
  await page.waitForFunction(() => document.body.dataset.state !== undefined);

  const pill = page.locator('.pill[data-agent="claude"]');
  await expect(page.locator('.subpill')).toHaveCount(2);
  await expect(pill.locator('.pill-expand')).toHaveAttribute('aria-expanded', 'true');

  // 手动收起后保持收起，等下一帧也不会被设置重新展开。
  await pill.locator('.pill-expand').click();
  await expect(page.locator('.subpill')).toHaveCount(0);
  // 聚合行显示的是最坏的那个会话（waiting），所以用它的新说明确认页面确实重画过。
  await api('/state', { session: 'b', agent: 'claude', state: 'waiting', detail: '又催了一次' });
  await settled(page, () => document.querySelector('.pill[data-agent="claude"] span')?.textContent)
    .toContain('又催了一次');
  await expect(page.locator('.subpill')).toHaveCount(0);
});

// 桌面便签：真实读写测试服务器的 /notes（通过注入的预加载桥，写操作带 token）。
test('the desk memo stores, completes and deletes tasks', async ({ page }) => {
  // 清空上一个测试可能留下的条目。
  const pre = await (await fetch(base + '/notes')).json();
  for (const it of pre.items || []) {
    await fetch(base + '/notes', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-bao-token': token },
      body: JSON.stringify({ action: 'remove', id: it.id }),
    });
  }

  await page.addInitScript(({ b, t }) => {
    const json = (r) => r.json();
    window.bao = {
      serverUrl: b,
      getConfig: () => Promise.resolve({}),
      saveConfig: () => Promise.resolve({}),
      getAutostart: () => Promise.resolve({ enabled: false }),
      setAutostart: () => Promise.resolve({ enabled: false }),
      getNotes: () => fetch(b + '/notes').then(json),
      saveNotes: (action) => fetch(b + '/notes', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-bao-token': t },
        body: JSON.stringify(action),
      }).then(json),
      contentSize: () => {}, hotRect: () => {}, onCursor: () => {}, notify: () => {},
      openTerminal: () => {}, trayStatus: () => {}, quit: () => {},
      dragStart: () => {}, dragEnd: () => {},
    };
  }, { b: base, t: token });
  await page.reload();
  await page.waitForFunction(() => document.body.dataset.state !== undefined);

  await page.evaluate(() => document.getElementById('btn-memo').click());
  await expect(page.locator('#memo')).toBeVisible();
  await page.fill('#memo-input', '写周报');
  await page.press('#memo-input', 'Enter');

  const item = page.locator('.memo-item', { hasText: '写周报' });
  await expect(item).toHaveCount(1);
  await expect(page.locator('#memo-badge')).toHaveText('1');

  // 关掉面板后，未完成的事仍然在机器人脚边露出来；点它重新打开。
  await page.locator('#memo-close').click();
  await expect(page.locator('#memo')).toBeHidden();
  const peek = page.locator('#memo-peek');
  await expect(peek).toBeVisible();
  await expect(peek).toHaveText('1');
  await peek.click();
  await expect(page.locator('#memo')).toBeVisible();

  // 双击就地改字：条目本身还在，不需要删了重加。
  await item.locator('.memo-text').dblclick();
  const edit = page.locator('.memo-edit');
  await expect(edit).toHaveValue('写周报');
  await edit.fill('写月报');
  await edit.press('Enter');
  await expect(page.locator('.memo-item', { hasText: '写月报' })).toHaveCount(1);
  await expect(page.locator('.memo-item', { hasText: '写周报' })).toHaveCount(0);

  const renamed = page.locator('.memo-item', { hasText: '写月报' });
  // 置顶：它会被排到最上面，并出现「置顶」分组。
  await renamed.locator('.memo-pin').click();
  await expect(renamed.locator('.memo-pin')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.memo-group').first()).toHaveText('置顶');

  await renamed.locator('.memo-check').click();
  await expect(renamed).toHaveClass(/done/);
  await expect(page.locator('#memo-badge')).toBeHidden();
  // 完成统计按完成时刻算：刚勾掉的这条就是「今天 1」。
  await expect(page.locator('#memo-done-note')).toContainText('今天 1');

  await renamed.locator('.memo-del').click();
  await expect(page.locator('.memo-item')).toHaveCount(0);
  // 删除后可撤销：条目原样回来（包括它已完成的状态）。
  await expect(page.locator('#memo-undo')).toBeVisible();
  await page.locator('#memo-undo-btn').click();
  await expect(page.locator('.memo-item', { hasText: '写月报' })).toHaveClass(/done/);
});

// 一张写满的便签：滚动位置不能在勾选后跳回顶部，新记下的事必须自己滚进视野，
// 否则用户会以为「没保存」或「找不到刚才那条」。
test('a long memo list keeps its scroll position and reveals a new item', async ({ page }) => {
  await page.addInitScript(() => {
    const state = {
      day: '2026-11-17',
      items: Array.from({ length: 20 }, (_, i) => ({
        id: 'n' + i, text: `第 ${i + 1} 件要做的事`, done: false, day: '2026-11-17',
      })),
      open: 20, done: 0, doneToday: 0,
    };
    const snap = () => ({
      ...state,
      items: state.items.map((i) => ({ ...i })),
      open: state.items.filter((i) => !i.done).length,
      done: state.items.filter((i) => i.done).length,
    });
    window.bao = {
      serverUrl: location.origin,
      getConfig: () => Promise.resolve({ memoOpen: true }),
      saveConfig: () => Promise.resolve({}),
      getAutostart: () => Promise.resolve({ enabled: false }),
      setAutostart: () => Promise.resolve({ enabled: false }),
      getNotes: () => Promise.resolve(snap()),
      saveNotes: (a) => {
        if (a.action === 'add') {
          state.items.push({ id: 'x' + state.items.length, text: a.text, done: false, day: state.day });
        } else if (a.action === 'toggle') {
          const it = state.items.find((i) => i.id === a.id);
          if (it) it.done = !it.done;
        }
        return Promise.resolve(snap());
      },
      contentSize: () => {}, hotRect: () => {}, onCursor: () => {}, notify: () => {},
      openTerminal: () => {}, trayStatus: () => {}, quit: () => {},
      dragStart: () => {}, dragEnd: () => {},
    };
  });
  await page.reload();
  await page.waitForFunction(() => document.body.dataset.state !== undefined);
  await expect(page.locator('.memo-item')).toHaveCount(20);
  // 覆盖式滚动条平时不可见：列表底部必须有一句「还有更多」。
  await expect(page.locator('#memo-more')).toBeVisible();

  await page.evaluate(() => { document.getElementById('memo-list').scrollTop = 9999; });
  await expect(page.locator('#memo-more')).toBeHidden();
  await page.evaluate(() => { document.getElementById('memo-list').scrollTop = 120; });
  await page.locator('.memo-item').nth(9).locator('.memo-check').click();
  await expect.poll(() => page.evaluate(() => document.getElementById('memo-list').scrollTop))
    .toBeGreaterThan(0);

  await page.fill('#memo-input', '新记下的一件事');
  await page.press('#memo-input', 'Enter');
  const fresh = page.locator('.memo-item', { hasText: '新记下的一件事' });
  await expect(fresh).toHaveCount(1);
  // 新条目在可视区域内（不必是列表最后一行：已完成的排在后面）。
  await expect.poll(() => page.evaluate(() => {
    const list = document.getElementById('memo-list');
    const row = [...document.querySelectorAll('.memo-item')]
      .find((el) => el.textContent.includes('新记下的一件事'));
    if (!row) return false;
    const lr = list.getBoundingClientRect();
    const rr = row.getBoundingClientRect();
    return rr.top >= lr.top - 1 && rr.bottom <= lr.bottom + 1;
  })).toBe(true);
});

// 快速记一条：Ctrl+Shift+N 只开一条输入，不摊开整张便签。
test('a quick note can be added with the keyboard without opening the memo', async ({ page }) => {
  await page.addInitScript(() => {
    const state = { day: '2026-11-17', items: [], open: 0, done: 0, doneToday: 0, olderOpen: 0 };
    const snap = () => ({ ...state, items: state.items.map((i) => ({ ...i })) });
    window.bao = {
      serverUrl: location.origin,
      getConfig: () => Promise.resolve({}),
      saveConfig: () => Promise.resolve({}),
      getAutostart: () => Promise.resolve({ enabled: false }),
      setAutostart: () => Promise.resolve({ enabled: false }),
      getNotes: () => Promise.resolve(snap()),
      saveNotes: (a) => {
        if (a.action === 'add') {
          state.items.push({ id: 'x' + state.items.length, text: a.text, done: false, day: state.day });
          state.open += 1;
        }
        return Promise.resolve(snap());
      },
      contentSize: () => {}, hotRect: () => {}, onCursor: () => {}, notify: () => {},
      openTerminal: () => {}, trayStatus: () => {}, quit: () => {},
      dragStart: () => {}, dragEnd: () => {},
    };
  });
  await page.reload();
  await page.waitForFunction(() => document.body.dataset.state !== undefined);
  await expect(page.locator('#memo')).toBeHidden();

  await page.keyboard.press('Control+Shift+N');
  await expect(page.locator('#quick-add')).toBeVisible();
  await page.fill('#quick-add-input', '快速记下的事');
  await page.press('#quick-add-input', 'Enter');
  await expect(page.locator('#quick-add')).toBeHidden();
  await expect(page.locator('#memo-badge')).toHaveText('1');

  await page.evaluate(() => document.getElementById('btn-memo').click());
  await expect(page.locator('.memo-item', { hasText: '快速记下的事' })).toHaveCount(1);
});

// 一个软件会话很多时，展开不能把整张桌面推下去：先列 6 条，其余折起来。
test('a software with many sessions caps the list and offers the rest', async ({ page }) => {
  for (let i = 0; i < 8; i++) {
    await api('/state', {
      session: 'many' + i, agent: 'codex', state: 'busy',
      detail: '任务 ' + i, cwd: 'D:/work/p' + i,
    });
  }
  const pill = page.locator('.pill[data-agent="codex"]');
  await expect(pill.locator('.pill-expand')).toHaveText(/×8/);
  await pill.locator('.pill-expand').click();

  await expect(page.locator('.subpill:not(.more)')).toHaveCount(6);
  await expect(page.locator('.subpill.more')).toHaveText(/还有 2 个会话/);
  await page.locator('.subpill.more').click();
  await expect(page.locator('.subpill:not(.more)')).toHaveCount(8);
  await expect(page.locator('.subpill.more')).toHaveCount(0);
});

// 放在最后：它会在测试专用的 cc-switch 目录里摆一份「已接管」的状态，
// cc-switch 的缓存 10 秒才刷新一次，清理要等下一轮，不适合影响别的用例。
test('the model label can be hidden without hiding the software', async ({ page }) => {
  fs.mkdirSync(path.join(ccSwitchHome, '.cc-switch'), { recursive: true });
  fs.mkdirSync(path.join(ccSwitchHome, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(ccSwitchHome, '.cc-switch', 'live-state.json'),
    JSON.stringify({ apps: { claude: { attached: true, mode: 'proxy' } } }));
  fs.writeFileSync(path.join(ccSwitchHome, '.cc-switch', 'settings.json'),
    JSON.stringify({ currentProviderClaude: 'deepseek' }));
  fs.writeFileSync(path.join(ccSwitchHome, '.claude', 'settings.json'),
    JSON.stringify({ env: { ANTHROPIC_MODEL: 'deepseek-v4.1-flash' } }));

  await api('/state', { session: 'model', agent: 'claude', state: 'busy' });
  const pillText = () => page.evaluate(() =>
    document.querySelector('.pill[data-agent="claude"]')?.textContent || '');
  // 服务端每 10 秒才重读一次 cc-switch：等它自己刷新，不催。
  await expect.poll(pillText, { timeout: 25000 }).toContain('deepseek-v4.1-flash');

  await openGroups(page, ['系统']);
  await page.evaluate(() => {
    const el = document.getElementById('m-model');
    el.checked = false;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await expect.poll(pillText).not.toContain('deepseek-v4.1-flash');
  await expect(page.locator('.pill[data-agent="claude"] b')).toHaveText('Claude Code');
});
