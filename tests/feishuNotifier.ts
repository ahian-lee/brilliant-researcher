import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FeishuNotifier, type FeishuNotice } from '../packages/adapters/src/feishuNotifier.ts';

const temp = mkdtempSync(join(tmpdir(), 'feishu-notifier-'));
const configFile = join(temp, 'feishu.json');
const config = { appId: 'fixture-app', appSecret: 'fixture-secret', receiveId: 'fixture-chat', receiveIdType: 'chat_id' };
const put = (value: unknown) => writeFileSync(configFile, JSON.stringify(value));
const notice: FeishuNotice = { id: '81b050cc-c86a-4242-8b54-fd39affed370', projectId: 'private-project', projectName: '测试项目', sessionId: 'private-session', reason: 'DO-NOT-SEND raw prompt; pwsh secret command' };
const auth = () => Response.json({ code: 0, tenant_access_token: 'fixture-token', expire: 7200 });
const sent = () => Response.json({ code: 0, data: { message_id: 'om_fixture' } });
type Call = { url: string; init?: RequestInit };
function mocked(responses: Array<Response | Error>) {
  const calls: Call[] = [];
  const fetch = (async (url: URL | RequestInfo, init?: RequestInit) => {
    calls.push({ url: String(url), init }); const response = responses.shift();
    if (!response) throw new Error('unexpected network request');
    if (response instanceof Error) throw response;
    return response;
  }) as typeof globalThis.fetch;
  return { calls, fetch };
}
try {
  const unused = mocked([]);
  const absent = new FeishuNotifier({ configFile, fetch: unused.fetch });
  assert.equal((await absent.send(notice)).status, 'unconfigured');
  put({ appId: config.appId, appSecret: config.appSecret });
  assert.equal((await absent.send(notice)).status, 'unconfigured');
  put({ ...config, receiveIdType: 'unsupported-type' });
  assert.equal((await absent.send(notice)).status, 'unconfigured');
  put({ ...config, receiveIdType: ['chat_id'] });
  assert.equal((await absent.send(notice)).status, 'unconfigured');
  assert.equal(unused.calls.length, 0);

  put(config);
  let now = 1_000_000;
  const good = mocked([auth(), sent(), sent(), auth(), sent()]);
  const notifier = new FeishuNotifier({ configFile, fetch: good.fetch, now: () => now });
  assert.deepEqual(await notifier.send(notice), { status: 'sent', messageId: 'om_fixture' });
  assert.equal((await notifier.send({ ...notice, id: '33333333-3333-4333-8333-333333333333' })).status, 'sent');
  assert.equal(good.calls.length, 3); // second notice reuses the tenant token.
  assert.equal(good.calls[0].url, 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal');
  assert.equal(good.calls[1].url, 'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id');
  assert.equal(good.calls[1].init?.redirect, 'error');
  const payload = JSON.parse(String(good.calls[1].init?.body));
  assert.equal(payload.uuid, notice.id);
  assert.equal(payload.receive_id, config.receiveId);
  assert.equal(payload.msg_type, 'text');
  assert.match(JSON.parse(payload.content).text, /测试项目/);
  assert.match(JSON.parse(payload.content).text, /Codex/);
  assert.match(JSON.parse(payload.content).text, /仅可.*本机/);
  for (const secret of [notice.reason!, notice.projectId, notice.sessionId, config.appSecret, 'fixture-token']) assert.equal(payload.content.includes(secret), false);
  now += 7_200_000;
  assert.equal((await notifier.send({ ...notice, id: '44444444-4444-4444-8444-444444444444' })).status, 'sent');
  assert.equal(good.calls.length, 5); // expired token is refreshed for a later notice.

  const denied = mocked([Response.json({ code: 99991672, msg: config.appSecret })]);
  const deniedResult = await new FeishuNotifier({ configFile, fetch: denied.fetch }).send(notice);
  assert.equal(deniedResult.status, 'failed');
  assert.match(deniedResult.error!, /99991672/);
  assert.equal(deniedResult.error!.includes(config.appSecret), false);
  assert.equal(denied.calls.length, 1);
  const authFailure = mocked([new Error('fixture-secret fixture-token')]);
  assert.equal((await new FeishuNotifier({ configFile, fetch: authFailure.fetch }).send(notice)).status, 'failed');
  assert.equal(authFailure.calls.length, 1);

  for (const response of [
    Response.json({ code: 0, data: {} }),
    Response.json({ data: { message_id: 'om_fixture' } }),
    new Error('fixture-secret fixture-token'),
    new DOMException('fixture-token', 'TimeoutError'),
    new Response('fixture-secret invalid-json', { status: 200 }),
  ]) {
    const mock = mocked([auth(), response]);
    const result = await new FeishuNotifier({ configFile, fetch: mock.fetch }).send(notice);
    assert.equal(result.status, 'unknown');
    assert.equal(mock.calls.length, 2); // no delivery replay after ambiguity.
    assert.equal(JSON.stringify(result).includes('fixture-secret'), false);
    assert.equal(JSON.stringify(result).includes('fixture-token'), false);
  }
  for (const response of [Response.json({ code: 230013, msg: 'fixture-secret' }), new Response('fixture-secret', { status: 403 })]) {
    const mock = mocked([auth(), response]);
    const result = await new FeishuNotifier({ configFile, fetch: mock.fetch }).send(notice);
    assert.equal(result.status, 'failed');
    assert.equal(JSON.stringify(result).includes('fixture-secret'), false);
  }
  for (const receiveIdType of ['open_id', 'email']) {
    put({ ...config, receiveIdType });
    const mock = mocked([auth(), sent()]);
    assert.equal((await new FeishuNotifier({ configFile, fetch: mock.fetch }).send(notice)).status, 'sent');
    assert.ok(mock.calls[1].url.endsWith(`receive_id_type=${receiveIdType}`));
  }
  put(config);
  const invalid = mocked([]);
  assert.equal((await new FeishuNotifier({ configFile, fetch: invalid.fetch }).send({ ...notice, id: '' })).status, 'failed');
  assert.equal(invalid.calls.length, 0);
  console.log('feishuNotifier: PASS');
} finally { rmSync(temp, { recursive: true, force: true }); }
