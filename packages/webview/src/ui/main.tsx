/**
 * Browser-mode entry point: the bundle `axiomap serve` hands to a browser.
 *
 * The bridge is chosen here and nowhere else, which is what keeps the same
 * bundle hostable twice (§5: "built once, hosted twice"). Phase 8 adds a second
 * entry that constructs a `postMessage` bridge instead and renders the same
 * `App`.
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { HttpBridge } from '../bridge.js';
import { App } from './App.js';
import './styles.css';

const container = document.getElementById('root');
if (container === null) throw new Error('No #root element to mount into.');

createRoot(container).render(
  <StrictMode>
    <App bridge={new HttpBridge()} />
  </StrictMode>,
);
