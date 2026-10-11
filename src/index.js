import wasmModule from "./sha3_wasm_v1.wasm";

// Solve PoW challenge using WebAssembly (for self-hosted private deployments)
async function solveDeepSeekPoW(challengeObj) {
  const instance = await WebAssembly.instantiate(wasmModule, {});
  const { memory, wasm_solve, __wbindgen_add_to_stack_pointer, __wbindgen_export_0: alloc } = instance.exports;

  const { challenge, salt, difficulty, expire_at } = challengeObj;
  const prefix = `${salt}_${expire_at}_`;

  const encoder = new TextEncoder();
  const challengeBytes = encoder.encode(challenge);
  const prefixBytes = encoder.encode(prefix);

  const challengePtr = alloc(challengeBytes.length, 1);
  new Uint8Array(memory.buffer, challengePtr, challengeBytes.length).set(challengeBytes);

  const prefixPtr = alloc(prefixBytes.length, 1);
  new Uint8Array(memory.buffer, prefixPtr, prefixBytes.length).set(prefixBytes);

  const stackRetPtr = __wbindgen_add_to_stack_pointer(-16);

  try {
    wasm_solve(stackRetPtr, challengePtr, challengeBytes.length, prefixPtr, prefixBytes.length, Number(difficulty));
    const dataView = new DataView(memory.buffer);
    const status = dataView.getInt32(stackRetPtr, true);
    if (status === 0) {
      throw new Error("WASM failed to solve PoW challenge");
    }
    const answer = dataView.getFloat64(stackRetPtr + 8, true);
    return Math.floor(answer);
  } finally {
    __wbindgen_add_to_stack_pointer(16);
  }
}

function getCorsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "*",
  };
}

// DSML Tool Calling Parser
function parseDSML(text) {
  if (!text) return null;
  const norm = text.replace(/｜/g, "|");

  const callsMatch = norm.match(/<\|+DSML\|+\s*(?:calls|tool_calls)[^>]*>([\s\S]*?)<\/\|+DSML\|+\s*(?:calls|tool_calls)[^>]*>/i);
  if (!callsMatch) return null;

  const contentBefore = norm.substring(0, callsMatch.index).trim();
  const inner = callsMatch[1];

  const toolCalls = [];
  const invokeRegex = /<\|+DSML\|+\s*invoke\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/\|+DSML\|+\s*invoke[^>]*>/gi;
  let invMatch;
  let idx = 0;

  while ((invMatch = invokeRegex.exec(inner)) !== null) {
    const name = invMatch[1];
    const paramsBlock = invMatch[2];

    const params = {};
    const paramRegex = /<\|+DSML\|+\s*parameter\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/\|+DSML\|+\s*parameter[^>]*>/gi;
    let pMatch;
    while ((pMatch = paramRegex.exec(paramsBlock)) !== null) {
      const pName = pMatch[1];
      const pVal = pMatch[2].trim();
      try {
        params[pName] = JSON.parse(pVal);
      } catch {
        params[pName] = pVal;
      }
    }

    toolCalls.push({
      index: idx++,
      id: "call_" + crypto.randomUUID().replace(/-/g, "").substring(0, 10),
      type: "function",
      function: {
        name: name,
        arguments: JSON.stringify(params),
      },
    });
  }

  return { contentBefore, toolCalls };
}

function formatPromptWithTools(messages, tools) {
  let promptParts = [];

  if (tools && tools.length > 0) {
    const toolsDesc = JSON.stringify(tools, null, 2);
    promptParts.push(
      `[SYSTEM INSTRUCTION: TOOLS AVAILABLE]\nYou have access to the following tools:\n${toolsDesc}\n\n` +
      `When you need to execute a tool, write your response in this exact format:\n` +
      `<｜｜DSML｜｜ calls>\n` +
      `<｜｜DSML｜｜ invoke name="tool_name">\n` +
      `<｜｜DSML｜｜ parameter name="arg_name" string="true">value</｜｜DSML｜｜ parameter>\n` +
      `</｜｜DSML｜｜ invoke>\n` +
      `</｜｜DSML｜｜ calls>\n`
    );
  }

  for (const m of messages) {
    const role = (m.role || "user").toUpperCase();
    if (m.role === "tool") {
      promptParts.push(`[TOOL RESULT for ${m.name || m.tool_call_id}]:\n${m.content}`);
    } else if (m.tool_calls && m.tool_calls.length > 0) {
      const callsStr = m.tool_calls
        .map((t) => `${t.function.name}(${t.function.arguments})`)
        .join(", ");
      promptParts.push(`ASSISTANT (Tool Invocations): ${callsStr}`);
      if (m.content) promptParts.push(`ASSISTANT: ${m.content}`);
    } else {
      promptParts.push(`${role}: ${m.content}`);
    }
  }

  return promptParts.join("\n\n");
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: getCorsHeaders() });
    }

    // Health check
    if (url.pathname === "/health" || url.pathname === "/api/status") {
      return new Response(JSON.stringify({ status: "ok", service: "deepseek-setup-assistant" }), {
        headers: { "Content-Type": "application/json", ...getCorsHeaders() },
      });
    }

    // Completions endpoint
    if (url.pathname === "/v1/chat/completions" || url.pathname === "/chat/completions") {
      if (request.method !== "POST") {
        return new Response("Method Not Allowed", { status: 405, headers: getCorsHeaders() });
      }

      // Check if self-hosted with private credentials
      if (env.DEEPSEEK_AUTH_TOKEN && env.DEEPSEEK_AUTH_TOKEN.length > 20) {
        try {
          const body = await request.json();
          return await handleChatCompletion(body, env);
        } catch (err) {
          return new Response(
            JSON.stringify({ error: { message: err.message || "Proxy Error", type: "proxy_error" } }),
            { status: 500, headers: { "Content-Type": "application/json", ...getCorsHeaders() } }
          );
        }
      }

      // On our public setup guide, shared hosting is intentionally disabled to avoid cross-user rate limits
      return new Response(
        JSON.stringify({
          error: {
            message: "Hosting completions on this shared setup server is disabled to protect your privacy and prevent shared rate limits. Please complete Step 2 on the setup page to deploy your own free private worker!",
            type: "self_host_required",
          },
        }),
        { status: 403, headers: { "Content-Type": "application/json", ...getCorsHeaders() } }
      );
    }

    // Models list
    if (url.pathname === "/v1/models" || url.pathname === "/models") {
      return new Response(
        JSON.stringify({
          object: "list",
          data: [
            { id: "deepseek-reasoner", object: "model", created: 1700000000, owned_by: "deepseek" },
            { id: "deepseek-chat", object: "model", created: 1700000000, owned_by: "deepseek" },
          ],
        }),
        { headers: { "Content-Type": "application/json", ...getCorsHeaders() } }
      );
    }

    // Serve the clean, white-themed, 1-step-at-a-time setup wizard
    return new Response(renderSetupHtml(), {
      headers: { "Content-Type": "text/html; charset=utf-8", ...getCorsHeaders() },
    });
  },
};

// Completion handler used when user deploys their own private worker
async function handleChatCompletion(body, env) {
  const messages = body.messages || [];
  const tools = body.tools || [];
  const isStream = body.stream === true;
  const model = body.model || "deepseek-reasoner";
  const thinkingEnabled = !model.includes("chat") || model.includes("r1") || model.includes("reasoner");

  const prompt = formatPromptWithTools(messages, tools);

  const token = env.DEEPSEEK_AUTH_TOKEN;
  const wafToken = env.AWS_WAF_TOKEN || "";
  const sessionIdCookie = env.DS_SESSION_ID || "";
  const cookieHeader = `smidV2=20260902181842a81f173d2e1128d055a3ec9480855c92002427af5dfc76c30; aws-waf-token=${wafToken}; ds_session_id=${sessionIdCookie}`;

  const baseHeaders = {
    "accept": "*/*",
    "accept-language": "en-US,en;q=0.9",
    "authorization": token,
    "content-type": "application/json",
    "origin": "https://chat.deepseek.com",
    "referer": "https://chat.deepseek.com/",
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36",
    "cookie": cookieHeader,
    "x-client-platform": "web",
    "x-client-version": "2.5.0",
  };

  const sessResp = await fetch("https://chat.deepseek.com/api/v0/chat_session/create", {
    method: "POST",
    headers: baseHeaders,
    body: JSON.stringify({}),
  });
  const sessData = await sessResp.json();
  if (sessData.code !== 0) {
    throw new Error(`Failed to create DeepSeek session: ${sessData.msg || "Unknown error"}`);
  }
  const sessionId = sessData.data.biz_data.chat_session.id;

  const powResp = await fetch("https://chat.deepseek.com/api/v0/chat/create_pow_challenge", {
    method: "POST",
    headers: baseHeaders,
    body: JSON.stringify({ target_path: "/api/v0/chat/completion" }),
  });
  const powData = await powResp.json();
  if (powData.code !== 0) {
    throw new Error(`Failed to get PoW challenge: ${powData.msg || "Unknown error"}`);
  }
  const challengeObj = powData.data.biz_data.challenge;

  const answer = await solveDeepSeekPoW(challengeObj);

  const powResponsePayload = {
    algorithm: challengeObj.algorithm,
    challenge: challengeObj.challenge,
    salt: challengeObj.salt,
    answer: answer,
    signature: challengeObj.signature,
    target_path: challengeObj.target_path,
  };
  const powHeaderValue = btoa(JSON.stringify(powResponsePayload));

  const completionHeaders = {
    ...baseHeaders,
    "referer": `https://chat.deepseek.com/a/chat/s/${sessionId}`,
    "x-ds-pow-response": powHeaderValue,
  };

  const completionPayload = {
    chat_session_id: sessionId,
    parent_message_id: null,
    prompt: prompt,
    ref_file_ids: [],
    thinking_enabled: thinkingEnabled,
    search_enabled: false,
  };

  const dsResponse = await fetch("https://chat.deepseek.com/api/v0/chat/completion", {
    method: "POST",
    headers: completionHeaders,
    body: JSON.stringify(completionPayload),
  });

  if (!dsResponse.ok) {
    const errorText = await dsResponse.text();
    throw new Error(`DeepSeek completion error: HTTP ${dsResponse.status} - ${errorText}`);
  }

  const completionId = "chatcmpl-" + crypto.randomUUID().replace(/-/g, "").substring(0, 16);
  const createdTimestamp = Math.floor(Date.now() / 1000);

  if (isStream) {
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();

    (async () => {
      const reader = dsResponse.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let dsmlStreamBuffer = "";

      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop();

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const jsonStr = line.substring(6).trim();
            if (!jsonStr) continue;

            try {
              const chunk = JSON.parse(jsonStr);
              const choices = chunk.choices || [];
              if (choices.length === 0) continue;
              const delta = choices[0].delta || {};

              if (delta.type === "thinking" && delta.content) {
                await emitStreamDelta(writer, encoder, completionId, model, createdTimestamp, "THINK", delta.content);
              } else if (delta.type === "text" && delta.content) {
                dsmlStreamBuffer += delta.content;
                if (!dsmlStreamBuffer.includes("<｜") && !dsmlStreamBuffer.includes("<|")) {
                  await emitStreamDelta(writer, encoder, completionId, model, createdTimestamp, "TEXT", dsmlStreamBuffer);
                  dsmlStreamBuffer = "";
                }
              }
            } catch (e) {}
          }
        }

        if (dsmlStreamBuffer.length > 0) {
          const parsed = parseDSML(dsmlStreamBuffer);
          if (parsed && parsed.toolCalls && parsed.toolCalls.length > 0) {
            if (parsed.contentBefore) {
              await emitStreamDelta(writer, encoder, completionId, model, createdTimestamp, "TEXT", parsed.contentBefore);
            }
            const tcChunk = {
              id: completionId,
              object: "chat.completion.chunk",
              created: createdTimestamp,
              model: model,
              choices: [
                {
                  index: 0,
                  delta: { role: "assistant", tool_calls: parsed.toolCalls },
                  finish_reason: "tool_calls",
                },
              ],
            };
            await writer.write(encoder.encode(`data: ${JSON.stringify(tcChunk)}\n\n`));
          } else {
            await emitStreamDelta(writer, encoder, completionId, model, createdTimestamp, "TEXT", dsmlStreamBuffer);
          }
        }

        await writer.write(encoder.encode("data: [DONE]\n\n"));
      } finally {
        await writer.close();
      }
    })();

    return new Response(readable, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        ...getCorsHeaders(),
      },
    });
  }

  // Non-streaming
  const fullText = await dsResponse.text();
  const lines = fullText.split("\n");
  let responseAccumulated = "";
  let thinkAccumulated = "";

  for (const line of lines) {
    if (!line.startsWith("data: ")) continue;
    const jsonStr = line.substring(6).trim();
    if (!jsonStr) continue;

    try {
      const chunk = JSON.parse(jsonStr);
      const choices = chunk.choices || [];
      if (choices.length === 0) continue;
      const delta = choices[0].delta || {};

      if (delta.type === "thinking" && delta.content) {
        thinkAccumulated += delta.content;
      } else if (delta.type === "text" && delta.content) {
        responseAccumulated += delta.content;
      }
    } catch (e) {}
  }

  const dsml = parseDSML(responseAccumulated);
  let messageObj;
  if (dsml && dsml.toolCalls && dsml.toolCalls.length > 0) {
    messageObj = {
      role: "assistant",
      content: dsml.contentBefore || null,
      tool_calls: dsml.toolCalls,
      reasoning_content: thinkAccumulated || null,
    };
  } else {
    messageObj = {
      role: "assistant",
      content: responseAccumulated || thinkAccumulated,
      reasoning_content: thinkAccumulated || null,
    };
  }

  return new Response(
    JSON.stringify({
      id: completionId,
      object: "chat.completion",
      created: createdTimestamp,
      model: model,
      choices: [
        {
          index: 0,
          message: messageObj,
          finish_reason: dsml && dsml.toolCalls.length > 0 ? "tool_calls" : "stop",
        },
      ],
      usage: {
        prompt_tokens: Math.max(1, Math.floor(prompt.length / 4)),
        completion_tokens: Math.max(1, Math.floor((responseAccumulated.length + thinkAccumulated.length) / 4)),
        total_tokens: Math.max(2, Math.floor((prompt.length + responseAccumulated.length + thinkAccumulated.length) / 4)),
      },
    }),
    { headers: { "Content-Type": "application/json", ...getCorsHeaders() } }
  );
}

async function emitStreamDelta(writer, encoder, completionId, model, created, fragmentType, text) {
  const delta = {};
  if (fragmentType === "THINK") {
    delta.reasoning_content = text;
  } else {
    delta.content = text;
  }

  const chunk = {
    id: completionId,
    object: "chat.completion.chunk",
    created: created,
    model: model,
    choices: [{ index: 0, delta: delta, finish_reason: null }],
  };
  await writer.write(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
}

// -----------------------------------------------------------------------------
// MINIMALIST, WHITE-THEMED, 1-STEP-AT-A-TIME SETUP GUIDE (BLACK & WHITE ONLY)
// -----------------------------------------------------------------------------
function renderSetupHtml() {
  const bookmarkletCode = `javascript:(function(){try{let t='';const raw=localStorage.getItem('userToken');if(raw){try{t=JSON.parse(raw).value||raw;}catch(e){t=raw;}}if(!t)return alert('No active DeepSeek session found! Please log in on chat.deepseek.com first.');if(!t.startsWith('Bearer '))t='Bearer '+t;navigator.clipboard.writeText(t);alert('✓ Copied DeepSeek Token to clipboard!\\nNow return to the setup guide and paste in Step 1.');}catch(e){alert('Error copying token: '+e);}})();`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>DeepSeek Private Proxy Setup</title>
  <style>
    :root {
      --bg: #ffffff;
      --card-bg: #ffffff;
      --border: #e5e5e5;
      --border-dark: #111111;
      --text: #0a0a0a;
      --text-muted: #666666;
      --text-subtle: #888888;
      --code-bg: #f9f9f9;
      --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      --font-mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg);
      color: var(--text);
      font-family: var(--font-sans);
      line-height: 1.5;
      padding: 48px 20px 80px 20px;
      display: flex;
      flex-direction: column;
      align-items: center;
      min-height: 100vh;
    }
    .container {
      width: 100%;
      max-width: 680px;
    }
    .header {
      margin-bottom: 32px;
      text-align: left;
    }
    .badge {
      display: inline-block;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.8px;
      padding: 3px 8px;
      border: 1px solid var(--border-dark);
      border-radius: 4px;
      margin-bottom: 12px;
      color: var(--text);
    }
    h1 {
      font-size: 26px;
      font-weight: 700;
      letter-spacing: -0.5px;
      color: var(--text);
      margin-bottom: 6px;
    }
    .subtitle {
      font-size: 14px;
      color: var(--text-muted);
    }
    /* Stepper Navigation */
    .stepper {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 32px;
      padding-bottom: 20px;
      border-bottom: 1px solid var(--border);
    }
    .step-item {
      display: flex;
      align-items: center;
      gap: 8px;
      cursor: pointer;
    }
    .step-num {
      width: 24px;
      height: 24px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 12px;
      font-weight: 600;
      background: #f0f0f0;
      color: var(--text-subtle);
      border: 1px solid var(--border);
      transition: all 0.15s ease;
    }
    .step-item.active .step-num {
      background: #000000;
      color: #ffffff;
      border-color: #000000;
    }
    .step-item.completed .step-num {
      background: #ffffff;
      color: #000000;
      border-color: #000000;
    }
    .step-name {
      font-size: 13px;
      font-weight: 500;
      color: var(--text-muted);
    }
    .step-item.active .step-name {
      color: var(--text);
      font-weight: 600;
    }
    .step-divider {
      flex: 1;
      height: 1px;
      background: var(--border);
      margin: 0 12px;
    }
    /* Step Panels (Only 1 active at a time) */
    .step-panel {
      display: none;
    }
    .step-panel.active {
      display: block;
    }
    .card {
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 24px;
      background: var(--card-bg);
      margin-bottom: 24px;
    }
    .card-title {
      font-size: 18px;
      font-weight: 700;
      margin-bottom: 8px;
      color: var(--text);
    }
    .card-desc {
      font-size: 13.5px;
      color: var(--text-muted);
      margin-bottom: 20px;
    }
    /* Bookmarklet */
    .bookmarklet-box {
      border: 1px dashed var(--border-dark);
      border-radius: 6px;
      padding: 18px;
      margin: 16px 0;
      background: #fafafa;
    }
    .bookmarklet-btn {
      display: inline-block;
      background: #000000;
      color: #ffffff;
      text-decoration: none;
      padding: 9px 18px;
      border-radius: 4px;
      font-size: 13px;
      font-weight: 600;
      cursor: grab;
      margin-bottom: 12px;
    }
    .bookmarklet-btn:hover {
      background: #262626;
    }
    .instructions-list {
      font-size: 13px;
      color: var(--text-muted);
      padding-left: 20px;
    }
    .instructions-list li {
      margin-bottom: 6px;
    }
    /* Inputs */
    label {
      display: block;
      font-size: 12.5px;
      font-weight: 600;
      color: var(--text);
      margin-bottom: 6px;
    }
    .input-field {
      width: 100%;
      padding: 10px 12px;
      font-family: var(--font-mono);
      font-size: 13px;
      border: 1px solid var(--border);
      border-radius: 6px;
      background: #ffffff;
      color: var(--text);
      outline: none;
      transition: border-color 0.15s;
    }
    .input-field:focus {
      border-color: #000000;
    }
    .status-msg {
      font-size: 12.5px;
      margin-top: 8px;
      display: none;
    }
    .status-msg.valid {
      color: #000000;
      font-weight: 600;
      display: block;
    }
    /* Action Buttons */
    .button-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-top: 24px;
    }
    .btn {
      padding: 10px 20px;
      font-size: 13.5px;
      font-weight: 600;
      border-radius: 6px;
      cursor: pointer;
      transition: all 0.15s;
      border: 1px solid transparent;
      text-decoration: none;
      display: inline-block;
    }
    .btn-primary {
      background: #000000;
      color: #ffffff;
      border-color: #000000;
    }
    .btn-primary:hover {
      background: #262626;
    }
    .btn-secondary {
      background: #ffffff;
      color: var(--text);
      border-color: var(--border);
    }
    .btn-secondary:hover {
      background: #f5f5f5;
    }
    /* Code Blocks */
    pre {
      background: var(--code-bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 12px 14px;
      font-family: var(--font-mono);
      font-size: 12.5px;
      color: var(--text);
      overflow-x: auto;
      margin: 10px 0;
      line-height: 1.45;
    }
    /* Tabs */
    .tabs {
      display: flex;
      gap: 6px;
      border-bottom: 1px solid var(--border);
      margin-bottom: 14px;
    }
    .tab-item {
      padding: 6px 12px;
      font-size: 12.5px;
      font-weight: 500;
      color: var(--text-muted);
      cursor: pointer;
      border-bottom: 2px solid transparent;
      margin-bottom: -1px;
    }
    .tab-item.active {
      color: #000000;
      font-weight: 600;
      border-bottom-color: #000000;
    }
    .tab-content {
      display: none;
    }
    .tab-content.active {
      display: block;
    }
    /* Copy Row */
    .copy-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      background: var(--code-bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 8px 12px;
      margin: 8px 0;
      font-family: var(--font-mono);
      font-size: 12.5px;
    }
    .btn-copy {
      padding: 4px 10px;
      font-size: 11.5px;
      font-weight: 500;
      background: #ffffff;
      color: #000000;
      border: 1px solid var(--border);
      border-radius: 4px;
      cursor: pointer;
    }
    .btn-copy:hover {
      background: #f0f0f0;
    }
    .note-box {
      border-left: 2px solid #000000;
      padding-left: 12px;
      margin: 14px 0;
      font-size: 12.5px;
      color: var(--text-muted);
    }
  </style>
</head>
<body>
  <div class="container">
    
    <div class="header">
      <div class="badge">Open Source Setup</div>
      <h1>DeepSeek Private Proxy</h1>
      <p class="subtitle">Deploy your own dedicated, 100% free OpenAI-compatible proxy for DeepSeek R1 & V3 in 3 simple steps.</p>
    </div>

    <!-- Stepper Header -->
    <div class="stepper">
      <div class="step-item active" id="indicator-1" onclick="goToStep(1)">
        <span class="step-num">1</span>
        <span class="step-name">Get Token</span>
      </div>
      <div class="step-divider"></div>
      <div class="step-item" id="indicator-2" onclick="goToStep(2)">
        <span class="step-num">2</span>
        <span class="step-name">Deploy Worker</span>
      </div>
      <div class="step-divider"></div>
      <div class="step-item" id="indicator-3" onclick="goToStep(3)">
        <span class="step-num">3</span>
        <span class="step-name">Connect IDE</span>
      </div>
    </div>

    <!-- STEP 1 PANEL -->
    <div class="step-panel active" id="panel-1">
      <div class="card">
        <div class="card-title">Step 1: Grab Your DeepSeek Token</div>
        <p class="card-desc">DeepSeek web accounts don't need paid API keys. Drag this bookmarklet to your browser bookmarks bar to extract your session token in 1 click.</p>

        <div class="bookmarklet-box">
          <a class="bookmarklet-btn" href="${bookmarkletCode}" onclick="alert('Drag this button to your browser Bookmarks Bar, then click it on chat.deepseek.com'); return false;">
            ⭐ DeepSeek Token Grabber
          </a>
          <ol class="instructions-list">
            <li>Drag the black button above to your browser Bookmarks Bar.</li>
            <li>Open <a href="https://chat.deepseek.com" target="_blank" style="color: #000000;">chat.deepseek.com</a> in your browser and log in.</li>
            <li>Click the bookmark on the page. Your credentials JSON is automatically copied to your clipboard.</li>
          </ol>
        </div>

        <label for="input-token">Paste Copied DeepSeek Token</label>
        <input type="text" id="input-token" class="input-field" placeholder='Bearer koeKUj... (or paste JSON)' oninput="onTokenPasted()">
        <p style="font-size: 12px; color: var(--text-muted); margin-top: 6px;">Note: Only your Bearer token is needed. DeepSeek does not require ds_session_id or aws_waf_token.</p>
        <div id="token-status" class="status-msg"></div>

        <div class="button-row">
          <div></div>
          <button class="btn btn-primary" onclick="proceedToStep2()">Continue to Step 2 &rarr;</button>
        </div>
      </div>
    </div>

    <!-- STEP 2 PANEL -->
    <div class="step-panel" id="panel-2">
      <div class="card">
        <div class="card-title">Step 2: Deploy Your Own Free Cloudflare Worker</div>
        <p class="card-desc">
          To protect your privacy and guarantee your requests never share rate limits with anyone else, you host your proxy on your own free Cloudflare account. Cloudflare provides 100,000 requests per day for free.
        </p>

        <p style="font-size: 13px; color: var(--text-muted); margin-bottom: 8px;">Run these 3 commands in your terminal to deploy your dedicated proxy in under 60 seconds:</p>
        <pre><code># 1. Clone this open-source proxy
git clone https://github.com/divyansh-shandilya/deepseek-openai-proxy.git
cd deepseek-openai-proxy

# 2. Login to your free Cloudflare account
npx wrangler login

# 3. Deploy in 1 command
npx wrangler deploy</code></pre>

        <p style="font-size: 13px; color: var(--text-muted); margin-top: 14px; margin-bottom: 6px;">Your pre-configured <code>wrangler.toml</code> with your token from Step 1:</p>
        <div class="copy-row">
          <span style="font-size: 12px; color: var(--text-muted);">wrangler.toml configuration</span>
          <button class="btn-copy" onclick="copyWranglerToml()">Copy Config</button>
        </div>
        <pre id="wrangler-preview"><code>name = "my-deepseek-proxy"
main = "src/index.js"
compatibility_date = "2024-04-01"

[[rules]]
type = "CompiledWasm"
globs = ["**/*.wasm"]
fallthrough = false

[vars]
DEEPSEEK_AUTH_TOKEN = "Paste your token from Step 1"</code></pre>

        <div style="margin-top: 24px;">
          <label for="input-worker-url">Enter Your Deployed Worker URL</label>
          <input type="text" id="input-worker-url" class="input-field" placeholder="https://my-deepseek-proxy.your-name.workers.dev" oninput="saveWorkerUrl()">
          <div class="note-box">Wrangler will output your URL in your terminal immediately after deployment. Paste it above to generate your IDE setup guide in Step 3.</div>
        </div>

        <div class="button-row">
          <button class="btn btn-secondary" onclick="goToStep(1)">&larr; Back</button>
          <button class="btn btn-primary" onclick="proceedToStep3()">Continue to Step 3 &rarr;</button>
        </div>
      </div>
    </div>

    <!-- STEP 3 PANEL -->
    <div class="step-panel" id="panel-3">
      <div class="card">
        <div class="card-title">Step 3: Connect to Your IDE</div>
        <p class="card-desc">Your dedicated proxy is ready. Copy these values into Cursor, VS Code, Cline, or any OpenAI-compatible application.</p>

        <div style="margin-bottom: 20px;">
          <div class="copy-row">
            <div>
              <div style="font-size: 11px; text-transform: uppercase; color: var(--text-muted); margin-bottom: 2px;">OpenAI Base URL</div>
              <span id="final-base-url">https://your-worker.workers.dev/v1</span>
            </div>
            <button class="btn-copy" onclick="copyText('final-base-url')">Copy URL</button>
          </div>

          <div class="copy-row">
            <div>
              <div style="font-size: 11px; text-transform: uppercase; color: var(--text-muted); margin-bottom: 2px;">API Key</div>
              <span>sk-dummy</span>
            </div>
            <button class="btn-copy" onclick="navigator.clipboard.writeText('sk-dummy'); alert('Copied API Key: sk-dummy');">Copy Key</button>
          </div>

          <div class="copy-row">
            <div>
              <div style="font-size: 11px; text-transform: uppercase; color: var(--text-muted); margin-bottom: 2px;">Default Model</div>
              <span>deepseek-reasoner</span>
            </div>
            <button class="btn-copy" onclick="navigator.clipboard.writeText('deepseek-reasoner'); alert('Copied Model: deepseek-reasoner');">Copy Model</button>
          </div>
        </div>

        <div class="tabs">
          <div class="tab-item active" onclick="switchIdeTab('cursor')">Cursor</div>
          <div class="tab-item" onclick="switchIdeTab('vscode')">VS Code / Cline</div>
          <div class="tab-item" onclick="switchIdeTab('dsh')">DeepSeek CLI (dsh)</div>
          <div class="tab-item" onclick="switchIdeTab('python')">Python SDK</div>
        </div>

        <div id="tab-ide-cursor" class="tab-content active">
          <pre><code id="snippet-cursor">1. Open Cursor Settings -> Models -> OpenAI.
2. Set API Key to: sk-dummy
3. Enable "Override OpenAI Base URL" and enter:
   https://your-worker.workers.dev/v1
4. Add Model: deepseek-reasoner (or deepseek-chat)</code></pre>
        </div>

        <div id="tab-ide-vscode" class="tab-content">
          <pre><code id="snippet-vscode">In Cline / Continue / Roo Code settings:
Provider: OpenAI Compatible
Base URL: https://your-worker.workers.dev/v1
API Key: dummy
Model ID: deepseek-reasoner</code></pre>
        </div>

        <div id="tab-ide-dsh" class="tab-content">
          <pre><code id="snippet-dsh">export OPENAI_BASE_URL="https://your-worker.workers.dev/v1"
export OPENAI_API_KEY="dummy"

# Run DeepSeek Harness with full command execution & tool support
dsh</code></pre>
        </div>

        <div id="tab-ide-python" class="tab-content">
          <pre><code id="snippet-python">from openai import OpenAI

client = OpenAI(
    base_url="https://your-worker.workers.dev/v1",
    api_key="dummy"
)

response = client.chat.completions.create(
    model="deepseek-reasoner",
    messages=[{"role": "user", "content": "Hello!"}],
    stream=True
)
for chunk in response:
    print(chunk.choices[0].delta.content or "", end="")</code></pre>
        </div>

        <div class="button-row">
          <button class="btn btn-secondary" onclick="goToStep(2)">&larr; Back to Step 2</button>
          <button class="btn btn-primary" onclick="goToStep(1)">Done / Start Over &rarr;</button>
        </div>
      </div>
    </div>

  </div>

  <script>
    let currentStep = 1;
    let userToken = "";
    let userWaf = "";
    let userSess = "";
    let userWorkerUrl = "https://your-worker.workers.dev";

    function goToStep(step) {
      currentStep = step;
      document.querySelectorAll('.step-panel').forEach(p => p.classList.remove('active'));
      const activePanel = document.getElementById('panel-' + step);
      if (activePanel) activePanel.classList.add('active');

      // Update Stepper
      for (let i = 1; i <= 3; i++) {
        const ind = document.getElementById('indicator-' + i);
        if (!ind) continue;
        ind.classList.remove('active', 'completed');
        if (i === step) ind.classList.add('active');
        else if (i < step) ind.classList.add('completed');
      }

      window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    function onTokenPasted() {
      const input = document.getElementById('input-token').value.trim();
      const status = document.getElementById('token-status');
      if (!input) {
        status.style.display = 'none';
        return;
      }

      try {
        let token = input;
        if (input.startsWith('{')) {
          const parsed = JSON.parse(input);
          token = parsed.token || input;
        }
        if (!token.startsWith('Bearer ') && token.length > 20) {
          token = 'Bearer ' + token;
        }
        userToken = token;

        status.textContent = '✓ Valid Token: ' + userToken.substring(0, 32) + '...';
        status.className = 'status-msg valid';
        updateWranglerPreview();
      } catch (e) {
        status.textContent = 'Invalid format. Please copy using the bookmarklet on chat.deepseek.com';
        status.className = 'status-msg error';
      }
    }

    function proceedToStep2() {
      const input = document.getElementById('input-token').value.trim();
      if (!input) {
        alert('Please paste your DeepSeek token before continuing.');
        return;
      }
      onTokenPasted();
      goToStep(2);
    }

    function updateWranglerPreview() {
      const el = document.getElementById('wrangler-preview');
      if (!el) return;
      const t = userToken || "Bearer your-token-from-step-1";
      el.innerHTML = '<code>name = "my-deepseek-proxy"\\nmain = "src/index.js"\\ncompatibility_date = "2024-04-01"\\n\\n[[rules]]\\ntype = "CompiledWasm"\\nglobs = ["**/*.wasm"]\\nfallthrough = false\\n\\n[vars]\\nDEEPSEEK_AUTH_TOKEN = "' + t + '"</code>';
    }

    function copyWranglerToml() {
      const t = userToken || "Bearer your-token-from-step-1";
      const config = 'name = "my-deepseek-proxy"\\nmain = "src/index.js"\\ncompatibility_date = "2024-04-01"\\n\\n[[rules]]\\ntype = "CompiledWasm"\\nglobs = ["**/*.wasm"]\\nfallthrough = false\\n\\n[vars]\\nDEEPSEEK_AUTH_TOKEN = "' + t + '"\\n';
      navigator.clipboard.writeText(config);
      alert('Copied wrangler.toml config to clipboard!');
    }

    function saveWorkerUrl() {
      let raw = document.getElementById('input-worker-url').value.trim();
      if (!raw) raw = "https://your-worker.workers.dev";
      raw = raw.replace(/\\/v1\\/?$/, '').replace(/\\/$/, '');
      userWorkerUrl = raw;
      updateStep3Snippets();
    }

    function proceedToStep3() {
      saveWorkerUrl();
      goToStep(3);
    }

    function updateStep3Snippets() {
      const base = userWorkerUrl + '/v1';
      document.getElementById('final-base-url').textContent = base;

      document.getElementById('snippet-cursor').textContent =
        '1. Open Cursor Settings -> Models -> OpenAI.\\n' +
        '2. Set API Key to: sk-dummy\\n' +
        '3. Enable "Override OpenAI Base URL" and enter:\\n' +
        '   ' + base + '\\n' +
        '4. Add Model: deepseek-reasoner (or deepseek-chat)';

      document.getElementById('snippet-vscode').textContent =
        'In Cline / Continue / Roo Code settings:\\n' +
        'Provider: OpenAI Compatible\\n' +
        'Base URL: ' + base + '\\n' +
        'API Key: dummy\\n' +
        'Model ID: deepseek-reasoner';

      document.getElementById('snippet-dsh').textContent =
        'export OPENAI_BASE_URL="' + base + '"\\n' +
        'export OPENAI_API_KEY="dummy"\\n\\n' +
        '# Run DeepSeek Harness with full command execution & tool support\\n' +
        'dsh';

      document.getElementById('snippet-python').textContent =
        'from openai import OpenAI\\n\\n' +
        'client = OpenAI(\\n' +
        '    base_url="' + base + '",\\n' +
        '    api_key="dummy"\\n' +
        ')\\n\\n' +
        'response = client.chat.completions.create(\\n' +
        '    model="deepseek-reasoner",\\n' +
        '    messages=[{"role": "user", "content": "Hello!"}],\\n' +
        '    stream=True\\n' +
        ')\\n' +
        'for chunk in response:\\n' +
        '    print(chunk.choices[0].delta.content or "", end="")';
    }

    function switchIdeTab(ide) {
      document.querySelectorAll('#panel-3 .tabs .tab-item').forEach(t => t.classList.remove('active'));
      event.target.classList.add('active');
      document.querySelectorAll('#panel-3 .tab-content').forEach(c => c.classList.remove('active'));
      document.getElementById('tab-ide-' + ide).classList.add('active');
    }

    function copyText(elemId) {
      const text = document.getElementById(elemId).textContent;
      navigator.clipboard.writeText(text);
      alert('Copied: ' + text);
    }
  </script>
</body>
</html>`;
}
