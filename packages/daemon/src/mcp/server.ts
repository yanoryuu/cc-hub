// CC Hub 自身の MCP サーバー(Streamable HTTP、ステートレス)。POST / GET / DELETE /mcp。
// 認証: Authorization: Bearer <mcp トークン>(<dataDir>\mcp-token)。tailscale serve 経由(プロキシヘッダ付き)は拒否する。
// リクエストごとに Server + Transport を作って捨てる(セッションを持たない)。
import type http from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Auth } from '../api/auth';
import { json, readBody } from '../util';
import { callTool, listToolsResult, toolErrorMessage, type McpDeps } from './tools';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const INSTRUCTIONS =
  'CC Hub(このPCで Claude Code のセッションを束ねているアプリ)のツールです。' +
  'サーバーへのアップロードは request_deploy で申請し、ユーザーの承認を待ちます(直接は送信しません)。' +
  'Firebase へのデプロイは firebase_status で状況を確かめてから request_firebase_deploy で申請します(承認制。Hosting はまずプレビュー URL、本番への反映はユーザーが確認してから)。' +
  'プロジェクトの共通の指示は get_project_instructions / update_project_instructions で読み書きします。' +
  'Unity のプロジェクトは launch_unity でエディタを開けます(unity_status で開いているか確認できます)。' +
  'Unity のプロジェクトや自作ツールは set_app_launcher で「アプリを開く」ボタンとして登録すると、ユーザーが CC Hub からいつでも起動できます。' +
  'スクリーンショットやモックなどの画像をユーザーに見せたいときは send_images で Discord に送れます(ターンの終わりの通知のスレッドに投稿されます)。' +
  'cwd を受け取るツールには、必ずあなたの現在の作業ディレクトリの絶対パスを渡してください。';

export interface McpHttpDeps extends McpDeps {
  auth: Auth;
  mcpToken: string;
  version: string;
}

export async function handleMcp(d: McpHttpDeps, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (!d.auth.isMcp(req, d.mcpToken)) {
    res.setHeader('WWW-Authenticate', 'Bearer');
    return json(res, 401, { jsonrpc: '2.0', error: { code: -32001, message: 'unauthorized' }, id: null });
  }
  const method = req.method || 'GET';
  let body: unknown = undefined;
  if (method === 'POST') {
    try {
      body = await readBody(req, 4e6);
    } catch {
      return json(res, 400, { jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null });
    }
  }
  // 展開済みの X-CC-Hub-Session(CC Hub のセッション ID)が届けば呼び出し元の特定に使う
  const hdr = req.headers['x-cc-hub-session'];
  const sessionId = typeof hdr === 'string' && UUID_RE.test(hdr.trim()) ? hdr.trim() : null;

  const server = new Server({ name: 'cc-hub', version: d.version }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });
  server.setRequestHandler(ListToolsRequestSchema, async () => listToolsResult() as any);
  server.setRequestHandler(CallToolRequestSchema, async (r) => {
    const name = r.params.name;
    try {
      const out = await callTool(name, r.params.arguments, d, { sessionId });
      console.log(`[mcp] ${name}`);
      return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }], structuredContent: out as Record<string, unknown> };
    } catch (e) {
      const msg = toolErrorMessage(e);
      console.log(`[mcp] ${name} エラー: ${msg}`);
      return { content: [{ type: 'text', text: msg }], isError: true };
    }
  });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}
