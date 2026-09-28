# Development & Workflow Guide

This document provides developer instructions for running, debugging, testing, and building **TradingVibe**.

---

## 1. Prerequisites

* **Node.js**: v18.0.0 or higher (v20+ recommended).
* **npm**: v9.0.0 or higher.
* Modern web browser with WebSocket and HTML5 Canvas support.

---

## 2. Getting Started

### 1. Install Dependencies
```bash
npm install
```

### 2. Environment Configuration
Copy `.env.example` to `.env`:
```bash
cp .env.example .env
```
Populate optional credentials:
* `OPENROUTER_API_KEY`: If using BYO AI capabilities with Claude 3.5 or GPT-4o.

### 3. Start Development Server
```bash
npm run dev
```
The application will launch on `http://localhost:3000/`.

---

## 3. Available NPM Scripts

| Command | Action |
|---|---|
| `npm run dev` | Starts Vite development server on port 3000 with hot reload. |
| `npm run build` | Compiles TypeScript and builds production bundles into `dist/`. |
| `npm run lint` | Runs `tsc --noEmit` to validate all TypeScript types and imports. |
| `npm run preview` | Previews the production build locally. |

---

## 4. Operational Modes

### 1. Mock / Paper Mode (Default Out-of-the-Box)
* Operates without requiring external broker credentials or live accounts.
* Historical bars are generated deterministically using `Mulberry32 PRNG`.
* Trades and bots run against simulated order fills with spreads and commissions.
* Status is clearly badged as `MOCK` or `DEMO`.

### 2. Hyperliquid WebSocket Mode
* Active when the Hyperliquid websocket is connected.
* Real `l2Book` bid/ask quotes stream into the market-data adapter.
* Status is badged as `LIVE` with millisecond ping latency.

### 3. OpenRouter AI Mode
* Active when a valid API key is saved in Settings → AI Provider.
* Streams live reasoning responses from Claude 3.5 Sonnet or GPT-4o.
* If no key is provided, the assistant offers helpful built-in algorithmic trading advice.

---

## 5. Testing & Verification Checklist

Before pushing changes:
1. Run `npm run lint` to guarantee zero TypeScript compilation errors.
2. Run `npm run build` to verify production bundling.
3. Test in mobile emulation mode (Chrome DevTools: iPhone 14 Pro / 393×852).
4. Verify that Trades is the central highlighted action in the bottom bar.
5. Verify that clicking the desktop profile area opens `ProfileView.tsx`.
