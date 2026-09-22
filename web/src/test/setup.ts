import '@testing-library/jest-dom/vitest'

// jsdom has no ResizeObserver -- Headless UI's Combobox/Listbox use one
// internally (movement detection while a gesture is tracked), so any test
// that opens/closes one throws without this stub.
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
}
