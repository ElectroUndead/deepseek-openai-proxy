// ==UserScript==
// @name         DeepSeek Auto-Continue
// @namespace    https://github.com/divyansh-shandilya/deepseek-openai-proxy
// @version      1.0.0
// @description  Automatically clicks the Continue button on chat.deepseek.com when long responses are truncated
// @author       Divyansh Shandilya
// @match        https://chat.deepseek.com/*
// @icon         https://chat.deepseek.com/favicon.svg
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function() {
  'use strict';

  let lastClickTime = 0;

  function clickContinueIfPresent() {
    if (Date.now() - lastClickTime < 2000) return false;

    const elements = document.querySelectorAll('.ds-button__content, button, [role=button], .ds-button');
    for (const el of elements) {
      const text = (el.textContent || '').trim().toLowerCase();
      if (text === 'continue') {
        const btn = el.closest('[role=button]') || el.closest('button') || el;
        if (btn && !btn.disabled && btn.offsetParent !== null) {
          console.log('[DeepSeek Auto-Continue] Detected Continue button, clicking automatically...');
          lastClickTime = Date.now();
          btn.click();
          try {
            btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
          } catch (e) {}
          return true;
        }
      }
    }
    return false;
  }

  // Periodic polling fallback
  setInterval(clickContinueIfPresent, 400);

  // MutationObserver for instant 0ms response
  const observer = new MutationObserver(() => {
    clickContinueIfPresent();
  });
  observer.observe(document.body, { childList: true, subtree: true });

  // Minimalist status badge
  const badge = document.createElement('div');
  badge.id = 'deepseek-auto-continue-badge';
  badge.textContent = 'Auto-Continue Active';
  badge.style.cssText = [
    'position: fixed',
    'bottom: 16px',
    'left: 16px',
    'background: #111111',
    'color: #ffffff',
    'font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    'font-size: 11px',
    'font-weight: 500',
    'padding: 5px 12px',
    'border-radius: 16px',
    'z-index: 999999',
    'box-shadow: 0 2px 8px rgba(0,0,0,0.15)',
    'pointer-events: none',
    'opacity: 0.85',
  ].join(';');
  document.body.appendChild(badge);

  console.log('[DeepSeek Auto-Continue] Active on chat.deepseek.com');
})();
