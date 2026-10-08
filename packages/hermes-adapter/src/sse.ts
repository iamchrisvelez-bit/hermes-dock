export interface SseFrame {
  id: string | null;
  event: string | null;
  data: string;
}

/**
 * Minimal spec-following SSE parser over a byte stream. Comment lines (`: keepalive`)
 * are skipped, multi-line `data:` fields are joined with `\n`.
 */
export async function* parseSse(body: AsyncIterable<Uint8Array>): AsyncGenerator<SseFrame> {
  const decoder = new TextDecoder();
  let buffer = '';
  let id: string | null = null;
  let event: string | null = null;
  let data: string[] = [];

  const flush = (): SseFrame | null => {
    if (data.length === 0) {
      event = null;
      return null;
    }
    const frame = { id, event, data: data.join('\n') };
    id = null;
    event = null;
    data = [];
    return frame;
  };

  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buffer.search(/\r\n|\n|\r/)) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + (buffer.startsWith('\r\n', nl) ? 2 : 1));
      if (line === '') {
        const frame = flush();
        if (frame) yield frame;
        continue;
      }
      if (line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon >= 0 ? line.slice(0, colon) : line;
      let value = colon >= 0 ? line.slice(colon + 1) : '';
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'data') data.push(value);
      else if (field === 'id') id = value;
      else if (field === 'event') event = value;
    }
  }
  const tail = flush();
  if (tail) yield tail;
}
