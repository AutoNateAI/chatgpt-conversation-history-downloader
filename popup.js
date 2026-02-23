let debugLog = [];

const browserAPI = typeof chrome !== 'undefined' ? chrome : browser;

const log = message => {
  debugLog.push(`${new Date().toISOString()}: ${message}`);
  updateDebugLogDisplay();
};

const updateDebugLogDisplay = () => {
  const debugLogElement = document.getElementById('debugLog');
  debugLogElement.textContent = debugLog.join('\n');
  debugLogElement.scrollTop = debugLogElement.scrollHeight;
};

const getCurrentSite = () => {
  browserAPI.tabs.query({active: true, currentWindow: true}, (tabs) => {
    if (tabs[0]) {
      const url = new URL(tabs[0].url);
      const siteMap = {
        'chatgpt.com': 'chatgpt',
        'claude.ai': 'claude',
        'poe.com': 'poe'
      };
      const detectedSite = siteMap[url.hostname] || 'unknown';
      log(`Current detected site: ${detectedSite}`);
    } else {
      log('No active tab found');
    }
  });
};

document.addEventListener('DOMContentLoaded', getCurrentSite);

document.getElementById('extractBtn').addEventListener('click', () => {
  debugLog = [];
  log('Starting conversation extraction...');
  
  const format = document.querySelector('input[name="format"]:checked').value;
  log(`Selected format: ${format}`);

  browserAPI.tabs.query({active: true, currentWindow: true}, (tabs) => {
    log(`Current URL: ${tabs[0].url}`);
    browserAPI.tabs.sendMessage(tabs[0].id, {action: "extract", format}, response => {
      if (browserAPI.runtime.lastError) {
        log(`Error: ${browserAPI.runtime.lastError.message}`);
        if (browserAPI.runtime.lastError.message.includes("Cannot access contents of url") ||
            browserAPI.runtime.lastError.message.includes("Could not establish connection")) {
          log("Make sure you're on a chatgpt.com, claude.ai, or poe.com page and refresh if necessary.");
        }
      } else if (response) {
        response.logs?.forEach(logMessage => log(logMessage));
        if (response.error) {
          log(`Extraction failed: ${response.error}`);
        } else {
          log(`Extraction completed. ${response.messageCount} messages found.`);
          log(`Platform detected: ${response.platform}`);
          log(`Format used: ${format}`);
          log(response.downloadInitiated ? 'File download initiated.' : 'File download failed to start.');
        }
      } else {
        log('Extraction failed: No response from content script');
      }
    });
  });
});

document.getElementById('copyDebugBtn').addEventListener('click', () => {
  const logText = debugLog.join('\n');
  navigator.clipboard.writeText(logText)
    .then(() => log('Debug log copied to clipboard.'))
    .catch(err => log('Failed to copy debug log: ' + err));
});

// --- Batch Download ---

let chatListData = [];

const getCurrentSiteHostname = () => {
  return new Promise(resolve => {
    browserAPI.tabs.query({active: true, currentWindow: true}, tabs => {
      if (tabs[0]) {
        try { resolve(new URL(tabs[0].url).hostname); } catch { resolve(''); }
      } else {
        resolve('');
      }
    });
  });
};

// Show batch section only on chatgpt.com
getCurrentSiteHostname().then(hostname => {
  if (hostname === 'chatgpt.com') {
    document.getElementById('batchSection').style.display = 'block';
  }
});

document.getElementById('loadChatsBtn').addEventListener('click', () => {
  log('Loading chat list...');
  document.getElementById('loadChatsBtn').textContent = 'Loading...';
  document.getElementById('loadChatsBtn').disabled = true;

  browserAPI.tabs.query({active: true, currentWindow: true}, tabs => {
    browserAPI.tabs.sendMessage(tabs[0].id, {action: 'getChatList'}, response => {
      document.getElementById('loadChatsBtn').textContent = 'Load Chat List';
      document.getElementById('loadChatsBtn').disabled = false;

      if (browserAPI.runtime.lastError) {
        log('Error loading chats: ' + browserAPI.runtime.lastError.message);
        return;
      }

      if (response && response.chats && response.chats.length > 0) {
        chatListData = response.chats;
        renderChatList(chatListData);
        document.getElementById('chatListContainer').style.display = 'block';
        log(`Loaded ${chatListData.length} chats.`);
      } else {
        log('No chats found. Make sure the ChatGPT sidebar is visible.');
      }
    });
  });
});

function renderChatList(chats) {
  const container = document.getElementById('chatList');
  container.innerHTML = '';
  chats.forEach((chat, i) => {
    const div = document.createElement('div');
    div.className = 'chat-item';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.id = `chat-${i}`;
    cb.value = i;
    const lbl = document.createElement('label');
    lbl.htmlFor = `chat-${i}`;
    lbl.textContent = chat.title;
    lbl.title = chat.title;
    div.appendChild(cb);
    div.appendChild(lbl);
    container.appendChild(div);
  });
}

document.getElementById('selectAllBtn').addEventListener('click', () => {
  const checkboxes = document.querySelectorAll('#chatList input[type="checkbox"]');
  const allChecked = Array.from(checkboxes).every(cb => cb.checked);
  checkboxes.forEach(cb => cb.checked = !allChecked);
  document.getElementById('selectAllBtn').textContent = allChecked ? 'Select All' : 'Deselect All';
});

document.getElementById('batchDownloadBtn').addEventListener('click', () => {
  const selected = Array.from(document.querySelectorAll('#chatList input[type="checkbox"]:checked'))
    .map(cb => chatListData[parseInt(cb.value)]);

  if (selected.length === 0) {
    log('No chats selected for batch download.');
    return;
  }

  const format = document.querySelector('input[name="format"]:checked').value;
  log(`Starting batch download of ${selected.length} chats in ${format} format...`);

  // Show progress
  const progressDiv = document.getElementById('batchProgress');
  progressDiv.style.display = 'block';
  document.getElementById('progressFill').style.width = '0%';
  document.getElementById('progressText').textContent = `0 / ${selected.length}`;
  document.getElementById('batchDownloadBtn').disabled = true;

  browserAPI.runtime.sendMessage({
    action: 'batchExtract',
    chats: selected,
    format
  }, response => {
    document.getElementById('batchDownloadBtn').disabled = false;
    if (browserAPI.runtime.lastError) {
      log('Batch error: ' + browserAPI.runtime.lastError.message);
      return;
    }
    if (response && response.results) {
      const succeeded = response.results.filter(r => r.success).length;
      const failed = response.results.filter(r => !r.success).length;
      log(`Batch complete: ${succeeded} saved, ${failed} failed.`);
      response.results.forEach(r => {
        if (r.success) {
          log(`  OK: ${r.title} (${r.messageCount} msgs) -> ${r.path}`);
        } else {
          log(`  FAIL: ${r.title} - ${r.error}`);
        }
      });
    }
  });
});

// Listen for progress updates from background
browserAPI.runtime.onMessage.addListener((msg) => {
  if (msg.action === 'batchProgress') {
    const pct = Math.round((msg.current / msg.total) * 100);
    document.getElementById('progressFill').style.width = pct + '%';
    const statusIcon = msg.status === 'done' ? 'OK' : msg.status === 'error' ? 'ERR' : '...';
    document.getElementById('progressText').textContent =
      `${msg.current} / ${msg.total} - [${statusIcon}] ${msg.title}`;
  }
});
