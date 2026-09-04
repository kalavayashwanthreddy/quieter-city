import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles.css';

// NOTE: no StrictMode on purpose — it double-invokes effects in dev, which
// fights with live mic streams and interval loops.
createRoot(document.getElementById('root')).render(<App />);