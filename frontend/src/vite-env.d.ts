/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_WORKER_URL?: string;
  readonly VITE_PMTILES_URL?: string;
  readonly VITE_POIS_URL?: string;
  readonly VITE_BASEMAP_STYLE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
