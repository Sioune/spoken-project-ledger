import fs from 'node:fs';
import path from 'node:path';
import { chromium } from '../.sites-runtime/browser-qa/node_modules/playwright-core/index.mjs';

// This proof deliberately uses only fictional records. All write requests are
// aborted before a connection is made; it must never be used to mutate a ledger.
const base = new URL(process.env.QA_BASE || 'http://127.0.0.1:5186').origin;
const out = path.resolve('.sites-runtime/readability-proof');
const fixture = JSON.parse(fs.readFileSync('tests/visual-fixture.json', 'utf8'));
fs.mkdirSync(out, { recursive: true });
const failures = [];
const screenshots = [];
const pageErrors = [];
const blockedWrites = [];
const apiReads = [];
const measurements = [];
const navigation = [];
const dialogReachability = [];
const check = (condition, message, detail) => {
  if (!condition) failures.push({ message, ...(detail === undefined ? {} : { detail }) });
};

async function measure(page, label) {
  const result = await page.evaluate(label => {
    const visible = e => {
      const r = e.getBoundingClientRect(), s = getComputedStyle(e);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden'
        && !e.closest('.sr-only, [hidden]') && parseFloat(s.opacity) > 0;
    };
    const color = value => {
      if (value === 'transparent') return [0, 0, 0, 0];
      const values = value.match(/[\d.]+/g)?.map(Number);
      if (!values) throw new Error(`Unsupported CSS color ${value}`);
      if (value.startsWith('color(srgb')) return [values[0] * 255, values[1] * 255, values[2] * 255, values[3] ?? 1];
      return [values[0], values[1], values[2], values[3] ?? 1];
    };
    const over = (front, back) => {
      const alpha = front[3] + back[3] * (1 - front[3]);
      if (!alpha) return [0, 0, 0, 0];
      return [...front.slice(0, 3).map((n, i) => (n * front[3] + back[i] * back[3] * (1 - front[3])) / alpha), alpha];
    };
    const effectiveBackgrounds = e => {
      const layers = [];
      for (let p = e; p; p = p.parentElement) layers.unshift(p);
      // Checking all gradient stops is conservative and avoids treating a
      // transparent child as white when a colored ancestor shows through it.
      return layers.reduce((backs, p) => {
        const style = getComputedStyle(p);
        const baseColors = backs.map(back => over(color(style.backgroundColor), back));
        const stops = style.backgroundImage.match(/rgba?\([^)]*\)|color\(srgb[^)]*\)/g)?.map(color);
        if (!stops?.length) return baseColors;
        return baseColors.flatMap(back => stops.map(stop => over(stop, back))).slice(0, 32);
      }, [[255, 255, 255, 1]]);
    };
    const luminance = rgba => rgba.slice(0, 3).map(n => n / 255).map(n => n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4)
      .reduce((sum, n, i) => sum + n * [.2126, .7152, .0722][i], 0);
    const ratio = (a, b) => {
      const x = luminance(a), y = luminance(b);
      return (Math.max(x, y) + .05) / (Math.min(x, y) + .05);
    };
    const describe = e => ({ tag: e.tagName.toLowerCase(), className: typeof e.className === 'string' ? e.className : '', text: (e.getAttribute('aria-label') || e.textContent || e.getAttribute('placeholder') || '').trim().replace(/\s+/g, ' ').slice(0, 110) });
    const elements = selector => [...document.querySelectorAll(selector)].filter(visible);
    const fonts = [
      ['body', 16], ['.task-title', 18], ['.next-action', 16], ['.status-badge', 13],
      ['input:not([type="checkbox"]):not([type="radio"]):not([type="file"]), textarea, select', 16],
    ].flatMap(([selector, minimum]) => elements(selector).map(e => ({ ...describe(e), selector, minimum, actual: parseFloat(getComputedStyle(e).fontSize) })));
    const touches = [
      ['.button-primary, .new-task', 48],
      ['.icon-button, .task-check', 44],
      ['.mobile-nav button', 44],
    ].flatMap(([selector, minimum]) => elements(selector).map(e => {
      const r = e.getBoundingClientRect();
      return { ...describe(e), selector, minimum, width: r.width, height: r.height, bothAxes: selector !== '.button-primary, .new-task' };
    }));
    const contrastSelectors = [
      '.page-heading h1', '.modal-head h2', '.task-title', '.next-action', '.status-badge',
      '.button', '.icon-button', '.nav-item', '.mobile-nav button', '.simulation-tag', '.mic-note',
      '.capture-hint', '.date-line', '.page-heading p', '.task-meta button', '.task-foot',
      '.project-card h2', '.project-card p', '.project-card-bottom span', '.project-summary strong',
      '.pending-card h3', '.pending-card p', '.document-top h3', '.document-task', '.version-labels',
      '.document-versions summary', '.version-row p', '.version-row > div > span', '.reference-link',
      '.form-label', '.form-help', '.small-label', '.channel-row strong', '.channel-row p',
      '.channel-card .inline-note', '.data-setting-row strong', '.data-setting-row p', '.data-setting-row > span',
      '.empty-state h3', '.empty-state p', '.detail-next p', '.detail-grid dt', '.detail-grid dd',
      '.detail-section h3', '.muted', '.breadcrumb', '.connection-indicator', '.private-label',
      '.task-detail-status > span', '.form-actions > span', '.modal-head p', '.eyebrow', '.text-button',
      'input:not([type="checkbox"]):not([type="radio"]):not([type="file"]), textarea, select',
    ];
    const contrast = [];
    const seen = new Set();
    const ownText = e => [...e.childNodes].some(node => node.nodeType === Node.TEXT_NODE && node.textContent.trim());
    for (const selector of contrastSelectors) for (const container of elements(selector)) {
      const candidates = [container, ...container.querySelectorAll('*')].filter(e => visible(e) && (ownText(e) || e.matches('input, textarea, select')));
      // Icon-only buttons need their actual inherited icon color checked too.
      if (!candidates.length && container.matches('button') && container.querySelector('svg')) candidates.push(container);
      for (const e of candidates) {
      if (seen.has(e) || e.matches(':disabled') || e.closest('button:disabled')) continue;
      seen.add(e);
      const style = getComputedStyle(e), backgrounds = effectiveBackgrounds(e), foreground = color(style.color);
      let opacity = 1;
      for (let p = e; p; p = p.parentElement) opacity *= parseFloat(getComputedStyle(p).opacity);
      foreground[3] *= opacity;
      const backgroundsWithContrast = backgrounds.map(background => ({ background, ratio: ratio(over(foreground, background), background) }));
      const worst = backgroundsWithContrast.reduce((a, b) => a.ratio < b.ratio ? a : b);
      const backgroundImages = [];
      for (let p = e; p; p = p.parentElement) if (getComputedStyle(p).backgroundImage !== 'none') backgroundImages.push(getComputedStyle(p).backgroundImage);
      contrast.push({ ...describe(e), selector, minimum: e.matches('.page-heading h1') ? 7 : 4.5, actual: worst.ratio, foreground: style.color, background: worst.background.slice(0, 3).map(Math.round), ...(backgroundImages.length ? { backgroundImages } : {}) });
      }
    }
    for (const e of elements('input[placeholder], textarea[placeholder]')) {
      if (e.value) continue;
      const style = getComputedStyle(e, '::placeholder'), foreground = color(style.color), backgrounds = effectiveBackgrounds(e);
      foreground[3] *= parseFloat(style.opacity);
      const worst = backgrounds.map(background => ({ background, ratio: ratio(over(foreground, background), background) })).reduce((a, b) => a.ratio < b.ratio ? a : b);
      contrast.push({ ...describe(e), selector: '::placeholder', minimum: 4.5, actual: worst.ratio, foreground: style.color, background: worst.background.slice(0, 3).map(Math.round) });
    }
    const documentWidth = document.documentElement.scrollWidth;
    const overflowing = elements('main *, dialog *').filter(e => {
      const r = e.getBoundingClientRect();
      return r.right > innerWidth + 1 || r.left < -1;
    }).slice(0, 15).map(describe);
    return { label, viewport: { width: innerWidth, height: innerHeight }, documentWidth, fonts, touches, contrast, overflowing };
  }, label);
  measurements.push(result);
  check(result.documentWidth <= result.viewport.width + 1, `${label}: horizontal page overflow`, { viewport: result.viewport.width, documentWidth: result.documentWidth, elements: result.overflowing });
  for (const item of result.fonts) check(item.actual + .01 >= item.minimum, `${label}: font below minimum`, item);
  for (const item of result.touches) check(item.height + .01 >= item.minimum && (!item.bothAxes || item.width + .01 >= item.minimum), `${label}: touch target below minimum`, item);
  for (const item of result.contrast) check(item.actual + .01 >= item.minimum, `${label}: contrast below minimum`, { ...item, actual: +item.actual.toFixed(2) });
  return result;
}

async function capture(page, label, fullPage = true) {
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); });
  const file = path.join(out, `${label}.png`);
  await page.screenshot({ path: file, fullPage, animations: 'disabled' });
  screenshots.push(path.relative(process.cwd(), file));
  await measure(page, label);
}

async function inViewport(locator) {
  return locator.evaluate(e => {
    const r = e.getBoundingClientRect(), dialog = e.closest('dialog'), clip = dialog?.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.left >= Math.max(0, clip?.left ?? 0) - 1
      && r.right <= Math.min(innerWidth, clip?.right ?? innerWidth) + 1
      && r.top >= Math.max(0, clip?.top ?? 0) - 1
      && r.bottom <= Math.min(innerHeight, clip?.bottom ?? innerHeight) + 1;
  });
}

async function scrollDialogToBottom(dialog) {
  return dialog.evaluate(e => {
    e.scrollTop = e.scrollHeight;
    return { scrollTop: e.scrollTop, clientHeight: e.clientHeight, scrollHeight: e.scrollHeight, atBottom: e.scrollTop + e.clientHeight >= e.scrollHeight - 1 };
  });
}

async function navigate(page, width, tab, label) {
  const names = { today: '今天', projects: '项目', pending: '待确认', files: width < 640 ? '文件' : '成果文件', settings: '设置' };
  if (tab === 'history') {
    if (width < 640) {
      await navigate(page, width, 'settings', `${label}-via-settings`);
      await page.getByRole('button', { name: '查看历史', exact: true }).click();
    } else await page.locator('.sidebar-bottom').getByRole('button', { name: '操作历史', exact: true }).click();
  } else await page.getByRole('navigation', { name: width < 640 ? '手机导航' : '主导航', exact: true }).getByRole('button', { name: new RegExp(`^${names[tab]}(?:\\s*\\d+)?$`) }).click();
  await page.locator('.page-heading h1').waitFor();
  navigation.push({ viewport: width, tab, heading: await page.locator('.page-heading h1').innerText() });
}

const browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true, args: ['--disable-gpu'] });
try {
  for (const { width, height, label } of [{ width: 1440, height: 1100, label: 'desktop' }, { width: 390, height: 844, label: 'mobile' }, { width: 320, height: 740, label: 'mobile-320' }]) {
    const context = await browser.newContext({ viewport: { width, height }, locale: 'zh-CN', deviceScaleFactor: 1, serviceWorkers: 'block' });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    page.on('pageerror', error => pageErrors.push({ viewport: width, message: error.message }));
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (!['GET', 'HEAD'].includes(request.method())) {
        blockedWrites.push({ method: request.method(), path: url.pathname });
        return route.abort('blockedbyclient');
      }
      if (url.origin !== base) return route.abort('blockedbyclient');
      if (url.pathname.startsWith('/api/')) {
        apiReads.push(url.pathname);
        if (url.pathname === '/api/state') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fixture) });
        if (url.pathname === '/api/operations') return route.fulfill({ status: 200, contentType: 'application/json', body: '{"operations":[]}' });
        return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"READ_ONLY_VISUAL_FIXTURE"}' });
      }
      return route.continue();
    });
    try {
      await page.goto(`${base}/`, { waitUntil: 'networkidle' });
      await page.locator('.task-title').first().waitFor();
      check(await page.locator('.task-title').count() > 0, `${label}: fictional tasks are visible`);
      await capture(page, `${label}-today`);
      const firstTaskTitle = await page.locator('.task-title').first().innerText();
      await page.locator('.task-title').first().click();
      const detail = page.getByRole('dialog');
      await detail.waitFor();
      check((await detail.locator('h2').innerText()) === firstTaskTitle, `${label}: task detail preserves task identity`);
      check(await detail.locator('.detail-next p').isVisible(), `${label}: task next action can be read`);
      await capture(page, `${label}-task-detail`);
      const dependencyHeading = detail.getByRole('heading', { name: '前序任务', exact: true });
      await dependencyHeading.scrollIntoViewIfNeeded();
      const dependenciesReachable = await inViewport(dependencyHeading);
      check(dependenciesReachable, `${label}: dependency section is reachable within the dialog viewport`);
      const filesHeading = detail.getByRole('heading', { name: '关联成果', exact: true });
      await filesHeading.scrollIntoViewIfNeeded();
      const filesReachable = await inViewport(filesHeading);
      check(filesReachable, `${label}: associated files section is reachable within the dialog viewport`);
      const detailScroll = await scrollDialogToBottom(detail);
      check(detailScroll.atBottom, `${label}: task detail can scroll to its bottom`, detailScroll);
      dialogReachability.push({ viewport: width, dialog: 'task-detail', dependenciesReachable, filesReachable, ...detailScroll });
      if (width < 640) await capture(page, `${label}-task-detail-bottom`, false);
      await detail.getByRole('button', { name: '编辑任务', exact: true }).click();
      const editor = page.getByRole('dialog', { name: '更新任务', exact: true });
      await editor.waitFor();
      check((await editor.getByLabel('任务名称', { exact: true }).inputValue()) === firstTaskTitle, `${label}: editor retains task title`);
      check(await editor.getByLabel('业务状态').isVisible(), `${label}: business status is editable`);
      check(await editor.getByLabel('核实程度').isVisible(), `${label}: verification state is separate`);
      await capture(page, `${label}-task-editor`);
      const dependencyLegend = editor.locator('.dependency-fieldset legend');
      await dependencyLegend.scrollIntoViewIfNeeded();
      const dependencyEditorReachable = await inViewport(dependencyLegend);
      check(dependencyEditorReachable, `${label}: dependency editor is reachable within the dialog viewport`);
      const editorScroll = await scrollDialogToBottom(editor);
      const saveButton = editor.getByRole('button', { name: '确认保存', exact: true });
      const saveButtonVisible = await inViewport(saveButton);
      check(editorScroll.atBottom, `${label}: task editor can scroll to its bottom`, editorScroll);
      check(saveButtonVisible, `${label}: save button is fully visible at the editor bottom`);
      dialogReachability.push({ viewport: width, dialog: 'task-editor', dependencyEditorReachable, saveButtonVisible, ...editorScroll });
      if (width < 640) await capture(page, `${label}-task-editor-bottom`, false);
      await editor.getByRole('button', { name: '关闭', exact: true }).click();
      await page.getByRole('dialog').waitFor({ state: 'hidden' });

      for (const [name, status] of [['等待别人', 'waiting'], ['已完成', 'done']]) {
        await page.locator('.overview-item').filter({ hasText: name }).click();
        const expected = fixture.data.tasks.filter(task => task.status === status);
        check(await page.locator('.task-title').count() === expected.length, `${label}: ${status} category keeps its own task count`);
        for (const task of expected) check(await page.getByRole('button', { name: task.title, exact: true }).isVisible(), `${label}: ${status} task remains visible`, task.id);
        await capture(page, `${label}-${status}`);
      }
      await page.locator('.overview-item').filter({ hasText: '今天要做' }).click();

      for (const tab of ['projects', 'pending', 'files', 'settings', 'history']) {
        await navigate(page, width, tab, label);
        if (tab === 'projects') check(await page.locator('.project-card').count() === fixture.data.projects.length, `${label}: all fictional projects can be viewed`);
        if (tab === 'pending') check(await page.locator('.pending-card').count() > 0, `${label}: clarification card can be viewed`);
        if (tab === 'files') {
          check(await page.locator('.document-card').count() === fixture.data.documents.length, `${label}: associated document can be viewed`);
          await page.locator('.document-versions summary').first().click();
          const ref = fixture.data.documents[0].versions[0].library_ref;
          check(await page.getByRole('button', { name: ref, exact: true }).isVisible(), `${label}: document version Library reference can be viewed`);
          check(await page.locator('.adopted-tag').first().isVisible(), `${label}: adopted version remains explicit`);
        }
        if (tab === 'settings') {
          check(await page.getByText('待授权', { exact: true }).isVisible(), `${label}: external notifications remain awaiting authorization`);
          check((await page.locator('.form-help').innerText()).includes('网页关闭后无法提醒'), `${label}: closed-page reminder limitation is visible`);
        }
        if (tab === 'history') check(await page.getByRole('heading', { name: '第一条进展，会从这里开始', exact: true }).isVisible(), `${label}: empty isolated audit view can be read`);
        await capture(page, `${label}-${tab}`);
      }
      await navigate(page, width, 'today', label);
      check(await page.locator('.task-title').count() > 0, `${label}: return-to-today navigation works`);
    } catch (error) {
      failures.push({ message: `${label}: browser flow failed`, detail: error.stack || error.message });
      const file = path.join(out, `${label}-failure.png`);
      await page.screenshot({ path: file, fullPage: true }).catch(() => {});
    } finally {
      await context.close();
    }
  }
} finally {
  await browser.close();
}
check(pageErrors.length === 0, 'No browser runtime exceptions', pageErrors);
check(blockedWrites.length === 0, 'Read-only browsing must not attempt any write', blockedWrites);
const report = { ok: failures.length === 0, base, source: 'Actual frontend; entirely fictional API fixture. All non-GET/HEAD requests and cross-origin requests blocked before dispatch. No production data read or written.', requirements: { body: 16, taskTitle: 18, nextAction: 16, status: 13, formInput: 16, primaryHeight: 48, iconTouch: 44, textContrast: 4.5, headingContrast: 7 }, screenshots, navigation, dialogReachability, apiReads: [...new Set(apiReads)], blockedWrites, pageErrors, failures, measurements };
fs.writeFileSync(path.join(out, 'metrics.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ok: report.ok, output: out, viewports: 3, screenshots: screenshots.length, measurements: measurements.length, blockedWrites: blockedWrites.length, pageErrors: pageErrors.length, failureCount: failures.length, failures: failures.slice(0, 24) }));
if (!report.ok) process.exitCode = 1;
