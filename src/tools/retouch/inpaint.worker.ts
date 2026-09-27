// Worker entry: content-aware inpainting off the main thread.
import { inpaint } from './inpaint';

self.onmessage = (e: MessageEvent) => {
  const { id, data, w, h, hole, allowed, patch, seed } = e.data;
  try {
    const out = inpaint(data, w, h, hole, { allowed, patch, seed });
    (self as any).postMessage({ id, out }, [out.buffer]);
  } catch (err) {
    (self as any).postMessage({ id, error: String(err) });
  }
};
