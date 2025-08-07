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

/**
 * ✅ MCP-compliant SSE endpoint
 * Sends an immediate handshake packet for ChatGPT MCP connector validation
 * Includes debug logging for connection attempts
 */
app.get('/sse', (req, res) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  const userAgent = req.headers['user-agent'] || 'Unknown UA';

  console.log(`📥 [SSE] Incoming connection from ${ip} | UA: ${userAgent} | ${new Date().toISOString()}`);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });

  // Immediate handshake
  const handshake = {
    type: "connection",
    status: "active",
    message: "Webflow MCP Connector is live",
    timestamp: new Date().toISOString(),
    capabilities: { collections: true, items: true, crud: true }
  };

  console.log(`📡 [SSE] Sent handshake: ${JSON.stringify(handshake)}`);
  res.write(`data: ${JSON.stringify(handshake)}\n\n`);

  // Heartbeat every 30 seconds
  const interval = setInterval(() => {
    const hb = { type: "heartbeat", timestamp: new Date().toISOString() };
    res.write(`data: ${JSON.stringify(hb)}\n\n`);
    console.log(`💓 [SSE] Heartbeat sent at ${hb.timestamp}`);
  }, 30000);

  req.on('close', () => {
    clearInterval(interval);
    console.log(`❌ [SSE] Connection closed from ${ip} at ${new Date().toISOString()}`);
    res.end();
  });
});

// ✅ List all Webflow CMS collections
app.get('/collections', async (req, res) => {
  try {
    const response = await fetch(`https://api.webflow.com/v2/sites/${WEBFLOW_SITE_ID}/collections`, {
      headers: {
        'Authorization': `Bearer ${WEBFLOW_API_KEY}`,
        'accept-version': '1.0.0',
        'Content-Type': 'application/json'
      }
    });
    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error('Error fetching collections:', err);
    res.status(500).json({ error: 'Failed to fetch collections' });
  }
});

// ✅ Get items in a specific collection
app.get('/collections/:id/items', async (req, res) => {
  try {
    const response = await fetch(`https://api.webflow.com/v2/collections/${req.params.id}/items`, {
      headers: {
        'Authorization': `Bearer ${WEBFLOW_API_KEY}`,
        'accept-version': '1.0.0',
        'Content-Type': 'application/json'
      }
    });
    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error('Error fetching collection items:', err);
    res.status(500).json({ error: 'Failed to fetch collection items' });
  }
});

// ✅ Create new CMS item
app.post('/collections/:id/items', async (req, res) => {
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
    res.json(data);
  } catch (err) {
    console.error('Error creating collection item:', err);
    res.status(500).json({ error: 'Failed to create collection item' });
  }
});

// ✅ Publish the site
app.post('/publish', async (req, res) => {
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
    res.json(data);
  } catch (err) {
    console.error('Error publishing site:', err);
    res.status(500).json({ error: 'Failed to publish site' });
  }
});

// ✅ Root test endpoint
app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'Webflow MCP Connector running' });
});

// ✅ Start server
app.listen(PORT, () => {
  console.log(`✅ Webflow MCP Connector running on port ${PORT}`);
  console.log(`📡 SSE endpoint available at http://localhost:${PORT}/sse`);
});
