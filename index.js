// index.js
const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 8080;

// Secrets
const WEBFLOW_API_KEY = process.env.WEBFLOW_API_KEY;
const WEBFLOW_SITE_ID = process.env.WEBFLOW_SITE_ID;

if (!WEBFLOW_API_KEY || !WEBFLOW_SITE_ID) {
  console.error('❌ Missing WEBFLOW_API_KEY or WEBFLOW_SITE_ID');
  process.exit(1);
}

app.use(cors());
app.use(express.json());

// ---------- Helpers ----------
function logRequest(route, req) {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  const ua = req.headers['user-agent'] || 'Unknown UA';
  console.log(`📥 [${route}] from ${ip} | UA: ${ua} | ${new Date().toISOString()}`);
}

async function wfFetch(path, opts = {}) {
  const url = `https://api.webflow.com/v2${path}`;
  const res = await fetch(url, {
    ...opts,
    headers: {
      'Authorization': `Bearer ${WEBFLOW_API_KEY}`,
      'accept-version': '1.0.0',
      'Content-Type': 'application/json',
      ...(opts.headers || {})
    }
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = `Webflow API ${res.status}: ${JSON.stringify(data)}`;
    throw new Error(msg);
  }
  return data;
}

// ---------- MCP — Streamable HTTP transport ----------
// Spec: one endpoint that supports POST (JSON-RPC) and GET (SSE). :contentReference[oaicite:4]{index=4}

// In-memory noop “event stream” registry (simple demo)
const sseClients = new Set();

// GET /mcp -> optional server->client SSE stream (not strictly required for init)
app.get('/mcp', (req, res) => {
  logRequest('GET /mcp (SSE)', req);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });

  const start = Date.now();
  const client = { res };
  sseClients.add(client);

  // harmless log + regular heartbeats
  res.write(`event: log\n`);
  res.write(`data: ${JSON.stringify({ message: 'SSE stream open', ts: new Date().toISOString() })}\n\n`);

  const interval = setInterval(() => {
    const hb = { type: 'heartbeat', timestamp: new Date().toISOString() };
    res.write(`event: heartbeat\n`);
    res.write(`data: ${JSON.stringify(hb)}\n\n`);
  }, 10000);

  req.on('close', () => {
    clearInterval(interval);
    sseClients.delete(client);
    console.log(`❌ [/mcp SSE] closed after ${((Date.now()-start)/1000).toFixed(1)}s`);
    res.end();
  });
});

// POST /mcp -> JSON-RPC request(s). Must support initialize + tools. :contentReference[oaicite:5]{index=5}
app.post('/mcp', async (req, res) => {
  logRequest('POST /mcp', req);

  // If body is an array and contains only notifications/responses -> 202 (spec)
  // If it contains any requests -> we’ll return application/json (non-streaming) for simplicity. :contentReference[oaicite:6]{index=6}
  const body = req.body;

  // Normalize to array for uniform handling
  const batch = Array.isArray(body) ? body : [body];

  const responses = [];
  for (const msg of batch) {
    try {
      if (!msg || typeof msg !== 'object') continue;

      // Notifications: e.g., "notifications/initialized"
      if (!('id' in msg) && typeof msg.method === 'string') {
        console.log(`ℹ️ [MCP notif] ${msg.method}`);
        continue;
      }

      // Only handle requests with id
      if (msg && msg.id != null && typeof msg.method === 'string') {
        const id = msg.id;
        const method = msg.method;

        // ---- initialize ----
        if (method === 'initialize') {
          // Return server capabilities and info (minimal, tools included). :contentReference[oaicite:7]{index=7}
          responses.push({
            jsonrpc: '2.0',
            id,
            result: {
              protocolVersion: '2025-03-26',
              capabilities: {
                logging: {},
                prompts: { listChanged: true },
                resources: { subscribe: false, listChanged: true },
                tools: { listChanged: true }
              },
              serverInfo: { name: 'Webflow MCP Connector', version: '1.0.0' },
              instructions: 'Use tools to manage Webflow CMS (list collections, read items, create items, publish).'
            }
          });
          continue;
        }

        // ---- tools/list ----
        if (method === 'tools/list') {
          responses.push({
            jsonrpc: '2.0',
            id,
            result: {
              tools: [
                {
                  name: 'wf_list_collections',
                  description: 'List all CMS collections in the configured Webflow site.',
                  inputSchema: { type: 'object', properties: {} }
                },
                {
                  name: 'wf_get_items',
                  description: 'List items from a specific collection.',
                  inputSchema: {
                    type: 'object',
                    properties: {
                      collectionId: { type: 'string', description: 'Webflow collection ID' },
                      limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Optional limit' }
                    },
                    required: ['collectionId']
                  }
                },
                {
                  name: 'wf_create_item',
                  description: 'Create a new item in a collection. Pass the fields payload exactly as Webflow expects.',
                  inputSchema: {
                    type: 'object',
                    properties: {
                      collectionId: { type: 'string', description: 'Webflow collection ID' },
                      fields: { type: 'object', description: 'Item fields per Webflow schema' }
                    },
                    required: ['collectionId', 'fields']
                  }
                },
                {
                  name: 'wf_publish_site',
                  description: 'Publish the entire site.',
                  inputSchema: {
                    type: 'object',
                    properties: {
                      publishToWebflow: { type: 'boolean', default: true }
                    }
                  }
                }
              ],
              nextCursor: null
            }
          });
          continue;
        }

        // ---- tools/call ----
        if (method === 'tools/call') {
          const { name, arguments: args = {} } = msg.params || {};
          try {
            if (name === 'wf_list_collections') {
              const data = await wfFetch(`/sites/${WEBFLOW_SITE_ID}/collections`);
              responses.push({
                jsonrpc: '2.0',
                id,
                result: {
                  content: [{ type: 'text', text: JSON.stringify(data) }],
                  isError: false
                }
              });
            } else if (name === 'wf_get_items') {
              const { collectionId, limit } = args;
              if (!collectionId) throw new Error('Missing collectionId');
              const q = typeof limit === 'number' ? `?limit=${limit}` : '';
              const data = await wfFetch(`/collections/${collectionId}/items${q}`);
              responses.push({
                jsonrpc: '2.0',
                id,
                result: { content: [{ type: 'text', text: JSON.stringify(data) }], isError: false }
              });
            } else if (name === 'wf_create_item') {
              const { collectionId, fields } = args;
              if (!collectionId || !fields) throw new Error('Missing collectionId or fields');
              const data = await wfFetch(`/collections/${collectionId}/items`, {
                method: 'POST',
                body: JSON.stringify({ ...fields })
              });
              responses.push({
                jsonrpc: '2.0',
                id,
                result: { content: [{ type: 'text', text: JSON.stringify(data) }], isError: false }
              });
            } else if (name === 'wf_publish_site') {
              const { publishToWebflow = true } = args;
              const data = await wfFetch(`/sites/${WEBFLOW_SITE_ID}/publish`, {
                method: 'POST',
                body: JSON.stringify({ publishToWebflow })
              });
              responses.push({
                jsonrpc: '2.0',
                id,
                result: { content: [{ type: 'text', text: JSON.stringify(data) }], isError: false }
              });
            } else {
              responses.push({
                jsonrpc: '2.0',
                id,
                error: { code: -32602, message: `Unknown tool: ${name}` }
              });
            }
          } catch (toolErr) {
            responses.push({
              jsonrpc: '2.0',
              id,
              result: {
                content: [{ type: 'text', text: `Tool error: ${String(toolErr.message || toolErr)}` }],
                isError: true
              }
            });
          }
          continue;
        }

        // Unknown method
        responses.push({
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `Method not found: ${method}` }
        });
      }
    } catch (err) {
      console.error('❌ [MCP] handler error', err);
    }
  }

  // If no request in the batch (only notifications/responses), return 202
  if (responses.length === 0) {
    return res.status(202).end();
  }

  // For simplicity, always return application/json (client MUST support). :contentReference[oaicite:8]{index=8}
  const payload = Array.isArray(body) ? responses : responses[0];
  res.setHeader('Content-Type', 'application/json');
  res.status(200).send(JSON.stringify(payload));
});

// ---------- Legacy HTTP+SSE fallback endpoint ----------
// When a client falls back, it does GET and expects the FIRST event to be "endpoint" telling where to POST. :contentReference[oaicite:9]{index=9}
app.get('/sse', (req, res) => {
  logRequest('GET /sse (legacy)', req);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });

  // Required first event for legacy HTTP+SSE: tell client where to send JSON-RPC
  res.write(`event: endpoint\n`);
  res.write(`data: ${JSON.stringify({ endpoint: '/mcp' })}\n\n`);

  // Optional: small status + heartbeat
  const hello = {
    type: 'connection',
    status: 'active',
    mcp: true,
    message: 'Legacy SSE is active; POST your JSON-RPC to /mcp',
    timestamp: new Date().toISOString()
  };
  res.write(`event: connection\n`);
  res.write(`data: ${JSON.stringify(hello)}\n\n`);

  const interval = setInterval(() => {
    res.write(`event: heartbeat\n`);
    res.write(`data: ${JSON.stringify({ type: 'heartbeat', ts: new Date().toISOString() })}\n\n`);
  }, 10000);

  req.on('close', () => {
    clearInterval(interval);
    res.end();
  });
});

// ---------- Your REST helpers (unchanged) ----------
app.get('/collections', async (req, res) => {
  logRequest('GET /collections', req);
  try {
    const data = await wfFetch(`/sites/${WEBFLOW_SITE_ID}/collections`);
    res.json(data);
  } catch (err) {
    console.error('❌ [Collections] ', err);
    res.status(500).json({ error: 'Failed to fetch collections' });
  }
});

app.get('/collections/:id/items', async (req, res) => {
  logRequest(`GET /collections/${req.params.id}/items`, req);
  try {
    const data = await wfFetch(`/collections/${req.params.id}/items`);
    res.json(data);
  } catch (err) {
    console.error('❌ [Collection Items] ', err);
    res.status(500).json({ error: 'Failed to fetch collection items' });
  }
});

app.post('/collections/:id/items', async (req, res) => {
  logRequest(`POST /collections/${req.params.id}/items`, req);
  try {
    const data = await wfFetch(`/collections/${req.params.id}/items`, {
      method: 'POST',
      body: JSON.stringify(req.body)
    });
    res.json(data);
  } catch (err) {
    console.error('❌ [Create Item] ', err);
    res.status(500).json({ error: 'Failed to create collection item' });
  }
});

app.post('/publish', async (req, res) => {
  logRequest('POST /publish', req);
  try {
    const data = await wfFetch(`/sites/${WEBFLOW_SITE_ID}/publish`, {
      method: 'POST',
      body: JSON.stringify({ publishToWebflow: true })
    });
    res.json(data);
  } catch (err) {
    console.error('❌ [Publish] ', err);
    res.status(500).json({ error: 'Failed to publish site' });
  }
});

// Root
app.get('/', (req, res) => {
  logRequest('GET /', req);
  res.json({ status: 'ok', message: 'Webflow MCP Connector running', endpoints: ['/mcp', '/sse'] });
});

// Start
app.listen(PORT, () => {
  console.log(`✅ Webflow MCP Connector running on port ${PORT}`);
  console.log(`📡 MCP endpoint: POST/GET http://localhost:${PORT}/mcp`);
  console.log(`📡 Legacy SSE (with endpoint hint): http://localhost:${PORT}/sse`);
});
