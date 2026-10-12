#!/usr/bin/env node

/**
 * freeseek - Local DeepSeek OpenAI-Compatible Proxy
 * High-performance local server with WebAssembly PoW solving and DSML tool calling.
 *
 * Runs locally on Node.js without Cloudflare CPU/timeout limits.
 */

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

// -----------------------------------------------------------------------------
// WebAssembly PoW Solver
// -----------------------------------------------------------------------------
let cachedWasmInstance = null;
function getWasmExports() {
  if (!cachedWasmInstance) {
    const wasmPath = path.join(__dirname, "..", "src", "sha3_wasm_v1.wasm");
    const wasmBytes = fs.readFileSync(wasmPath);
    const wasmModule = new WebAssembly.Module(wasmBytes);
    cachedWasmInstance = new WebAssembly.Instance(wasmModule, {});
  }
  return cachedWasmInstance.exports;
}

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

// -----------------------------------------------------------------------------
// DSML Tool Calling Parser
// -----------------------------------------------------------------------------
function normalizeDSML(text) {
  if (!text) return "";
  let s = text.replace(/｜/g, "|");
  s = s.replace(/<\s*(\/?)\s*\|*[\s|]*DSML[\s|]*\|*\s*/gi, "<$1||DSML|| ");
  return s;
}

function parseDSML(text) {
  if (!text) return null;
  const norm = normalizeDSML(text);

  const firstInvokeMatch = norm.match(/<\|+DSML\|+\s*invoke\b[^>]*?\bname=["']?([^"'\s>]+)["']?[^>]*>/i);
  if (!firstInvokeMatch) {
    return null;
  }

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

// -----------------------------------------------------------------------------
// Image Processing
// -----------------------------------------------------------------------------
function parseDataUri(dataUri) {
  const match = dataUri.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return null;
  const mimeType = match[1];
  const b64Data = match[2];
  const buf = Buffer.from(b64Data, "base64");
  let ext = "png";
  if (mimeType.includes("jpeg") || mimeType.includes("jpg")) ext = "jpg";
  else if (mimeType.includes("webp")) ext = "webp";
  else if (mimeType.includes("gif")) ext = "gif";
  return { bytes: new Uint8Array(buf), mimeType, filename: `image.${ext}` };
}

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

function extractImagesFromMessages(messages) {
  const urls = [];
  if (!Array.isArray(messages)) return urls;
  for (const m of messages) {
    if (Array.isArray(m.content)) {
      for (const part of m.content) {
        if (part && part.type === "image_url" && part.image_url && part.image_url.url) {
          urls.push(part.image_url.url);
        }
      }
    }
  }
  return urls;
}

async function uploadImageToDeepSeek(imgInfo, token, sessionId, baseHeaders) {
  try {
    const uploadHeaders = {
      ...baseHeaders,
      "referer": `https://chat.deepseek.com/a/chat/s/${sessionId}`,
    };
    delete uploadHeaders["content-type"];

    const formData = new FormData();
    const blob = new Blob([imgInfo.bytes], { type: imgInfo.mimeType });
    formData.append("file", blob, imgInfo.filename);

    const uploadResp = await fetch("https://chat.deepseek.com/api/v0/file/upload", {
      method: "POST",
      headers: uploadHeaders,
      body: formData,
    });

    if (!uploadResp.ok) return null;
    const uploadData = await uploadResp.json();
    if (uploadData.code !== 0 || !uploadData.data || !uploadData.data.biz_data) return null;

    const fileId = uploadData.data.biz_data.id || uploadData.data.biz_data.file_id;
    if (!fileId) return null;

    // Brief poll to wait for status to be ready
    for (let poll = 0; poll < 4; poll++) {
      try {
        const statusResp = await fetch(
          `https://chat.deepseek.com/api/v0/file/fetch_files?file_ids=${encodeURIComponent(fileId)}`,
          { method: "GET", headers: uploadHeaders }
        );
        if (statusResp.ok) {
          const statusData = await statusResp.json();
          const files = statusData.data?.biz_data?.files || [];
          const f = files.find((item) => item.id === fileId);
          if (f && f.status && !["PENDING", "UPLOADING", "PROCESSING"].includes(f.status.toUpperCase())) {
            break;
          }
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 300));
    }

    return fileId;
  } catch (err) {
    console.error("Image upload error:", err);
    return null;
  }
}

// -----------------------------------------------------------------------------
// Prompt Formatting & Session Management
// -----------------------------------------------------------------------------
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
      `When you need to execute a tool, write your response in this exact format:\n` +
      `<||DSML|| calls>\n` +
      `<||DSML|| invoke name="tool_name">\n` +
      `<||DSML|| parameter name="arg_name" string="true">value</||DSML|| parameter>\n` +
      `</||DSML|| invoke>\n` +
      `</||DSML|| calls>\n`
    );
  }

  const totalLength = messages.reduce((acc, m) => acc + (typeof m.content === "string" ? m.content.length : 1000), 0);
  const isLargeChat = totalLength > 60000;
  const recentThresholdIndex = Math.max(0, messages.length - 12);

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const role = (m.role || "user").toUpperCase();
    let contentText = extractMessageContent(m.content);

    if (isLargeChat && i < recentThresholdIndex) {
      if (role === "TOOL" || role === "FUNCTION") {
        if (contentText.length > 1200) {
          contentText = contentText.substring(0, 1200) + "\n...[truncated historical tool output]...";
        }
      } else if (contentText.length > 3000) {
        contentText = contentText.substring(0, 3000) + "\n...[compacted earlier message]...";
      }
    }

    if (m.tool_calls && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      let dsmlCalls = "<||DSML|| calls>\n";
      for (const tc of m.tool_calls) {
        const fnName = tc.function?.name || "tool";
        let fnArgs = {};
        try {
          fnArgs = typeof tc.function?.arguments === "string" ? JSON.parse(tc.function.arguments) : tc.function?.arguments || {};
        } catch {
          fnArgs = { raw: tc.function?.arguments };
        }
        dsmlCalls += `<||DSML|| invoke name="${fnName}">\n`;
        for (const [k, v] of Object.entries(fnArgs)) {
          const valStr = typeof v === "object" ? JSON.stringify(v) : String(v);
          dsmlCalls += `<||DSML|| parameter name="${k}" string="true">${valStr}</||DSML|| parameter>\n`;
        }
        dsmlCalls += `</||DSML|| invoke>\n`;
      }
      dsmlCalls += `</||DSML|| calls>`;
      promptParts.push(`[${role}]: ${contentText ? contentText + "\n" : ""}${dsmlCalls}`);
    } else if (role === "TOOL" || role === "FUNCTION") {
      promptParts.push(`[TOOL RESULT]:\n${contentText}`);
    } else {
      promptParts.push(`[${role}]: ${contentText}`);
    }
  }

  return promptParts.join("\n\n");
}

const activeSessionCache = new Map();
const SESSION_TTL_MS = 15 * 60 * 1000;

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
      if (attempt < 2) await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
    }
  }

  if (cached && cached.sessionId) return cached.sessionId;
  throw lastSessError || new Error("Failed to create DeepSeek session after retries");
}

async function dispatchDeepSeekCompletion(prompt, messages, tools, baseHeaders, token, thinkingEnabled, imageUrls, options = {}) {
  let lastErr = null;
  const targetSessionId = options.sessionId || null;
  const parentMessageId = options.parentMessageId !== undefined ? options.parentMessageId : null;
  const useThinking = options.thinkingEnabled !== undefined ? options.thinkingEnabled : thinkingEnabled;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const sessionId = targetSessionId || await getOrCreateSession(token, baseHeaders);

      const refFileIds = [];
      if (imageUrls.length > 0) {
        for (const imgUrl of imageUrls) {
          try {
            const imgInfo = await getImageInfo(imgUrl);
            if (imgInfo) {
              const fileId = await uploadImageToDeepSeek(imgInfo, token, sessionId, baseHeaders);
              if (fileId) refFileIds.push(fileId);
            }
          } catch {}
        }
      }
      const uniqueFileIds = [...new Set(refFileIds)];

      let powHeaderValue = null;
      for (let powAttempt = 0; powAttempt < 5; powAttempt++) {
        try {
          const powResp = await fetch("https://chat.deepseek.com/api/v0/chat/create_pow_challenge", {
            method: "POST",
            headers: baseHeaders,
            body: JSON.stringify({ target_path: "/api/v0/chat/completion" }),
          });
          if (!powResp.ok) throw new Error(`PoW endpoint HTTP ${powResp.status}`);
          const powData = await powResp.json();
          if (powData.code !== 0) throw new Error(powData.msg || "PoW challenge error");
          const challengeObj = powData.data.biz_data.challenge;

          // Local node runs fast without worker CPU limits
          const t0 = Date.now();
          const answer = solveDeepSeekPoW(challengeObj);
          const elapsed = Date.now() - t0;
          console.log(`  [PoW] Solved difficulty ${challengeObj.difficulty} in ${elapsed}ms (answer: ${answer})`);

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
          if (powAttempt < 4) await new Promise((r) => setTimeout(r, 200 * (powAttempt + 1)));
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
        parent_message_id: parentMessageId,
        prompt: prompt,
        ref_file_ids: uniqueFileIds,
        thinking_enabled: useThinking,
        search_enabled: false,
      };

      const dsResponse = await fetch("https://chat.deepseek.com/api/v0/chat/completion", {
        method: "POST",
        headers: completionHeaders,
        body: JSON.stringify(completionPayload),
      });

      if (dsResponse.ok) {
        return { response: dsResponse, sessionId };
      }

      activeSessionCache.delete(token);

      if ([429, 500, 502, 503, 504].includes(dsResponse.status) && attempt < 2) {
        await new Promise((r) => setTimeout(r, 800));
        continue;
      }

      const errorText = await dsResponse.text();
      throw new Error(`DeepSeek completion HTTP ${dsResponse.status}: ${errorText.substring(0, 100)}`);
    } catch (e) {
      lastErr = e;
      activeSessionCache.delete(token);
      if (attempt < 2) await new Promise((r) => setTimeout(r, 800));
    }
  }

  throw lastErr || new Error("Failed to connect to DeepSeek (503)");
}

function writeSSE(res, data) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function emitStreamDelta(res, completionId, model, created, fragmentType, text) {
  const delta = {};
  if (fragmentType === "THINK") {
    delta.reasoning_content = text;
  } else {
    delta.content = text;
  }
  writeSSE(res, {
    id: completionId,
    object: "chat.completion.chunk",
    created: created,
    model: model,
    choices: [{ index: 0, delta: delta, finish_reason: null }],
  });
}

// -----------------------------------------------------------------------------
// Auto-Continue Verification Engine Helpers
// -----------------------------------------------------------------------------
function checkNeedsContinuation(text) {
  if (!text || text.trim().length === 0) return { needsContinuation: false, reason: "empty" };
  const trimmed = text.trim();

  // 1. Unclosed code block: count of ``` is odd
  const fenceMatches = text.match(/```/g);
  if (fenceMatches && (fenceMatches.length % 2 !== 0)) {
    return { needsContinuation: true, reason: "unclosed_code_fence" };
  }

  // 2. Trailing syntax / tokens indicating mid-sentence or mid-expression cutoff
  const abruptEnding = /[,(=+\-*\/&|<>:;{\[\]\\]\s*$/.test(trimmed) ||
                       /\b(and|or|then|because|with|if|function|const|let|var|def|class|return)\s*$/i.test(trimmed);
  if (abruptEnding) {
    return { needsContinuation: true, reason: "abrupt_ending" };
  }

  // 3. Substantive answers (> 300 chars) that ended without terminal punctuation
  const lastChar = trimmed.slice(-1);
  const endsWithPunctuation = ['.', '!', '?', '"', "'", '`', '}', ')', '>', '#'].includes(lastChar) || trimmed.endsWith('```');
  if (trimmed.length > 300 && !endsWithPunctuation) {
    return { needsContinuation: true, reason: "missing_terminal_punctuation" };
  }

  // 4. Substantive answers (> 600 chars) to verify with DeepSeek if everything has been completed
  if (trimmed.length > 600) {
    return { needsContinuation: true, reason: "verify_completeness" };
  }

  return { needsContinuation: false, reason: "complete" };
}

function isContinuationCompleteSignal(text) {
  if (!text) return false;
  const t = text.trim().toLowerCase();
  if (t === "[complete]" || t.startsWith("[complete]")) return true;
  if (/^yes[,\.\s]+(the\s+answer\s+is\s+complete|everything\s+has\s+been\s+given|all\s+code\s+is\s+complete|it\s+is\s+complete)/i.test(t)) return true;
  if (/^(the\s+answer\s+is\s+complete|everything\s+is\s+complete|all\s+requested\s+information\s+has\s+been\s+provided)\.?$/i.test(t)) return true;
  return false;
}

// -----------------------------------------------------------------------------
// HTTP Request Router & Handler
// -----------------------------------------------------------------------------
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

async function handleChatCompletion(body, token, res) {
  const messages = body.messages || [];
  const tools = body.tools || [];
  const isStream = body.stream === true;
  const model = body.model || "deepseek-reasoner";
  const isFastMode = model.toLowerCase().includes("chat") || model.toLowerCase().includes("flash");
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
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      ...CORS_HEADERS,
    });

    writeSSE(res, {
      id: completionId,
      object: "chat.completion.chunk",
      created: createdTimestamp,
      model: model,
      choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
    });

    let dsResponse = null;
    let activeSessionId = null;
    try {
      const dispatchResult = await dispatchDeepSeekCompletion(prompt, messages, tools, baseHeaders, token, thinkingEnabled, imageUrls);
      dsResponse = dispatchResult.response;
      activeSessionId = dispatchResult.sessionId;
    } catch (dispatchErr) {
      console.error("  [Error] DeepSeek dispatch error:", dispatchErr.message);
      const failMsg = "DeepSeek's servers are currently experiencing high traffic. Please click 'continue' or send your message again in a moment.";
      emitStreamDelta(res, completionId, model, createdTimestamp, "RESPONSE", failMsg);
      writeSSE(res, {
        id: completionId,
        object: "chat.completion.chunk",
        created: createdTimestamp,
        model: model,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      });
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

    let lastResponseMsgId = null;
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
      if (inToolCallBlock) return;

      pendingResponseBuffer += text;

      const tagMatch = pendingResponseBuffer.search(/<\s*(\/?)\s*(?:[|｜]|DSML)/i);
      if (tagMatch !== -1) {
        inToolCallBlock = true;
        const beforeTag = pendingResponseBuffer.substring(0, tagMatch);
        if (beforeTag) {
          emitStreamDelta(res, completionId, model, createdTimestamp, "RESPONSE", beforeTag);
          hasEmittedContent = true;
        }
        pendingResponseBuffer = "";
        return;
      }

      const partialTagMatch = pendingResponseBuffer.match(/<\s*(\/?)\s*(?:[|｜]|D|DS|DSM)?$/i);
      if (partialTagMatch) {
        const cutIdx = partialTagMatch.index;
        if (cutIdx > 0) {
          const safePrefix = pendingResponseBuffer.substring(0, cutIdx);
          emitStreamDelta(res, completionId, model, createdTimestamp, "RESPONSE", safePrefix);
          hasEmittedContent = true;
          pendingResponseBuffer = pendingResponseBuffer.substring(cutIdx);
        }
        return;
      }

      emitStreamDelta(res, completionId, model, createdTimestamp, "RESPONSE", pendingResponseBuffer);
      hasEmittedContent = true;
      pendingResponseBuffer = "";
    }

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop();

        for (const line of lines) {
          if (line.startsWith("event: close") || line.includes("[DONE]")) break;
          if (line.startsWith("data:")) {
            const dataStr = line.substring(5).trim();
            if (!dataStr) continue;

            try {
              const data = JSON.parse(dataStr);
              if (data.response_message_id) {
                lastResponseMsgId = data.response_message_id;
              }
              if (data.v && data.v.response && (data.v.response.message_id || data.v.response.id)) {
                lastResponseMsgId = data.v.response.message_id || data.v.response.id || lastResponseMsgId;
              }

              if (data.v && data.v.response && data.v.response.fragments && data.v.response.fragments.length > 0) {
                currentFragmentType = data.v.response.fragments[0].type || "THINK";
                const initialContent = data.v.response.fragments[0].content || "";
                if (initialContent) {
                  if (currentFragmentType === "THINK") {
                    accumulatedThinkText += initialContent;
                    emitStreamDelta(res, completionId, model, createdTimestamp, "THINK", initialContent);
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
                    emitStreamDelta(res, completionId, model, createdTimestamp, "THINK", c);
                  } else {
                    await handleResponseChunk(c);
                  }
                }
              }

              if (data.v && typeof data.v === "string" && (!data.p || !data.p.includes("status"))) {
                if (currentFragmentType === "THINK") {
                  accumulatedThinkText += data.v;
                  emitStreamDelta(res, completionId, model, createdTimestamp, "THINK", data.v);
                } else {
                  await handleResponseChunk(data.v);
                }
              }
            } catch {}
          }
        }
      }

      if (!inToolCallBlock && pendingResponseBuffer) {
        emitStreamDelta(res, completionId, model, createdTimestamp, "RESPONSE", pendingResponseBuffer);
        hasEmittedContent = true;
        pendingResponseBuffer = "";
      }

      const dsml = parseDSML(accumulatedResponseText);
      if (dsml && dsml.toolCalls.length > 0) {
        if (!hasEmittedContent && dsml.contentBefore) {
          emitStreamDelta(res, completionId, model, createdTimestamp, "RESPONSE", dsml.contentBefore);
          hasEmittedContent = true;
        }
        writeSSE(res, {
          id: completionId,
          object: "chat.completion.chunk",
          created: createdTimestamp,
          model: model,
          choices: [{ index: 0, delta: { tool_calls: dsml.toolCalls }, finish_reason: null }],
        });
        writeSSE(res, {
          id: completionId,
          object: "chat.completion.chunk",
          created: createdTimestamp,
          model: model,
          choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
        });
        res.write("data: [DONE]\n\n");
        return;
      } else {
        if (inToolCallBlock) {
          const cleanText = accumulatedResponseText.replace(/<\s*(\/?)\s*\|*[\s|]*DSML[\s|]*\|*[^>]*>/gi, "").trim();
          if (!hasEmittedContent && cleanText) {
            emitStreamDelta(res, completionId, model, createdTimestamp, "RESPONSE", cleanText);
            hasEmittedContent = true;
          }
        }

        // Auto-Continue Verification Engine: Check if DeepSeek finished or if more is needed
        let continuationCount = 0;
        let alreadyVerifiedCompleteness = false;
        const MAX_CONTINUATIONS = 3;

        while (continuationCount < MAX_CONTINUATIONS) {
          const checkResult = checkNeedsContinuation(accumulatedResponseText);
          if (!checkResult.needsContinuation) break;
          if (checkResult.reason === "verify_completeness" && alreadyVerifiedCompleteness) break;

          continuationCount++;
          if (checkResult.reason === "verify_completeness") {
            alreadyVerifiedCompleteness = true;
          }

          console.log(`  [Auto-Continue] Turn ${continuationCount}: Verifying completion with DeepSeek (${checkResult.reason})...`);

          let continuationPrompt;
          if (checkResult.reason === "unclosed_code_fence") {
            continuationPrompt = `Your previous output stopped abruptly inside an unclosed code block. Continue writing the code immediately from the exact character where you left off. Do not repeat previous lines and do not provide any greeting or explanation. Output only the continuation until the code block is closed.`;
          } else if (checkResult.reason === "abrupt_ending" || checkResult.reason === "missing_terminal_punctuation") {
            continuationPrompt = `Your previous response stopped before finishing. Continue directly from where you left off. Do not repeat previous text and do not add conversational preamble. Complete the remaining answer.`;
          } else {
            continuationPrompt = `Has everything been given for the user's request? Is the answer complete and should we stop?
- If YES (the answer is completely finished with nothing missing or cut off): Reply with ONLY "[COMPLETE]" and nothing else.
- If NO (the answer is incomplete, was truncated, or parts remain): Do not say "[COMPLETE]". Continue writing the remaining answer/code immediately where you left off until it is 100% complete.`;
          }

          try {
            const contResult = await dispatchDeepSeekCompletion(
              continuationPrompt,
              messages,
              tools,
              baseHeaders,
              token,
              false,
              [],
              { sessionId: activeSessionId, parentMessageId: lastResponseMsgId }
            );

            const contReader = contResult.response.body.getReader();
            let contBuffer = "";
            let contAccumulated = "";
            let contInitialBuffer = "";
            let contIsComplete = false;
            let contStreamStarted = false;
            let contCurrentFragment = "RESPONSE";

            while (true) {
              const { value, done } = await contReader.read();
              if (done) break;

              contBuffer += decoder.decode(value, { stream: true });
              const contLines = contBuffer.split("\n");
              contBuffer = contLines.pop();

              for (const line of contLines) {
                if (line.startsWith("event: close") || line.includes("[DONE]")) break;
                if (line.startsWith("data:")) {
                  const dataStr = line.substring(5).trim();
                  if (!dataStr) continue;

                  try {
                    const data = JSON.parse(dataStr);
                    if (data.response_message_id) {
                      lastResponseMsgId = data.response_message_id;
                    }
                    if (data.v && data.v.response && (data.v.response.message_id || data.v.response.id)) {
                      lastResponseMsgId = data.v.response.message_id || data.v.response.id || lastResponseMsgId;
                    }

                    let chunkText = "";
                    if (data.v && data.v.response && data.v.response.fragments && data.v.response.fragments.length > 0) {
                      contCurrentFragment = data.v.response.fragments[0].type || "RESPONSE";
                      chunkText = data.v.response.fragments[0].content || "";
                    } else if (data.p === "response/fragments" && data.o === "APPEND" && Array.isArray(data.v) && data.v.length > 0) {
                      contCurrentFragment = data.v[0].type || "RESPONSE";
                      chunkText = data.v[0].content || "";
                    } else if (data.v && typeof data.v === "string" && (!data.p || !data.p.includes("status"))) {
                      chunkText = data.v;
                    }

                    if (!chunkText || contCurrentFragment === "THINK") continue;

                    contAccumulated += chunkText;

                    if (!contStreamStarted) {
                      contInitialBuffer += chunkText;
                      if (contInitialBuffer.length > 15 || contInitialBuffer.includes("\n") || contInitialBuffer.includes("]")) {
                        if (isContinuationCompleteSignal(contInitialBuffer)) {
                          contIsComplete = true;
                          break;
                        } else {
                          contStreamStarted = true;
                          let toEmit = contInitialBuffer;
                          if (checkResult.reason === "unclosed_code_fence") {
                            toEmit = toEmit.replace(/^```[a-zA-Z0-9_-]*\r?\n/, "");
                          }
                          toEmit = toEmit.replace(/^(Sure,\s*(here\s*is\s*the\s*rest|continuing)\b[^\n]*\r?\n+|Here\s*is\s*the\s*(remaining|rest)[^\n]*\r?\n+)/i, "");
                          if (toEmit) {
                            emitStreamDelta(res, completionId, model, createdTimestamp, "RESPONSE", toEmit);
                            hasEmittedContent = true;
                          }
                        }
                      }
                    } else {
                      emitStreamDelta(res, completionId, model, createdTimestamp, "RESPONSE", chunkText);
                      hasEmittedContent = true;
                    }
                  } catch (e) {}
                }
              }
              if (contIsComplete) break;
            }

            if (contIsComplete || isContinuationCompleteSignal(contAccumulated)) {
              console.log(`  [Auto-Continue] DeepSeek verified answer is 100% complete.`);
              break;
            }

            if (!contStreamStarted && contInitialBuffer && !isContinuationCompleteSignal(contInitialBuffer)) {
              let toEmit = contInitialBuffer;
              if (checkResult.reason === "unclosed_code_fence") {
                toEmit = toEmit.replace(/^```[a-zA-Z0-9_-]*\r?\n/, "");
              }
              toEmit = toEmit.replace(/^(Sure,\s*(here\s*is\s*the\s*rest|continuing)\b[^\n]*\r?\n+|Here\s*is\s*the\s*(remaining|rest)[^\n]*\r?\n+)/i, "");
              if (toEmit) {
                emitStreamDelta(res, completionId, model, createdTimestamp, "RESPONSE", toEmit);
                hasEmittedContent = true;
              }
            }

            accumulatedResponseText += "\n" + contAccumulated;
          } catch (contErr) {
            console.warn(`  [Auto-Continue] Continuation attempt error:`, contErr.message);
            break;
          }
        }

        if (!hasEmittedContent) {
          const fallback = accumulatedResponseText.trim() || accumulatedThinkText.trim() || " ";
          emitStreamDelta(res, completionId, model, createdTimestamp, "RESPONSE", fallback);
          hasEmittedContent = true;
        }

        writeSSE(res, {
          id: completionId,
          object: "chat.completion.chunk",
          created: createdTimestamp,
          model: model,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        });
      }

      res.write("data: [DONE]\n\n");
    } catch (streamErr) {
      console.error("  [Stream Error]", streamErr);
      if (!hasEmittedContent) {
        const fallback = accumulatedResponseText.trim() || accumulatedThinkText.trim() || "DeepSeek's servers are currently experiencing high traffic. Please click 'continue' or send your message again in a moment.";
        emitStreamDelta(res, completionId, model, createdTimestamp, "RESPONSE", fallback);
      }
      writeSSE(res, {
        id: completionId,
        object: "chat.completion.chunk",
        created: createdTimestamp,
        model: model,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      });
      res.write("data: [DONE]\n\n");
    } finally {
      res.end();
    }
  } else {
    // Non-streaming Response
    try {
      const dispatchResult = await dispatchDeepSeekCompletion(prompt, messages, tools, baseHeaders, token, thinkingEnabled, imageUrls);
      const dsResponse = dispatchResult.response;
      const activeSessionId = dispatchResult.sessionId;
      let lastResponseMsgId = null;
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
              if (data.response_message_id) {
                lastResponseMsgId = data.response_message_id;
              }
              if (data.v && data.v.response && (data.v.response.message_id || data.v.response.id)) {
                lastResponseMsgId = data.v.response.message_id || data.v.response.id || lastResponseMsgId;
              }

              if (data.v && data.v.response && data.v.response.fragments && data.v.response.fragments.length > 0) {
                currentFragmentType = data.v.response.fragments[0].type || "THINK";
                const c = data.v.response.fragments[0].content || "";
                if (currentFragmentType === "THINK") thinkAccumulated += c;
                else responseAccumulated += c;
              }
              if (data.p === "response/fragments" && data.o === "APPEND" && Array.isArray(data.v) && data.v.length > 0) {
                currentFragmentType = data.v[0].type || "RESPONSE";
                const c = data.v[0].content || "";
                if (currentFragmentType === "THINK") thinkAccumulated += c;
                else responseAccumulated += c;
              }
              if (data.v && typeof data.v === "string" && (!data.p || !data.p.includes("status"))) {
                if (currentFragmentType === "THINK") thinkAccumulated += data.v;
                else responseAccumulated += data.v;
              }
            } catch {}
          }
        }
      }

      const dsml = parseDSML(responseAccumulated);
      let messageContent = responseAccumulated;
      let toolCalls = undefined;
      let finishReason = "stop";

      if (dsml && dsml.toolCalls.length > 0) {
        messageContent = dsml.contentBefore || null;
        toolCalls = dsml.toolCalls;
        finishReason = "tool_calls";
      } else {
        // Auto-Continue verification for non-streaming
        let nonStreamContCount = 0;
        let nonStreamVerified = false;
        while (nonStreamContCount < 2) {
          const checkResult = checkNeedsContinuation(responseAccumulated);
          if (!checkResult.needsContinuation) break;
          if (checkResult.reason === "verify_completeness" && nonStreamVerified) break;

          nonStreamContCount++;
          if (checkResult.reason === "verify_completeness") nonStreamVerified = true;

          let continuationPrompt;
          if (checkResult.reason === "unclosed_code_fence") {
            continuationPrompt = `Your previous output stopped abruptly inside an unclosed code block. Continue writing the code immediately from the exact character where you left off. Do not repeat previous lines and do not provide any greeting or explanation. Output only the continuation until the code block is closed.`;
          } else if (checkResult.reason === "abrupt_ending" || checkResult.reason === "missing_terminal_punctuation") {
            continuationPrompt = `Your previous response stopped before finishing. Continue directly from where you left off. Do not repeat previous text and do not add conversational preamble. Complete the remaining answer.`;
          } else {
            continuationPrompt = `Has everything been given for the user's request? Is the answer complete and should we stop?
- If YES (the answer is completely finished with nothing missing or cut off): Reply with ONLY "[COMPLETE]" and nothing else.
- If NO (the answer is incomplete, was truncated, or parts remain): Do not say "[COMPLETE]". Continue writing the remaining answer/code immediately where you left off until it is 100% complete.`;
          }

          try {
            const contResult = await dispatchDeepSeekCompletion(
              continuationPrompt,
              messages,
              tools,
              baseHeaders,
              token,
              false,
              [],
              { sessionId: activeSessionId, parentMessageId: lastResponseMsgId }
            );

            const contReader = contResult.response.body.getReader();
            let contBuf = "";
            let contText = "";

            while (true) {
              const { value, done } = await contReader.read();
              if (done) break;
              contBuf += decoder.decode(value, { stream: true });
              const cLines = contBuf.split("\n");
              contBuf = cLines.pop();
              for (const l of cLines) {
                if (l.startsWith("data:")) {
                  const s = l.substring(5).trim();
                  if (!s) continue;
                  try {
                    const d = JSON.parse(s);
                    if (d.v && typeof d.v === "string" && (!d.p || !d.p.includes("status"))) {
                      contText += d.v;
                    } else if (d.p === "response/fragments" && Array.isArray(d.v) && d.v[0]?.content) {
                      contText += d.v[0].content;
                    }
                  } catch(e) {}
                }
              }
            }

            if (isContinuationCompleteSignal(contText)) break;

            let toAppend = contText;
            if (checkResult.reason === "unclosed_code_fence") {
              toAppend = toAppend.replace(/^```[a-zA-Z0-9_-]*\r?\n/, "");
            }
            toAppend = toAppend.replace(/^(Sure,\s*(here\s*is\s*the\s*rest|continuing)\b[^\n]*\r?\n+|Here\s*is\s*the\s*(remaining|rest)[^\n]*\r?\n+)/i, "");
            if (toAppend) {
              responseAccumulated += "\n" + toAppend;
            }
          } catch(e) {
            break;
          }
        }
        messageContent = responseAccumulated;
      }

      res.writeHead(200, { "Content-Type": "application/json", ...CORS_HEADERS });
      res.end(JSON.stringify({
        id: completionId,
        object: "chat.completion",
        created: createdTimestamp,
        model: model,
        choices: [{
          index: 0,
          message: {
            role: "assistant",
            content: messageContent,
            reasoning_content: thinkAccumulated || undefined,
            tool_calls: toolCalls,
          },
          finish_reason: finishReason,
        }],
      }));
    } catch (err) {
      res.writeHead(200, { "Content-Type": "application/json", ...CORS_HEADERS });
      res.end(JSON.stringify({
        id: completionId,
        object: "chat.completion",
        created: createdTimestamp,
        model: model,
        choices: [{
          index: 0,
          message: {
            role: "assistant",
            content: "DeepSeek's servers are currently experiencing high traffic. Please click 'continue' or send your message again in a moment.",
          },
          finish_reason: "stop",
        }],
      }));
    }
  }
}

// -----------------------------------------------------------------------------
// Server Initialization
// -----------------------------------------------------------------------------
function startServer(port = 8787) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1:" + port}`);

    if (req.method === "OPTIONS") {
      res.writeHead(204, CORS_HEADERS);
      res.end();
      return;
    }

    if (url.pathname === "/health" || url.pathname === "/api/status") {
      res.writeHead(200, { "Content-Type": "application/json", ...CORS_HEADERS });
      res.end(JSON.stringify({ status: "ok", mode: "local-node", timestamp: new Date().toISOString() }));
      return;
    }

    if (url.pathname === "/v1/models" || url.pathname === "/models") {
      res.writeHead(200, { "Content-Type": "application/json", ...CORS_HEADERS });
      res.end(JSON.stringify({
        object: "list",
        data: [
          { id: "deepseek-reasoner", object: "model", created: 1700000000, owned_by: "deepseek" },
          { id: "deepseek-chat", object: "model", created: 1700000000, owned_by: "deepseek" },
        ],
      }));
      return;
    }

    if (url.pathname === "/v1/chat/completions" || url.pathname === "/chat/completions") {
      const authHeader = req.headers["authorization"] || "";
      let callerToken = authHeader.trim();
      while (callerToken.toLowerCase().startsWith("bearer ")) {
        callerToken = callerToken.substring(7).trim();
      }

      if (!callerToken && process.env.DEEPSEEK_AUTH_TOKEN) {
        callerToken = process.env.DEEPSEEK_AUTH_TOKEN.trim();
      }

      if (!callerToken || callerToken.length < 10) {
        res.writeHead(401, { "Content-Type": "application/json", ...CORS_HEADERS });
        res.end(JSON.stringify({
          error: {
            message: "Missing DeepSeek token. Please set your API Key in Cursor or provide DEEPSEEK_AUTH_TOKEN.",
            type: "auth_required",
          },
        }));
        return;
      }

      let bodyStr = "";
      req.on("data", (chunk) => { bodyStr += chunk; });
      req.on("end", async () => {
        try {
          const body = JSON.parse(bodyStr);
          const modelName = body.model || "deepseek-reasoner";
          console.log(`[${new Date().toLocaleTimeString()}] Chat request -> model: ${modelName}, stream: ${body.stream === true}`);
          await handleChatCompletion(body, `Bearer ${callerToken}`, res);
        } catch (err) {
          console.error("Request parse error:", err);
          res.writeHead(200, { "Content-Type": "application/json", ...CORS_HEADERS });
          res.end(JSON.stringify({
            id: "chatcmpl-" + crypto.randomUUID().replace(/-/g, "").substring(0, 16),
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: "deepseek-reasoner",
            choices: [{
              index: 0,
              message: {
                role: "assistant",
                content: "DeepSeek's servers are currently experiencing high traffic. Please click 'continue' or send your message again in a moment.",
              },
              finish_reason: "stop",
            }],
          }));
        }
      });
      return;
    }

    // Default HTML Status page
    const bookmarkletCode = `javascript:(function(){try{let t='';const raw=localStorage.getItem('userToken');if(raw){try{const p=JSON.parse(raw);t=(p&&typeof p==='object')?(p.value||p.token||''):p;}catch(e){t=raw;}}if(typeof t==='string'){t=t.trim();while(t.toLowerCase().startsWith('bearer '))t=t.substring(7).trim();}if(!t||t==='null'||t==='undefined'||t==='{}'||t.length<10){return alert('Key NOT copied: You are not logged in. Please sign in to chat.deepseek.com first and try again.');}try{navigator.clipboard.writeText(t);}catch(e){}try{const ta=document.createElement('textarea');ta.value=t;document.body.appendChild(ta);ta.select();document.execCommand('copy');document.body.removeChild(ta);}catch(e){}alert('Copied DeepSeek API Key to clipboard!');}catch(e){alert('Key NOT copied: '+e);}})();`;
    const autoContinueBookmarkletCode = `javascript:(function(){if(window.__deepseek_auto_continue_active){alert('DeepSeek Auto-Continue is already active on this tab!');return;}window.__deepseek_auto_continue_active=true;let lastClick=0;function clickContinue(){if(Date.now()-lastClick<2000)return false;const els=document.querySelectorAll('.ds-button__content, button, [role=button], .ds-button');for(const el of els){if((el.textContent||'').trim().toLowerCase()==='continue'){const btn=el.closest('[role=button]')||el.closest('button')||el;if(btn&&!btn.disabled&&btn.offsetParent!==null){console.log('[Auto-Continue] Clicked Continue button');lastClick=Date.now();btn.click();try{btn.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,view:window}));}catch(e){}return true;}}}return false;}setInterval(clickContinue,400);new MutationObserver(clickContinue).observe(document.body,{childList:true,subtree:true});const b=document.createElement('div');b.textContent='Auto-Continue Active';b.style.cssText='position:fixed;bottom:16px;left:16px;background:#111;color:#fff;font-family:sans-serif;font-size:11px;font-weight:600;padding:6px 12px;border-radius:14px;z-index:999999;box-shadow:0 2px 8px rgba(0,0,0,0.2);pointer-events:none;';document.body.appendChild(b);alert('Auto-Continue is now active! Continue buttons will be clicked automatically.');})();`;

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", ...CORS_HEADERS });
    res.end(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>freeseek - Local Proxy</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace; background: #fff; color: #000; padding: 40px; line-height: 1.6; }
    .box { border: 2px solid #000; padding: 24px; max-width: 600px; margin: 0 auto; border-radius: 8px; }
    h1 { font-size: 20px; margin-top: 0; text-transform: uppercase; }
    code { background: #f0f0f0; padding: 2px 6px; font-family: monospace; border-radius: 3px; }
    .btn { display: inline-block; padding: 8px 14px; background: #000; color: #fff; text-decoration: none; border-radius: 4px; font-weight: 600; font-size: 12px; margin-right: 8px; }
    .btn:hover { background: #262626; }
  </style>
</head>
<body>
  <div class="box">
    <h1>freeseek Local Proxy</h1>
    <p>Status: <strong>Running locally on http://127.0.0.1:${port}</strong></p>
    <hr style="border: 1px solid #000; margin: 20px 0;">
    <h3>Cursor / IDE Settings:</h3>
    <p><strong>Base URL:</strong> <code>http://127.0.0.1:${port}/v1</code></p>
    <p><strong>API Key:</strong> <code>your DeepSeek token</code></p>
    <p><strong>Models:</strong> <code>deepseek-reasoner</code>, <code>deepseek-chat</code></p>
    <hr style="border: 1px solid #000; margin: 20px 0;">
    <h3>Browser Helper Tools:</h3>
    <p style="font-size: 13px; color: #555; margin-bottom: 10px;">Drag these to your bookmarks bar for 1-click use on chat.deepseek.com:</p>
    <div style="margin: 12px 0;">
      <a class="btn" href="${bookmarkletCode}">Key Grabber</a>
      <a class="btn" href="${autoContinueBookmarkletCode}">Auto-Continue</a>
    </div>
    <hr style="border: 1px solid #000; margin: 20px 0;">
    <p style="font-size: 12px; color: #666;">Running natively on your CPU with unlimited WebAssembly PoW capability and zero Cloudflare limits.</p>
  </div>
</body>
</html>`);
  });

  server.listen(port, "127.0.0.1", () => {
    console.log("");
    console.log("============================================================");
    console.log("  freeseek local proxy active on http://127.0.0.1:" + port);
    console.log("============================================================");
    console.log("  Cursor / IDE Configuration:");
    console.log("    Base URL: http://127.0.0.1:" + port + "/v1");
    console.log("    API Key:  your DeepSeek user token");
    console.log("    Models:   deepseek-reasoner, deepseek-chat");
    console.log("============================================================");
    console.log("  Press Ctrl+C to stop.");
    console.log("");
  });
}

// CLI Argument Parsing
const args = process.argv.slice(2);
let port = process.env.PORT ? parseInt(process.env.PORT) : 8787;
const portIdx = args.indexOf("--port");
if (portIdx !== -1 && args[portIdx + 1]) {
  port = parseInt(args[portIdx + 1]);
}

startServer(port);
