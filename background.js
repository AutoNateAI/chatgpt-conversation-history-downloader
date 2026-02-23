const browserAPI = typeof chrome !== 'undefined' ? chrome : browser;

const SUPPORTED_URLS = ['chatgpt.com', 'claude.ai', 'poe.com'];
const NATIVE_HOST_NAME = 'com.aichatdl.native_host';

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

async function batchExtract(tabId, chats, format) {
  const results = [];
  const fileExt = { markdown: 'md', html: 'html', plaintext: 'txt' }[format] || 'md';

  for (let i = 0; i < chats.length; i++) {
    const chat = chats[i];
    const dirName = sanitizeFilename(chat.title);
    const fileName = `${dirName}.${fileExt}`;

    // Report progress
    browserAPI.runtime.sendMessage({
      action: 'batchProgress',
      current: i + 1,
      total: chats.length,
      title: chat.title,
      status: 'navigating'
    }).catch(() => {}); // popup may be closed

    try {
      // Navigate the tab to this conversation
      await browserAPI.tabs.update(tabId, { url: chat.url });
      await waitForTabLoad(tabId);

      // Extract conversation content (returnContent: true)
      const response = await new Promise((resolve, reject) => {
        browserAPI.tabs.sendMessage(tabId, {
          action: 'extract',
          format,
          returnContent: true
        }, resp => {
          if (browserAPI.runtime.lastError) {
            reject(new Error(browserAPI.runtime.lastError.message));
          } else {
            resolve(resp);
          }
        });
      });

      if (response && response.content) {
        // Send to native host to write to disk
        const writeResult = await sendToNativeHost({
          action: 'write',
          dirName,
          fileName,
          content: response.content
        });

        results.push({
          title: chat.title,
          success: writeResult.success,
          path: writeResult.path,
          messageCount: response.messageCount
        });

        browserAPI.runtime.sendMessage({
          action: 'batchProgress',
          current: i + 1,
          total: chats.length,
          title: chat.title,
          status: 'done'
        }).catch(() => {});
      } else {
        const errorMsg = response?.error || 'No content extracted';
        results.push({ title: chat.title, success: false, error: errorMsg });
        browserAPI.runtime.sendMessage({
          action: 'batchProgress',
          current: i + 1,
          total: chats.length,
          title: chat.title,
          status: 'error',
          error: errorMsg
        }).catch(() => {});
      }
    } catch (err) {
      results.push({ title: chat.title, success: false, error: err.message });
      browserAPI.runtime.sendMessage({
        action: 'batchProgress',
        current: i + 1,
        total: chats.length,
        title: chat.title,
        status: 'error',
        error: err.message
      }).catch(() => {});
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
