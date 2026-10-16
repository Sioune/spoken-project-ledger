import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from '../.sites-runtime/browser-qa/node_modules/playwright-core/index.mjs';
import { base, verifyLocalLedger } from './local-base.mjs';

// Real UI writes belong only to the explicitly selected isolated loopback ledger.
// Historical unknown-date coverage lives in fixtures; this proof never invents
// production history, restores a snapshot, or initializes a database.
assert.ok(process.env.LEDGER_QA_BASE, 'Set LEDGER_QA_BASE to the isolated local ledger before running this proof');
await verifyLocalLedger();
const out = path.resolve('.sites-runtime/calendar-flow-proof');
fs.mkdirSync(out, { recursive: true });
const checks = [], writes = [], probes = [], screenshots = [], pageErrors = [], blockedRequests = [];
const anonymousCalendar = await fetch(`${base}/api/calendar`, { redirect: 'manual' });
assert.equal(anonymousCalendar.status, 401, 'Calendar projection must require the same owner authentication as the ledger');
probes.push({ label: 'anonymous-calendar-rejected', status: anonymousCalendar.status });

function shanghaiDate(instant) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(instant));
  return `${parts.find(p => p.type === 'year').value}-${parts.find(p => p.type === 'month').value}-${parts.find(p => p.type === 'day').value}`;
}

async function getJSON(context, route) {
  const response = await context.request.get(`${base}${route}`, { maxRedirects: 0 });
  const body = await response.json();
  assert.equal(response.status(), 200, JSON.stringify(body));
  return body;
}

async function readState(context) {
  const state = await getJSON(context, '/api/state');
  assert.equal(state.initialized, true, 'Use an already initialized isolated ledger');
  return state;
}

async function readCalendar(context) {
  const before = await readState(context), calendar = await getJSON(context, '/api/calendar'), after = await readState(context);
  assert.equal(calendar.timezone, 'Asia/Shanghai');
  assert.equal(calendar.revision, before.revision);
  assert.equal(after.revision, before.revision, 'Calendar projection must remain read-only');
  assert.deepEqual(after.data, before.data, 'Calendar reads must not backfill task or project fields');
  return calendar;
}

async function verifyReceipt(context, operationId, expectedRevision) {
  const receipt = await getJSON(context, `/api/operations/${encodeURIComponent(operationId)}`);
  assert.equal(receipt.state, 'verified');
  if (expectedRevision !== undefined) assert.equal(receipt.result_version, expectedRevision);
  return receipt;
}

function preserveExisting(original, latest) {
  for (const key of ['projects', 'tasks', 'documents', 'pending']) {
    for (const existing of original[key]) assert.deepEqual(latest[key].find(item => item.id === existing.id), existing, `Existing ${key} record ${existing.id} changed`);
  }
  assert.deepEqual(latest.settings, original.settings);
  assert.deepEqual(latest.reminderLog, original.reminderLog);
}

function recordFor(calendar, kind, id) {
  const result = calendar[kind].filter(item => item.id === id);
  assert.equal(result.length, 1, `Exactly one ${kind} calendar record should exist for ${id}`);
  return result[0];
}

async function capture(page, label) {
  const filename = `${label}.png`;
  await page.screenshot({ path: path.join(out, filename), fullPage: true });
  screenshots.push(filename);
}

const browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true, args: ['--disable-gpu'] });
try {
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: width < 500 ? 844 : 1000 }, locale: 'zh-CN', serviceWorkers: 'block' });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    page.on('pageerror', error => pageErrors.push({ width, message: error.message }));
    const run = crypto.randomUUID(), prefix = `虚构日历验收 ${width} ${run}`;
    const projectName = `${prefix} 项目`, taskTitle = `${prefix} 任务`;
    let fixtureProjectId, fixtureTaskId, expectedWrite = null;

    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== base) {
        blockedRequests.push({ width, reason: 'external-origin', origin: url.origin, method: request.method() });
        return route.abort('blockedbyclient');
      }
      if (!['GET', 'HEAD'].includes(request.method())) {
        if (url.pathname !== '/api/operations' || request.method() !== 'POST' || !expectedWrite) {
          blockedRequests.push({ width, reason: 'unexpected-ui-write', path: url.pathname, method: request.method() });
          return route.abort('blockedbyclient');
        }
        const payload = request.postDataJSON();
        const scoped = payload.changes.every(change => {
          if (Object.hasOwn(change.values, 'created_at')) return false;
          if (change.type === 'create') return change.values.title === taskTitle && change.values.project_id === fixtureProjectId;
          if (change.type === 'project') return change.id ? change.id === fixtureProjectId : change.values.name === projectName;
          return change.type === 'update' && change.id === fixtureTaskId && !Object.hasOwn(change.values, 'dependencies');
        });
        if (!scoped || !expectedWrite(payload)) {
          blockedRequests.push({ width, reason: 'ui-write-outside-fixture-or-stage', payload });
          return route.abort('blockedbyclient');
        }
        writes.push({ width, payload });
      }
      return route.continue();
    });

    async function navigate(name) {
      const nav = page.getByRole('navigation', { name: width < 500 ? '手机导航' : '主导航' });
      await nav.getByRole('button', { name, exact: true }).click();
    }

    async function saveFromUI(label, click, allow) {
      expectedWrite = allow;
      try {
        const responsePromise = page.waitForResponse(response => response.url() === `${base}/api/operations` && response.request().method() === 'POST');
        await click();
        const response = await responsePromise, saved = await response.json(), payload = response.request().postDataJSON();
        assert.equal(response.status(), 200, JSON.stringify(saved));
        assert.equal(saved.state, 'verified');
        await page.getByRole('dialog').waitFor({ state: 'detached' });
        const receipt = await verifyReceipt(context, saved.operation_id, saved.result_version), state = await readState(context);
        assert.equal(state.revision, saved.result_version);
        assert.equal(receipt.verification, 'current_fields_match');
        checks.push({ width, label, operation_id: saved.operation_id, revision: state.revision });
        return { saved, state, payload };
      } finally {
        expectedWrite = null;
      }
    }

    async function openTaskFromCalendar() {
      await page.getByRole('button', { name: `查看日历任务：${taskTitle}`, exact: true }).click();
      const detail = page.getByRole('dialog', { name: taskTitle, exact: true });
      await detail.waitFor();
      assert.ok((await detail.innerText()).includes(fixtureTaskId), 'Calendar task must open its real task detail');
      return detail;
    }

    try {
      await page.goto(`${base}/signin-with-chatgpt?return_to=/`);
      await page.getByRole('heading', { name: '今天，推进一件件。', exact: true }).waitFor();
      const initial = await readState(context);
      await navigate('项目');
      await page.getByRole('button', { name: '新建项目', exact: true }).click();
      await page.getByLabel('项目名称', { exact: true }).fill(projectName);
      await page.getByLabel('目标与完成条件', { exact: true }).fill('虚构本机验收：每日登记保持原日，每项任务自动成为项目周期节点。');
      const createdProject = await saveFromUI('ui-create-project', () => page.getByRole('button', { name: '确认保存项目', exact: true }).click(), payload => payload.changes.length === 1 && payload.changes[0].type === 'project');
      const project = createdProject.state.data.projects.find(item => item.name === projectName);
      assert.ok(project);
      fixtureProjectId = project.id;
      assert.equal(project.created_at, createdProject.saved.created_at, 'New project registration must use its server receipt time');

      await page.locator('.project-card').filter({ has: page.getByRole('heading', { name: projectName, exact: true }) }).click();
      await page.getByRole('button', { name: '添加任务', exact: true }).click();
      await page.getByLabel('任务名称', { exact: true }).fill(taskTitle);
      await page.getByLabel('下一步', { exact: true }).fill('第一版虚构下一步；这不是登记日期。');
      // A different schedule day in the current month catches accidental use of
      // planned_date as registration time without fabricating a server receipt.
      const projectRegistrationDay = shanghaiDate(project.created_at);
      const scheduledDay = `${projectRegistrationDay.slice(0, 7)}-${projectRegistrationDay.endsWith('-01') ? '02' : '01'}`;
      await page.getByLabel('计划日期 · 可留空', { exact: true }).fill(scheduledDay);
      const createdTask = await saveFromUI('ui-create-task', () => page.getByRole('button', { name: '确认保存', exact: true }).click(), payload => payload.changes.length === 1 && payload.changes[0].type === 'create');
      const task = createdTask.state.data.tasks.find(item => item.title === taskTitle);
      assert.ok(task);
      fixtureTaskId = task.id;
      assert.equal(task.created_at, createdTask.saved.created_at, 'New task registration must use its server receipt time');
      const registeredDay = shanghaiDate(task.created_at);
      assert.notEqual(registeredDay, task.planned_date);
      const firstCalendar = await readCalendar(context), firstRegistration = recordFor(firstCalendar, 'tasks', task.id);
      assert.equal(firstRegistration.registered_at, task.created_at);
      assert.equal(firstRegistration.registration_source, 'recorded');
      assert.equal(recordFor(firstCalendar, 'projects', project.id).registered_at, project.created_at);

      await navigate('日历');
      const calendarUrl = new URL(page.url());
      calendarUrl.searchParams.set('cal_mode', 'registered');
      calendarUrl.searchParams.set('cal_month', registeredDay.slice(0, 7));
      calendarUrl.searchParams.set('cal_date', registeredDay);
      calendarUrl.searchParams.set('cal_project', project.id);
      await page.goto(calendarUrl.href);
      await page.getByRole('button', { name: '每日登记', exact: true }).waitFor();
      assert.equal(await page.getByRole('button', { name: '每日登记', exact: true }).getAttribute('aria-pressed'), 'true');
      await page.getByLabel('筛选日历项目', { exact: true }).selectOption(project.id);
      await page.getByRole('button', { name: `查看日历任务：${taskTitle}`, exact: true }).waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await capture(page, `registered-${width}`);

      const detail = await openTaskFromCalendar();
      await detail.getByRole('button', { name: '编辑任务', exact: true }).click();
      await page.getByLabel('下一步', { exact: true }).fill('第二版虚构下一步；编辑不改变登记时间。');
      const editedTask = await saveFromUI('ui-edit-next-action', () => page.getByRole('button', { name: '确认保存', exact: true }).click(), payload => payload.changes.length === 1 && payload.changes[0].type === 'update' && payload.changes[0].values.next_action === '第二版虚构下一步；编辑不改变登记时间。');
      assert.equal(editedTask.state.data.tasks.find(item => item.id === task.id).created_at, task.created_at);
      const editedRegistration = recordFor(await readCalendar(context), 'tasks', task.id);
      assert.equal(editedRegistration.registered_at, firstRegistration.registered_at);
      assert.equal(editedRegistration.registration_source, 'recorded');

      await page.getByRole('button', { name: '项目周期', exact: true }).click();
      assert.equal(await page.getByRole('button', { name: '项目周期', exact: true }).getAttribute('aria-pressed'), 'true');
      const automaticCycle = page.getByRole('article', { name: `项目周期：${projectName}`, exact: true });
      await automaticCycle.getByRole('button', { name: `查看日历任务：${taskTitle}`, exact: true }).waitFor();
      checks.push({ width, label: 'every-task-automatically-appears-in-project-cycle', task_id: task.id });
      await page.getByRole('button', { name: `补充项目周期：${projectName}`, exact: true }).click();
      const startDate = `${registeredDay.slice(0, 7)}-01`;
      const [year, month] = registeredDay.slice(0, 7).split('-').map(Number);
      const endDate = `${registeredDay.slice(0, 7)}-${String(new Date(Date.UTC(year, month, 0)).getUTCDate()).padStart(2, '0')}`;
      await page.getByLabel('实际进场日期', { exact: true }).fill(startDate);
      await page.getByLabel('计划完成日期', { exact: true }).fill(endDate);
      await page.getByLabel('实际完成日期', { exact: true }).fill(registeredDay);
      const datedProject = await saveFromUI('ui-save-project-dates', () => page.getByRole('button', { name: '确认保存项目', exact: true }).click(), payload => payload.changes.length === 1 && payload.changes[0].type === 'project' && payload.changes[0].id === project.id);
      const persistedProject = datedProject.state.data.projects.find(item => item.id === project.id);
      assert.equal(persistedProject.start_date, startDate);
      assert.equal(persistedProject.target_end_date, endDate);
      assert.equal(persistedProject.completed_date, registeredDay);
      assert.equal(persistedProject.status, 'active', 'A supplied actual completion date must not auto-archive a project');
      assert.equal(persistedProject.created_at, project.created_at);

      // Saved project metadata and the selected calendar mode/filter survive a
      // full navigation reload; no fixture API is used by this proof.
      await page.reload();
      await page.getByRole('button', { name: '项目周期', exact: true }).waitFor();
      // Controls render before authenticated calendar data finishes loading.
      // Wait for the requested saved selection rather than inspecting the
      // temporary disabled all-projects default during that initial read.
      await page.waitForFunction(id => {
        const select = document.querySelector('select[aria-label="筛选日历项目"]');
        return select && !select.disabled && select.value === id;
      }, project.id);
      assert.equal(await page.getByRole('button', { name: '项目周期', exact: true }).getAttribute('aria-pressed'), 'true');
      assert.equal(await page.getByLabel('筛选日历项目', { exact: true }).inputValue(), project.id);
      const cycle = page.getByRole('article', { name: `项目周期：${projectName}`, exact: true });
      await cycle.waitFor();
      for (const label of ['实际进场', '计划结束', '实际完成']) assert.ok((await cycle.innerText()).includes(label));
      await cycle.getByRole('button', { name: `查看日历任务：${taskTitle}`, exact: true }).waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await capture(page, `project-cycle-${width}`);
      const persistedCalendar = await readCalendar(context), persistedTask = recordFor(persistedCalendar, 'tasks', task.id), calendarProject = recordFor(persistedCalendar, 'projects', project.id);
      assert.equal(persistedTask.registered_at, task.created_at);
      assert.equal(calendarProject.start_date, startDate);
      assert.equal(calendarProject.target_end_date, endDate);
      assert.equal(calendarProject.completed_date, registeredDay);

      const latest = await readState(context);
      const staleId = crypto.randomUUID();
      const staleResponse = await context.request.post(`${base}/api/operations`, { maxRedirects: 0, data: {
        operation_id: staleId, idempotency_key: staleId, source_event_id: staleId, base_version: latest.revision - 1,
        occurred_at: new Date().toISOString(), raw_text: '虚构本机日历过期版本拒绝探针',
        changes: [{ type: 'update', id: task.id, values: { next_action: '过期修改绝不能保存' } }],
      } });
      const stale = await staleResponse.json();
      assert.equal(staleResponse.status(), 409, JSON.stringify(stale));
      assert.equal(stale.error, 'REVISION_CONFLICT');
      assert.deepEqual(await readState(context), latest, 'Stale CAS must not change the current ledger');
      probes.push({ width, label: 'stale-cas-no-write', status: staleResponse.status(), error: stale.error });

      const immutableId = crypto.randomUUID();
      const immutableResponse = await context.request.post(`${base}/api/operations`, { maxRedirects: 0, data: {
        operation_id: immutableId, idempotency_key: immutableId, source_event_id: immutableId, base_version: latest.revision,
        occurred_at: new Date().toISOString(), raw_text: '虚构本机日历登记时间不可写探针',
        changes: [{ type: 'update', id: task.id, values: { created_at: '2001-01-02T00:00:00Z' } }],
      } });
      const immutable = await immutableResponse.json();
      assert.equal(immutableResponse.status(), 400, JSON.stringify(immutable));
      assert.equal(immutable.error, 'FIELD');
      assert.deepEqual(await readState(context), latest, 'Rejected created_at must leave state intact');
      probes.push({ width, label: 'created-at-immutable', status: immutableResponse.status(), error: immutable.error });

      const replayResponse = await context.request.post(`${base}/api/operations`, { maxRedirects: 0, data: createdTask.payload });
      const replay = await replayResponse.json();
      assert.equal(replayResponse.status(), 200, JSON.stringify(replay));
      assert.equal(replay.duplicate, true);
      assert.equal(replay.operation_id, createdTask.saved.operation_id);
      assert.equal(replay.result_version, createdTask.saved.result_version);
      const afterReplay = await readState(context);
      assert.deepEqual(afterReplay, latest, 'Replaying the original create must not increase revision or alter current metadata');
      assert.equal(afterReplay.data.tasks.filter(item => item.id === task.id).length, 1);
      preserveExisting(initial.data, afterReplay.data);
      assert.equal(recordFor(await readCalendar(context), 'tasks', task.id).registered_at, task.created_at);
      probes.push({ width, label: 'original-ui-create-replay-stable', operation_id: replay.operation_id, duplicate: replay.duplicate });
      checks.push({ width, label: 'registration-and-cycle-metadata-persist-after-reload', project_id: project.id, task_id: task.id, registered_day: registeredDay });
    } finally {
      await context.close();
    }
  }
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(blockedRequests, []);
  const report = { recorded_at: new Date().toISOString(), base, source: 'Real isolated local ledger, real UI saves and authenticated independent state/calendar/receipt reads', checks, probes, uiWrites: writes.length, writes, screenshots, pageErrors, blockedRequests, productionRequests: 0 };
  fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ checks: checks.length, probes: probes.length, uiWrites: writes.length, screenshots: screenshots.length, pageErrors: pageErrors.length, productionRequests: 0, output: out }));
} catch (error) {
  fs.writeFileSync(path.join(out, 'failure.json'), JSON.stringify({ recorded_at: new Date().toISOString(), error: error.stack || String(error), checks, probes, writes, screenshots, pageErrors, blockedRequests }, null, 2));
  throw error;
} finally {
  await browser.close();
}
