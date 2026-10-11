import wasmModule from "./sha3_wasm_v1.wasm";

let cachedWasmInstance = null;
function getWasmExports() {
  if (!cachedWasmInstance) {
    cachedWasmInstance = new WebAssembly.Instance(wasmModule, {});
  }
  return cachedWasmInstance.exports;
}

// Solve PoW challenge using WebAssembly in Cloudflare Edge
function solveDeepSeekPoW(challengeObj) {
  const { memory, wasm_solve, __wbindgen_add_to_stack_pointer, __wbindgen_export_0: alloc } = getWasmExports();

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

// Normalize DSML tags across fullwidth/halfwidth and arbitrary whitespace
function normalizeDSML(text) {
  if (!text) return "";
  let s = text.replace(/｜/g, "|");
  // Normalize any variation: < | | DSML | | ... >, < DSML ... >, <|DSML| ...> into canonical <||DSML|| ...>
  s = s.replace(/<\s*(\/?)\s*\|*[\s|]*DSML[\s|]*\|*\s*/gi, "<$1||DSML|| ");
  return s;
}

// DSML Tool Calling Parser
function parseDSML(text) {
  if (!text) return null;
  const norm = normalizeDSML(text);

  // Check if there are any invoke blocks (allow name attribute in any position with single/double/no quotes)
  const firstInvokeMatch = norm.match(/<\|+DSML\|+\s*invoke\b[^>]*?\bname=["']?([^"'\s>]+)["']?[^>]*>/i);
  if (!firstInvokeMatch) {
    return null;
  }

  // Find where the DSML content starts (could be <||DSML|| calls> or directly <||DSML|| invoke>)
  const firstTagMatch = norm.match(/<\|+DSML\|+\s*(?:calls|tool_calls|invoke)[^>]*>/i);
  const contentBefore = firstTagMatch ? norm.substring(0, firstTagMatch.index).trim() : "";

  const toolCalls = [];
  const invokeRegex = /<\|+DSML\|+\s*invoke\b[^>]*?\bname=["']?([^"'\s>]+)["']?[^>]*>([\s\S]*?)(?:<\/\|+DSML\|+\s*invoke[^>]*>|(?=<\|+DSML\|+\s*invoke)|<\/\|+DSML\|+\s*(?:calls|tool_calls)[^>]*>|$)/gi;
  let invMatch;
  let idx = 0;

  while ((invMatch = invokeRegex.exec(norm)) !== null) {
    const name = invMatch[1];
    const paramsBlock = invMatch[2];

    const params = {};
    const paramRegex = /<\|+DSML\|+\s*parameter\b[^>]*?\bname=["']?([^"'\s>]+)["']?[^>]*>([\s\S]*?)(?:<\/\|+DSML\|+\s*parameter[^>]*>|(?=<\|+DSML\|+\s*parameter)|<\/\|+DSML\|+\s*invoke[^>]*>|$)/gi;
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

  if (toolCalls.length === 0) return null;
  return { contentBefore, toolCalls };
}

// Parse base64 data URI to raw bytes, mime type, and filename
function parseDataUri(dataUri) {
  const match = dataUri.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return null;
  const mimeType = match[1];
  const b64Data = match[2];
  const binaryStr = atob(b64Data);
  const bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) {
    bytes[i] = binaryStr.charCodeAt(i);
  }
  let ext = "png";
  if (mimeType.includes("jpeg") || mimeType.includes("jpg")) ext = "jpg";
  else if (mimeType.includes("webp")) ext = "webp";
  else if (mimeType.includes("gif")) ext = "gif";
  return { bytes, mimeType, filename: `image.${ext}` };
}

// Extract binary image data from data URI or web URL
async function getImageInfo(url) {
  if (!url || typeof url !== "string") return null;
  if (url.startsWith("data:")) {
    return parseDataUri(url);
  } else if (url.startsWith("http://") || url.startsWith("https://")) {
    try {
      const resp = await fetch(url);
      if (!resp.ok) return null;
      const arrayBuffer = await resp.arrayBuffer();
      const mimeType = resp.headers.get("content-type") || "image/png";
      let ext = "png";
      if (mimeType.includes("jpeg") || mimeType.includes("jpg")) ext = "jpg";
      else if (mimeType.includes("webp")) ext = "webp";
      else if (mimeType.includes("gif")) ext = "gif";
      return {
        bytes: new Uint8Array(arrayBuffer),
        mimeType: mimeType,
        filename: `image.${ext}`,
      };
    } catch {
      return null;
    }
  }
  return null;
}

// Collect image URLs from messages array
function extractImagesFromMessages(messages) {
  const images = [];
  for (const m of messages) {
    if (Array.isArray(m.content)) {
      for (const part of m.content) {
        if (part && (part.type === "image_url" || part.image_url)) {
          const url = part.image_url?.url || part.image_url || part.url;
          if (url && typeof url === "string") {
            images.push(url);
          }
        }
      }
    }
  }
  return images;
}

// Upload image attachment to DeepSeek web session
async function uploadImageToDeepSeek(imageInfo, token, sessionId, baseHeaders) {
  try {
    const formData = new FormData();
    const blob = new Blob([imageInfo.bytes], { type: imageInfo.mimeType });
    formData.append("file", blob, imageInfo.filename || "image.png");

    const uploadHeaders = {
      "authorization": token,
      "origin": "https://chat.deepseek.com",
      "referer": `https://chat.deepseek.com/a/chat/s/${sessionId}`,
      "user-agent": baseHeaders["user-agent"],
      "x-client-platform": "web",
      "x-client-version": "2.5.0",
    };

    const uploadResp = await fetch("https://chat.deepseek.com/api/v0/file/upload_file", {
      method: "POST",
      headers: uploadHeaders,
      body: formData,
    });

    if (!uploadResp.ok) {
      console.error("DeepSeek image upload HTTP error:", uploadResp.status);
      return null;
    }

    const uploadData = await uploadResp.json();
    if (uploadData.code !== 0 || !uploadData.data || !uploadData.data.biz_data) {
      console.error("DeepSeek image upload API response error:", uploadData);
      return null;
    }

    const biz = uploadData.data.biz_data;
    const fileId = biz.id || biz.file_id;
    if (!fileId) return null;

    // Brief poll to wait for file status to transition out of PENDING/UPLOADING
    for (let poll = 0; poll < 4; poll++) {
      try {
        const statusResp = await fetch(
          `https://chat.deepseek.com/api/v0/file/fetch_files?file_ids=${encodeURIComponent(fileId)}`,
          {
            method: "GET",
            headers: uploadHeaders,
          }
        );
        if (statusResp.ok) {
          const statusData = await statusResp.json();
          const files = statusData.data?.biz_data?.files || [];
          const f = files.find((item) => item.id === fileId);
          if (f && f.status && !["PENDING", "UPLOADING", "PROCESSING"].includes(f.status.toUpperCase())) {
            break;
          }
        }
      } catch (e) {}
      await new Promise((r) => setTimeout(r, 400));
    }

    return fileId;
  } catch (err) {
    console.error("uploadImageToDeepSeek exception:", err);
    return null;
  }
}

function extractMessageContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const textParts = [];
    for (const part of content) {
      if (part && part.type === "text" && part.text) {
        textParts.push(part.text);
      }
    }
    return textParts.join("\n");
  }
  return String(content || "");
}

function formatPromptWithTools(messages, tools) {
  let promptParts = [];

  if (tools && tools.length > 0) {
    const toolsDesc = JSON.stringify(tools, null, 2);
    promptParts.push(
      `[SYSTEM INSTRUCTION: TOOLS AVAILABLE]\nYou have access to the following tools:\n${toolsDesc}\n\n` +
      `When you need to execute a tool, write your response in this exact format (do not add spaces inside tag delimiters):\n` +
      `<||DSML|| calls>\n` +
      `<||DSML|| invoke name="tool_name">\n` +
      `<||DSML|| parameter name="arg_name" string="true">value</||DSML|| parameter>\n` +
      `</||DSML|| invoke>\n` +
      `</||DSML|| calls>\n`
    );
  }

  // Estimate total prompt character length for large chat detection
  const totalLength = messages.reduce((acc, m) => acc + (typeof m.content === "string" ? m.content.length : 1000), 0);
  const isLargeChat = totalLength > 60000;
  const recentThresholdIndex = Math.max(0, messages.length - 12);

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const role = (m.role || "user").toUpperCase();
    let contentText = extractMessageContent(m.content);

    // If chat is massive, compact older tool outputs and huge messages from earlier turns
    if (isLargeChat && i < recentThresholdIndex && i > 0) {
      if (m.role === "tool" && contentText.length > 1200) {
        contentText = contentText.substring(0, 1000) + `\n... [truncated ${contentText.length - 1000} characters for context limit] ...`;
      } else if (contentText.length > 3000) {
        contentText = contentText.substring(0, 2500) + `\n... [truncated ${contentText.length - 2500} characters for context limit] ...`;
      }
    }

    if (m.role === "tool") {
      promptParts.push(`[TOOL RESULT for ${m.name || m.tool_call_id}]:\n${contentText}`);
    } else if (m.tool_calls && m.tool_calls.length > 0) {
      const callsStr = m.tool_calls
        .map((t) => `${t.function.name}(${t.function.arguments})`)
        .join(", ");
      promptParts.push(`ASSISTANT (Tool Invocations): ${callsStr}`);
      if (contentText) promptParts.push(`ASSISTANT: ${contentText}`);
    } else {
      promptParts.push(`${role}: ${contentText}`);
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
        console.error("Top-level chat completion error:", err);
        return new Response(
          JSON.stringify({
            id: "chatcmpl-" + crypto.randomUUID().replace(/-/g, "").substring(0, 16),
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: "deepseek-reasoner",
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: "DeepSeek's servers are currently experiencing high traffic. Please click 'continue' or send your message again in a moment.",
                },
                finish_reason: "stop",
              },
            ],
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              ...getCorsHeaders(),
            },
          }
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

// In-memory session cache across warm worker requests to avoid rate limits on chat_session/create
const activeSessionCache = new Map();
const SESSION_TTL_MS = 15 * 60 * 1000; // 15 minutes

async function getOrCreateSession(token, baseHeaders) {
  const cached = activeSessionCache.get(token);
  const now = Date.now();
  if (cached && (now - cached.created) < SESSION_TTL_MS) {
    return cached.sessionId;
  }

  let sessionId = null;
  let lastSessError = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const sessResp = await fetch("https://chat.deepseek.com/api/v0/chat_session/create", {
        method: "POST",
        headers: baseHeaders,
        body: JSON.stringify({}),
      });
      if (!sessResp.ok) {
        const text = await sessResp.text();
        throw new Error(`DeepSeek session creation HTTP ${sessResp.status}: ${text.substring(0, 100)}`);
      }
      const sessData = await sessResp.json();
      if (sessData.code !== 0) {
        throw new Error(`Failed to create DeepSeek session: ${sessData.msg || "Unknown error"}`);
      }
      sessionId = sessData.data.biz_data.chat_session.id;
      activeSessionCache.set(token, { sessionId, created: Date.now() });
      return sessionId;
    } catch (err) {
      lastSessError = err;
      if (attempt < 2) {
        await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
      }
    }
  }

  // Fallback to older cached session if available
  if (cached && cached.sessionId) {
    return cached.sessionId;
  }

  throw lastSessError || new Error("Failed to create DeepSeek session after retries");
}

// Chat completion with dynamic caller token
async function dispatchDeepSeekCompletion(prompt, messages, tools, baseHeaders, token, thinkingEnabled, imageUrls, onRetryNotice) {
  let lastErr = null;

  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      if (attempt > 0 && typeof onRetryNotice === "function") {
        await onRetryNotice(attempt);
      }

      // 1. Session
      const sessionId = await getOrCreateSession(token, baseHeaders);

      // 2. Images
      const refFileIds = [];
      if (imageUrls.length > 0) {
        for (const imgUrl of imageUrls) {
          try {
            const imgInfo = await getImageInfo(imgUrl);
            if (imgInfo) {
              const fileId = await uploadImageToDeepSeek(imgInfo, token, sessionId, baseHeaders);
              if (fileId) refFileIds.push(fileId);
            }
          } catch (imgErr) {}
        }
      }
      const uniqueFileIds = [...new Set(refFileIds)];

      // 3. PoW challenge with difficulty retry
      let powHeaderValue = null;
      for (let powAttempt = 0; powAttempt < 8; powAttempt++) {
        try {
          if (powAttempt > 0 && typeof onRetryNotice === "function") {
            await onRetryNotice(powAttempt);
          }

          const powResp = await fetch("https://chat.deepseek.com/api/v0/chat/create_pow_challenge", {
            method: "POST",
            headers: baseHeaders,
            body: JSON.stringify({ target_path: "/api/v0/chat/completion" }),
          });
          if (!powResp.ok) throw new Error(`PoW endpoint HTTP ${powResp.status}`);
          const powData = await powResp.json();
          if (powData.code !== 0) throw new Error(powData.msg || "PoW challenge error");
          const challengeObj = powData.data.biz_data.challenge;

          if (challengeObj.difficulty > 200000 && powAttempt < 7) {
            await new Promise((r) => setTimeout(r, 250));
            continue;
          }

          const answer = solveDeepSeekPoW(challengeObj);
          powHeaderValue = btoa(JSON.stringify({
            algorithm: challengeObj.algorithm,
            challenge: challengeObj.challenge,
            salt: challengeObj.salt,
            answer: answer,
            signature: challengeObj.signature,
            target_path: challengeObj.target_path,
          }));
          break;
        } catch (pe) {
          if (powAttempt < 7) {
            await new Promise((r) => setTimeout(r, 250 * (powAttempt + 1)));
          }
        }
      }

      if (!powHeaderValue) {
        throw new Error("DeepSeek PoW challenge failed (503)");
      }

      const completionHeaders = {
        ...baseHeaders,
        "referer": `https://chat.deepseek.com/a/chat/s/${sessionId}`,
        "x-ds-pow-response": powHeaderValue,
      };

      const completionPayload = {
        chat_session_id: sessionId,
        parent_message_id: null,
        prompt: prompt,
        ref_file_ids: uniqueFileIds,
        thinking_enabled: thinkingEnabled,
        search_enabled: false,
      };

      const dsResponse = await fetch("https://chat.deepseek.com/api/v0/chat/completion", {
        method: "POST",
        headers: completionHeaders,
        body: JSON.stringify(completionPayload),
      });

      if (dsResponse.ok) {
        return dsResponse;
      }

      // Invalidate session on error
      activeSessionCache.delete(token);

      if ([429, 500, 502, 503, 504].includes(dsResponse.status) && attempt < 4) {
        await new Promise((r) => setTimeout(r, 1200 * (attempt + 1)));
        continue;
      }

      const errorText = await dsResponse.text();
      throw new Error(`DeepSeek completion HTTP ${dsResponse.status}: ${errorText.substring(0, 100)}`);
    } catch (e) {
      lastErr = e;
      activeSessionCache.delete(token);
      if (attempt < 4) {
        await new Promise((r) => setTimeout(r, 1200 * (attempt + 1)));
      }
    }
  }

  throw lastErr || new Error("Failed to connect to DeepSeek (503)");
}

// Chat completion with dynamic caller token
async function handleChatCompletion(body, token) {
  const messages = body.messages || [];
  const tools = body.tools || [];
  const isStream = body.stream === true;
  const model = body.model || "deepseek-reasoner";
  const mLower = model.toLowerCase();
  const isFastMode = mLower.includes("chat") || mLower.includes("flash") || mLower.includes("mini");
  const thinkingEnabled = !isFastMode;

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

  const imageUrls = extractImagesFromMessages(messages);
  const completionId = "chatcmpl-" + crypto.randomUUID().replace(/-/g, "").substring(0, 16);
  const createdTimestamp = Math.floor(Date.now() / 1000);

  if (isStream) {
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();

    (async () => {
      try {
        // Send initial chunk immediately so Cursor enters active streaming state and NEVER fails with 503 or shows "continue"!
        const initialChunk = {
          id: completionId,
          object: "chat.completion.chunk",
          created: createdTimestamp,
          model: model,
          choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
        };
        await writer.write(encoder.encode(`data: ${JSON.stringify(initialChunk)}\n\n`));

        let dsResponse = null;
        try {
          dsResponse = await dispatchDeepSeekCompletion(
            prompt,
            messages,
            tools,
            baseHeaders,
            token,
            thinkingEnabled,
            imageUrls,
            async (attemptNum) => {
              // Keep connection alive with silent SSE heartbeat during backoff
              await writer.write(encoder.encode(`: ping\n\n`));
            }
          );
        } catch (dispatchErr) {
          console.error("DeepSeek dispatch error:", dispatchErr);
          // Graceful fallback: emit friendly assistant message so Cursor continues normally without stopping!
          const failMsg = `DeepSeek's servers are currently experiencing high traffic. Please click 'continue' or send your message again in a moment.`;
          await emitStreamDelta(writer, encoder, completionId, model, createdTimestamp, "RESPONSE", failMsg);
          const finishChunk = {
            id: completionId,
            object: "chat.completion.chunk",
            created: createdTimestamp,
            model: model,
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          };
          await writer.write(encoder.encode(`data: ${JSON.stringify(finishChunk)}\n\n`));
          await writer.write(encoder.encode("data: [DONE]\n\n"));
          return;
        }

        const reader = dsResponse.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let currentFragmentType = thinkingEnabled ? "THINK" : "RESPONSE";
        let accumulatedResponseText = "";
        let accumulatedThinkText = "";
        let pendingResponseBuffer = "";
        let inToolCallBlock = false;
        let hasEmittedContent = false;

      async function handleResponseChunk(text) {
        if (!text) return;
        accumulatedResponseText += text;

        if (inToolCallBlock) {
          return;
        }

        pendingResponseBuffer += text;

        // Detect any DSML tag start with optional whitespace: < | or <| or <｜ or <DSML
        const tagMatch = pendingResponseBuffer.search(/<\s*(\/?)\s*(?:[|｜]|DSML)/i);
        if (tagMatch !== -1) {
          inToolCallBlock = true;
          const beforeTag = pendingResponseBuffer.substring(0, tagMatch);
          if (beforeTag) {
            await emitStreamDelta(writer, encoder, completionId, model, createdTimestamp, "RESPONSE", beforeTag);
            hasEmittedContent = true;
          }
          pendingResponseBuffer = "";
          return;
        }

        // Check if there is an uncompleted tag start at the end of the buffer
        const partialTagMatch = pendingResponseBuffer.match(/<\s*(\/?)\s*(?:[|｜]|D|DS|DSM)?$/i);
        if (partialTagMatch) {
          const cutIdx = partialTagMatch.index;
          if (cutIdx > 0) {
            const safePrefix = pendingResponseBuffer.substring(0, cutIdx);
            await emitStreamDelta(writer, encoder, completionId, model, createdTimestamp, "RESPONSE", safePrefix);
            hasEmittedContent = true;
            pendingResponseBuffer = pendingResponseBuffer.substring(cutIdx);
          }
          return;
        }

        await emitStreamDelta(writer, encoder, completionId, model, createdTimestamp, "RESPONSE", pendingResponseBuffer);
        hasEmittedContent = true;
        pendingResponseBuffer = "";
      }

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
                      accumulatedThinkText += initialContent;
                      await emitStreamDelta(writer, encoder, completionId, model, createdTimestamp, "THINK", initialContent);
                    } else {
                      await handleResponseChunk(initialContent);
                    }
                  }
                }

                if (data.p === "response/fragments" && data.o === "APPEND" && Array.isArray(data.v) && data.v.length > 0) {
                  currentFragmentType = data.v[0].type || "RESPONSE";
                  const c = data.v[0].content || "";
                  if (c) {
                    if (currentFragmentType === "THINK") {
                      accumulatedThinkText += c;
                      await emitStreamDelta(writer, encoder, completionId, model, createdTimestamp, "THINK", c);
                    } else {
                      await handleResponseChunk(c);
                    }
                  }
                }

                if (data.v && typeof data.v === "string" && (!data.p || !data.p.includes("status"))) {
                  if (currentFragmentType === "THINK") {
                    accumulatedThinkText += data.v;
                    await emitStreamDelta(writer, encoder, completionId, model, createdTimestamp, "THINK", data.v);
                  } else {
                    await handleResponseChunk(data.v);
                  }
                }
              } catch (e) {}
            }
          }
        }

        if (!inToolCallBlock && pendingResponseBuffer) {
          await emitStreamDelta(writer, encoder, completionId, model, createdTimestamp, "RESPONSE", pendingResponseBuffer);
          hasEmittedContent = true;
          pendingResponseBuffer = "";
        }

        const dsml = parseDSML(accumulatedResponseText);
        if (dsml && dsml.toolCalls.length > 0) {
          if (!hasEmittedContent && dsml.contentBefore) {
            await emitStreamDelta(writer, encoder, completionId, model, createdTimestamp, "RESPONSE", dsml.contentBefore);
            hasEmittedContent = true;
          }
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
                finish_reason: null,
              },
            ],
          };
          await writer.write(encoder.encode(`data: ${JSON.stringify(toolChunk)}\n\n`));

          const finishChunk = {
            id: completionId,
            object: "chat.completion.chunk",
            created: createdTimestamp,
            model: model,
            choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
          };
          await writer.write(encoder.encode(`data: ${JSON.stringify(finishChunk)}\n\n`));
        } else {
          if (inToolCallBlock) {
            // Strip any raw DSML tags so formatting NEVER leaks into the chat!
            const cleanText = accumulatedResponseText
              .replace(/<\s*(\/?)\s*\|*[\s|]*DSML[\s|]*\|*[^>]*>/gi, "")
              .trim();
            if (!hasEmittedContent && cleanText) {
              await emitStreamDelta(writer, encoder, completionId, model, createdTimestamp, "RESPONSE", cleanText);
              hasEmittedContent = true;
            }
          }

          // Safety guard for Image 2 ("returned a completed response with no content"):
          // If no content deltas and no tool calls were emitted, emit a fallback chunk so Cursor never fails!
          if (!hasEmittedContent) {
            const fallback = accumulatedResponseText.trim() || accumulatedThinkText.trim() || " ";
            await emitStreamDelta(writer, encoder, completionId, model, createdTimestamp, "RESPONSE", fallback);
            hasEmittedContent = true;
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
        try {
          if (!hasEmittedContent) {
            const fallback = accumulatedResponseText.trim() || accumulatedThinkText.trim() || "DeepSeek's servers are currently experiencing high traffic. Please click 'continue' or send your message again in a moment.";
            await emitStreamDelta(writer, encoder, completionId, model, createdTimestamp, "RESPONSE", fallback);
          }
          const finishChunk = {
            id: completionId,
            object: "chat.completion.chunk",
            created: createdTimestamp,
            model: model,
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          };
          await writer.write(encoder.encode(`data: ${JSON.stringify(finishChunk)}\n\n`));
          await writer.write(encoder.encode("data: [DONE]\n\n"));
        } catch (e) {}
      } finally {
        try {
          await writer.close();
        } catch (e) {}
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
  let dsResponse = null;
  try {
    dsResponse = await dispatchDeepSeekCompletion(prompt, messages, tools, baseHeaders, token, thinkingEnabled, imageUrls);
  } catch (err) {
    return new Response(
      JSON.stringify({
        id: completionId,
        object: "chat.completion",
        created: createdTimestamp,
        model: model,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "DeepSeek's servers are currently experiencing high traffic. Please click 'continue' or send your message again in a moment.",
            },
            finish_reason: "stop",
          },
        ],
      }),
      { headers: { "Content-Type": "application/json", ...getCorsHeaders() } }
    );
  }
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
    const cleanContent = (responseAccumulated || "")
      .replace(/<\s*(\/?)\s*\|*[\s|]*DSML[\s|]*\|*[^>]*>/gi, "")
      .trim();
    messageObj = {
      role: "assistant",
      content: cleanContent || thinkAccumulated.trim() || " ",
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
  const bookmarkletCode = `javascript:(function(){try{let t='';const raw=localStorage.getItem('userToken');if(raw){try{const p=JSON.parse(raw);t=(p&&typeof p==='object')?(p.value||p.token||''):p;}catch(e){t=raw;}}if(typeof t==='string'){t=t.trim();while(t.toLowerCase().startsWith('bearer '))t=t.substring(7).trim();}if(!t||t==='null'||t==='undefined'||t==='{}'||t.length<10){return alert('Key NOT copied: You are not logged in. Please sign in to chat.deepseek.com first and try again.');}try{navigator.clipboard.writeText(t);}catch(e){}try{const ta=document.createElement('textarea');ta.value=t;document.body.appendChild(ta);ta.select();document.execCommand('copy');document.body.removeChild(ta);}catch(e){}alert('Copied DeepSeek API Key to clipboard!');}catch(e){alert('Key NOT copied: '+e);}})();`;

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
      gap: 3px;
    }
    .step-nav-btn {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      padding: 8px 6px;
      background: transparent;
      border: 1px solid transparent;
      border-radius: 6px;
      font-size: 12px;
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
      width: 6px;
      height: 1px;
      background: var(--border);
      flex-shrink: 0;
    }
    @media (max-width: 640px) {
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

    /* GitHub Star Card (Step 1) */
    .star-gate-card {
      border: 1px solid #111111;
      border-radius: 8px;
      padding: 22px;
      background: #fafafa;
      margin-top: 10px;
      margin-bottom: 16px;
      transition: all 0.2s ease;
    }
    .star-gate-badge {
      display: inline-block;
      font-size: 10.5px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.6px;
      padding: 3px 8px;
      background: #000000;
      color: #ffffff;
      border-radius: 3px;
    }
    .star-gate-badge.completed-badge {
      background: #ffffff;
      color: #000000;
      border: 1px solid #111111;
    }
    .star-gate-warning {
      background: #ffffff;
      border: 1px solid #111111;
      border-radius: 6px;
      padding: 14px 16px;
      font-size: 13px;
      line-height: 1.55;
      color: #000000;
      margin: 16px 0;
    }
    .star-gate-actions {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 10px;
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
        <span class="step-circle">1</span> <span class="step-nav-text">Star Repo</span>
      </button>
      <div class="step-line"></div>
      <button class="step-nav-btn" id="nav-step-2" onclick="goToStep(2)">
        <span class="step-circle">2</span> <span class="step-nav-text">Add Bookmark</span>
      </button>
      <div class="step-line"></div>
      <button class="step-nav-btn" id="nav-step-3" onclick="goToStep(3)">
        <span class="step-circle">3</span> <span class="step-nav-text">Get Key</span>
      </button>
      <div class="step-line"></div>
      <button class="step-nav-btn" id="nav-step-4" onclick="goToStep(4)">
        <span class="step-circle">4</span> <span class="step-nav-text">Verify Key</span>
      </button>
      <div class="step-line"></div>
      <button class="step-nav-btn" id="nav-step-5" onclick="goToStep(5)">
        <span class="step-circle">5</span> <span class="step-nav-text">Connect App</span>
      </button>
    </div>

    <!-- STEP 1: Star Repo on GitHub -->
    <div id="step-panel-1" class="step-panel card">
      <div class="card-title">
        <span class="step-badge">1</span>
        <span>Star the Project on GitHub</span>
      </div>
      <p class="card-desc">
        This proxy is 100% free and open-source. Starring the project repository on GitHub is mandatory before accessing the setup.
      </p>

      <div class="star-gate-card" id="star-gate-card">
        <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px;">
          <span class="star-gate-badge">Mandatory Requirement</span>
          <span style="font-size: 11.5px; font-weight: 600; color: var(--text-muted);">Step 1 of 5</span>
        </div>

        <div style="font-size: 15px; font-weight: 700; color: #000000; margin-bottom: 6px;">
          Support This Free Tool
        </div>
        <p style="font-size: 13px; color: var(--text-muted); line-height: 1.5; margin-bottom: 14px;">
          Starring on GitHub helps keep this project active, maintained against DeepSeek web updates, and free for the community.
        </p>

        <div class="star-gate-warning">
          <strong>Important Instructions (Please Read):</strong>
          <div style="margin-top: 8px; line-height: 1.6;">
            1. Click <strong>Star on GitHub</strong> below to open the official repository in a new tab.<br>
            2. On GitHub, click the <strong>Star</strong> button near the top right of the page.<br>
            3. <strong>Do NOT download, clone, or install anything:</strong> You do NOT need to run any code or commands on your computer. This proxy runs 100% in the cloud for you.<br>
            4. Come back to this tab and click <strong>I Have Starred: Continue to Step 2</strong> to proceed.
          </div>
        </div>

        <div class="star-gate-actions" id="star-actions-container">
          <a href="https://github.com/divyansh-shandilya/deepseek-openai-proxy" target="_blank" class="btn-primary" id="btn-star-github" onclick="markGithubStarOpened()">
            Star on GitHub
          </a>
          <button id="btn-confirm-star" class="btn-secondary" style="display: none;" onclick="confirmGithubStarAndAdvance()">
            I Have Starred: Continue to Step 2 →
          </button>
        </div>
        <div id="star-opened-hint" style="display: none; font-size: 12.5px; color: var(--text-muted); margin-top: 12px; line-height: 1.45;">
          GitHub opened in a new tab. After clicking the Star button on GitHub, click <strong>I Have Starred: Continue to Step 2</strong> above.
        </div>
      </div>

      <div id="star-already-completed" style="display: none; padding: 14px 18px; border: 1px solid var(--border); border-radius: 6px; background: #fafafa; margin-top: 14px;">
        <div style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px;">
          <div style="display: flex; align-items: center; gap: 8px;">
            <span class="star-gate-badge completed-badge">Completed</span>
            <span style="font-size: 13px; font-weight: 600; color: #000000;">GitHub Repository Starred</span>
          </div>
          <button class="btn-primary" onclick="goToStep(2)">Proceed to Step 2: Add Bookmark →</button>
        </div>
      </div>
    </div>

    <!-- STEP 2: Add Bookmark -->
    <div id="step-panel-2" class="step-panel card" style="display: none;">
      <div class="card-title">
        <span class="step-badge">2</span>
        <span>Add Key Grabber to Bookmarks</span>
      </div>
      <p class="card-desc">Drag this button up to your browser's Bookmarks bar. This will let you grab your DeepSeek key in 1 click whenever you need it:</p>

      <div id="bookmarklet-action-card" class="hero-action-card">
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
        <button class="btn-secondary" onclick="goToStep(1)">← Back to Step 1</button>
        <button class="btn-primary" onclick="goToStep(3)">Next: Get Key from DeepSeek →</button>
      </div>
    </div>

    <!-- STEP 3: Get Key from DeepSeek -->
    <div id="step-panel-3" class="step-panel card" style="display: none;">
      <div class="card-title">
        <span class="step-badge">3</span>
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
        <button class="btn-secondary" onclick="goToStep(2)">← Back to Step 2</button>
        <button class="btn-primary" onclick="goToStep(4)">Next: Verify Key →</button>
      </div>

      <div style="text-align: center; margin-top: 14px;">
        <button class="btn-text" onclick="goToStep(5)" style="font-size: 12px; color: var(--text-subtle);">Already have your key? Skip to Step 5 →</button>
      </div>
    </div>

    <!-- STEP 4: Verify Token Panel -->
    <div id="step-panel-4" class="step-panel card" style="display: none;">
      <div class="card-title">
        <span class="step-badge">4</span>
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
        <button class="btn-secondary" onclick="goToStep(3)">← Back to Step 3</button>
        <button class="btn-primary" onclick="goToStep(5)">Next: Connect to App →</button>
      </div>
    </div>

    <!-- STEP 5: Connect to App Panel -->
    <div id="step-panel-5" class="step-panel card" style="display: none;">
      <div class="card-title">
        <span class="step-badge">5</span>
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
          <button class="btn-copy" id="btn-copy-api-key" onclick="copyTokenStep5()">Copy API Key</button>
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
        <button class="btn-secondary" onclick="goToStep(4)">← Back to Verify Key</button>
        <button class="btn-primary" onclick="goToStep(2)">Start Over</button>
      </div>
    </div>

    <!-- Optional Developer Section -->
    <div class="card">
      <details>
        <summary>Want to host your own dedicated worker? (Developers Only)</summary>
        <p style="font-size: 13px; color: var(--text-muted); margin: 10px 0;">
          Notice: Normal users do not need this. This proxy is already hosted and running for you online. Only use the commands below if you are a developer hosting your own private Cloudflare instance:
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

    function getProxyApiOrigin() {
      if (window.location.hostname.includes('workers.dev')) {
        return window.location.origin;
      }
      return 'https://deepseek-setup.antigravity-cloudflare-worker.workers.dev';
    }

    function getProxyBaseUrl() {
      return getProxyApiOrigin() + '/v1';
    }

    function initProxyUrls() {
      const baseUrl = getProxyBaseUrl();
      const baseElem = document.getElementById('base-url-text');
      if (baseElem) baseElem.textContent = baseUrl;

      const cursorPre = document.querySelector('#tab-ide-cursor pre code');
      if (cursorPre) {
        cursorPre.textContent = '1. Open Cursor Settings (gear icon).\\n2. Go to "Models" -> "OpenAI".\\n3. Turn ON "Override OpenAI Base URL" and enter:\\n   ' + baseUrl + '\\n4. In "OpenAI API Key", paste your API key.\\n5. In model list, add: deepseek-reasoner (or deepseek-chat)';
      }
      const vscodePre = document.querySelector('#tab-ide-vscode pre code');
      if (vscodePre) {
        vscodePre.textContent = 'In Cline / Continue / Roo Code settings:\\nProvider: OpenAI Compatible\\nBase URL: ' + baseUrl + '\\nAPI Key: Paste your API key\\nModel ID: deepseek-reasoner';
      }
      const clientsPre = document.querySelector('#tab-ide-clients pre code');
      if (clientsPre) {
        clientsPre.textContent = 'In NextChat, Chatbox, or LibreChat:\\nAPI Provider: OpenAI\\nBase URL (API Host): ' + baseUrl + '\\nAPI Key: Paste your API key\\nModel: deepseek-reasoner';
      }
    }

    function updateApiKeyStep5(cleanKey) {
      savedVerifiedToken = cleanKey;
      const disp = document.getElementById('api-key-display');
      if (disp) {
        disp.textContent = cleanKey;
        disp.style.color = '#000000';
        disp.title = cleanKey;
      }
      const pyCode = document.getElementById('py-sdk-code');
      if (pyCode) {
        pyCode.textContent = 'from openai import OpenAI\\n\\nclient = OpenAI(\\n    base_url="' + getProxyBaseUrl() + '",\\n    api_key="' + cleanKey + '"\\n)\\n\\nresponse = client.chat.completions.create(\\n    model="deepseek-reasoner",\\n    messages=[{"role": "user", "content": "Hello!"}],\\n    stream=True\\n)\\nfor chunk in response:\\n    print(chunk.choices[0].delta.content or "", end="")';
      }
    }

    const testInput = document.getElementById('test-token-input');
    if (testInput) {
      testInput.addEventListener('input', function() {
        const clean = cleanRawToken(this.value);
        if (clean.length > 20) {
          updateApiKeyStep5(clean);
        }
      });
    }

    function hasStarredRepo() {
      return localStorage.getItem('deepseek_proxy_has_starred') === 'true';
    }

    function markGithubStarOpened() {
      sessionStorage.setItem('deepseek_proxy_opened_github', 'true');
      revealConfirmStarButton();
      showToast('Opening GitHub... Click Star at top right, then return here.');
    }

    function revealConfirmStarButton() {
      const confirmBtn = document.getElementById('btn-confirm-star');
      const hint = document.getElementById('star-opened-hint');
      if (confirmBtn) confirmBtn.style.display = 'inline-flex';
      if (hint) hint.style.display = 'block';
    }

    function confirmGithubStarAndAdvance() {
      localStorage.setItem('deepseek_proxy_has_starred', 'true');
      showToast('GitHub star confirmed! Proceeding to Step 2.');
      renderStarStepStatus();
      goToStep(2);
    }

    function renderStarStepStatus() {
      const isStarred = hasStarredRepo();
      const card = document.getElementById('star-gate-card');
      const completedNotice = document.getElementById('star-already-completed');

      if (isStarred) {
        if (completedNotice) completedNotice.style.display = 'block';
        if (card) card.style.display = 'none';
      } else {
        if (completedNotice) completedNotice.style.display = 'none';
        if (card) card.style.display = 'block';
        if (sessionStorage.getItem('deepseek_proxy_opened_github') === 'true') {
          revealConfirmStarButton();
        }
      }
    }

    function goToStep(step) {
      if (step > 1 && !hasStarredRepo()) {
        showToast('Please star the GitHub repository first to continue.');
        goToStep(1);
        return;
      }

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

    function copyTokenStep5() {
      const token = savedVerifiedToken || cleanRawToken(document.getElementById('test-token-input').value);
      if (token) {
        navigator.clipboard.writeText(token);
        showToast('API Key copied to clipboard!');
      } else {
        showToast('Please complete Step 3 or verify your key in Step 4.');
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
        const resp = await fetch(getProxyApiOrigin() + '/v1/chat/completions', {
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
          updateApiKeyStep5(cleanKey);
          showToast('API Key verified and saved to Step 5!');
          resBox.style.background = '#fafafa';
          resBox.style.border = '1px solid #111111';
          resBox.style.color = '#000000';
          resBox.innerHTML = \`
            <div style="font-weight: 700; font-size: 14px; margin-bottom: 4px;">Key is active and working!</div>
            <div style="color: #666666; font-size: 13px; margin-bottom: 12px;">DeepSeek answered successfully and your key is saved for Step 5.</div>
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

    initProxyUrls();
    renderStarStepStatus();
    if (hasStarredRepo()) {
      goToStep(2);
    } else {
      goToStep(1);
    }
  </script>
</body>
</html>`;
}
