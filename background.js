const browserAPI = typeof chrome !== 'undefined' ? chrome : browser;

const SUPPORTED_URLS = ['chatgpt.com', 'claude.ai', 'poe.com'];
const NATIVE_HOST_NAME = 'com.aichatdl.native_host';
const WINDOW_SIZE = 4; // Process 4 chats per window, then reload tab to free memory

// Listen for tab updates
browserAPI.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete') {
    if (tab.url && SUPPORTED_URLS.some(url => tab.url.includes(url))) {
      browserAPI.action.enable(tabId);
    } else {
      browserAPI.action.disable(tabId);
    }
  }
});

function sanitizeFilename(title) {
  return title
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')  // strip illegal chars
    .replace(/\s+/g, '-')                      // spaces to hyphens
    .replace(/-+/g, '-')                       // collapse multiple hyphens
    .replace(/^-|-$/g, '')                     // trim leading/trailing hyphens
    .substring(0, 60) || 'Untitled';
}

function waitForTabLoad(tabId) {
  return new Promise(resolve => {
    function listener(id, changeInfo) {
      if (id === tabId && changeInfo.status === 'complete') {
        browserAPI.tabs.onUpdated.removeListener(listener);
        // Extra delay to let SPA content render
        setTimeout(resolve, 2000);
      }
    }
    browserAPI.tabs.onUpdated.addListener(listener);
  });
}

function sendToNativeHost(message) {
  return new Promise((resolve, reject) => {
    browserAPI.runtime.sendNativeMessage(NATIVE_HOST_NAME, message, response => {
      if (browserAPI.runtime.lastError) {
        reject(new Error(browserAPI.runtime.lastError.message));
      } else {
        resolve(response);
      }
    });
  });
}

// Fetch extracted content from content script in 1MB chunks
async function fetchContentChunked(tabId, totalChunks) {
  const parts = [];
  for (let i = 0; i < totalChunks; i++) {
    const result = await new Promise((resolve, reject) => {
      browserAPI.tabs.sendMessage(tabId, { action: 'getChunk', index: i }, resp => {
        if (browserAPI.runtime.lastError) {
          reject(new Error(browserAPI.runtime.lastError.message));
        } else {
          resolve(resp);
        }
      });
    });
    if (result.error) throw new Error(result.error);
    parts.push(result.chunk);
  }
  return parts.join('');
}

function reportProgress(current, total, title, status, error) {
  browserAPI.runtime.sendMessage({
    action: 'batchProgress',
    current, total, title, status,
    ...(error ? { error } : {})
  }).catch(() => {}); // popup may be closed
}

async function extractSingleChat(tabId, chat, format, index, total) {
  const dirName = sanitizeFilename(chat.title);
  const fileExt = { markdown: 'md', html: 'html', plaintext: 'txt' }[format] || 'md';
  const fileName = `${dirName}.${fileExt}`;

  // Check if already saved — skip if so
  try {
    const existsResult = await sendToNativeHost({
      action: 'checkExists',
      dirName,
      fileName
    });
    if (existsResult && existsResult.exists) {
      reportProgress(index + 1, total, chat.title, 'skipped');
      return { title: chat.title, success: true, skipped: true, path: existsResult.path };
    }
  } catch (e) {
    // If checkExists fails, proceed with extraction
  }

  reportProgress(index + 1, total, chat.title, 'navigating');

  try {
    // Navigate to conversation
    await browserAPI.tabs.update(tabId, { url: chat.url });
    await waitForTabLoad(tabId);

    // Extract — content script stores content locally, returns metadata
    const response = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Extraction timed out')), 60000);
      browserAPI.tabs.sendMessage(tabId, {
        action: 'extract',
        format,
        returnContent: true
      }, resp => {
        clearTimeout(timeout);
        if (browserAPI.runtime.lastError) {
          reject(new Error(browserAPI.runtime.lastError.message));
        } else {
          resolve(resp);
        }
      });
    });

    if (response && response.totalChunks) {
      reportProgress(index + 1, total, chat.title, 'saving');

      // Fetch content in chunks to avoid 64MiB message limit
      const content = await fetchContentChunked(tabId, response.totalChunks);

      // Write to disk via native host
      const writeResult = await sendToNativeHost({
        action: 'write',
        dirName,
        fileName,
        content
      });

      reportProgress(index + 1, total, chat.title, 'done');
      return {
        title: chat.title,
        success: writeResult.success,
        path: writeResult.path,
        messageCount: response.messageCount
      };
    } else {
      const errorMsg = response?.error || 'No content extracted';
      reportProgress(index + 1, total, chat.title, 'error', errorMsg);
      return { title: chat.title, success: false, error: errorMsg };
    }
  } catch (err) {
    reportProgress(index + 1, total, chat.title, 'error', err.message);
    return { title: chat.title, success: false, error: err.message };
  }
}

async function batchExtract(tabId, chats, format) {
  const results = [];

  for (let windowStart = 0; windowStart < chats.length; windowStart += WINDOW_SIZE) {
    const windowEnd = Math.min(windowStart + WINDOW_SIZE, chats.length);

    // Process this window of chats
    for (let i = windowStart; i < windowEnd; i++) {
      const result = await extractSingleChat(tabId, chats[i], format, i, chats.length);
      results.push(result);
    }

    // After each window, reload the tab to a blank chatgpt page to free memory
    // (skip if this was the last window)
    if (windowEnd < chats.length) {
      try {
        await browserAPI.tabs.update(tabId, { url: 'https://chatgpt.com/' });
        await waitForTabLoad(tabId);
      } catch (e) {
        // If reload fails, continue anyway
      }
    }
  }

  return results;
}

// Listen for messages from popup.js
browserAPI.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "extract") {
    browserAPI.tabs.query({active: true, currentWindow: true}, function(tabs) {
      browserAPI.tabs.sendMessage(tabs[0].id, {action: "extract", format: request.format}, function(response) {
        sendResponse(response);
      });
    });
    return true;
  } else if (request.action === "detectPlatform") {
    browserAPI.tabs.query({active: true, currentWindow: true}, function(tabs) {
      browserAPI.tabs.sendMessage(tabs[0].id, {action: "detectPlatform"}, function(response) {
        sendResponse(response);
      });
    });
    return true;
  } else if (request.action === "getChatList") {
    browserAPI.tabs.query({active: true, currentWindow: true}, function(tabs) {
      browserAPI.tabs.sendMessage(tabs[0].id, {action: "getChatList"}, function(response) {
        sendResponse(response);
      });
    });
    return true;
  } else if (request.action === "batchExtract") {
    browserAPI.tabs.query({active: true, currentWindow: true}, function(tabs) {
      batchExtract(tabs[0].id, request.chats, request.format).then(results => {
        sendResponse({ results });
      });
    });
    return true;
  }
});
