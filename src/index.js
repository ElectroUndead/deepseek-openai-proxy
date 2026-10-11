import wasmModule from "./sha3_wasm_v1.wasm";

// Solve PoW challenge using WebAssembly in Cloudflare Edge
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
      return new Response(JSON.stringify({ status: "ok", service: "deepseek-stateless-proxy" }), {
        headers: { "Content-Type": "application/json", ...getCorsHeaders() },
      });
    }

    // Completions endpoint: /v1/chat/completions or /chat/completions
    if (url.pathname === "/v1/chat/completions" || url.pathname === "/chat/completions") {
      if (request.method !== "POST") {
        return new Response("Method Not Allowed", { status: 405, headers: getCorsHeaders() });
      }

      // Extract token dynamically from request Authorization header or x-api-key
      const authHeader = request.headers.get("authorization") || request.headers.get("x-api-key") || "";
      let callerToken = null;

      let rawToken = authHeader.trim();
      while (rawToken.toLowerCase().startsWith("bearer ")) {
        rawToken = rawToken.substring(7).trim();
      }

      // Check if user pasted a JSON string like {"token":"Bearer ..."}
      if (rawToken.startsWith("{")) {
        try {
          const parsed = JSON.parse(rawToken);
          if (parsed.token) {
            rawToken = parsed.token.trim();
            while (rawToken.toLowerCase().startsWith("bearer ")) {
              rawToken = rawToken.substring(7).trim();
            }
          }
        } catch(e) {}
      }

      if (rawToken.length > 20 && !rawToken.startsWith("sk-dummy") && !rawToken.startsWith("dummy")) {
        callerToken = `Bearer ${rawToken}`;
      }

      // Fallback if self-hosted with private env var
      if (!callerToken && env.DEEPSEEK_AUTH_TOKEN && env.DEEPSEEK_AUTH_TOKEN.length > 20) {
        callerToken = env.DEEPSEEK_AUTH_TOKEN.trim();
        if (!callerToken.startsWith("Bearer ")) {
          callerToken = `Bearer ${callerToken}`;
        }
      }

      if (!callerToken) {
        return new Response(
          JSON.stringify({
            error: {
              message: "Missing DeepSeek token. Please set your API Key to your DeepSeek token in Cursor/IDE settings! Use the 1-click bookmarklet on our website to grab your token.",
              type: "auth_required",
            },
          }),
          { status: 401, headers: { "Content-Type": "application/json", ...getCorsHeaders() } }
        );
      }

      try {
        const body = await request.json();
        return await handleChatCompletion(body, callerToken);
      } catch (err) {
        return new Response(
          JSON.stringify({ error: { message: err.message || "Proxy Error", type: "proxy_error" } }),
          { status: 500, headers: { "Content-Type": "application/json", ...getCorsHeaders() } }
        );
      }
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

    // Serve the clean, white-themed, 2-step setup page
    return new Response(renderSetupHtml(url.origin), {
      headers: { "Content-Type": "text/html; charset=utf-8", ...getCorsHeaders() },
    });
  },
};

// Chat completion with dynamic caller token
async function handleChatCompletion(body, token) {
  const messages = body.messages || [];
  const tools = body.tools || [];
  const isStream = body.stream === true;
  const model = body.model || "deepseek-reasoner";
  const thinkingEnabled = !model.includes("chat") || model.includes("r1") || model.includes("reasoner");

  const prompt = formatPromptWithTools(messages, tools);

  const baseHeaders = {
    "accept": "*/*",
    "accept-language": "en-US,en;q=0.9",
    "authorization": token,
    "content-type": "application/json",
    "origin": "https://chat.deepseek.com",
    "referer": "https://chat.deepseek.com/",
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36",
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
      let currentFragmentType = thinkingEnabled ? "THINK" : "RESPONSE";
      let accumulatedResponseText = "";

      try {
        const initialChunk = {
          id: completionId,
          object: "chat.completion.chunk",
          created: createdTimestamp,
          model: model,
          choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
        };
        await writer.write(encoder.encode(`data: ${JSON.stringify(initialChunk)}\n\n`));

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop();

          for (const line of lines) {
            if (line.startsWith("event: close") || line.includes("[DONE]")) {
              break;
            }
            if (line.startsWith("data:")) {
              const dataStr = line.substring(5).trim();
              if (!dataStr) continue;

              try {
                const data = JSON.parse(dataStr);

                if (data.v && data.v.response && data.v.response.fragments && data.v.response.fragments.length > 0) {
                  currentFragmentType = data.v.response.fragments[0].type || "THINK";
                  const initialContent = data.v.response.fragments[0].content || "";
                  if (initialContent) {
                    if (currentFragmentType === "THINK") {
                      await emitStreamDelta(writer, encoder, completionId, model, createdTimestamp, "THINK", initialContent);
                    } else {
                      accumulatedResponseText += initialContent;
                    }
                  }
                }

                if (data.p === "response/fragments" && data.o === "APPEND" && Array.isArray(data.v) && data.v.length > 0) {
                  currentFragmentType = data.v[0].type || "RESPONSE";
                  const c = data.v[0].content || "";
                  if (c) {
                    if (currentFragmentType === "THINK") {
                      await emitStreamDelta(writer, encoder, completionId, model, createdTimestamp, "THINK", c);
                    } else {
                      accumulatedResponseText += c;
                    }
                  }
                }

                if (data.v && typeof data.v === "string" && (!data.p || !data.p.includes("status"))) {
                  if (currentFragmentType === "THINK") {
                    await emitStreamDelta(writer, encoder, completionId, model, createdTimestamp, "THINK", data.v);
                  } else {
                    accumulatedResponseText += data.v;
                    if (!accumulatedResponseText.includes("<|") && !accumulatedResponseText.includes("<｜")) {
                      await emitStreamDelta(writer, encoder, completionId, model, createdTimestamp, "RESPONSE", data.v);
                    }
                  }
                }
              } catch (e) {}
            }
          }
        }

        const dsml = parseDSML(accumulatedResponseText);
        if (dsml && dsml.toolCalls.length > 0) {
          const toolChunk = {
            id: completionId,
            object: "chat.completion.chunk",
            created: createdTimestamp,
            model: model,
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: dsml.toolCalls,
                },
                finish_reason: "tool_calls",
              },
            ],
          };
          await writer.write(encoder.encode(`data: ${JSON.stringify(toolChunk)}\n\n`));
        } else {
          if (accumulatedResponseText.includes("<|") || accumulatedResponseText.includes("<｜")) {
            await emitStreamDelta(writer, encoder, completionId, model, createdTimestamp, "RESPONSE", accumulatedResponseText);
          }

          const finishChunk = {
            id: completionId,
            object: "chat.completion.chunk",
            created: createdTimestamp,
            model: model,
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          };
          await writer.write(encoder.encode(`data: ${JSON.stringify(finishChunk)}\n\n`));
        }

        await writer.write(encoder.encode("data: [DONE]\n\n"));
      } catch (streamErr) {
        console.error("Stream processing error:", streamErr);
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

  // Non-streaming Response
  const reader = dsResponse.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let thinkAccumulated = "";
  let responseAccumulated = "";
  let currentFragmentType = thinkingEnabled ? "THINK" : "RESPONSE";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop();

    for (const line of lines) {
      if (line.startsWith("data:")) {
        const dataStr = line.substring(5).trim();
        if (!dataStr) continue;

        try {
          const data = JSON.parse(dataStr);
          if (data.v && data.v.response && data.v.response.fragments && data.v.response.fragments.length > 0) {
            currentFragmentType = data.v.response.fragments[0].type || "THINK";
            const initC = data.v.response.fragments[0].content || "";
            if (currentFragmentType === "THINK") thinkAccumulated += initC;
            else responseAccumulated += initC;
          }
          if (data.p === "response/fragments" && data.o === "APPEND" && Array.isArray(data.v) && data.v.length > 0) {
            currentFragmentType = data.v[0].type || "RESPONSE";
            const appendC = data.v[0].content || "";
            if (currentFragmentType === "THINK") thinkAccumulated += appendC;
            else responseAccumulated += appendC;
          }
          if (data.v && typeof data.v === "string" && (!data.p || !data.p.includes("status"))) {
            if (currentFragmentType === "THINK") thinkAccumulated += data.v;
            else responseAccumulated += data.v;
          }
        } catch (e) {}
      }
    }
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
// 100% NON-TECHY FRIENDLY, WHITE-THEMED, BLACK & WHITE SETUP PAGE (ZERO CODING)
// -----------------------------------------------------------------------------
function renderSetupHtml(origin) {
  const baseUrl = `${origin}/v1`;
  const bookmarkletCode = `javascript:(function(){try{let t='';const raw=localStorage.getItem('userToken');if(raw){try{t=JSON.parse(raw).value||raw;}catch(e){t=raw;}}if(!t)return alert('No active DeepSeek session found! Please log in on chat.deepseek.com first.');if(!t.startsWith('Bearer '))t='Bearer '+t;navigator.clipboard.writeText(t);alert('✓ Copied DeepSeek Token to clipboard!\\nNow paste it in Cursor as your API Key.');}catch(e){alert('Error copying token: '+e);}})();`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>DeepSeek Free OpenAI Proxy</title>
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
      --font-mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
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
      margin-bottom: 28px;
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
    .stepper-nav {
      display: flex;
      align-items: center;
      justify-content: space-between;
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 6px;
      margin-bottom: 24px;
      background: #fafafa;
      gap: 4px;
    }
    .step-nav-btn {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      padding: 10px 12px;
      background: transparent;
      border: 1px solid transparent;
      border-radius: 6px;
      font-size: 13px;
      font-weight: 600;
      color: var(--text-muted);
      cursor: pointer;
      transition: all 0.15s ease;
    }
    .step-nav-btn.active {
      background: #000000;
      color: #ffffff;
    }
    .step-circle {
      width: 20px;
      height: 20px;
      border-radius: 50%;
      background: #e5e5e5;
      color: #000000;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 11px;
      font-weight: 700;
    }
    .step-nav-btn.active .step-circle {
      background: #ffffff;
      color: #000000;
    }
    .step-line {
      width: 14px;
      height: 1px;
      background: var(--border);
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
      margin-bottom: 6px;
      color: var(--text);
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .step-badge {
      width: 24px;
      height: 24px;
      border-radius: 50%;
      background: #000000;
      color: #ffffff;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 12px;
      font-weight: 700;
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
      padding: 10px 20px;
      border-radius: 4px;
      font-size: 13px;
      font-weight: 600;
      cursor: grab;
      margin-bottom: 14px;
    }
    .bookmarklet-btn:hover {
      background: #262626;
    }
    .instructions-list {
      font-size: 13px;
      color: var(--text-muted);
      padding-left: 20px;
      line-height: 1.6;
    }
    .instructions-list li {
      margin-bottom: 8px;
    }
    .tip-box {
      background: #fafafa;
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 10px 14px;
      margin-top: 14px;
      font-size: 12.5px;
      color: var(--text);
      line-height: 1.45;
    }

    /* Copy Rows */
    .copy-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      background: var(--code-bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 10px 14px;
      margin: 8px 0;
      font-family: var(--font-mono);
      font-size: 13px;
    }
    .btn-copy {
      padding: 5px 12px;
      font-size: 12px;
      font-weight: 600;
      background: #000000;
      color: #ffffff;
      border: 1px solid #000000;
      border-radius: 4px;
      cursor: pointer;
    }
    .btn-copy:hover {
      background: #262626;
    }

    /* Form & Input Rows */
    .input-row {
      display: flex;
      gap: 8px;
      margin: 10px 0;
    }
    .input-field {
      flex: 1;
      padding: 10px 14px;
      border: 1px solid var(--border-dark);
      border-radius: 4px;
      font-family: var(--font-mono);
      font-size: 13px;
      background: #ffffff;
      color: #000000;
    }
    .input-field:focus {
      outline: 2px solid #000000;
    }
    kbd {
      display: inline-block;
      padding: 2px 6px;
      font-family: var(--font-mono);
      font-size: 11px;
      background: #ffffff;
      border: 1px solid #111111;
      border-radius: 3px;
    }

    /* Wizard Action Navigation */
    .wizard-nav {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-top: 24px;
      padding-top: 18px;
      border-top: 1px solid var(--border);
    }
    .btn-primary {
      padding: 10px 20px;
      font-size: 13px;
      font-weight: 600;
      background: #000000;
      color: #ffffff;
      border: 1px solid #000000;
      border-radius: 4px;
      cursor: pointer;
    }
    .btn-primary:hover {
      background: #262626;
    }
    .btn-secondary {
      padding: 10px 18px;
      font-size: 13px;
      font-weight: 600;
      background: #ffffff;
      color: #000000;
      border: 1px solid #111111;
      border-radius: 4px;
      cursor: pointer;
    }
    .btn-secondary:hover {
      background: #f5f5f5;
    }
    .btn-text {
      background: none;
      border: none;
      color: var(--text-muted);
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      text-decoration: underline;
    }
    .btn-text:hover {
      color: #000000;
    }

    /* Tabs */
    .tabs {
      display: flex;
      gap: 6px;
      border-bottom: 1px solid var(--border);
      margin: 18px 0 12px 0;
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
    details summary {
      cursor: pointer;
      font-size: 13px;
      font-weight: 600;
      color: var(--text);
      padding: 8px 0;
    }
  </style>
</head>
<body>
  <div class="container">
    
    <div class="header">
      <div class="badge">Zero-Config Free Proxy</div>
      <h1>DeepSeek OpenAI Proxy</h1>
      <p class="subtitle">Connect DeepSeek R1 & V3 directly into Cursor, VS Code, Cline, or any OpenAI client. No coding, no terminal, and no payment required.</p>
    </div>

    <!-- Stepper Header -->
    <div class="stepper-nav">
      <button class="step-nav-btn active" id="nav-step-1" onclick="goToStep(1)">
        <span class="step-circle">1</span> Get Token
      </button>
      <div class="step-line"></div>
      <button class="step-nav-btn" id="nav-step-2" onclick="goToStep(2)">
        <span class="step-circle">2</span> Verify Token
      </button>
      <div class="step-line"></div>
      <button class="step-nav-btn" id="nav-step-3" onclick="goToStep(3)">
        <span class="step-circle">3</span> Connect to App
      </button>
    </div>

    <!-- STEP 1: Grab Token Panel -->
    <div id="step-panel-1" class="step-panel card">
      <div class="card-title">
        <span class="step-badge">1</span>
        <span>Get Your DeepSeek Token</span>
      </div>
      <p class="card-desc">DeepSeek web accounts don't need paid API keys. Drag this button to your browser bookmarks bar to extract your free token in 1 click:</p>

      <div class="bookmarklet-box">
        <a class="bookmarklet-btn" href="${bookmarkletCode}" onclick="alert('Drag this button to your browser Bookmarks Bar, then click it on chat.deepseek.com'); return false;">
          ⭐ DeepSeek Token Grabber
        </a>
        <ol class="instructions-list">
          <li>Drag the black button above to your browser's Bookmarks bar.</li>
          <li>Open <a href="https://chat.deepseek.com" target="_blank" style="color: #000000; font-weight: 600;">chat.deepseek.com</a> in your browser and log in.</li>
          <li>Click the bookmark on the page. Your token is automatically copied to your clipboard!</li>
        </ol>

        <div class="tip-box">
          💡 <strong>Don't see your bookmarks bar?</strong> Press <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>B</kbd> (or <kbd>Cmd</kbd> + <kbd>Shift</kbd> + <kbd>B</kbd> on Mac) to show it.
        </div>
      </div>

      <div class="wizard-nav">
        <div></div>
        <div style="display: flex; gap: 14px; align-items: center;">
          <button class="btn-text" onclick="goToStep(3)">Skip to App Setup →</button>
          <button class="btn-primary" onclick="goToStep(2)">Next: Verify Token →</button>
        </div>
      </div>
    </div>

    <!-- STEP 2: Verify Token Panel -->
    <div id="step-panel-2" class="step-panel card" style="display: none;">
      <div class="card-title">
        <span class="step-badge">2</span>
        <span>Verify Your Token</span>
      </div>
      <p class="card-desc">Make sure your token is active and working before configuring your AI tool:</p>

      <div>
        <label style="font-size: 11px; text-transform: uppercase; font-weight: 700; color: var(--text-muted);">Paste Your Token Below</label>
        <div class="input-row">
          <input type="text" id="test-token-input" class="input-field" placeholder="Paste your token here (Ctrl + V)..." />
          <button id="btn-test-token" class="btn-primary" onclick="runTokenTest()">Verify Token</button>
        </div>
        <div id="test-token-result" style="display: none; padding: 14px; border-radius: 6px; margin-top: 12px;"></div>
      </div>

      <div class="wizard-nav">
        <button class="btn-secondary" onclick="goToStep(1)">← Back to Step 1</button>
        <button class="btn-primary" onclick="goToStep(3)">Next: Connect to App →</button>
      </div>
    </div>

    <!-- STEP 3: Connect to App Panel -->
    <div id="step-panel-3" class="step-panel card" style="display: none;">
      <div class="card-title">
        <span class="step-badge">3</span>
        <span>Connect to Your AI App</span>
      </div>
      <p class="card-desc">Enter these 3 values into your IDE, extension, or OpenAI-compatible client:</p>

      <div>
        <label style="font-size: 11px; text-transform: uppercase; font-weight: 700; color: var(--text-muted);">1. Base URL</label>
        <div class="copy-row">
          <span id="base-url-text">${baseUrl}</span>
          <button class="btn-copy" onclick="copyText('base-url-text')">Copy URL</button>
        </div>
      </div>

      <div style="margin-top: 14px;">
        <label style="font-size: 11px; text-transform: uppercase; font-weight: 700; color: var(--text-muted);">2. API Key</label>
        <div class="copy-row">
          <span style="color: var(--text-muted);">Paste the token from Step 1</span>
          <button class="btn-copy" onclick="copyTokenStep3()">Copy Token</button>
        </div>
      </div>

      <div style="margin-top: 14px;">
        <label style="font-size: 11px; text-transform: uppercase; font-weight: 700; color: var(--text-muted);">3. Model Name</label>
        <div class="copy-row">
          <span id="model-name-text">deepseek-reasoner</span>
          <button class="btn-copy" onclick="copyText('model-name-text')">Copy Model</button>
        </div>
        <div style="font-size: 12px; color: var(--text-muted); margin-top: 4px;">
          Note: You can also use <code>deepseek-chat</code> for standard conversational mode without extended reasoning.
        </div>
      </div>

      <div class="tabs">
        <div class="tab-item active" onclick="switchIdeTab('cursor')">Cursor Instructions</div>
        <div class="tab-item" onclick="switchIdeTab('vscode')">VS Code / Cline</div>
        <div class="tab-item" onclick="switchIdeTab('clients')">Other AI Apps</div>
        <div class="tab-item" onclick="switchIdeTab('python')">Python SDK</div>
      </div>

      <div id="tab-ide-cursor" class="tab-content active">
        <pre><code>1. Open Cursor Settings (gear icon).
2. Go to "Models" -> "OpenAI".
3. Turn ON "Override OpenAI Base URL" and enter:
   ${baseUrl}
4. In "OpenAI API Key", paste your token.
5. In model list, add: deepseek-reasoner (or deepseek-chat)</code></pre>
      </div>

      <div id="tab-ide-vscode" class="tab-content">
        <pre><code>In Cline / Continue / Roo Code settings:
Provider: OpenAI Compatible
Base URL: ${baseUrl}
API Key: Paste your DeepSeek token
Model ID: deepseek-reasoner</code></pre>
      </div>

      <div id="tab-ide-clients" class="tab-content">
        <pre><code>In NextChat, Chatbox, or LibreChat:
API Provider: OpenAI
Base URL (API Host): ${baseUrl}
API Key: Paste your DeepSeek token
Model: deepseek-reasoner</code></pre>
      </div>

      <div id="tab-ide-python" class="tab-content">
        <pre><code>from openai import OpenAI

client = OpenAI(
    base_url="${baseUrl}",
    api_key="PASTE_YOUR_DEEPSEEK_TOKEN_HERE"
)

response = client.chat.completions.create(
    model="deepseek-reasoner",
    messages=[{"role": "user", "content": "Hello!"}],
    stream=True
)
for chunk in response:
    print(chunk.choices[0].delta.content or "", end="")</code></pre>
      </div>

      <div class="wizard-nav">
        <button class="btn-secondary" onclick="goToStep(2)">← Back to Verify Token</button>
        <button class="btn-primary" onclick="goToStep(1)">Start Over</button>
      </div>
    </div>

    <!-- Optional Developer Section -->
    <div class="card">
      <details>
        <summary>⚙️ Want to host your own dedicated worker? (For Developers Only)</summary>
        <p style="font-size: 13px; color: var(--text-muted); margin: 10px 0;">
          If you are a developer and want to deploy this proxy on your own Cloudflare account:
        </p>
        <pre><code>git clone https://github.com/divyansh-shandilya/deepseek-openai-proxy.git
cd deepseek-openai-proxy
npx wrangler login
npx wrangler deploy</code></pre>
        <p style="font-size: 12.5px; color: var(--text-muted);">
          View open-source repository on <a href="https://github.com/divyansh-shandilya/deepseek-openai-proxy" target="_blank" style="color: #000000; font-weight: 600;">GitHub</a>.
        </p>
      </details>
    </div>

  </div>

  <script>
    let currentStep = 1;
    let savedVerifiedToken = '';

    function goToStep(step) {
      currentStep = step;
      document.querySelectorAll('.step-panel').forEach(p => p.style.display = 'none');
      document.getElementById('step-panel-' + step).style.display = 'block';

      document.querySelectorAll('.step-nav-btn').forEach((btn, idx) => {
        if (idx + 1 === step) {
          btn.classList.add('active');
        } else {
          btn.classList.remove('active');
        }
      });
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    function copyText(elemId) {
      const text = document.getElementById(elemId).textContent;
      navigator.clipboard.writeText(text);
      alert('Copied to clipboard: ' + text);
    }

    function copyVerifiedToken() {
      const token = savedVerifiedToken || document.getElementById('test-token-input').value.trim();
      if (token) {
        navigator.clipboard.writeText(token);
        alert('✓ Token copied to clipboard!');
      } else {
        alert('No token to copy yet. Paste and verify your token first!');
      }
    }

    function copyTokenStep3() {
      if (savedVerifiedToken) {
        navigator.clipboard.writeText(savedVerifiedToken);
        alert('✓ Token copied to clipboard!');
      } else {
        alert('Please paste the token you extracted from Step 1 into your app.');
      }
    }

    function switchIdeTab(ide) {
      document.querySelectorAll('.tabs .tab-item').forEach(t => t.classList.remove('active'));
      event.target.classList.add('active');
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      document.getElementById('tab-ide-' + ide).classList.add('active');
    }

    async function runTokenTest() {
      const input = document.getElementById('test-token-input');
      const resBox = document.getElementById('test-token-result');
      const btn = document.getElementById('btn-test-token');
      const raw = input.value.trim();

      if (!raw) {
        alert('Please paste your token in the box first!');
        return;
      }

      btn.disabled = true;
      btn.textContent = 'Verifying...';
      resBox.style.display = 'block';
      resBox.style.background = '#fafafa';
      resBox.style.border = '1px solid #111111';
      resBox.style.color = '#000000';
      resBox.innerHTML = '⏳ Verifying token with DeepSeek and solving PoW challenge...';

      try {
        const cleanToken = raw.startsWith('Bearer ') ? raw : 'Bearer ' + raw;
        const resp = await fetch('/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': cleanToken
          },
          body: JSON.stringify({
            model: 'deepseek-chat',
            messages: [{ role: 'user', content: 'Say OK' }]
          })
        });

        const data = await resp.json();
        if (resp.ok && data.choices && data.choices[0]) {
          savedVerifiedToken = cleanToken;
          resBox.style.background = '#fafafa';
          resBox.style.border = '1px solid #111111';
          resBox.style.color = '#000000';
          resBox.innerHTML = \`
            <div style="font-weight: 700; font-size: 14px; margin-bottom: 4px;">✓ Token is active and working!</div>
            <div style="color: #666666; font-size: 13px; margin-bottom: 12px;">DeepSeek answered successfully. Click below to copy your token:</div>
            <button class="btn-copy" onclick="copyVerifiedToken()">📋 Copy Token</button>
          \`;
        } else {
          resBox.style.background = '#fafafa';
          resBox.style.border = '1px solid #111111';
          resBox.style.color = '#000000';
          const errMsg = data.error ? data.error.message : JSON.stringify(data);
          resBox.innerHTML = '<strong>❌ Verification failed:</strong> ' + errMsg;
        }
      } catch (err) {
        resBox.style.background = '#fafafa';
        resBox.style.border = '1px solid #111111';
        resBox.style.color = '#000000';
        resBox.innerHTML = '<strong>❌ Network error:</strong> ' + err.message;
      } finally {
        btn.disabled = false;
        btn.textContent = 'Verify Token';
      }
    }
  </script>
</body>
</html>`;
}
