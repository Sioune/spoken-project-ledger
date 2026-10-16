import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from '../.sites-runtime/browser-qa/node_modules/playwright-core/index.mjs';
import { base } from './local-base.mjs';

// Only local frontend assets are fetched. All business reads use fictional
// fixtures, and every write is rejected before dispatch, including MCP calls.
const out = path.resolve('.sites-runtime/calendar-ui-proof');
fs.mkdirSync(out, { recursive: true });
const checks = [], screenshots = [], pageErrors = [], blockedWrites = [], externalRequests = [];
const project = (id, name, extra = {}) => ({ id, name, status: 'active', registered_at: null, registration_source: 'unknown', start_date: null, target_end_date: null, completed_date: null, ...extra });
const task = (id, title, extra = {}) => ({ id, project_id: 'cal-a', title, status: 'todo', next_action: '这是完整的虚构下一步，打开任务后核对。', dependencies: [], registered_at: null, registration_source: 'unknown', planned_date: null, due_at: null, completed_at: null, ...extra });
const calendarFixture = {
  revision: 41, timezone: 'Asia/Shanghai', generated_at: '2026-10-16T08:00:00Z', history_complete: false,
  warnings: ['虚构历史页缺失：登记来源未知的任务单独保留。'],
  projects: [
    project('cal-a', '虚构建模项目', { registered_at: '2026-09-30T16:30:00Z', registration_source: 'history', target_end_date: '2026-10-28' }),
    project('cal-b', '虚构交付项目', { registered_at: '2026-10-14T16:30:00Z', registration_source: 'recorded', start_date: '2026-10-14', target_end_date: '2026-10-30', completed_date: '2026-10-15' }),
    project('cal-empty', '虚构空项目'),
  ],
  tasks: [
    task('cal-cross', '虚构上海跨日登记', { registered_at: '2026-10-15T16:30:00Z', registration_source: 'recorded' }),
    task('cal-report', '虚构口述完成节点', { status: 'done', registered_at: '2026-10-10T02:00:00Z', registration_source: 'history', completed_at: '2026-10-16T02:00:00Z' }),
    task('cal-plan', '虚构长期计划节点', { registered_at: '2026-10-13T01:00:00Z', registration_source: 'recorded', planned_date: '2001-06-15' }),
    task('cal-unknown', '虚构登记日未知'),
    task('cal-other', '虚构另一项目任务', { project_id: 'cal-b', registered_at: '2026-10-15T01:00:00Z', registration_source: 'recorded', due_at: '2026-10-25T16:00:00Z' }),
  ],
};

function stateFor(calendar, revision = calendar.revision) {
  return { initialized: true, revision, identity: { displayName: '隔离日历验收' }, data: {
    projects: calendar.projects.map(item => ({ ...item, goal: '完全虚构的日历测试项目', completion_rule: '本人核对', external_links: [], version: 1 })),
    tasks: calendar.tasks.map(item => ({ ...item, updated_at: '2026-10-16T08:00:00Z', created_at: item.registration_source === 'recorded' ? item.registered_at : null, version: 1, verification_state: 'user_reported', source_ref: '仅为隔离日历验收fixture' })),
    documents: [], pending: [], settings: { timezone: 'Asia/Shanghai', intervalHours: 2, workStart: '09:00', workEnd: '19:00', enabled: false }, reminderLog: [],
  } };
}

async function capture(page, name) {
  await page.locator('.calendar-page-header h1').click();
  await page.screenshot({ path: path.join(out, `${name}.png`), fullPage: true });
  screenshots.push(`${name}.png`);
}

async function setup(width, options = {}) {
  const context = await browser.newContext({ viewport: { width, height: width < 500 ? 844 : 1000 }, locale: 'zh-CN', timezoneId: 'America/Los_Angeles', serviceWorkers: 'block' });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => pageErrors.push({ width, message: error.message }));
  const control = { failure: !!options.failure, revision: 41, calendar: structuredClone(options.empty ? { ...calendarFixture, projects: [], tasks: [], history_complete: true, warnings: [] } : calendarFixture), gate: options.gate || null };
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== base) { externalRequests.push({ origin: url.origin, method: request.method() }); return route.abort('blockedbyclient'); }
    if (!['GET', 'HEAD'].includes(request.method())) { blockedWrites.push({ method: request.method(), path: url.pathname }); return route.abort('blockedbyclient'); }
    if (url.pathname === '/api/state') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(stateFor(control.calendar, control.revision)) });
    if (url.pathname === '/api/calendar') {
      if (control.gate) await control.gate;
      if (control.failure) return route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"QA_CALENDAR_UNAVAILABLE","message":"虚构网络失败，请重试。"}' });
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...control.calendar, revision: control.revision }) });
    }
    if (url.pathname === '/api/operations') return route.fulfill({ status: 200, contentType: 'application/json', body: '{"operations":[]}' });
    if (url.pathname.startsWith('/api/')) return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"CALENDAR_FIXTURE_ONLY"}' });
    return route.continue();
  });
  return { context, page, control };
}

const calendarURL = `${base}/?view=calendar&cal_mode=registered&cal_month=2026-10&cal_date=2026-10-16&cal_project=all&preserve=fixture`;
const browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true, args: ['--disable-gpu'] });
try {
  for (const width of [1440, 390, 320]) {
    const { context, page } = await setup(width);
    try {
      await page.goto(calendarURL, { waitUntil: 'networkidle' });
      await page.locator('.calendar-month-table').waitFor();
      const details = page.locator('.calendar-day-details');
      await details.getByRole('button', { name: '查看日历任务：虚构上海跨日登记', exact: true }).waitFor();
      assert.equal(await details.getByRole('button', { name: '查看日历任务：虚构口述完成节点', exact: true }).count(), 0, 'Completion records must not become first registration dates');
      await page.locator('button[data-calendar-date="2026-10-16"]').waitFor();
      assert.ok((await page.locator('button[data-calendar-date="2026-10-16"]').getAttribute('aria-label')).includes('首次登记1项'));
      await page.getByRole('region', { name: '登记日未知的任务' }).getByRole('button', { name: '查看日历任务：虚构登记日未知', exact: true }).waitFor();
      await page.locator('button[data-calendar-date="2026-10-16"]').focus();
      await page.keyboard.press('ArrowRight');
      await page.waitForFunction(() => new URL(location.href).searchParams.get('cal_date') === '2026-10-17');
      assert.equal(await page.locator('#calendar-selected-day time').getAttribute('datetime'), '2026-10-17');
      await page.keyboard.press('Home');
      await page.waitForFunction(() => new URL(location.href).searchParams.get('cal_date') === '2026-10-12');
      await page.getByRole('button', { name: '下个月', exact: true }).click();
      assert.equal(new URL(page.url()).searchParams.get('cal_month'), '2026-11');
      await page.getByRole('button', { name: '上个月', exact: true }).click();
      assert.equal(new URL(page.url()).searchParams.get('cal_month'), '2026-10');
      await page.locator('button[data-calendar-date="2026-10-16"]').click();
      await capture(page, `registered-${width}`);

      await page.getByLabel('筛选日历项目', { exact: true }).selectOption('cal-a');
      await page.getByRole('button', { name: '项目周期', exact: true }).click();
      const cycle = page.getByRole('article', { name: '项目周期：虚构建模项目', exact: true });
      await cycle.waitFor();
      assert.equal(await page.getByRole('article', { name: '项目周期：虚构交付项目', exact: true }).count(), 0);
      assert.equal(await cycle.getByRole('button', { name: /^查看日历任务：/ }).count(), 4, 'Every task, including non-milestones and undated tasks, must be a node');
      assert.equal(await cycle.locator('.calendar-observed-start time').getAttribute('datetime'), '2026-10-01');
      assert.ok((await cycle.locator('.calendar-observed-start').innerText()).includes('不是实际进场'));
      const report = cycle.getByRole('button', { name: '查看日历任务：虚构口述完成节点', exact: true });
      assert.ok((await report.innerText()).includes('口述完成记录'));
      assert.equal(await report.locator('.calendar-node-date time').getAttribute('datetime'), '2026-10-16');
      assert.equal(await report.locator('.calendar-node-registration time').getAttribute('datetime'), '2026-10-10');
      const registration = cycle.getByRole('button', { name: '查看日历任务：虚构上海跨日登记', exact: true });
      assert.ok((await registration.innerText()).includes('首次登记 · 进展日期待补'));
      await cycle.locator('.calendar-undated-nodes').getByRole('button', { name: '查看日历任务：虚构登记日未知', exact: true }).waitFor();
      const planned = cycle.getByRole('button', { name: '查看日历任务：虚构长期计划节点', exact: true });
      assert.equal(await planned.locator('.calendar-node-date time').getAttribute('datetime'), '2001-06-15');
      assert.equal(await planned.locator('.calendar-node-registration time').getAttribute('datetime'), '2026-10-13');
      if (width === 1440) assert.ok((await cycle.locator('.calendar-cycle-axis').innerText()).includes('2001/'), 'Cross-year axis labels need a year');
      assert.equal(new URL(page.url()).searchParams.get('cal_project'), 'cal-a');
      assert.equal(new URL(page.url()).searchParams.get('preserve'), 'fixture');
      await registration.click();
      const taskDialog = page.getByRole('dialog', { name: '虚构上海跨日登记', exact: true });
      await taskDialog.waitFor();
      assert.ok((await taskDialog.locator('.detail-next p').innerText()).includes('完整的虚构下一步'));
      await taskDialog.getByRole('button', { name: '关闭', exact: true }).click();
      await cycle.getByRole('button', { name: '补充项目周期：虚构建模项目', exact: true }).click();
      const editor = page.getByRole('dialog', { name: '编辑项目', exact: true });
      await editor.waitFor();
      await editor.getByRole('button', { name: '关闭', exact: true }).click();
      await capture(page, `cycles-${width}`);
      const savedURL = page.url();
      await page.reload({ waitUntil: 'networkidle' });
      await page.getByRole('article', { name: '项目周期：虚构建模项目', exact: true }).waitFor();
      assert.equal(await page.getByLabel('筛选日历项目', { exact: true }).inputValue(), 'cal-a');
      assert.equal(new URL(page.url()).searchParams.get('cal_mode'), 'projects');
      assert.equal(new URL(savedURL).searchParams.get('cal_date'), new URL(page.url()).searchParams.get('cal_date'));
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${width}: horizontal overflow`);
      await page.getByRole('button', { name: '每日登记', exact: true }).click();
      const targetSizes = await page.locator('.calendar-day, .calendar-mode button, .calendar-icon-button, .calendar-today, .calendar-refresh').evaluateAll(elements => elements.filter(e => e.tagName === 'BUTTON').map(e => { const rect = e.getBoundingClientRect(); return { width: rect.width, height: rect.height, label: e.getAttribute('aria-label') || e.textContent }; }));
      assert.ok(targetSizes.every(size => size.width >= 43.5 && size.height >= 44), JSON.stringify({ width, undersized: targetSizes.filter(size => size.width < 43.5 || size.height < 44) }));
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${width}: daily calendar overflow`);
      checks.push({ width, shanghaiFirstRegistration: true, completionAndEditDoNotMoveRegistration: true, unknownDatesRemainExplicit: true, dateKeyboardAndMonths: true, projectFilterPersistsBetweenModes: true, everyTaskAutomaticallyHasNode: true, registeredNodeFallbackIsLabeled: true, firstRegistrationShownOnEveryDatedNode: true, projectObservationNotActualStart: true, taskAndProjectEditorCallbacks: true, urlRestoredAfterReload: true, otherQueryPreserved: true, noHorizontalOverflow: true, touchTargets44: true });
    } finally { await context.close(); }
  }

  const invalid = await setup(390);
  try {
    await invalid.page.goto(`${base}/?view=calendar&cal_mode=unexpected&cal_month=2026-99&cal_date=2026-02-30&cal_project=missing&preserve=fixture`, { waitUntil: 'networkidle' });
    await invalid.page.locator('.calendar-month-table').waitFor();
    const normalized = new URL(invalid.page.url());
    assert.equal(normalized.searchParams.get('cal_mode'), 'registered');
    assert.equal(normalized.searchParams.get('cal_project'), 'all');
    assert.notEqual(normalized.searchParams.get('cal_date'), '2026-02-30');
    assert.notEqual(normalized.searchParams.get('cal_month'), '2026-99');
    assert.equal(normalized.searchParams.get('preserve'), 'fixture');
    await invalid.page.evaluate(() => { const url = new URL(location.href); url.searchParams.set('cal_date', '2026-10-10'); url.searchParams.set('cal_month', '2026-10'); history.pushState(null, '', url); dispatchEvent(new PopStateEvent('popstate')); });
    await invalid.page.waitForFunction(() => document.querySelector('#calendar-selected-day time')?.getAttribute('datetime') === '2026-10-10');
    checks.push({ invalidURLSanitized: true, popstateRestoresDate: true });
  } finally { await invalid.context.close(); }

  let releaseLoading;
  const gate = new Promise(resolve => { releaseLoading = resolve; });
  const loading = await setup(390, { gate });
  try {
    await loading.page.goto(calendarURL, { waitUntil: 'domcontentloaded' });
    await loading.page.getByRole('heading', { name: '正在读取项目日历', exact: true }).waitFor();
    await capture(loading.page, 'loading-390');
    releaseLoading();
    await loading.page.locator('.calendar-month-table').waitFor();
    loading.control.failure = true;
    loading.control.revision = 42;
    await loading.page.getByRole('button', { name: '刷新日历', exact: true }).click();
    await loading.page.getByText('日历尚未刷新成功', { exact: true }).waitFor();
    await loading.page.getByText('正在显示上次读回的日历', { exact: true }).waitFor();
    await loading.page.locator('.calendar-month-table').waitFor();
    await capture(loading.page, 'stale-error-390');
    loading.control.failure = false;
    await loading.page.getByRole('button', { name: '重试读取日历', exact: true }).click();
    await loading.page.waitForFunction(() => !document.querySelector('.calendar-message-error') && !document.querySelector('.calendar-message-warning'));
    checks.push({ initialLoadingVisible: true, staleDataRetainedOnFailure: true, retryRecovers: true });
  } finally { releaseLoading(); await loading.context.close(); }

  const empty = await setup(320, { empty: true });
  try {
    await empty.page.goto(calendarURL, { waitUntil: 'networkidle' });
    await empty.page.getByRole('heading', { name: '这一天没有首次登记的任务', exact: true }).waitFor();
    await empty.page.getByRole('button', { name: '项目周期', exact: true }).click();
    await empty.page.getByRole('heading', { name: '还没有可展示的项目周期', exact: true }).waitFor();
    await capture(empty.page, 'empty-320');
    checks.push({ emptyDailyAndProjectStates: true });
  } finally { await empty.context.close(); }

  assert.deepEqual(pageErrors, []);
  assert.deepEqual(blockedWrites, []);
  assert.deepEqual(externalRequests, []);
  const report = { recorded_at: new Date().toISOString(), passed: true, source: 'Actual local frontend with fictional calendar/state fixtures; all writes and non-local requests blocked', checks, screenshots, pageErrors, blockedWrites, externalRequests, productionRequests: 0, ledgerWritesSent: 0 };
  fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: true, scenarios: checks.length, checks: checks.reduce((sum, item) => sum + Object.values(item).filter(value => value === true).length, 0), screenshots: screenshots.length, ledgerWritesSent: 0, productionRequests: 0, output: out }));
} catch (error) {
  fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ recorded_at: new Date().toISOString(), passed: false, error: error.stack || error.message, checks, screenshots, pageErrors, blockedWrites, externalRequests }, null, 2));
  throw error;
} finally { await browser.close(); }
