import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import ts from 'typescript';
import { chromium } from '../.sites-runtime/browser-qa/node_modules/playwright-core/index.mjs';
import { base } from './local-base.mjs';

// Actual local frontend, in-memory real interpretation/model, fictional state,
// mocked recognition. No business POST, image, or AI call leaves this fixture.
const compile = file => ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const modelURL = `data:text/javascript;base64,${Buffer.from(compile('lib/model.ts')).toString('base64')}`;
const { applyChanges } = await import(modelURL);
const intakeCode = compile('lib/intake.ts').replace(/from ['"]\.\/model['"]/g, `from '${modelURL}'`);
const { buildIntakePreview } = await import(`data:text/javascript;base64,${Buffer.from(intakeCode).toString('base64')}`);
const seed = JSON.parse(fs.readFileSync('tests/visual-fixture.json', 'utf8'));
const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const pixelHash = crypto.createHash('sha256').update(pixel).digest('hex');
const out = path.resolve('.sites-runtime/image-intake-ui-proof'); fs.mkdirSync(out, { recursive: true });
const checks = [], screenshots = [], pageErrors = [], intercepted = [], escapedRequests = [];
const dinnerFields = { title: '南里山房太阳宫店晚宴预约', classification: 'reserved_event', item_type: 'event', status: 'todo', event_status: 'reserved', date: '2026-10-17', time: '17:00', location: '南里山房·宴山海（太阳宫店）山海包厢', project_id: 'demo-collab', next_action: '按原预约时间参加，核对门店和包厢。', target_task_id: '', action: 'inspect', uncertainties_confirmed: false };

function initialState() {
  const state = structuredClone(seed); state.revision = 41;
  state.data.tasks.push({ id: 'fixture-dinner', project_id: 'demo-collab', title: '已预约活动｜2026-10-17 17:00 南里山房·宴山海太阳宫店 山海包厢', status: 'todo', item_type: 'event', event_status: 'reserved', event_date: '2026-10-17', start_at: '2026-10-17T17:00:00+08:00', location: dinnerFields.location, next_action: dinnerFields.next_action, dependencies: [], version: 1, verification_state: 'user_reported', updated_at: '2026-10-15T07:00:00Z', created_at: '2026-10-15T07:00:00Z', source_ref: '虚构已存在预约；仅供防重复验收', attachment_ids: [] });
  return state;
}

async function capture(page, label) { await page.locator('.intake-heading h3').click(); await page.screenshot({ path: path.join(out, `${label}.png`), fullPage: true }); screenshots.push(`${label}.png`); }
async function stableDraft(page) { await page.getByText('本人本机草稿已保存', { exact: true }).waitFor(); }
async function readStored(page, scope) {
  return page.evaluate(async key => {
    const db = await new Promise((resolve, reject) => { const r = indexedDB.open('spoken-projects:image-intake:v1', 1); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    const draft = await new Promise((resolve, reject) => { const r = db.transaction('drafts', 'readonly').objectStore('drafts').get(key); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); }); db.close();
    const bytes = draft.image ? await draft.image.blob.arrayBuffer() : null;
    const hash = bytes ? [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('') : null;
    return { note: draft.note, fields: draft.fields, pending: draft.pending, recognitionRequestId: draft.recognitionRequestId, recognitionQuestions: draft.recognitionQuestions, resolvedRecognitionQuestions: draft.resolvedRecognitionQuestions, imageHash: hash };
  }, scope);
}

async function setup(width, vision = false) {
  const context = await browser.newContext({ viewport: { width, height: width < 500 ? 844 : 1000 }, locale: 'zh-CN', timezoneId: 'America/Los_Angeles', serviceWorkers: 'block' });
  await context.addInitScript(() => {
    window.__draftReads = [];
    const originalGet = IDBObjectStore.prototype.get, originalPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.get = function (key) { if (this.name === 'drafts') window.__draftReads.push(key); return originalGet.call(this, key); };
    IDBObjectStore.prototype.put = function (...args) { if (this.name === 'drafts' && window.__quotaFailure) throw new DOMException('Fixture quota exceeded', 'QuotaExceededError'); return originalPut.apply(this, args); };
  });
  const page = await context.newPage(); page.setDefaultTimeout(10000);
  page.on('pageerror', error => pageErrors.push({ width, message: error.message }));
  const control = { state: initialState(), scope: `fixture-owner-${width}`, capabilitiesStatus: 200, vision, recognizeMode: 'success', commitMode: 'success', receiptUnavailable: false, operations: new Map(), operationReads: [], commits: [], recognition: [], previews: [] };
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    if (url.origin !== base) { escapedRequests.push({ method, origin: url.origin }); return route.abort('blockedbyclient'); }
    const json = (body, status = 200) => { if (status >= 400) intercepted.push({ width, path: url.pathname, status, error: body.error, message: body.message }); return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) }); };
    if (url.pathname === '/api/state') return json(control.state);
    if (url.pathname === '/api/intake/capabilities') return control.capabilitiesStatus !== 200 ? json({ error: 'AUTH', message: '虚构身份暂不可用' }, control.capabilitiesStatus) : json({ draft_scope: control.scope, max_image_bytes: 1500000, allowed_types: ['image/png', 'image/jpeg', 'image/webp'], storage_text: '虚构草稿说明：确认并独立读回后才正式保存原图。', vision: { configured: control.vision, enabled: control.vision, provider: 'OpenAI', model: 'gpt-4.1-mini', pricing_text: '本场景是完全拦截的虚构响应，不产生实际费用。', retention_text: '虚构服务保留策略说明。', max_daily_requests: 10 } });
    if (url.pathname === '/api/operations') return json({ operations: [...control.operations.values()] });
    if (url.pathname.startsWith('/api/operations/')) {
      const id = decodeURIComponent(url.pathname.split('/').at(-1));
      control.operationReads.push(id);
      if (control.receiptUnavailable) return json({ error: 'QA_READBACK', message: '虚构读回不可用' }, 503);
      return control.operations.has(id) ? json(control.operations.get(id)) : json({ error: 'OPERATION', message: '虚构原编号尚未保存' }, 404);
    }
    if (url.pathname.startsWith('/api/intake/') && method === 'POST') {
      const form = await new Response(request.postDataBuffer(), { headers: { 'Content-Type': request.headers()['content-type'] } }).formData();
      const file = form.get('image'), bytes = file && typeof file !== 'string' ? Buffer.from(await file.arrayBuffer()) : null;
      const hash = bytes ? crypto.createHash('sha256').update(bytes).digest('hex') : null;
      intercepted.push({ width, path: url.pathname, imageHash: hash });
      const image = bytes ? { id: `img_${hash}`, sha256: hash, mime_type: file.type, byte_size: bytes.length, uploaded_at: '2026-10-16T10:35:21Z' } : null;
      if (url.pathname.endsWith('/recognize')) {
        const entry = { requestId: form.get('request_id'), consent: form.get('consent'), note: form.get('note'), imageHash: hash }; control.recognition.push(entry);
        assert.equal(entry.consent, 'true'); assert.equal(entry.imageHash, pixelHash);
        if (control.recognizeMode === 'pending') return json({ error: 'RECOGNITION_PENDING', message: '虚构同一识别尚待确认，保留原编号。' }, 409);
        return json({ fields: { ...dinnerFields }, questions: ['图中存在多个日期，请核对具体活动日期。', '开始时间尚待确认。'], classification: 'reserved_event', recognized: true, provider: 'OpenAI', model: 'gpt-4.1-mini', cached: control.recognition.length > 1 });
      }
      if (url.pathname.endsWith('/preview')) {
        const input = JSON.parse(form.get('draft_json')); control.previews.push(input);
        try { return json(buildIntakePreview(control.state.data, control.state.revision, input, image)); }
        catch (error) { return json({ error: error.code || 'QA_PREVIEW', message: error.message }, error.status || 500); }
      }
      if (url.pathname.endsWith('/commit')) {
        const payload = JSON.parse(form.get('payload_json')); control.commits.push(payload);
        if (control.commitMode === 'failure') return json({ error: 'QA_SAVE', message: '虚构保存503，不能报告成功。' }, 503);
        if (control.commitMode === 'conflict') { control.state.revision++; control.commitMode = 'success'; return json({ error: 'REVISION_CONFLICT', message: '虚构其他编辑先已保存。', current_revision: control.state.revision }, 409); }
        if (typeof control.commitMode === 'object') return json({ error: control.commitMode.error, message: '虚构保存校验拒绝，需要核对原请求后修正。' }, control.commitMode.status);
        if (control.operations.has(payload.operation_id)) return json({ ...control.operations.get(payload.operation_id), duplicate: true });
        try {
          assert.equal(payload.base_version, control.state.revision);
          const before = structuredClone(control.state.data), after = applyChanges(before, payload.changes, new Date().toISOString(), payload.occurred_at).data;
          control.state = { ...control.state, data: after, revision: control.state.revision + 1 };
          const receipt = { state: 'verified', operation_id: payload.operation_id, result_version: control.state.revision, verification: 'current_fields_match', current_revision: control.state.revision, before, after, changes: payload.changes, occurred_at: payload.occurred_at, raw_text: payload.raw_text, source_event_id: payload.source_event_id };
          control.operations.set(payload.operation_id, receipt); return json(receipt);
        } catch (error) { return json({ error: error.code || 'QA_COMMIT', message: error.message }, error.status || 500); }
      }
    }
    if (!['GET', 'HEAD'].includes(method)) { escapedRequests.push({ method, path: url.pathname }); return route.abort('blockedbyclient'); }
    if (url.pathname.startsWith('/api/')) return json({ error: 'FIXTURE_ONLY' }, 404);
    return route.continue();
  });
  await page.goto(`${base}/?view=today`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: '选择图片', exact: true }).waitFor();
  return { page, context, control };
}

async function choosePixel(page) { await page.getByLabel('选择事项图片', { exact: true }).setInputFiles({ name: 'fictional-appointment.png', mimeType: 'image/png', buffer: pixel }); await page.locator('.intake-image-card img').waitFor(); }
async function manualEvent(page) {
  await page.getByRole('button', { name: '手动填写', exact: true }).click();
  await page.getByLabel('事项标题', { exact: true }).fill(dinnerFields.title);
  await page.getByLabel('内容分类', { exact: true }).selectOption('reserved_event');
  await page.getByLabel('记录类型', { exact: true }).selectOption('event');
  await page.getByLabel('事项所属项目', { exact: true }).selectOption('demo-collab');
  await page.getByLabel('活动状态', { exact: true }).selectOption('reserved');
  await page.getByLabel('活动日期（未知可留空）', { exact: true }).fill(dinnerFields.date);
  await page.getByLabel('开始时间（北京时间，可留空）', { exact: true }).fill(dinnerFields.time);
  await page.getByLabel('事项地点', { exact: true }).fill(dinnerFields.location);
  await page.getByLabel('事项下一步', { exact: true }).fill(dinnerFields.next_action);
}
async function preview(page) { const response = page.waitForResponse(r => r.url().endsWith('/api/intake/preview')); await page.getByRole('button', { name: '生成核对预览', exact: true }).click(); const result = await (await response).json(); await page.getByRole('region', { name: '图片事项核对预览', exact: true }).waitFor(); return result; }
async function confirmUnknown(page) { await page.getByRole('checkbox', { name: /我已逐项核对/ }).check(); }

const browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true, args: ['--disable-gpu'] });
try {
  const manual = await setup(1440);
  try {
    const { page, control } = manual;
    await choosePixel(page); await page.getByLabel('图片补充说明', { exact: true }).fill('核对已有晚宴预约，原图作为附件。');
    assert.equal(await page.getByRole('button', { name: '识别预览', exact: true }).isDisabled(), true);
    await manualEvent(page); await page.getByLabel('本次事项操作', { exact: true }).selectOption('create');
    const found = await preview(page); assert.equal(found.duplicate, true); assert.equal(found.changes.length, 0); assert.equal(found.fields.action, 'inspect');
    assert.equal(await page.getByRole('button', { name: '确认保存图片与事项', exact: true }).isDisabled(), true);
    await page.getByText('本次图片上传核对时间（非活动时间）', { exact: true }).waitFor();
    assert.equal(await page.locator('.intake-upload-record time').getAttribute('datetime'), '2026-10-16T10:35:21Z');
    await capture(page, 'manual-existing-event-1440');
    await page.getByRole('button', { name: '关联到已有事项', exact: true }).click(); await confirmUnknown(page);
    const linked = await preview(page); assert.equal(linked.changes.length, 1); assert.equal(linked.changes[0].type, 'update'); assert.equal(linked.changes[0].id, 'fixture-dinner');
    assert.equal(control.commits.length, 0); assert.equal(control.recognition.length, 0);
    assert.ok((await page.locator('.intake-changes').innerText()).includes('本人私有原图'));
    assert.equal(/attachment_ids|item_type|event_status/.test(await page.locator('.intake-changes').innerText()), false);
    checks.push({ manualWithoutVision: true, existingDinnerNotDuplicated: true, associationRequiresExplicitChoice: true, uploadTimeDistinctFromEventTime: true, chineseChangeLabels: true });
  } finally { await manual.context.close(); }

  const vision = await setup(390, true);
  try {
    const { page, control } = vision;
    await choosePixel(page); await page.getByLabel('图片补充说明', { exact: true }).fill('请核对图片中的日期，原预约已经存在。'); await stableDraft(page);
    const recognizeButton = page.getByRole('button', { name: '识别预览（可能收费）', exact: true });
    assert.equal(await recognizeButton.isDisabled(), true); assert.equal(control.recognition.length, 0);
    await page.getByRole('checkbox', { name: /我同意本次发送原图/ }).check(); control.recognizeMode = 'pending'; await recognizeButton.click();
    await page.getByText(/虚构同一识别尚待确认/).waitFor(); await stableDraft(page);
    const initial = await readStored(page, control.scope); assert.equal(initial.imageHash, pixelHash);
    await page.reload({ waitUntil: 'networkidle' }); await page.getByRole('button', { name: '更换图片', exact: true }).waitFor();
    assert.equal(await page.getByLabel('图片补充说明', { exact: true }).inputValue(), initial.note);
    assert.equal((await readStored(page, control.scope)).recognitionRequestId, initial.recognitionRequestId);
    control.recognizeMode = 'success'; await page.getByRole('checkbox', { name: /我同意本次发送原图/ }).check(); await recognizeButton.click();
    await page.getByRole('heading', { name: '修订识别候选', exact: true }).waitFor(); assert.equal(control.recognition[0].requestId, control.recognition[1].requestId);
    await page.getByLabel('事项标题', { exact: true }).fill('已经人工校对的晚宴预约');
    await page.getByLabel('本次事项操作', { exact: true }).selectOption('link_existing'); await page.getByLabel('目标已有事项', { exact: true }).selectOption('fixture-dinner'); await confirmUnknown(page);
    const blocked = await preview(page); assert.equal(blocked.changes.length, 0); assert.equal(control.previews.at(-1).questions.length, 2);
    assert.equal(await page.getByRole('button', { name: '已核对并修正此问题', exact: true }).count(), 2);
    await page.getByRole('button', { name: '已核对并修正此问题', exact: true }).first().click();
    assert.equal(await page.getByRole('button', { name: '已核对并修正此问题', exact: true }).count(), 1);
    await page.getByRole('button', { name: '已核对并修正此问题', exact: true }).click(); await confirmUnknown(page);
    const resolved = await preview(page); assert.equal(resolved.changes.length, 1); assert.deepEqual(control.previews.at(-1).questions, []);
    await capture(page, 'recognized-and-corrected-390');
    control.commitMode = 'failure'; await page.getByRole('button', { name: '确认保存图片与事项', exact: true }).click(); await page.getByRole('button', { name: '查询保存结果', exact: true }).waitFor(); await stableDraft(page);
    const pending = await readStored(page, control.scope); assert.ok(pending.pending.operation_id); assert.equal(pending.imageHash, pixelHash);
    assert.equal(await page.getByRole('button', { name: '核对原请求后重新编辑', exact: true }).count(), 0);
    await page.reload({ waitUntil: 'networkidle' }); await page.getByRole('button', { name: '查询保存结果', exact: true }).waitFor();
    assert.equal((await readStored(page, control.scope)).pending.operation_id, pending.pending.operation_id);
    control.commitMode = 'success'; await page.getByRole('button', { name: '重试原请求（同一编号）', exact: true }).click();
    await page.getByText('图片与事项已保存，并已独立读回验证。', { exact: true }).waitFor(); await stableDraft(page);
    assert.deepEqual(control.commits[0], control.commits[1]); assert.equal(control.state.data.tasks.filter(task => task.id === 'fixture-dinner').length, 1);
    assert.equal((await readStored(page, control.scope)).imageHash, null);
    checks.push({ feeConsentRequired: true, originalBytesPreserved: true, recognitionPendingKeepsIdAfterReload: true, editsDoNotSilentlyClearQuestions: true, individualQuestionResolution: true, originalQuestionsRetainedInDraft: pending.resolvedRecognitionQuestions.length === 2, failedSaveKeepsPayloadAndBlob: true, retryUsesIdenticalPayload: true, verifiedReadbackClearsDraft: true });
  } finally { await vision.context.close(); }

  const conflict = await setup(320);
  try {
    const { page, control } = conflict;
    await choosePixel(page); await page.getByRole('button', { name: '手动填写', exact: true }).click();
    await page.getByLabel('事项标题', { exact: true }).fill('虚构独立并发图片待办'); await page.getByLabel('内容分类', { exact: true }).selectOption('new_task'); await page.getByLabel('事项所属项目', { exact: true }).selectOption('demo-product'); await page.getByLabel('本次事项操作', { exact: true }).selectOption('create'); await confirmUnknown(page);
    const before = await preview(page); assert.equal(before.changes.length, 1); control.commitMode = 'conflict';
    await page.getByRole('button', { name: '确认保存图片与事项', exact: true }).click(); await page.getByRole('button', { name: '核对原请求后重新编辑', exact: true }).waitFor();
    await capture(page, 'conflict-preserves-draft-320');
    await page.getByRole('button', { name: '核对原请求后重新编辑', exact: true }).click(); await page.getByText(/已核对原编号尚未保存/).waitFor();
    assert.equal(control.commits.length, 1); assert.equal(await page.getByLabel('事项标题', { exact: true }).inputValue(), '虚构独立并发图片待办');
    const current = await preview(page); assert.equal(current.base_version, 42); assert.equal(await page.getByRole('button', { name: '确认保存图片与事项', exact: true }).isDisabled(), false);
    await page.getByRole('button', { name: '确认保存图片与事项', exact: true }).click(); await page.getByText('图片与事项已保存，并已独立读回验证。', { exact: true }).waitFor();
    assert.equal(control.state.data.tasks.filter(task => task.title === '虚构独立并发图片待办').length, 1);
    assert.notEqual(control.commits[0].operation_id, control.commits[1].operation_id);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    checks.push({ conflictDoesNotAutoCreate: true, original404CheckedBeforeRepreview: true, newPreviewUsesCurrentRevision: true, exactlyOneTaskAfterConflictRecovery: true, mobile320NoOverflow: true });
  } finally { await conflict.context.close(); }

  for (const rejected of [{ status: 400, error: 'WAITING_FOR_REQUIRED' }, { status: 409, error: 'DUPLICATE_IMAGE' }, { status: 413, error: 'IMAGE_SIZE' }, { status: 415, error: 'IMAGE_TYPE' }]) {
    const validation = await setup(390);
    try {
      const { page, control } = validation;
      const title = `虚构可修正图片事项${rejected.status}`;
      await choosePixel(page); await page.getByLabel('图片补充说明', { exact: true }).fill('被明确拒绝后，仍保留原图和全部人工填写内容。');
      await page.getByRole('button', { name: '手动填写', exact: true }).click();
      await page.getByLabel('事项标题', { exact: true }).fill(title); await page.getByLabel('内容分类', { exact: true }).selectOption('new_task'); await page.getByLabel('事项所属项目', { exact: true }).selectOption('demo-product'); await page.getByLabel('本次事项操作', { exact: true }).selectOption('create'); await confirmUnknown(page);
      assert.equal((await preview(page)).changes.length, 1); control.commitMode = rejected;
      await page.getByRole('button', { name: '确认保存图片与事项', exact: true }).click(); await page.getByRole('button', { name: '核对原请求后重新编辑', exact: true }).waitFor(); await stableDraft(page);
      const pending = await readStored(page, control.scope); assert.equal(pending.imageHash, pixelHash); assert.equal(pending.fields.title, title); assert.ok(pending.pending);
      assert.equal(await page.getByLabel('事项标题', { exact: true }).isDisabled(), true); assert.equal(control.state.revision, 41);
      control.receiptUnavailable = true; await page.getByRole('button', { name: '核对原请求后重新编辑', exact: true }).click(); await page.getByText(/虚构读回不可用/).waitFor(); await stableDraft(page);
      assert.equal((await readStored(page, control.scope)).pending.operation_id, pending.pending.operation_id); assert.equal(await page.getByLabel('事项标题', { exact: true }).isDisabled(), true);
      control.receiptUnavailable = false; await page.getByRole('button', { name: '核对原请求后重新编辑', exact: true }).click(); await page.getByText(/已核对原编号尚未保存/).waitFor(); await stableDraft(page);
      const editable = await readStored(page, control.scope); assert.equal(editable.pending, null); assert.equal(editable.imageHash, pixelHash); assert.equal(editable.fields.title, title); assert.ok(control.operationReads.includes(pending.pending.operation_id));
      assert.equal(await page.getByLabel('事项标题', { exact: true }).isDisabled(), false); assert.equal(control.commits.length, 1);
      await page.getByLabel('事项标题', { exact: true }).fill(`${title}已修正`); await confirmUnknown(page); assert.equal((await preview(page)).changes.length, 1);
      control.commitMode = 'success'; await page.getByRole('button', { name: '确认保存图片与事项', exact: true }).click(); await page.getByText('图片与事项已保存，并已独立读回验证。', { exact: true }).waitFor();
      assert.notEqual(control.commits[0].operation_id, control.commits[1].operation_id); assert.equal(control.state.data.tasks.filter(task => task.title === `${title}已修正`).length, 1);
      checks.push({ rejectedStatus: rejected.status, correctionRequiresOriginal404: true, failedProbeKeepsOriginalLocked: true, correctionRetainsImageAndFields: true, correctionRepreviewsBeforeNewOperation: true });
    } finally { await validation.context.close(); }
  }

  const isolation = await setup(390);
  try {
    const { page, control } = isolation;
    await choosePixel(page); await page.getByLabel('图片补充说明', { exact: true }).fill('只属于账号A的草稿说明'); await stableDraft(page);
    await page.getByLabel('选择事项图片', { exact: true }).setInputFiles({ name: 'wrong.pdf', mimeType: 'application/pdf', buffer: Buffer.from('fixture') });
    await page.getByText(/仅支持 PNG、JPEG、WEBP/).waitFor(); assert.equal(await page.getByLabel('图片补充说明', { exact: true }).inputValue(), '只属于账号A的草稿说明');
    await page.getByLabel('选择事项图片', { exact: true }).setInputFiles({ name: 'oversized.png', mimeType: 'image/png', buffer: Buffer.alloc(1500001) }); await page.getByText(/图片需为 1 至/).waitFor(); await stableDraft(page);
    assert.equal((await readStored(page, control.scope)).imageHash, pixelHash);
    await page.evaluate(() => { window.__quotaFailure = true; }); await page.getByLabel('图片补充说明', { exact: true }).fill('空间失败后仍在当前页面');
    await page.getByText(/本机草稿尚未保存到浏览器空间/).waitFor(); assert.equal(await page.getByLabel('图片补充说明', { exact: true }).inputValue(), '空间失败后仍在当前页面');
    await page.evaluate(() => { window.__quotaFailure = false; }); await page.getByRole('button', { name: '重试保存本机草稿', exact: true }).click(); await stableDraft(page);
    control.capabilitiesStatus = 401; await page.reload({ waitUntil: 'networkidle' }); await page.getByText(/当前身份无法读取图片草稿/).waitFor(); assert.deepEqual(await page.evaluate(() => window.__draftReads), []);
    control.capabilitiesStatus = 200; control.scope = 'fixture-different-owner'; await page.reload({ waitUntil: 'networkidle' }); await page.getByRole('button', { name: '选择图片', exact: true }).waitFor();
    assert.equal(await page.getByLabel('图片补充说明', { exact: true }).inputValue(), ''); assert.deepEqual(await page.evaluate(() => window.__draftReads), ['fixture-different-owner']);
    checks.push({ invalidTypeAndSizeRetainExistingImage: true, quotaFailureRetainsInMemoryDraft: true, storageRetryRecovers: true, auth401NeverReadsIndexedDBDraft: true, differentOwnerGetsOnlyOwnDraft: true });
  } finally { await isolation.context.close(); }

  assert.deepEqual(pageErrors, []); assert.deepEqual(escapedRequests, []);
  const report = { recorded_at: new Date().toISOString(), passed: true, source: 'Local UI and real in-memory model/builder with fully fictional API and vision responses', checks, screenshots, pageErrors, intercepted, escapedRequests, productionRequests: 0, realProviderCalls: 0 };
  fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ passed: true, scenarios: checks.length, checks: checks.reduce((count, item) => count + Object.values(item).filter(value => value === true).length, 0), screenshots: screenshots.length, realProviderCalls: 0, productionRequests: 0, output: out }));
} catch (error) {
  fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ recorded_at: new Date().toISOString(), passed: false, error: error.stack || error.message, checks, screenshots, pageErrors, intercepted, escapedRequests }, null, 2)); throw error;
} finally { await browser.close(); }
