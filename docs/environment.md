# Environment Configuration

This document documents all environment variables used by **TradingVibe**.

---

## 1. Environment Template (`.env.example`)

```env
# APP_URL: The URL where the app is hosted.
# Used for self-referential links and API endpoints.
APP_URL="http://localhost:3000"

# VITE_HYPERLIQUID_NETWORK: mainnet (default) or testnet
VITE_HYPERLIQUID_NETWORK="mainnet"

# OpenRouter AI Provider (BYO Key)
OPENROUTER_API_KEY="your_openrouter_api_key_here"
```

TradingVibe requires no venue credentials: market data comes from Hyperliquid's
public endpoints.

---

## 2. Variable Descriptions & Sourcing

### `APP_URL`
* **Purpose**: Base URL used for self-referential links and API endpoints.
* **Development Value**: `http://localhost:3000`
* **Production Value**: Public HTTPS domain (e.g. `https://tradingvibe.app`).

### `VITE_HYPERLIQUID_NETWORK`
* **Purpose**: Selects the Hyperliquid network used for discovery, quotes, and candles.
* **Values**: `mainnet` (default) or `testnet`.

### `OPENROUTER_API_KEY`
* **Purpose**: API key for routing conversational AI queries to Claude 3.5 Sonnet, GPT-4o, or DeepSeek V3.
* **Where to Obtain**: [openrouter.ai/keys](https://openrouter.ai/keys).
* **Note**: In TradingVibe, users can also provide their personal BYO API key directly in the in-app Settings UI, which is saved securely in their browser's local storage.

---

## 3. Security Guidelines

* **Never commit `.env` with real credentials**: Only commit `.env.example` with placeholder strings.
* **No venue credentials exist**: there is no signing key, API secret, or account token to configure. Any future live execution must keep signing outside the browser.
* **Client-Side Storage**: In the client SPA, secrets are kept strictly isolated and never logged to console or telemetry.
