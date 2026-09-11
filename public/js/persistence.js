import { validateProjectData } from './projectValidation.js';

/** One in-flight save per project; edits made during a save stay dirty. */
export function createProjectSaver(state, api) {
  const pending = new WeakMap();
  return function save(project = state.project) {
    if (pending.has(project)) return pending.get(project);
    const editRevision = state.editRevision;
    const data = validateProjectData({ catalog: project.catalog, scenarios: project.scenarios, staging: project.staging || [] });
    // Snapshot before starting I/O. Existing-project saves NEVER write sharing metadata.
    const payload = JSON.parse(JSON.stringify(project.id
      ? { revision: project.revision, data }
      : { name: project.name, visibility: project.visibility, viewers: project.viewers || [], data }));
    const operation = (async () => {
      const { project: saved } = project.id
        ? await api.updateProject(project.id, payload)
        : await api.createProject(payload);
      project.id = saved.id;
      project.revision = saved.revision;
      project.name = saved.name;
      project.visibility = saved.visibility;
      project.viewers = saved.viewers;
      if (state.project === project && state.editRevision === editRevision) state.dirty = false;
      return saved;
    })();
    pending.set(project, operation);
    operation.finally(() => pending.delete(project)).catch(() => {});
    return operation;
  };
}