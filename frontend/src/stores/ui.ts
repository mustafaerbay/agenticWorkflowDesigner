import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

interface UiState {
  sidebarCollapsed: boolean;
  paletteCollapsed: boolean;
  /** Show technical labels and configuration (otherwise: business language). */
  advancedMode: boolean;
  toggleSidebar: () => void;
  togglePalette: () => void;
  setAdvancedMode: (on: boolean) => void;
}

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      sidebarCollapsed: false,
      paletteCollapsed: false,
      advancedMode: false,
      setAdvancedMode: (advancedMode) => set({ advancedMode }),
      toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
      togglePalette: () => set((s) => ({ paletteCollapsed: !s.paletteCollapsed })),
    }),
    { name: "agentic-ui", storage: createJSONStorage(() => localStorage) },
  ),
);
