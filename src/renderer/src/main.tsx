import '@xterm/xterm/css/xterm.css';
import './styles/app.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';

const container = document.getElementById('root');
if (!container) throw new Error('root container missing');

/*
 * xterm measures its cell from the font and then never re-measures on its own,
 * so the terminal face has to be decoded before any pane mounts: a face that
 * arrives after mount leaves every column a pixel off. The rest of the UI can
 * swap in, which is why only this one is awaited.
 *
 * Both weights, because they are separate files: the bold face is another 9 MB,
 * and a bold run drawn while it is still decoding is painted with a synthesised
 * bold that stays in the scrollback - one listing then shows two kinds of bold,
 * the odd word fatter and a hair taller than the words beside it.
 */
void Promise.all([
  document.fonts.load('13px "Sarasa Mono SC"'),
  document.fonts.load('bold 13px "Sarasa Mono SC"'),
])
  .catch(() => undefined)
  .then(() => {
    createRoot(container).render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
  });
