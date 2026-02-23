const browserAPI = typeof chrome !== 'undefined' ? chrome : browser;

const PLATFORMS = {
  CLAUDE: 'Claude',
  CHATGPT: 'ChatGPT',
  POE: 'Poe',
  UNKNOWN: 'Unknown'
};

const FORMAT_HANDLERS = {
  markdown: {
    convert: htmlToMarkdown,
    fileExtension: 'md',
    formatMetadata: (url, platform) => `# Conversation extracted from ${url}\n**Platform:** ${platform}\n**Format:** markdown\n\n`,
    formatMessage: (speaker, text) => `## ${speaker}:\n${text}\n\n`
  },
  html: {
    convert: simplifyHtml,
    fileExtension: 'html',
    formatMetadata: (url, platform) => `<h1>Conversation extracted from ${url}</h1><p><strong>Platform:</strong> ${platform}</p><p><strong>Format:</strong> html</p>`,
    formatMessage: (speaker, text) => `<h2>${speaker}:</h2><div>${text}</div>`
  },
  plaintext: {
    convert: htmlToPlaintext,
    fileExtension: 'txt',
    formatMetadata: (url, platform) => `Conversation extracted from ${url}\nPlatform: ${platform}\nFormat: plaintext\n\n`,
    formatMessage: (speaker, text) => `${speaker}:\n${text}\n\n`
  }
};

async function extractConversation(format, options = {}) {
  const logs = [];
  const log = message => {
    console.log(message);
    logs.push(message);
  };

  try {
    const platform = detectPlatform();
    log(`Platform detected: ${platform}`);
    log(`Format selected: ${format}`);

    const messages = await extractConversationFromPlatform(platform, format);

    if (messages.length > 0) {
      const content = formatConversation(platform, messages, format);

      // Batch mode: download with custom filename
      if (options.batchDownload && options.fileName) {
        downloadConversationAs(content, options.fileName);
        return { platform, messageCount: messages.length, downloadInitiated: true, logs };
      }

      const downloadStatus = downloadConversation(content, format);
      return { platform, messageCount: messages.length, downloadInitiated: true, logs };
    } else {
      return { error: "No messages found in the conversation.", logs };
    }
  } catch (error) {
    return { error: `Extraction failed: ${error.message}`, logs };
  }
}

async function getChatList() {
  const historyDiv = document.querySelector('#history');
  if (!historyDiv) return { chats: [], error: 'Sidebar #history not found' };

  // Find the scrollable container (the parent that actually scrolls)
  let scrollContainer = historyDiv;
  let el = historyDiv;
  while (el) {
    if (el.scrollHeight > el.clientHeight + 10) {
      scrollContainer = el;
      break;
    }
    el = el.parentElement;
  }

  // Scroll to bottom repeatedly until no new links appear
  let prevCount = 0;
  let stableRounds = 0;
  const maxScrollAttempts = 50;

  for (let i = 0; i < maxScrollAttempts; i++) {
    const currentCount = historyDiv.querySelectorAll('a[href^="/c/"]').length;
    if (currentCount === prevCount) {
      stableRounds++;
      if (stableRounds >= 3) break;
    } else {
      stableRounds = 0;
      prevCount = currentCount;
    }
    scrollContainer.scrollTop = scrollContainer.scrollHeight;
    await new Promise(r => setTimeout(r, 500));
  }

  scrollContainer.scrollTop = 0;

  const links = Array.from(historyDiv.querySelectorAll('a[href^="/c/"]'));
  const seen = new Set();
  const chats = [];
  for (const a of links) {
    const href = a.getAttribute('href');
    if (seen.has(href)) continue;
    seen.add(href);
    const id = href.replace('/c/', '');
    const title = a.textContent.trim() || 'Untitled';
    chats.push({ id, title, url: `https://chatgpt.com${href}` });
  }

  return { chats };
}

function detectPlatform() {
  if (document.querySelector('div.font-claude-message')) return PLATFORMS.CLAUDE;
  if (window.location.hostname === 'chatgpt.com') return PLATFORMS.CHATGPT;
  if (document.querySelector('div.ChatMessagesView_messagePair__ZEXUz')) return PLATFORMS.POE;
  return PLATFORMS.UNKNOWN;
}

async function extractConversationFromPlatform(platform, format) {
  const extractors = {
    [PLATFORMS.CHATGPT]: extractChatGPTConversation,
    [PLATFORMS.CLAUDE]: extractClaudeConversation,
    [PLATFORMS.POE]: extractPoeConversation
  };

  return extractors[platform] ? await extractors[platform](format) : [];
}

async function imgToBase64(src) {
  try {
    const resp = await fetch(src);
    const blob = await resp.blob();
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  } catch (e) {
    return src;
  }
}

async function extractChatGPTConversation(format) {
  const articles = Array.from(document.querySelectorAll('article'));
  const results = [];

  for (const article of articles) {
    const roleEl = article.querySelector('[data-message-author-role]');
    const role = roleEl ? roleEl.getAttribute('data-message-author-role') : null;
    const speaker = role === 'user' ? "User" : "AI";

    const contentDiv = article.querySelector('.markdown, .whitespace-pre-wrap');
    let text = contentDiv ? extractContent(contentDiv, format) : '';

    const seenPaths = new Set();
    const imgElements = Array.from(article.querySelectorAll('img'))
      .filter(img => {
        if (!img.src || img.src.includes('data:') || (img.width <= 50 && img.naturalWidth <= 50)) return false;
        try {
          const path = new URL(img.src).pathname;
          if (seenPaths.has(path)) return false;
          seenPaths.add(path);
          return true;
        } catch {
          return true;
        }
      });

    for (const img of imgElements) {
      const dataUri = await imgToBase64(img.src);
      if (format === 'markdown') {
        text += `\n\n![image](${dataUri})`;
      } else if (format === 'html') {
        text += `<br><img src="${dataUri}">`;
      } else {
        text += `\n\n[embedded image]`;
      }
    }

    if (text.length > 1) results.push([speaker, text]);
  }

  return results;
}

function extractClaudeConversation(format) {
  return Array.from(document.querySelectorAll('div.font-user-message, div.font-claude-message'))
    .map(container => {
      const speaker = container.classList.contains('font-user-message') ? "User" : "AI";
      const contentElement = speaker === "AI" ? container.querySelector('div') : container;
      return [speaker, extractContent(contentElement, format)];
    })
    .filter(([, text]) => text.length > 1);
}

function extractPoeConversation(format) {
  return Array.from(document.querySelectorAll('div.ChatMessagesView_messagePair__ZEXUz'))
    .flatMap(container => {
      const messages = [];
      const userMessage = container.querySelector('div.ChatMessage_rightSideMessageWrapper__r0roB');
      if (userMessage) {
        const content = userMessage.querySelector('div.Markdown_markdownContainer__Tz3HQ');
        if (content) {
          const text = extractContent(content, format);
          if (text.length > 1) messages.push(["User", text]);
        }
      }

      const aiMessages = Array.from(container.querySelectorAll('div.ChatMessage_messageWrapper__4Ugd6'))
        .filter(msg => !msg.classList.contains('ChatMessage_rightSideMessageWrapper__r0roB'));
      aiMessages.forEach(aiMessage => {
        const content = aiMessage.querySelector('div.Markdown_markdownContainer__Tz3HQ');
        if (content) {
          const text = extractContent(content, format);
          if (text.length > 1) messages.push(["AI", text]);
        }
      });
      return messages;
    });
}

function extractContent(element, format) {
  return FORMAT_HANDLERS[format].convert(element.innerHTML);
}

function formatConversation(platform, messages, format) {
  const { formatMetadata, formatMessage } = FORMAT_HANDLERS[format];
  let content = formatMetadata(window.location.href, platform);
  messages.forEach(([speaker, text]) => {
    content += formatMessage(speaker, text);
  });
  return content;
}

function downloadConversation(content, format) {
  const blob = new Blob([content], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `conversation_${new Date().toISOString().replace(/[:.]/g, '-')}.${FORMAT_HANDLERS[format].fileExtension}`;
  a.click();
  URL.revokeObjectURL(url);
  return 'File download initiated';
}

function downloadConversationAs(content, fileName) {
  const blob = new Blob([content], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}

function htmlToMarkdown(html) {
  return html
    .replace(/<img\b[^>]*src="([^"]*)"[^>]*alt="([^"]*)"[^>]*\/?>/gi, '![$2]($1)')
    .replace(/<img\b[^>]*alt="([^"]*)"[^>]*src="([^"]*)"[^>]*\/?>/gi, '![$1]($2)')
    .replace(/<img\b[^>]*src="([^"]*)"[^>]*\/?>/gi, '![image]($1)')
    .replace(/<ul\b[^>]*>([\s\S]*?)<\/ul>/gi, function(match, content) {
      return content.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, '- $1\n');
    })
    .replace(/<p\b[^>]*>([\s\S]*?)<\/p>/gi, '$1\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .trim();
}

function htmlToPlaintext(html) {
  return html
    .replace(/<img\b[^>]*src="([^"]*)"[^>]*\/?>/gi, '[image: $1]')
    .replace(/<ul\b[^>]*>([\s\S]*?)<\/ul>/gi, function(match, content) {
      return content.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, '- $1\n');
    })
    .replace(/<p\b[^>]*>([\s\S]*?)<\/p>/gi, '$1\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .trim();
}

function simplifyHtml(html) {
  return html
    .replace(/<(\w+)\s+[^>]*>/g, '<$1>')
    .replace(/\s+/g, ' ')
    .trim();
}

browserAPI.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "extract") {
    extractConversation(request.format, {
      batchDownload: request.batchDownload,
      fileName: request.fileName
    }).then(sendResponse);
    return true;
  } else if (request.action === "detectPlatform") {
    sendResponse({ platform: detectPlatform() });
  } else if (request.action === "getChatList") {
    getChatList().then(sendResponse);
    return true;
  }
});
