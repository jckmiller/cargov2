// Local JSON import/export of layouts (whole projects).
import { validateProjectData } from './projectValidation.js';
import { makeScenario } from './store.js';

export function exportProjectJSON(project) {
  const payload = {
    format: 'a3-shipping-pro',
    version: 1,
    exportedAt: new Date().toISOString(),
    project: {
      name: project.name,
      visibility: project.visibility,
      catalog: project.catalog,
      scenarios: project.scenarios,
      staging: project.staging || [],
    },
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${sanitize(project.name)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

export function importProjectJSON(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        if (data.version !== undefined && data.version !== 1) throw new Error('Unsupported project file version');
        const p = data.project || data;
        if (!p || !Array.isArray(p.scenarios)) {
          throw new Error('Invalid layout file');
        }
        validateProjectData(p);
        resolve({
          id: null,
          name: p.name || 'Imported Project',
          visibility: p.visibility === 'public' ? 'public' : 'restricted',
          viewers: [],
          catalog: Array.isArray(p.catalog) ? p.catalog : [],
          scenarios: p.scenarios.length ? p.scenarios : [makeScenario('Container 1')],
          staging: p.staging || [],
        });
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

function sanitize(name) {
  return String(name || 'project').replace(/[^a-z0-9_-]+/gi, '_');
}
