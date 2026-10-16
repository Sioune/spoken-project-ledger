import { PlanError } from './identity.mjs';
import { recognitionSchema, recognitionInstructions, validateRawRecognition } from './contract.mjs';

const ENDPOINT = 'https://api.openai.com/v1/responses';
const MAXIMUM_STREAM = 1048576;
const fail = (status, code, message) => new PlanError(status, code, message);
const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
const diagnosticEvent = value => typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,100}$/.test(value)
  && (value.startsWith('response.') || ['message', 'error', 'ping', 'keepalive'].includes(value)) ? value : 'other';
function contentTypeClass(value) {
  const mime = (value ?? '').split(';', 1)[0].trim().toLowerCase();
  if (!mime) return 'missing';
  if (mime === 'text/event-stream') return 'event-stream';
  if (mime === 'application/json' || mime.endsWith('+json')) return 'json';
  if (mime === 'text/html') return 'html';
  if (mime.startsWith('text/')) return 'text';
  return 'other';
}

function providerError(status, code) {
  if (code === 'subscription_sharing_usage_limit_exceeded' || status === 429) return fail(429, 'PLAN_USAGE_LIMIT', 'ChatGPT计划额度已达上限，请查看ChatGPT用量设置后再试。');
  if (['subscription_sharing_usage_unavailable', 'subscription_sharing_user_unavailable'].includes(code) || status === 503) return fail(503, 'PLAN_TEMPORARY', 'ChatGPT计划可用性暂时无法核对，请保留连接并稍后再试。');
  if (code === 'subscription_sharing_user_not_eligible') return fail(403, 'PLAN_NOT_ELIGIBLE', '当前账号、工作区或地区尚不能使用此计划授权路径，请核对服务资格。');
  if (code === 'subscription_sharing_unsupported_capability') return fail(400, 'PLAN_UNSUPPORTED', '当前授权路径不支持这次请求的能力，请核对模型和请求配置。');
  if (status === 403) return fail(403, 'PLAN_UNAVAILABLE', '当前ChatGPT计划暂不可用于这次识图，请核对授权与可用额度。');
  if (status === 401) return fail(401, 'PLAN_AUTH', 'ChatGPT授权已失效，请在本机重新登录。');
  return fail(502, 'PLAN_RESPONSE', 'ChatGPT识图服务未能完成请求，原图草稿仍保留。');
}
function imageValid(bytes, mime) {
  const buffer = Buffer.from(bytes);
  if (mime === 'image/png') return buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (mime === 'image/jpeg') return buffer.length >= 3 && buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255;
  if (mime === 'image/webp') return buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP';
  return false;
}
const toolType = type => typeof type === 'string' && /(?:function_call|custom_tool|tool_call|web_search|file_search|computer_call|shell_call|mcp_call|code_interpreter|image_generation_call|tool_search|apply_patch_call)/i.test(type);
function inspectItem(item) {
  if (!object(item) || toolType(item.type) || !['message', 'reasoning'].includes(item.type)) throw fail(502, 'PLAN_TOOL_CALL', '识图返回了不允许的工具或执行请求，已拒绝处理。');
  if (item.type === 'message') {
    if (item.role !== undefined && item.role !== 'assistant') throw fail(502, 'PLAN_RESPONSE', '识图响应角色无效。');
    if (item.content !== undefined && (!Array.isArray(item.content) || item.content.some(part => !object(part) || part.type !== 'output_text' || typeof part.text !== 'string'))) throw fail(502, 'PLAN_REFUSAL', 'ChatGPT未提供可用的识图结果，原图草稿仍保留。');
  }
}
function completedResult(response) {
  if (!object(response) || response.status !== 'completed' || !Array.isArray(response.output)) throw fail(502, 'PLAN_INCOMPLETE', '识图未完整完成，不能使用部分结果。');
  const messages = [];
  for (const item of response.output) { inspectItem(item); if (item.type === 'message') messages.push(item); }
  if (messages.length !== 1 || messages[0].status !== undefined && messages[0].status !== 'completed') throw fail(502, 'PLAN_RESPONSE', '识图结果不完整或存在歧义，请重新核对。');
  const text = (messages[0].content ?? []).map(part => part.text).join('');
  if (!text || Buffer.byteLength(text) > 65536) throw fail(502, 'PLAN_RESPONSE_SIZE', '识图结果为空或过大，已停止处理。');
  let result;
  try { result = JSON.parse(text); } catch { throw fail(502, 'PLAN_JSON', '识图结果不是有效JSON，原图草稿仍保留。'); }
  try { return validateRawRecognition(result); } catch { throw fail(502, 'PLAN_SCHEMA', '识图结果不符合允许的字段结构，原图草稿仍保留。'); }
}

export async function recognizeWithPlan({ identity, bytes, mime_type, note = '', projects = [], model } = {}, { fetchImpl = globalThis.fetch, timeoutMs = 120000, signal, onDiagnostic } = {}) {
  if (!(bytes instanceof Uint8Array) || !bytes.byteLength || bytes.byteLength > 1500000) throw fail(413, 'IMAGE_SIZE', '原图大小须在1,500,000字节以内。');
  if (!imageValid(bytes, mime_type)) throw fail(415, 'IMAGE_TYPE', '只支持真实的PNG、JPEG或WebP原图。');
  if (typeof note !== 'string' || note.length > 5000 || !Array.isArray(projects) || projects.length > 1000 || projects.some(project => !object(project) || typeof project.name !== 'string' || !project.name.trim() || project.name.length > 300) || typeof model !== 'string' || !model || model.length > 200) throw fail(400, 'RECOGNITION_INPUT', '识图说明、项目名称或模型选择无效。');
  if (!identity || typeof identity.models !== 'function' || typeof identity.accessToken !== 'function' || typeof identity.status !== 'function') throw fail(401, 'OAUTH_REQUIRED', '请先完成本机ChatGPT授权。');
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw fail(400, 'TIMEOUT_CONFIG', '识图超时设置无效。');
  if (signal && (typeof signal.aborted !== 'boolean' || typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function')) throw fail(400, 'ABORT_CONFIG', '本机识图取消设置无效。');
  const cancelled = () => fail(499, 'PLAN_CANCELLED', '本机已停止这次识图，请保留原图与原编号核对结果。');
  if (signal?.aborted) throw cancelled();
  const controller = new AbortController(); let timer, reader; let timedOut = false;
  let onAbort;
  const externalAbort = new Promise((_, reject) => {
    if (signal) { onAbort = () => { controller.abort(); reject(cancelled()); }; signal.addEventListener('abort', onAbort, { once: true }); }
  });
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => { timedOut = true; controller.abort(); reject(fail(504, 'PLAN_TIMEOUT', '识图等待超时，原图草稿已保留；请先核对原识别编号的状态。')); }, timeoutMs); });
  const initialAccount = identity.status().account_key;
  try {
    return await Promise.race([timeout, externalAbort, (async () => {
      const catalog = await identity.models();
      if (controller.signal.aborted) throw cancelled();
      if (!Array.isArray(catalog) || !catalog.some(item => item?.slug === model)) throw fail(400, 'MODEL_UNAVAILABLE', '所选模型不在当前ChatGPT账号的可用列表中，请重新选择。');
      const token = await identity.accessToken();
      if (controller.signal.aborted) throw cancelled();
      if (!initialAccount || identity.status().account_key !== initialAccount) throw fail(409, 'OAUTH_SUPERSEDED', 'ChatGPT账号连接已更换，请重新预览。');
      const response = await fetchImpl(ENDPOINT, { method: 'POST', redirect: 'error', signal: controller.signal, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' }, body: JSON.stringify({ model, instructions: recognitionInstructions, input: [{ role: 'user', content: [{ type: 'input_text', text: JSON.stringify({ note, project_names: projects.map(project => project.name) }) }, { type: 'input_image', image_url: `data:${mime_type};base64,${Buffer.from(bytes).toString('base64')}`, detail: 'high' }] }], tools: [], text: { format: { type: 'json_schema', name: 'project_ledger_image_intake', strict: true, schema: recognitionSchema } }, store: false, stream: true }) });
      if (!response.ok) { try { await response.body?.cancel(); } catch { /* Do not read sensitive provider diagnostics. */ } throw providerError(response.status); }
      const contentType = contentTypeClass(response.headers.get('content-type'));
      function diagnostic(stage, dataLength = 0, eventName, eventType, parsedEvents) {
        if (typeof onDiagnostic !== 'function') return;
        const metadata = Object.freeze({ stage, http_status: response.status, content_type: contentType,
          data_length: dataLength, event_name: diagnosticEvent(eventName), event_type: diagnosticEvent(eventType),
          ...(stage === 'eof' ? { parsed_events: parsedEvents } : {}) });
        // Logging is opt-in. A diagnostic consumer cannot change recognition behavior.
        try { void Promise.resolve(onDiagnostic(metadata)).catch(() => {}); } catch { /* No raw errors are logged. */ }
      }
      // The plan route can omit Content-Type; its body must still pass every SSE check.
      if (!response.body || !['event-stream', 'missing'].includes(contentType)) {
        diagnostic('http');
        throw fail(502, 'PLAN_STREAM_TYPE', '识图服务未返回可读取的SSE流式响应，原图草稿仍保留。');
      }
      if (Number(response.headers.get('content-length')) > MAXIMUM_STREAM) throw fail(502, 'PLAN_RESPONSE_SIZE', '识图响应过大，已停止处理。');
      reader = response.body.getReader(); const decoder = new TextDecoder('utf-8', { fatal: true }); let buffer = '', dataLines = [], eventName = '', size = 0, parsedEvents = 0;
      function dispatch() {
        if (!dataLines.length) { eventName = ''; return null; }
        const data = dataLines.join('\n'); dataLines = []; const name = eventName; eventName = '';
        if (data === '[DONE]') throw fail(502, 'PLAN_INCOMPLETE', '识图连接已结束，但尚未确认完成。');
        let event;
        try { event = JSON.parse(data); } catch {
          diagnostic('json', Buffer.byteLength(data), name);
          throw fail(502, 'PLAN_STREAM_JSON', '识图SSE事件不是有效JSON，原图草稿仍保留。');
        }
        if (!object(event) || typeof event.type !== 'string' || name && name !== 'message' && name !== event.type) {
          diagnostic('event', Buffer.byteLength(data), name, object(event) ? event.type : undefined);
          throw fail(502, 'PLAN_STREAM_EVENT', '识图SSE事件结构或事件名称不匹配，原图草稿仍保留。');
        }
        parsedEvents++;
        if (toolType(event.type) || event.type.includes('refusal')) throw fail(502, 'PLAN_TOOL_CALL', '识图返回了工具请求或拒绝响应，已停止处理。');
        if (event.item !== undefined) inspectItem(event.item);
        if (event.part !== undefined && (!object(event.part) || !['output_text', 'reasoning_text', 'summary_text'].includes(event.part.type))) throw fail(502, 'PLAN_REFUSAL', 'ChatGPT没有提供可用识图内容。');
        if (event.type === 'response.failed' || event.type === 'error') throw providerError(0, event.response?.error?.code ?? event.code ?? event.error?.code);
        if (event.type === 'response.incomplete') throw fail(502, 'PLAN_INCOMPLETE', '识图未完整完成，不能使用部分结果。');
        return event.type === 'response.completed' ? { result: completedResult(event.response) } : null;
      }
      function line(value) {
        if (!value) return dispatch();
        if (value.startsWith(':')) return null;
        const colon = value.indexOf(':'); const field = colon < 0 ? value : value.slice(0, colon); let content = colon < 0 ? '' : value.slice(colon + 1);
        if (content.startsWith(' ')) content = content.slice(1);
        if (field === 'data') dataLines.push(content); else if (field === 'event') eventName = content;
        return null;
      }
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAXIMUM_STREAM) throw fail(502, 'PLAN_RESPONSE_SIZE', '识图响应过大，已停止处理。');
        buffer += decoder.decode(value, { stream: true });
        while (true) {
          const match = /\r\n|\n|\r/.exec(buffer); if (!match || match[0] === '\r' && match.index === buffer.length - 1) break;
          const result = line(buffer.slice(0, match.index)); buffer = buffer.slice(match.index + match[0].length);
          if (result) { if (identity.status().account_key !== initialAccount) throw fail(409, 'OAUTH_SUPERSEDED', 'ChatGPT账号已更换，旧结果不会填入当前草稿。'); return result.result; }
        }
      }
      decoder.decode();
      // An unterminated event is a truncated stream, even if its text resembles JSON.
      diagnostic('eof', size, undefined, undefined, parsedEvents);
      throw fail(502, 'PLAN_INCOMPLETE', '识图连接中断或缺少完成确认，部分结果不会填入草稿。');
    })()]);
  } catch (error) {
    if (timedOut) throw fail(504, 'PLAN_TIMEOUT', '识图等待超时，原图草稿已保留；请先核对原识别编号的状态。');
    if (error instanceof PlanError) throw error;
    throw fail(503, 'PLAN_NETWORK', '识图连接中断，请保留原编号并检查网络，不会使用部分结果。');
  } finally {
    clearTimeout(timer); controller.abort();
    if (onAbort) signal.removeEventListener('abort', onAbort);
    if (reader) { void reader.cancel().catch(() => {}); }
  }
}
