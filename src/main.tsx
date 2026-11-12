import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { HARD_LEAF_MODE_CONFIG } from './game/ai/searchConfig'

// PPC-HV-2 TRIAL ARM: the Hard cat plays the already-shipped H1 leaf
// (evaluateCorrectedHoleForCat — both-reachable holeControl sign corrected).
// The production default constant stays 'baseline', so reverting this build is
// deleting the line below; the debug panel's leaf toggle still overrides it.
HARD_LEAF_MODE_CONFIG.current = 'baseline_hole_corrected'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
