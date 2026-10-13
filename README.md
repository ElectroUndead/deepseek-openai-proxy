# freeseek - Local DeepSeek OpenAI-Compatible Proxy

High-performance local proxy for **DeepSeek R1 (Reasoning)** and **DeepSeek V3** with native WebAssembly Proof-of-Work (PoW) solving and DSML tool calling.

Connect DeepSeek directly into **Cursor**, **VS Code / Cline**, **Roo Code**, **Continue**, or any OpenAI SDK application with zero latency, zero cloud limits, and zero cost.

---

## Why freeseek Runs Locally

DeepSeek requires solving cryptographic Proof-of-Work (PoW) challenges for every message. Cloudflare Workers and serverless platforms have strict 10ms CPU limits that cause frequent timeouts, glitches, and 503 errors when attempting to solve challenges.

Running `freeseek` locally runs directly on your computer's CPU:
- **Zero Limits**: Solves PoW challenges via native WebAssembly in milliseconds.
- **Zero Cloud Costs & No Server Crashes**: Eliminates centralized server bottlenecks.
- **Full DSML Tool Calling**: Intercepts DeepSeek's internal `<||DSML|| invoke>` markup and translates it to standard OpenAI `tool_calls`. Coding agents can execute terminal commands, view files, and edit code automatically.
- **Privacy First**: Your token and requests are stored locally on your machine and never pass through third-party servers.

---

## Quick Setup (1 Command)

### Option 1: Run via npx (Zero Installation)
```bash
npx freeseek
```

### Option 2: Clone and Run
```bash
git clone https://github.com/divyansh-shandilya/deepseek-openai-proxy.git
cd deepseek-openai-proxy
npm start
```
*Windows users: You can also double-click `start.bat`.*

---

## 3-Step Setup Workflow

1. **Launch**: Running `npx freeseek` starts the local server and automatically opens `http://127.0.0.1:8787` in your browser.
2. **Sync Token**: Click **Open chat.deepseek.com** and sign in. Drag the **Sync Token with Local Freeseek** bookmarklet to your bookmarks bar and click it once on `chat.deepseek.com`. Your token is saved locally to `~/.freeseek/config.json`.
3. **Configure IDE**: In your editor, configure the OpenAI provider using the values below.

---

## IDE Configuration

### Cursor
1. Go to **Settings** -> **Models** -> **OpenAI**.
2. Turn ON **Override OpenAI Base URL**:
   ```text
   http://127.0.0.1:8787/v1
   ```
3. Set **OpenAI API Key**: `dummy` (any text works, as credentials are managed locally).
4. Add Model: `deepseek-reasoner` (or `deepseek-chat`).

---

### VS Code / Cline / Roo Code / Continue
- **Provider**: `OpenAI Compatible`
- **Base URL**: `http://127.0.0.1:8787/v1`
- **API Key**: `dummy`
- **Model ID**: `deepseek-reasoner`

---

### Python SDK
```python
from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:8787/v1",
    api_key="dummy"
)

response = client.chat.completions.create(
    model="deepseek-reasoner",
    messages=[{"role": "user", "content": "Explain quantum computing in 3 bullets."}],
    stream=True
)

for chunk in response:
    if hasattr(chunk.choices[0].delta, 'reasoning_content') and chunk.choices[0].delta.reasoning_content:
        print(chunk.choices[0].delta.reasoning_content, end="")
    if chunk.choices[0].delta.content:
        print(chunk.choices[0].delta.content, end="")
```

---

## Online Web Setup Hub
Visit the online guide at:
[https://deepseek-setup.antigravity-cloudflare-worker.workers.dev](https://deepseek-setup.antigravity-cloudflare-worker.workers.dev)

---

## License
MIT License. Free for personal and commercial use.
