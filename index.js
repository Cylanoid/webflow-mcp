// index.js
const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 8080;

// Load secrets from Railway environment
const WEBFLOW_API_KEY = process.env.WEBFLOW_API_KEY;
const WEBFLOW_SITE_ID = process.env.WEBFLOW_SITE_ID;

if (!WEBFLOW_API_KEY || !WEBFLOW_SITE_ID) {
  console.error('❌ Missing required environment variables: WEBFLOW_API_KEY or WEBFLOW_SITE_ID');
  process.exit(1);
}

app.use(cors());
app.use(express.json());

// Helper: Log incoming requests
function logRequest(route, req) {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  const userAgent = req.headers['user-agent'] || 'Unknown UA';
  console.log(`📥 [${route}] Request from ${ip} | UA: ${userAgent} | ${new Date().toISOString()}`);
}

/**
 * ✅ MCP-compliant SSE endpoint (Strict Spec + MCP flags)
 */
app.get('/sse', (req, res) => {
  logRequest('SSE', req);
  const startTime = Date.now();

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });

  // Immediate handshake
  const handshake = {
    mcp: true, // MCP flag
    type: "connection",
    status: "active",
    message: "Webflow MCP Connector is live",
    timestamp: new Date().toISOString(),
    capabilities: { collections: true, items: true, crud: true }
  };

  console.log(`📡 [SSE] Sent handshake: ${JSON.stringify(handshake)}`);
  res.write(`event: connection\n`);
  res.write(`data: ${JSON.stringify(handshake)}\n`);
  res.write(`retry: 3000\n\n`);

  // Immediate "ready" confirmation event
  const readyMsg = {
    type: "status",
    status: "ready",
    message: "Connector is ready to accept MCP requests",
    timestamp: new Date().toISOString()
  };
  res.write(`event: ready\n`);
  res.write(`data: ${JSON.stringify(readyMsg)}\n\n`);
  console.log(`✅ [SSE] Ready event sent`);

  // Heartbeat every 10 seconds
  const interval = setInterval(() => {
    const hb = { type: "heartbeat", timestamp: new Date().toISOString() };
    res.write(`event: heartbeat\n`);
    res.write(`data: ${JSON.stringify(hb)}\n\n`);
    console.log(`💓 [SSE] Heartbeat sent at ${hb.timestamp}`);
  }, 10000);

  req.on('close', () => {
    clearInterval(interval);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`❌ [SSE] Connection closed from ${req.socket.remoteAddress || 'unknown'} after ${elapsed}s at ${new Date().toISOString()}`);
    res.end();
  });
});

// ✅ List all Webflow CMS collections
app.get('/collections', async (req, res) => {
  logRequest('GET /collections', req);
  try {
    const response = await fetch(`https://api.webflow.com/v2/sites/${WEBFLOW_SITE_ID}/collections`, {
      headers: {
        'Authorization': `Bearer ${WEBFLOW_API_KEY}`,
        'accept-version': '1.0.0',
        'Content-Type': 'application/json'
      }
    });
    const data = await response.json();
    console.log(`📦 [Collections] Returned ${Array.isArray(data.collections) ? data.collections.length : 0} collections`);
    res.json(data);
  } catch (err) {
    console.error('❌ [Collections] Error:', err);
    res.status(500).json({ error: 'Failed to fetch collections' });
  }
});

// ✅ Get items in a specific collection
app.get('/collections/:id/items', async (req, res) => {
  logRequest(`GET /collections/${req.params.id}/items`, req);
  try {
    const response = await fetch(`https://api.webflow.com/v2/collections/${req.params.id}/items`, {
      headers: {
        'Authorization': `Bearer ${WEBFLOW_API_KEY}`,
        'accept-version': '1.0.0',
        'Content-Type': 'application/json'
      }
    });
    const data = await response.json();
    console.log(`📦 [Collection Items] Returned ${Array.isArray(data.items) ? data.items.length : 0} items`);
    res.json(data);
  } catch (err) {
    console.error(`❌ [Collection Items] Error for ID ${req.params.id}:`, err);
    res.status(500).json({ error: 'Failed to fetch collection items' });
  }
});

// ✅ Create new CMS item
app.post('/collections/:id/items', async (req, res) => {
  logRequest(`POST /collections/${req.params.id}/items`, req);
  try {
    const response = await fetch(`https://api.webflow.com/v2/collections/${req.params.id}/items`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${WEBFLOW_API_KEY}`,
        'accept-version': '1.0.0',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(req.body)
    });
    const data = await response.json();
    console.log(`✅ [Create Item] Created item in collection ${req.params.id}: ${JSON.stringify(req.body)}`);
    res.json(data);
  } catch (err) {
    console.error(`❌ [Create Item] Error for collection ${req.params.id}:`, err);
    res.status(500).json({ error: 'Failed to create collection item' });
  }
});

// ✅ Publish the site
app.post('/publish', async (req, res) => {
  logRequest('POST /publish', req);
  try {
    const response = await fetch(`https://api.webflow.com/v2/sites/${WEBFLOW_SITE_ID}/publish`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${WEBFLOW_API_KEY}`,
        'accept-version': '1.0.0',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ publishToWebflow: true })
    });
    const data = await response.json();
    console.log(`🚀 [Publish] Site publish request sent`);
    res.json(data);
  } catch (err) {
    console.error('❌ [Publish] Error:', err);
    res.status(500).json({ error: 'Failed to publish site' });
  }
});

// ✅ Root test endpoint
app.get('/', (req, res) => {
  logRequest('GET /', req);
  res.json({ status: 'ok', message: 'Webflow MCP Connector running' });
});

// ✅ Start server
app.listen(PORT, () => {
  console.log(`✅ Webflow MCP Connector running on port ${PORT}`);
  console.log(`📡 SSE endpoint available at http://localhost:${PORT}/sse`);
});
