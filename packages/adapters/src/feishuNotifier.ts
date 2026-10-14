import { readFileSync } from 'node:fs';

export interface FeishuNotice {
  /** Durable approval notification UUID. Reuse this value if delivery must later be checked. */
  id: string;
  projectId: string;
  projectName: string;
  sessionId: string;
  reason?: string;
}
export interface FeishuNoticeResult {
  status: 'sent' | 'unconfigured' | 'failed' | 'unknown';
  messageId?: string;
  error?: string;
}
export interface FeishuNotifierOptions {
  /** Trusted server configuration path; never accept this path from a request. */
  configFile: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  now?: () => number;
  dashboardUrl?: string;
}
interface FeishuConfig {
  appId: string;
  appSecret: string;
  receiveId: string;
  receiveIdType: 'chat_id' | 'open_id' | 'email';
}
const AUTH_URL = 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal';
const MESSAGE_URL = 'https://open.feishu.cn/open-apis/im/v1/messages';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value.trim() : undefined;
const codeLabel = (code: unknown): string => typeof code === 'number' && Number.isSafeInteger(code) ? `，code ${code}` : '';

/** Notification delivery never decides or changes the underlying tool approval. */
export class FeishuNotifier {
  readonly options: FeishuNotifierOptions;
  private token: { value: string; expiresAt: number; appId: string; appSecret: string } | undefined;
  constructor(options: FeishuNotifierOptions) { this.options = options; }

  private config(): FeishuConfig | null {
    try {
      const value = object(JSON.parse(readFileSync(this.options.configFile, 'utf8')));
      const appId = text(value.appId); const appSecret = text(value.appSecret); const receiveId = text(value.receiveId);
      const receiveIdType = value.receiveIdType;
      if (!appId || !appSecret || !receiveId || typeof receiveIdType !== 'string' || !['chat_id', 'open_id', 'email'].includes(receiveIdType)) return null;
      return { appId, appSecret, receiveId, receiveIdType: receiveIdType as FeishuConfig['receiveIdType'] };
    } catch { return null; }
  }

  private async authenticate(config: FeishuConfig): Promise<{ token: string } | { error: string }> {
    const now = (this.options.now ?? Date.now)();
    if (this.token && this.token.expiresAt > now && this.token.appId === config.appId && this.token.appSecret === config.appSecret) return { token: this.token.value };
    try {
      const response = await (this.options.fetch ?? globalThis.fetch)(AUTH_URL, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, redirect: 'error',
        body: JSON.stringify({ app_id: config.appId, app_secret: config.appSecret }),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 15_000),
      });
      if (!response.ok) return { error: `飞书认证失败（HTTP ${response.status}）` };
      const result = object(await response.json());
      if (result.code !== 0) return { error: `飞书认证失败（API 拒绝${codeLabel(result.code)}）` };
      const token = text(result.tenant_access_token); const expire = result.expire;
      if (!token || typeof expire !== 'number' || !Number.isFinite(expire) || expire <= 0) return { error: '飞书认证响应不完整，未发送通知' };
      this.token = { value: token, expiresAt: (this.options.now ?? Date.now)() + Math.max(0, expire - 60) * 1000,
        appId: config.appId, appSecret: config.appSecret };
      return { token };
    } catch {
      // Never propagate fetch errors: a server or transport may put credentials in them.
      return { error: '飞书认证请求失败或超时，未发送通知' };
    }
  }

  async send(notice: FeishuNotice): Promise<FeishuNoticeResult> {
    const config = this.config();
    if (!config) return { status: 'unconfigured', error: '飞书应用或收件目标尚未配置完整' };
    if (!UUID.test(notice.id)) return { status: 'failed', error: '通知缺少有效的持久 UUID，未发送' };
    const authenticated = await this.authenticate(config);
    if ('error' in authenticated) return { status: 'failed', error: authenticated.error };
    const projectName = notice.projectName.replace(/[\r\n\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 120) || '未命名项目';
    const dashboardUrl = this.options.dashboardUrl ?? 'http://localhost:8791';
    const localhost = (() => {
      try { return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(dashboardUrl).hostname); } catch { return true; }
    })();
    // Neither reason, original prompt, tool command nor credentials leave this boundary.
    const message = `研究项目：${projectName}\n工具请求未获自动审核及 Codex 审核放行，正在等待人工处理。\n请打开研究看板查看待审批请求，核对具体操作后决定。\n看板：${dashboardUrl}${localhost ? '（仅可在运行看板的本机打开）' : ''}`;
    try {
      const response = await (this.options.fetch ?? globalThis.fetch)(`${MESSAGE_URL}?receive_id_type=${config.receiveIdType}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authenticated.token}` }, redirect: 'error',
        body: JSON.stringify({ receive_id: config.receiveId, msg_type: 'text', content: JSON.stringify({ text: message }), uuid: notice.id }),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 15_000),
      });
      if (!response.ok) return { status: 'failed', error: `飞书通知发送失败（HTTP ${response.status}）` };
      const result = object(await response.json());
      if (typeof result.code !== 'number' || !Number.isSafeInteger(result.code)) return { status: 'unknown', error: '飞书响应缺少有效状态码，送达状态不明；未自动重发' };
      if (result.code !== 0) return { status: 'failed', error: `飞书通知发送失败（API 拒绝${codeLabel(result.code)}）` };
      const messageId = text(object(result.data).message_id);
      if (!messageId) return { status: 'unknown', error: '飞书响应缺少消息标识，送达状态不明；未自动重发' };
      return { status: 'sent', messageId };
    } catch {
      return { status: 'unknown', error: '飞书通知请求超时或响应不明，请先核实送达状态；未自动重发' };
    }
  }
}
