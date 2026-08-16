import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';
import type { GameConfig } from '../game/config';
import { DEFAULT_CONFIG } from '../game/config';
import type { GameMode, Difficulty } from '../game/types';

interface GameContextValue {
  config: GameConfig;
  setGameMode: (mode: GameMode) => void;
  setDifficulty: (difficulty: Difficulty) => void;
  setFullConfig: (config: GameConfig) => void;
  updateConfigField: <K extends keyof GameConfig>(key: K, value: GameConfig[K]) => void;
  resetConfig: () => void;
}

const GameContext = createContext<GameContextValue | null>(null);

export function GameProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<GameConfig>({ ...DEFAULT_CONFIG });

  const setGameMode = useCallback((mode: GameMode) => {
    setConfig(prev => ({ ...prev, gameMode: mode }));
  }, []);

  const setDifficulty = useCallback((difficulty: Difficulty) => {
    setConfig(prev => ({ ...prev, difficulty }));
  }, []);

  const setFullConfig = useCallback((next: GameConfig) => {
    setConfig({ ...DEFAULT_CONFIG, ...next });
  }, []);

  const updateConfigField = useCallback(<K extends keyof GameConfig>(key: K, value: GameConfig[K]) => {
    setConfig(prev => ({ ...prev, [key]: value }));
  }, []);

  const resetConfig = useCallback(() => {
    setConfig({ ...DEFAULT_CONFIG });
  }, []);

  return (
    <GameContext.Provider value={{ config, setGameMode, setDifficulty, setFullConfig, updateConfigField, resetConfig }}>
      {children}
    </GameContext.Provider>
  );
}

export function useGame() {
  const ctx = useContext(GameContext);
  if (!ctx) throw new Error('useGame must be used within GameProvider');
  return ctx;
}
