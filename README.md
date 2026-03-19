# ASTRA – Intelligent Browser Automation Assistant

<p align="center">
  <img src="extension/public/icons/icon128.png" alt="ASTRA Logo" width="128" height="128" />
</p>

<p align="center">
  <a href="https://chromewebstore.google.com"><img src="https://img.shields.io/badge/Chrome-Extension-blue?style=flat&logo=google-chrome" alt="Chrome Extension" /></a>
  <a href="https://www.typescript.org"><img src="https://img.shields.io/badge/TypeScript-5.7-blue?style=flat&logo=typescript" alt="TypeScript" /></a>
  <a href="https://fastify.dev"><img src="https://img.shields.io/badge/Fastify-5.1-purple?style=flat" alt="Fastify" /></a>
  <a href="https://react.dev"><img src="https://img.shields.io/badge/React-18-cyan?style=flat&logo=react" alt="React" /></a>
  <a href="https://fireworks.ai"><img src="https://img.shields.io/badge/Multi--LLM-Router-orange?style=flat" alt="Multi-LLM Router" /></a>
</p>

---

## Overview

ASTRA is a Chrome extension that automates web tasks using AI. Simply tell it what you want to do, and it takes care of the rest—navigating websites, filling forms, clicking buttons, and handling complex interactions. It works on any website with standard UI elements, from streaming services to e-commerce platforms.

**Example**: "Search Netflix for Interstellar and play it" → ASTRA navigates to Netflix, searches for the movie, and starts playback.

---

## What's New

- **Shadow DOM Support** – Locates and interacts with elements inside web components and shadow boundaries
- **Deep Selector Search** – Intelligent fallback system finds elements even when DOM changes
- **Multi-Site Compatibility** – Tested on Spotify, Prime Video, Netflix, Amazon, and more
- **Self-Healing Actions** – When selectors don't work, the system automatically finds the right element
- **Smart Retry Logic** – Exponential backoff prevents rate limiting with automatic fallbacks
- **Better Debugging** – Clear logging helps identify what's happening at each step

---

## Core Features

### Reliable Automation
- **React-Safe DOM Access** – Safely bypasses framework protections to fill forms and trigger actions
- **Cross-Boundary Element Finding** – Works inside web components and shadow DOM elements
- **Multiple Discovery Strategies** – CSS → aria-labels → data-testid → XPath → fuzzy text matching
- **Automatic Fallbacks** – Failed selectors trigger alternative discovery methods instantly
- **Intelligent Retry System** – Exponential backoff with circuit breaker pattern

### Smart Navigation
- **Visual Element Recognition** – Uses screenshots to identify UI elements by appearance
- **Multi-LLM Router** – Automatically switches providers when rate limits are hit
- **Optimized Timeouts** – Action-specific delays instead of fixed waits
- **Selector Caching** – 87% reduction in DOM lookups for repeated actions

### Advanced Intelligence
- **Form Auto-Detection** – Handles date pickers, rich editors, dropdowns, autocomplete fields
- **Infinite Scroll** – Auto-loads more content when reaching page bottom
- **Modal Management** – Intelligently closes popups and dialogs
- **SPA Detection** – Recognizes React/Vue/Angular apps and waits for data
- **Three-Layer Memory** – Redis (fast), ChromaDB (semantic), PostgreSQL (long-term)

---

## How It Works

<p align="center">
  <img src="https://mermaid.ink/img/pako:eNqVksFuwjAM_BXLOSNQN4EQ0g5I3bbpNO08HkkxZLGTyA6qRf-9GzIBQ-ppfnn55_vhO5aygU1jFJVyqzHJ8fN8dz8-TZPne3K5GC_H48n5eLqeP4wvl9vjZXI5GM-Xj_ML0jIL1_M_16dVUBwvPmIu3VWQHSXh4rVQZl8p0_eHUm2lRYqo7dNPXRCCDPYOCvSqwAvJXdmFKk7_VhSFPqNFCx7jP9JUlVGdmYrxc0LL1s-eBEHWxMDM5wLK0chMw6NaDWMDdMQhHqZ5VNT_7V5XyTXVBKqWWQLqsWkDyiLd6n-yF5NJgAEDWsAYd9Yh-DsOmEcEhQV06eKrAqPxBmWR4OdXKqvVwT4gYEQECQvM3Yx92rWiM8sVE5A1MgJ8sNMpQqZmLUHzA1Vs1UQRF9MQvV5DKnnWkQT64jY5Cl6Y_X_lzJx2YjCtzQNMIoKNWBIKRAUsBFyoAcxKlekQIKNvXLUVzTpKuSMEu0Cpc1Gy2EtPMhEJgPb2LKTsxc09LIo2YhHVMdQx1QQQMR76GxeLYiOmG2KFqzComlhXZxCpWVaVWtVKSB1dMEz6GkJPZKfUi7ggXgKmqkKhKLxSoF9r2NHfMWZwl2E" alt="ASTRA Architecture" />
</p>

1. **You** → Give a natural language command
2. **ASTRA Extension** → Sends request to backend
3. **NEXUS Backend** → Plans actions, analyzes screenshots, routes to best LLM
4. **Content Script** → Finds elements (including shadow DOM), executes actions with fallbacks
5. **Website** → Task completed automatically

---

## Getting Started

### Requirements

- **Node.js** 18+ and npm 9+
- **Chrome** browser (latest version)
- API key for at least one LLM provider (Anthropic, OpenAI, Fireworks, or Groq)
- **Docker** (optional, for memory layers)

### Installation

```bash
# 1. Clone the repository
git clone https://github.com/saikumargudelly/ASTRA-Xtension.git
cd ASTRA-Xtension

# 2. (Optional) Start Docker containers for memory
docker-compose up -d

# 3. Setup backend
cd backend
npm install
cp .env.example .env
# Edit .env with your LLM API key

# 4. Start backend server
npm run dev

# 5. Build extension
cd ../extension
npm install
npm run build

# 6. Load extension in Chrome
# Go to chrome://extensions
# Enable Developer Mode (top right)
# Click "Load unpacked"
# Select extension/dist folder
```

The ASTRA icon will appear in your Chrome toolbar. Click it to open the side panel.

---

## Configuration

### Backend .env File

```env
# Choose at least one LLM provider
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
FIREWORKS_API_KEY=fw-...
GROQ_API_KEY=gsk-...

# Vision model for screenshot analysis
VISION_MODEL=accounts/fireworks/models/qwen3-vl-30b-a3b-instruct

# Local LLM (optional)
OLLAMA_URL=http://localhost:11434
OLLAMA_MODEL=llama3.1:8b

# Database connections (if using Docker)
POSTGRES_URL=postgresql://nexus:nexus@localhost:5432/nexus
REDIS_URL=redis://localhost:6379
CHROMA_URL=http://localhost:8000

# Privacy mode
PRIVACY_MODE=cloud
```

### STT Setup (Voice Input)

- Get a free Groq API key at [console.groq.com](https://console.groq.com) (no card required)
- Add `GROQ_API_KEY` to `backend/.env`
- Optional: set `GROQ_WHISPER_MODEL=whisper-large-v3-turbo`
- Open the extension popup, click the mic button, and speak your command

---

## System Architecture

### Chrome Extension
- **Side Panel UI** – React + Tailwind for persistent chat interface
- **Background Worker** – Service worker handling messaging
- **Content Script** – DOM access and action execution (with shadow DOM support)

### Backend Server
- **Fastify API** – Fast HTTP server on port 3001
- **LLM Router** – Selects optimal provider based on task and availability
- **Page Intelligence** – Plans actions by analyzing page state
- **Vision System** – Understands screenshots and identifies elements
- **Critic Engine** – Validates actions and detects completion

### Memory Layers
- **Tier 1: Redis** → Fast working memory for current session
- **Tier 2: ChromaDB** → Semantic embeddings of past actions
- **Tier 3: PostgreSQL** → Long-term structured knowledge

---

## Supported Websites

ASTRA works on:
- ✅ **Streaming** – Netflix, Prime Video, Spotify, Disney+, Hulu
- ✅ **E-Commerce** – Amazon, eBay, Shopify stores
- ✅ **Search** – Google, YouTube, Bing
- ✅ **SPA Apps** – Any React, Vue, or Angular app with modern UI
- ✅ **Web Apps** – Forms, dashboards, admin panels
- ✅ **Shadow DOM** – Web components and encapsulated elements

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Extension won't open | Go to `chrome://extensions` → Reload ASTRA → Click its icon in toolbar |
| Clicks not working | Refresh the webpage. Reload extension to inject new content script |
| Text input failing | Check if element is visible. ASTRA handles shadow DOM, but try scrolling first |
| "Element not found" messages | Refresh page (DOM may have changed). ASTRA will retry automatically |
| Rate limit errors | Wait a moment. Backend automatically backs off and retries with delay |
| Wrong element selected | Check browser console for logs. ASTRA logs which fallback was used |

---

## Development

### Project Structure

```
ASTRA-Xtension/
├── backend/
│   ├── src/
│   │   ├── agents/        # AI agent logic
│   │   ├── routes/        # API endpoints
│   │   ├── services/      # LLM routing, web search
│   │   └── db/            # Database layer
│   ├── server.ts
│   └── package.json
├── extension/
│   ├── src/
│   │   ├── background/    # Service worker
│   │   ├── content/       # Content script (DOM access)
│   │   └── popup/         # UI components
│   ├── manifest.json
│   └── vite.config.ts
└── package.json
```

### Development Commands

```bash
# Backend
cd backend && npm run dev         # Auto-reload server
cd backend && npm run build       # Compile TypeScript

# Extension
cd extension && npm run build     # Production build
cd extension && npm run dev       # Watch mode
```

---

## Known Limitations

- **Single Tab** – Automates one tab at a time
- **File Uploads** – Cannot interact with file input fields yet
- **CAPTCHA** – Requires manual intervention
- **Highly Dynamic Sites** – May need additional wait time to load

---

## Contributing

We welcome contributions! Here's how:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/your-feature`)
3. Make your changes
4. Push to your branch (`git push origin feature/your-feature`)
5. Open a Pull Request

---

## License

MIT License – See LICENSE file for details.

---

## Acknowledgments

Built with:
- [Fastify](https://fastify.dev) – Fast, low-overhead web framework
- [Fireworks.ai](https://fireworks.ai) – Scalable vision and LLM inference
- [Groq](https://groq.com) – Ultra-fast inference engine
- [Ollama](https://ollama.ai) – Local private LLM inference
- [ChromaDB](https://www.trychroma.com) – Vector embedding storage
- [React](https://react.dev) – UI framework

---

## Support

For questions, bugs, or feature requests:

- 🐛 [Open an issue on GitHub](https://github.com/saikumargudelly/ASTRA-Xtension/issues)
- 📖 Check the troubleshooting section above
- 📋 Review backend logs: `tail -f /tmp/backend.log`

---

**Let ASTRA handle the web. You focus on what matters. 🚀**
