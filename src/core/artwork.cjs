'use strict';

// Never let an untrusted artwork server force an unbounded allocation. Responses
// without Content-Length are common; the byte limit must cover those too.
async function readJpegWithLimit(response, maximumBytes = 5 * 1024 * 1024) {
  if (!response?.ok || !/^image\/(?:jpeg|pjpeg)(?:;|$)/i.test(response.headers.get('content-type') || '')) {
    return null;
  }
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > maximumBytes) {
    await response.body?.cancel().catch(() => {});
    return null;
  }
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximumBytes) return null;
      chunks.push(value);
    }
  } finally {
    // Also release the stream when the remote server exceeded the limit.
    await reader.cancel().catch(() => {});
  }
  const bytes = Buffer.concat(chunks, size);
  return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff ? bytes : null;
}

module.exports = { readJpegWithLimit };
