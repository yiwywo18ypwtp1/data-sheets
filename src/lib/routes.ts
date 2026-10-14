/** URL builders, shared by server redirects and client links, so paths are spelled in one place. */
export const routes = {
  view: (baseId: string, tableId: string, viewId: string) => `/b/${baseId}/${tableId}/${viewId}`,
  importCsv: (baseId: string, tableId: string) => `/b/${baseId}/${tableId}/import`,
  settings: () => "/settings",
};
