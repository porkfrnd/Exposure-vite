import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter';
import 'leaflet/dist/leaflet.css';
import './index.css';
import { App } from '@/ui/App';

createRoot(document.getElementById('root')!).render(<App />);
