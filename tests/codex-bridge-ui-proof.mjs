import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import ts from 'typescript';
import { chromium } from '../.sites-runtime/browser-qa/node_modules/playwright-core/index.mjs';
import { base } from './local-base.mjs';

// Real local frontend and in-memory interpretation/model. All loopback bridge,
// authorization, AI, parser and business routes are intercepted before dispatch.
const compile = file => ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const modelURL = `data:text/javascript;base64,${Buffer.from(compile('lib/model.ts')).toString('base64')}`;
const { applyChanges } = await import(modelURL);
const { buildIntakePreview } = await import(`data:text/javascript;base64,${Buffer.from(compile('lib/intake.ts').replace(/from ['"]\.\/model['"]/g, `from '${modelURL}'`)).toString('base64')}`);
const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const hash = crypto.createHash('sha256').update(pixel).digest('hex');
const bridge = 'http://127.0.0.1:5197';
const fixtureToken = 'fixture-memory-only-secret-token';
const fixtureCode = '78243169';
const fields = { title: '南里山房太阳宫店晚宴预约', classification: 'reserved_event', item_type: 'event', status: 'todo', event_status: 'reserved', date: '2026-10-17', time: '17:00', location: '南里山房·宴山海（太阳宫店）山海包厢', project_id: 'demo-collab', next_action: '按已预约时间到店，核对包厢。', target_task_id: '', action: 'inspect', uncertainties_confirmed: false };
const out = path.resolve('.sites-runtime/codex-bridge-ui-proof'); fs.mkdirSync(out, { recursive: true });
const checks = [], screenshots = [], pageErrors = [], escaped = [];
function initialState() {
  const state = JSON.parse(fs.readFileSync('tests/visual-fixture.json', 'utf8')); state.revision = 61;
  state.data.tasks.push({ id: 'fixture-dinner', project_id: 'demo-collab', title: '已预约活动｜2026-10-17 17:00 南里山房·宴山海太阳宫店 山海包厢', status: 'todo', item_type: 'event', event_status: 'reserved', event_date: fields.date, start_at: '2026-10-17T17:00:00+08:00', location: fields.location, next_action: fields.next_action, dependencies: [], version: 1, verification_state: 'user_reported', created_at: '2026-10-16T07:00:00Z', updated_at: '2026-10-16T07:00:00Z', attachment_ids: [] });
  return state;
}
async function draft(page, scope) {
  return page.evaluate(async key => {
    const db = await new Promise((resolve, reject) => { const request = indexedDB.open('spoken-projects:image-intake:v1', 1); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const saved = await new Promise((resolve, reject) => { const request = db.transaction('drafts', 'readonly').objectStore('drafts').get(key); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); }); db.close();
    const imageHash = saved.image ? [...new Uint8Array(await crypto.subtle.digest('SHA-256', await saved.image.blob.arrayBuffer()))].map(value => value.toString(16).padStart(2, '0')).join('') : null;
    return { data: JSON.parse(JSON.stringify(saved)), imageHash, local: JSON.stringify({ ...localStorage }), session: JSON.stringify({ ...sessionStorage }) };
  }, scope);
}
async function stable(page) { await page.getByText('本人本机草稿已保存', { exact: true }).waitFor(); }
async function selectImage(page) { await page.getByLabel('选择事项图片', { exact: true }).setInputFiles({ name: 'fictional-dinner.png', mimeType: 'image/png', buffer: pixel }); await page.locator('.intake-image-card img').waitFor(); }
async function setup(width) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', serviceWorkers: 'block' });
  await context.addInitScript(() => { const original = crypto.subtle.digest.bind(crypto.subtle); crypto.subtle.digest = async (...args) => { if (window.__holdDigest) { window.__digestHeld = true; await new Promise(resolve => { window.__releaseDigest = resolve; }); const result = await original(...args); window.__digestFinished = true; return result; } return original(...args); }; });
  const page = await context.newPage(); page.setDefaultTimeout(10000); page.on('pageerror', error => pageErrors.push({ width, message: error.message }));
  const control = { state: initialState(), scope: `codex-fixture-owner-${width}`, bridgeCalls: [], recognitions: [], parserCalls: [], previews: [], commits: [], receipts: new Map(), denyPair: false, recognitionMode: 'success', models: [{ slug: 'gpt-6.1-sol', display_name: 'GPT 6.1 Sol' }, { slug: 'fixture-other', display_name: 'Fixture Other' }], receiptUnavailable: false };
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    const cors = { 'Access-Control-Allow-Origin': base, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Private-Network': 'true' };
    const json = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: url.origin === bridge ? cors : {}, body: JSON.stringify(value) });
    if (url.origin === bridge) {
      if (method === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
      control.bridgeCalls.push({ path: url.pathname, method });
      if (url.pathname === '/pair') { if (control.denyPair) return route.abort('blockedbyclient'); const body = request.postDataJSON(); assert.equal(body.code, fixtureCode); assert.equal(body.scope, control.scope); return json({ token: fixtureToken, bridge_id: 'fixture-bridge' }); }
      assert.equal(request.headers().authorization, `Bearer ${fixtureToken}`);
      if (url.pathname === '/status') return json({ connected: true, plan_authorized: true, account_label: '本人虚构计划账号', account_key: 'fixture-account', bridge_id: 'fixture-bridge', quota: { day: '2026-10-17', used: 1, max: 10 } });
      if (url.pathname === '/models') return json({ models: control.models });
      if (url.pathname === '/disconnect') return json({ disconnected: true });
      if (url.pathname === '/recognize') {
        const form = await new Response(request.postDataBuffer(), { headers: { 'Content-Type': request.headers()['content-type'] } }).formData();
        const image = form.get('image'), actualHash = crypto.createHash('sha256').update(Buffer.from(await image.arrayBuffer())).digest('hex');
        const entry = { requestId: form.get('request_id'), note: form.get('note'), model: form.get('model'), consent: form.get('consent'), imageHash: actualHash, projects: JSON.parse(form.get('projects_json')) }; control.recognitions.push(entry);
        assert.equal(actualHash, hash); assert.equal(entry.consent, 'true'); assert.ok(entry.projects.some(project => project.id === 'demo-collab')); for (const project of entry.projects) assert.deepEqual(Object.keys(project).sort(), ['id', 'name']);
        if (control.recognitionMode === 'pending') return json({ error: 'RECOGNITION_PENDING' }, 409);
        if (typeof control.recognitionMode === 'object') return json({ error: control.recognitionMode.error, message: fixtureToken + ' is deliberately unsafe provider text' }, control.recognitionMode.status);
        const response = { result: { fields, questions: [] }, model: entry.model, request_id: entry.requestId, image_sha256: hash, provider: 'codex-local-plan', completed: true, cached: control.recognitions.length > 1 };
        if (control.recognitionMode === 'wrong-hash') response.image_sha256 = '0'.repeat(64);
        if (control.recognitionMode === 'wrong-id') response.request_id = 'fixture-unrelated-request';
        if (control.recognitionMode === 'incomplete') response.completed = false;
        return json(response);
      }
      escaped.push({ origin: url.origin, path: url.pathname, method }); return route.abort('blockedbyclient');
    }
    if (url.origin !== base) { escaped.push({ origin: url.origin, method }); return route.abort('blockedbyclient'); }
    if (url.pathname === '/api/state') return json(control.state);
    if (url.pathname === '/api/intake/capabilities') return json({ draft_scope: control.scope, max_image_bytes: 1500000, allowed_types: ['image/png', 'image/jpeg', 'image/webp'], storage_text: '虚构本机草稿说明', vision: { configured: false, enabled: false, provider: 'OpenAI', model: 'gpt-4.1-mini', pricing_text: '', retention_text: '', max_daily_requests: 10 } });
    if (url.pathname === '/api/operations') return json({ operations: [...control.receipts.values()] });
    if (url.pathname.startsWith('/api/operations/')) { if (control.receiptUnavailable) return json({ error: 'QA_READBACK', message: '虚构核验未完成' }, 503); const receipt = control.receipts.get(decodeURIComponent(url.pathname.split('/').at(-1))); return receipt ? json(receipt) : json({ error: 'OPERATION' }, 404); }
    if (url.pathname.startsWith('/api/intake/') && method === 'POST') {
      const form = await new Response(request.postDataBuffer(), { headers: { 'Content-Type': request.headers()['content-type'] } }).formData();
      const image = form.get('image'), imageHash = image ? crypto.createHash('sha256').update(Buffer.from(await image.arrayBuffer())).digest('hex') : null;
      if (url.pathname.endsWith('/codex-result')) { const result = JSON.parse(form.get('result_json')); control.parserCalls.push(result); assert.equal(result.image_sha256, imageHash); assert.equal(result.request_id, control.recognitions.at(-1).requestId); return json({ fields: result.result.fields, questions: result.result.questions, classification: fields.classification, recognized: true, provider: result.provider, model: result.model, cached: result.cached }); }
      if (url.pathname.endsWith('/preview')) { const input = JSON.parse(form.get('draft_json')); control.previews.push(input); return json(buildIntakePreview(control.state.data, control.state.revision, input, { id: `img_${imageHash}`, sha256: imageHash, mime_type: image.type, byte_size: image.size, uploaded_at: '2026-10-17T01:02:03Z' })); }
      if (url.pathname.endsWith('/commit')) {
        const payload = JSON.parse(form.get('payload_json')); control.commits.push(payload); assert.equal(payload.confirmed, true); assert.equal(payload.base_version, control.state.revision);
        const before = structuredClone(control.state.data), after = applyChanges(before, payload.changes, new Date().toISOString(), payload.occurred_at).data;
        control.state = { ...control.state, data: after, revision: control.state.revision + 1 };
        const receipt = { state: 'verified', operation_id: payload.operation_id, result_version: control.state.revision, verification: 'current_fields_match', current_revision: control.state.revision, before, after, changes: payload.changes, occurred_at: payload.occurred_at, raw_text: payload.raw_text, source_event_id: payload.source_event_id }; control.receipts.set(payload.operation_id, receipt); return json(receipt);
      }
      escaped.push({ origin: url.origin, path: url.pathname, method }); return route.abort('blockedbyclient');
    }
    if (url.pathname.startsWith('/api/')) return json({ error: 'FIXTURE_ONLY' }, 404);
    if (!['GET', 'HEAD'].includes(method)) { escaped.push({ origin: url.origin, path: url.pathname, method }); return route.abort('blockedbyclient'); }
    return route.continue();
  });
  await page.goto(`${base}/?view=today`, { waitUntil: 'networkidle' }); await page.getByRole('button', { name: '选择图片', exact: true }).waitFor();
  return { context, page, control };
}
async function pair(page) { await page.getByLabel('本机连接码', { exact: true }).fill(fixtureCode); await page.getByRole('button', { name: '连接本机桥接', exact: true }).click(); await page.getByRole('button', { name: '刷新本机授权状态', exact: true }).waitFor(); }
async function authorize(page) { await pair(page); await page.getByRole('button', { name: '刷新本机授权状态', exact: true }).click(); await page.getByText('本人虚构计划账号', { exact: true }).waitFor(); await page.getByRole('button', { name: '加载可用模型', exact: true }).click(); }
async function consent(page) { await page.getByRole('checkbox', { name: /我同意本图原图/ }).check(); }
async function screenshot(page, name) { const file = `${name}.png`; await page.locator('.codex-bridge-heading h4').click(); await page.locator('.codex-bridge-panel').screenshot({ path: path.join(out, file) }); screenshots.push(file); }
function noCredentials(stored) { const serialized = JSON.stringify(stored); assert.equal(serialized.includes(fixtureToken), false); assert.equal(serialized.includes(fixtureCode), false); }

const browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true, args: ['--disable-gpu'] });
try {
  const main = await setup(320);
  try {
    const { page, control } = main;
    assert.equal(control.bridgeCalls.length, 0); const link = page.getByRole('link', { name: '打开本机授权与连接码页面' }); assert.equal(await link.getAttribute('href'), bridge + '/'); assert.equal(await link.getAttribute('target'), '_blank'); assert.equal(await link.getAttribute('rel'), 'noopener noreferrer');
    await page.getByText('原图、草稿和识别结果如何保留', { exact: true }).click(); await page.getByText(/结构化识别结果在本机缓存七天/).waitFor(); assert.ok((await page.locator('.codex-retention').innerText()).includes('store:false')); await page.getByText('原图、草稿和识别结果如何保留', { exact: true }).click();
    await selectImage(page); await page.getByLabel('图片补充说明', { exact: true }).fill('已有晚宴，不可重复新增。'); await stable(page); const original = await draft(page, control.scope);
    control.denyPair = true; await page.getByLabel('本机连接码', { exact: true }).fill(fixtureCode); await page.getByRole('button', { name: '连接本机桥接', exact: true }).click(); await page.getByText(/无法连接本机桥接/).waitFor(); await stable(page);
    const afterLNA = await draft(page, control.scope); assert.equal(afterLNA.imageHash, hash); assert.equal(afterLNA.data.recognitionRequestId, original.data.recognitionRequestId); assert.equal(afterLNA.data.note, original.data.note); noCredentials(afterLNA);
    control.denyPair = false; await authorize(page); await page.getByLabel('Codex识图模型', { exact: true }).selectOption('gpt-6.1-sol');
    const recognize = page.getByRole('button', { name: '用Codex识别并预览', exact: true }); assert.equal(await recognize.isDisabled(), true);
    await consent(page); control.recognitionMode = 'pending'; await recognize.click(); await page.getByText(/原编号的识别仍需核对/).waitFor(); await stable(page); const pending = await draft(page, control.scope); noCredentials(pending); assert.equal(pending.data.recognitionRequestId, original.data.recognitionRequestId);
    await screenshot(page, 'pending-original-request-320'); const callsBeforeReload = control.bridgeCalls.length;
    await page.reload({ waitUntil: 'networkidle' }); await page.getByRole('button', { name: '更换图片', exact: true }).waitFor(); assert.equal(control.bridgeCalls.length, callsBeforeReload); assert.equal(await page.getByLabel('本机连接码', { exact: true }).inputValue(), ''); assert.equal((await draft(page, control.scope)).data.recognitionRequestId, original.data.recognitionRequestId);
    control.recognitionMode = 'success'; await authorize(page); await consent(page); await recognize.click(); await page.getByRole('region', { name: '图片事项核对预览', exact: true }).waitFor(); await stable(page);
    assert.equal(control.recognitions.length, 2); assert.equal(control.recognitions[0].requestId, control.recognitions[1].requestId); assert.equal(control.recognitions[0].model, control.recognitions[1].model); assert.equal(control.parserCalls.length, 1); assert.equal(control.previews.at(-1).fields.action, 'inspect'); assert.equal(control.commits.length, 0);
    assert.equal(await page.getByLabel('活动日期（未知可留空）', { exact: true }).inputValue(), '2026-10-17'); assert.equal(await page.getByRole('button', { name: '确认保存图片与事项', exact: true }).isDisabled(), true);
    await screenshot(page, 'returned-inspect-preview-320');
    await page.getByRole('button', { name: '关联到已有事项', exact: true }).click(); await page.getByRole('checkbox', { name: /我已逐项核对/ }).check(); await page.getByRole('button', { name: '生成核对预览', exact: true }).click(); await page.getByRole('button', { name: '确认保存图片与事项', exact: true }).waitFor({ state: 'visible' });
    control.receiptUnavailable = true; await page.getByRole('button', { name: '确认保存图片与事项', exact: true }).click(); await page.getByRole('button', { name: '查询保存结果', exact: true }).waitFor(); await stable(page); const savedPending = await draft(page, control.scope); assert.equal(savedPending.imageHash, hash); assert.ok(savedPending.data.pending.operation_id);
    control.receiptUnavailable = false; await page.getByRole('button', { name: '查询保存结果', exact: true }).click(); await page.getByText('图片与事项已保存，并已独立读回验证。', { exact: true }).waitFor(); await stable(page);
    assert.equal(control.commits.length, 1); assert.equal(control.commits[0].changes[0].type, 'update'); assert.equal(control.commits[0].changes[0].id, 'fixture-dinner'); assert.equal(control.state.data.tasks.filter(task => task.id === 'fixture-dinner').length, 1); assert.equal((await draft(page, control.scope)).imageHash, null);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true); noCredentials(await draft(page, control.scope));
    assert.equal(await page.locator('.codex-bridge-panel button,.codex-bridge-panel a,.codex-retention summary').evaluateAll(elements => elements.filter(element => element.getBoundingClientRect().height > 0).every(element => element.getBoundingClientRect().height >= 44)), true);
    checks.push({ noAutomaticLoopbackAccess: true, portalLinkIsIsolated: true, retentionPolicyExplainsBrowserBridgeAndProvider: true, lnaDenialKeepsBlobAndOriginalId: true, codeAndTokenNeverPersisted: true, explicitPerImagePlanConsent: true, refreshRequiresPairAgain: true, reconnectRetriesOriginalIdAndModel: true, parserValidatesCompleteBridgeEnvelope: true, resultReturnsInspectPreviewOnly: true, humanMustChooseAndConfirmWrite: true, existingDinnerUpdatedWithoutDuplicate: true, verifiedReadbackRequiredBeforeDraftClear: true, mobile320NoOverflow: true, mobileBridgeControlsAtLeast44px: true });
  } finally { await main.context.close(); }

  const catalog = await setup(390);
  try {
    const { page, control } = catalog; await selectImage(page); await page.getByRole('button', { name: '手动填写', exact: true }).click(); await page.getByLabel('事项标题', { exact: true }).fill('模型目录不可用也保留此人工字段'); control.models = [];
    await authorize(page); await page.getByText(/当前授权未返回可用模型/).waitFor(); assert.equal(await page.getByLabel('事项标题', { exact: true }).inputValue(), '模型目录不可用也保留此人工字段'); assert.equal(await page.getByRole('button', { name: '用Codex识别并预览', exact: true }).isDisabled(), true);
    control.models = [{ slug: 'fixture-other', display_name: 'Fixture Other' }]; await page.getByRole('button', { name: '加载可用模型', exact: true }).click(); assert.equal(await page.getByLabel('Codex识图模型', { exact: true }).inputValue(), '');
    await page.getByLabel('Codex识图模型', { exact: true }).selectOption('fixture-other'); await consent(page); control.models.push({ slug: 'gpt-6.1-sol', display_name: 'GPT 6.1 Sol' }); await page.getByRole('button', { name: '加载可用模型', exact: true }).click(); await consent(page); await page.getByLabel('Codex识图模型', { exact: true }).selectOption('gpt-6.1-sol'); assert.equal(await page.getByRole('checkbox', { name: /我同意本图原图/ }).isChecked(), false);
    assert.equal(control.recognitions.length, 0); control.recognitionMode = { status: 504, error: 'PLAN_TIMEOUT' }; await consent(page); await page.getByRole('button', { name: '用Codex识别并预览', exact: true }).click(); await page.getByText(/识别等待超时.*PLAN_TIMEOUT/).waitFor(); assert.equal((await page.locator('body').innerText()).includes(fixtureToken), false); await stable(page); noCredentials(await draft(page, control.scope));
    assert.equal(await page.getByText('正在通过本人本机授权识别原图；尚未保存事项。', { exact: true }).count(), 0);
    await screenshot(page, 'explicit-catalog-selection-390'); checks.push({ emptyCatalogPreservesManualFields: true, unavailablePreferredModelDoesNotFallback: true, alternativeModelRequiresExplicitSelection: true, modelChangeResetsPlanConsent: true, safeSpecificTimeoutWithoutProviderMessage: true, failureDoesNotKeepRunningMessage: true });
  } finally { await catalog.context.close(); }

  const mismatch = await setup(1440);
  try {
    const { page, control } = mismatch; await selectImage(page); await stable(page); const original = await draft(page, control.scope); await authorize(page);
    for (const mode of ['wrong-hash', 'wrong-id', 'incomplete']) { control.recognitionMode = mode; await consent(page); await page.getByRole('button', { name: '用Codex识别并预览', exact: true }).click(); await page.getByText(/原图校验或原请求编号不一致/).waitFor(); await stable(page); assert.equal(control.parserCalls.length, 0); assert.equal(control.previews.length, 0); assert.equal(control.commits.length, 0); assert.equal((await draft(page, control.scope)).data.recognitionRequestId, original.data.recognitionRequestId); }
    await page.getByLabel('Codex识图模型', { exact: true }).selectOption('fixture-other'); assert.equal(await page.getByRole('checkbox', { name: /我同意本图原图/ }).isDisabled(), true); await page.getByText(/更换模型前，请明确准备一次新的识别/).waitFor();
    await page.getByRole('button', { name: '准备一次新的Codex识别（将使用额度）', exact: true }).click(); await stable(page); const fresh = await draft(page, control.scope); assert.notEqual(fresh.data.recognitionRequestId, original.data.recognitionRequestId); assert.equal(fresh.imageHash, hash); noCredentials(fresh);
    checks.push({ mismatchedImageRejectedBeforeParser: true, mismatchedRequestRejectedBeforeParser: true, uploadAloneNeverMeansRecognized: true, failureKeepsOriginalRequestId: true, differentModelCannotReuseOriginalRequest: true, explicitNewRecognitionKeepsDraftAndChangesId: true });
  } finally { await mismatch.context.close(); }

  const race = await setup(1440);
  try {
    const { page, control } = race; await selectImage(page); await authorize(page); await consent(page);
    await page.evaluate(() => { window.__holdDigest = true; }); await page.getByRole('button', { name: '用Codex识别并预览', exact: true }).click(); await page.waitForFunction(() => window.__digestHeld === true);
    await page.getByRole('navigation', { name: '主导航', exact: true }).getByRole('button', { name: '项目', exact: true }).click(); await page.locator('.codex-bridge-panel').waitFor({ state: 'detached' });
    await page.evaluate(() => { window.__releaseDigest(); }); await page.waitForFunction(() => window.__digestFinished === true);
    assert.equal(control.recognitions.length, 0); assert.equal(control.parserCalls.length, 0); assert.equal(control.commits.length, 0); checks.push({ unmountBeforeDigestCompletesNeverSendsOldImage: true });
  } finally { await race.context.close(); }

  assert.deepEqual(pageErrors, []); assert.deepEqual(escaped, []);
  const report = { recorded_at: new Date().toISOString(), passed: true, checks, screenshots, pageErrors, escapedRequests: escaped, realProviderCalls: 0, realBridgeRequests: 0, productionRequests: 0 };
  fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ passed: true, scenarios: checks.length, checks: checks.reduce((count, item) => count + Object.values(item).filter(value => value === true).length, 0), screenshots: screenshots.length, realProviderCalls: 0, realBridgeRequests: 0, productionRequests: 0, output: out }));
} catch (error) { fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ recorded_at: new Date().toISOString(), passed: false, error: error.stack || error.message, checks, screenshots, pageErrors, escaped }, null, 2)); throw error; }
finally { await browser.close(); }
