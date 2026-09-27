// SVG-based canvas cursors (black glyph with white halo, Photoshop style).
const cache = new Map<string, string>();

/** Build a CSS cursor from SVG inner markup drawn on a 24×24 grid. hot = hotspot. */
export function svgCursor(body: string, hotX = 12, hotY = 12, fallback = 'default', size = 24): string {
  const key = body + hotX + hotY + size;
  let c = cache.get(key);
  if (c) return c;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke-linecap="round" stroke-linejoin="round">`
    + `<g stroke="#fff" stroke-width="3.2">${body}</g><g stroke="#000" stroke-width="1.3">${body}</g></svg>`;
  c = `url("data:image/svg+xml;utf8,${encodeURIComponent(svg)}") ${hotX} ${hotY}, ${fallback}`;
  cache.set(key, c);
  return c;
}

export const CURSORS = {
  crosshair: svgCursor('<path d="M12 3v7M12 14v7M3 12h7M14 12h7"/>', 12, 12, 'crosshair'),
  precise: svgCursor('<path d="M12 4v6M12 14v6M4 12h6M14 12h6"/><path d="M12 12h.01"/>', 12, 12, 'crosshair'),
  move: svgCursor('<path d="m4 2 0 13 3.5-3.5 2.5 5.5 2-1-2.5-5.5H14z" fill="#000"/><path d="M17 12v8M13 16h8M15.8 13.2 17 12l1.2 1.2M15.8 18.8 17 20l1.2-1.2M14.2 14.8 13 16l1.2 1.2M19.8 14.8 21 16l-1.2 1.2"/>', 4, 2, 'move'),
  moveDup: svgCursor('<path d="m4 2 0 13 3.5-3.5 2.5 5.5 2-1-2.5-5.5H14z" fill="#000"/><path d="m16 12 2.5 2.5M20.5 12 18 14.5M16.5 17.5l2 2 2-2"/>', 4, 2, 'copy'),
  hand: svgCursor('<path d="M8.2 20.5v-3.6c-1.4-1.3-3.6-3.9-3.8-5.6-.1-1 1-1.5 1.8-.8L8 12.2V5.3a1.2 1.2 0 0 1 2.4 0V11V3.9a1.2 1.2 0 0 1 2.4 0V11V4.8a1.2 1.2 0 0 1 2.4 0V11.4V7a1.2 1.2 0 0 1 2.4 0v7.5c0 3.4-2 6-5.3 6z" fill="#fff"/>', 12, 12, 'grab'),
  grab: svgCursor('<path d="M7.5 20v-3.2c-1.4-1.3-3-3.4-3-5 0-.9.8-1.3 1.5-.8l1.5 1.3V9a1.2 1.2 0 0 1 2.4 0v1.4-1.2a1.2 1.2 0 0 1 2.4 0v1.2-1a1.2 1.2 0 0 1 2.4 0v1.4-.8a1.2 1.2 0 0 1 2.4 0v4c0 3.4-2 6-5.3 6z" fill="#fff"/>', 12, 12, 'grabbing'),
  zoomIn: svgCursor('<circle cx="10" cy="10" r="6" fill="#fff"/><path d="m14.5 14.5 6 6M7.5 10h5M10 7.5v5"/>', 10, 10, 'zoom-in'),
  zoomOut: svgCursor('<circle cx="10" cy="10" r="6" fill="#fff"/><path d="m14.5 14.5 6 6M7.5 10h5"/>', 10, 10, 'zoom-out'),
  zoomNone: svgCursor('<circle cx="10" cy="10" r="6" fill="#fff"/><path d="m14.5 14.5 6 6"/>', 10, 10, 'zoom-in'),
  rotate: svgCursor('<path d="M5 12a7 7 0 1 1 3 5.7"/><path d="M4 15.5 5 12l3.5 1"/>', 12, 12, 'grab'),
  eyedropper: svgCursor('<path d="m13.5 7.5 3 3-9 9-3.8.8.8-3.8z" fill="#fff"/><path d="M12.4 6.4l5.2 5.2M15.5 4.5a2.3 2.3 0 0 1 3.2 0l.8.8a2.3 2.3 0 0 1 0 3.2l-2 2-4-4z" fill="#000"/>', 3, 21, 'crosshair'),
  notAllowed: 'not-allowed',
};
