const browserAPI = typeof chrome !== 'undefined' ? chrome : browser;

const SUPPORTED_URLS = ['chatgpt.com', 'claude.ai', 'poe.com'];
const WINDOW_SIZE = 4;

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
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 60) || 'Untitled';
}

function waitForTabLoad(tabId) {
  return new Promise(resolve => {
    function listener(id, changeInfo) {
      if (id === tabId && changeInfo.status === 'complete') {
        browserAPI.tabs.onUpdated.removeListener(listener);
        setTimeout(resolve, 2000);
      }
    }
    browserAPI.tabs.onUpdated.addListener(listener);
  });
}

function reportProgress(current, total, title, status, error) {
  browserAPI.runtime.sendMessage({
    action: 'batchProgress',
    current, total, title, status,
    ...(error ? { error } : {})
  }).catch(() => {});
}

async function extractSingleChat(tabId, chat, format, index, total) {
  const dirName = sanitizeFilename(chat.title);
  const fileExt = { markdown: 'md', html: 'html', plaintext: 'txt' }[format] || 'md';
  const fileName = `${dirName}.${fileExt}`;

  reportProgress(index + 1, total, chat.title, 'navigating');

  try {
    await browserAPI.tabs.update(tabId, { url: chat.url });
    await waitForTabLoad(tabId);

    const response = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Extraction timed out')), 60000);
      browserAPI.tabs.sendMessage(tabId, {
        action: 'extract',
        format,
        batchDownload: true,
        fileName
      }, resp => {
        clearTimeout(timeout);
        if (browserAPI.runtime.lastError) {
          reject(new Error(browserAPI.runtime.lastError.message));
        } else {
          resolve(resp);
        }
      });
    });

    if (response && response.downloadInitiated) {
      reportProgress(index + 1, total, chat.title, 'done');
      return { title: chat.title, success: true, messageCount: response.messageCount };
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

    for (let i = windowStart; i < windowEnd; i++) {
      const result = await extractSingleChat(tabId, chats[i], format, i, chats.length);
      results.push(result);
    }

    // Reload tab between windows to free memory
    if (windowEnd < chats.length) {
      try {
        await browserAPI.tabs.update(tabId, { url: 'https://chatgpt.com/' });
        await waitForTabLoad(tabId);
      } catch (e) {}
    }
  }

  return results;
}

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
