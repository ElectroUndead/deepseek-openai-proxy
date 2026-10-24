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
3. Set **OpenAI API Key**: your **DeepSeek session token** (grab it with the bookmarklet on the setup hub). This is the credential the proxy uses to call DeepSeek on your behalf.

   > `dummy` also works **only if** you already saved a token locally (`~/.freeseek/config.json`) — the proxy then falls back to that stored token. That fallback is what makes `dummy` appear to "work"; it is not a real API key.
4. Add Model: `deepseek-reasoner` (or `deepseek-chat`).

---

### VS Code / Cline / Roo Code / Continue
- **Provider**: `OpenAI Compatible`
- **Base URL**: `http://127.0.0.1:8787/v1`
- **API Key**: your DeepSeek session token (or `dummy` if a token is already saved in `~/.freeseek/config.json`)
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

## Security & Network Exposure

Your DeepSeek session token is stored in plaintext at `~/.freeseek/config.json` on your own machine. It is never sent anywhere except `chat.deepseek.com`.

**Default bind address:** `127.0.0.1` (loopback only — nothing on your network can reach it).

If you set `HOST` (or run the Docker image, which sets `HOST=0.0.0.0`), the proxy listens on **all interfaces**. That means:

- **Anyone on your LAN can use your DeepSeek account** through the proxy. There is no auth gate: a client that sends `dummy` (or any placeholder / short string) is served using the token stored in **your** `~/.freeseek/config.json`. They don't need to know your token — `dummy` is enough.
- Every request they make is billed to and rate-limited against *your* DeepSeek session.
- If you port-forward it, anyone on the internet can do the same.

Only bind to `0.0.0.0` on a network you trust, and never expose the port publicly without putting an authenticating reverse proxy in front of it.

```bash
# loopback only (default)
freeseek

# all interfaces — required inside Docker, risky on a laptop
HOST=0.0.0.0 freeseek
```

---

## Scope & Caveats

This proxy talks to DeepSeek's **consumer web API** (`chat.deepseek.com`) using a session token taken from your browser — not the official DeepSeek platform API. Practical consequences:

- DeepSeek can change their internal API or anti-bot challenge at any time, which will break the proxy until it's updated.
- Automated use of a consumer session may violate DeepSeek's Terms of Service and can result in your account being limited or banned.
- "No rate limits" refers to the absence of an API billing quota — DeepSeek's own web-side throttling still applies.

Use it on your own account and at your own discretion.

---

## License
MIT License. See [LICENSE](LICENSE).
