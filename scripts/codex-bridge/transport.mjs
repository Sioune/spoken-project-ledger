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
const knownCodes = new Set(['subscription_sharing_usage_limit_exceeded', 'subscription_sharing_usage_unavailable', 'subscription_sharing_user_unavailable',
  'subscription_sharing_user_not_eligible', 'subscription_sharing_unsupported_capability', 'subscription_sharing_route_not_supported',
  'subscription_sharing_invalid_user', 'chatpass_v2_scope_not_authorized', 'chatpass_v2_invalid_authorization_context',
  'invalid_request_error', 'invalid_json_schema', 'unsupported_parameter', 'model_not_found', 'invalid_value', 'invalid_image',
  'unsupported_content_type', 'server_error', 'rate_limit_exceeded']);
const knownTypes = new Set(['invalid_request_error', 'authentication_error', 'permission_error', 'not_found_error', 'rate_limit_error', 'server_error', 'api_error', 'error']);
const knownParams = new Set(['input', 'input[0].content', 'input[0].content[1]', 'input[0].content[1].image_url', 'model',
  'text.format', 'text.format.schema', 'tools', 'store', 'stream', 'instructions']);
const classified = (value, allowlist) => value === null || value === undefined ? 'unknown' : allowlist.has(value) ? value : 'other';
const statusClass = value => classified(value, new Set(['completed', 'in_progress', 'incomplete', 'failed', 'cancelled', 'queued']));
const roleClass = value => classified(value, new Set(['assistant', 'user', 'system', 'developer', 'tool']));
function providerDetails(value, fallback = 'other') {
  let error, shape = fallback;
  if (object(value?.response?.error)) { error = value.response.error; shape = 'response_error'; }
  else if (object(value?.error)) { error = value.error; shape = 'error_object'; }
  else if (object(value) && (Object.hasOwn(value, 'code') || value.type === 'error')) { error = value; shape = 'top_level_error'; }
  else if (object(value) && typeof value.detail === 'string') shape = 'detail';
  return { error_shape: shape, provider_code: classified(error?.code, knownCodes),
    provider_type: classified(error?.type, knownTypes), provider_param: classified(error?.param, knownParams) };
}

function providerError(status, code, source = 'http') {
  if (code === 'subscription_sharing_usage_limit_exceeded' || status === 429) return fail(429, 'PLAN_USAGE_LIMIT', 'ChatGPT计划额度已达上限，请查看ChatGPT用量设置后再试。');
  if (['subscription_sharing_usage_unavailable', 'subscription_sharing_user_unavailable'].includes(code) || status === 503) return fail(503, 'PLAN_TEMPORARY', 'ChatGPT计划可用性暂时无法核对，请保留连接并稍后再试。');
  if (code === 'subscription_sharing_user_not_eligible') return fail(403, 'PLAN_NOT_ELIGIBLE', '当前账号、工作区或地区尚不能使用此计划授权路径，请核对服务资格。');
  if (code === 'subscription_sharing_unsupported_capability') return fail(400, 'PLAN_UNSUPPORTED', '当前授权路径不支持这次请求的能力，请核对模型和请求配置。');
  if (code === 'subscription_sharing_route_not_supported') return fail(403, 'PLAN_ROUTE', '当前ChatGPT授权路径不支持此接口，请核对本机请求配置。');
  if (code === 'subscription_sharing_invalid_user') return fail(401, 'PLAN_AUTH', 'ChatGPT账号授权上下文无法核验，请检查本机登录。');
  if (['chatpass_v2_scope_not_authorized', 'chatpass_v2_invalid_authorization_context'].includes(code)) return fail(403, 'PLAN_PERMISSION', '当前ChatGPT授权范围不允许此次识图，请核对应用授权。');
  if (status === 403) return fail(403, 'PLAN_UNAVAILABLE', '当前ChatGPT计划暂不可用于这次识图，请核对授权与可用额度。');
  if (status === 401) return fail(401, 'PLAN_AUTH', 'ChatGPT授权已失效，请在本机重新登录。');
  return fail(source === 'http' && status >= 400 && status <= 599 ? status : 502,
    source === 'http' ? 'PLAN_HTTP_ERROR' : 'PLAN_PROVIDER_ERROR', 'ChatGPT识图服务未能完成请求，原图草稿仍保留。');
}
function imageValid(bytes, mime) {
  const buffer = Buffer.from(bytes);
  if (mime === 'image/png') return buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (mime === 'image/jpeg') return buffer.length >= 3 && buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255;
  if (mime === 'image/webp') return buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP';
  return false;
}
const toolType = type => typeof type === 'string' && /(?:function_call|custom_tool|tool_call|web_search|file_search|computer_call|shell_call|mcp_call|code_interpreter|image_generation_call|tool_search|apply_patch_call)/i.test(type);
function inspectItem(item, reportShape) {
  if (!object(item) || toolType(item.type) || !['message', 'reasoning'].includes(item.type)) throw fail(502, 'PLAN_TOOL_CALL', '识图返回了不允许的工具或执行请求，已拒绝处理。');
  if (item.type === 'message') {
    if (item.role !== undefined && item.role !== 'assistant') {
      reportShape?.('role', item);
      throw fail(502, 'PLAN_MESSAGE_ROLE', '识图响应角色无效，未采用结果。');
    }
    if (item.content !== undefined && (!Array.isArray(item.content) || item.content.some(part => !object(part) || part.type !== 'output_text' || typeof part.text !== 'string'))) throw fail(502, 'PLAN_REFUSAL', 'ChatGPT未提供可用的识图结果，原图草稿仍保留。');
  }
}
function completedResult(response, diagnostic) {
  const output = object(response) && Array.isArray(response.output) ? response.output : [];
  const messages = output.filter(item => object(item) && item.type === 'message');
  const report = (reason, item) => diagnostic?.({ shape_reason: reason, response_status: statusClass(response?.status),
    output_items: output.length, message_count: messages.length, message_role: roleClass(item?.role), message_status: statusClass(item?.status),
    commentary_messages: messages.filter(message => message.phase === 'commentary').length,
    final_answer_messages: messages.filter(message => message.phase === 'final_answer').length });
  if (!object(response) || response.status !== 'completed' || !Array.isArray(response.output)) {
    report('response_status'); throw fail(502, 'PLAN_INCOMPLETE', '识图未完整完成，不能使用部分结果。');
  }
  for (const item of output) inspectItem(item, report);
  if (messages.length !== 1) { report('message_count'); throw fail(502, 'PLAN_MESSAGE_COUNT', '识图完成结果的消息数量存在歧义，未采用结果。'); }
  if (messages[0].status !== undefined && messages[0].status !== 'completed') { report('message_status', messages[0]); throw fail(502, 'PLAN_MESSAGE_STATUS', '识图消息尚未完整完成，未采用结果。'); }
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
      const contentType = contentTypeClass(response.headers.get('content-type'));
      function diagnostic(stage, dataLength = 0, eventName, eventType, parsedEvents, extra = {}) {
        if (typeof onDiagnostic !== 'function') return;
        const metadata = Object.freeze({ stage, http_status: response.status, content_type: contentType,
          data_length: dataLength, event_name: diagnosticEvent(eventName), event_type: diagnosticEvent(eventType),
          ...(stage === 'eof' ? { parsed_events: parsedEvents } : {}), ...extra });
        // Logging is opt-in. A diagnostic consumer cannot change recognition behavior.
        try { void Promise.resolve(onDiagnostic(metadata)).catch(() => {}); } catch { /* No raw errors are logged. */ }
      }
      if (!response.ok) {
        let value, errorShape = 'empty', errorSize = 0;
        if (response.body) {
          reader = response.body.getReader(); const chunks = [];
          try {
            while (true) {
              const part = await reader.read(); if (part.done) break;
              errorSize += part.value.byteLength;
              if (errorSize > 65536) { errorShape = 'too_large'; break; }
              chunks.push(part.value);
            }
            if (errorShape !== 'too_large' && errorSize) {
              try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); errorShape = 'other'; }
              catch { errorShape = 'not_json'; }
            }
          } catch { errorShape = 'read_error'; }
          void reader.cancel().catch(() => {});
        }
        if (controller.signal.aborted) throw cancelled();
        const details = providerDetails(value, errorShape);
        diagnostic('http_error', errorSize, undefined, undefined, undefined, details);
        const error = providerError(response.status, details.provider_code);
        // The safe local classification must not replace the real admission status.
        error.status = response.status;
        throw error;
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
        if (event.item !== undefined) inspectItem(event.item, (reason, item) => diagnostic('message_shape', Buffer.byteLength(data), name, event.type, undefined,
          { shape_reason: reason, message_role: roleClass(item.role), message_status: statusClass(item.status), message_count: 1 }));
        if (event.part !== undefined && (!object(event.part) || !['output_text', 'reasoning_text', 'summary_text'].includes(event.part.type))) throw fail(502, 'PLAN_REFUSAL', 'ChatGPT没有提供可用识图内容。');
        if (event.type === 'response.failed' || event.type === 'error') {
          const details = providerDetails(event);
          diagnostic('provider_error', Buffer.byteLength(data), name, event.type, undefined, details);
          throw providerError(0, details.provider_code, 'sse');
        }
        if (event.type === 'response.incomplete') throw fail(502, 'PLAN_INCOMPLETE', '识图未完整完成，不能使用部分结果。');
        return event.type === 'response.completed' ? { result: completedResult(event.response,
          details => diagnostic('completed_shape', Buffer.byteLength(data), name, event.type, undefined, details)) } : null;
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
