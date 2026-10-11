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
function renderSetupHtml(origin) {
  const baseUrl = `${origin}/v1`;
  const bookmarkletCode = `javascript:(function(){try{if(!window.location.hostname.includes('deepseek.com')){return alert('Key NOT copied: You must be on chat.deepseek.com! Please open chat.deepseek.com, log in, and click this bookmark.');}let t='';const raw=localStorage.getItem('userToken');if(raw){try{const p=JSON.parse(raw);t=p.value||p.token||p.userToken||raw;}catch(e){t=raw;}}if(typeof t==='string'){t=t.trim();while(t.toLowerCase().startsWith('bearer '))t=t.substring(7).trim();if((t.startsWith('"')&&t.endsWith('"'))||(t.startsWith("'")&&t.endsWith("'")))t=t.slice(1,-1).trim();}if(!t||t==='null'||t==='undefined'||t==='{}'||t.length<10){return alert('Key NOT copied: You are not logged in. Please sign in to chat.deepseek.com first and try again.');}navigator.clipboard.writeText(t);alert('Copied DeepSeek API Key to clipboard!');}catch(e){alert('Key NOT copied: '+e);}})();`;

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
      margin-bottom: 24px;
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
      gap: 6px;
      padding: 9px 8px;
      background: transparent;
      border: 1px solid transparent;
      border-radius: 6px;
      font-size: 12.5px;
      font-weight: 600;
      color: var(--text-muted);
      cursor: pointer;
      transition: all 0.15s ease;
      white-space: nowrap;
    }
    .step-nav-btn.active {
      background: #000000;
      color: #ffffff;
    }
    .step-circle {
      width: 18px;
      height: 18px;
      border-radius: 50%;
      background: #e5e5e5;
      color: #000000;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 11px;
      font-weight: 700;
      flex-shrink: 0;
    }
    .step-nav-btn.active .step-circle {
      background: #ffffff;
      color: #000000;
    }
    .step-line {
      width: 8px;
      height: 1px;
      background: var(--border);
      flex-shrink: 0;
    }
    @media (max-width: 580px) {
      .step-nav-text {
        display: none;
      }
      .step-nav-btn {
        padding: 8px 4px;
      }
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

    /* Hero Action Card (Step 1) */
    .hero-action-card {
      border: 1px solid var(--border);
      border-radius: 8px;
      background: #fafafa;
      overflow: hidden;
      margin: 18px 0;
    }
    .hero-action-body {
      padding: 30px 20px 26px 20px;
      display: flex;
      flex-direction: column;
      align-items: center;
      text-align: center;
    }
    .bookmarklet-btn {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      background: #000000;
      color: #ffffff;
      text-decoration: none;
      padding: 13px 28px;
      border-radius: 6px;
      font-size: 14px;
      font-weight: 600;
      cursor: grab;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
      user-select: none;
      transition: background 0.15s ease, transform 0.15s ease;
    }
    .bookmarklet-btn:hover {
      background: #262626;
      transform: translateY(-1px);
    }
    .bookmarklet-btn:active {
      cursor: grabbing;
    }
    .drag-hint {
      margin-top: 14px;
      font-size: 13.5px;
      font-weight: 600;
      color: var(--text);
    }
    .drag-subhint {
      font-size: 12.5px;
      color: var(--text-muted);
      margin-top: 4px;
    }
    .hero-action-footer {
      border-top: 1px solid var(--border);
      background: #f4f4f4;
      padding: 12px 18px;
      font-size: 12.5px;
      color: var(--text);
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      text-align: center;
      line-height: 1.4;
    }

    /* Clean Step Flow Cards (Step 2) */
    .flow-steps {
      display: flex;
      flex-direction: column;
      gap: 12px;
      margin: 18px 0;
    }
    .flow-item {
      display: flex;
      align-items: flex-start;
      gap: 14px;
      padding: 16px 18px;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: #fafafa;
      transition: border-color 0.15s ease;
    }
    .flow-item:hover {
      border-color: #cccccc;
    }
    .flow-badge {
      width: 24px;
      height: 24px;
      border-radius: 50%;
      background: #000000;
      color: #ffffff;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 12px;
      font-weight: 700;
      flex-shrink: 0;
      margin-top: 2px;
    }
    .flow-content {
      flex: 1;
    }
    .flow-title {
      font-size: 14px;
      font-weight: 700;
      color: var(--text);
      margin-bottom: 3px;
    }
    .flow-desc {
      font-size: 13px;
      color: var(--text-muted);
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
      flex-shrink: 0;
      margin-left: 8px;
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
      padding: 1px 6px;
      font-family: var(--font-mono);
      font-size: 11px;
      font-weight: 600;
      background: #ffffff;
      border: 1px solid #cccccc;
      border-radius: 4px;
      box-shadow: 0 1px 0 rgba(0,0,0,0.1);
      color: #111111;
      margin: 0 2px;
    }

    /* Action Buttons */
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
      text-decoration: none;
      display: inline-flex;
      align-items: center;
      gap: 6px;
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
      text-decoration: none;
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

    /* Modern Toast */
    .toast {
      position: fixed;
      bottom: 28px;
      left: 50%;
      transform: translateX(-50%) translateY(20px);
      background: #000000;
      color: #ffffff;
      padding: 11px 20px;
      border-radius: 6px;
      font-size: 13px;
      font-weight: 500;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.28);
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.2s ease, transform 0.2s ease;
      z-index: 9999;
      white-space: nowrap;
    }
    .toast.show {
      opacity: 1;
      transform: translateX(-50%) translateY(0);
      pointer-events: auto;
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
        <span class="step-circle">1</span> <span class="step-nav-text">Add Bookmark</span>
      </button>
      <div class="step-line"></div>
      <button class="step-nav-btn" id="nav-step-2" onclick="goToStep(2)">
        <span class="step-circle">2</span> <span class="step-nav-text">Get Key</span>
      </button>
      <div class="step-line"></div>
      <button class="step-nav-btn" id="nav-step-3" onclick="goToStep(3)">
        <span class="step-circle">3</span> <span class="step-nav-text">Verify Key</span>
      </button>
      <div class="step-line"></div>
      <button class="step-nav-btn" id="nav-step-4" onclick="goToStep(4)">
        <span class="step-circle">4</span> <span class="step-nav-text">Connect App</span>
      </button>
    </div>

    <!-- STEP 1: Add Bookmark -->
    <div id="step-panel-1" class="step-panel card">
      <div class="card-title">
        <span class="step-badge">1</span>
        <span>Add Key Grabber to Bookmarks</span>
      </div>
      <p class="card-desc">Drag this button up to your browser's Bookmarks bar. This will let you grab your DeepSeek key in 1 click whenever you need it:</p>

      <div class="hero-action-card">
        <div class="hero-action-body">
          <a class="bookmarklet-btn" href="${bookmarkletCode}" onclick="showToast('Drag this button to your Bookmarks Bar (press Ctrl+Shift+B if hidden)'); return false;">
            <span>DeepSeek Key Grabber</span>
          </a>
          <div class="drag-hint">Click and drag this button up into your bookmarks bar</div>
          <div class="drag-subhint">Once placed in your bookmarks, you can get your key anytime with a single click.</div>
        </div>
        <div class="hero-action-footer">
          <span><strong>Bookmarks bar hidden?</strong> Press <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>B</kbd> (or <kbd>Cmd</kbd> + <kbd>Shift</kbd> + <kbd>B</kbd> on Mac) to reveal it.</span>
        </div>
      </div>

      <div class="wizard-nav">
        <div></div>
        <button class="btn-primary" onclick="goToStep(2)">Next: Get Key from DeepSeek →</button>
      </div>
    </div>

    <!-- STEP 2: Get Key from DeepSeek -->
    <div id="step-panel-2" class="step-panel card" style="display: none;">
      <div class="card-title">
        <span class="step-badge">2</span>
        <span>Get Your Key from DeepSeek</span>
      </div>
      <p class="card-desc">Follow these 3 simple steps to copy your key directly from your browser session:</p>

      <div class="flow-steps">
        <div class="flow-item">
          <div class="flow-badge">1</div>
          <div class="flow-content">
            <div class="flow-title">Open DeepSeek & Sign In</div>
            <p class="flow-desc">
              Open DeepSeek in a new browser tab. Make sure you are signed in so your account session is active.
            </p>
            <div style="margin-top: 10px;">
              <a href="https://chat.deepseek.com" target="_blank" class="btn-primary" style="font-size: 12.5px; padding: 7px 16px; display: inline-flex; align-items: center;">
                <span>Open chat.deepseek.com</span>
              </a>
            </div>
          </div>
        </div>

        <div class="flow-item">
          <div class="flow-badge">2</div>
          <div class="flow-content">
            <div class="flow-title">Click the Bookmarklet</div>
            <p class="flow-desc">
              While on the <strong>chat.deepseek.com</strong> tab, click the <strong>DeepSeek Key Grabber</strong> bookmark in your browser bar.
            </p>
          </div>
        </div>

        <div class="flow-item">
          <div class="flow-badge">3</div>
          <div class="flow-content">
            <div class="flow-title">Key Copied to Clipboard</div>
            <p class="flow-desc">
              A popup will confirm the key is copied. Your API key is now on your clipboard, ready to use.
            </p>
          </div>
        </div>
      </div>

      <div class="wizard-nav">
        <button class="btn-secondary" onclick="goToStep(1)">← Back to Step 1</button>
        <button class="btn-primary" onclick="goToStep(3)">Next: Verify Key →</button>
      </div>

      <div style="text-align: center; margin-top: 14px;">
        <button class="btn-text" onclick="goToStep(4)" style="font-size: 12px; color: var(--text-subtle);">Already have your key? Skip to Step 4 →</button>
      </div>
    </div>

    <!-- STEP 3: Verify Token Panel -->
    <div id="step-panel-3" class="step-panel card" style="display: none;">
      <div class="card-title">
        <span class="step-badge">3</span>
        <span>Verify Your API Key (Optional)</span>
      </div>
      <p class="card-desc">Paste your key below to test and confirm that it works with the proxy:</p>

      <div>
        <label style="font-size: 11px; text-transform: uppercase; font-weight: 700; color: var(--text-muted);">Paste Your API Key</label>
        <div class="input-row">
          <input type="text" id="test-token-input" class="input-field" placeholder="Paste your key here (Ctrl + V)..." />
          <button id="btn-test-token" class="btn-primary" onclick="runTokenTest()">Verify Key</button>
        </div>
        <div id="test-token-result" style="display: none; padding: 14px; border-radius: 6px; margin-top: 12px;"></div>
      </div>

      <div class="wizard-nav">
        <button class="btn-secondary" onclick="goToStep(2)">← Back to Step 2</button>
        <button class="btn-primary" onclick="goToStep(4)">Next: Connect to App →</button>
      </div>
    </div>

    <!-- STEP 4: Connect to App Panel -->
    <div id="step-panel-4" class="step-panel card" style="display: none;">
      <div class="card-title">
        <span class="step-badge">4</span>
        <span>Connect to Your AI App</span>
      </div>
      <p class="card-desc">Enter these 3 values into your IDE, extension, or OpenAI-compatible client:</p>

      <div>
        <label style="font-size: 11px; text-transform: uppercase; font-weight: 700; color: var(--text-muted);">1. Base URL</label>
        <div class="copy-row">
          <span id="base-url-text">${baseUrl}</span>
          <button class="btn-copy" onclick="copyText('base-url-text', 'Base URL')">Copy URL</button>
        </div>
      </div>

      <div style="margin-top: 14px;">
        <label style="font-size: 11px; text-transform: uppercase; font-weight: 700; color: var(--text-muted);">2. API Key</label>
        <div class="copy-row">
          <span id="api-key-display" style="font-family: var(--font-mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 440px; color: var(--text-muted);">
            (Verified key will appear here, or paste from clipboard)
          </span>
          <button class="btn-copy" id="btn-copy-api-key" onclick="copyTokenStep4()">Copy API Key</button>
        </div>
      </div>

      <div style="margin-top: 14px;">
        <label style="font-size: 11px; text-transform: uppercase; font-weight: 700; color: var(--text-muted);">3. Model Name</label>
        <div class="copy-row">
          <span id="model-name-text">deepseek-reasoner</span>
          <button class="btn-copy" onclick="copyText('model-name-text', 'Model Name')">Copy Model</button>
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
4. In "OpenAI API Key", paste your API key.
5. In model list, add: deepseek-reasoner (or deepseek-chat)</code></pre>
      </div>

      <div id="tab-ide-vscode" class="tab-content">
        <pre><code>In Cline / Continue / Roo Code settings:
Provider: OpenAI Compatible
Base URL: ${baseUrl}
API Key: Paste your API key
Model ID: deepseek-reasoner</code></pre>
      </div>

      <div id="tab-ide-clients" class="tab-content">
        <pre><code>In NextChat, Chatbox, or LibreChat:
API Provider: OpenAI
Base URL (API Host): ${baseUrl}
API Key: Paste your API key
Model: deepseek-reasoner</code></pre>
      </div>

      <div id="tab-ide-python" class="tab-content">
        <pre><code id="py-sdk-code">from openai import OpenAI

client = OpenAI(
    base_url="${baseUrl}",
    api_key="PASTE_YOUR_API_KEY_HERE"
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
        <button class="btn-secondary" onclick="goToStep(3)">← Back to Verify Key</button>
        <button class="btn-primary" onclick="goToStep(1)">Start Over</button>
      </div>
    </div>

    <!-- Optional Developer Section -->
    <div class="card">
      <details>
        <summary>Want to host your own dedicated worker? (For Developers Only)</summary>
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

  <!-- Modern Floating Toast -->
  <div id="toast" class="toast"></div>

  <script>
    let currentStep = 1;
    let savedVerifiedToken = '';
    let toastTimer = null;

    function showToast(msg) {
      const toast = document.getElementById('toast');
      if (!toast) return;
      toast.innerHTML = msg;
      toast.classList.add('show');
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = setTimeout(() => {
        toast.classList.remove('show');
      }, 2500);
    }

    function cleanRawToken(str) {
      let s = (str || '').trim();
      if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
        s = s.slice(1, -1).trim();
      }
      while (s.toLowerCase().startsWith('bearer ')) {
        s = s.substring(7).trim();
      }
      if (s.startsWith('{')) {
        try {
          const p = JSON.parse(s);
          if (p.token) {
            s = p.token.trim();
            while (s.toLowerCase().startsWith('bearer ')) {
              s = s.substring(7).trim();
            }
          }
        } catch(e) {}
      }
      return s;
    }

    function updateApiKeyStep4(cleanKey) {
      savedVerifiedToken = cleanKey;
      const disp = document.getElementById('api-key-display');
      if (disp) {
        disp.textContent = cleanKey;
        disp.style.color = '#000000';
        disp.title = cleanKey;
      }
      const pyCode = document.getElementById('py-sdk-code');
      if (pyCode) {
        pyCode.textContent = 'from openai import OpenAI\\n\\nclient = OpenAI(\\n    base_url="' + "${baseUrl}" + '",\\n    api_key="' + cleanKey + '"\\n)\\n\\nresponse = client.chat.completions.create(\\n    model="deepseek-reasoner",\\n    messages=[{"role": "user", "content": "Hello!"}],\\n    stream=True\\n)\\nfor chunk in response:\\n    print(chunk.choices[0].delta.content or "", end="")';
      }
    }

    const testInput = document.getElementById('test-token-input');
    if (testInput) {
      testInput.addEventListener('input', function() {
        const clean = cleanRawToken(this.value);
        if (clean.length > 20) {
          updateApiKeyStep4(clean);
        }
      });
    }

    function goToStep(step) {
      currentStep = step;
      document.querySelectorAll('.step-panel').forEach(p => p.style.display = 'none');
      const panel = document.getElementById('step-panel-' + step);
      if (panel) panel.style.display = 'block';

      document.querySelectorAll('.step-nav-btn').forEach((btn, idx) => {
        if (idx + 1 === step) {
          btn.classList.add('active');
        } else {
          btn.classList.remove('active');
        }
      });
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    function copyText(elemId, label) {
      const text = document.getElementById(elemId).textContent;
      navigator.clipboard.writeText(text);
      showToast((label || 'Text') + ' copied to clipboard!');
    }

    function copyVerifiedToken() {
      const token = savedVerifiedToken || cleanRawToken(document.getElementById('test-token-input').value);
      if (token) {
        navigator.clipboard.writeText(token);
        showToast('API Key copied to clipboard!');
      } else {
        showToast('No key available yet. Paste your key above and verify.');
      }
    }

    function copyTokenStep4() {
      const token = savedVerifiedToken || cleanRawToken(document.getElementById('test-token-input').value);
      if (token) {
        navigator.clipboard.writeText(token);
        showToast('API Key copied to clipboard!');
      } else {
        showToast('Please complete Step 2 or verify your key in Step 3.');
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
        showToast('Please paste your API key in the box first');
        return;
      }

      const cleanKey = cleanRawToken(raw);
      if (cleanKey !== raw) {
        input.value = cleanKey;
      }

      btn.disabled = true;
      btn.textContent = 'Verifying...';
      resBox.style.display = 'block';
      resBox.style.background = '#fafafa';
      resBox.style.border = '1px solid #111111';
      resBox.style.color = '#000000';
      resBox.innerHTML = 'Verifying key with DeepSeek and solving challenge...';

      try {
        const resp = await fetch('/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + cleanKey
          },
          body: JSON.stringify({
            model: 'deepseek-chat',
            messages: [{ role: 'user', content: 'Say OK' }]
          })
        });

        const data = await resp.json();
        if (resp.ok && data.choices && data.choices[0]) {
          updateApiKeyStep4(cleanKey);
          showToast('API Key verified and saved to Step 4!');
          resBox.style.background = '#fafafa';
          resBox.style.border = '1px solid #111111';
          resBox.style.color = '#000000';
          resBox.innerHTML = \`
            <div style="font-weight: 700; font-size: 14px; margin-bottom: 4px;">Key is active and working!</div>
            <div style="color: #666666; font-size: 13px; margin-bottom: 12px;">DeepSeek answered successfully and your key is saved for Step 4.</div>
            <div>
              <button class="btn-copy" onclick="copyVerifiedToken()">Copy Key</button>
            </div>
          \`;
        } else {
          resBox.style.background = '#fafafa';
          resBox.style.border = '1px solid #111111';
          resBox.style.color = '#000000';
          const errMsg = data.error ? data.error.message : JSON.stringify(data);
          resBox.innerHTML = '<strong>Verification failed:</strong> ' + errMsg;
          showToast('Verification failed');
        }
      } catch (err) {
        resBox.style.background = '#fafafa';
        resBox.style.border = '1px solid #111111';
        resBox.style.color = '#000000';
        resBox.innerHTML = '<strong>Network error:</strong> ' + err.message;
        showToast('Network error: ' + err.message);
      } finally {
        btn.disabled = false;
        btn.textContent = 'Verify Key';
      }
    }
  </script>
</body>
</html>`;
}
