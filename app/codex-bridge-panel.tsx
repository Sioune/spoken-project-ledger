"use client";

import { useEffect, useRef, useState } from "react";
import { ExternalLink, Link2, LoaderCircle, RefreshCw, Unplug } from "lucide-react";
import "./codex-bridge-panel.css";

const BRIDGE = "http://127.0.0.1:5197";
type BridgeStatus = { connected: boolean; plan_authorized: boolean; account_label: string; account_key: string; quota: { day: string; used: number; max: number }; bridge_id: string };
type BridgeModel = { slug: string; display_name: string };
export type CodexBridgeResult = { result: unknown; model: string; request_id: string; image_sha256: string; provider: "codex-local-plan"; completed: true; cached?: boolean };
export type CodexBridgeInput = { image: File; note: string; projects: { id: string; name: string }[]; requestId: string };
type Props = { scope: string | null; disabled: boolean; imageReady: boolean; requestId: string; requestModel: string | null; onRecognize: (model: string, invoke: (input: CodexBridgeInput) => Promise<CodexBridgeResult>) => Promise<void>; onNewRequest: () => void };

class BridgeError extends Error { constructor(public status: number, public code: string) { super("本机识图请求未完成，请查看本机连接面板的核对提示"); } }
async function bridgeJSON<T>(path: string, token: string, body?: FormData | object): Promise<T> {
  const controller = new AbortController(), timeout = window.setTimeout(() => controller.abort(), path === "/recognize" ? 180000 : 12000);
  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
  if (body && !(body instanceof FormData)) headers["Content-Type"] = "application/json";
  try {
    const response = await fetch(`${BRIDGE}${path}`, { method: body ? "POST" : "GET", headers, body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined, credentials: "omit", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer", signal: controller.signal });
    const value: unknown = await response.json().catch(() => ({}));
    if (!response.ok) throw new BridgeError(response.status, value && typeof value === "object" && "error" in value ? String(value.error) : "BRIDGE_REQUEST");
    return value as T;
  } finally { window.clearTimeout(timeout); }
}

function bridgeMessage(cause: unknown) {
  if (cause instanceof BridgeError) {
    const messages: Record<string, string> = {
      PLAN_TIMEOUT: "识别等待超时。本机可能已使用额度；请保留原编号核对，重试原号不会自动发起第二次识别。",
      CODEX_TIMEOUT: "识别等待超时。本机可能已使用额度；请保留原编号核对。",
      PLAN_INCOMPLETE: "识别没有完整完成，部分结果不会填入字段。原图和原编号已保留。",
      CODEX_INCOMPLETE: "识别没有完整完成，不能把上传或部分结果视为识别成功。",
      PLAN_REFUSAL: "模型没有提供可用识别内容。可保留原图手动填写；没有保存事项。",
      CODEX_REFUSED: "模型拒绝了本次识别。可保留原图手动填写；没有保存事项。",
      PLAN_TOOL_CALL: "识别返回了不允许的工具或执行请求，已拒绝采用。可手动填写并核对。",
      PLAN_JSON: "识别结果格式无效，没有采用内容。原图和人工字段仍保留。",
      PLAN_SCHEMA: "识别结果不符合允许的事项字段，没有采用内容。原图和人工字段仍保留。",
      PLAN_STREAM: "识别数据流格式异常或中断，没有采用部分内容。请按原编号核对。",
      PLAN_STREAM_TYPE: "识别服务未返回所需的数据流类型，没有采用内容。原图与原编号已保留。",
      PLAN_STREAM_JSON: "识别数据流中的事件格式无效，没有采用部分内容。原图与原编号已保留。",
      PLAN_STREAM_EVENT: "识别数据流中的事件类型无法核对，没有采用部分内容。原图与原编号已保留。",
      PLAN_RESPONSE: "计划服务没有返回可核对的识别结果。原图保留，可按原编号核对或手动填写。",
      PLAN_RESPONSE_SIZE: "识别结果为空或超出允许大小，已停止采用。原图与草稿仍保留。",
      CODEX_INVALID_RESPONSE: "识别结构或证据无效，没有采用结果。原图和草稿仍保留。",
      INVALID_RECOGNITION: "本机返回的识别结构无效或过大，没有采用结果。",
      PLAN_NETWORK: "本机到识别服务的网络连接中断。请保留原编号核对，不会自动重发。",
      PLAN_TEMPORARY: "ChatGPT计划可用性暂时无法核对。请保留连接与原编号，稍后再核对。",
      PLAN_NOT_ELIGIBLE: "当前账号、工作区或地区尚不能使用此计划授权路径，请在本机授权页核对服务资格。",
      PLAN_UNSUPPORTED: "当前授权路径不支持这次识别能力，请核对所选模型。不会切换到收费API。",
      PLAN_UNAVAILABLE: "当前ChatGPT计划不可用于本次识别，请核对授权与可用额度。",
      PLAN_AUTH: "ChatGPT计划授权已失效，请在本机授权页重新登录并连接。草稿仍保留。",
      REQUEST_PENDING: "原编号的识别仍需核对，可能已经发往模型。重试原号不会发起第二次识别。",
      RECOGNITION_PENDING: "原编号的识别仍需核对。请保留当前图片、说明、模型和编号，重新连接后重试原请求。",
      REQUEST_FAILED: "原编号已记录识别失败或超时，不会原样再次调用模型。可手动填写；明确准备新识别会使用额度。",
      RECOGNITION_FAILED: "本次识别失败，未采用结果。原图与草稿仍保留；新识别需本人明确准备并确认额度。",
      RESULT_EXPIRED: "原编号的七天识别结果已过期。原图和草稿仍在；需要再次识别时请明确准备新请求。",
      RECOGNITION_EXPIRED: "原编号的识别结果已过期。需要再次识别时请明确准备新请求并确认额度。",
      REQUEST_CONFLICT: "原编号已绑定不同图片、说明、账号或模型。请恢复原输入核对，或明确准备一次新的识别。",
      REQUEST_STATE: "原编号的处理状态已经变化，请先核对原请求，不会自动新增识别。",
      BRIDGE_BUSY: "本机正在处理另一项识别，本次尚未提交。请稍后按当前原编号重试。",
      OAUTH_SUPERSEDED: "本机授权账号已更换，旧结果不会填入当前草稿。请重新核对账号与本次请求。",
      MODEL_CATALOG: "无法读取本机已授权模型列表。草稿保留，请刷新授权状态后重新加载。",
      MODEL_NOT_ALLOWED: "所选模型不在已授权列表，请重新加载可用模型并明确选择。",
      MODEL_UNAVAILABLE: "所选模型当前不可用，请重新加载模型列表，不会自动换模型。",
      PAIR_EXPIRED: "本机连接码已过期，请在本机授权页取得新连接码。图片草稿仍保留。",
      PAIR_CODE: "本机连接码未通过，请核对本机授权页的八位连接码。",
      PAIR_LOCKED: "连接码尝试已达上限，请在本机授权页刷新后再连接。",
      DAILY_LIMIT: "本机今日十次识别额度已用完。原号缓存仍可核对，新识别请稍后再试。",
      PLAN_USAGE_LIMIT: "ChatGPT计划可用额度已达上限，请核对计划用量；不会切换到收费API。",
      IMAGE_SIZE: "原图大小超过本机允许范围，请选取不超过1,500,000字节的图片。原草稿仍保留。",
      IMAGE_TYPE: "本机核对的原图格式不符，仅接受真实PNG、JPEG或WebP。原草稿仍保留。",
      CONSENT_REQUIRED: "请先明确同意本图发送OpenAI并使用已授权计划的额度。",
    };
    if (messages[cause.code]) return `${messages[cause.code]}（${cause.code}）`;
    if (cause.status === 401 || cause.status === 403) return "本机授权或连接已失效。请在本机授权页核对账号与网页连接权限，再使用新的连接码连接。图片草稿仍保留。";
    if (cause.status === 429) return "本机桥接或当前计划的可用额度不足，请稍后核对额度；不会切换到另行收费的 API。";
    if (cause.code === "RECOGNITION_PENDING" || cause.status === 409) return "原编号的识别仍需核对。请保留当前图片、说明、模型和编号，重新连接后重试原请求，不会自动另建识别。";
    return "本机桥接未完成此请求。请在本机授权页检查登录、模型和服务状态；草稿与原编号仍保留。";
  }
  if (cause instanceof Error && cause.name === "AbortError") return "本页等待本机响应超时。本机可能仍在处理，请保留原编号重新连接后核对；不会自动生成新请求。";
  return "无法连接本机桥接。请确认本电脑的 5197 服务正在运行；若浏览器询问本地网络访问（LNA），需允许此网页访问本机。手机不能直连本电脑的 127.0.0.1。图片草稿仍保留。";
}

export default function CodexBridgePanel({ scope, disabled, imageReady, requestId, requestModel, onRecognize, onNewRequest }: Props) {
  const [code, setCode] = useState(""), [token, setToken] = useState(""), [bridgeId, setBridgeId] = useState("");
  const [status, setStatus] = useState<BridgeStatus | null>(null), [models, setModels] = useState<BridgeModel[]>([]), [model, setModel] = useState("");
  const [consent, setConsent] = useState(false), [working, setWorking] = useState(""), [error, setError] = useState(""), [message, setMessage] = useState("");
  const epoch = useRef(0);
  useEffect(() => { epoch.current++; setCode(""); setToken(""); setBridgeId(""); setStatus(null); setModels([]); setModel(""); setConsent(false); setWorking(""); setError(""); setMessage(""); return () => { epoch.current++; }; }, [scope]);
  useEffect(() => { setConsent(false); }, [requestId, model]);
  const locked = disabled || !!working || !scope;
  const authorized = !!token && !!status?.connected && !!status.plan_authorized;
  const modelChanged = !!requestModel && model !== requestModel;
  const quotaAvailable = !!status && status.quota.used < status.quota.max;
  const canCheckOriginal = !!requestModel && requestModel === model;

  async function action(name: string, operation: (currentEpoch: number) => Promise<void>) {
    if (locked) return;
    const currentEpoch = epoch.current; setWorking(name); setError(""); setMessage("");
    try { await operation(currentEpoch); }
    catch (cause) { if (currentEpoch === epoch.current) { setError(bridgeMessage(cause)); if (cause instanceof BridgeError && [401, 403].includes(cause.status)) { setToken(""); setStatus(null); setModels([]); setModel(""); } } }
    finally { if (currentEpoch === epoch.current) { setWorking(""); setConsent(false); } }
  }

  return <section className="codex-bridge-panel" aria-label="本机授权识图（Codex模型）">
    <div className="codex-bridge-heading"><h4>本机授权识图（Codex模型）</h4><span>{authorized ? "本人本机已连接" : "等待本人连接"}</span></div>
    <p>在这台电脑运行本机桥接，并在独立授权页使用本人账号授权。识别是独立请求，不会继承当前聊天。电脑和桥接需保持运行；手机不能直接连接本电脑。</p>
    <a className="intake-link codex-portal-link" href={`${BRIDGE}/`} target="_blank" rel="noopener noreferrer">打开本机授权与连接码页面<ExternalLink size={15} /></a>
    {!token ? <div className="codex-pair-row"><label className="intake-label">本机连接码<input aria-label="本机连接码" autoComplete="off" inputMode="numeric" pattern="[0-9]{8}" maxLength={8} value={code} disabled={locked} onChange={event => setCode(event.target.value.replace(/\D/g, "").slice(0, 8))} placeholder="8 位连接码" /></label><button type="button" className="intake-button" disabled={locked || !/^\d{8}$/.test(code)} onClick={() => { void action("pair", async currentEpoch => { const paired = await bridgeJSON<{ token: string; bridge_id: string }>("/pair", "", { code, scope }); if (currentEpoch !== epoch.current) return; if (!paired.token || !paired.bridge_id) throw new Error("配对响应不完整"); setToken(paired.token); setBridgeId(paired.bridge_id); setCode(""); setMessage("网页已连接本机。请手动刷新授权状态，再加载可用模型。刷新网页后需要重新连接，图片草稿不受影响。"); }); }}><Link2 size={16} />连接本机桥接</button></div> : <div className="codex-connection-actions"><button type="button" className="intake-button" disabled={locked} onClick={() => { void action("status", async currentEpoch => { const next = await bridgeJSON<BridgeStatus>("/status", token); if (currentEpoch !== epoch.current) return; if (next.bridge_id !== bridgeId || !next.quota || !Number.isFinite(next.quota.used) || !Number.isFinite(next.quota.max)) throw new Error("状态响应不完整"); setStatus(next); if (!next.connected || !next.plan_authorized) { setModels([]); setModel(""); } setMessage(next.connected && next.plan_authorized ? "已核对本人本机授权。请加载并选择当前可用的模型。" : "本机尚未完成计划授权，请在本机授权页完成后，再手动刷新状态。"); }); }}><RefreshCw size={16} />刷新本机授权状态</button><button type="button" className="intake-link" disabled={locked} onClick={() => { void action("disconnect", async () => { try { await bridgeJSON("/disconnect", token, {}); } finally { epoch.current++; setToken(""); setCode(""); setBridgeId(""); setStatus(null); setModels([]); setModel(""); setWorking(""); setConsent(false); setMessage("已清除本页连接。图片与事项草稿仍保留。重新连接需在本机获取新连接码。"); } }); }}><Unplug size={15} />断开本页连接</button></div>}
    {status && <div className="codex-account-status"><strong>{status.account_label || "本人账号"}</strong><span>{status.plan_authorized ? "ChatGPT 计划已授权" : "计划尚未授权"}</span><span>本机今日使用 {status.quota.used} / {status.quota.max} 次 · {status.quota.day}</span></div>}
    {token && <div className="codex-model-row"><label className="intake-label">识图模型<select aria-label="Codex识图模型" value={model} disabled={locked || !authorized || !models.length} onChange={event => { setModel(event.target.value); setConsent(false); }}><option value="">请明确选择可用模型</option>{models.map(item => <option key={item.slug} value={item.slug}>{item.display_name || item.slug}</option>)}</select></label><button type="button" className="intake-button" disabled={locked || !authorized} onClick={() => { void action("models", async currentEpoch => { const catalog = await bridgeJSON<{ models: BridgeModel[] }>("/models", token); if (currentEpoch !== epoch.current) return; const available = Array.isArray(catalog.models) ? catalog.models.filter(item => item && typeof item.slug === "string" && item.slug && typeof item.display_name === "string") : []; setModels(available); setModel(current => available.some(item => item.slug === current) ? current : requestModel && available.some(item => item.slug === requestModel) ? requestModel : available.some(item => item.slug === "gpt-6.1-sol") ? "gpt-6.1-sol" : ""); if (!available.length) setError("当前授权未返回可用模型。已保留所有草稿字段，请核对本机账号与计划后重新加载；不会自动选用其他服务。"); else setMessage("已加载本机当前可用模型。仅在列表中提供时预选 gpt-6.1-sol；其他模型需本人明确选择。"); }); }}>加载可用模型</button></div>}
    <p className="codex-usage-note">本图原图、补充说明及项目名称会发送给 OpenAI，使用本人已授权 ChatGPT 计划及可用额度，不承诺免费。不会自动回落到另行收费的 API。</p>
    <details className="codex-retention"><summary>原图、草稿和识别结果如何保留</summary><p>本机桥接收到的原图及授权令牌仅保留在运行内存。结构化识别结果在本机缓存七天，到期访问时清理；请求编号、图片校验值和每日计数长期保留，用于防止重复识别。</p><p>网页尚未保存的原图、说明及字段草稿仍在本人浏览器的 IndexedDB 中，清理草稿或浏览器站点数据可删除；正式保存后按私有项目簿的附件规则保留。</p><p>发往 OpenAI 的请求设置 store:false，这不等于零保留。服务端数据处理以当前账号和工作区政策为准，不套用另行 API 的固定保留期限。</p></details>
    {modelChanged && <p className="codex-bridge-error" role="alert">原请求使用 {requestModel}。更换模型前，请明确准备一次新的识别；重试原请求需选择原模型。</p>}
    <label className="intake-check"><input type="checkbox" checked={consent} disabled={locked || !authorized || !model || !imageReady || (!quotaAvailable && !canCheckOriginal) || modelChanged} onChange={event => setConsent(event.target.checked)} /><span>我同意本图原图、说明及项目名称发送给 OpenAI，并使用本人已授权计划的可用额度。</span></label>
    <div className="codex-recognition-actions"><button type="button" className="intake-button intake-primary" disabled={locked || !authorized || !model || !imageReady || (!quotaAvailable && !canCheckOriginal) || !consent || modelChanged} onClick={() => { void action("recognize", async currentEpoch => { await onRecognize(model, async input => { if (currentEpoch !== epoch.current) throw new Error("本页连接已变化，未发送旧请求"); const form = new FormData(); form.set("image", input.image); form.set("note", input.note); form.set("projects_json", JSON.stringify(input.projects)); form.set("request_id", input.requestId); form.set("model", model); form.set("consent", "true"); const result = await bridgeJSON<CodexBridgeResult>("/recognize", token, form); if (currentEpoch !== epoch.current) throw new Error("本页连接已变化，未采用识别响应"); return result; }); }); }}>{working === "recognize" ? <LoaderCircle size={16} className="spin" /> : null}用Codex识别并预览</button>{requestModel && <button type="button" className="intake-link" disabled={locked} onClick={() => { setConsent(false); onNewRequest(); setMessage("已准备新的识别编号。下次发送会使用计划额度；当前图片与人工字段保留。"); }}>准备一次新的Codex识别（将使用额度）</button>}</div>
    {working && working !== "recognize" && <p className="codex-bridge-message" role="status">正在核对本机连接…</p>}{message && <p className="codex-bridge-message" role="status">{message}</p>}{error && <p className="codex-bridge-error" role="alert">{error}</p>}
  </section>;
}
