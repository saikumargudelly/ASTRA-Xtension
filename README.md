# ASTRA – Multi-Agent Browser Automation Assistant

<p align="center">
  <img src="extension/public/icons/icon128.png" alt="ASTRA Logo" width="128" height="128" />
</p>

<p align="center">
  <a href="https://chromewebstore.google.com"><img src="https://img.shields.io/badge/Chrome-Extension-blue?style=flat&logo=google-chrome" alt="Chrome Extension" /></a>
  <a href="https://www.typescript.org"><img src="https://img.shields.io/badge/TypeScript-5.7-blue?style=flat&logo=typescript" alt="TypeScript" /></a>
  <a href="https://fastify.dev"><img src="https://img.shields.io/badge/Fastify-5.1-purple?style=flat" alt="Fastify" /></a>
  <a href="https://react.dev"><img src="https://img.shields.io/badge/React-18-cyan?style=flat&logo=react" alt="React" /></a>
  <a href="https://fireworks.ai"><img src="https://img.shields.io/badge/Powered%20by-Multi--LLM%20Router-orange?style=flat" alt="Multi-LLM via Router" /></a>
</p>

---

## 📋 Table of Contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [Features](#features)
4. [Quick Start](#quick-start)
5. [Installation](#installation)
6. [Configuration](#configuration)
7. [Usage Guide](#usage-guide)
8. [API Reference](#api-reference)
9. [Agent System](#agent-system)
10. [Memory Architecture](#memory-architecture)
11. [Troubleshooting](#troubleshooting)

---

## 🔭 Overview

**ASTRA** is an innovative AI browser assistant that natively integrates into Chrome as a **Persistent Side Panel**, empowering users to automate workflows alongside their active browsing session. ASTRA connects to the powerful **NEXUS Backend** – a multi-agent execution engine capable of dynamically routing across various top-tier LLMs (Anthropic, OpenAI, Fireworks, Groq, Ollama) and storing cross-session semantic memories.

### What ASTRA Does

ASTRA processes natural language goals into real, executable DOM actions leveraging strict React-safe execution loops, automated scrolling, intent decomposition, and screenshot vision analysis. 

```
User: "Search Netflix for Interstellar and play it"
         │
         ▼
    ┌──────────────┐
    │ NEXUS ROUTER │ ← Multi-LLM provider routing
    │   (& LLMs)   │
    └──────────────┘
         │
         ▼
    ┌──────────────┐
    │ PAGE INTEL & │ ← Intent chunking, vision heuristics, Goal evaluation
    │ EXECUTION    │   
    └──────────────┘
         │
         ▼
    ┌──────────────┐
    │ Chrome Panel │ ← Safe DOM Execution (React bypasses, Event bubbling)
    │ & Content    │
    └──────────────┘
```

---

## 🏗️ Architecture

### System Overview

```mermaid
graph TB
    subgraph "Chrome Extension (ASTRA)"
        UI[Side Panel UI<br/>React + Tailwind]
        BG[Background<br/>Service Worker]
        CS[React-Safe Content Script<br/>DOM Controller]
    end
    
    subgraph "NEXUS Backend Server"
        API[Fastify API<br/>Port 3001]
        
        subgraph "Agent Registry"
            PI[Page Intelligence]
            CR[Critic & Eval]
            WR[Web Researcher]
            VS[Vision Analyzer]
            WK[Walkthroughs]
        end
        
        subgraph "3-Tier Memory System"
            RD[Tier 1: Redis<br/>Working Memory]
            CH[Tier 2: ChromaDB<br/>Episodic]
            PG[Tier 3: PostgreSQL<br/>Semantic]
        end
        
        LLM[LLM Router<br/>Anthropic, OpenAI,<br/>Fireworks, Groq, Ollama]
    end
    
    UI <--> BG
    BG <--> API
    CS <--> BG
    API <--> PI
    API <--> CR
    API <--> WR
    API <--> VS
    PI --> LLM
    CR --> LLM
    VS --> LLM
    RD <--> API
    CH <--> API
    PG <--> API
```

### Key Technical Distinctions
- **SPA Safety**: Extensively modeled native `input` / `change` event dispatchers safely sidestep heavily controlled DOM overrides on modern React/Vue applications (e.g. Amazon Prime Video, Netflix).
- **Graceful Rate Limits**: Parses header delays (ex: Groq 429s, 413s) to apply mathematically precise backend sleeps before attempting automatic multi-retry loops.
- **Side Panel First**: Replaces traditional popups with Chrome’s `sidePanel` API to persist chat state across page reloads and window shifts.

---

## ✨ Features

### Core Capabilities

| Feature | Description |
|---------|-------------|
| **Multi-LLM Fallback Router** | Intelligently falls back from complex models (Anthropic) to lighter ones based on rate limits, handling tasks (Vision vs Planning) using appropriate vendors (e.g. Fireworks for Vision). |
| **React-Safe Actions** | Input fields leverage direct Property Descriptor bypasses to natively fill forms on stubborn SPAs. |
| **Robust Enter Key Simulation** | Real-world simulation of `KeyboardEvent` propagation combined with composed inputs to trigger difficult interactive menus. |
| **Screenshot Vision Feedback** | Re-sends rendered screenshots back to the pipeline to ensure the engine knows precisely what UI elements loaded dynamically. |
| **3-Tier Persistent Memory** | Context persists seamlessly from fast temporary Redis all the way to long-term SQL-backed pgvector knowledge graphs. |
| **Chrome Side Panel** | Always open alongside your active browsing space. |

### Advanced Page Skills

```javascript
// Smart DOM Skills
press_enter, fill_form, hover, click, type
range-set, extract_data, select_option

// Page State Skills
analyze_page, wait_for, scroll_to
```

---

## 🚀 Quick Start

### Prerequisites

- **Node.js** 18+ 
- **npm** 9+
- **Chrome** browser
- LLM API Key (Anthropic, OpenAI, Fireworks, or Groq)
- **Docker** (Optional, for running Redis and Postgres memories)

### 5-Minute Setup

```bash
# 1. Clone the repository
git clone https://github.com/saikumargudelly/ASTRA-Xtension.git
cd ASTRA-Xtension

# 2. Setup the Data Layers (Optional but recommended)
docker-compose up -d

# 3. Configure backend
cd backend
npm install
cp .env.example .env
# Open .env and insert an API key for your preferred provider

# 4. Start the NEXUS execution engine
npm run dev

# 5. Build the extension
cd ../extension
npm install
npm run build 

# 6. Load in Chrome
# Open chrome://extensions → Enable Developer Mode
# → Load Unpacked → Select "extension/dist"
```

---

## ⚙️ Configuration

### `.env` Structure (Backend)

ASTRA supports fluid swapping of providers. A typical `.env` configuration requires at least one primary model key, and optimally a vision tier:

```env
# Primary (planning, reasoning, code)
ANTHROPIC_API_KEY=sk-ant-
OPENAI_API_KEY=sk-

# Vision tasks (falls back to Fireworks if not set)
VISION_MODEL=accounts/fireworks/models/qwen3-vl-30b-a3b-instruct
FIREWORKS_API_KEY=fw-

# Privacy Mode (cloud, hybrid, local-only)
PRIVACY_MODE=cloud

# Local LLMs (Ollama)
OLLAMA_URL=http://localhost:11434
OLLAMA_MODEL=llama3.1:8b

# Databases (Docker-compose default ports)
POSTGRES_URL=postgresql://nexus:nexus@localhost:5432/nexus
REDIS_URL=redis://localhost:6379
CHROMA_URL=http://localhost:8000
```

---

## 🤖 Agent System

The NEXUS backend uses a specialized agent registry over monolithic parsing to distribute complex browsing logic:

1. **Page Intelligence** (`pageIntelligence.ts`): Re-evaluates active DOMs in a ReAct loop. Decides the next step against the current goal using HTML snapshots.
2. **Page State Controller** (`pageState.ts`): Asserts if UI states represent Captchas, Login hurdles, or generic browsing.
3. **Critic & Evaluator** (`critic.ts`, `goalEvaluator.ts`): Sanity checks actions before they execute and dynamically gauges real-time success matrices to prevent looping.
4. **Error Taxonomy** (`errorTaxonomy.ts`): Intelligently categorizes failures. A 413 Payload too Large from Vision instantly trims screenshots rather than blind-retrying. 429s automatically trigger Sleep + Fallback flows.
5. **Walkthrough Generator** (`walkthroughGenerator.ts`): Converts successfully completed commands into reusable Markdown/SOP formats.

---

## 🧠 Memory Architecture (3-Tier)

ASTRA operates using structured, human-like tiers of memory to guarantee high performance without exhausting context tokens:

- **Tier 1 (Working Memory / Redis)**: Stores rapidly changing state. Active DOM bounds, immediate user prompt logs, intent signals. It's cleared or heavily compacted when you finish a session.
- **Tier 2 (Episodic Memory / ChromaDB)**: High-dimensional semantic embeddings of previous actions, failed strategies, and raw web snippets to perform RAG-style augmentations for future similar requests.
- **Tier 3 (Semantic Memory / PostgreSQL)**: Immutable, trusted structured data (User preferences, pre-approved credentials, system knowledge schemas).

---

## 🐛 Troubleshooting

### Common Issues

#### `413 Payload Too Large` from Groq / Text Providers
**Cause**: The router attempted to send the massive page `<canvas>/base64` screenshot to a text-only model fallback.
**Fix**: Ensure your `FIREWORKS_API_KEY` is loaded and `VISION_MODEL` is declared. Vision tasks have been hard-locked to prevent falling back to text-only providers to prevent this.

#### Chrome Side panel won't open
**Cause**: In dev mode, the extension may fall out of sync.
**Fix**: Go to `chrome://extensions` and click the curved Reload icon on the ASTRA card. Then, click the ASTRA extension icon in the toolbar natively (do NOT use a keyboard shortcut the first time) to prompt the setPanelBehavior.

#### Keystrokes ignored on Prime Video/Netflix
**Cause**: Old popup scripts are retained by the current tab instances cache. 
**Fix**: Refresh the Netflix/Prime Video tab after reloading the extension within `chrome://extensions` to inject the new `content_script.ts` which uses React-safe descriptors.

---

## 📄 License & Acknowledgements

MIT License - See LICENSE file for details.

- [Fireworks.ai](https://fireworks.ai) - Scalable Vision/LLM serving
- [Groq](https://groq.com) - LPU high speed inference
- [Ollama](https://ollama.ai) - Local privacy inference
- [Fastify](https://fastify.dev) - Low latency Web framework 
