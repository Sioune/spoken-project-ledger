import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { chromium } from '../.sites-runtime/browser-qa/node_modules/playwright-core/index.mjs';
import { base } from './local-base.mjs';

// Only the local frontend is requested. Every API response comes from a
// fictional fixture; preview runs in memory and no ledger writes are sent.
const out = path.resolve('.sites-runtime/settings-preview-proof');
const compiled = ts.transpileModule(fs.readFileSync('lib/model.ts', 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;
const { preview } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
const visual = JSON.parse(fs.readFileSync('tests/visual-fixture.json', 'utf8'));
const oldIds = ['t-teaser-edit', 't-teaser-send', 't-teaser-feedback'];
const pageErrors = [], blockedWrites = [], previews = [], screenshots = [], checks = {};
const ambiguousText = 'teaser 已经更新并发给宋晔了，现在等他反馈。';
fs.mkdirSync(out, { recursive: true });

function restPreview(body, state) {
  const result = preview(body.text, state.data, state.revision, body.source_event_id, body.occurred_at);
  // Match action('preview') in lib/api.ts: new clarification questions become
  // proposed pending records, while already-open questions are not duplicated.
  for (const question of result.questions) {
    if (!state.data.pending.some(item => item.question === question && item.status === 'open')) {
      result.changes.push({ type: 'pending', id: crypto.randomUUID(), values: { question, context: body.text } });
    }
  }
  return result;
}

function task(id, title, status, extra = {}) {
  return {
    id, project_id: 'p-teaser', title, status, next_action: '仅用于隔离界面验收。',
    dependencies: [], version: 1, updated_at: '2026-10-16T01:00:00Z',
    completed_at: null, verification_state: 'user_reported',
    source_ref: '完全虚构的界面验收数据，不是生产状态', ...extra,
  };
}

function fixture(kind) {
  const state = structuredClone(visual);
  state.identity = { displayName: '隔离界面验收' };
  state.data.projects.push({ id: 'p-teaser', name: 'teaser', goal: '核对不同轮次的步骤', status: 'active', completion_rule: '逐步核实', external_links: [], version: 1 });
  state.data.tasks.push(
    task('t-teaser-edit', '旧一轮更新 teaser', 'done'),
    task('t-teaser-send', '旧一轮发送 teaser 给宋晔', 'done', { dependencies: ['t-teaser-edit'] }),
    task('t-teaser-feedback', '旧一轮等待 teaser 反馈', 'waiting', { dependencies: ['t-teaser-send'], waiting_for: '宋晔', expected_result: '旧一轮反馈' }),
  );
  if (kind === 'chain') {
    state.data.tasks.push(
      task('ui-round2-edit', '10月16日 teaser 第2轮更新', 'todo'),
      task('ui-round2-send', '10月16日 teaser 第2轮发送给宋晔', 'blocked', { dependencies: ['ui-round2-edit'] }),
      task('ui-round2-feedback', '10月16日 teaser 第2轮等待反馈', 'blocked', { dependencies: ['ui-round2-send'], waiting_for: '宋晔', expected_result: '第2轮反馈' }),
    );
  } else {
    state.data.tasks.push(task('ui-combined-round', '10月16日 teaser 新一轮修订及同步宋晔', 'todo'));
    if (kind === 'ambiguous') state.data.tasks.push(task('ui-another-round', '10月17日 teaser 新一轮修订及同步宋晔', 'todo'));
  }
  return state;
}

const browser = await chromium.launch({
  executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  headless: true, args: ['--disable-gpu'],
});

async function withPage(state, width, run) {
  const context = await browser.newContext({ viewport: { width, height: width < 500 ? 844 : 1000 }, locale: 'zh-CN', serviceWorkers: 'block' });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => pageErrors.push(error.message));
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== base) return route.abort('blockedbyclient');
    if (url.pathname === '/api/preview' && request.method() === 'POST') {
      const body = request.postDataJSON(), before = JSON.stringify(state);
      try {
        const result = restPreview(body, state);
        assert.equal(JSON.stringify(state), before, 'Preview must not mutate the fixture');
        previews.push({ text: body.text, result });
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(result) });
      } catch (error) {
        return route.fulfill({ status: error.status || 500, contentType: 'application/json', body: JSON.stringify({ error: error.code || 'FIXTURE_PREVIEW', message: error.message }) });
      }
    }
    if (!['GET', 'HEAD'].includes(request.method())) {
      blockedWrites.push({ method: request.method(), path: url.pathname });
      return route.abort('blockedbyclient');
    }
    if (url.pathname === '/api/state') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(state) });
    if (url.pathname === '/api/operations') return route.fulfill({ status: 200, contentType: 'application/json', body: '{"operations":[]}' });
    if (url.pathname.startsWith('/api/')) return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"ISOLATED_UI_FIXTURE"}' });
    return route.continue();
  });
  try {
    await page.goto(base, { waitUntil: 'networkidle' });
    await page.getByRole('heading', { name: '今天，推进一件件。' }).waitFor();
    await run(page);
  } finally {
    await context.close();
  }
}

async function capture(page, name) {
  const filename = `${name}.png`;
  await page.screenshot({ path: path.join(out, filename), fullPage: true });
  screenshots.push(filename);
}

async function parse(page, text) {
  await page.locator('#spoken-input').fill(text);
  const response = page.waitForResponse(r => r.url() === `${base}/api/preview` && r.request().method() === 'POST');
  await page.getByRole('button', { name: '预览变更', exact: true }).click();
  const result = await (await response).json();
  await page.locator('.preview-panel').waitFor();
  assert.equal(await page.locator('.change-item').count(), result.changes.length);
  assert.equal(await page.locator('.preview-questions p').count(), result.questions.length);
  assert.equal(result.changes.some(change => oldIds.includes(change.id)), false, 'The new-round preview must not update historical tasks');
  return result;
}

async function assertConservative(page, result, existingQuestion = false) {
  assert.ok(result.questions.length > 0);
  assert.equal(result.changes.some(change => change.type !== 'pending'), false, 'Unclear facts may only propose clarification records');
  if (existingQuestion) {
    assert.equal(result.changes.length, 0);
    await page.getByText('尚未生成可保存变更，请先核对待确认内容。', { exact: true }).waitFor();
    assert.equal(await page.locator('.preview-footer .button-primary').isDisabled(), true);
  } else {
    assert.ok(result.changes.length > 0, 'New questions should remain available for explicit saving as pending records');
    assert.equal(await page.locator('.preview-footer .button-primary').isDisabled(), false);
    await page.getByRole('button', { name: '确认保存明确部分', exact: true }).waitFor();
  }
}

try {
  for (const width of [1440, 390]) {
    await withPage(fixture('combined'), width, async page => {
      const example = await page.locator('#spoken-input').getAttribute('placeholder');
      assert.ok(example.includes('宋晔'));
      assert.equal(/松叶|宋业/.test(example), false);
      const nav = width < 500 ? page.getByRole('navigation', { name: '手机导航' }) : page.getByRole('navigation', { name: '主导航' });
      await nav.getByRole('button', { name: '设置', exact: true }).click();
      const options = await page.getByLabel('整点提醒节奏').locator('option').evaluateAll(items => items.map(item => ({ value: item.value, text: item.textContent.trim() })));
      assert.deepEqual(options, [{ value: '2', text: '每 2 小时整点' }]);
      assert.ok((await page.locator('.form-help').innerText()).includes('网页关闭后无法提醒'));
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      checks[`settingsOnlyTwoHoursAndSongYeExample${width}`] = true;
      await capture(page, `settings-${width}`);
    });
  }

  await withPage(fixture('combined'), 1440, async page => {
    const result = await parse(page, '10月16日 teaser 新一轮修订及同步宋晔已经完成，现在等待反馈。');
    await assertConservative(page, result);
    checks.compoundRoundRequiresClarification = true;
    await capture(page, 'combined-round-conservative');
  });

  await withPage(fixture('chain'), 1440, async page => {
    const result = await parse(page, '10月16日 teaser 第2轮已经更新并发给宋晔了，等待反馈。');
    assert.ok(result.changes.some(change => change.id === 'ui-round2-edit' && change.values.status === 'done'));
    assert.ok(result.changes.some(change => change.id === 'ui-round2-send' && change.values.status === 'done'));
    assert.ok(result.changes.some(change => change.id === 'ui-round2-feedback' && change.values.status === 'waiting'));
    assert.equal(result.changes.some(change => change.type === 'create'), false, 'Existing steps must not be duplicated');
    assert.equal(await page.locator('.preview-footer .button-primary').isDisabled(), false);
    await page.locator('.change-item strong').filter({ hasText: '10月16日 teaser 第2轮更新' }).waitFor();
    checks.explicitNewRoundUpdatesOnlyItsSteps = true;
    await capture(page, 'explicit-new-round');
  });

  await withPage(fixture('ambiguous'), 390, async page => {
    const result = await parse(page, ambiguousText);
    await assertConservative(page, result);
    checks.ambiguousRoundsOnlyProposePendingQuestions = true;
    await capture(page, 'ambiguous-rounds-mobile');
  });

  const knownQuestionState = fixture('ambiguous');
  const knownQuestions = preview(ambiguousText, knownQuestionState.data, knownQuestionState.revision, 'ui-known-question', new Date().toISOString()).questions;
  assert.ok(knownQuestions.length > 0);
  knownQuestionState.data.pending.push(...knownQuestions.map((question, index) => ({ id: `ui-known-question-${index}`, question, context: ambiguousText, status: 'open' })));
  await withPage(knownQuestionState, 390, async page => {
    const result = await parse(page, ambiguousText);
    await assertConservative(page, result, true);
    checks.existingQuestionsAreNotDuplicatedAndDisableSaving = true;
    await capture(page, 'existing-questions-mobile');
  });

  assert.deepEqual(pageErrors, []);
  assert.deepEqual(blockedWrites, []);
  checks.noPageErrors = true;
  checks.noLedgerWriteAttempted = true;
  const report = { recorded_at: new Date().toISOString(), base, source: 'Local frontend plus fictional API fixtures and real model preview in memory', checks, previews, screenshots, pageErrors, blockedWrites, ledgerWritesSent: 0, productionRequests: 0 };
  fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ checks, screenshots: screenshots.length, previewCases: previews.length, ledgerWritesSent: 0, productionRequests: 0, output: out }));
} finally {
  await browser.close();
}
