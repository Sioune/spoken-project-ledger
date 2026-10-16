import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from '../.sites-runtime/browser-qa/node_modules/playwright-core/index.mjs';
import { base, verifyLocalLedger } from './local-base.mjs';

// This is a real-write regression for an isolated local ledger. Explicitly
// selecting and checking the service happens before login or any fixture write.
assert.ok(process.env.LEDGER_QA_BASE, 'Set LEDGER_QA_BASE to the isolated local ledger before running this proof');
await verifyLocalLedger();
const out = path.resolve('.sites-runtime/dependency-flow-proof');
fs.mkdirSync(out, { recursive: true });
const results = [], requests = [], pageErrors = [], rejectedRequests = [], screenshots = [];
let stage = 'navigation';

async function readState(context) {
  const response = await context.request.get(`${base}/api/state`);
  assert.equal(response.status(), 200);
  const state = await response.json();
  assert.equal(state.initialized, true, 'The local preview must have its isolated database initialized');
  return state;
}

async function verifyReceipt(context, operationId) {
  const response = await context.request.get(`${base}/api/operations/${operationId}`);
  assert.equal(response.status(), 200);
  const receipt = await response.json();
  assert.equal(receipt.state, 'verified');
  assert.equal(receipt.verification, 'current_fields_match');
  return receipt;
}

function checkTask(state, id, status, dependencies) {
  const task = state.data.tasks.find(item => item.id === id);
  assert.ok(task, `Missing fixture task ${id}`);
  assert.equal(task.status, status);
  if (dependencies) assert.deepEqual(task.dependencies, dependencies);
  return task;
}

async function createFixture(context, width) {
  const state = await readState(context), run = crypto.randomUUID();
  const projectId = `qa-dependency-${run}`;
  const prefix = `虚构依赖验收 ${width} ${run.slice(0, 8)}`;
  const tasks = {
    a: { id: `${run}-a`, title: `${prefix} 前序资料审核A`, next_action: `完整前序说明A：先检查虚构材料范围与每一项内容，再由当前任务自己的完成入口记录审核结果。验收编号 ${run}。` },
    b: { id: `${run}-b`, title: `${prefix} 前序内容核对B`, next_action: `完整前序说明B：核对虚构提交清单，确认全部项目后在本任务中记录完成。验收编号 ${run}。` },
    c: { id: `${run}-c`, title: `${prefix} 后续实际提交C`, next_action: '必须等待A和B均完成，再单独处理本任务；解锁不等于提交完成。' },
    d: { id: `${run}-d`, title: `${prefix} 后续等待评审D`, next_action: 'A完成后仅进入等待，不代表收到评审结论。' },
  };
  const change = (key, extra = {}) => ({ type: 'create', id: tasks[key].id, values: { project_id: projectId, title: tasks[key].title, next_action: tasks[key].next_action, verification_state: 'user_reported', source_ref: '仅用于本机隔离依赖流程验收，非生产任务', ...extra } });
  const operation = crypto.randomUUID();
  const response = await context.request.post(`${base}/api/operations`, { data: {
    operation_id: operation, idempotency_key: operation, source_event_id: operation,
    base_version: state.revision, occurred_at: new Date().toISOString(), raw_text: `新建虚构本地依赖流程验收 ${width} ${run}`,
    changes: [
      { type: 'project', id: projectId, values: { name: `${prefix} 独立项目`, goal: '核对从依赖进入前序自己的流程以及后续自动解锁', status: 'active' } },
      change('a'), change('b'),
      change('c', { status: 'blocked', dependencies: [tasks.a.id, tasks.b.id] }),
      change('d', { status: 'blocked', dependencies: [tasks.a.id], waiting_for: '虚构评审方', expected_result: '虚构评审结论' }),
    ],
  } });
  const saved = await response.json();
  assert.equal(response.status(), 200, JSON.stringify(saved));
  assert.equal(saved.state, 'verified');
  await verifyReceipt(context, operation);
  const back = await readState(context);
  checkTask(back, tasks.c.id, 'blocked', [tasks.a.id, tasks.b.id]);
  checkTask(back, tasks.d.id, 'blocked', [tasks.a.id]);
  // APIRequestContext writes are deliberate isolated setup/probes; they do not
  // enter the page's UI-write count below. A rejected atomic group must leave
  // neither a changed dependency nor its unrelated new task behind.
  const atomicBypassOperation = crypto.randomUUID();
  const bypass = await context.request.post(`${base}/api/operations`, { data: {
    operation_id: atomicBypassOperation, idempotency_key: atomicBypassOperation, source_event_id: atomicBypassOperation,
    base_version: back.revision, occurred_at: new Date().toISOString(), raw_text: `虚构依赖绕过及原子回滚拒绝探针 ${width} ${run}`,
    changes: [
      { type: 'update', id: tasks.c.id, values: { dependencies: [], status: 'done' } },
      { type: 'create', id: `${run}-must-not-exist`, values: { project_id: projectId, title: `${prefix} 不得部分保存的额外任务`, next_action: '此任务必须随整组失败而不落库。' } },
    ],
  } });
  const rejected = await bypass.json();
  assert.equal(bypass.status(), 409, JSON.stringify(rejected));
  assert.equal(rejected.error, 'BLOCKED');
  const unchanged = await readState(context);
  assert.equal(unchanged.revision, back.revision);
  assert.deepEqual(unchanged.data, back.data);
  return { projectId, tasks, setupOperation: operation, atomicBypassOperation };
}

async function capture(page, label) {
  const filename = `${label}.png`;
  await page.screenshot({ path: path.join(out, filename), fullPage: true });
  screenshots.push(filename);
}

async function saveFromUI(page, label, click) {
  stage = label;
  const responsePromise = page.waitForResponse(response => response.url() === `${base}/api/operations` && response.request().method() === 'POST');
  await click();
  const response = await responsePromise, saved = await response.json();
  assert.equal(response.status(), 200, JSON.stringify(saved));
  assert.equal(saved.state, 'verified');
  // The client also finishes its independent receipt/state reads before the
  // next action; an older visible success receipt cannot satisfy this check.
  await page.locator('.receipt-panel .mono').filter({ hasText: saved.operation_id }).waitFor({ state: 'attached' });
  await verifyReceipt(page.context(), saved.operation_id);
  const state = await readState(page.context());
  assert.equal(state.revision, saved.result_version);
  stage = 'navigation';
  return { state, saved };
}

const browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true, args: ['--disable-gpu'] });
try {
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: width < 500 ? 844 : 1000 }, locale: 'zh-CN', serviceWorkers: 'block' });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    page.on('pageerror', error => pageErrors.push({ width, message: error.message }));
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== base) {
        rejectedRequests.push({ width, reason: 'external-origin', url: url.origin, method: request.method() });
        return route.abort('blockedbyclient');
      }
      if (!['GET', 'HEAD'].includes(request.method())) {
        if (url.pathname !== '/api/operations' || request.method() !== 'POST') {
          rejectedRequests.push({ width, reason: 'unexpected-write-route', path: url.pathname, method: request.method() });
          return route.abort('blockedbyclient');
        }
        const payload = request.postDataJSON();
        requests.push({ width, stage, payload });
        if (payload.changes.some(change => change.type === 'update' && Object.hasOwn(change.values, 'dependencies'))) {
          rejectedRequests.push({ width, reason: 'existing-task-dependencies-rewritten', stage, payload });
          return route.fulfill({ status: 409, contentType: 'application/json', body: '{"error":"DEPENDENCY_QA_BYPASS","message":"Existing editor must not rewrite prerequisite relations"}' });
        }
      }
      return route.continue();
    });
    try {
      await page.goto(`${base}/signin-with-chatgpt?return_to=/`);
      await page.getByRole('heading', { name: '今天，推进一件件。' }).waitFor();
      const { projectId, tasks: { a, b, c, d }, setupOperation, atomicBypassOperation } = await createFixture(context, width);
      await page.reload();
      await page.getByRole('heading', { name: '今天，推进一件件。' }).waitFor();
      await page.getByRole('textbox', { name: '搜索当前任务' }).fill(c.title);
      const card = page.locator('.task-card').filter({ has: page.getByRole('button', { name: c.title, exact: true }) });
      assert.equal(await card.getByRole('button', { name: `标记${c.title}完成`, exact: true }).isDisabled(), true);
      await card.getByRole('button', { name: c.title, exact: true }).click();
      let dialog = page.getByRole('dialog', { name: c.title, exact: true });
      await dialog.waitFor();
      assert.equal(await dialog.getByRole('button', { name: '完成当前任务', exact: true }).isDisabled(), true);
      await capture(page, `blocked-detail-${width}`);

      await dialog.getByRole('button', { name: '编辑任务', exact: true }).click();
      dialog = page.getByRole('dialog', { name: '更新任务', exact: true });
      await dialog.waitFor();
      assert.equal(await dialog.getByLabel('所属项目').isDisabled(), true);
      const status = dialog.getByLabel('业务状态');
      for (const value of ['doing', 'waiting', 'done']) { const option = status.locator(`option[value="${value}"]`); assert.equal(await option.evaluate(element => element.disabled), true); assert.equal(await option.evaluate(element => element.hasAttribute('disabled')), true); }
      assert.equal(await dialog.getByRole('checkbox').count(), 0);
      await dialog.getByRole('button', { name: `查看前序任务：${a.title}`, exact: true }).waitFor();
      await dialog.getByRole('button', { name: `查看前序任务：${b.title}`, exact: true }).waitFor();
      await capture(page, `readonly-editor-${width}`);
      await dialog.getByRole('button', { name: `查看前序任务：${a.title}`, exact: true }).click();
      dialog = page.getByRole('dialog', { name: a.title, exact: true });
      await dialog.waitFor();
      assert.equal(await dialog.locator('.detail-next p').innerText(), a.next_action);
      await dialog.getByRole('button', { name: `返回后续任务：${c.title}`, exact: true }).click();
      dialog = page.getByRole('dialog', { name: c.title, exact: true });
      await dialog.getByRole('button', { name: '编辑任务', exact: true }).click();
      dialog = page.getByRole('dialog', { name: '更新任务', exact: true });
      await dialog.getByLabel('下一步', { exact: true }).fill(`${c.next_action} 编辑说明仍保留原前序关系。`);
      const metadata = await saveFromUI(page, `metadata-${c.id}`, () => dialog.getByRole('button', { name: '确认保存', exact: true }).click());
      await page.getByRole('dialog').waitFor({ state: 'detached' });
      checkTask(metadata.state, c.id, 'blocked', [a.id, b.id]);
      checkTask(metadata.state, a.id, 'todo');
      checkTask(metadata.state, b.id, 'todo');

      await page.getByRole('button', { name: c.title, exact: true }).click();
      dialog = page.getByRole('dialog', { name: c.title, exact: true });
      await dialog.getByRole('button', { name: `查看前序任务：${a.title}`, exact: true }).click();
      dialog = page.getByRole('dialog', { name: a.title, exact: true });
      await dialog.waitFor();
      assert.equal(await dialog.locator('.detail-next p').innerText(), a.next_action);
      await dialog.getByRole('button', { name: `返回后续任务：${c.title}`, exact: true }).waitFor();
      await capture(page, `prerequisite-full-details-${width}`);
      await dialog.getByRole('button', { name: '编辑任务', exact: true }).click();
      dialog = page.getByRole('dialog', { name: '更新任务', exact: true });
      await dialog.waitFor();
      assert.equal(await dialog.getByLabel('任务名称', { exact: true }).inputValue(), a.title);
      await dialog.getByRole('button', { name: '关闭', exact: true }).click();
      dialog = page.getByRole('dialog', { name: a.title, exact: true });
      await dialog.waitFor();
      assert.equal(await dialog.locator('.detail-next p').innerText(), a.next_action);
      await dialog.getByRole('button', { name: `返回后续任务：${c.title}`, exact: true }).click();
      dialog = page.getByRole('dialog', { name: c.title, exact: true });
      await dialog.getByRole('button', { name: `查看前序任务：${a.title}`, exact: true }).click();
      dialog = page.getByRole('dialog', { name: a.title, exact: true });
      await dialog.waitFor();
      const first = await saveFromUI(page, `complete-${a.id}`, () => dialog.getByRole('button', { name: '完成当前任务', exact: true }).click());
      checkTask(first.state, a.id, 'done');
      checkTask(first.state, b.id, 'todo');
      checkTask(first.state, c.id, 'blocked', [a.id, b.id]);
      checkTask(first.state, d.id, 'waiting', [a.id]);

      await dialog.getByRole('button', { name: `返回后续任务：${c.title}`, exact: true }).click();
      dialog = page.getByRole('dialog', { name: c.title, exact: true });
      await dialog.waitFor();
      assert.equal(await dialog.getByRole('button', { name: '完成当前任务', exact: true }).isDisabled(), true);
      await dialog.getByRole('button', { name: `查看前序任务：${b.title}`, exact: true }).click();
      dialog = page.getByRole('dialog', { name: b.title, exact: true });
      await dialog.waitFor();
      assert.equal(await dialog.locator('.detail-next p').innerText(), b.next_action);
      const second = await saveFromUI(page, `complete-${b.id}`, () => dialog.getByRole('button', { name: '完成当前任务', exact: true }).click());
      checkTask(second.state, a.id, 'done');
      checkTask(second.state, b.id, 'done');
      checkTask(second.state, c.id, 'todo', [a.id, b.id]);
      checkTask(second.state, d.id, 'waiting', [a.id]);
      await dialog.getByRole('button', { name: `返回后续任务：${c.title}`, exact: true }).click();
      dialog = page.getByRole('dialog', { name: c.title, exact: true });
      await dialog.waitFor();
      assert.equal(await dialog.getByRole('button', { name: '完成当前任务', exact: true }).isDisabled(), false);
      await capture(page, `unlocked-not-completed-${width}`);
      await dialog.getByRole('button', { name: '关闭', exact: true }).click();

      await page.getByRole('button', { name: '新建任务', exact: true }).click();
      dialog = page.getByRole('dialog', { name: '新建任务', exact: true });
      await dialog.getByLabel('所属项目').selectOption(projectId);
      const createDependency = dialog.locator('.dependency-fieldset label').filter({ hasText: a.title }).getByRole('checkbox');
      await createDependency.check();
      assert.equal(await createDependency.isChecked(), true);
      await createDependency.uncheck();
      assert.equal(await createDependency.isChecked(), false);
      await capture(page, `new-task-relations-selectable-${width}`);
      await dialog.getByRole('button', { name: '关闭', exact: true }).click();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);

      const ownRequests = requests.filter(item => item.width === width);
      assert.equal(ownRequests.length, 3, 'Only metadata save and two explicit prerequisite completions should be sent');
      for (const request of ownRequests) {
        assert.equal(request.payload.changes.length, 1);
        const change = request.payload.changes[0];
        assert.equal(change.type, 'update');
        assert.equal(Object.hasOwn(change.values, 'dependencies'), false);
        const expected = request.stage.startsWith('metadata-') ? c.id : request.stage.slice('complete-'.length);
        assert.equal(change.id, expected);
        if (request.stage.startsWith('complete-')) assert.deepEqual(change.values, { status: 'done' });
      }
      results.push({ width, setupOperation, atomicBypassOperation, metadataOperation: metadata.saved.operation_id, firstOperation: first.saved.operation_id, secondOperation: second.saved.operation_id, checks: { atomicBypassRejected: true, prerequisiteNavigation: true, fullDetailsVisible: true, nestedEditorReturnsToPrerequisite: true, blockedCompletionDisabled: true, blockedEditorCannotChooseActiveStatuses: true, existingRelationsReadOnly: true, metadataSavePreservesDependencies: true, prerequisiteCompletionReceiptsIndependentlyVerified: true, allPrerequisitesRequired: true, releasedTaskIsTodoOnly: true, releasedWaitingTaskIsWaitingOnly: true, returnToSuccessor: true, newTaskRelationshipsSelectable: true, noDependencyRewriteRequests: true, noHorizontalOverflow: true }, ids: { a: a.id, b: b.id, c: c.id, d: d.id } });
    } catch (error) {
      await capture(page, `failure-${width}`).catch(() => {});
      throw error;
    } finally {
      await context.close();
    }
  }
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(rejectedRequests, []);
  const report = { recorded_at: new Date().toISOString(), base, passed: true, results, requests, pageErrors, rejectedRequests, screenshots, productionWrites: 0 };
  fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: true, viewports: results.length, checks: results.reduce((count, item) => count + Object.keys(item.checks).length, 0), uiWrites: requests.length, screenshots: screenshots.length, productionWrites: 0, output: out }));
} catch (error) {
  fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ recorded_at: new Date().toISOString(), base, passed: false, error: error.stack || error.message, results, requests, pageErrors, rejectedRequests, screenshots, productionWrites: 0 }, null, 2));
  throw error;
} finally {
  await browser.close();
}
