// Worker entry: runs filter kernels off the main thread.
import { KERNELS } from './kernels/index';

self.onmessage = (e: MessageEvent) => {
  const { id, name, params, width, height, data, meta } = e.data;
  try {
    const k = KERNELS[name];
    if (!k) throw new Error(`Unknown filter kernel: ${name}`);
    const out = k(new ImageData(new Uint8ClampedArray(data), width, height), params, meta);
    (self as any).postMessage({ id, width: out.width, height: out.height, data: out.data.buffer }, [out.data.buffer]);
  } catch (err) {
    (self as any).postMessage({ id, error: String((err as any)?.message || err) });
  }
};
