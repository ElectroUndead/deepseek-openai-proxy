# 🌐 DeepSeek OpenAI-Compatible Proxy (Cloudflare Workers)

Deploy your own private, 100% free OpenAI-compatible proxy for **DeepSeek R1 (Reasoning)** and **DeepSeek V3** on Cloudflare Workers.

Connect DeepSeek directly into **Cursor**, **VS Code / Cline**, **Roo Code**, **Continue**, **DeepSeek CLI (`dsh`)**, or any application using the OpenAI SDK.

---

## ✨ Features

- **100% Free Forever**: Runs on Cloudflare Workers free tier (100,000 requests/day).
- **Embedded WebAssembly PoW Solver**: Solves DeepSeek's `DeepSeekHashV1` Proof-of-Work challenge natively in Cloudflare edge isolates in ~300ms. No external servers or Python required.
- **Native Tool Calling (DSML)**: Intercepts DeepSeek's internal `<｜｜DSML｜｜ invoke>` markup and translates it to standard OpenAI `tool_calls`. Your coding agents (e.g. `dsh`, Cursor, Cline) can run terminal commands, view files, and edit code automatically.
- **Full Streaming Support**: SSE streaming with reasoning output delivered in `delta.reasoning_content`.
- **Completely Private**: Hosted on your own Cloudflare account. Your tokens and requests are never shared with anyone.

---

## 🚀 Quick Setup (3 Minutes)

### 1. Get Your DeepSeek Token

Use our 1-click bookmarklet on [https://deepseek-setup.antigravity-cloudflare-worker.workers.dev/](https://deepseek-setup.antigravity-cloudflare-worker.workers.dev/):
1. Drag the **⭐ DeepSeek Token Grabber** button to your browser bookmarks bar.
2. Open [chat.deepseek.com](https://chat.deepseek.com) and log in.
3. Click the bookmark to copy your token (`Bearer koeKUj...`).

---

### 2. Deploy to Cloudflare Workers

1. Clone this repository:
   ```bash
   git clone https://github.com/divyansh-shandilya/deepseek-openai-proxy.git
   cd deepseek-openai-proxy
   ```

2. Open `wrangler.toml` and paste your token:
   ```toml
   [vars]
   DEEPSEEK_AUTH_TOKEN = "Bearer your-token-from-step-1"
   ```

3. Login and deploy:
   ```bash
   npx wrangler login
   npx wrangler deploy
   ```

Wrangler will output your personal proxy URL:
```text
https://my-deepseek-proxy.<your-subdomain>.workers.dev
```

---

## 🛠️ IDE Configuration

### Cursor
1. Go to **Settings** $\rightarrow$ **Models** $\rightarrow$ **OpenAI**.
2. Toggle **Override OpenAI Base URL** and enter:
   ```text
   https://my-deepseek-proxy.<your-subdomain>.workers.dev/v1
   ```
3. Set **API Key** to: `sk-dummy` (or any text).
4. Add Model: `deepseek-reasoner` (or `deepseek-chat`).

---

### VS Code / Cline / Roo Code
- **Provider**: `OpenAI Compatible`
- **Base URL**: `https://my-deepseek-proxy.<your-subdomain>.workers.dev/v1`
- **API Key**: `dummy`
- **Model ID**: `deepseek-reasoner`

---

### DeepSeek CLI (`dsh`)
```bash
export OPENAI_BASE_URL="https://my-deepseek-proxy.<your-subdomain>.workers.dev/v1"
export OPENAI_API_KEY="dummy"

# Run terminal agent with full tool & command execution
dsh
```

---

### Python SDK
```python
from openai import OpenAI

client = OpenAI(
    base_url="https://my-deepseek-proxy.<your-subdomain>.workers.dev/v1",
    api_key="dummy"
)

response = client.chat.completions.create(
    model="deepseek-reasoner",
    messages=[{"role": "user", "content": "Explain quantum computing in 3 bullets."}],
    stream=True
)

for chunk in response:
    # Reasoning chain-of-thought
    if hasattr(chunk.choices[0].delta, 'reasoning_content') and chunk.choices[0].delta.reasoning_content:
        print(chunk.choices[0].delta.reasoning_content, end="")
    # Final answer
    if chunk.choices[0].delta.content:
        print(chunk.choices[0].delta.content, end="")
```

```

---

## Running Locally (freeseek CLI)

If you prefer running the proxy directly on your machine without Cloudflare edge CPU limits:

```bash
# 1. Run directly from this repo:
npm start

# 2. Or run globally from any terminal:
npm link
freeseek start
```

Cursor Configuration:
- Base URL: `http://127.0.0.1:8787/v1`
- API Key: your DeepSeek token
- Model: `deepseek-reasoner` or `deepseek-chat`

---

## License
MIT License. Free for personal and commercial use.
