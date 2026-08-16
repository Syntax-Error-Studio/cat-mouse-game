import { HashRouter, Routes, Route } from 'react-router-dom';
import { GameProvider } from './context/GameContext';
import { MainMenu } from './pages/MainMenu';
import { LocalModeSelect } from './pages/LocalModeSelect';
import { OnlineModeSelect } from './pages/OnlineModeSelect';
import { MatchSetupPage } from './pages/MatchSetupPage';
import { GamePage } from './pages/GamePage';
import { SettingsPage } from './pages/SettingsPage';
import { EditorPage } from './pages/EditorPage';
import { ChallengesPage } from './pages/ChallengesPage';
import { TutorialPage } from './pages/TutorialPage';

function App() {
  return (
    <GameProvider>
      <HashRouter>
        <Routes>
          <Route path="/" element={<MainMenu />} />
          <Route path="/local" element={<LocalModeSelect />} />
          {/* 对局配置中间页：所有对战类模式先在此配置，再进入棋盘 */}
          <Route path="/setup/:mode" element={<MatchSetupPage />} />
          {/* 棋盘本身模式无关，参数来自 context */}
          <Route path="/game" element={<GamePage />} />
          <Route path="/online" element={<OnlineModeSelect />} />
          <Route path="/challenges" element={<ChallengesPage />} />
          <Route path="/editor" element={<EditorPage />} />
          <Route path="/tutorial" element={<TutorialPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Routes>
      </HashRouter>
    </GameProvider>
  );
}

export default App;
