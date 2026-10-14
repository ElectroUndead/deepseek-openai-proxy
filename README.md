# freeseek - Local DeepSeek OpenAI-Compatible Proxy

Free, fast local proxy for **DeepSeek R1 (Reasoning)** and **DeepSeek V3**.

Connect DeepSeek directly into **Cursor**, **VS Code / Cline**, **Roo Code**, **Continue**, or any OpenAI SDK application with zero rate limits and zero cost.

---

## Why freeseek

- **Fast & Direct**: Runs directly on your computer with zero cloud timeouts or server slowdowns.
- **Full Coding Agent Support**: Seamlessly translates tool calls (file reading, terminal execution, code editing) for Cursor, VS Code, Cline, and Continue.
- **Privacy First**: Your token and requests are stored locally on your machine and never pass through third-party servers.
- **100% Free**: No subscription or credit card needed.

---

## Quick Setup (1 Command)

### 1. Download / Install
```bash
npm install -g freeseek
```
*(Windows alternative: You can also clone this repository and double-click `start.bat`)*

### 2. Start the Server
```bash
freeseek
```

### 3. Check Server Status
Open the setup hub at [https://deepseek-setup.antigravity-cloudflare-worker.workers.dev](https://deepseek-setup.antigravity-cloudflare-worker.workers.dev) or test your endpoint directly:
```bash
curl http://127.0.0.1:8787/health
```

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
