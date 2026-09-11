import { packAll } from './autoload.js';

self.onmessage = ({ data }) => {
  try {
    self.postMessage({ result: packAll(data.catalog, data.options) });
  } catch (error) {
    self.postMessage({ error: error.message });
  }
};