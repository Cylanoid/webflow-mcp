# Webflow MCP Connector

A Node.js/Express server that bridges OpenAI's MCP (Model Context Protocol) with Webflow's CMS API, enabling ChatGPT to manage your Webflow site content.

## 🚀 Quick Start

### 1. Install Dependencies
```bash
cd "C:\Users\Big Levi Local\Documents\webflow-mcp"
npm install
```

### 2. Configure Environment
1. Copy `.env.example` to `.env`:
```bash
copy .env.example .env
```

2. Edit `.env` and add your Webflow API key:
```
WEBFLOW_API_KEY=your_actual_webflow_api_key_here
```

To get your Webflow API key:
- Go to https://webflow.com/dashboard/account/apps
- Generate a new API token
- Copy and paste it into the `.env` file

### 3. Run the Server
```bash
npm start
```

Or for development with auto-restart:
```bash
npm run dev
```

## 📋 Available Endpoints

### Core MCP Endpoint
- `GET /sse` - Server-Sent Events endpoint for MCP protocol

### Site Management
- `GET /sites` - List all sites
- `GET /sites/:siteId` - Get site details
- `POST /sites/:siteId/publish` - Publish a site

### Collection Management
- `GET /collections?site_id=xxx` - List all collections for a site
- `GET /collections/:collectionId` - Get collection details
- `GET /collections/:collectionId/items` - List items in collection
- `GET /collections/:collectionId/items/:itemId` - Get specific item
- `POST /collections/:collectionId/items` - Create new item
- `PATCH /collections/:collectionId/items/:itemId` - Update item
- `DELETE /collections/:collectionId/items/:itemId` - Delete item
- `POST /collections/:collectionId/items/publish` - Publish items

## 🔧 Configuration Options

### Environment Variables
- `WEBFLOW_API_KEY` - Your Webflow API key (required)
- `PORT` - Server port (default: 3000)
- `NODE_ENV` - Environment (development/production)
- `CONNECTOR_API_TOKEN` - Optional API token for securing the connector
- `ALLOWED_ORIGINS` - CORS origins (default: *)

## 🚢 Deployment

### Deploy to Railway
1. Push to GitHub
2. Connect Railway to your GitHub repo
3. Add environment variables in Railway dashboard
4. Deploy!

### Deploy to Render
1. Push to GitHub
2. Create new Web Service on Render
3. Connect to your GitHub repo
4. Add environment variables
5. Deploy!

### Deploy to Heroku
```bash
heroku create your-app-name
heroku config:set WEBFLOW_API_KEY=your_key
git push heroku main
```

## 🔐 Security

### Optional API Token
To secure your connector, uncomment and set `CONNECTOR_API_TOKEN` in your `.env`:
```
CONNECTOR_API_TOKEN=your_secure_token_here
```

Then include the token in requests:
- Header: `x-api-token: your_secure_token_here`
- Or query param: `?token=your_secure_token_here`

## 🧪 Testing

### Test Health Check
```bash
curl http://localhost:3000/health
```

### Test SSE Endpoint
```bash
curl http://localhost:3000/sse
```

### Test Sites List (replace with your API token if enabled)
```bash
curl http://localhost:3000/sites
```

## 📚 Valor Investigations Specific Info

### Your Site Details
- **Site ID:** 688cbb2c6729adeb8a489ab4
- **Site Name:** Valor Investigations
- **Domain:** https://www.valor-investigations.com

### Your Collections
- **Articles:** 688f41bb8c03f7dbc7ae26a9
- **Resources:** 6892f55a6dfdde59aef7455a

### Example: Create a New Article
```bash
curl -X POST http://localhost:3000/collections/688f41bb8c03f7dbc7ae26a9/items \
  -H "Content-Type: application/json" \
  -d '{
    "live": true,
    "items": [{
      "fieldData": {
        "name": "New Investigation Report",
        "slug": "new-investigation-report",
        "content": "Article content here..."
      }
    }]
  }'
```

## 🤝 Connect to ChatGPT

1. Go to ChatGPT Settings → Connectors
2. Add new MCP server:
   - **Server URL:** Your deployed URL + `/sse` (e.g., `https://your-app.railway.app/sse`)
   - **Server Label:** "Webflow CMS Manager"
   - **Allowed Tools:** All
   - **Require Approval:** Never (for automation)

## 📞 Support

For issues with:
- **This connector:** Check the logs with `npm run dev`
- **Webflow API:** https://developers.webflow.com
- **MCP Protocol:** https://docs.openai.com/mcp

## 📝 License

MIT

---

Built for Valor Investigations - Exposing corruption and protecting the vulnerable.
