import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { readInitialState } from './initialState';
import './styles.css';

// A pre-rendered /resume page leaves its summary inside #root and its data in #initial-state.
// createRoot replaces the summary in the same commit that draws the real view (which starts from
// that data, so it lines up), so there is no blank frame between them.
const initialState = readInitialState();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App initialState={initialState} />
  </StrictMode>,
);
