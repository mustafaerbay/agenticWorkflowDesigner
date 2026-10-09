import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

interface UiState {
  sidebarCollapsed: boolean;
  paletteCollapsed: boolean;
  toggleSidebar: () => void;
  togglePalette: () => void;
}

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      sidebarCollapsed: false,
      paletteCollapsed: false,
      toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
      togglePalette: () => set((s) => ({ paletteCollapsed: !s.paletteCollapsed })),
    }),
    { name: "agentic-ui", storage: createJSONStorage(() => localStorage) },
  ),
);
