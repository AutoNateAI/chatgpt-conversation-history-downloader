#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const BASE_DIR = path.join(
  process.env.HOME,
  'Documents/code/AutoNateAI_Workspace/chatgpt-convos'
);

// Read a native messaging message (4-byte length prefix + JSON)
function readMessage() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let headerBuf = Buffer.alloc(0);

    process.stdin.once('readable', () => {
      // Read 4-byte header
      while (headerBuf.length < 4) {
        const chunk = process.stdin.read(4 - headerBuf.length);
        if (!chunk) { resolve(null); return; }
        headerBuf = Buffer.concat([headerBuf, chunk]);
      }

      const msgLen = headerBuf.readUInt32LE(0);
      if (msgLen === 0) { resolve(null); return; }

      let remaining = msgLen;
      const readBody = () => {
        while (remaining > 0) {
          const data = process.stdin.read(remaining);
          if (!data) {
            process.stdin.once('readable', readBody);
            return;
          }
          chunks.push(data);
          remaining -= data.length;
        }
        const body = Buffer.concat(chunks).toString('utf8');
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error('Invalid JSON: ' + e.message)); }
      };
      readBody();
    });
  });
}

// Write a native messaging response
function sendMessage(obj) {
  const json = JSON.stringify(obj);
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(json.length, 0);
  process.stdout.write(buf);
  process.stdout.write(json);
}

// Accumulated chunks for large files
const chunkStore = {};

async function handleMessage(msg) {
  try {
    // Chunked write support: accumulate parts, write on final chunk
    if (msg.action === 'writeChunk') {
      const key = msg.dirName + '/' + msg.fileName;
      if (!chunkStore[key]) chunkStore[key] = [];
      chunkStore[key].push(msg.data);

      if (msg.final) {
        const content = chunkStore[key].join('');
        delete chunkStore[key];
        return writeFile(msg.dirName, msg.fileName, content);
      }
      return { success: true, status: 'chunk_received' };
    }

    // Single write (content fits in one message)
    if (msg.action === 'write') {
      return writeFile(msg.dirName, msg.fileName, msg.content);
    }

    // Check if a file already exists (for skip logic)
    if (msg.action === 'checkExists') {
      const dirPath = path.join(BASE_DIR, msg.dirName);
      const filePath = path.join(dirPath, msg.fileName);
      const exists = fs.existsSync(filePath);
      return { success: true, exists, path: filePath };
    }

    return { success: false, error: 'Unknown action: ' + msg.action };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function writeFile(dirName, fileName, content) {
  const dirPath = path.join(BASE_DIR, dirName);
  fs.mkdirSync(dirPath, { recursive: true });

  const filePath = path.join(dirPath, fileName);
  fs.writeFileSync(filePath, content, 'utf8');

  return { success: true, path: filePath };
}

async function main() {
  const msg = await readMessage();
  if (!msg) {
    sendMessage({ success: false, error: 'No message received' });
    process.exit(0);
  }

  const result = await handleMessage(msg);
  sendMessage(result);
  process.exit(0);
}

main().catch(err => {
  sendMessage({ success: false, error: err.message });
  process.exit(1);
});
