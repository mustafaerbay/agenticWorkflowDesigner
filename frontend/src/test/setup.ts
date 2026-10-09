import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

// --- Browser APIs React Flow / Radix need but jsdom lacks -------------------
class ResizeObserverStub {
  private cb: ResizeObserverCallback;
  constructor(cb: ResizeObserverCallback) {
    this.cb = cb;
  }
  observe(target: Element) {
    this.cb([{ target, contentRect: { width: 1000, height: 800 } } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver);
  }
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

class DOMMatrixReadOnlyStub {
  m22: number;
  constructor(transform?: string) {
    const scale = transform?.match(/scale\(([0-9.]+)\)/)?.[1];
    this.m22 = scale !== undefined ? Number(scale) : 1;
  }
}
// @ts-expect-error test stub
globalThis.DOMMatrixReadOnly = DOMMatrixReadOnlyStub;
// @ts-expect-error test stub
globalThis.DOMMatrix = DOMMatrixReadOnlyStub;

Object.defineProperties(HTMLElement.prototype, {
  offsetHeight: { configurable: true, get() { return parseFloat((this as HTMLElement).style.height) || 80; } },
  offsetWidth: { configurable: true, get() { return parseFloat((this as HTMLElement).style.width) || 240; } },
});
(SVGElement.prototype as unknown as { getBBox: () => DOMRect }).getBBox = () =>
  ({ x: 0, y: 0, width: 0, height: 0 }) as DOMRect;

if (!window.matchMedia) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}
Element.prototype.scrollIntoView ??= vi.fn();
Element.prototype.hasPointerCapture ??= vi.fn(() => false);
Element.prototype.releasePointerCapture ??= vi.fn();

afterEach(() => {
  cleanup();
  localStorage.clear();
});
