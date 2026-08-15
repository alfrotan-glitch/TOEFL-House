import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { AuthProvider } from './contexts/AuthProvider';
import { ErrorBoundary } from './components/ErrorBoundary';
import './index.css';

// ── DOM Root Resolution ─────────────────────────────────────────────
// Safely resolve the root element. If it doesn't exist (e.g., due to a 
// misconfigured index.html), throw a descriptive error instead of a 
// cryptic null reference. This greatly improves developer debugging.
const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error(
    "Fatal: Root element with id 'root' was not found. Ensure your index.html contains <div id='root'></div>."
  );
}

createRoot(rootElement).render(
  <StrictMode>
    <ErrorBoundary>
      <AuthProvider>
        <App />
      </AuthProvider>
    </ErrorBoundary>
  </StrictMode>
);